/**
 * YouTube Upload — OAuth2 auth + video upload via YouTube Data API v3
 *
 * First run: opens browser for Google OAuth consent → saves refresh token.
 * Subsequent runs: uses stored refresh token — fully automated.
 */

import { google } from 'googleapis';
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createServer } from 'http';
import { assertUploadAllowed, fingerprint } from './upload-guard';

// Resolution order:
//   1. $YOUTUBE_CLIENT_SECRET (explicit override)
//   2. <repo>/.client_secret.json (project-local, accessible to launchd)
//   3. ~/Desktop/client_secret.json (legacy; only readable from interactive Terminal w/ Full Disk Access)
const CLIENT_SECRET_PATH = resolve(
  process.env.YOUTUBE_CLIENT_SECRET ||
    (existsSync(resolve(__dirname, '..', '.client_secret.json'))
      ? resolve(__dirname, '..', '.client_secret.json')
      : '/Users/tapas/Desktop/client_secret.json')
);
const TOKEN_PATH = process.env.YOUTUBE_TOKEN_PATH
  ? resolve(process.env.YOUTUBE_TOKEN_PATH)
  : resolve(__dirname, '..', '.youtube-token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly', // needed for backfill (channels.list / playlistItems.list)
];

interface UploadOptions {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus?: 'public' | 'unlisted' | 'private';
}

interface UploadResult {
  videoId: string;
  url: string;
}

/**
 * Get authenticated OAuth2 client.
 * First run opens browser, subsequent runs use stored token.
 */
async function getAuthClient() {
  const creds = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;

  // For Desktop apps, use loopback on a high port — Google allows any port on localhost
  const redirectUri = 'http://localhost:8085';
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  // Check for stored token
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    oauth2.setCredentials(token);

    // Refresh if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    }

    return oauth2;
  }

  // First time: interactive browser auth
  console.log('\n  First-time YouTube authorization required.');
  console.log('  A browser window will open — sign in and authorize.\n');

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  // Start local server on port 8085 to receive the callback
  const code = await new Promise<string>((resolveCode) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '', 'http://localhost:8085');
      const authCode = url.searchParams.get('code');
      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p><script>window.close()</script>');
        server.close();
        resolveCode(authCode);
      } else {
        res.writeHead(400);
        res.end('Missing code parameter');
      }
    });

    server.listen(8085, () => {
      console.log('  Listening on http://localhost:8085 ...');
      const { execSync } = require('child_process');
      execSync(`open "${authUrl}"`);
    });
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('  Token saved. Future uploads will be automatic.\n');

  return oauth2;
}

/**
 * Idempotency window for pre-flight duplicate detection. Any upload of the
 * same title inside this window is treated as an already-published request.
 * 30 minutes covers googleapis client retry chains (default gaxios backoff
 * can span several minutes) and manual re-run mistakes; long enough to be
 * safe, short enough to not block a legitimate re-title on the same day.
 */
const DUPLICATE_CHECK_WINDOW_MS = 30 * 60 * 1000;

/**
 * Check whether a video with the given title was already uploaded to this
 * channel in the last DUPLICATE_CHECK_WINDOW_MS. Returns the existing
 * videoId if so, else null.
 *
 * Rationale: the raw videos.insert call is not idempotent — the underlying
 * gaxios HTTP client auto-retries on network errors / socket drops, and if
 * the first request actually reached YouTube but the response never made it
 * back, the retry uploads the same file a second time. Both uploads succeed
 * on YouTube; the caller only sees the retry's ID. This function is the
 * defensive pre-flight check that closes that hole. Also protects against
 * cron double-fires and manual re-runs.
 */
async function findRecentUploadWithTitle(
  youtube: ReturnType<typeof google.youtube>,
  title: string,
): Promise<string | null> {
  try {
    const chRes = await youtube.channels.list({ part: ['contentDetails'], mine: true });
    const uploadsPlaylist = chRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) return null;

    const plRes = await youtube.playlistItems.list({
      part: ['snippet'],
      playlistId: uploadsPlaylist,
      maxResults: 5,
    });
    const items = plRes.data.items || [];
    const now = Date.now();
    for (const it of items) {
      const s = it.snippet;
      if (!s) continue;
      if (s.title !== title) continue;
      const publishedAt = s.publishedAt ? Date.parse(s.publishedAt) : 0;
      if (publishedAt <= 0) continue;
      if (now - publishedAt <= DUPLICATE_CHECK_WINDOW_MS) {
        return s.resourceId?.videoId || null;
      }
    }
    return null;
  } catch (err: any) {
    // Never block the upload on a pre-flight failure — if the check itself
    // errors (rate limit, transient auth), fall through to the upload path.
    console.warn(`  [dup-check] Skipped: ${String(err?.message || err).slice(0, 120)}`);
    return null;
  }
}

/**
 * Upload video to YouTube.
 */
export async function uploadToYouTube(options: UploadOptions): Promise<UploadResult> {
  const { videoPath, title, description, tags, privacyStatus = 'public' } = options;

  // GUARD: refuse to upload from a machine that hasn't been explicitly authorised.
  // See factory/upload-guard.ts for rationale.
  const guard = assertUploadAllowed('uploadToYouTube');
  const fp = fingerprint(guard);

  const auth = await getAuthClient();
  const youtube = google.youtube({ version: 'v3', auth });

  // Pre-flight duplicate check — see findRecentUploadWithTitle for rationale.
  const existing = await findRecentUploadWithTitle(youtube, title);
  if (existing) {
    console.log(`  [dup-check] Video "${title.slice(0, 60)}" already uploaded ${existing} within the last 30 min — skipping duplicate insert.`);
    return {
      videoId: existing,
      url: `https://www.youtube.com/watch?v=${existing}`,
    };
  }

  // Stamp the description with a machine fingerprint so future audits can
  // tell which machine produced which upload. The marker is at the very end,
  // visible but unobtrusive.
  const stampedDescription = `${description}\n\n[ats-fp:${fp}]`;

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description: stampedDescription,
        tags,
        categoryId: '22', // People & Blogs (use '25' for News & Politics)
        defaultLanguage: 'en',
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(videoPath),
    },
  });

  const videoId = res.data.id || '';
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/**
 * Save video metadata to DynamoDB for homepage integration.
 */
export async function saveVideoToDynamo(meta: Record<string, any>): Promise<void> {
  try {
    const client = new DynamoDBClient({ region: 'ap-south-1' });
    const docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    const table = process.env.PRIME_SPEAKS_TABLE || 'prime-speaks-prod';

    await docClient.send(new PutCommand({
      TableName: table,
      Item: {
        pk: 'YOUTUBE_VIDEO',
        sk: `DATE#${new Date().toISOString()}`,
        ...meta,
        ttl: Math.floor(Date.now() / 1000) + 90 * 86400, // 90 days
      },
    }));
  } catch (err: any) {
    console.log(`  DynamoDB save skipped: ${err.message}`);
  }
}

/**
 * Sync video feed JSON to S3 — the frontend reads this directly.
 * Keeps the latest 12 videos, sorted newest first.
 */
const S3_BUCKET = 'trading-squad-dashboard-prod-228644978624';
const FEED_KEY = 'prime-speaks-feed.json';
const FEED_LOCAL = resolve(__dirname, '..', 'out', 'prime-speaks-feed.json');

export async function syncFeedToS3(newVideo: Record<string, any>): Promise<void> {
  try {
    // Read existing feed from S3
    let feed: any[] = [];
    try {
      const { execSync } = require('child_process');
      const existing = execSync(`aws s3 cp s3://${S3_BUCKET}/${FEED_KEY} - 2>/dev/null`, { encoding: 'utf-8' });
      feed = JSON.parse(existing);
    } catch {
      // No existing feed yet
    }

    // Add new video to front
    feed.unshift({
      videoId: newVideo.videoId,
      url: newVideo.url,
      title: newVideo.title,
      date: newVideo.date || new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      type: newVideo.type || 'daily-market-update',
      thumbnailUrl: newVideo.thumbnailUrl || `https://img.youtube.com/vi/${newVideo.videoId}/maxresdefault.jpg`,
      company: newVideo.company,
      ticker: newVideo.ticker,
      uploadedAt: new Date().toISOString(),
    });

    // Dedupe by (title, date, type) — keep the entry with the latest uploadedAt.
    // YouTube re-uploads create different videoIds with identical content; without
    // this, the feed accumulates duplicates (see E2E Issue #2).
    const bestByKey = new Map<string, any>();
    for (const e of feed) {
      const key = `${(e.title || '').trim()}|${e.date || ''}|${e.type || ''}`;
      const prev = bestByKey.get(key);
      if (!prev || (e.uploadedAt || '') > (prev.uploadedAt || '')) {
        bestByKey.set(key, e);
      }
    }
    const winners = new Set(bestByKey.values());
    feed = feed.filter(e => winners.has(e));

    // Keep latest 12
    feed = feed.slice(0, 12);

    // Write locally + upload to S3
    writeFileSync(FEED_LOCAL, JSON.stringify(feed, null, 2));
    const { execSync } = require('child_process');
    execSync(`aws s3 cp ${FEED_LOCAL} s3://${S3_BUCKET}/${FEED_KEY} --content-type application/json --cache-control "max-age=300"`, { stdio: 'pipe' });
    console.log('  Feed synced to S3 (latest 12 videos).');
  } catch (err: any) {
    console.log(`  S3 feed sync skipped: ${err.message}`);
  }
}

/**
 * Generate YouTube title and description from market data.
 */
export function generateYouTubeMetadata(marketData: any, date: string) {
  const n = marketData.nifty;
  const b = marketData.bankNifty;
  const nSign = n.changePercent >= 0 ? '+' : '';
  const direction = n.changePercent >= 0 ? '📈' : '📉';

  const title = `Nifty ${n.value} (${nSign}${n.changePercent}%) ${direction} | Prime's Market Pulse | ${date}`;

  const description = `${direction} Daily AI Market Analysis by Prime — AalsiTrader's AI Trading Analyst

📊 Today's Numbers:
• Nifty 50: ${n.value} (${nSign}${n.change}, ${nSign}${n.changePercent}%)
• Bank Nifty: ${b.value} (${b.change >= 0 ? '+' : ''}${b.change}, ${b.changePercent >= 0 ? '+' : ''}${b.changePercent}%)

🤖 This video is 100% AI-generated:
• Script: Amazon Nova Lite
• Voice: Amazon Polly (Kajal, Indian English)
• Charts: TradingView Lightweight Charts
• Pipeline: AalsiTrader Prime Speaks Factory

🔗 Start algo trading with AI: https://aalsitrader.com
📱 Follow us for daily market updates

⚠️ Disclaimer: This is AI-generated educational content, not financial advice. AalsiTrader is not a SEBI-registered advisor. Always do your own research.

#Nifty #BankNifty #StockMarket #Trading #AlgoTrading #AI #AalsiTrader #MarketAnalysis #IndianStockMarket #NSE #BSE #PrimeMarketPulse`;

  const tags = [
    'nifty', 'bank nifty', 'stock market', 'nifty today', 'market analysis',
    'trading', 'algo trading', 'AI trading', 'aalsitrader', 'indian stock market',
    'nse', 'bse', 'sensex', 'nifty 50', 'market pulse', 'daily market update',
    'support resistance', 'technical analysis', 'prime market pulse',
  ];

  return { title: title.slice(0, 100), description, tags };
}

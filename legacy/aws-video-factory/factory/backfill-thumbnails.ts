#!/usr/bin/env npx tsx
/**
 * Backfill — regenerate thumbnails for already-uploaded YouTube videos
 *               and replace them via youtube.thumbnails.set.
 *
 * Use cases:
 *   - Picked up a new thumbnail design (e.g., added Aalsi face PNGs)
 *   - Want to replace old emoji-less thumbnails on existing videos
 *
 * Reads:  prime-speaks-feed.json (S3 OR ../out/)
 * Parses:  title to recover the data each video was rendered from
 * Renders: new PNG via generateDailyThumbnail / generateEarningsThumbnail
 * Uploads: via youtube.thumbnails.set (replaces what's on YouTube)
 *
 * Usage:
 *   npx tsx factory/backfill-thumbnails.ts                 # all videos
 *   npx tsx factory/backfill-thumbnails.ts --earnings-only # skip daily
 *   npx tsx factory/backfill-thumbnails.ts --dry           # don't upload
 *
 * Costs:
 *   YouTube API quota: 50 units per thumbnails.set call.
 *   Daily quota = 10,000 → can backfill ~200 videos/day.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { resolve } from 'path';
import { generateDailyThumbnail, generateEarningsThumbnail } from './thumbnail';

const FEED_URL = 'https://aalsitrader.com/prime-speaks-feed.json';
const FEED_LOCAL = resolve(__dirname, '..', 'out', 'prime-speaks-feed.json');
const OUT_DIR = resolve(__dirname, '..', 'out', 'backfill');
const CLIENT_SECRET_PATH = '/Users/tapas/Desktop/client_secret.json';
const TOKEN_PATH = resolve(__dirname, '..', '.youtube-token.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const EARNINGS_ONLY = args.includes('--earnings-only');

interface FeedVideo {
  videoId: string;
  url: string;
  title: string;
  date: string;
  type: 'daily-market-update' | 'earnings-analysis' | string;
  thumbnailUrl: string;
}

// ─── Parsing titles to recover thumbnail data ───────────────────────────────

interface DailyTitleData {
  niftyValue: number;
  niftyChangePercent: number;
  bankNiftyValue: number;
  bankNiftyChangePercent: number;
}

function parseDailyTitle(title: string): DailyTitleData | null {
  // Examples:
  //  "Nifty 24177.65 (+0.76%) 📈 | Prime's Market Pulse | 29 Apr 2026"
  //  "Nifty 22,679 (+1.56%) — Bulls in Control | Daily Market Update"
  const m = title.match(/Nifty\s+([\d,.]+)\s*\(([+-]?[\d.]+)%\)/i);
  if (!m) return null;
  const niftyValue = parseFloat(m[1].replace(/,/g, ''));
  const niftyChangePercent = parseFloat(m[2]);
  if (Number.isNaN(niftyValue) || Number.isNaN(niftyChangePercent)) return null;
  // Bank Nifty isn't in the title — use 0/0 (the thumbnail's bn line will show
  // "Bank Nifty 0 (+0.00%)" but that's better than skipping the backfill).
  // If you want accurate bank nifty for backfill, fetch historical from Yahoo
  // here using the date — out of scope for the basic backfill.
  return { niftyValue, niftyChangePercent, bankNiftyValue: 0, bankNiftyChangePercent: 0 };
}

interface EarningsTitleData {
  companyName: string;
  ticker: string;
  quarter: string;
  hook: string;
  direction: 'up' | 'down' | 'mixed';
}

function parseEarningsTitle(title: string): EarningsTitleData | null {
  // Examples:
  //  "ACC Ltd Mar 2026 Results — Net Profit -68% YoY · Margins Contract | Prime AI Deep Dive"
  //  "Bajaj Finance Ltd Q4 Results: Net Profit +24% YoY · Margins Stable | Prime AI Deep Dive"
  //  "Manappuram Finance Ltd Dec 2025 Results — Net Profit -14% YoY · Margins Stable | Prime AI Deep Dive"
  const m = title.match(/^(.+?)\s+(Q[1-4]|Mar|Jun|Sep|Dec)\s*(\d{4})?\s*Results[\s—:-]+(.+?)\s*\|/i);
  if (!m) return null;
  const companyName = m[1].trim();
  const quarterPart = m[2];
  const year = m[3] || '';
  const quarter = year ? `${quarterPart} ${year}` : quarterPart;
  const hook = m[4].trim();
  // Direction from net-profit sign in hook
  const directionMatch = hook.match(/Net Profit\s+([+-])/i);
  let direction: 'up' | 'down' | 'mixed' = 'mixed';
  if (directionMatch) direction = directionMatch[1] === '+' ? 'up' : 'down';
  // Ticker can't be recovered from title reliably; use uppercased company name.
  const ticker = companyName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return { companyName, ticker, quarter, hook, direction };
}

// ─── YouTube auth (refresh-token based) ─────────────────────────────────────

async function getAuthClient() {
  const creds = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:8085');
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`No token at ${TOKEN_PATH}. Run pipeline.ts once interactively first.`);
  }
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
  oauth2.setCredentials(token);
  if (token.expiry_date && token.expiry_date < Date.now()) {
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);
    writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
    console.log('  Refreshed access token.');
  }
  return oauth2;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // Load feed: prefer S3 (always latest), fallback to local
  let feed: FeedVideo[] = [];
  try {
    const r = await fetch(FEED_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    feed = (await r.json()) as FeedVideo[];
    console.log(`Loaded ${feed.length} videos from ${FEED_URL}`);
  } catch (err) {
    console.warn(`S3 feed fetch failed (${err}); trying local…`);
    if (existsSync(FEED_LOCAL)) {
      feed = JSON.parse(readFileSync(FEED_LOCAL, 'utf-8'));
      console.log(`Loaded ${feed.length} videos from ${FEED_LOCAL}`);
    } else {
      throw new Error('No feed available — pass a --feed=path/to/feed.json arg or run pipeline first');
    }
  }

  const youtube = DRY ? null : google.youtube({ version: 'v3', auth: await getAuthClient() });
  if (DRY) console.log('DRY MODE — thumbnails will render to disk but NOT upload.');

  const stats = { total: feed.length, attempted: 0, succeeded: 0, skipped: 0, failed: 0 };

  for (const v of feed) {
    if (EARNINGS_ONLY && v.type !== 'earnings-analysis') {
      console.log(`  [skip] ${v.videoId} — not earnings (${v.type})`);
      stats.skipped++;
      continue;
    }
    stats.attempted++;
    const outPath = resolve(OUT_DIR, `${v.videoId}.png`);
    try {
      if (v.type === 'daily-market-update') {
        const data = parseDailyTitle(v.title);
        if (!data) { console.log(`  [skip] ${v.videoId} — could not parse daily title`); stats.skipped++; continue; }
        await generateDailyThumbnail({ ...data, date: v.date }, outPath);
      } else {
        const data = parseEarningsTitle(v.title);
        if (!data) { console.log(`  [skip] ${v.videoId} — could not parse earnings title: ${v.title.slice(0, 60)}`); stats.skipped++; continue; }
        await generateEarningsThumbnail(data, outPath);
      }
      console.log(`  [render] ${v.videoId} → ${outPath}`);

      if (DRY) { stats.succeeded++; continue; }

      await youtube!.thumbnails.set({
        videoId: v.videoId,
        media: { mimeType: 'image/png', body: createReadStream(outPath) },
      });
      console.log(`  [upload] ${v.videoId} ✓`);
      stats.succeeded++;
    } catch (err: any) {
      console.error(`  [fail] ${v.videoId}: ${err?.message || err}`);
      stats.failed++;
    }
  }

  console.log('\nDone:', stats);
}

main().catch((err) => { console.error(err); process.exit(1); });

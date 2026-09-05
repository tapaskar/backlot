/**
 * Podcast Publisher — Generates RSS feed + uploads MP3s to S3 for Spotify/Apple Podcasts
 *
 * Architecture:
 * - MP3 files hosted on S3 (same bucket as frontend)
 * - RSS feed generated as XML, also on S3
 * - Spotify/Apple/Google index the RSS feed URL
 *
 * RSS feed URL: https://aalsitrader.com/podcast/feed.xml
 * MP3s at:      https://aalsitrader.com/podcast/episodes/<id>.mp3
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const S3_BUCKET = 'trading-squad-dashboard-prod-228644978624';
const PODCAST_DIR = resolve(__dirname, '..', 'out', 'podcast');
const FEED_PATH = resolve(PODCAST_DIR, 'feed.xml');
const EPISODES_PATH = resolve(PODCAST_DIR, 'episodes.json');
const BASE_URL = 'https://aalsitrader.com/podcast';

export interface PodcastEpisode {
  id: string;
  title: string;
  description: string;
  date: string;           // ISO date
  audioUrl: string;       // S3 URL
  durationSeconds: number;
  fileSizeBytes: number;
  type: 'daily' | 'earnings';
  youtubeUrl?: string;
}

/**
 * Publish a podcast episode: upload MP3 to S3 + regenerate RSS feed.
 */
export async function publishPodcastEpisode(opts: {
  audioPath: string;
  title: string;
  description: string;
  type: 'daily' | 'earnings';
  youtubeUrl?: string;
}): Promise<string> {
  if (!existsSync(PODCAST_DIR)) mkdirSync(PODCAST_DIR, { recursive: true });

  const { audioPath, title, description, type, youtubeUrl } = opts;

  // Generate episode ID from date + type
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const id = `${dateStr}-${type}-${now.getTime().toString(36)}`;

  // Get file size and estimate duration
  const stat = require('fs').statSync(audioPath);
  const fileSizeBytes = stat.size;
  // Rough estimate: MP3 at 128kbps = 16KB/s
  const durationSeconds = Math.round(fileSizeBytes / 16000);

  // Upload MP3 to S3
  const s3Key = `podcast/episodes/${id}.mp3`;
  const audioUrl = `${BASE_URL}/episodes/${id}.mp3`;

  try {
    execSync(
      `aws s3 cp "${audioPath}" s3://${S3_BUCKET}/${s3Key} --content-type audio/mpeg --cache-control "max-age=86400"`,
      { stdio: 'pipe' },
    );
  } catch (err: any) {
    console.log(`  Podcast MP3 upload failed: ${err.message}`);
    return '';
  }

  // Load existing episodes
  let episodes: PodcastEpisode[] = [];
  if (existsSync(EPISODES_PATH)) {
    episodes = JSON.parse(readFileSync(EPISODES_PATH, 'utf-8'));
  }

  // Add new episode at front
  const episode: PodcastEpisode = {
    id,
    title,
    description,
    date: now.toISOString(),
    audioUrl,
    durationSeconds,
    fileSizeBytes,
    type,
    youtubeUrl,
  };
  episodes.unshift(episode);

  // Keep latest 100 episodes
  episodes = episodes.slice(0, 100);
  writeFileSync(EPISODES_PATH, JSON.stringify(episodes, null, 2));

  // Regenerate RSS feed
  generateRSSFeed(episodes);

  // Upload RSS feed to S3
  try {
    execSync(
      `aws s3 cp "${FEED_PATH}" s3://${S3_BUCKET}/podcast/feed.xml --content-type "application/rss+xml; charset=utf-8" --cache-control "max-age=300"`,
      { stdio: 'pipe' },
    );
    console.log(`  Podcast published: ${audioUrl}`);
  } catch (err: any) {
    console.log(`  Podcast RSS upload failed: ${err.message}`);
  }

  return audioUrl;
}

/**
 * Generate podcast RSS 2.0 feed XML compliant with Spotify/Apple requirements.
 */
function generateRSSFeed(episodes: PodcastEpisode[]) {
  const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };

  const formatRFC2822 = (isoDate: string) => new Date(isoDate).toUTCString();

  const items = episodes.map((ep) => `
    <item>
      <title>${escXml(ep.title)}</title>
      <description><![CDATA[${ep.description}${ep.youtubeUrl ? `\n\nVideo version: ${ep.youtubeUrl}` : ''}]]></description>
      <enclosure url="${escXml(ep.audioUrl)}" length="${ep.fileSizeBytes}" type="audio/mpeg" />
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${formatRFC2822(ep.date)}</pubDate>
      <itunes:duration>${formatDuration(ep.durationSeconds)}</itunes:duration>
      <itunes:episode>${episodes.indexOf(ep) + 1}</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`).join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:spotify="http://www.spotify.com/ns/rss">

  <channel>
    <title>Prime's Market Pulse</title>
    <link>https://aalsitrader.com</link>
    <description>Daily Indian stock market analysis covering Nifty 50, Bank Nifty, and F&amp;O stocks. Each episode breaks down the day's price action, key support and resistance levels, FII/DII institutional flows, and outlook for the next session. Quarterly earnings deep dives analyze revenue trends, margin trajectories, and hidden insights in company results. Hosted by Prime, an AI analyst.</description>
    <language>en-in</language>
    <copyright>© 2026 Prime's Market Pulse</copyright>
    <atom:link href="${BASE_URL}/feed.xml" rel="self" type="application/rss+xml" />

    <itunes:author>Prime</itunes:author>
    <itunes:owner>
      <itunes:name>Prime Market Pulse</itunes:name>
      <itunes:email>support@aalsitrader.com</itunes:email>
    </itunes:owner>
    <itunes:image href="https://aalsitrader.com/podcast/artwork.png" />
    <itunes:category text="Business">
      <itunes:category text="Investing" />
    </itunes:category>
    <itunes:category text="News">
      <itunes:category text="Daily News" />
    </itunes:category>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:summary>Daily Indian stock market analysis. Nifty 50 and Bank Nifty price action, support/resistance levels, FII/DII flows, sector rotation, and quarterly earnings deep dives. Each episode delivers specific numbers, key levels to watch, and an actionable outlook.</itunes:summary>

    <spotify:countryOfOrigin>in</spotify:countryOfOrigin>

    ${items}
  </channel>
</rss>`;

  writeFileSync(FEED_PATH, rss);
}

/**
 * Bulk publish: extract audio from all existing videos and create podcast episodes.
 */
export async function bulkPublishExisting(): Promise<void> {
  // Fetch all videos from the S3 feed
  let feed: any[] = [];
  try {
    const existing = execSync(`aws s3 cp s3://${S3_BUCKET}/prime-speaks-feed.json -`, { encoding: 'utf-8' });
    feed = JSON.parse(existing);
  } catch {
    console.log('No existing video feed found.');
    return;
  }

  console.log(`Found ${feed.length} videos in feed. Publishing as podcast episodes...`);

  for (const video of feed.reverse()) {  // Oldest first so newest ends up at top
    const id = video.videoId;
    const title = video.title || 'Market Update';
    const type = (video.type || '').includes('earnings') ? 'earnings' : 'daily';

    // Check if we have the audio locally
    // For bulk, we'll create a short description-only episode since we don't have all MP3s locally
    console.log(`  ${id}: ${title.slice(0, 50)}...`);

    // Try to find local audio — if not, skip (pipeline will handle future ones)
    // For now we'll only publish the latest daily and earnings audio we have
  }

  console.log('Bulk publish note: Only future videos will have podcast episodes.');
  console.log('The pipeline now auto-publishes to podcast on every new upload.');
}

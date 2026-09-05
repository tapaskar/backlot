/**
 * One-shot audit of the AalsiTrader channel.
 *
 * For every uploaded video, checks the description for the upload-guard
 * fingerprint marker `[ats-fp:<8hex>]` and classifies it:
 *
 *   GUARDED (this Mac)   description contains [ats-fp:<thisMacFp>]
 *   GUARDED (other fp)   contains some other [ats-fp:...] — different machine
 *                        has been enrolled (unexpected for now)
 *   UNSTAMPED-LEGACY     no fingerprint AND uploaded before guard was deployed
 *   UNSTAMPED-SUSPECT    no fingerprint AND uploaded AFTER guard was deployed
 *                        → these are the ones from another machine running
 *                          old code that doesn't call assertUploadAllowed()
 *
 * Usage:
 *   cd /Volumes/wininstall/trading-dashboard/video
 *   npx tsx factory/audit-uploads.ts                       # full channel
 *   npx tsx factory/audit-uploads.ts --cutoff 2026-05-12   # override guard-deploy date
 *   npx tsx factory/audit-uploads.ts --suspect-only        # only list suspect rows
 */

import { google } from 'googleapis';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve } from 'path';

const SECRET = existsSync(resolve(__dirname, '..', '.client_secret.json'))
  ? resolve(__dirname, '..', '.client_secret.json')
  : '/Users/tapas/Desktop/client_secret.json';
const TOKEN = resolve(__dirname, '..', '.youtube-token.json');
const GUARD = resolve(__dirname, '..', '.upload-guard');

const args = process.argv.slice(2);
const SUSPECT_ONLY = args.includes('--suspect-only');
const cutoffIdx = args.indexOf('--cutoff');
const CUTOFF_OVERRIDE = cutoffIdx >= 0 ? args[cutoffIdx + 1] : '';

// Determine the guard-deploy cutoff. Two strategies, in priority order:
//   1. Explicit --cutoff YYYY-MM-DD flag
//   2. Take the mtime of youtube-upload.ts (when guard was wired in)
function getCutoff(): Date {
  if (CUTOFF_OVERRIDE) return new Date(CUTOFF_OVERRIDE);
  const file = resolve(__dirname, 'youtube-upload.ts');
  if (existsSync(file)) {
    return new Date(statSync(file).mtime);
  }
  return new Date(0);
}

function getMyFingerprint(): string | null {
  if (!existsSync(GUARD)) return null;
  try {
    const g = JSON.parse(readFileSync(GUARD, 'utf-8'));
    return g.uuid.replace(/-/g, '').slice(0, 8);
  } catch { return null; }
}

const FP_REGEX = /\[ats-fp:([0-9a-f]{8})\]/i;

async function main() {
  const myFp = getMyFingerprint();
  const cutoff = getCutoff();
  console.log(`Audit anchor:`);
  console.log(`  This-Mac fingerprint  : ${myFp || '(no .upload-guard on this Mac)'}`);
  console.log(`  Guard-deploy cutoff   : ${cutoff.toISOString().slice(0, 10)}  (videos before this can legitimately lack a stamp)`);
  console.log('');

  const c = JSON.parse(readFileSync(SECRET, 'utf-8'));
  const o = new google.auth.OAuth2(c.installed.client_id, c.installed.client_secret, 'http://localhost:8085');
  o.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf-8')));
  const yt = google.youtube({ version: 'v3', auth: o });

  // 1. Resolve uploads playlist
  const ch = await yt.channels.list({ mine: true, part: ['contentDetails'] });
  const playlistId = ch.data.items![0].contentDetails!.relatedPlaylists!.uploads!;

  // 2. Page through every upload
  const allIds: { videoId: string; publishedAt: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r = await yt.playlistItems.list({ playlistId, part: ['contentDetails'], maxResults: 50, pageToken });
    for (const it of r.data.items || []) {
      const vid = it.contentDetails?.videoId;
      const at = it.contentDetails?.videoPublishedAt;
      if (vid && at) allIds.push({ videoId: vid, publishedAt: at });
    }
    pageToken = r.data.nextPageToken || undefined;
  } while (pageToken);
  console.log(`Total uploads on channel: ${allIds.length}`);

  // 3. Fetch snippet for each (50 at a time)
  const buckets = {
    GUARDED_MINE: [] as { id: string; at: string; title: string }[],
    GUARDED_OTHER: [] as { id: string; at: string; title: string; fp: string }[],
    UNSTAMPED_LEGACY: [] as { id: string; at: string; title: string }[],
    UNSTAMPED_SUSPECT: [] as { id: string; at: string; title: string }[],
  };

  for (let i = 0; i < allIds.length; i += 50) {
    const chunk = allIds.slice(i, i + 50);
    const r = await yt.videos.list({ id: chunk.map(x => x.videoId), part: ['snippet'] });
    for (const v of r.data.items || []) {
      const at = chunk.find(x => x.videoId === v.id)?.publishedAt || '';
      const title = (v.snippet?.title || '').slice(0, 80);
      const desc = v.snippet?.description || '';
      const m = desc.match(FP_REGEX);
      const fp = m ? m[1].toLowerCase() : null;
      const row = { id: v.id!, at: at.slice(0, 10), title };
      if (fp && myFp && fp === myFp) buckets.GUARDED_MINE.push(row);
      else if (fp) buckets.GUARDED_OTHER.push({ ...row, fp });
      else if (new Date(at) < cutoff) buckets.UNSTAMPED_LEGACY.push(row);
      else buckets.UNSTAMPED_SUSPECT.push(row);
    }
  }

  // 4. Print summary
  console.log('');
  console.log(`Summary:`);
  console.log(`  GUARDED  (this Mac, ats-fp=${myFp}) : ${buckets.GUARDED_MINE.length}`);
  console.log(`  GUARDED  (other fingerprints)        : ${buckets.GUARDED_OTHER.length}`);
  console.log(`  UNSTAMPED LEGACY (pre-cutoff, OK)    : ${buckets.UNSTAMPED_LEGACY.length}`);
  console.log(`  UNSTAMPED SUSPECT (post-cutoff)      : ${buckets.UNSTAMPED_SUSPECT.length}  <-- these are from another machine`);
  console.log('');

  if (!SUSPECT_ONLY && buckets.GUARDED_MINE.length) {
    console.log(`--- GUARDED (this Mac) ---`);
    for (const r of buckets.GUARDED_MINE) console.log(`  ${r.id}  ${r.at}  ${r.title}`);
    console.log('');
  }
  if (buckets.GUARDED_OTHER.length) {
    console.log(`--- GUARDED (other fingerprints) ---`);
    for (const r of buckets.GUARDED_OTHER) console.log(`  ${r.id}  ${r.at}  fp=${r.fp}  ${r.title}`);
    console.log('');
  }
  if (buckets.UNSTAMPED_SUSPECT.length) {
    console.log(`--- UNSTAMPED SUSPECT (uploaded after ${cutoff.toISOString().slice(0,10)} but no fingerprint) ---`);
    for (const r of buckets.UNSTAMPED_SUSPECT) console.log(`  ${r.id}  ${r.at}  ${r.title}`);
    console.log('');
  }
  if (!SUSPECT_ONLY && buckets.UNSTAMPED_LEGACY.length) {
    console.log(`--- UNSTAMPED LEGACY (${buckets.UNSTAMPED_LEGACY.length} videos, pre-guard, suppressed unless --all) ---`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

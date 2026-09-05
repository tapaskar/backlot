/**
 * Shared thumbnail upload with retry + loud failure logging.
 * Used by: earnings-pipeline.ts, pipeline.ts, backfill-thumbnails.ts.
 */

import { google } from 'googleapis';
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { assertUploadAllowed } from './upload-guard';

// Resolution order:
//   1. $YOUTUBE_CLIENT_SECRET (explicit override)
//   2. <repo>/.client_secret.json (project-local, accessible to launchd)
//   3. ~/Desktop/client_secret.json (legacy; only readable from interactive Terminal w/ Full Disk Access)
const CLIENT_SECRET_PATH =
  process.env.YOUTUBE_CLIENT_SECRET ||
  (existsSync(resolve(__dirname, '..', '.client_secret.json'))
    ? resolve(__dirname, '..', '.client_secret.json')
    : '/Users/tapas/Desktop/client_secret.json');
const TOKEN_PATH = process.env.YOUTUBE_TOKEN_PATH
  ? resolve(process.env.YOUTUBE_TOKEN_PATH)
  : resolve(__dirname, '..', '.youtube-token.json');
const FAILURE_MARKER = resolve(__dirname, '..', 'out', '.thumbnail-failures.log');

function authenticatedYouTube() {
  const creds = JSON.parse(readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:8085');
  oauth2.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')));
  return google.youtube({ version: 'v3', auth: oauth2 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Set the thumbnail for a video, retrying on rate-limit / quota errors.
 *
 * On terminal failure, appends a line to `out/.thumbnail-failures.log` so the
 * user can spot misses without grepping every pipeline log, and re-throws so
 * launchd records a non-zero exit (visible in `Console.app`).
 */
export async function setVideoThumbnailWithRetry(
  videoId: string,
  thumbnailPath: string,
  retries = 4
): Promise<void> {
  // GUARD: refuse to mutate channel state from an unauthorised machine.
  assertUploadAllowed('setVideoThumbnail');

  const yt = authenticatedYouTube();
  let attempt = 0;
  while (true) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { mimeType: 'image/png', body: createReadStream(thumbnailPath) },
      });
      console.log(`  ✓ thumbnail set on ${videoId}`);
      return;
    } catch (err: any) {
      const msg: string = err?.errors?.[0]?.message || err?.message || String(err);
      const rateLimited = /too many thumbnails|rateLimit|quotaExceeded|userRateLimitExceeded/i.test(msg);
      if (!rateLimited || attempt >= retries) {
        const line = `${new Date().toISOString()}\t${videoId}\t${thumbnailPath}\t${msg.slice(0, 200)}\n`;
        try {
          if (!existsSync(resolve(__dirname, '..', 'out'))) {
            // out/ should exist; if not, swallow — main pipeline already created it.
          }
          writeFileSync(FAILURE_MARKER, line, { flag: 'a' });
        } catch {}
        console.error(`  ✗ thumbnail FAILED for ${videoId}: ${msg}`);
        console.error(`    logged to ${FAILURE_MARKER}`);
        throw err;
      }
      const backoff = 60 * Math.pow(2, attempt); // 60, 120, 240, 480 s
      console.log(`  rate-limited; sleeping ${backoff}s then retrying (attempt ${attempt + 1}/${retries})...`);
      await sleep(backoff * 1000);
      attempt++;
    }
  }
}

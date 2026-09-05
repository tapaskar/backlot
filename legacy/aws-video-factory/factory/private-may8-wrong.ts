/**
 * One-shot: set the 3 wrong-quarter May-8 videos to privacyStatus=private.
 * Reversible from YouTube Studio — flip back to "Public" any time.
 *
 *   Q55xvAzkZ3s  Metropolis Healthcare Dec 2025  (should have been Mar 2026)
 *   ldskxKwSC4g  Bank of Baroda     Dec 2025
 *   UA7zj_0nScE  Tata Consumer      Dec 2025
 *
 * (ABB India p2knt9dFhd8 left alone — calendar-year reporter, Dec 2025 likely legit.)
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const SECRET = existsSync(resolve(__dirname, '..', '.client_secret.json'))
  ? resolve(__dirname, '..', '.client_secret.json')
  : '/Users/tapas/Desktop/client_secret.json';
const TOKEN = resolve(__dirname, '..', '.youtube-token.json');

const TARGET_IDS = ['Q55xvAzkZ3s', 'ldskxKwSC4g', 'UA7zj_0nScE'];

(async () => {
  const c = JSON.parse(readFileSync(SECRET, 'utf-8'));
  const o = new google.auth.OAuth2(c.installed.client_id, c.installed.client_secret, 'http://localhost:8085');
  o.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf-8')));
  const yt = google.youtube({ version: 'v3', auth: o });

  // Need current snippet (categoryId etc.) to round-trip on update; videos.update
  // is a full PUT, missing fields can be wiped. Fetch snippet+status first.
  const r = await yt.videos.list({ id: TARGET_IDS, part: ['snippet', 'status'] });
  for (const v of r.data.items || []) {
    try {
      await yt.videos.update({
        part: ['status'],
        requestBody: {
          id: v.id!,
          status: { privacyStatus: 'private', selfDeclaredMadeForKids: v.status?.selfDeclaredMadeForKids ?? false },
        },
      });
      console.log(`  ${v.id}  ${v.snippet?.title?.slice(0, 60)} → private`);
    } catch (err: any) {
      console.error(`  ${v.id}  FAILED: ${err?.message || err}`);
    }
  }
})();

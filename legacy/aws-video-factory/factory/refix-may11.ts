/**
 * One-shot: re-render and re-upload the May-11 daily thumbnail. The cron failed
 * at script-validator at 16:05; the video that's live (NqRBnxoBMPk, uploaded
 * 16:09 IST) came from somewhere with stale pre-rewrite code and shows the old
 * "BEARS STRIKE" layout — no Prime face.
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { generateDailyThumbnail } from './thumbnail';
import { setVideoThumbnailWithRetry } from './youtube-thumb';

const SECRET = existsSync(resolve(__dirname, '..', '.client_secret.json'))
  ? resolve(__dirname, '..', '.client_secret.json')
  : '/Users/tapas/Desktop/client_secret.json';
const TOKEN = resolve(__dirname, '..', '.youtube-token.json');

(async () => {
  const c = JSON.parse(readFileSync(SECRET, 'utf-8'));
  const o = new google.auth.OAuth2(c.installed.client_id, c.installed.client_secret, 'http://localhost:8085');
  o.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf-8')));
  const yt = google.youtube({ version: 'v3', auth: o });

  const r = await yt.videos.list({ id: ['NqRBnxoBMPk'], part: ['snippet'] });
  const v = r.data.items?.[0];
  if (!v) { console.error('not found'); process.exit(1); }
  const title = v.snippet?.title || '';
  console.log('title:', title);

  // Parse from title: "Nifty 23815.85 (-1.49%) 📉 | Prime's Market Pulse | 11 May 2026"
  const m = title.match(/^Nifty\s+([\d,.]+)\s*\(([+-]?\d+(?:\.\d+)?)%\)/i);
  if (!m) { console.error('parse fail'); process.exit(1); }
  const niftyValue = parseFloat(m[1].replace(/,/g, ''));
  const niftyChangePercent = parseFloat(m[2]);

  // Bank Nifty from description if present, else 0/0 small subline
  const desc = v.snippet?.description || '';
  const bn = desc.match(/Bank\s+Nifty[:\s]+([\d,.]+).*?([+-]?\d+(?:\.\d+)?)%/i);
  const bankNiftyValue = bn ? parseFloat(bn[1].replace(/,/g, '')) : 0;
  const bankNiftyChangePercent = bn ? parseFloat(bn[2]) : 0;

  const dateM = title.match(/\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*$/);
  const date = dateM ? dateM[1] : '11 May 2026';

  const out = resolve(__dirname, '..', 'out', 'refix-may11', 'NqRBnxoBMPk.png');
  require('fs').mkdirSync(resolve(out, '..'), { recursive: true });

  await generateDailyThumbnail({ niftyValue, niftyChangePercent, bankNiftyValue, bankNiftyChangePercent, date }, out);
  console.log('rendered:', out);
  await setVideoThumbnailWithRetry('NqRBnxoBMPk', out);
})();

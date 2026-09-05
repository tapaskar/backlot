/**
 * One-shot: re-render and re-upload thumbnails for the 7 videos that shipped
 * with the OLD pre-rewrite layout on May 8 2026 (cron ran before the
 * thumbnail.ts rewrite landed at 10:27 AM).
 *
 * Run: npx tsx factory/refix-may8.ts
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { generateDailyThumbnail, generateEarningsThumbnail } from './thumbnail';
import { setVideoThumbnailWithRetry } from './youtube-thumb';

const SECRET = existsSync(resolve(__dirname, '..', '.client_secret.json'))
  ? resolve(__dirname, '..', '.client_secret.json')
  : '/Users/tapas/Desktop/client_secret.json';
const TOKEN = resolve(__dirname, '..', '.youtube-token.json');

const TARGET_IDS = [
  'Q55xvAzkZ3s',
  'hqLmocxuXaA',
  '4m-pousw8AI',
  'ldskxKwSC4g',
  'UA7zj_0nScE',
  'p2knt9dFhd8',
  'andwuxprMPM',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseDailyTitle(title: string) {
  const m = title.match(/^Nifty\s+([\d,.]+)\s*\(([+-]?\d+(?:\.\d+)?)%\)/i);
  if (!m) return null;
  const niftyValue = parseFloat(m[1].replace(/,/g, ''));
  const niftyChangePercent = parseFloat(m[2]);
  const dateMatch = title.match(/\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*$/);
  const date = dateMatch ? dateMatch[1] : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return { niftyValue, niftyChangePercent, date };
}

function parseEarningsTitle(title: string, description: string, tags: string[]) {
  if (!/Results/i.test(title)) return null;
  const pctMatch = title.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  const isFlat = /\bFlat\b/i.test(title);
  const changePercent = pctMatch ? Math.round(parseFloat(pctMatch[1])) : 0;
  const direction: 'up' | 'down' | 'mixed' =
    changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'mixed';
  const qMatch = title.match(/\b(Q[1-4]|Mar|Jun|Sep|Dec)\s*(\d{4})?\b/i);
  const quarter = qMatch ? `${qMatch[1]}${qMatch[2] ? ' ' + qMatch[2] : ''}` : 'Latest';
  const idx = qMatch ? title.indexOf(qMatch[0]) : -1;
  const companyName = idx > 0 ? title.slice(0, idx).trim() : title.split(/\s+Results/i)[0].trim();
  const STOPWORDS = new Set(['aalsitrader', 'earnings', 'results', 'quarterly', 'stock', 'analysis', 'deep', 'dive', 'indian', 'market', 'nse', 'bse', 'prime']);
  const descTicker = description.match(/\(([A-Z][A-Z0-9&-]{2,15})\)/)?.[1];
  const tagTicker = tags
    .filter((t) => /^[a-z][a-z0-9-]{2,15}$/.test(t) && !STOPWORDS.has(t) && !t.includes(' '))
    .find((t) => !companyName.toLowerCase().includes(t));
  const ticker =
    descTicker ||
    (tagTicker ? tagTicker.toUpperCase() : '') ||
    companyName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) ||
    'STOCK';
  const hookMatch = title.match(/Net Profit[^|]+/i);
  const hook = hookMatch ? hookMatch[0].trim() : '';
  return { companyName, ticker, quarter, hook, direction, changePercent: isFlat ? 0 : changePercent };
}

(async () => {
  const c = JSON.parse(readFileSync(SECRET, 'utf-8'));
  const o = new google.auth.OAuth2(c.installed.client_id, c.installed.client_secret, 'http://localhost:8085');
  o.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf-8')));
  const yt = google.youtube({ version: 'v3', auth: o });

  const r = await yt.videos.list({ id: TARGET_IDS, part: ['snippet'] });
  const items = r.data.items || [];

  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    const id = v.id!;
    const title = v.snippet?.title || '';
    const description = v.snippet?.description || '';
    const tags = v.snippet?.tags || [];
    const isDaily = /^Nifty\s+\d/i.test(title);

    const out = resolve(__dirname, '..', 'out', 'refix-may8', `${id}.png`);
    const outDir = resolve(out, '..');
    if (!existsSync(outDir)) require('fs').mkdirSync(outDir, { recursive: true });

    try {
      if (isDaily) {
        const d = parseDailyTitle(title);
        if (!d) { console.log(`[skip] ${id} daily parse failed`); continue; }
        await generateDailyThumbnail({
          niftyValue: d.niftyValue, niftyChangePercent: d.niftyChangePercent,
          // Bank Nifty unknown from title — use 0/0 (small subline only)
          bankNiftyValue: 0, bankNiftyChangePercent: 0,
          date: d.date,
        }, out);
      } else {
        const e = parseEarningsTitle(title, description, tags);
        if (!e) { console.log(`[skip] ${id} earnings parse failed: ${title.slice(0, 60)}`); continue; }
        await generateEarningsThumbnail({
          companyName: e.companyName, ticker: e.ticker, quarter: e.quarter, hook: e.hook,
          direction: e.direction, changePercent: e.changePercent, changeLabel: 'Net Profit YoY',
        }, out);
      }
      console.log(`[render] ${id} ${isDaily ? 'NIFTY' : title.slice(0, 40)} → ${out}`);

      if (i > 0) {
        console.log(`  pacing 30s...`);
        await sleep(30_000);
      }
      await setVideoThumbnailWithRetry(id, out);
    } catch (err: any) {
      console.error(`[fail] ${id}: ${err?.message || err}`);
    }
  }
})();

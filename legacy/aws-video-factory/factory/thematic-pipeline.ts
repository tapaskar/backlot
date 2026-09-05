#!/usr/bin/env npx tsx
/**
 * Prime Speaks — Thematic Deep Dive Pipeline
 *
 * Usage:
 *   npx tsx factory/thematic-pipeline.ts            # uses the hardcoded TOPIC/BRIEF below
 *   npx tsx factory/thematic-pipeline.ts <slug>     # future: pick from a registry
 *
 * Pipeline:
 *   1. Fetch macro context (Nifty + Nifty Infra index) + stock prices for the basket
 *   2. Build a long-form thematic prompt
 *   3. Call the shared LLM dispatcher (Gemini → Claude → Nova Pro)
 *   4. Polly Kajal narration
 *   5. Puppeteer scenes: intro, theme overview, stock comparison table, outro
 *   6. FFmpeg compose
 *   7. YouTube upload + podcast publish
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync, createReadStream } from 'fs';
import { resolve } from 'path';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { google } from 'googleapis';
import puppeteer from 'puppeteer';
import { parseSpeechMarks } from '../src/audio-sync';
import { composeVideo } from './video-compose';
import { uploadToYouTube, syncFeedToS3 } from './youtube-upload';
import { publishPodcastEpisode } from './podcast';
import { callLLM, stripMarkdown } from './llm';
import { validateGeneric, type SymbolDirection } from './script-validator';

const REGION = 'ap-south-1';
const polly = new PollyClient({ region: REGION });

const OUT_DIR = resolve(__dirname, '..', 'out', 'thematic');
const FRAMES_DIR = resolve(OUT_DIR, 'frames');

// ─── Topic + Brief ──────────────────────────────────────────────────────────

const TOPIC = 'Decoding The Impact Of New Trade Corridors On Nifty Infrastructure Sector Stocks';

const BRIEF = `New trade corridors are redrawing logistics maps, forcing us to identify which infrastructure stocks will lead this industrial shift. We must dissect port throughput data and rail connectivity metrics to pinpoint the specific companies poised for growth. Our analysis isolates the precise intersection where strategic geography meets long-term capital appreciation and scalability.`;

// Infrastructure basket — F&O / Nifty stocks with direct exposure to corridor logistics
const STOCKS = [
  { ticker: 'ADANIPORTS', sym: 'ADANIPORTS.NS', focus: "India's largest commercial port operator — Mundra, Krishnapatnam, Ennore, Karaikal — direct exposure to coastal-to-hinterland evacuation via DFC" },
  { ticker: 'LT', sym: 'LT.NS', focus: 'Engineering & construction giant — heavy infra, railway electrification, port construction, urban metros, BharatMala HAM projects' },
  { ticker: 'CONCOR', sym: 'CONCOR.NS', focus: 'Container Corporation of India — rail-based container logistics, ICDs, biggest beneficiary of DFC throughput tailwind' },
  { ticker: 'POWERGRID', sym: 'POWERGRID.NS', focus: 'Pan-India transmission monopoly — power evacuation backbone for industrial corridor clusters' },
  { ticker: 'GMRAIRPORT', sym: 'GMRAIRPORT.NS', focus: 'Multi-airport operator — Delhi, Hyderabad, Goa cargo terminals tied to corridor logistics' },
  { ticker: 'IRB', sym: 'IRB.NS', focus: 'Highway BOT/HAM developer — toll-road exposure to BharatMala expansion and inter-state corridors' },
  { ticker: 'NTPC', sym: 'NTPC.NS', focus: "India's largest power producer — base-load power for upcoming industrial corridors" },
];

// ─── Data Fetch ─────────────────────────────────────────────────────────────

interface StockSnapshot {
  ticker: string;
  focus: string;
  name: string;
  price: number;
  changePercent: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  ytdReturn?: number;
}

async function fetchStock(ticker: string, sym: string, focus: string): Promise<StockSnapshot> {
  let price = 0,
    changePercent = 0,
    fiftyTwoWeekHigh = 0,
    fiftyTwoWeekLow = 0,
    name = ticker;
  try {
    // 5 day range gives a real previous-day close in chartPreviousClose.
    // Yahoo includes fiftyTwoWeekHigh / fiftyTwoWeekLow in meta regardless of range.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()) as any;
    const meta = r?.chart?.result?.[0]?.meta;
    if (meta) {
      price = +Number(meta.regularMarketPrice || 0).toFixed(2);
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      changePercent = prev > 0 ? +(((price - prev) / prev) * 100).toFixed(2) : 0;
      fiftyTwoWeekHigh = +Number(meta.fiftyTwoWeekHigh || 0).toFixed(2);
      fiftyTwoWeekLow = +Number(meta.fiftyTwoWeekLow || 0).toFixed(2);
      name = meta.longName || meta.shortName || ticker;
    }
  } catch (err) {
    console.log(`  ${ticker}: Yahoo fetch failed - ${(err as Error).message}`);
  }
  return { ticker, focus, name, price, changePercent, fiftyTwoWeekHigh, fiftyTwoWeekLow };
}

async function fetchIndexLevel(sym: string): Promise<{ value: number; changePercent: number }> {
  try {
    // sym passed as raw (e.g. "^CNXINFRA"); encodeURIComponent handles the caret.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = (await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json()) as any;
    const meta = r?.chart?.result?.[0]?.meta;
    if (!meta) return { value: 0, changePercent: 0 };
    const p = +Number(meta.regularMarketPrice || 0).toFixed(2);
    const prev = meta.chartPreviousClose || meta.previousClose || p;
    return { value: p, changePercent: prev > 0 ? +(((p - prev) / prev) * 100).toFixed(2) : 0 };
  } catch {
    return { value: 0, changePercent: 0 };
  }
}

// ─── Audio (Polly Kajal, chunked for >2900 chars) ───────────────────────────

async function genAudio(script: string) {
  const chunks: string[] = [];
  let rem = script;
  while (rem.length > 0) {
    if (rem.length <= 2900) {
      chunks.push(rem);
      break;
    }
    let at = rem.lastIndexOf('. ', 2900);
    if (at < 1200) at = 2900;
    else at += 1;
    chunks.push(rem.slice(0, at).trim());
    rem = rem.slice(at).trim();
  }

  const audioBufs: Buffer[] = [];
  let allMarks = '';
  let charOff = 0,
    timeOff = 0;

  for (const chunk of chunks) {
    const [audioRes, marksRes] = await Promise.all([
      polly.send(
        new SynthesizeSpeechCommand({
          Text: chunk,
          OutputFormat: 'mp3',
          VoiceId: 'Kajal',
          Engine: 'neural',
          LanguageCode: 'en-IN',
        })
      ),
      polly.send(
        new SynthesizeSpeechCommand({
          Text: chunk,
          OutputFormat: 'json',
          VoiceId: 'Kajal',
          Engine: 'neural',
          LanguageCode: 'en-IN',
          SpeechMarkTypes: ['word', 'sentence'],
        })
      ),
    ]);

    audioBufs.push(Buffer.from(await audioRes.AudioStream!.transformToByteArray()));
    const marksText = new TextDecoder().decode(await marksRes.AudioStream!.transformToByteArray());
    let maxT = 0;
    for (const line of marksText.trim().split('\n')) {
      const m = JSON.parse(line);
      m.time += timeOff;
      m.start += charOff;
      m.end += charOff;
      if (m.time > maxT) maxT = m.time;
      allMarks += JSON.stringify(m) + '\n';
    }
    charOff += chunk.length + 1;
    timeOff = maxT + 1500;
  }

  const audio = Buffer.concat(audioBufs);
  const marks = parseSpeechMarks(allMarks);
  return {
    audio,
    marksJsonl: allMarks,
    durationMs: marks[marks.length - 1] ? marks[marks.length - 1].time + 2000 : 600000,
  };
}

// ─── Scene HTML builders ────────────────────────────────────────────────────

function introHTML(): string {
  return `<!DOCTYPE html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
body { width: 1920px; height: 1080px; background: radial-gradient(ellipse at 50% 40%, #1e293b 0%, #0f172a 70%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 32px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 80px; text-align: center; }
.badge { background: linear-gradient(90deg, #10b981, #059669); padding: 14px 40px; border-radius: 10px; box-shadow: 0 0 50px rgba(16,185,129,0.3); }
.badge span { color: #fff; font-size: 28px; font-weight: 800; letter-spacing: 4px; }
.title { color: #f8fafc; font-size: 72px; font-weight: 900; line-height: 1.15; max-width: 1500px; letter-spacing: -1.5px; }
.subtitle { color: #94a3b8; font-size: 28px; max-width: 1300px; line-height: 1.5; margin-top: 8px; font-weight: 400; }
.divider { width: 600px; height: 2px; background: linear-gradient(90deg, transparent, #10b981, transparent); margin: 8px 0; }
.brand { display: flex; align-items: center; gap: 16px; position: absolute; bottom: 60px; }
.brand-icon { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 900; color: #fff; box-shadow: 0 0 30px rgba(16,185,129,0.4); }
.brand-text { color: #10b981; font-size: 32px; font-weight: 800; letter-spacing: 3px; }
</style></head><body>
<div class="badge"><span>SPECIAL DEEP DIVE</span></div>
<div class="title">${TOPIC}</div>
<div class="divider"></div>
<div class="subtitle">Where strategic geography meets long-term capital appreciation</div>
<div class="brand">
  <div class="brand-icon">Σ</div>
  <div class="brand-text">PRIME · AALSITRADER.COM</div>
</div>
</body></html>`;
}

function themeOverviewHTML(): string {
  return `<!DOCTYPE html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
body { width: 1920px; height: 1080px; background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 60px 80px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
.section-tag { color: #10b981; font-size: 22px; font-weight: 800; letter-spacing: 4px; }
.title { color: #f8fafc; font-size: 56px; font-weight: 900; margin-top: 6px; line-height: 1.1; }
.badge { background: rgba(16,185,129,0.15); border: 1px solid #10b981; color: #10b981; font-size: 18px; padding: 8px 18px; border-radius: 8px; font-weight: 700; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px; }
.card { background: rgba(30,41,59,0.7); border: 1px solid #334155; border-radius: 16px; padding: 28px 32px; }
.card-tag { color: #10b981; font-size: 16px; font-weight: 700; letter-spacing: 2px; margin-bottom: 8px; }
.card-title { color: #f8fafc; font-size: 28px; font-weight: 800; margin-bottom: 10px; }
.card-body { color: #94a3b8; font-size: 19px; line-height: 1.5; }
.lower { position: absolute; bottom: 30px; left: 80px; }
.lower-bar { background: linear-gradient(90deg, #10b981, #10b981cc, transparent); padding: 10px 24px; border-radius: 4px; display: inline-block; }
.lower-bar span { color: #fff; font-size: 20px; font-weight: 700; letter-spacing: 1px; }
</style></head><body>
<div class="header">
  <div>
    <div class="section-tag">THE BIG PICTURE</div>
    <div class="title">India's Trade Corridor Map Is Being Redrawn</div>
  </div>
  <div class="badge">LOGISTICS COST ~13% OF GDP</div>
</div>
<div class="grid">
  <div class="card">
    <div class="card-tag">DEDICATED FREIGHT CORRIDORS</div>
    <div class="card-title">Eastern + Western DFC</div>
    <div class="card-body">Western DFC: JNPT (Mumbai) ↔ Dadri (NCR). Eastern DFC: Ludhiana ↔ Dankuni (Kolkata). Longer freight trains, faster transit, dedicated tracks free up passenger network.</div>
  </div>
  <div class="card">
    <div class="card-tag">SAGARMALA · PORTS</div>
    <div class="card-title">Coastal Modernisation</div>
    <div class="card-body">Mundra, Vizhinjam, JNPT expansion, Krishnapatnam capacity adds. Higher container throughput → demand for last-mile rail and road evacuation.</div>
  </div>
  <div class="card">
    <div class="card-tag">BHARATMALA · HIGHWAYS</div>
    <div class="card-title">National Highway Expansion</div>
    <div class="card-body">~83,000 km of highway construction across phases. Economic corridors, inter-corridor links, border roads. Direct tailwind for HAM/BOT toll developers.</div>
  </div>
  <div class="card">
    <div class="card-tag">PM GATISHAKTI · MMLPs</div>
    <div class="card-title">Multi-Modal Logistics Parks</div>
    <div class="card-body">Integrated rail + road + port hubs at strategic nodes. Lower transit time, lower handling cost, higher utilisation across asset classes — a structural margin lever.</div>
  </div>
</div>
<div class="lower"><div class="lower-bar"><span>SPECIAL DEEP DIVE · PRIME AI · AALSITRADER.COM</span></div></div>
</body></html>`;
}

function stockTableHTML(stocks: StockSnapshot[], niftyInfra: { value: number; changePercent: number }): string {
  const fmt = (n: any) => (n ?? 0).toLocaleString('en-IN');
  const rows = stocks
    .map((s) => {
      const changeColor = s.changePercent >= 0 ? '#22c55e' : '#ef4444';
      const fromHigh = s.fiftyTwoWeekHigh > 0 ? (((s.price - s.fiftyTwoWeekHigh) / s.fiftyTwoWeekHigh) * 100).toFixed(1) : '0';
      const fromHighColor = parseFloat(fromHigh) > -10 ? '#22c55e' : parseFloat(fromHigh) > -25 ? '#facc15' : '#ef4444';
      return `<tr>
        <td><div style="color:#f8fafc;font-weight:800;font-size:22px">${s.ticker}</div><div style="color:#64748b;font-size:14px;margin-top:2px">${s.name.slice(0, 40)}</div></td>
        <td style="color:#f8fafc;font-weight:700;font-size:22px">₹${fmt(s.price)}</td>
        <td style="color:${changeColor};font-weight:800;font-size:22px">${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%</td>
        <td style="color:#94a3b8;font-size:18px">₹${fmt(s.fiftyTwoWeekHigh)}</td>
        <td style="color:${fromHighColor};font-weight:700;font-size:18px">${fromHigh}%</td>
      </tr>`;
    })
    .join('');
  const niftyColor = niftyInfra.changePercent >= 0 ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
body { width: 1920px; height: 1080px; background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 60px 80px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; }
.section-tag { color: #10b981; font-size: 22px; font-weight: 800; letter-spacing: 4px; }
.title { color: #f8fafc; font-size: 56px; font-weight: 900; margin-top: 6px; }
.index-pill { background: rgba(16,185,129,0.12); border: 1px solid #334155; padding: 16px 28px; border-radius: 14px; }
.index-label { color: #64748b; font-size: 14px; letter-spacing: 2px; font-weight: 700; }
.index-value { color: #f8fafc; font-size: 28px; font-weight: 800; margin-top: 4px; }
.index-change { color: ${niftyColor}; font-size: 20px; font-weight: 800; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; }
th { color: #64748b; font-size: 14px; font-weight: 700; letter-spacing: 2px; text-align: left; padding: 14px 18px; border-bottom: 2px solid #1e293b; }
td { padding: 18px; border-bottom: 1px solid #1e293b; vertical-align: top; }
.lower { position: absolute; bottom: 30px; left: 80px; }
.lower-bar { background: linear-gradient(90deg, #10b981, #10b981cc, transparent); padding: 10px 24px; border-radius: 4px; display: inline-block; }
.lower-bar span { color: #fff; font-size: 20px; font-weight: 700; letter-spacing: 1px; }
</style></head><body>
<div class="header">
  <div>
    <div class="section-tag">THE BASKET</div>
    <div class="title">Infrastructure Stocks On The Corridor Trail</div>
  </div>
  <div class="index-pill">
    <div class="index-label">NIFTY INFRA</div>
    <div class="index-value">${fmt(niftyInfra.value)}</div>
    <div class="index-change">${niftyInfra.changePercent >= 0 ? '+' : ''}${niftyInfra.changePercent}% TODAY</div>
  </div>
</div>
<table>
  <thead><tr><th>STOCK</th><th>CMP</th><th>1-DAY</th><th>52W HIGH</th><th>FROM HIGH</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="lower"><div class="lower-bar"><span>VERIFIED PRICES · PRIME AI · AALSITRADER.COM</span></div></div>
</body></html>`;
}

function outroHTML(): string {
  return `<!DOCTYPE html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
body { width: 1920px; height: 1080px; background: radial-gradient(ellipse at 50% 60%, #1e293b 0%, #0f172a 70%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 80px; text-align: center; }
.tagline { font-size: 50px; color: #10b981; font-weight: 700; font-style: italic; line-height: 1.3; max-width: 1200px; }
.divider { width: 600px; height: 2px; background: linear-gradient(90deg, transparent, #10b981, transparent); }
.brand { display: flex; align-items: center; gap: 24px; }
.brand-icon { width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; font-size: 42px; font-weight: 900; color: #fff; box-shadow: 0 0 50px rgba(16,185,129,0.4); }
.brand-text { color: #f8fafc; font-size: 56px; font-weight: 900; letter-spacing: 5px; }
.brand-text .dot { color: #10b981; }
.tag { color: #94a3b8; font-size: 24px; letter-spacing: 2px; margin-top: 6px; }
.cta { background: linear-gradient(90deg, #10b981, #059669); padding: 16px 48px; border-radius: 14px; box-shadow: 0 0 40px rgba(16,185,129,0.3); }
.cta span { color: #fff; font-size: 26px; font-weight: 800; letter-spacing: 2px; }
.engage { background: rgba(220,38,38,0.95); padding: 16px 40px; border-radius: 999px; display: flex; align-items: center; gap: 24px; box-shadow: 0 8px 32px rgba(220,38,38,0.4); border: 2px solid rgba(255,255,255,0.2); }
.engage-item { display: flex; align-items: center; gap: 10px; }
.engage-emoji { font-size: 32px; }
.engage-text { color: #fff; font-size: 26px; font-weight: 800; letter-spacing: 1px; }
.engage-divider { width: 1px; height: 30px; background: rgba(255,255,255,0.4); }
</style></head><body>
<div class="tagline">"Data bolta hai, hum sunte hain.<br>Aalsi rahein, smart rahein!"</div>
<div class="divider"></div>
<div>
  <div class="brand"><div class="brand-icon">Σ</div><div><div class="brand-text">AALSITRADER<span class="dot">.</span>COM</div><div class="tag">AI-POWERED ALGO TRADING FOR INDIAN MARKETS</div></div></div>
</div>
<!-- LIKE & SUBSCRIBE engagement CTA — static end-card prompt for the outro. -->
<div class="engage">
  <div class="engage-item"><span class="engage-emoji">👍</span><span class="engage-text">LIKE</span></div>
  <div class="engage-divider"></div>
  <div class="engage-item"><span class="engage-emoji">🔔</span><span class="engage-text">SUBSCRIBE</span></div>
  <div class="engage-divider"></div>
  <div class="engage-item"><span class="engage-emoji">💬</span><span class="engage-text">COMMENT</span></div>
</div>
<div class="cta"><span>WATCH NEXT DEEP DIVE → aalsitrader.com</span></div>
</body></html>`;
}

function thumbnailHTML(): string {
  return `<!DOCTYPE html>
<html><head><style>
* { margin: 0; box-sizing: border-box; }
body { width: 1280px; height: 720px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 60px 70px; position: relative; overflow: hidden; }
.bg-glow { position: absolute; top: -100px; right: -100px; width: 600px; height: 600px; background: radial-gradient(circle, rgba(16,185,129,0.2), transparent); border-radius: 50%; }
.special-badge { background: linear-gradient(90deg, #ef4444, #dc2626); padding: 14px 36px; border-radius: 50px; display: inline-block; box-shadow: 0 0 40px rgba(239,68,68,0.4); }
.special-badge span { color: #fff; font-size: 22px; font-weight: 900; letter-spacing: 3px; }
.title { color: #f8fafc; font-size: 60px; font-weight: 900; line-height: 1.1; margin-top: 22px; max-width: 1100px; letter-spacing: -1.5px; }
.title .accent { color: #10b981; }
.subtitle { color: #94a3b8; font-size: 24px; max-width: 1000px; margin-top: 18px; line-height: 1.4; font-weight: 500; }
.bottom { position: absolute; bottom: 50px; left: 70px; right: 70px; display: flex; justify-content: space-between; align-items: center; }
.brand { display: flex; align-items: center; gap: 14px; }
.brand-icon { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 900; color: #fff; }
.brand-text { color: #10b981; font-size: 28px; font-weight: 900; letter-spacing: 2px; }
.tags { display: flex; gap: 14px; }
.tag { background: rgba(16,185,129,0.15); border: 1px solid #10b981; color: #10b981; padding: 8px 18px; border-radius: 8px; font-size: 18px; font-weight: 700; }
</style></head><body>
<div class="bg-glow"></div>
<div class="special-badge"><span>SPECIAL · DEEP DIVE</span></div>
<div class="title">India's <span class="accent">Trade Corridor Boom</span>: Which Infra Stocks Will Lead?</div>
<div class="subtitle">Decoding DFC, BharatMala, Sagarmala, and the stocks at the intersection of strategic geography</div>
<div class="bottom">
  <div class="brand"><div class="brand-icon">Σ</div><div class="brand-text">PRIME · AALSITRADER</div></div>
  <div class="tags"><div class="tag">ADANIPORTS</div><div class="tag">L&T</div><div class="tag">CONCOR</div></div>
</div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   PRIME SPEAKS — SPECIAL THEMATIC DEEP DIVE          ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\nTopic: ${TOPIC}\n`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(FRAMES_DIR)) mkdirSync(FRAMES_DIR, { recursive: true });

  // 1. Fetch macro indices + stock snapshots
  console.log('[1/6] Fetching market data...');
  const [niftyInfra, stockResults] = await Promise.all([
    fetchIndexLevel('^CNXINFRA'), // Nifty Infrastructure (raw — encodeURIComponent will escape ^)
    Promise.all(STOCKS.map((s) => fetchStock(s.ticker, s.sym, s.focus))),
  ]);
  stockResults.forEach((s) => {
    console.log(`  ${s.ticker.padEnd(11)} ₹${String(s.price).padStart(9)} (${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%)  52w-high ₹${s.fiftyTwoWeekHigh}`);
  });
  console.log(`  NIFTY INFRA ${niftyInfra.value} (${niftyInfra.changePercent >= 0 ? '+' : ''}${niftyInfra.changePercent}%)`);
  writeFileSync(resolve(OUT_DIR, 'stock-data.json'), JSON.stringify({ niftyInfra, stocks: stockResults }, null, 2));

  // 2. Build the thematic prompt
  console.log('\n[2/6] Generating script (Gemini → Claude → Nova Pro)...');
  const stockBlock = stockResults
    .map(
      (s) =>
        `• ${s.ticker} (${s.name}) — CMP ₹${s.price.toLocaleString('en-IN')}, today ${s.changePercent >= 0 ? '+' : ''}${s.changePercent}%, 52w high ₹${s.fiftyTwoWeekHigh.toLocaleString('en-IN')}, 52w low ₹${s.fiftyTwoWeekLow.toLocaleString('en-IN')}.\n  Strategic role: ${s.focus}`
    )
    .join('\n');

  const prompt = `You are Prime (Σ), AalsiTrader's AI thematic analyst. Write a Hindi-English narration script for a SPECIAL deep-dive video on India's infrastructure sector.

TOPIC: ${TOPIC}

EDITORIAL BRIEF (lead the analysis with this framing):
${BRIEF}

VERIFIED MARKET DATA (today's closing prints — these are ground truth, never invent other numbers):

NIFTY INFRASTRUCTURE INDEX: ${niftyInfra.value} (${niftyInfra.changePercent >= 0 ? '+' : ''}${niftyInfra.changePercent}% today)

STOCK BASKET (verified):
${stockBlock}

CONTEXT YOU CAN DRAW ON (general industry knowledge — but do NOT cite specific tonnage, throughput, or km numbers unless they are widely-known industry facts):
- Dedicated Freight Corridors: Western DFC connects JNPT (Mumbai) to Dadri/NCR; Eastern DFC connects Ludhiana to Dankuni (Kolkata). Both are operational in major stretches and free up the passenger rail network.
- Sagarmala: port modernisation programme covering Mundra, Vizhinjam, JNPT expansion, coastal-shipping promotion.
- BharatMala: ~83,000 km of highway construction across phases including economic corridors and inter-corridor links.
- PM GatiShakti: integrated multi-modal logistics parks (MMLPs) at strategic rail-road-port nodes.
- India's logistics cost is roughly 13–14% of GDP today, with a stated goal of bringing it down to global benchmark of 8–9%.

YOUR TASK:
Write a 1400–1700 word Hindi-English narration script for a 6–7 minute video. The analysis must explain HOW these corridor programmes change the unit economics for the listed companies, identify which stocks have the cleanest pure-play exposure, and which deserve a strategic re-look at current valuations.

STRUCTURE (flowing narration only, no markdown, no headings, no bullet points in output):

1. Opener (50–80 words): "Namaste investors! This is Prime from AalsiTrader. Aaj hum ek special deep dive kar rahe hain — India's trade corridor opportunity, aur infrastructure sector ke kaunse stocks isse benefit honge." Set the macro hook: India's logistics cost is one of the highest in the world, the corridor programmes are aiming to bring it down structurally, and that creates real margin levers for the right companies.

2. The Big Picture (200–280 words): Explain DFC eastern + western, Sagarmala port modernisation, BharatMala highway expansion, and PM GatiShakti's multi-modal logistics parks. Connect these dots — the goal is to lower the cost of moving goods from origin to destination across rail, road, port and air. Be specific about the OUTCOME (faster freight trains, shorter port-to-hinterland transit, lower handling cost) rather than the inputs (km of road, crore of rupees).

3. Stock-by-stock walk (one short paragraph per company, ~120 words each — 7 paragraphs total). For each company:
   - Use the EXACT CMP from the verified data above when you cite a price.
   - Connect the company to the corridor story specifically (not generically).
   - Mention whether it is near its 52-week high or has corrected — use the verified 52-week high above.
   - End each paragraph with what the investor should watch.
   Do these in this order: ADANIPORTS → CONCOR → LT → POWERGRID → IRB → GMRAIRPORT → NTPC.

4. The Intersection (140–200 words): Where strategic geography meets capital appreciation. Identify which 2–3 stocks have the cleanest, most direct corridor exposure right now. Discuss the trade-off between pure-play exposure (CONCOR, ADANIPORTS) and diversified blue-chip plays (LT, POWERGRID).

5. Risks (80–120 words): Cyclical demand, execution delays, balance-sheet leverage on asset-heavy infra, regulatory and tariff risk, dependence on government capex cycles.

6. Closer (40–60 words): "Yeh tha aapka special deep dive on India's trade corridor opportunity. Yeh ek thematic story hai — short-term mein volatility rahegi, lekin lambi avadhi mein, ye stocks structural beneficiaries ban sakte hain. Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!"

HARD CONSTRAINTS — violating any of these is a failure:
1. Use only the prices, percent changes, and 52-week highs/lows from the verified data above. Never invent prices or percent moves.
2. For port throughput, freight tonnage, road km, etc., stay GENERAL — don't fabricate specific tonnage or km figures.
3. Hindi-English mix, conversational, like a smart trader friend explaining a thesis. Short sentences (under 22 words). Flowing narration only — no markdown, no headings, no bullets.
4. Do not insert templated curiosity hooks ("Why did margins fall...", "Is It Real?"). Lead with the corridor thesis, not a clickbait question.
5. 1400–1700 words total.

Output ONLY the narration script.`;

  // Approved-numbers whitelist for the thematic deep-dive: NIFTY INFRA value,
  // each stock's CMP / change% / 52w high / 52w low. Tolerant of paraphrase
  // rounding and standard contextual numbers like 13-14% logistics-cost-of-GDP
  // (which appears in the prompt as "13–14%").
  const approvedNums: number[] = [
    niftyInfra.value, niftyInfra.changePercent,
    13, 14, 8, 9, // logistics-cost-of-GDP figures explicitly cited in prompt
    83000,         // BharatMala km cited explicitly
  ];
  for (const s of stockResults) {
    approvedNums.push(s.price, s.changePercent, s.fiftyTwoWeekHigh, s.fiftyTwoWeekLow);
  }
  const symbols: SymbolDirection[] = stockResults.map((s) => ({
    aliases: [s.ticker, s.name].filter(Boolean) as string[],
    direction: s.changePercent > 0.5 ? 'UP' : s.changePercent < -0.5 ? 'DOWN' : 'FLAT',
  }));

  let raw = await callLLM(prompt, { maxTokens: 5000, temperature: 0.5 });
  let script = stripMarkdown(raw);
  let v = validateGeneric(script, approvedNums, symbols);
  if (!v.valid) {
    console.warn(`[thematic-validator] Hallucination on first generation:`);
    for (const i of v.issues) console.warn(`  - ${i}`);
    const retryPrompt = prompt +
      `\n\nIMPORTANT: A previous attempt was REJECTED for these issues:\n` +
      v.issues.map(i => `  - ${i}`).join('\n') +
      `\n\nFix them. Cite ONLY numbers from the VERIFIED MARKET DATA above (and the general industry context numbers like 13-14% logistics-of-GDP that appear verbatim in the prompt).`;
    raw = await callLLM(retryPrompt, { maxTokens: 5000, temperature: 0.1 });
    script = stripMarkdown(raw);
    v = validateGeneric(script, approvedNums, symbols);
    if (!v.valid) {
      throw new Error(`[thematic-validator] Script REJECTED twice — refusing to render. Issues: ${v.issues.join('; ')}`);
    }
    console.log(`[thematic-validator] Retry produced a clean script.`);
  }
  writeFileSync(resolve(OUT_DIR, 'script.txt'), script);
  console.log(`  ${script.split(/\s+/).length} words`);

  // 3. Audio
  console.log('\n[3/6] Audio + speech marks (Polly Kajal)...');
  const { audio, marksJsonl, durationMs } = await genAudio(script);
  const audioPath = resolve(OUT_DIR, 'audio.mp3');
  writeFileSync(audioPath, audio);
  writeFileSync(resolve(OUT_DIR, 'speech-marks.jsonl'), marksJsonl);
  console.log(`  ${Math.round(audio.length / 1024)} KB | ~${(durationMs / 1000).toFixed(1)}s`);

  // 4. Capture scenes
  console.log('\n[4/6] Capturing scenes (Puppeteer)...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });

  async function snap(html: string, name: string, w = 1920, h = 1080) {
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h });
    await p.setContent(html, { waitUntil: 'networkidle0' });
    const out = resolve(FRAMES_DIR, `${name}.png`);
    await p.screenshot({ path: out });
    await p.close();
    return out;
  }

  const introPng = await snap(introHTML(), 'intro');
  const themePng = await snap(themeOverviewHTML(), 'theme-overview');
  const tablePng = await snap(stockTableHTML(stockResults, niftyInfra), 'stock-table');
  const outroPng = await snap(outroHTML(), 'outro');
  const thumbPath = resolve(OUT_DIR, 'thumbnail.png');
  const thumbPage = await browser.newPage();
  await thumbPage.setViewport({ width: 1280, height: 720 });
  await thumbPage.setContent(thumbnailHTML(), { waitUntil: 'networkidle0' });
  await thumbPage.screenshot({ path: thumbPath });
  await thumbPage.close();
  await browser.close();
  console.log('  4 scenes + 1 thumbnail captured');

  // 5. Build scene timeline + compose
  console.log('\n[5/6] Composing video (FFmpeg)...');
  const scenes = [
    { id: 'intro', imagePath: introPng, durationMs: Math.round(durationMs * 0.08) },
    { id: 'theme', imagePath: themePng, durationMs: Math.round(durationMs * 0.32) },
    { id: 'table', imagePath: tablePng, durationMs: Math.round(durationMs * 0.5) },
    { id: 'outro', imagePath: outroPng, durationMs: Math.round(durationMs * 0.1) },
  ];
  scenes.forEach((s) => console.log(`  ${s.id}: ${(s.durationMs / 1000).toFixed(1)}s`));

  const videoPath = resolve(OUT_DIR, 'episode.mp4');
  composeVideo({
    captures: scenes.map((s) => ({ sceneName: s.id, imagePath: s.imagePath, durationMs: s.durationMs })),
    audioPath,
    outputPath: videoPath,
  });

  // 6. Upload
  console.log('\n[6/6] Uploading to YouTube...');
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const title = `India's Trade Corridor Boom 🚂 Which Infra Stocks Will Lead? | Special Deep Dive | ${today}`;
  const description = `SPECIAL DEEP DIVE — ${TOPIC}

${BRIEF}

In this video Prime (Σ) walks through how the Dedicated Freight Corridors, Sagarmala, BharatMala and PM GatiShakti are reshaping India's logistics economics, and which Nifty infrastructure stocks have the cleanest exposure to that re-rating story.

Stocks covered (verified prices from today's close):
${stockResults.map((s) => `• ${s.ticker} — ₹${s.price.toLocaleString('en-IN')} (${s.changePercent >= 0 ? '+' : ''}${s.changePercent}% today)`).join('\n')}

Nifty Infrastructure Index: ${niftyInfra.value} (${niftyInfra.changePercent >= 0 ? '+' : ''}${niftyInfra.changePercent}%)

🤖 100% AI-generated thematic analysis by Prime (Σ) at AalsiTrader
🔗 Algo trading platform: https://aalsitrader.com

⚠️ This is AI-generated educational content based on publicly available market data. NOT financial advice. Do your own research before investing.

#NiftyInfra #AdaniPorts #LarsenToubro #CONCOR #BharatMala #DFC #Sagarmala #IndianStockMarket #ThematicInvesting #PrimeAI #AalsiTrader`;

  const tags = [
    'nifty infrastructure',
    'trade corridors',
    'dedicated freight corridor',
    'dfc',
    'bharatmala',
    'sagarmala',
    'pm gatishakti',
    'adani ports',
    'larsen toubro',
    'concor',
    'thematic investing',
    'indian stock market',
    'aalsitrader',
    'prime ai',
    'special deep dive',
  ];

  try {
    const result = await uploadToYouTube({
      videoPath,
      title: title.slice(0, 100),
      description,
      tags,
      privacyStatus: 'public',
    });
    console.log(`  Uploaded: ${result.url}`);

    // Custom thumbnail
    try {
      const clientSecretPath = process.env.YOUTUBE_CLIENT_SECRET || '/Users/tapas/Desktop/client_secret.json';
      const tokenPath = process.env.YOUTUBE_TOKEN_PATH
        ? resolve(process.env.YOUTUBE_TOKEN_PATH)
        : resolve(__dirname, '..', '.youtube-token.json');
      const creds = JSON.parse(readFileSync(clientSecretPath, 'utf-8')).installed;
      const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:8085');
      oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf-8')));
      const yt = google.youtube({ version: 'v3', auth: oauth2 });
      await yt.thumbnails.set({ videoId: result.videoId, media: { mimeType: 'image/png', body: createReadStream(thumbPath) } });
      console.log('  Thumbnail set.');
    } catch (err: any) {
      console.log(`  Thumbnail upload skipped: ${err.message}`);
    }

    // Save metadata + sync feed
    const meta = {
      videoId: result.videoId,
      url: result.url,
      title,
      type: 'thematic-deep-dive',
      topic: TOPIC,
      uploadedAt: new Date().toISOString(),
      thumbnailUrl: `https://img.youtube.com/vi/${result.videoId}/maxresdefault.jpg`,
    };
    writeFileSync(resolve(OUT_DIR, 'latest-video.json'), JSON.stringify(meta, null, 2));
    await syncFeedToS3(meta);

    // Podcast
    await publishPodcastEpisode({
      audioPath,
      title: title.slice(0, 100),
      description: `${TOPIC}. ${BRIEF}`.slice(0, 500),
      type: 'daily',
      youtubeUrl: result.url,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   DONE — SPECIAL DEEP DIVE LIVE                      ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  YouTube: ${result.url}     ║`);
    console.log(`║  Time:    ${elapsed}s                                   ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
  } catch (err: any) {
    console.error(`  Upload failed: ${err.message}`);
    console.log('  Video saved locally — upload manually or re-run.');
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('Pipeline failed:', err.message);
  process.exit(1);
});

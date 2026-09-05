/**
 * Thumbnail Generator — YouTube-optimized clickable thumbnails (1280x720)
 *
 * Each call emits THREE A/B variants for YouTube's Test & Compare:
 *   <out>.png        Variant A — Topic-led:   ticker huge left, Prime right
 *   <out>_B.png      Variant B — Face-led:    Prime huge left, ticker+% right
 *   <out>_C.png      Variant C — Chart-led:   chart background, ticker centered, Prime small bottom-right
 *
 * Host assets live in: factory/assets/prime/{bullish,bearish,shock,neutral}.png
 * Optional chart asset can be passed for variant C; falls back to gradient if absent.
 */

import puppeteer, { type Browser } from 'puppeteer';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export type Tone = 'bullish' | 'bearish' | 'shock' | 'neutral';

const ASSETS_DIR = resolve(__dirname, 'assets', 'prime');

function loadHostDataUrl(tone: Tone): string {
  // HARD FAIL on missing host PNG. Earlier we returned null and silently
  // dropped the face, which is how the May 7 SHREECEM thumbnail shipped
  // with an empty red panel and no fallback emoji either. Production
  // thumbnails MUST have a host face — if the asset is missing, the
  // pipeline should fail loudly rather than upload a half-rendered image.
  const path = resolve(ASSETS_DIR, `${tone}.png`);
  if (!existsSync(path)) {
    throw new Error(`[thumbnail] host PNG missing: ${path}. Cannot render thumbnail without face.`);
  }
  const buf = readFileSync(path);
  if (buf.length < 10000) {
    // Defensive: a truncated/empty PNG paints invisibly in CSS background-image
    // without throwing. Reject anything implausibly small.
    throw new Error(`[thumbnail] host PNG too small (${buf.length} bytes): ${path}`);
  }
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function loadDataUrl(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  const ext = path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(path).toString('base64')}`;
}

function tonePalette(tone: Tone) {
  switch (tone) {
    case 'bullish': return { main: '#22c55e', glow: '#064e3b' };
    case 'bearish': return { main: '#ef4444', glow: '#7f1d1d' };
    case 'shock':   return { main: '#f59e0b', glow: '#78350f' };
    default:        return { main: '#38bdf8', glow: '#0c4a6e' };
  }
}

interface RenderOpts {
  tag: string;
  bigText: string;
  pctChip: string;
  subline: string;
  tone: Tone;
  date?: string;
  chartImagePath?: string;
}

const COMMON_CSS = `
  * { margin: 0; box-sizing: border-box; }
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@800;900&family=Anton&display=swap');
  body { width: 1280px; height: 720px; background: #0f172a; font-family: 'Inter', -apple-system, sans-serif; overflow: hidden; position: relative; }
  .brand { position: absolute; bottom: 22px; left: 30px; display: flex; align-items: center; gap: 10px; z-index: 5; background: rgba(0,0,0,0.55); padding: 6px 14px; border-radius: 999px; }
  .brand-dot { width: 30px; height: 30px; border-radius: 50%; background: #10b981; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 16px; font-weight: 900; }
  .brand-tx  { color: #10b981; font-size: 22px; font-weight: 900; letter-spacing: 2px; }
  .date  { position: absolute; top: 22px; right: 30px; color: #94a3b8; font-size: 22px; font-weight: 800; letter-spacing: 1px; z-index: 3; }
  .tag   { background: rgba(15,23,42,0.85); padding: 6px 18px; border-radius: 6px; align-self: flex-start; display: inline-block; }
`;

// ---- Variant A: Topic-led ----------------------------------------------------
function renderVariantA(opts: RenderOpts): string {
  const { main, glow } = tonePalette(opts.tone);
  const host = loadHostDataUrl(opts.tone);
  const big = opts.bigText.toUpperCase();
  // Left pane ~640px wide. Anton glyph ≈ 0.6em → 5 chars at 200px ≈ 600px.
  const bigSize = Math.max(100, 200 - Math.max(0, big.length - 5) * 22);

  return `<!DOCTYPE html><html><head><style>${COMMON_CSS}
    .bg-split { position: absolute; top: 0; right: 0; width: 55%; height: 100%; background: ${glow}; clip-path: polygon(18% 0, 100% 0, 100% 100%, 0% 100%); }
    .bg-glow  { position: absolute; top: 50%; left: 58%; transform: translate(-50%, -50%); width: 820px; height: 820px; border-radius: 50%; background: radial-gradient(circle, ${main}22 0%, transparent 60%); }
    .content { position: relative; z-index: 2; width: 100%; height: 100%; display: flex; }
    .left  { width: 58%; display: flex; flex-direction: column; justify-content: center; padding: 56px 40px 56px 56px; gap: 14px; overflow: hidden; }
    .right { width: 42%; position: relative; overflow: hidden; }
    .host-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center bottom; filter: drop-shadow(-12px 0 30px rgba(0,0,0,0.55)); }
    .tag span { color: ${main}; font-size: 18px; font-weight: 900; letter-spacing: 3px; }
    .tag { border: 2px solid ${main}66; }
    .big  { color: #fff; font-family: 'Anton', sans-serif; font-size: ${bigSize}px; line-height: 0.92; letter-spacing: 1px; -webkit-text-stroke: 2px #000; text-shadow: 0 6px 28px rgba(0,0,0,0.55); white-space: nowrap; }
    .chip { background: ${main}; padding: 10px 26px; border-radius: 10px; align-self: flex-start; box-shadow: 0 0 36px ${main}88; margin-top: 6px; }
    .chip span { color: #0b1220; font-size: 84px; font-weight: 900; letter-spacing: -2px; }
    .sub  { color: #cbd5e1; font-size: 30px; font-weight: 800; letter-spacing: 1px; margin-top: 10px; }
    .host-emoji { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 220px; filter: drop-shadow(0 0 40px ${main}66); }
  </style></head><body>
    <div class="bg-split"></div><div class="bg-glow"></div>
    ${opts.date ? `<div class="date">${opts.date}</div>` : ''}
    <div class="content">
      <div class="left">
        <div class="tag"><span>${opts.tag}</span></div>
        <div class="big">${big}</div>
        <div class="chip"><span>${opts.pctChip}</span></div>
        <div class="sub">${opts.subline}</div>
      </div>
      <div class="right"><img class="host-bg" src="${host}" alt="" /></div>
    </div>
    <div class="brand"><div class="brand-dot">Σ</div><div class="brand-tx">AALSITRADER</div></div>
  </body></html>`;
}

// ---- Variant B: Face-led -----------------------------------------------------
function renderVariantB(opts: RenderOpts): string {
  const { main, glow } = tonePalette(opts.tone);
  const host = loadHostDataUrl(opts.tone);
  const big = opts.bigText.toUpperCase();
  // Right pane ~490px after padding. Anton glyph ~0.6em → 5 chars at 160px ≈ 480px.
  // Floor 80px keeps 10-char tickers single-line (~480px wide).
  const bigSize = Math.max(80, 160 - Math.max(0, big.length - 5) * 16);

  return `<!DOCTYPE html><html><head><style>${COMMON_CSS}
    body { background: ${glow}; }
    .bg-glow { position: absolute; top: 50%; right: -10%; transform: translateY(-50%); width: 900px; height: 900px; border-radius: 50%; background: radial-gradient(circle, ${main}33 0%, transparent 60%); z-index: 1; }
    .content { position: relative; z-index: 2; width: 100%; height: 100%; display: flex; }
    .left  { width: 55%; position: relative; overflow: hidden; }
    .host-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center bottom; filter: drop-shadow(12px 0 30px rgba(0,0,0,0.55)); }
    .right { width: 45%; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 56px 56px 56px 30px; gap: 16px; }
    .tag span { color: ${main}; font-size: 18px; font-weight: 900; letter-spacing: 3px; }
    .tag { border: 2px solid ${main}66; }
    .big  { color: #fff; font-family: 'Anton', sans-serif; font-size: ${bigSize}px; line-height: 0.92; letter-spacing: 1px; -webkit-text-stroke: 2px #000; text-shadow: 0 6px 28px rgba(0,0,0,0.55); white-space: nowrap; }
    .chip-huge { background: ${main}; padding: 16px 28px; border-radius: 14px; box-shadow: 0 0 50px ${main}aa; align-self: flex-start; }
    .chip-huge span { color: #0b1220; font-size: 130px; font-weight: 900; letter-spacing: -4px; line-height: 0.9; }
    .sub { color: #f8fafc; font-size: 30px; font-weight: 800; letter-spacing: 1px; }
    .host-emoji { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 260px; filter: drop-shadow(0 0 40px ${main}66); }
  </style></head><body>
    <div class="bg-glow"></div>
    ${opts.date ? `<div class="date">${opts.date}</div>` : ''}
    <div class="content">
      <div class="left"><img class="host-bg" src="${host}" alt="" /></div>
      <div class="right">
        <div class="tag"><span>${opts.tag}</span></div>
        <div class="big">${big}</div>
        <div class="chip-huge"><span>${opts.pctChip}</span></div>
        <div class="sub">${opts.subline}</div>
      </div>
    </div>
    <div class="brand"><div class="brand-dot">Σ</div><div class="brand-tx">AALSITRADER</div></div>
  </body></html>`;
}

// ---- Variant C: Chart-led ----------------------------------------------------
function renderVariantC(opts: RenderOpts): string {
  const { main, glow } = tonePalette(opts.tone);
  const host = loadHostDataUrl(opts.tone);
  const chart = loadDataUrl(opts.chartImagePath);
  const big = opts.bigText.toUpperCase();
  // Text shares canvas with bottom-right Prime cutout (~30% width).
  // Available text width ≈ 1280 - padding(64+64) - prime(384) ≈ 768.
  const bigSize = Math.max(130, 240 - Math.max(0, big.length - 5) * 27);

  const bgLayer = chart
    ? `background: linear-gradient(180deg, rgba(15,23,42,0.85) 0%, rgba(15,23,42,0.6) 60%, rgba(15,23,42,0.92) 100%), url('${chart}'); background-size: cover; background-position: center;`
    : `background: radial-gradient(circle at 30% 50%, ${main}22 0%, transparent 60%), linear-gradient(135deg, ${glow} 0%, #0f172a 100%);`;

  return `<!DOCTYPE html><html><head><style>${COMMON_CSS}
    body { ${bgLayer} }
    .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.55) 100%); z-index: 1; }
    .content { position: relative; z-index: 2; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 48px 64px; gap: 14px; }
    .tag span { color: ${main}; font-size: 18px; font-weight: 900; letter-spacing: 3px; }
    .tag { border: 2px solid ${main}88; background: rgba(0,0,0,0.6); }
    .big { color: #fff; font-family: 'Anton', sans-serif; font-size: ${bigSize}px; line-height: 0.9; letter-spacing: 2px; -webkit-text-stroke: 3px #000; text-shadow: 0 8px 32px rgba(0,0,0,0.85), 0 0 60px ${main}44; white-space: nowrap; max-width: 60%; }
    .chip-row { display: flex; align-items: center; gap: 18px; margin-top: 6px; }
    .chip { background: ${main}; padding: 12px 28px; border-radius: 12px; box-shadow: 0 0 50px ${main}aa, 0 8px 24px rgba(0,0,0,0.5); }
    .chip span { color: #0b1220; font-size: 100px; font-weight: 900; letter-spacing: -3px; line-height: 0.9; }
    .sub { color: #f1f5f9; font-size: 32px; font-weight: 900; letter-spacing: 1px; text-shadow: 0 4px 12px rgba(0,0,0,0.8); }
    .host-cutout { position: absolute; right: 0; bottom: 0; width: 32%; height: 90%; object-fit: cover; object-position: center bottom; filter: drop-shadow(-12px 0 30px rgba(0,0,0,0.6)); z-index: 2; }
    .host-emoji { position: absolute; right: 60px; bottom: 60px; font-size: 180px; filter: drop-shadow(0 0 40px ${main}66); z-index: 2; }
  </style></head><body>
    <div class="vignette"></div>
    ${opts.date ? `<div class="date">${opts.date}</div>` : ''}
    <img class="host-cutout" src="${host}" alt="" />
    <div class="content">
      <div class="tag"><span>${opts.tag}</span></div>
      <div class="big">${big}</div>
      <div class="chip-row">
        <div class="chip"><span>${opts.pctChip}</span></div>
      </div>
      <div class="sub">${opts.subline}</div>
    </div>
    <div class="brand"><div class="brand-dot">Σ</div><div class="brand-tx">AALSITRADER</div></div>
  </body></html>`;
}

// ---- Render driver -----------------------------------------------------------
async function renderToFile(html: string, outputPath: string, browser: Browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // ─── Defensive: wait for ALL <img> elements to fully decode before snapping ─
  // The May 7 SHREECEM thumbnail shipped with an empty face panel because
  // Puppeteer fired networkidle0 before the data-URI background-image had
  // painted. Switching to <img> + img.decode() makes the wait deterministic.
  await page.evaluate(async () => {
    const imgs = Array.from(document.images) as HTMLImageElement[];
    await Promise.all(
      imgs.map((img) =>
        img.complete && img.naturalWidth > 0
          ? img.decode().catch(() => undefined)
          : new Promise<void>((res, rej) => {
              img.addEventListener('load', () => res(), { once: true });
              img.addEventListener('error', () => rej(new Error(`<img> failed: ${img.src.slice(0, 80)}`)), { once: true });
            }).then(() => img.decode().catch(() => undefined))
      )
    );
    // Verify every <img> actually rasterised — naturalWidth=0 means decode failed silently.
    const broken = imgs.filter((i) => !i.naturalWidth || !i.naturalHeight);
    if (broken.length) {
      throw new Error(`[thumbnail] ${broken.length} <img> failed to rasterise (first src=${broken[0].src.slice(0, 80)})`);
    }
  });

  await page.screenshot({ path: outputPath, type: 'png' });
  await page.close();
}

async function renderAllVariants(opts: RenderOpts, primaryPath: string) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 720 } });
  try {
    const pathB = primaryPath.replace(/\.png$/i, '_B.png');
    const pathC = primaryPath.replace(/\.png$/i, '_C.png');
    await renderToFile(renderVariantA(opts), primaryPath, browser);
    await renderToFile(renderVariantB(opts), pathB, browser);
    await renderToFile(renderVariantC(opts), pathC, browser);
    return { A: primaryPath, B: pathB, C: pathC };
  } finally {
    await browser.close();
  }
}

// ---- Public API --------------------------------------------------------------

export interface DailyThumbnailData {
  niftyValue: number;
  niftyChangePercent: number;
  bankNiftyValue: number;
  bankNiftyChangePercent: number;
  date: string;
  /** Optional chart image (e.g. NIFTY chart screenshot) used by variant C. */
  chartImagePath?: string;
}

export async function generateDailyThumbnail(data: DailyThumbnailData, outputPath: string) {
  const pct = data.niftyChangePercent;
  const tone: Tone =
    pct >= 2 ? 'bullish' :
    pct <= -2 ? 'shock' :
    pct >= 0 ? 'bullish' : 'bearish';
  const sign = pct >= 0 ? '+' : '';
  const bnSign = data.bankNiftyChangePercent >= 0 ? '+' : '';

  return renderAllVariants({
    tag: 'DAILY MARKET',
    bigText: 'NIFTY',
    pctChip: `${sign}${pct.toFixed(2)}%`,
    subline: `Bank Nifty ${bnSign}${data.bankNiftyChangePercent.toFixed(2)}%`,
    tone,
    date: data.date,
    chartImagePath: data.chartImagePath,
  }, outputPath);
}

export interface EarningsThumbnailData {
  companyName: string;
  ticker: string;
  quarter: string;
  hook: string;
  direction: 'up' | 'down' | 'mixed';
  changePercent?: number;
  changeLabel?: string;
  /** Optional stock chart image used by variant C (e.g. frames/stock-chart.png). */
  chartImagePath?: string;
}

export async function generateEarningsThumbnail(data: EarningsThumbnailData, outputPath: string) {
  const pct = data.changePercent ?? parsePctFromHook(data.hook);
  const tone: Tone =
    Math.abs(pct) >= 25 ? 'shock' :
    data.direction === 'up' ? 'bullish' :
    data.direction === 'down' ? 'bearish' : 'neutral';

  const sign = pct > 0 ? '+' : '';
  const pctChip = pct === 0 ? 'FLAT' : `${sign}${pct}%`;

  return renderAllVariants({
    tag: `${data.quarter} RESULTS`,
    bigText: data.ticker,
    pctChip,
    subline: data.changeLabel || 'Net Profit YoY',
    tone,
    chartImagePath: data.chartImagePath,
  }, outputPath);
}

function parsePctFromHook(hook: string): number {
  const m = hook.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

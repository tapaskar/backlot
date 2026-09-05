/**
 * Chart Capture — Takes TradingView-quality chart screenshots via Puppeteer
 *
 * Generates one screenshot per scene with proper annotations.
 * Uses TradingView's lightweight-charts library rendered in a headless browser.
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface ChartCapture {
  sceneName: string;
  imagePath: string;
  durationMs: number;
}

export interface ChartCaptureRequest {
  id: string;
  type: 'intro' | 'chart' | 'fii-dii' | 'summary';
  durationMs: number;
  // Chart fields
  displayName?: string;
  price?: number;
  change?: number;
  changePercent?: number;
  direction?: 'up' | 'down';
  supportLevel?: number;
  resistanceLevel?: number;
  annotation?: string;
  ohlcData?: Array<{ time: string; open: number; high: number; low: number; close: number }>;
  // FII/DII fields
  fiiNetCr?: number;
  diiNetCr?: number;
  fiiSentiment?: string;
  diiSentiment?: string;
  // Summary fields
  keyLevels?: Array<{ index: string; support: number; resistance: number }>;
  catchphrase?: string;
  // Intro fields
  title?: string;
  subtitle?: string;
  date?: string;
}

/**
 * Generate HTML for a TradingView-style chart using lightweight-charts.
 */
function buildChartHTML(req: ChartCaptureRequest): string {
  if (req.type === 'intro') return buildIntroHTML(req);
  if (req.type === 'fii-dii') return buildFIIDIIHTML(req);
  if (req.type === 'summary') return buildSummaryHTML(req);
  return buildCandlestickHTML(req);
}

function buildCandlestickHTML(req: ChartCaptureRequest): string {
  const data = req.ohlcData || [];
  const last30 = data.slice(-30);
  const color = req.direction === 'up' ? '#22c55e' : '#ef4444';
  const sign = (req.change || 0) >= 0 ? '+' : '';
  const arrow = req.direction === 'up' ? '▲' : '▼';

  return `<!DOCTYPE html>
<html><head>
<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f172a; width: 1920px; height: 1080px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
  .header { position: absolute; top: 32px; left: 48px; z-index: 10; }
  .name { color: #f1f5f9; font-size: 44px; font-weight: 800; letter-spacing: -1px; }
  .name span { color: #64748b; font-size: 24px; font-weight: 400; margin-left: 12px; }
  .price { color: #f1f5f9; font-size: 64px; font-weight: 800; letter-spacing: -2px; margin-top: 4px; }
  .change { color: ${color}; font-size: 32px; font-weight: 700; margin-left: 16px; }
  .chart { position: absolute; top: 160px; left: 32px; right: 32px; bottom: 120px; }
  .lower { position: absolute; bottom: 40px; left: 48px; }
  .lower-bar { background: linear-gradient(90deg, #10b981 0%, #10b981cc 70%, transparent 100%); padding: 10px 24px; border-radius: 4px 4px 0 0; display: inline-block; }
  .lower-bar span { color: #fff; font-size: 24px; font-weight: 700; }
  .lower-sub { background: rgba(15,23,42,0.9); padding: 6px 24px; border-radius: 0 0 4px 4px; display: inline-block; }
  .lower-sub span { color: #94a3b8; font-size: 18px; }
  ${req.annotation ? `.annotation { position: absolute; top: 180px; left: 50%; transform: translateX(-50%); background: rgba(16,185,129,0.92); padding: 10px 32px; border-radius: 8px; z-index: 20; }
  .annotation span { color: #fff; font-size: 20px; font-weight: 700; }` : ''}
</style>
</head><body>
  <div class="header">
    <div class="name">${req.displayName || 'NIFTY 50'}<span>Daily Chart</span></div>
    <div style="display:flex;align-items:baseline;gap:16px;margin-top:4px;">
      <div class="price">${(req.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
      <div class="change">${arrow} ${sign}${(req.change || 0).toFixed(2)} (${sign}${(req.changePercent || 0).toFixed(2)}%)</div>
    </div>
  </div>
  ${req.annotation ? `<div class="annotation"><span>${req.annotation}</span></div>` : ''}
  <div class="chart" id="chart"></div>
  <div class="lower">
    <div class="lower-bar"><span>PRIME'S MARKET PULSE</span></div>
    <div class="lower-sub"><span>${req.displayName || ''}</span></div>
  </div>
<script>
const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: { background: { type: 'solid', color: '#0f172a' }, textColor: '#64748b', fontSize: 13 },
  grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
  crosshair: { mode: 0 },
  rightPriceScale: { borderColor: '#1e293b', textColor: '#64748b' },
  timeScale: { borderColor: '#1e293b', timeVisible: false },
  handleScroll: false,
  handleScale: false,
});

const series = chart.addCandlestickSeries({
  upColor: '#22c55e', downColor: '#ef4444',
  borderUpColor: '#22c55e', borderDownColor: '#ef4444',
  wickUpColor: '#22c55e88', wickDownColor: '#ef444488',
});
series.setData(${JSON.stringify(last30)});

${req.supportLevel ? `series.createPriceLine({ price: ${req.supportLevel}, color: '#3b82f6', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'S: ${req.supportLevel.toLocaleString()}' });` : ''}
${req.resistanceLevel ? `series.createPriceLine({ price: ${req.resistanceLevel}, color: '#f97316', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'R: ${req.resistanceLevel.toLocaleString()}' });` : ''}

chart.timeScale().fitContent();
</script>
</body></html>`;
}

function buildIntroHTML(req: ChartCaptureRequest): string {
  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { background: radial-gradient(ellipse at 50% 40%, #1e293b 0%, #0f172a 70%); width: 1920px; height: 1080px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; }
  /* Glow ring behind logo */
  .glow { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -60%); width: 500px; height: 500px; border-radius: 50%; background: radial-gradient(circle, #10b98115 0%, transparent 70%); }
  /* Logo sigma */
  .logo { width: 100px; height: 100px; border-radius: 50%; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; font-size: 52px; font-weight: 900; color: #fff; box-shadow: 0 0 40px #10b98144; }
  .brand { font-size: 56px; color: #f8fafc; font-weight: 900; letter-spacing: 8px; text-transform: uppercase; margin-top: 8px; }
  .brand-dot { color: #10b981; }
  .tagline { font-size: 22px; color: #10b981; font-weight: 600; letter-spacing: 6px; text-transform: uppercase; }
  .divider { width: 500px; height: 2px; background: linear-gradient(90deg, transparent 0%, #10b981 30%, #10b981 70%, transparent 100%); margin: 8px 0; }
  .title { font-size: 64px; color: #f8fafc; font-weight: 800; letter-spacing: -1px; }
  .sub { font-size: 28px; color: #94a3b8; }
  .date { font-size: 22px; color: #64748b; }
  .url { position: absolute; bottom: 50px; font-size: 28px; color: #10b981; font-weight: 700; letter-spacing: 2px; }
</style></head><body>
  <div class="glow"></div>
  <div class="logo">Σ</div>
  <div class="brand">AALSITRADER<span class="brand-dot">.</span>COM</div>
  <div class="tagline">AI-Powered Trading for Indian Markets</div>
  <div class="divider"></div>
  <div class="title">${req.title || "PRIME'S MARKET PULSE"}</div>
  <div class="sub">${req.subtitle || 'Your Daily AI Market Analysis'}</div>
  <div class="date">${req.date || ''}</div>
  <div class="url">aalsitrader.com</div>
</body></html>`;
}

function buildFIIDIIHTML(req: ChartCaptureRequest): string {
  const fii = req.fiiNetCr || 0;
  const dii = req.diiNetCr || 0;
  const fiiColor = fii >= 0 ? '#22c55e' : '#ef4444';
  const diiColor = dii >= 0 ? '#22c55e' : '#ef4444';
  const maxVal = Math.max(Math.abs(fii), Math.abs(dii), 1);
  const fiiH = Math.round((Math.abs(fii) / maxVal) * 350);
  const diiH = Math.round((Math.abs(dii) / maxVal) * 350);

  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; } body { background: #0f172a; width: 1920px; height: 1080px; font-family: -apple-system, sans-serif; }
  .title { position: absolute; top: 60px; left: 60px; color: #f8fafc; font-size: 48px; font-weight: 800; }
  .sub { position: absolute; top: 120px; left: 60px; color: #64748b; font-size: 24px; }
  .bars { position: absolute; top: 220px; left: 0; right: 0; bottom: 160px; display: flex; align-items: flex-end; justify-content: center; gap: 200px; padding-bottom: 80px; }
  .bar-group { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .bar-val { font-size: 36px; font-weight: 800; }
  .bar { width: 180px; border-radius: 12px 12px 4px 4px; }
  .bar-label { font-size: 28px; font-weight: 700; color: #f8fafc; }
  .bar-sent { font-size: 20px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; }
</style></head><body>
  <div class="title">FII / DII Flows</div>
  <div class="sub">Net Institutional Activity (in Crores)</div>
  <div class="bars">
    <div class="bar-group">
      <div class="bar-val" style="color:${fiiColor}">${fii >= 0 ? '+' : ''}₹${fii.toLocaleString()} Cr</div>
      <div class="bar" style="height:${fiiH}px;background:linear-gradient(180deg,${fiiColor}cc,${fiiColor})"></div>
      <div class="bar-label">FII / FPI</div>
      <div class="bar-sent" style="color:${fiiColor}">${req.fiiSentiment || 'neutral'}</div>
    </div>
    <div class="bar-group">
      <div class="bar-val" style="color:${diiColor}">${dii >= 0 ? '+' : ''}₹${dii.toLocaleString()} Cr</div>
      <div class="bar" style="height:${diiH}px;background:linear-gradient(180deg,${diiColor}cc,${diiColor})"></div>
      <div class="bar-label">DII</div>
      <div class="bar-sent" style="color:${diiColor}">${req.diiSentiment || 'neutral'}</div>
    </div>
  </div>
</body></html>`;
}

function buildSummaryHTML(req: ChartCaptureRequest): string {
  const levels = req.keyLevels || [];
  const levelsHTML = levels.map((l) => `
    <div style="background:rgba(30,41,59,0.8);border-radius:16px;padding:28px 44px;border:1px solid #334155;display:flex;flex-direction:column;align-items:center;gap:16px;">
      <span style="color:#f8fafc;font-size:28px;font-weight:700">${l.index}</span>
      <div style="display:flex;gap:36px;">
        <div style="text-align:center"><div style="color:#3b82f6;font-size:16px;font-weight:600">SUPPORT</div><div style="color:#3b82f6;font-size:32px;font-weight:800">${l.support.toLocaleString()}</div></div>
        <div style="width:1px;background:#334155"></div>
        <div style="text-align:center"><div style="color:#f97316;font-size:16px;font-weight:600">RESISTANCE</div><div style="color:#f97316;font-size:32px;font-weight:800">${l.resistance.toLocaleString()}</div></div>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; }
  body { background: radial-gradient(ellipse at 50% 60%, #1e293b 0%, #0f172a 70%); width: 1920px; height: 1080px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; }
  .glow { position: absolute; bottom: 20%; left: 50%; transform: translateX(-50%); width: 600px; height: 400px; border-radius: 50%; background: radial-gradient(circle, #10b98110 0%, transparent 70%); }
</style></head><body>
  <div class="glow"></div>
  <!-- Key levels section -->
  <div style="font-size:36px;color:#f8fafc;font-weight:800;letter-spacing:1px">KEY LEVELS TO WATCH</div>
  <div style="display:flex;gap:48px">${levelsHTML}</div>

  <!-- Catchphrase -->
  <div style="font-size:34px;color:#10b981;font-weight:700;font-style:italic;text-align:center;max-width:860px;line-height:1.4;margin:8px 0">"${req.catchphrase || ''}"</div>

  <!-- Divider -->
  <div style="width:500px;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent);margin:4px 0"></div>

  <!-- Prominent branding -->
  <div style="display:flex;align-items:center;gap:20px;margin-top:4px">
    <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:900;color:#fff;box-shadow:0 0 30px #10b98144">Σ</div>
    <div style="display:flex;flex-direction:column">
      <span style="color:#f8fafc;font-size:40px;font-weight:900;letter-spacing:4px">AALSITRADER<span style="color:#10b981">.</span>COM</span>
      <span style="color:#94a3b8;font-size:20px;letter-spacing:2px">AI-Powered Algo Trading for Indian Markets</span>
    </div>
  </div>

  <!-- LIKE & SUBSCRIBE engagement pill — static end-card CTA. The earlier
       Remotion SummaryScene CTA never made it into production because daily
       videos are composed from Puppeteer screenshots of THIS HTML (not the
       Remotion render path). This is the only spot that ships. -->
  <div style="background:rgba(220,38,38,0.95);padding:14px 36px;border-radius:999px;display:flex;align-items:center;gap:22px;box-shadow:0 8px 32px rgba(220,38,38,0.4);border:2px solid rgba(255,255,255,0.2)">
    <div style="display:flex;align-items:center;gap:10px"><span style="font-size:30px">👍</span><span style="color:#fff;font-size:24px;font-weight:800;letter-spacing:1px">LIKE</span></div>
    <div style="width:1px;height:28px;background:rgba(255,255,255,0.4)"></div>
    <div style="display:flex;align-items:center;gap:10px"><span style="font-size:30px">🔔</span><span style="color:#fff;font-size:24px;font-weight:800;letter-spacing:1px">SUBSCRIBE</span></div>
    <div style="width:1px;height:28px;background:rgba(255,255,255,0.4)"></div>
    <div style="display:flex;align-items:center;gap:10px"><span style="font-size:30px">💬</span><span style="color:#fff;font-size:24px;font-weight:800;letter-spacing:1px">COMMENT</span></div>
  </div>

  <!-- Trial CTA -->
  <div style="background:linear-gradient(90deg,#10b981,#059669);padding:12px 44px;border-radius:12px;box-shadow:0 0 30px #10b98133">
    <span style="color:#fff;font-size:22px;font-weight:800;letter-spacing:2px">START FREE TRIAL → aalsitrader.com</span>
  </div>
</body></html>`;
}

/**
 * Capture all scene screenshots using Puppeteer.
 */
export async function captureScenes(
  requests: ChartCaptureRequest[],
  outputDir: string,
): Promise<ChartCapture[]> {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const captures: ChartCapture[] = [];

  for (const req of requests) {
    const page = await browser.newPage();
    const html = buildChartHTML(req);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    // Wait for lightweight-charts to render
    if (req.type === 'chart') {
      await page.waitForSelector('canvas', { timeout: 10000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500)); // extra buffer for chart animation
    }

    const imagePath = resolve(outputDir, `${req.id}.png`);
    await page.screenshot({ path: imagePath, type: 'png' });
    await page.close();

    captures.push({
      sceneName: req.id,
      imagePath,
      durationMs: req.durationMs,
    });
  }

  await browser.close();
  return captures;
}

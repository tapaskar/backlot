#!/usr/bin/env npx tsx
/**
 * Prime Speaks — Quarterly Results Deep Analysis Pipeline
 *
 * Run: npx tsx factory/earnings-pipeline.ts RELIANCE
 * Run: npx tsx factory/earnings-pipeline.ts TCS
 *
 * Pipeline:
 *   1. Fetch quarterly results (screener.in scraping)
 *   2. Deep analysis with hidden insights (Nova Lite — multi-pass)
 *   3. Generate curiosity-driven narration script
 *   4. Generate audio (Polly Kajal)
 *   5. Capture charts + results visuals (Puppeteer)
 *   6. Compose video (FFmpeg)
 *   7. Upload to YouTube with earnings thumbnail
 *
 * The analysis digs for:
 * - Revenue vs profit divergence (why margins expanded/contracted)
 * - Cash flow vs reported profit mismatch (earnings quality)
 * - Segment-level surprises (which business actually drove growth)
 * - Management guidance changes vs actual delivery
 * - YoY vs QoQ patterns (seasonal effects vs real trends)
 * - Peer comparison anomalies
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import puppeteer from 'puppeteer';
// @ts-ignore - pdf-parse has no types; lib subpath avoids the package's index.js test-PDF side effect
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { callLLM, stripMarkdown } from './llm';
import { validateGeneric, type SymbolDirection } from './script-validator';
import { parseSpeechMarks, buildTimedSentences, buildTimedScenes, extractLevels } from '../src/audio-sync';
import { captureScenes, type ChartCaptureRequest } from './chart-capture';
import { composeVideo } from './video-compose';
import { uploadToYouTube, syncFeedToS3 } from './youtube-upload';
import { publishPodcastEpisode } from './podcast';
import { generateEarningsThumbnail } from './thumbnail';
import { setVideoThumbnailWithRetry } from './youtube-thumb';
import { appendCTA, mixBellAtCTA } from './cta';

const REGION = 'ap-south-1';
const FPS = 30;
const bedrock = new BedrockRuntimeClient({ region: REGION });
const polly = new PollyClient({ region: REGION });

const OUT_DIR = resolve(__dirname, '..', 'out', 'earnings');
const FRAMES_DIR = resolve(OUT_DIR, 'frames');

// ─── Helpers for screener.in staleness detection ────────────────────────────

/**
 * Given an NSE filing date (e.g. "22-Apr-2026"), return the expected screener.in
 * quarter label (e.g. "Mar 2026"). An Indian corporate results filing in month M
 * covers the fiscal quarter ending in month F, where:
 *   Apr-May-Jun filings   → Mar of same year
 *   Jul-Aug-Sep           → Jun of same year
 *   Oct-Nov-Dec           → Sep of same year
 *   Jan-Feb-Mar           → Dec of previous year
 */
export function expectedQuarterFromFilingDate(filingDate: string): string | null {
  // Accept "22-Apr-2026" or "Apr 22, 2026" or ISO "2026-04-22"
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let filingMonth = -1;
  let filingYear = -1;
  const dashMatch = filingDate.match(/(\d{1,2})-(\w{3})-(\d{4})/);
  if (dashMatch) {
    filingMonth = monthNames.indexOf(dashMatch[2]);
    filingYear = parseInt(dashMatch[3], 10);
  } else {
    const d = new Date(filingDate);
    if (!Number.isNaN(d.getTime())) {
      filingMonth = d.getMonth();
      filingYear = d.getFullYear();
    }
  }
  if (filingMonth < 0 || filingYear < 1900) return null;

  // Map filing month to the quarter-end month it covers.
  // 0-indexed months: Jan=0 ... Dec=11.
  let qMonth: number;
  let qYear: number;
  if (filingMonth >= 3 && filingMonth <= 5) { qMonth = 2;  qYear = filingYear; }       // Apr-Jun → Mar
  else if (filingMonth >= 6 && filingMonth <= 8) { qMonth = 5;  qYear = filingYear; }  // Jul-Sep → Jun
  else if (filingMonth >= 9 && filingMonth <= 11) { qMonth = 8; qYear = filingYear; }  // Oct-Dec → Sep
  else { qMonth = 11; qYear = filingYear - 1; }                                         // Jan-Mar → Dec prev
  return `${monthNames[qMonth]} ${qYear}`;
}

/**
 * Loose match for screener.in quarter labels. Screener formats vary
 * ("Mar 2026", "Mar-2026", "Q4 Mar 2026"). We accept any label that contains
 * the expected "<Mon> <Year>" substring.
 */
export function quarterMatches(actual: string, expected: string): boolean {
  if (!actual) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(actual).includes(norm(expected));
}

/**
 * How many days old is the end-of-quarter relative to `today`?
 *
 * Examples (today = May 12 2026):
 *   "Dec 2025" → quarter-end Dec 31 2025 → 132 days old
 *   "Mar 2026" → quarter-end Mar 31 2026 →  42 days old
 *   "Jun 2026" → quarter-end Jun 30 2026 → -49 (future; not yet ended)
 *
 * Returns -1 if the label can't be parsed.
 */
export function quarterAgeDays(quarterLabel: string, today: Date = new Date()): number {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Tolerate "Mar 2026", "Mar-2026", "Q4 Mar 2026", "Mar 26", etc.
  const m = quarterLabel.match(/(\w{3})[\s-]+(\d{2,4})/);
  if (!m) return -1;
  const monthIdx = monthNames.indexOf(m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase());
  if (monthIdx < 0) return -1;
  let year = parseInt(m[2], 10);
  if (year < 100) year += 2000;
  // Last day of the quarter-end month.
  const qEnd = new Date(year, monthIdx + 1, 0);
  return Math.floor((today.getTime() - qEnd.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Fetch Quarterly Results from Screener.in ───────────────────────────────

interface QuarterlyResult {
  quarter: string;
  revenue: number;
  expenses: number;
  operatingProfit: number;
  opm: number;        // operating profit margin %
  netProfit: number;
  npm: number;        // net profit margin %
  eps: number;
}

interface CompanyData {
  name: string;
  ticker: string;
  sector: string;
  currentPrice: number;
  marketCap: string;
  pe: number;
  results: QuarterlyResult[];
  rawHTML?: string;
}

async function fetchCompanyData(ticker: string): Promise<CompanyData> {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  try {
    await page.goto(`https://www.screener.in/company/${ticker}/consolidated/`, { waitUntil: 'networkidle2', timeout: 20000 });

    // Get company name
    const name = await page.$eval('h1', (el) => el.textContent?.trim() || '').catch(() => ticker);

    // Get key ratios
    const ratios = await page.evaluate(() => {
      const items = document.querySelectorAll('.company-ratios li, .sub, .company-info li');
      let cp = 0, mc = '', pe = 0, sec = '';
      items.forEach((li) => {
        const t = li.textContent || '';
        if (t.includes('Market Cap')) mc = (li.querySelector('.number, .value') as any)?.textContent?.trim() || '';
        if (t.includes('Stock P/E')) pe = parseFloat((li.querySelector('.number, .value') as any)?.textContent?.replace(/,/g, '') || '0');
        if (t.includes('Current Price')) cp = parseFloat((li.querySelector('.number, .value') as any)?.textContent?.replace(/,/g, '') || '0');
      });
      return { currentPrice: cp, marketCap: mc, pe: pe };
    });

    // Get quarterly results — robust extraction
    const tableData = await page.evaluate(() => {
      const table = document.querySelector('#quarters');
      if (!table) return { headers: [] as string[], rows: {} as Record<string, string[]> };
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim() || '');
      const rowMap: Record<string, string[]> = {};
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('td'));
        const label = cells[0]?.textContent?.trim().replace(/\s*\+\s*$/, '') || '';
        if (label) rowMap[label] = cells.map((c) => c.textContent?.trim() || '');
      });
      return { headers, rows: rowMap };
    });

    await browser.close();

    // Parse results from table data
    const parseNum = (s: string) => parseFloat((s || '0').replace(/,/g, '').replace('%', '')) || 0;
    const results: QuarterlyResult[] = [];

    // Take last 5 quarters (most recent first = rightmost columns)
    const colCount = tableData.headers.length;
    const startCol = Math.max(1, colCount - 5);

    for (let i = colCount - 1; i >= startCol; i--) {
      const quarter = tableData.headers[i];
      if (!quarter) continue;

      const revenue = parseNum(tableData.rows['Sales']?.[i] || tableData.rows['Revenue']?.[i] || '0');
      const expenses = parseNum(tableData.rows['Expenses']?.[i] || '0');
      const operatingProfit = parseNum(tableData.rows['Operating Profit']?.[i] || '0');
      const opm = parseNum(tableData.rows['OPM %']?.[i] || '0');
      const netProfit = parseNum(tableData.rows['Net Profit']?.[i] || tableData.rows['Profit after tax']?.[i] || '0');
      const eps = parseNum(tableData.rows['EPS in Rs']?.[i] || tableData.rows['EPS']?.[i] || '0');

      if (revenue > 0) {
        results.push({
          quarter, revenue, expenses, operatingProfit, opm,
          netProfit, npm: revenue > 0 ? +(netProfit / revenue * 100).toFixed(1) : 0, eps,
        });
      }
    }

    return {
      name, ticker, sector: '', currentPrice: ratios.currentPrice,
      marketCap: ratios.marketCap, pe: ratios.pe, results,
    };
  } catch (err) {
    await browser.close();
    throw new Error(`Failed to fetch data for ${ticker}: ${err}`);
  }
}

// ─── Fetch Stock Price + OHLC from Yahoo Finance ────────────────────────────

async function fetchStockPrice(ticker: string): Promise<{ currentPrice: number; change: number; changePercent: number; ohlc: any[] }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.NS?interval=1d&range=6mo`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = (await res.json()) as any;
    const result = data?.chart?.result?.[0];
    if (!result) return { currentPrice: 0, change: 0, changePercent: 0, ohlc: [] };

    const meta = result.meta;
    const price = meta?.regularMarketPrice || 0;
    const prev = meta?.chartPreviousClose || meta?.previousClose || price;

    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const ohlc = ts.map((t: number, i: number) =>
      q.open?.[i] != null ? ({
        time: new Date(t * 1000).toISOString().split('T')[0],
        open: +q.open[i].toFixed(2),
        high: +q.high[i].toFixed(2),
        low: +q.low[i].toFixed(2),
        close: +q.close[i].toFixed(2),
      }) : null
    ).filter(Boolean);

    return {
      currentPrice: Math.round(price * 100) / 100,
      change: Math.round((price - prev) * 100) / 100,
      changePercent: Math.round(((price - prev) / prev) * 10000) / 100,
      ohlc,
    };
  } catch {
    return { currentPrice: 0, change: 0, changePercent: 0, ohlc: [] };
  }
}

// ─── Exchange Filing (NSE corporate announcements + PDF text) ───────────────

interface ExchangeFiling {
  date: string;
  type: string;          // e.g. "Outcome of Board Meeting"
  snippet: string;       // attchmntText from NSE API (short)
  attachmentUrl?: string;// PDF URL
  fullText?: string;     // extracted PDF text (truncated)
}

async function fetchExchangeFiling(ticker: string): Promise<ExchangeFiling | null> {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  try {
    // Establish NSE session cookies
    await page.goto('https://www.nseindia.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // Last 120 days of announcements for this symbol — covers a full quarter
    // reporting cycle (companies file Dec results in Jan/Feb, Mar in Apr/May, etc.)
    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(today.getDate() - 120);
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
    const apiUrl = `https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(ticker)}&from_date=${fmt(windowStart)}&to_date=${fmt(today)}`;

    const announcements = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!r.ok) return [];
        return await r.json();
      } catch {
        return [];
      }
    }, apiUrl);

    const arr = Array.isArray(announcements) ? announcements : [];

    // Score announcements by how likely they are to be the actual results press release.
    //   3 = explicit results filing with PDF attachment (best)
    //   2 = "Outcome of Board Meeting" mentioning results, with PDF
    //   1 = any results-mentioning text with PDF
    //   0 = matches but no PDF attached (still usable for snippet)
    //  -1 = explicitly junk (newspaper publication, copy of newspaper, intimation)
    const scoreAnnouncement = (a: any): number => {
      const desc = String(a.desc || '').toLowerCase();
      const text = String(a.attchmntText || '').toLowerCase();
      const both = desc + ' ' + text;
      const hasFile = !!a.attchmntFile;

      // Newspaper ad acknowledgments are NOT the results filing — skip outright
      if (desc.includes('newspaper')) return -2;

      const isResults =
        both.includes('financial result') ||
        both.includes('quarterly result') ||
        both.includes('audited result') ||
        both.includes('unaudited result') ||
        (desc.includes('outcome of board meeting') && both.includes('result')) ||
        desc.includes('press release');

      if (!isResults) return -2;

      // Higher score = more likely to be the actual results press release with PDF text
      if (hasFile && (desc.includes('financial result') || desc.includes('quarterly result'))) return 3;
      if (hasFile && desc.includes('outcome of board meeting')) return 2;
      if (hasFile) return 1;
      return 0;
    };

    // Pick the most recent results filing. Date is PRIMARY sort because the watcher
    // only queues tickers whose newest filing is fresh — picking an older filing
    // (even if its desc-text scores higher) is exactly the bug that caused the
    // May-8 Dec-2025-vs-Mar-2026 mismatch (a Jan "Financial Results" desc beat a
    // May "Outcome of Board Meeting" desc despite being months old).
    const ranked = arr
      .map((a: any) => ({ a, score: scoreAnnouncement(a) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => {
        const dateCmp = String(y.a.an_dt || y.a.sort_date || '').localeCompare(
          String(x.a.an_dt || x.a.sort_date || '')
        );
        if (dateCmp !== 0) return dateCmp;
        return y.score - x.score; // tie-break: richer filing wins for same date
      });

    const resultsAnn = ranked[0]?.a;

    if (!resultsAnn) {
      console.log(`  (Filing: scanned ${arr.length} NSE announcements for ${ticker} in last 120d, none matched a results filing)`);
      await browser.close();
      return null;
    }

    const attachmentUrl: string | undefined = resultsAnn.attchmntFile;
    await browser.close();

    // Download the PDF directly from Node (page.evaluate's base64 round-trip
    // is unreliable for multi-MB PDFs and silently truncates). NSE archives
    // serve PDFs publicly without cookies.
    let fullText: string | undefined;
    if (attachmentUrl) {
      try {
        const r = await fetch(attachmentUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          const pdfData = await pdfParse(buf);
          // Collapse whitespace, cap to 12k chars to keep prompt size sane
          fullText = (pdfData.text || '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 12000);
        } else {
          console.log(`  (PDF download HTTP ${r.status})`);
        }
      } catch (err) {
        console.log(`  (PDF extraction failed: ${(err as Error).message})`);
      }
    }
    return {
      date: resultsAnn.an_dt || resultsAnn.sort_date || '',
      type: resultsAnn.desc || 'Announcement',
      snippet: String(resultsAnn.attchmntText || '').slice(0, 1500),
      attachmentUrl,
      fullText,
    };
  } catch (err) {
    await browser.close().catch(() => {});
    console.log(`  (Filing fetch failed: ${(err as Error).message})`);
    return null;
  }
}

// ─── Deep Analysis (Claude Haiku 4.5 — facts pre-computed in TS) ────────────

// Find the same-quarter-last-year by matching the month label, not by index.
// Index-based matching is fragile (results[3] is 9mo ago, not 12).
function findYoYQuarter(latest: QuarterlyResult, results: QuarterlyResult[]): QuarterlyResult | undefined {
  const parts = latest.quarter.split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [month, yearStr] = parts;
  const targetYear = String(parseInt(yearStr, 10) - 1);
  return results.find((r) => r.quarter === `${month} ${targetYear}`);
}

async function analyzeResults(company: CompanyData, filing: ExchangeFiling | null): Promise<string> {
  const r = company.results;
  if (r.length < 2) {
    throw new Error(`Insufficient quarterly data for ${company.ticker}: only ${r.length} quarter(s)`);
  }

  const latest = r[0];
  const qoq = r[1];
  // True YoY: match by month label. Falls back to oldest available quarter if no match.
  const yoy = findYoYQuarter(latest, r) || r[r.length - 1];

  // Helpers
  const pct = (cur: number, base: number) =>
    base !== 0 ? +(((cur - base) / Math.abs(base)) * 100).toFixed(1) : 0;
  const pp = (cur: number, base: number) => +(cur - base).toFixed(1);
  const dir = (delta: number) => (delta > 0.05 ? 'UP' : delta < -0.05 ? 'DOWN' : 'FLAT');
  const sign = (n: number) => (n >= 0 ? '+' : '');

  // Pre-computed deltas — the LLM never has to compute these
  const revQoQ = pct(latest.revenue, qoq.revenue);
  const revYoY = pct(latest.revenue, yoy.revenue);
  const opQoQ = pct(latest.operatingProfit, qoq.operatingProfit);
  const opYoY = pct(latest.operatingProfit, yoy.operatingProfit);
  const opmQoQ = pp(latest.opm, qoq.opm);
  const opmYoY = pp(latest.opm, yoy.opm);
  const npQoQ = pct(latest.netProfit, qoq.netProfit);
  const npYoY = pct(latest.netProfit, yoy.netProfit);
  const npmQoQ = pp(latest.npm, qoq.npm);
  const npmYoY = pp(latest.npm, yoy.npm);
  const epsQoQ = pct(latest.eps, qoq.eps);
  const epsYoY = pct(latest.eps, yoy.eps);

  // Auto-detect patterns the LLM should focus on
  const observations: string[] = [];

  if (opmYoY > 1) {
    observations.push(`Margins EXPANDED YoY by +${opmYoY}pp (from ${yoy.opm}% in ${yoy.quarter} to ${latest.opm}% in ${latest.quarter}) — operational efficiency improving.`);
  } else if (opmYoY < -1) {
    observations.push(`Margins CONTRACTED YoY by ${opmYoY}pp (from ${yoy.opm}% in ${yoy.quarter} to ${latest.opm}% in ${latest.quarter}) — cost pressure or pricing weakness.`);
  } else {
    observations.push(`Margins broadly STABLE YoY (${yoy.opm}% → ${latest.opm}%, ${sign(opmYoY)}${opmYoY}pp).`);
  }

  if (Math.sign(revYoY) > 0 && Math.sign(npYoY) < 0) {
    observations.push(`PARADOX: Revenue UP ${sign(revYoY)}${revYoY}% YoY but Net Profit DOWN ${npYoY}% YoY — bottom line not following top line, investigate why (taxes, interest, depreciation, one-time charges).`);
  } else if (Math.sign(revYoY) < 0 && Math.sign(npYoY) > 0) {
    observations.push(`UNUSUAL: Revenue DOWN ${revYoY}% YoY but Net Profit UP ${sign(npYoY)}${npYoY}% YoY — margin expansion or cost cuts driving bottom line despite topline weakness.`);
  }

  if (opYoY > 5 && npYoY < opYoY - 5) {
    observations.push(`OPERATING-LEVERAGE GAP: Operating profit ${sign(opYoY)}${opYoY}% YoY but Net profit only ${sign(npYoY)}${npYoY}% YoY — a ${(opYoY - npYoY).toFixed(1)}pp gap is being eaten below the operating line (taxes/interest/depreciation/exceptionals).`);
  }

  if (revQoQ < -3 && revYoY > 5) {
    observations.push(`SEQUENTIAL DIP: Revenue down ${revQoQ}% QoQ but still up ${sign(revYoY)}${revYoY}% YoY — likely seasonal/cyclical, not a structural decline.`);
  }

  if (revYoY > 15) observations.push(`Strong YoY revenue growth (+${revYoY}%) — accelerating top line.`);
  if (revYoY < -5) observations.push(`Revenue declined ${revYoY}% YoY — top-line stress.`);

  // Margin trajectory across all quarters
  const opmSeries = r.map((q) => `${q.quarter}=${q.opm}%`).reverse().join(' → ');

  const tableBlock = r
    .map(
      (q) =>
        `  ${q.quarter.padEnd(10)} | Rev ₹${String(q.revenue).padStart(6)}Cr | OpProfit ₹${String(q.operatingProfit).padStart(5)}Cr | OPM ${String(q.opm).padStart(4)}% | NetProfit ₹${String(q.netProfit).padStart(5)}Cr | NPM ${q.npm.toFixed(1).padStart(5)}% | EPS ₹${q.eps}`
    )
    .join('\n');

  const cleanMcap = (company.marketCap || '').replace(/\s+/g, ' ').trim();

  // Build the exchange filing block (or empty if filing missing)
  const filingBlock = filing
    ? `EXCHANGE FILING — what ${company.name} itself told NSE on ${filing.date}:
Filing type: ${filing.type}
${filing.fullText
  ? `Press release / filing text (extracted from PDF, may be truncated):
"""
${filing.fullText}
"""`
  : `Filing snippet (no full PDF text available):
"""
${filing.snippet || '(empty)'}
"""`}
`
    : `EXCHANGE FILING: (none found in the last 14 days for ${company.ticker})`;

  const prompt = `You are Prime (Σ), AalsiTrader's AI analyst. Write a Hindi-English narration script for a quarterly results video.

COMPANY: ${company.name} (${company.ticker})
CMP: ₹${company.currentPrice} | Market Cap: ${cleanMcap} | P/E: ${company.pe}

RAW QUARTERLY DATA (most recent first):
${tableBlock}

${filingBlock}

VERIFIED FACTS — these are ground truth, do NOT contradict them:
• Latest reporting quarter: ${latest.quarter}
• Compared to previous quarter ${qoq.quarter}, and same quarter last year ${yoy.quarter}.

• Revenue: ₹${latest.revenue}Cr — ${dir(revQoQ)} ${sign(revQoQ)}${revQoQ}% QoQ (vs ₹${qoq.revenue}Cr in ${qoq.quarter}) | ${dir(revYoY)} ${sign(revYoY)}${revYoY}% YoY (vs ₹${yoy.revenue}Cr in ${yoy.quarter})
• Operating Profit: ₹${latest.operatingProfit}Cr — ${dir(opQoQ)} ${sign(opQoQ)}${opQoQ}% QoQ | ${dir(opYoY)} ${sign(opYoY)}${opYoY}% YoY
• OPM (Operating Margin): ${latest.opm}% — ${opmQoQ >= 0 ? 'EXPANDED' : 'CONTRACTED'} ${sign(opmQoQ)}${opmQoQ}pp QoQ (was ${qoq.opm}%) | ${opmYoY >= 0 ? 'EXPANDED' : 'CONTRACTED'} ${sign(opmYoY)}${opmYoY}pp YoY (was ${yoy.opm}%)
• Net Profit: ₹${latest.netProfit}Cr — ${dir(npQoQ)} ${sign(npQoQ)}${npQoQ}% QoQ | ${dir(npYoY)} ${sign(npYoY)}${npYoY}% YoY
• NPM (Net Margin): ${latest.npm.toFixed(1)}% — ${npmQoQ >= 0 ? 'EXPANDED' : 'CONTRACTED'} ${sign(npmQoQ)}${npmQoQ.toFixed(1)}pp QoQ | ${npmYoY >= 0 ? 'EXPANDED' : 'CONTRACTED'} ${sign(npmYoY)}${npmYoY.toFixed(1)}pp YoY
• EPS: ₹${latest.eps} — ${dir(epsQoQ)} ${sign(epsQoQ)}${epsQoQ}% QoQ | ${dir(epsYoY)} ${sign(epsYoY)}${epsYoY}% YoY

OPM TRAJECTORY (oldest → newest): ${opmSeries}

KEY OBSERVATIONS (auto-detected from the verified facts):
${observations.map((o) => '• ' + o).join('\n')}

YOUR TASK:
Write a 850–1100 word narration script (Hindi-English mix) explaining what actually happened this quarter. Base every claim on the VERIFIED FACTS and the EXCHANGE FILING above. Lead with whatever is most striking for THIS specific company (don't use a templated opener for every stock).

HARD CONSTRAINTS — violating any of these is a failure:
1. Every direction word (UP/DOWN/expanded/contracted/grew/fell/rose/dropped/improved/weakened) MUST match the verified facts. If OPM ${opmYoY >= 0 ? 'expanded' : 'contracted'} YoY, you may NOT say margins "${opmYoY >= 0 ? 'shrank' : 'expanded'}". Re-check the OPM line above before each direction claim.
2. Do not invent quarters. Only use quarter names that appear in the RAW DATA above (${r.map((q) => q.quarter).join(', ')}). Never write things like "Jan 2025" or "Q1 2026" — those don't exist in this data.
3. Use the EXACT numbers from the verified facts. Don't round, don't approximate, don't make up numbers.
4. Do not start with a generic curiosity hook like "Why did margins fall despite record revenue?" — that question only fits if margins actually fell AND revenue is at a record. Choose an opener that fits the actual story.
5. The "filing highlights" section MUST come ONLY from the EXCHANGE FILING text above. Do NOT invent dividends, buybacks, capacity expansions, acquisitions, or management quotes that are not in the filing text. If a fact isn't in the filing text, don't claim the company "announced" it.
6. If the EXCHANGE FILING block says "(none found)" or the text is empty, SKIP the filing-highlights section entirely. Do not fabricate filing content.

STRUCTURE:
1. Greeting: "Namaste investors! This is Prime from AalsiTrader, aaj hum dekh rahe hain ${company.name} ke ${latest.quarter} quarterly results."
2. Headline (1–2 sentences): the single most important fact for THIS company, drawn from the verified facts.
3. FILING HIGHLIGHTS (~150–250 words): Summarise what the company itself said in its press release / exchange filing — pull from the EXCHANGE FILING text above. Cover anything specifically called out: dividend / interim dividend / buyback announcements, capex or capacity additions, acquisitions or divestments, segment-level performance commentary, management outlook quotes, order-book updates, debt/cash position changes, one-time charges, or specific risks the company flagged. Be concrete — quote numbers and management phrasing where available. SKIP this section entirely if no filing text is available.
4. The story behind the numbers: connect the verified facts and the auto-detected observations into a coherent narrative.
5. Margin trajectory: state explicitly whether OPM expanded or contracted, with the actual pp change.
6. What it means for the stock at CMP ₹${company.currentPrice} and P/E ${company.pe}.
7. Close: "Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!"

STYLE:
- Hindi-English mix, conversational, like a smart analyst friend.
- Short sentences (under 20 words).
- No markdown, no headings, just flowing narration.

Output ONLY the narration script — no preamble, no explanation, no meta commentary.`;

  // Build the verified-numbers whitelist + per-symbol direction expectation.
  // Approved numbers = every numeric value the prompt cited from the data
  // dossier. The LLM may paraphrase (e.g. "around 22500"); validateGeneric
  // tolerates ±0.5% rounding.
  const approvedNums: number[] = [
    company.currentPrice, company.pe,
    revQoQ, revYoY, opQoQ, opYoY, opmQoQ, opmYoY, npQoQ, npYoY, npmQoQ, npmYoY, epsQoQ, epsYoY,
  ];
  for (const q of r) {
    approvedNums.push(q.revenue, q.operatingProfit, q.opm, q.netProfit, q.npm, q.eps);
  }
  // Quarter-name year tokens (e.g. "Q4FY25" → 25, FY26 → 26) and the
  // standalone ticker numbers from raw text would otherwise flag — strip
  // those by adding common 1-2 digit FY references explicitly.
  for (const q of r) {
    const m = q.quarter.match(/(\d{2})/g);
    if (m) for (const t of m) approvedNums.push(parseInt(t, 10));
  }

  // Direction check skipped here — CompanyData doesn't track today's
  // intraday move, only `currentPrice`. The earnings video is about quarterly
  // results, not today's price action, so direction integrity matters less.
  const symbols: SymbolDirection[] = [];

  let script = await callLLM(prompt);
  let cleaned = stripMarkdown(script);
  let v = validateGeneric(cleaned, approvedNums, symbols);

  if (!v.valid) {
    console.warn(`[earnings-validator] Hallucination on first generation for ${company.ticker}:`);
    for (const i of v.issues) console.warn(`  - ${i}`);
    const retryPrompt = prompt +
      `\n\nIMPORTANT: A previous attempt was REJECTED for these issues:\n` +
      v.issues.map(i => `  - ${i}`).join('\n') +
      `\n\nFix them. Cite ONLY numbers from the VERIFIED FACTS / RAW DATA blocks above.`;
    script = await callLLM(retryPrompt, { temperature: 0.1 });
    cleaned = stripMarkdown(script);
    v = validateGeneric(cleaned, approvedNums, symbols);
    if (!v.valid) {
      throw new Error(
        `[earnings-validator] Script for ${company.ticker} REJECTED twice — refusing to render. ` +
        `Issues: ${v.issues.join('; ')}`
      );
    }
    console.log(`[earnings-validator] Retry produced a clean script for ${company.ticker}.`);
  }
  return cleaned;
}

// LLM dispatcher (Gemini → Claude → Nova Pro) lives in ./llm — shared with pipeline.ts

// ─── Audio ──────────────────────────────────────────────────────────────────

async function genAudio(script: string) {
  const chunks: string[] = [];
  let rem = script;
  while (rem.length > 0) {
    if (rem.length <= 2900) { chunks.push(rem); break; }
    let at = rem.lastIndexOf('. ', 2900);
    if (at < 1200) at = 2900; else at += 1;
    chunks.push(rem.slice(0, at).trim());
    rem = rem.slice(at).trim();
  }

  const audioBufs: Buffer[] = [];
  let allMarks = '';
  let charOff = 0, timeOff = 0;

  for (const chunk of chunks) {
    const [audioRes, marksRes] = await Promise.all([
      polly.send(new SynthesizeSpeechCommand({ Text: chunk, OutputFormat: 'mp3', VoiceId: 'Kajal', Engine: 'neural', LanguageCode: 'en-IN' })),
      polly.send(new SynthesizeSpeechCommand({ Text: chunk, OutputFormat: 'json', VoiceId: 'Kajal', Engine: 'neural', LanguageCode: 'en-IN', SpeechMarkTypes: ['word', 'sentence'] })),
    ]);
    audioBufs.push(Buffer.from(await audioRes.AudioStream!.transformToByteArray()));
    const marksText = new TextDecoder().decode(await marksRes.AudioStream!.transformToByteArray());
    let maxT = 0;
    for (const line of marksText.trim().split('\n')) {
      const m = JSON.parse(line);
      m.time += timeOff; m.start += charOff; m.end += charOff;
      if (m.time > maxT) maxT = m.time;
      allMarks += JSON.stringify(m) + '\n';
    }
    charOff += chunk.length + 1;
    timeOff = maxT + 1500;
  }

  const audio = Buffer.concat(audioBufs);
  const marks = parseSpeechMarks(allMarks);
  return { audio, marksJsonl: allMarks, durationMs: marks[marks.length - 1] ? marks[marks.length - 1].time + 2000 : 300000 };
}

// ─── Build Earnings Scenes ──────────────────────────────────────────────────

function buildEarningsHTML(company: CompanyData): string {
  const latest = company.results[0] || { quarter: 'N/A', revenue: 0, expenses: 0, operatingProfit: 0, opm: 0, netProfit: 0, npm: 0, eps: 0 };
  const prev = company.results[1];
  const revChange = prev && prev.revenue > 0 ? ((latest.revenue - prev.revenue) / prev.revenue * 100).toFixed(1) : '0';
  const npChange = prev && prev.netProfit !== 0 ? ((latest.netProfit - prev.netProfit) / Math.abs(prev.netProfit) * 100).toFixed(1) : '0';

  const fmt = (n: any) => (n ?? 0).toLocaleString();
  const rowsHTML = company.results.slice(0, 5).map((r, i) => {
    const bg = i === 0 ? 'rgba(16,185,129,0.15)' : 'transparent';
    return `<tr style="background:${bg}">
      <td style="color:#f8fafc;font-weight:${i === 0 ? 800 : 400}">${r.quarter}</td>
      <td style="color:#f8fafc">₹${fmt(r.revenue)}</td>
      <td style="color:#f8fafc">₹${fmt(r.operatingProfit)}</td>
      <td style="color:${(r.opm || 0) > (prev?.opm || 0) ? '#22c55e' : '#ef4444'}">${r.opm || 0}%</td>
      <td style="color:#f8fafc">₹${fmt(r.netProfit)}</td>
      <td style="color:#f8fafc">₹${r.eps || 0}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; } body { width: 1920px; height: 1080px; background: #0f172a; font-family: -apple-system, sans-serif; padding: 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
  .company { color: #f8fafc; font-size: 48px; font-weight: 800; }
  .ticker { color: #64748b; font-size: 24px; letter-spacing: 4px; }
  .badge { background: #10b981; padding: 8px 20px; border-radius: 8px; }
  .badge span { color: #fff; font-size: 20px; font-weight: 700; }
  .metrics { display: flex; gap: 32px; margin-bottom: 32px; }
  .metric { background: rgba(30,41,59,0.8); border-radius: 12px; padding: 20px 28px; border: 1px solid #334155; }
  .metric-label { color: #64748b; font-size: 16px; margin-bottom: 4px; }
  .metric-value { color: #f8fafc; font-size: 32px; font-weight: 800; }
  .metric-change { font-size: 18px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th { color: #64748b; font-size: 16px; font-weight: 600; text-align: left; padding: 12px 16px; border-bottom: 1px solid #334155; }
  td { padding: 14px 16px; font-size: 20px; border-bottom: 1px solid #1e293b; }
  .lower { position: absolute; bottom: 40px; left: 48px; }
  .lower-bar { background: linear-gradient(90deg, #10b981, #10b981cc, transparent); padding: 10px 24px; border-radius: 4px; display: inline-block; }
  .lower-bar span { color: #fff; font-size: 22px; font-weight: 700; }
</style></head><body>
  <div class="header">
    <div>
      <div class="company">${company.name}</div>
      <div class="ticker">${company.ticker} | ${company.sector}</div>
    </div>
    <div class="badge"><span>${latest.quarter} RESULTS</span></div>
  </div>
  <div class="metrics">
    <div class="metric"><div class="metric-label">Revenue</div><div class="metric-value">₹${fmt(latest.revenue)} Cr</div><div class="metric-change" style="color:${parseFloat(revChange) >= 0 ? '#22c55e' : '#ef4444'}">${parseFloat(revChange) >= 0 ? '+' : ''}${revChange}% QoQ</div></div>
    <div class="metric"><div class="metric-label">Net Profit</div><div class="metric-value">₹${fmt(latest.netProfit)} Cr</div><div class="metric-change" style="color:${parseFloat(npChange) >= 0 ? '#22c55e' : '#ef4444'}">${parseFloat(npChange) >= 0 ? '+' : ''}${npChange}% QoQ</div></div>
    <div class="metric"><div class="metric-label">OPM</div><div class="metric-value">${latest.opm || 0}%</div></div>
    <div class="metric"><div class="metric-label">EPS</div><div class="metric-value">₹${latest.eps || 0}</div></div>
    <div class="metric"><div class="metric-label">CMP</div><div class="metric-value">₹${fmt(company.currentPrice)}</div></div>
    <div class="metric"><div class="metric-label">P/E</div><div class="metric-value">${company.pe}</div></div>
  </div>
  <table><thead><tr><th>Quarter</th><th>Revenue</th><th>Op. Profit</th><th>OPM %</th><th>Net Profit</th><th>EPS</th></tr></thead><tbody>${rowsHTML}</tbody></table>
  <div class="lower"><div class="lower-bar"><span>RESULTS ANALYSIS by PRIME AI | AALSITRADER.COM</span></div></div>
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const ticker = process.argv[2];
  if (!ticker) {
    console.error('Usage: npx tsx factory/earnings-pipeline.ts <TICKER>');
    console.error('  e.g. npx tsx factory/earnings-pipeline.ts RELIANCE');
    process.exit(1);
  }

  const t0 = Date.now();
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log(`║   PRIME SPEAKS — ${ticker} Results Deep Dive          `);
  console.log('╚═══════════════════════════════════════════════════════╝');

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(FRAMES_DIR)) mkdirSync(FRAMES_DIR, { recursive: true });

  // 1. Fetch company data (screener.in) + stock price & OHLC (Yahoo) + NSE filing
  console.log('\n[1/7] Fetching quarterly results + stock data + exchange filing...');
  const [company, stockData, filing] = await Promise.all([
    fetchCompanyData(ticker),
    fetchStockPrice(ticker),
    fetchExchangeFiling(ticker),
  ]);

  // Patch CMP from Yahoo (screener often fails to extract it)
  if (stockData.currentPrice > 0) company.currentPrice = stockData.currentPrice;

  console.log(`  ${company.name} | ${company.results.length} quarters | CMP ₹${company.currentPrice}`);
  if (company.results.length > 0) {
    const l = company.results[0];
    console.log(`  Latest: ${l.quarter} | Rev ₹${l.revenue}Cr | NP ₹${l.netProfit}Cr | OPM ${l.opm}%`);
  }
  console.log(`  OHLC: ${stockData.ohlc.length} bars`);
  if (filing) {
    console.log(`  Filing: ${filing.type} (${filing.date}) | ${filing.fullText ? `${filing.fullText.length} chars from PDF` : 'snippet only'}`);
    writeFileSync(resolve(OUT_DIR, 'filing.json'), JSON.stringify(filing, null, 2));
  } else {
    console.log(`  Filing: none found in last 14 days`);
  }
  writeFileSync(resolve(OUT_DIR, 'company-data.json'), JSON.stringify(company, null, 2));

  // Staleness guard: we got triggered because NSE just got a results filing, but
  // if screener.in's latest quarter doesn't match that filing's quarter, screener
  // hasn't ingested the new data yet and we'd produce a video about LAST quarter's
  // numbers with a misleading "Q4 results" title. Abort and let cron retry later.
  if (filing && company.results[0]) {
    const expected = expectedQuarterFromFilingDate(filing.date);
    const actual = company.results[0].quarter;
    if (expected && !quarterMatches(actual, expected)) {
      throw new Error(
        `STALE_SCREENER_DATA: NSE filing dated ${filing.date} implies ${expected} results, ` +
          `but screener.in's latest quarter is "${actual}". Refusing to publish a video about ` +
          `older data with a fresh-looking title. Re-run tomorrow after screener updates.`
      );
    }
  }

  // Calendar backstop: even if NO recent filing was fetched (NSE API hiccup,
  // filing outside the 14-day window, etc.), refuse to publish quarters that
  // are already > 100 days old. SEBI mandates filing within 45 days of
  // quarter-end; 100 days gives a generous buffer for late filers + screener
  // ingestion lag. Anything past that is genuinely the WRONG quarter for now.
  //
  // Example: May 12 2026 — "Dec 2025" is 132 days old → fail. "Mar 2026" is
  // 42 days old → pass. This catches Dec 2025 videos being shipped in May 2026,
  // which is what kept happening before this check was added (Metropolis, Bank
  // of Baroda, Tata Consumer on May 8; Dixon, Dr Reddys on May 12).
  if (company.results[0]) {
    const STALE_AFTER_DAYS = parseInt(process.env.STALE_AFTER_DAYS || '100', 10);
    const age = quarterAgeDays(company.results[0].quarter);
    if (age > STALE_AFTER_DAYS) {
      throw new Error(
        `STALE_QUARTER: screener.in's latest quarter for ${ticker} is "${company.results[0].quarter}" ` +
          `which is ${age} days past quarter-end (limit: ${STALE_AFTER_DAYS}). ` +
          `That's almost certainly the wrong quarter to publish about today — the new one ` +
          `should already have been filed. Refusing to publish stale data. ` +
          `Override with STALE_AFTER_DAYS=999 if you really know what you're doing.`
      );
    }
  }

  // 2. Deep analysis + script
  console.log('\n[2/7] Deep analysis + script (Gemini 2.5 Flash → Claude → Nova Pro)...');
  const rawScript = await analyzeResults(company, filing);
  // Append the spoken CTA ("hit like and subscribe…") to every script so
  // Prime asks for the conversion verbally, not just on-screen.
  const script = appendCTA(stripMarkdown(rawScript));
  writeFileSync(resolve(OUT_DIR, 'script.txt'), script);
  console.log(`  ${script.split(/\s+/).length} words`);

  // 3. Audio + speech marks
  console.log('\n[3/7] Audio + speech marks (Polly)...');
  const { audio, marksJsonl, durationMs } = await genAudio(script);
  const audioPath = resolve(OUT_DIR, 'audio.mp3');
  writeFileSync(audioPath, audio);
  writeFileSync(resolve(OUT_DIR, 'speech-marks.jsonl'), marksJsonl);
  // Overlay the bell SFX at the CTA timestamp. No-op if asset missing.
  mixBellAtCTA(audioPath, marksJsonl);
  console.log(`  ${Math.round(audio.length / 1024)} KB | ~${(durationMs / 1000).toFixed(1)}s`);

  // 4. Capture results table screenshot
  console.log('\n[4/7] Capturing results visuals...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1920, height: 1080 } });

  // Intro scene
  const introPage = await browser.newPage();
  const introHTML = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; } body { width: 1920px; height: 1080px; background: radial-gradient(ellipse at 50% 40%, #1e293b 0%, #0f172a 70%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; font-family: -apple-system, sans-serif; }
</style></head><body>
  <div style="background:#10b981;padding:10px 28px;border-radius:8px"><span style="color:#fff;font-size:24px;font-weight:800;letter-spacing:3px">${company.results[0]?.quarter || 'Q4'} RESULTS DEEP DIVE</span></div>
  <div style="font-size:80px;color:#f8fafc;font-weight:900;letter-spacing:-2px">${company.name}</div>
  <div style="font-size:32px;color:#64748b;letter-spacing:4px">${company.ticker} | ${company.sector}</div>
  <div style="width:500px;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent);margin:8px 0"></div>
  <div style="font-size:28px;color:#94a3b8">Deep Analysis by Prime AI</div>
  <div style="position:absolute;bottom:50px;display:flex;align-items:center;gap:12px">
    <div style="width:40px;height:40px;border-radius:50%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#fff">Σ</div>
    <span style="color:#10b981;font-size:28px;font-weight:800;letter-spacing:2px">AALSITRADER.COM</span>
  </div>
</body></html>`;
  await introPage.setContent(introHTML, { waitUntil: 'networkidle0' });
  await introPage.screenshot({ path: resolve(FRAMES_DIR, 'intro.png') });
  await introPage.close();

  // Results table scene
  const tablePage = await browser.newPage();
  await tablePage.setContent(buildEarningsHTML(company), { waitUntil: 'networkidle0' });
  await tablePage.screenshot({ path: resolve(FRAMES_DIR, 'results-table.png') });
  await tablePage.close();

  // Stock chart — inject pre-fetched OHLC data directly (no browser-side fetch)
  const chartPage = await browser.newPage();
  const priceColor = stockData.changePercent >= 0 ? '#22c55e' : '#ef4444';
  const priceSign = stockData.changePercent >= 0 ? '+' : '';
  const priceArrow = stockData.changePercent >= 0 ? '▲' : '▼';
  const ohlcJson = JSON.stringify(stockData.ohlc.slice(-90)); // last 90 days

  const chartHTML = `<!DOCTYPE html>
<html><head><script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
<style>* { margin: 0; } body { width: 1920px; height: 1080px; background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
.header { position: absolute; top: 32px; left: 48px; z-index: 10; }
.name { color: #f1f5f9; font-size: 44px; font-weight: 800; }
.name span { color: #64748b; font-size: 24px; font-weight: 400; margin-left: 12px; }
.price-row { display: flex; align-items: baseline; gap: 16px; margin-top: 4px; }
.price { color: #f1f5f9; font-size: 64px; font-weight: 800; letter-spacing: -2px; }
.change { color: ${priceColor}; font-size: 32px; font-weight: 700; }
.chart { position: absolute; top: 160px; left: 32px; right: 32px; bottom: 100px; }
.lower { position: absolute; bottom: 32px; left: 48px; display: flex; gap: 16px; align-items: center; }
.lower-bar { background: linear-gradient(90deg, #10b981, #10b981cc, transparent); padding: 10px 24px; border-radius: 4px 4px 0 0; }
.lower-bar span { color: #fff; font-size: 22px; font-weight: 700; }
.lower-sub { background: rgba(15,23,42,0.9); padding: 6px 24px; border-radius: 0 0 4px 4px; }
.lower-sub span { color: #94a3b8; font-size: 18px; }
</style></head><body>
<div class="header">
  <div class="name">${company.name}<span>${company.ticker} | ${company.results[0]?.quarter || ''} Results Period</span></div>
  <div class="price-row">
    <div class="price">₹${(company.currentPrice || 0).toLocaleString('en-IN')}</div>
    <div class="change">${priceArrow} ${priceSign}${stockData.change} (${priceSign}${stockData.changePercent}%)</div>
  </div>
</div>
<div class="chart" id="chart"></div>
<div class="lower">
  <div><div class="lower-bar"><span>RESULTS ANALYSIS by PRIME AI</span></div><div class="lower-sub"><span>AALSITRADER.COM</span></div></div>
</div>
<script>
// OHLC data pre-fetched and injected — no browser fetch needed
const data = ${ohlcJson};
const chart = LightweightCharts.createChart(document.getElementById("chart"), {
  layout: { background: { type: "solid", color: "#0f172a" }, textColor: "#64748b", fontSize: 13 },
  grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
  crosshair: { mode: 0 },
  rightPriceScale: { borderColor: "#1e293b" },
  timeScale: { borderColor: "#1e293b", timeVisible: false },
  handleScroll: false, handleScale: false,
});
const s = chart.addCandlestickSeries({
  upColor: "#22c55e", downColor: "#ef4444",
  borderUpColor: "#22c55e", borderDownColor: "#ef4444",
  wickUpColor: "#22c55e88", wickDownColor: "#ef444488",
});
s.setData(data);
chart.timeScale().fitContent();
</script></body></html>`;

  await chartPage.setContent(chartHTML, { waitUntil: 'networkidle0' });
  // Wait for lightweight-charts canvas to render
  await chartPage.waitForSelector('canvas', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  await chartPage.screenshot({ path: resolve(FRAMES_DIR, 'stock-chart.png') });
  await chartPage.close();

  // Outro
  const outroPage = await browser.newPage();
  const outroHTML = `<!DOCTYPE html>
<html><head><style>* { margin: 0; } body { width: 1920px; height: 1080px; background: radial-gradient(ellipse at 50% 60%, #1e293b 0%, #0f172a 70%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; font-family: -apple-system, sans-serif; }</style></head><body>
  <div style="font-size:48px;color:#10b981;font-weight:700;font-style:italic;text-align:center;max-width:1000px;line-height:1.3">"Data bolta hai, hum sunte hain.<br>Aalsi rahein, smart rahein!"</div>
  <div style="width:500px;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent)"></div>
  <div style="display:flex;align-items:center;gap:20px">
    <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:38px;font-weight:900;color:#fff;box-shadow:0 0 40px #10b98144">Σ</div>
    <div><div style="color:#f8fafc;font-size:48px;font-weight:900;letter-spacing:5px">AALSITRADER<span style="color:#10b981">.</span>COM</div><div style="color:#94a3b8;font-size:22px;letter-spacing:2px">AI-Powered Algo Trading for Indian Markets</div></div>
  </div>
  <!-- LIKE & SUBSCRIBE pill — static end-card CTA so viewers see it during the
       outro frames. Red background draws attention. Stacks above the trial CTA. -->
  <div style="background:rgba(220,38,38,0.95);padding:16px 40px;border-radius:999px;display:flex;align-items:center;gap:24px;box-shadow:0 8px 32px rgba(220,38,38,0.4);border:2px solid rgba(255,255,255,0.2)">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:32px">👍</span>
      <span style="color:#fff;font-size:26px;font-weight:800;letter-spacing:1px">LIKE</span>
    </div>
    <div style="width:1px;height:30px;background:rgba(255,255,255,0.4)"></div>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:32px">🔔</span>
      <span style="color:#fff;font-size:26px;font-weight:800;letter-spacing:1px">SUBSCRIBE</span>
    </div>
    <div style="width:1px;height:30px;background:rgba(255,255,255,0.4)"></div>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:32px">💬</span>
      <span style="color:#fff;font-size:26px;font-weight:800;letter-spacing:1px">COMMENT</span>
    </div>
  </div>
  <div style="background:linear-gradient(90deg,#10b981,#059669);padding:14px 48px;border-radius:14px;box-shadow:0 0 30px #10b98133">
    <span style="color:#fff;font-size:24px;font-weight:800;letter-spacing:2px">START FREE TRIAL → aalsitrader.com</span>
  </div>
</body></html>`;
  await outroPage.setContent(outroHTML, { waitUntil: 'networkidle0' });
  await outroPage.screenshot({ path: resolve(FRAMES_DIR, 'outro.png') });
  await outroPage.close();
  await browser.close();
  console.log('  4 scenes captured (intro, results table, stock chart, outro)');

  // 5. Build scene timing from speech marks
  console.log('\n[5/7] Building scene timeline...');
  const marks = parseSpeechMarks(marksJsonl);
  const sentenceCount = marks.filter((m) => m.type === 'sentence').length;
  // Simple split: intro 10%, results table 40%, chart 40%, outro 10%
  const totalMs = durationMs;
  const scenes = [
    { id: 'intro', imagePath: resolve(FRAMES_DIR, 'intro.png'), durationMs: Math.round(totalMs * 0.08) },
    { id: 'results', imagePath: resolve(FRAMES_DIR, 'results-table.png'), durationMs: Math.round(totalMs * 0.40) },
    { id: 'chart', imagePath: resolve(FRAMES_DIR, 'stock-chart.png'), durationMs: Math.round(totalMs * 0.40) },
    { id: 'outro', imagePath: resolve(FRAMES_DIR, 'outro.png'), durationMs: Math.round(totalMs * 0.12) },
  ];
  scenes.forEach((s) => console.log(`  ${s.id}: ${(s.durationMs / 1000).toFixed(1)}s`));

  // 6. Compose video
  console.log('\n[6/7] Composing video (FFmpeg)...');
  const videoPath = resolve(OUT_DIR, 'episode.mp4');
  composeVideo({ captures: scenes.map((s) => ({ sceneName: s.id, imagePath: s.imagePath, durationMs: s.durationMs })), audioPath, outputPath: videoPath });
  const desktopEarningsPath = process.env.DESKTOP_COPY_PATH_EARNINGS || '/Users/tapas/Desktop/prime-speaks-earnings.mp4';
  try { copyFileSync(videoPath, desktopEarningsPath); } catch {}

  // Generate thumbnail
  const thumbPath = resolve(OUT_DIR, 'thumbnail.png');
  const latest = company.results[0];
  const prev = company.results[1];

  // Build a clean, factual hook from verified numbers.
  // Prefer YoY (true year-over-year) over QoQ for the headline number — it's
  // less noisy and the videos describe themselves as "results" videos.
  // Always use Math.abs(base) as the divisor so a negative-prev-quarter
  // (loss → profit, profit → loss) doesn't yield contradictory text like
  // "Profit -129% UP" (the bug we shipped earlier).
  const yoyForTitle = latest ? findYoYQuarter(latest, company.results) : undefined;
  const npBaseQuarter = yoyForTitle || prev;
  const npChangePct =
    latest && npBaseQuarter && Math.abs(npBaseQuarter.netProfit) > 0
      ? Math.round(((latest.netProfit - npBaseQuarter.netProfit) / Math.abs(npBaseQuarter.netProfit)) * 100)
      : 0;
  const npPeriodLabel = yoyForTitle ? 'YoY' : 'QoQ';
  const npSign = npChangePct >= 0 ? '+' : '';
  const opmYoY = yoyForTitle && latest ? +(latest.opm - yoyForTitle.opm).toFixed(1) : 0;
  const marginWord =
    opmYoY > 0.5 ? 'Margins Expand' : opmYoY < -0.5 ? 'Margins Contract' : 'Margins Stable';

  // Direction used by thumbnail layout (kept compatible with existing thumbnail.ts)
  const profitDirection: 'up' | 'down' | 'mixed' =
    npChangePct > 0 ? 'up' : npChangePct < 0 ? 'down' : 'mixed';

  // Clean hook — no clickbait, real numbers, correct signs.
  // e.g. "Net Profit +13% YoY · Margins Expand"
  //      "Net Profit -45% YoY · Margins Contract"
  //      "Net Profit Flat YoY · Margins Stable"
  const hook =
    npChangePct === 0
      ? `Net Profit Flat ${npPeriodLabel} · ${marginWord}`
      : `Net Profit ${npSign}${npChangePct}% ${npPeriodLabel} · ${marginWord}`;

  const thumbPaths = await generateEarningsThumbnail({
    companyName: company.name, ticker: company.ticker,
    quarter: latest?.quarter || 'Latest', hook, direction: profitDirection,
    changePercent: npChangePct,
    changeLabel: `Net Profit ${npPeriodLabel}`,
    chartImagePath: resolve(FRAMES_DIR, 'stock-chart.png'),
  }, thumbPath);
  console.log(`  Thumbnails: A=${thumbPaths.A}\n              B=${thumbPaths.B}\n              C=${thumbPaths.C}`);
  console.log('  (A uploaded as primary; B/C available for YouTube Studio Test & Compare)');

  // 7. Upload
  console.log('\n[7/7] Uploading to YouTube...');
  const quarter = latest?.quarter || 'Latest';
  const title = `${company.name} ${quarter} Results — ${hook} | Prime AI Deep Dive`;
  const description = `Deep dive into ${company.name} (${ticker}) ${quarter} quarterly results.\n\nKey metrics:\n• Revenue: ₹${latest?.revenue?.toLocaleString() || 'N/A'} Cr\n• Net Profit: ₹${latest?.netProfit?.toLocaleString() || 'N/A'} Cr\n• OPM: ${latest?.opm || 'N/A'}%\n• EPS: ₹${latest?.eps || 'N/A'}\n\nAnalysis covers: Revenue vs profit divergence, margin trajectory, earnings quality, and hidden insights the market might be missing.\n\n🤖 100% AI-generated analysis by Prime (Σ) at AalsiTrader\n🔗 Start algo trading: https://aalsitrader.com\n\n⚠️ This is AI-generated educational content, not financial advice.\n\n#${ticker} #QuarterlyResults #${company.name.replace(/\s+/g, '')} #StockAnalysis #AalsiTrader #Earnings #IndianStockMarket`;
  const tags = [ticker.toLowerCase(), company.name.toLowerCase(), 'quarterly results', 'earnings', 'stock analysis', 'aalsitrader', 'deep dive', 'indian stock market', 'nse'];

  try {
    const privacyStatus = (process.env.YT_PRIVACY === 'unlisted' || process.env.YT_PRIVACY === 'private') ? process.env.YT_PRIVACY : 'public';
    const result = await uploadToYouTube({ videoPath, title: title.slice(0, 100), description, tags, privacyStatus });
    console.log(`  Uploaded: ${result.url}`);

    // Set thumbnail (retries on rate limit, logs to out/.thumbnail-failures.log on permanent failure)
    try {
      await setVideoThumbnailWithRetry(result.videoId, thumbPath);
    } catch (err: any) {
      console.error('  Thumbnail upload ultimately failed — see out/.thumbnail-failures.log');
    }

    // Save metadata + sync to S3 for website
    const earningsMeta = {
      videoId: result.videoId, url: result.url, title, ticker,
      company: company.name, quarter, type: 'earnings-analysis',
      uploadedAt: new Date().toISOString(),
      thumbnailUrl: `https://img.youtube.com/vi/${result.videoId}/maxresdefault.jpg`,
    };
    writeFileSync(resolve(OUT_DIR, 'latest-video.json'), JSON.stringify(earningsMeta, null, 2));
    await syncFeedToS3(earningsMeta);

    // Publish podcast episode
    await publishPodcastEpisode({
      audioPath,
      title: title.slice(0, 100),
      description: `Deep dive into ${company.name} (${ticker}) ${quarter} quarterly results. Revenue: ₹${latest?.revenue?.toLocaleString() || 'N/A'} Cr, Net Profit: ₹${latest?.netProfit?.toLocaleString() || 'N/A'} Cr, OPM: ${latest?.opm || 'N/A'}%. Analysis by Prime AI at AalsiTrader.`,
      type: 'earnings',
      youtubeUrl: result.url,
    });

    console.log(`\n  LIVE: ${result.url}`);
  } catch (err: any) {
    console.error(`  Upload failed: ${err.message}`);
    // Exit code 2 = transient upload failure (quota, auth, network) — caller
    // (e.g. upload-remaining.sh) should re-queue this ticker.
    // The video file is already on disk; only the YouTube upload failed.
    process.exitCode = 2;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Done in ${elapsed}s | Video: ~/Desktop/prime-speaks-earnings.mp4`);
}

// Only run main() when invoked as a CLI, not when imported by another module
// (e.g. unit tests, helper scripts). Without this guard, importing
// `quarterAgeDays` for testing triggers the full pipeline.
if (require.main === module) {
  main().catch((err) => { console.error('Pipeline failed:', err.message); process.exit(1); });
}

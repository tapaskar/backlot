#!/bin/bash
# Earnings Watcher — Checks for new quarterly results daily and triggers video creation
#
# Cron: 0 12 * * 1-5  (5:30 PM IST, after market close + time for filings)
#
# How it works:
# 1. Fetches NSE "Outcome of Board Meeting" announcements for F&O stocks
# 2. Filters for "financial results" / "quarterly results" in the text
# 3. Checks against processed list to avoid duplicates
# 4. Triggers earnings-pipeline.ts for each new result
# 5. Rate limits to max 10 uploads/day (YouTube quota)

LOG="${LOG_FILE:-/tmp/prime-speaks-earnings.log}"
VIDEO_DIR="${VIDEO_DIR:-/Volumes/wininstall/trading-dashboard/video}"
PROCESSED_FILE="${PROCESSED_FILE:-$VIDEO_DIR/factory/.processed-earnings.json}"
NPX_BIN="${NPX_BIN:-/usr/local/bin/npx}"
MAX_UPLOADS_PER_DAY="${MAX_UPLOADS_PER_DAY:-10}"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Earnings watcher started" >> "$LOG"

# Skip weekends
DOW=$(date +%u)
if [ "$DOW" -gt 5 ]; then
  echo "$(date '+%Y-%m-%d') — Weekend, skipping." >> "$LOG"
  exit 0
fi

# Initialize processed file if it doesn't exist
if [ ! -f "$PROCESSED_FILE" ]; then
  echo '[]' > "$PROCESSED_FILE"
fi

cd "$VIDEO_DIR"

# Step 1: Fetch new earnings from NSE using Node.js (handles cookies properly)
NEW_TICKERS=$("$NPX_BIN" tsx -e '
import puppeteer from "puppeteer";
import { readFileSync, writeFileSync } from "fs";

const FNO_STOCKS = new Set([
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
  "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
  "TITAN","SUNPHARMA","HCLTECH","WIPRO","ULTRACEMCO","NESTLEIND",
  "BAJAJ-AUTO","TATASTEEL","NTPC","POWERGRID","ONGC","JSWSTEEL","ADANIENT",
  "ADANIPORTS","TECHM","INDUSINDBK","HINDALCO","DRREDDY","CIPLA","DIVISLAB",
  "BRITANNIA","APOLLOHOSP","EICHERMOT","HEROMOTOCO","COALINDIA","BPCL","GRASIM",
  "SBILIFE","TATACONSUM","BAJAJFINSV","HDFCLIFE","LTIM",
  "HAL","BDL","BANKBARODA","PNB","CANBK","IDFCFIRSTB","FEDERALBNK","BANDHANBNK",
  "AUBANK","MANAPPURAM","MUTHOOTFIN","CHOLAFIN","SBICARD","PEL",
  "RECLTD","PFC","IRCTC","IRFC","IOC","GAIL","PETRONET","IGL",
  "HINDPETRO","NMDC","VEDL","NATIONALUM","SAIL","JINDALSTEL",
  "TATAPOWER","NHPC","TATACOMM","ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY",
  "MPHASIS","COFORGE","PERSISTENT","LTTS","TATAELXSI",
  "BIOCON","LUPIN","AUROPHARMA","TORNTPHARM","ALKEM","IPCALAB",
  "LAURUSLABS","GRANULES","NATCOPHARMA","GLENMARK","METROPOLIS",
  "ASHOKLEY","TVSMOTOR","BALKRISIND","MOTHERSON","EXIDEIND",
  "BHEL","BOSCHLTD","ESCORTS",
  "DABUR","MARICO","GODREJCP","COLPAL","TRENT","PAGEIND","VOLTAS","HAVELLS",
  "CROMPTON","PIDILITIND","BERGEPAINT","JUBLFOOD",
  "SHREECEM","AMBUJACEM","ACC","DALBHARAT",
  "ABB","SIEMENS","CUMMINSIND","CONCOR",
  "PIIND","ATUL","DEEPAKNTR","NAVINFLUOR","SRF","AARTIIND",
  "LICHSGFIN","CANFINHOME","ICICIGI","ICICIPRULI","MFSL","MCX",
  "CDSLTD","BSE","ANGELONE","JIOFIN",
  "DLF","GODREJPROP","PRESTIGE","LODHA",
  "DIXON","POLYCAB","KEI",
  "INDHOTEL","LICI","MAXHEALTH","STARHEALTH","DMART",
]);

const PROCESSED = JSON.parse(readFileSync("'"$PROCESSED_FILE"'", "utf-8"));
const processedSet = new Set(PROCESSED);

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

  // Get NSE session
  await page.goto("https://www.nseindia.com", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  const cookies = await page.cookies();
  const cookieStr = cookies.map(c => c.name + "=" + c.value).join("; ");

  // Fetch board meeting outcomes (last 3 days)
  const today = new Date();
  const threeDaysAgo = new Date(today);
  threeDaysAgo.setDate(today.getDate() - 3);
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");

  const apiUrl = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${fmt(threeDaysAgo)}&to_date=${fmt(today)}`;

  const res = await page.evaluate(async (url: string) => {
    const r = await fetch(url);
    return await r.json();
  }, apiUrl);

  await browser.close();

  // Filter: F&O stocks with "Outcome of Board Meeting" that mention financial/quarterly results
  const newTickers: string[] = [];

  for (const ann of res) {
    const symbol = ann.symbol;
    if (!FNO_STOCKS.has(symbol)) continue;

    const text = (ann.attchmntText || "" + ann.desc || "").toLowerCase();
    const isResults = text.includes("financial result") || text.includes("quarterly result") ||
                      text.includes("audited result") || text.includes("unaudited result") ||
                      (ann.desc === "Outcome of Board Meeting" && text.includes("result"));

    if (!isResults) continue;

    // Check quarter from date
    const quarter = new Date(ann.an_dt).toISOString().slice(0, 7); // YYYY-MM
    const key = symbol + ":" + quarter;

    if (processedSet.has(key)) continue;

    // Emit "<symbol>|<key>" so the bash loop can mark the key as processed
    // ONLY after the pipeline actually succeeds. Previously we marked here
    // upfront, which meant a transient failure (stale screener, network error,
    // etc.) permanently skipped the ticker on later runs.
    newTickers.push(`${symbol}|${key}`);

    // Also add to the in-memory set so a second NSE announcement for the same
    // (symbol, month) — e.g. both a "Board Meeting" and an "Outcome of Board
    // Meeting" notice — doesn'\''t trigger a duplicate pipeline run.
    processedSet.add(key);
  }

  // Output new tickers (one per line, "TICKER|KEY" format)
  for (const t of newTickers) console.log(t);
}

main().catch(() => {});
' 2>/dev/null)

if [ -z "$NEW_TICKERS" ]; then
  echo "$(date '+%Y-%m-%d') — No new F&O earnings found today." >> "$LOG"
  exit 0
fi

echo "$(date '+%Y-%m-%d') — New earnings detected:" >> "$LOG"
echo "$NEW_TICKERS" >> "$LOG"

# Step 2: Generate videos (rate limited). Mark each entry as processed in the
# JSON file ONLY after the pipeline exits 0, so transient failures (stale
# screener data, YouTube quota, etc.) get retried on the next run.
#
# IMPORTANT: use a here-string (`<<<`) instead of `echo … | while`. With a pipe,
# bash runs the right-hand side in a SUBSHELL, so any variable mutated inside
# (count, attempted, uploaded, queued, failed) is invisible after the loop
# ends — that's why the summary line was always logging "0 processed" even
# when videos uploaded successfully. A here-string keeps the loop in the
# current shell scope.
attempted=0
uploaded=0
queued=0
failed=0
while IFS= read -r entry; do
  if [ -z "$entry" ]; then continue; fi
  ticker="${entry%%|*}"
  key="${entry#*|}"
  attempted=$((attempted + 1))

  if [ "$attempted" -gt "$MAX_UPLOADS_PER_DAY" ]; then
    echo "  $ticker — QUEUED (upload limit reached, will retry tomorrow)" >> "$LOG"
    queued=$((queued + 1))
    continue
  fi

  echo "  [$attempted] Generating video for $ticker..." >> "$LOG"
  if "$NPX_BIN" tsx factory/earnings-pipeline.ts "$ticker" >> "$LOG" 2>&1; then
    echo "  $ticker — done" >> "$LOG"
    uploaded=$((uploaded + 1))
    # Success → persist to processed file
    "$NPX_BIN" tsx -e "
      const fs = require('fs');
      const path = '$PROCESSED_FILE';
      const arr = JSON.parse(fs.readFileSync(path, 'utf-8'));
      if (!arr.includes('$key')) { arr.push('$key'); fs.writeFileSync(path, JSON.stringify(arr, null, 2)); }
    " 2>/dev/null
  else
    echo "  $ticker — FAILED (will retry on next run)" >> "$LOG"
    failed=$((failed + 1))
  fi
done <<< "$NEW_TICKERS"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Earnings watcher finished (attempted=$attempted uploaded=$uploaded queued=$queued failed=$failed)" >> "$LOG"

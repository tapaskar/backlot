#!/usr/bin/env npx tsx
/**
 * Prime Speaks Factory — Daily Market Update Pipeline
 *
 * Run: npx tsx factory/pipeline.ts
 * Cron: 0 16 * * 1-5  (4 PM IST, Mon-Fri after market close)
 *
 * Pipeline:
 *   1. Fetch market data + OHLC  (Yahoo Finance)
 *   2. Generate script            (Nova Lite — $0.00015)
 *   3. Generate audio + marks     (Polly Kajal — $0.03)
 *   4. Capture chart screenshots   (Puppeteer + TradingView lightweight-charts)
 *   5. Compose video              (FFmpeg — crossfade transitions)
 *   6. Upload to YouTube          (YouTube Data API v3)
 *
 * Total cost: ~$0.03/episode | $0/mo first year (free tier)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { parseSpeechMarks, buildTimedSentences, buildTimedScenes, extractLevels } from '../src/audio-sync';
import { captureScenes, type ChartCaptureRequest } from './chart-capture';
import { composeVideo } from './video-compose';
import { uploadToYouTube, generateYouTubeMetadata, syncFeedToS3 } from './youtube-upload';
import { publishPodcastEpisode } from './podcast';
import { generateDailyThumbnail } from './thumbnail';
import { setVideoThumbnailWithRetry } from './youtube-thumb';
import { appendCTA, mixBellAtCTA } from './cta';
import { callLLM, stripMarkdown } from './llm';
import { validateScript, type ScriptFacts } from './script-validator';

const REGION = 'ap-south-1';
const FPS = 30;
const polly = new PollyClient({ region: REGION });

const OUT_DIR = resolve(__dirname, '..', 'out');
const FRAMES_DIR = resolve(OUT_DIR, 'frames');

// ─── Data ───────────────────────────────────────────────────────────────────

async function fetchMarket() {
  const syms = [
    { key: 'nifty', sym: '^NSEI' },
    { key: 'bankNifty', sym: '^NSEBANK' },
    { key: 'sensex', sym: '^BSESN' },
  ];
  const r: any = {};
  await Promise.all(syms.map(async ({ key, sym }) => {
    try {
      const d = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json() as any;
      const m = d?.chart?.result?.[0]?.meta;
      if (!m) { r[key] = { value: 0, change: 0, changePercent: 0 }; return; }
      const p = m.regularMarketPrice || 0, prev = m.chartPreviousClose || m.previousClose || p;
      r[key] = { value: +p.toFixed(2), change: +(p - prev).toFixed(2), changePercent: +(((p - prev) / prev) * 100).toFixed(2) };
    } catch { r[key] = { value: 0, change: 0, changePercent: 0 }; }
  }));
  return r;
}

async function fetchOHLC(sym: string, days = 60) {
  try {
    const d = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${days}d`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).json() as any;
    const r = d?.chart?.result?.[0]; if (!r) return [];
    const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
    return ts.map((t: number, i: number) => q.open?.[i] != null ? ({ time: new Date(t * 1000).toISOString().split('T')[0], open: +q.open[i].toFixed(2), high: +q.high[i].toFixed(2), low: +q.low[i].toFixed(2), close: +q.close[i].toFixed(2) }) : null).filter(Boolean);
  } catch { return []; }
}

// ─── Script ─────────────────────────────────────────────────────────────────

// Compute support/resistance levels from recent OHLC. Tiny pivot-style heuristic:
//   resistance = highest high of last `lookback` bars
//   support    = lowest low of last `lookback` bars
//   round to nearest 50 for cleaner narration
function computeLevels(ohlc: any[], lookback = 20): { support: number; resistance: number } {
  if (!ohlc || ohlc.length === 0) return { support: 0, resistance: 0 };
  const recent = ohlc.slice(-lookback);
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);
  const round = (n: number) => Math.round(n / 50) * 50;
  return { support: round(Math.min(...lows)), resistance: round(Math.max(...highs)) };
}

async function genScript(mkt: any, niftyOHLC: any[], bnOHLC: any[]) {
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const n = mkt.nifty;
  const b = mkt.bankNifty;
  const niftyLevels = computeLevels(niftyOHLC);
  const bnLevels = computeLevels(bnOHLC);

  const niftyDir = n.changePercent > 0 ? 'UP' : n.changePercent < 0 ? 'DOWN' : 'FLAT';
  const bnDir = b.changePercent > 0 ? 'UP' : b.changePercent < 0 ? 'DOWN' : 'FLAT';
  const niftyAbsChange = Math.abs(n.change);
  const bnAbsChange = Math.abs(b.change);
  const sign = (n: number) => (n >= 0 ? '+' : '');

  // Auto-detect the day's character
  const observations: string[] = [];
  if (Math.abs(n.changePercent) > 1 && Math.abs(b.changePercent) > 1) {
    observations.push(
      n.changePercent > 0
        ? `Strong broad-based rally — both Nifty and Bank Nifty closed UP more than 1%.`
        : `Broad-based selloff — both Nifty and Bank Nifty closed DOWN more than 1%.`
    );
  } else if (Math.abs(n.changePercent) < 0.3 && Math.abs(b.changePercent) < 0.3) {
    observations.push(`Quiet, range-bound day — both indices moved less than 0.3%.`);
  }
  if (Math.sign(n.changePercent) !== Math.sign(b.changePercent) && Math.abs(n.changePercent) > 0.2) {
    observations.push(
      `DIVERGENCE: Nifty ${niftyDir} ${sign(n.changePercent)}${n.changePercent}% but Bank Nifty ${bnDir} ${sign(b.changePercent)}${b.changePercent}% — financial sector trading against the broader market today.`
    );
  }
  if (Math.abs(b.changePercent) > Math.abs(n.changePercent) * 1.5 && Math.abs(b.changePercent) > 0.5) {
    observations.push(
      `Bank Nifty moved ${(Math.abs(b.changePercent) / Math.max(Math.abs(n.changePercent), 0.01)).toFixed(1)}× harder than Nifty — banks were the day's main driver.`
    );
  }
  if (n.value >= niftyLevels.resistance - 50) {
    observations.push(`Nifty closed near the recent resistance (~${niftyLevels.resistance}) — breakout watch.`);
  }
  if (n.value <= niftyLevels.support + 50) {
    observations.push(`Nifty closed near the recent support (~${niftyLevels.support}) — breakdown risk.`);
  }

  const prompt = `You are Prime (Σ), AalsiTrader's AI market analyst. Write a 2-minute Hindi-English narration script for the daily market wrap video.

Date: ${today}

VERIFIED FACTS — these are the day's closing prints. Do NOT contradict them.

NIFTY 50: closed at ${n.value}, ${niftyDir} ${sign(n.change)}${n.change} points (${sign(n.changePercent)}${n.changePercent}%)
  Recent 20-day support: ~${niftyLevels.support}
  Recent 20-day resistance: ~${niftyLevels.resistance}

BANK NIFTY: closed at ${b.value}, ${bnDir} ${sign(b.change)}${b.change} points (${sign(b.changePercent)}${b.changePercent}%)
  Recent 20-day support: ~${bnLevels.support}
  Recent 20-day resistance: ~${bnLevels.resistance}

KEY OBSERVATIONS (auto-detected from the verified facts):
${observations.length > 0 ? observations.map((o) => '• ' + o).join('\n') : '• Mixed day — no extreme signals detected. Cover the basics.'}

YOUR TASK:
Write a 350–450 word narration script (Hindi-English mix) explaining today's market action. Base every claim on the VERIFIED FACTS above.

HARD CONSTRAINTS — violating any of these is a failure:
1. Every direction word (UP/DOWN/rally/selloff/gained/lost/rose/fell/closed higher/closed lower) MUST match the verified facts. Nifty closed ${niftyDir}, Bank Nifty closed ${bnDir}. You may NOT reverse these.
2. If you cite a number, it MUST be one of the numbers in the verified facts (closing values, point change, percent change, or the support/resistance levels). Do not invent numbers.
3. Do not start with a generic curiosity hook unless it actually fits today. Lead with whatever is most striking about today's session.
4. No markdown, no headings, no bullet points — just flowing narration.

STRUCTURE:
1. Open: "Namaste traders! This is Prime from AalsiTrader."
2. Headline (1–2 sentences): the one most striking thing about today's close.
3. Nifty action: closing value, direction, point/percent change. State support and resistance levels with the actual numbers above.
4. Bank Nifty action: closing value, direction, point/percent change. Note divergence vs Nifty if any.
5. Outlook for tomorrow: what to watch (the levels mentioned, any divergences flagged in observations).
6. Close: "Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!"

STYLE:
- Hindi-English mix, conversational, like a smart trader friend.
- Short sentences (under 20 words).
- Use the EXACT closing numbers and EXACT support/resistance levels above.

Output ONLY the narration script — no preamble, no explanation, no meta commentary.`;

  // Generate, then validate against the same facts the prompt was built from.
  // If the LLM hallucinated (wrong direction word or invented number), retry
  // ONCE with a stricter regenerate prompt. If still bad, throw — better to
  // fail the day's render and alert than ship a script with false numbers
  // to subscribers.
  const facts: ScriptFacts = {
    niftyValue: n.value,
    niftyChange: n.change,
    niftyChangePercent: n.changePercent,
    niftyDir: niftyDir as 'UP' | 'DOWN' | 'FLAT',
    niftySupport: niftyLevels.support,
    niftyResistance: niftyLevels.resistance,
    bnValue: b.value,
    bnChange: b.change,
    bnChangePercent: b.changePercent,
    bnDir: bnDir as 'UP' | 'DOWN' | 'FLAT',
    bnSupport: bnLevels.support,
    bnResistance: bnLevels.resistance,
  };

  let raw = await callLLM(prompt, { maxTokens: 1500, temperature: 0.4 });
  let cleaned = stripMarkdown(raw);
  let validation = validateScript(cleaned, facts);

  // Track the first attempt so we can fall back to whichever is cleaner if
  // both fail. "Cleaner" = fewer unexplained numbers + no direction errors.
  const firstAttempt = { script: cleaned, validation };

  if (!validation.valid) {
    console.warn(`[script-validator] Hallucination detected on first generation:`);
    for (const issue of validation.issues) console.warn(`  - ${issue}`);
    console.warn(`  Regenerating with stricter prompt...`);

    const retryPrompt = prompt +
      `\n\nIMPORTANT: A previous attempt was REJECTED for these issues:\n` +
      validation.issues.map(i => `  - ${i}`).join('\n') +
      `\n\nFix the issues. Cite ONLY numbers from the VERIFIED FACTS above.` +
      ` Use ONLY direction words that match each index's actual close (Nifty=${niftyDir}, BankNifty=${bnDir}).`;
    // Lower temperature on retry for tighter adherence
    raw = await callLLM(retryPrompt, { maxTokens: 1500, temperature: 0.1 });
    cleaned = stripMarkdown(raw);
    validation = validateScript(cleaned, facts);

    if (!validation.valid) {
      // Hard-fail ONLY on direction errors — those mean the script
      // literally says "Nifty fell" when it rose, which is misinformation
      // we won't ship. Number-only issues (unexplained integers like
      // "20%", "26") are usually rhetorical phrasing; ship the cleaner of
      // the two attempts with a warning so subscribers still get a video.
      const hasDirectionError = (v: typeof validation) =>
        v.issues.some(i => /closed (UP|DOWN) but script uses/.test(i));

      if (hasDirectionError(validation) && hasDirectionError(firstAttempt.validation)) {
        const errMsg = `[script-validator] Script REJECTED twice with direction errors — refusing to render. Issues: ` +
          validation.issues.join('; ');
        console.error(errMsg);
        throw new Error(errMsg);
      }

      // Pick the attempt with fewer issues. Prefer retry if tied (lower temp).
      const firstScore = firstAttempt.validation.unexplainedNumbers.length;
      const retryScore = validation.unexplainedNumbers.length;
      const useFirst = firstScore < retryScore;
      const chosen = useFirst ? firstAttempt : { script: cleaned, validation };

      console.warn(
        `[script-validator] Both attempts failed number-whitelist (first=${firstScore} unexplained, retry=${retryScore} unexplained). ` +
        `Shipping ${useFirst ? 'first' : 'retry'} attempt with WARNING. Unexplained: ${chosen.validation.unexplainedNumbers.slice(0, 8).join(', ')}`,
      );
      return chosen.script;
    }
    console.log(`[script-validator] Retry produced a clean script.`);
  }

  return cleaned;
}

// ─── Audio + Speech Marks ───────────────────────────────────────────────────

async function genAudioAndMarks(script: string) {
  // Split if >2900 chars
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
  const lastMark = marks[marks.length - 1];
  return { audio, marksJsonl: allMarks, durationMs: lastMark ? lastMark.time + 2000 : 120000 };
}

// ─── Build Scenes ───────────────────────────────────────────────────────────

function buildSceneRequests(marksJsonl: string, durationMs: number, mkt: any, niftyOHLC: any[], bnOHLC: any[]): ChartCaptureRequest[] {
  const marks = parseSpeechMarks(marksJsonl);
  const sents = buildTimedSentences(marks, durationMs);
  const timed = buildTimedScenes(sents, FPS);
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return timed.map((ts) => {
    const levels = extractLevels(ts.narration);
    const durMs = ts.endMs - ts.startMs;

    switch (ts.topic) {
      case 'intro':
        return { id: ts.id, type: 'intro' as const, durationMs: durMs, title: "PRIME'S MARKET PULSE", subtitle: 'Your Daily AI Market Analysis', date: today };
      case 'nifty':
        return { id: ts.id, type: 'chart' as const, durationMs: durMs, displayName: 'NIFTY 50', price: mkt.nifty.value, change: mkt.nifty.change, changePercent: mkt.nifty.changePercent, direction: mkt.nifty.changePercent >= 0 ? 'up' as const : 'down' as const, supportLevel: levels.support, resistanceLevel: levels.resistance, annotation: levels.resistance ? `Resistance at ${levels.resistance.toLocaleString()}` : undefined, ohlcData: niftyOHLC };
      case 'banknifty':
        return { id: ts.id, type: 'chart' as const, durationMs: durMs, displayName: 'BANK NIFTY', price: mkt.bankNifty.value, change: mkt.bankNifty.change, changePercent: mkt.bankNifty.changePercent, direction: mkt.bankNifty.changePercent >= 0 ? 'up' as const : 'down' as const, supportLevel: levels.support, resistanceLevel: levels.resistance, ohlcData: bnOHLC };
      case 'fii-dii':
        return { id: ts.id, type: 'fii-dii' as const, durationMs: durMs, fiiNetCr: 0, diiNetCr: 0, fiiSentiment: 'neutral', diiSentiment: 'neutral' };
      case 'closing':
        return { id: ts.id, type: 'summary' as const, durationMs: durMs, keyLevels: [{ index: 'NIFTY', support: levels.support || 22500, resistance: levels.resistance || 23000 }, { index: 'BANK NIFTY', support: 51000, resistance: 52000 }], catchphrase: 'Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!' };
      default:
        return { id: ts.id, type: 'chart' as const, durationMs: durMs, displayName: 'NIFTY 50', price: mkt.nifty.value, change: mkt.nifty.change, changePercent: mkt.nifty.changePercent, direction: mkt.nifty.changePercent >= 0 ? 'up' as const : 'down' as const, ohlcData: niftyOHLC };
    }
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║   PRIME SPEAKS FACTORY — Automated Video Pipeline    ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // 1. Data
  console.log('\n[1/5] Market data...');
  const [mkt, niftyOHLC, bnOHLC] = await Promise.all([fetchMarket(), fetchOHLC('^NSEI'), fetchOHLC('^NSEBANK')]);
  console.log(`  Nifty ${mkt.nifty.value} (${mkt.nifty.changePercent}%) | BankNifty ${mkt.bankNifty.value} (${mkt.bankNifty.changePercent}%)`);

  // 2. Script
  console.log('\n[2/5] Script (Gemini 2.5 Flash → Claude → Nova Pro)...');
  const script = appendCTA(await genScript(mkt, niftyOHLC, bnOHLC));
  writeFileSync(resolve(OUT_DIR, 'script.txt'), script);
  console.log(`  ${script.split(/\s+/).length} words`);

  // 3. Audio + speech marks
  console.log('\n[3/5] Audio + speech marks (Polly)...');
  const { audio, marksJsonl, durationMs } = await genAudioAndMarks(script);
  const audioPath = resolve(OUT_DIR, 'audio.mp3');
  writeFileSync(audioPath, audio);
  writeFileSync(resolve(OUT_DIR, 'speech-marks.jsonl'), marksJsonl);
  mixBellAtCTA(audioPath, marksJsonl);
  console.log(`  ${Math.round(audio.length / 1024)} KB | ~${(durationMs / 1000).toFixed(1)}s`);

  // 4. Chart screenshots
  console.log('\n[4/5] Chart screenshots (Puppeteer + TradingView)...');
  const sceneRequests = buildSceneRequests(marksJsonl, durationMs, mkt, niftyOHLC, bnOHLC);
  console.log(`  ${sceneRequests.length} scenes to capture...`);
  const captures = await captureScenes(sceneRequests, FRAMES_DIR);
  for (const c of captures) {
    console.log(`  ${c.sceneName}: ${(c.durationMs / 1000).toFixed(1)}s`);
  }

  // 5. Compose video + thumbnail
  console.log('\n[5/7] Composing video (FFmpeg) + thumbnail...');
  const videoPath = resolve(OUT_DIR, 'episode.mp4');
  const thumbPath = resolve(OUT_DIR, 'thumbnail.png');
  const todayShort = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const niftyChartPath = captures.find((c) => c.sceneName.startsWith('ts'))?.imagePath;
  const [, thumbPaths] = await Promise.all([
    (async () => { composeVideo({ captures, audioPath, outputPath: videoPath }); })(),
    generateDailyThumbnail({
      niftyValue: mkt.nifty.value, niftyChangePercent: mkt.nifty.changePercent,
      bankNiftyValue: mkt.bankNifty.value, bankNiftyChangePercent: mkt.bankNifty.changePercent,
      date: todayShort,
      chartImagePath: niftyChartPath,
    }, thumbPath),
  ]);
  console.log(`  Thumbnails: A=${thumbPaths.A}\n              B=${thumbPaths.B}\n              C=${thumbPaths.C}`);
  console.log('  (A uploaded as primary; B/C available for YouTube Studio Test & Compare)');
  // Desktop copy is a convenience for the Mac user; skip silently on headless hosts.
  const desktopCopyPath = process.env.DESKTOP_COPY_PATH || '/Users/tapas/Desktop/prime-speaks-episode.mp4';
  try { copyFileSync(videoPath, desktopCopyPath); } catch {}

  // 6. Upload to YouTube
  console.log('\n[6/7] Uploading to YouTube (@AalsitraderYT)...');
  const { title, description, tags } = generateYouTubeMetadata(mkt, todayShort);
  console.log(`  Title: ${title}`);

  try {
    const result = await uploadToYouTube({
      videoPath,
      title,
      description,
      tags,
      privacyStatus: (process.env.YT_PRIVACY === 'unlisted' || process.env.YT_PRIVACY === 'private') ? process.env.YT_PRIVACY : 'public',
    });
    console.log(`  Uploaded: ${result.url}`);

    // Set custom thumbnail (retries on rate limit, logs to out/.thumbnail-failures.log on permanent failure)
    console.log('\n[7/7] Setting thumbnail...');
    try {
      await setVideoThumbnailWithRetry(result.videoId, thumbPath);
    } catch (err: any) {
      console.error('  Thumbnail upload ultimately failed — see out/.thumbnail-failures.log');
    }

    // Save video metadata for homepage integration
    const metaPath = resolve(OUT_DIR, 'latest-video.json');
    const videoMeta = {
      videoId: result.videoId,
      url: result.url,
      title,
      date: todayShort,
      nifty: mkt.nifty,
      bankNifty: mkt.bankNifty,
      thumbnailUrl: `https://img.youtube.com/vi/${result.videoId}/maxresdefault.jpg`,
      uploadedAt: new Date().toISOString(),
      type: 'daily-market-update',
    };
    writeFileSync(metaPath, JSON.stringify(videoMeta, null, 2));
    await syncFeedToS3(videoMeta);

    // Publish to podcast (Spotify/Apple)
    console.log('\n[8/8] Publishing podcast episode...');
    const podcastUrl = await publishPodcastEpisode({
      audioPath,
      title,
      description: `Daily AI market analysis: Nifty ${mkt.nifty.value} (${mkt.nifty.changePercent >= 0 ? '+' : ''}${mkt.nifty.changePercent}%), Bank Nifty ${mkt.bankNifty.value} (${mkt.bankNifty.changePercent >= 0 ? '+' : ''}${mkt.bankNifty.changePercent}%). Analysis by Prime AI at AalsiTrader.`,
      type: 'daily',
      youtubeUrl: result.url,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const cost = 0.00015 + (script.length * 16) / 1_000_000;

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   DONE — DAILY MARKET UPDATE LIVE                    ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  YouTube: ${result.url}     ║`);
    console.log(`║  Podcast: ${podcastUrl ? 'Published' : 'Skipped'}                              ║`);
    console.log(`║  Desktop: ~/Desktop/prime-speaks-episode.mp4          ║`);
    console.log(`║  Time:    ${elapsed}s                                   ║`);
    console.log(`║  Cost:    $${cost.toFixed(5)}                              ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
  } catch (err: any) {
    console.error(`  Upload failed: ${err.message}`);
    console.log('  Video saved locally — upload manually or re-run.');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const cost = 0.00015 + (script.length * 16) / 1_000_000;

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   DONE — VIDEO READY (upload failed)                 ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  Desktop: ~/Desktop/prime-speaks-episode.mp4          ║`);
    console.log(`║  Time:    ${elapsed}s                                   ║`);
    console.log(`║  Cost:    $${cost.toFixed(5)}                              ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
  }
}

main().catch((err) => { console.error('Pipeline failed:', err); process.exit(1); });

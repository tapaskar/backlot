/**
 * Prime Speaks — Full Episode Render (v2)
 *
 * Now uses Polly speech marks for perfect audio-visual sync.
 *
 * Run: npx tsx render-episode.ts
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import {
  parseSpeechMarks,
  buildTimedSentences,
  buildTimedScenes,
  extractLevels,
  type TimedScene,
} from './src/audio-sync';

const REGION = 'ap-south-1';
const FPS = 30;
const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const pollyClient = new PollyClient({ region: REGION });

const OUT_DIR = resolve(__dirname, 'out');
const PUBLIC_DIR = resolve(__dirname, 'public');

// ─── Market Data ────────────────────────────────────────────────────────────

async function fetchMarketData() {
  const symbols = [
    { key: 'nifty', symbol: '^NSEI' },
    { key: 'bankNifty', symbol: '^NSEBANK' },
    { key: 'sensex', symbol: '^BSESN' },
  ];
  const results: any = {};
  await Promise.all(
    symbols.map(async ({ key, symbol }) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = (await res.json()) as any;
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta) {
          const price = meta.regularMarketPrice || 0;
          const prev = meta.chartPreviousClose || meta.previousClose || price;
          results[key] = {
            value: Math.round(price * 100) / 100,
            change: Math.round((price - prev) * 100) / 100,
            changePercent: Math.round(((price - prev) / prev) * 10000) / 100,
          };
        } else results[key] = { value: 0, change: 0, changePercent: 0 };
      } catch { results[key] = { value: 0, change: 0, changePercent: 0 }; }
    }),
  );
  return results;
}

async function fetchOHLC(symbol: string, days = 60) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${days}d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = (await res.json()) as any;
    const r = data?.chart?.result?.[0];
    if (!r) return [];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    return ts.map((t: number, i: number) => q.open?.[i] != null ? ({
      time: new Date(t * 1000).toISOString().split('T')[0],
      open: Math.round(q.open[i] * 100) / 100,
      high: Math.round(q.high[i] * 100) / 100,
      low: Math.round(q.low[i] * 100) / 100,
      close: Math.round(q.close[i] * 100) / 100,
    }) : null).filter(Boolean);
  } catch { return []; }
}

// ─── Script Generation ──────────────────────────────────────────────────────

async function generateScript(marketData: any): Promise<string> {
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const n = marketData.nifty, b = marketData.bankNifty, s = marketData.sensex;

  const prompt = `You are Prime (Σ), the lead AI trading analyst at AalsiTrader.

Generate a 2-minute narration script for "Prime's Market Pulse".

Date: ${today}
Nifty 50: ${n.value} (${n.change >= 0 ? '+' : ''}${n.change}, ${n.changePercent}%)
Bank Nifty: ${b.value} (${b.change >= 0 ? '+' : ''}${b.change}, ${b.changePercent}%)
Sensex: ${s.value} (${s.change >= 0 ? '+' : ''}${s.change}, ${s.changePercent}%)

RULES:
1. Open with ONLY: "Namaste traders! This is Prime from AalsiTrader." — keep this first sentence short.
2. Then in SEPARATE sentences, cover Nifty with support/resistance, then Bank Nifty, then outlook.
3. Mix Hindi-English naturally. Include exact numbers.
4. Mention specific support and resistance levels for Nifty and Bank Nifty.
5. End with exactly: "Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!"
6. 350-450 words total. No markdown. Flowing spoken narration.
7. Each topic should be 2-4 sentences. Keep sentences SHORT (under 25 words each).

Output ONLY the narration.`;

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: 'apac.amazon.nova-lite-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1200, temperature: 0.7 },
    }),
  }));
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.output?.message?.content?.[0]?.text?.trim() || '';
}

// ─── Polly: Audio + Speech Marks ────────────────────────────────────────────

function splitForPolly(text: string, max = 2900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= max) { chunks.push(rem); break; }
    let at = rem.lastIndexOf('. ', max);
    if (at < max * 0.4) at = rem.lastIndexOf('! ', max);
    if (at < max * 0.4) at = max;
    else at += 1;
    chunks.push(rem.slice(0, at).trim());
    rem = rem.slice(at).trim();
  }
  return chunks;
}

async function generateAudioAndMarks(script: string) {
  const chunks = splitForPolly(script);
  const audioBuffers: Buffer[] = [];
  let allMarksJsonl = '';
  let charOffset = 0;
  let timeOffsetMs = 0;

  for (const chunk of chunks) {
    // Get audio
    const audioRes = await pollyClient.send(new SynthesizeSpeechCommand({
      Text: chunk, OutputFormat: 'mp3', VoiceId: 'Kajal', Engine: 'neural', LanguageCode: 'en-IN',
    }));
    const audioBytes = await audioRes.AudioStream!.transformToByteArray();
    audioBuffers.push(Buffer.from(audioBytes));

    // Get speech marks
    const marksRes = await pollyClient.send(new SynthesizeSpeechCommand({
      Text: chunk, OutputFormat: 'json', VoiceId: 'Kajal', Engine: 'neural', LanguageCode: 'en-IN',
      SpeechMarkTypes: ['word', 'sentence'],
    }));
    const marksBytes = await marksRes.AudioStream!.transformToByteArray();
    const marksText = new TextDecoder().decode(marksBytes);

    // Adjust offsets for multi-chunk
    const lines = marksText.trim().split('\n');
    let maxTimeInChunk = 0;
    for (const line of lines) {
      const mark = JSON.parse(line);
      mark.time += timeOffsetMs;
      mark.start += charOffset;
      mark.end += charOffset;
      if (mark.time > maxTimeInChunk) maxTimeInChunk = mark.time;
      allMarksJsonl += JSON.stringify(mark) + '\n';
    }

    charOffset += chunk.length + 1; // +1 for space between chunks
    // Estimate chunk audio duration from last word time + 1.5s buffer
    timeOffsetMs = maxTimeInChunk + 1500;
  }

  const audioBuffer = Buffer.concat(audioBuffers);

  // Estimate total duration: last mark time + 2s buffer
  const marks = parseSpeechMarks(allMarksJsonl);
  const lastMark = marks[marks.length - 1];
  const audioDurationMs = lastMark ? lastMark.time + 2000 : 120000;

  return { audioBuffer, marks: allMarksJsonl, audioDurationMs };
}

// ─── Build Timeline from Speech Marks ───────────────────────────────────────

function buildVideoTimeline(
  marksJsonl: string,
  audioDurationMs: number,
  marketData: any,
  niftyOHLC: any[],
  bankNiftyOHLC: any[],
) {
  const marks = parseSpeechMarks(marksJsonl);
  const sentences = buildTimedSentences(marks, audioDurationMs);
  const timedScenes = buildTimedScenes(sentences, FPS);

  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Convert TimedScenes → video Scene objects
  const scenes: any[] = timedScenes.map((ts) => {
    const levels = extractLevels(ts.narration);

    switch (ts.topic) {
      case 'intro':
        return {
          ...sceneBase(ts),
          type: 'intro',
          title: "PRIME'S MARKET PULSE",
          subtitle: 'Your Daily AI Market Analysis',
          date: today,
        };

      case 'nifty':
        return {
          ...sceneBase(ts),
          type: 'chart',
          symbol: '^NSEI',
          displayName: 'NIFTY 50',
          price: marketData.nifty.value,
          change: marketData.nifty.change,
          changePercent: marketData.nifty.changePercent,
          direction: marketData.nifty.changePercent >= 0 ? 'up' : 'down',
          supportLevel: levels.support,
          resistanceLevel: levels.resistance,
          annotation: levels.resistance ? `Resistance at ${levels.resistance.toLocaleString()}` : undefined,
          ohlcData: niftyOHLC,
        };

      case 'banknifty':
        return {
          ...sceneBase(ts),
          type: 'chart',
          symbol: '^NSEBANK',
          displayName: 'BANK NIFTY',
          price: marketData.bankNifty.value,
          change: marketData.bankNifty.change,
          changePercent: marketData.bankNifty.changePercent,
          direction: marketData.bankNifty.changePercent >= 0 ? 'up' : 'down',
          supportLevel: levels.support,
          resistanceLevel: levels.resistance,
          ohlcData: bankNiftyOHLC,
        };

      case 'sensex':
        return {
          ...sceneBase(ts),
          type: 'chart',
          symbol: '^BSESN',
          displayName: 'SENSEX',
          price: marketData.sensex.value,
          change: marketData.sensex.change,
          changePercent: marketData.sensex.changePercent,
          direction: marketData.sensex.changePercent >= 0 ? 'up' : 'down',
          ohlcData: niftyOHLC, // proxy
        };

      case 'fii-dii':
        return {
          ...sceneBase(ts),
          type: 'fii-dii',
          fiiNetCr: 0, diiNetCr: 0, fiiSentiment: 'neutral', diiSentiment: 'neutral',
        };

      case 'closing':
        return {
          ...sceneBase(ts),
          type: 'summary',
          outlook: ts.narration,
          keyLevels: [
            { index: 'NIFTY', support: levels.support || 22500, resistance: levels.resistance || 23000 },
            { index: 'BANK NIFTY', support: 51000, resistance: 52000 },
          ],
          catchphrase: 'Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!',
        };

      default: // outlook → show Nifty chart as background
        return {
          ...sceneBase(ts),
          type: 'chart',
          symbol: '^NSEI',
          displayName: 'MARKET OUTLOOK',
          price: marketData.nifty.value,
          change: marketData.nifty.change,
          changePercent: marketData.nifty.changePercent,
          direction: marketData.nifty.changePercent >= 0 ? 'up' : 'down',
          ohlcData: niftyOHLC,
        };
    }
  });

  const totalFrames = scenes.length > 0
    ? scenes[scenes.length - 1].startFrame + scenes[scenes.length - 1].durationFrames
    : 0;

  return {
    totalDurationFrames: totalFrames,
    totalDurationSeconds: Math.ceil(totalFrames / FPS),
    fps: FPS,
    scenes,
  };
}

function sceneBase(ts: TimedScene) {
  return {
    id: ts.id,
    narration: ts.narration,
    startFrame: ts.startFrame,
    durationFrames: ts.durationFrames,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PRIME SPEAKS v2 — Speech-Mark Synced Pipeline');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Market data + OHLC
  console.log('\n[1/5] Fetching market data + OHLC...');
  const [marketData, niftyOHLC, bankNiftyOHLC] = await Promise.all([
    fetchMarketData(),
    fetchOHLC('^NSEI', 60),
    fetchOHLC('^NSEBANK', 60),
  ]);
  console.log(`  Nifty: ${marketData.nifty.value} (${marketData.nifty.changePercent}%) | ${niftyOHLC.length} bars`);
  console.log(`  BankNifty: ${marketData.bankNifty.value} (${marketData.bankNifty.changePercent}%) | ${bankNiftyOHLC.length} bars`);

  // Step 2: Generate script
  console.log('\n[2/5] Generating script (Nova Lite)...');
  const t1 = Date.now();
  const script = await generateScript(marketData);
  console.log(`  ${script.split(/\s+/).length} words in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  writeFileSync(resolve(OUT_DIR, 'script.txt'), script);

  // Step 3: Audio + speech marks
  console.log('\n[3/5] Generating audio + speech marks (Polly)...');
  const t2 = Date.now();
  const { audioBuffer, marks: marksJsonl, audioDurationMs } = await generateAudioAndMarks(script);
  const audioPath = resolve(PUBLIC_DIR, 'episode-audio.mp3');
  writeFileSync(audioPath, audioBuffer);
  writeFileSync(resolve(OUT_DIR, 'speech-marks.jsonl'), marksJsonl);
  console.log(`  Audio: ${Math.round(audioBuffer.length / 1024)} KB, ~${(audioDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Speech marks: ${marksJsonl.trim().split('\n').length} entries`);
  console.log(`  Done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  // Step 4: Build timeline from speech marks
  console.log('\n[4/5] Building synced timeline...');
  const timeline = buildVideoTimeline(marksJsonl, audioDurationMs, marketData, niftyOHLC, bankNiftyOHLC);
  console.log(`  ${timeline.scenes.length} scenes, ${timeline.totalDurationSeconds}s total`);
  for (const s of timeline.scenes) {
    const startSec = (s.startFrame / FPS).toFixed(1);
    const durSec = (s.durationFrames / FPS).toFixed(1);
    console.log(`    [${startSec}s +${durSec}s] ${s.type}: ${s.narration?.slice(0, 60)}...`);
  }

  const timelinePath = resolve(PUBLIC_DIR, 'timeline.json');
  writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));

  const propsPath = resolve(OUT_DIR, 'input-props.json');
  writeFileSync(propsPath, JSON.stringify({ timeline, audioUrl: 'episode-audio.mp3' }));

  // Step 5: Render video
  console.log('\n[5/5] Rendering video (Remotion)...');
  const videoPath = resolve(OUT_DIR, 'episode.mp4');

  try {
    execSync(
      `npx remotion render MarketPulse "${videoPath}" --props="${propsPath}" --concurrency=4`,
      { cwd: __dirname, stdio: 'inherit', timeout: 300_000 },
    );

    copyFileSync(videoPath, '/Users/tapas/Desktop/prime-speaks-episode.mp4');
    copyFileSync(audioPath, '/Users/tapas/Desktop/prime-speaks-episode.mp3');
    console.log('\n  Copied to Desktop: prime-speaks-episode.mp4');
  } catch (err: any) {
    console.error(`\n  Render failed: ${err.message}`);
    console.log('  Timeline + audio saved — render manually:');
    console.log(`  npx remotion render MarketPulse "${videoPath}" --props="${propsPath}"`);
  }

  // Cost
  const scriptCost = 0.00015;
  const audioCost = (script.length * 16) / 1_000_000;
  console.log(`\n  Cost: $${(scriptCost + audioCost).toFixed(5)} | Monthly: $${((scriptCost + audioCost) * 30).toFixed(3)}`);
}

main().catch(console.error);

/**
 * Spoken CTA + bell SFX, appended to every Prime Speaks video.
 *
 * Why this exists: the visual "LIKE | SUBSCRIBE" pill in the outro frame
 * never converts on its own — viewers stop watching before the outro hits
 * the screen. Prime has to ASK verbally for likes & subs, and a short
 * bell ding at that moment draws the eye back to the screen.
 *
 * Pipeline integration:
 *   1. Before Polly synthesis, append the CTA_TAIL to the script via
 *      `appendCTA(script)`. Polly speaks it as part of one continuous
 *      audio file.
 *   2. After Polly, call `mixBellAtCTA(audioPath, marksJsonl)` to overlay
 *      the bell sound at the timestamp where the CTA starts. The function
 *      no-ops gracefully if the bell asset is missing or the timestamp
 *      can't be found.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

/**
 * The spoken CTA. Kept short on purpose (~3 sentences / ~25 words / ~8s
 * @ Polly Kajal neural pace) so it doesn't compete with the day's
 * analysis content. The opening "If you found this useful" is the cue
 * we search for in speech marks to time the bell overlay.
 */
export const CTA_TAIL =
  "If you found this useful, hit the like button below and subscribe to " +
  "Aalsi Trader for daily market deep dives. Thanks for watching — " +
  "see you in the next one.";

/**
 * The first content word of CTA_TAIL. We scan speech marks for this token
 * to locate the bell-overlay timestamp. "If" is reasonably distinctive at
 * the END of a market analysis — if Polly happens to emit "If" earlier in
 * the script, we still pick the LAST occurrence which will be ours.
 */
export const CTA_FIRST_WORD = 'If';

/** Path to the bell SFX, generated once on the publishing machine. */
export const BELL_PATH = resolve(__dirname, 'assets', 'sfx', 'bell.mp3');

/**
 * Append the CTA to a script with a sentence-break separator so Polly
 * takes a natural breath before the call-to-action.
 */
export function appendCTA(script: string): string {
  const trimmed = script.trim();
  const sep = /[.!?]$/.test(trimmed) ? ' ' : '. ';
  return `${trimmed}${sep}${CTA_TAIL}`;
}

/**
 * Find the timestamp (ms) where the CTA verbal starts inside a Polly
 * speech-marks JSONL stream. Returns -1 if not found.
 *
 * Polly emits one JSON-per-line for each word, e.g.:
 *   {"time":12345,"type":"word","start":456,"end":458,"value":"If"}
 * We pick the LAST occurrence of CTA_FIRST_WORD — the main script may
 * also contain "If" but the CTA we appended is guaranteed to be the
 * final one.
 */
export function findCTAStartMs(marksJsonl: string): number {
  let lastIfMs = -1;
  for (const line of marksJsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as { type?: string; value?: string; time?: number };
      if (m.type === 'word' && m.value === CTA_FIRST_WORD && typeof m.time === 'number') {
        lastIfMs = m.time;
      }
    } catch {
      // Skip malformed lines — Polly's JSONL is normally well-formed.
    }
  }
  return lastIfMs;
}

/**
 * Mix the bell SFX into the audio at the CTA timestamp. Modifies the
 * file at audioPath in-place via ffmpeg. No-op (returns false with a
 * console warning) if the bell asset is missing or the CTA timestamp
 * can't be located — never throws, so a missing SFX doesn't block uploads.
 */
export function mixBellAtCTA(audioPath: string, marksJsonl: string): boolean {
  if (!existsSync(BELL_PATH)) {
    console.warn(`[cta] bell SFX missing at ${BELL_PATH} — skipping bell overlay`);
    return false;
  }
  const ctaMs = findCTAStartMs(marksJsonl);
  if (ctaMs < 0) {
    console.warn(`[cta] CTA timestamp not found in speech marks — skipping bell overlay`);
    return false;
  }
  // Place the bell ~200ms BEFORE the spoken CTA so the ding lands while
  // Prime is taking the breath, not under her first word.
  const bellMs = Math.max(0, ctaMs - 200);
  const tmpOut = audioPath.replace(/\.mp3$/, '.cta-mixed.mp3');
  try {
    // -y overwrite; adelay shifts the bell to the right time; amix blends
    // both streams at their respective gain. Bell at 0.35 keeps it audible
    // without burying Prime's voice.
    execSync(
      `ffmpeg -y -i "${audioPath}" -i "${BELL_PATH}" ` +
        `-filter_complex "[1:a]adelay=${bellMs}|${bellMs},volume=0.35[bell];[0:a][bell]amix=inputs=2:duration=first:dropout_transition=0" ` +
        `-c:a libmp3lame -q:a 4 "${tmpOut}" 2>&1`,
      { stdio: 'pipe' }
    );
    execSync(`mv "${tmpOut}" "${audioPath}"`);
    console.log(`[cta] bell mixed at ${bellMs}ms (CTA starts at ${ctaMs}ms)`);
    return true;
  } catch (err: any) {
    console.warn(`[cta] bell overlay failed: ${err?.message?.slice(0, 200) || err}`);
    return false;
  }
}

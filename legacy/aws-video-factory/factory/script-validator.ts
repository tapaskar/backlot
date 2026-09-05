/**
 * Script hallucination validator for video narration.
 *
 * The pipeline prompts the LLM with "VERIFIED FACTS — do not invent numbers"
 * and "direction words must match" — but compliance is on the model, not
 * enforced. This validator runs AFTER the LLM returns and rejects scripts
 * that contradict the facts, so a hallucination can be caught and the model
 * re-asked rather than reaching subscribers' ears.
 *
 * Two checks:
 *   1. Direction integrity — if facts say Nifty closed UP and the script
 *      uses "fell"/"selloff"/"declined", reject.
 *   2. Number integrity — every numeric token in the script must either
 *      (a) exactly match an approved fact value, or
 *      (b) round-match an approved value (within ±0.5% — covers narration
 *          paraphrase like "around 22,500" when the fact is 22,567).
 *      Exempt: years (4-digit 19xx/20xx), single-digit small ints (1-10
 *      used as ordinals/counts), percentage symbols.
 *
 * Returns { valid, issues } so the caller can choose to regenerate, log, or
 * fall back to a deterministic template script.
 */

export interface ScriptFacts {
  niftyValue: number;
  niftyChange: number;
  niftyChangePercent: number;
  niftyDir: 'UP' | 'DOWN' | 'FLAT';
  niftySupport: number;
  niftyResistance: number;

  bnValue: number;
  bnChange: number;
  bnChangePercent: number;
  bnDir: 'UP' | 'DOWN' | 'FLAT';
  bnSupport: number;
  bnResistance: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  // Numbers we found in the script that don't match any approved fact.
  // Useful for telemetry — repeated patterns may indicate prompt issues.
  unexplainedNumbers: number[];
}

/**
 * Generic per-symbol direction expectation, used by validateGeneric for
 * earnings/thematic/render-episode pipelines that aren't NIFTY+BANK NIFTY only.
 *
 * `aliases` is an array of regex-friendly substrings that identify mentions
 * of this symbol in the script (e.g. ["INFY", "Infosys"], ["TCS", "Tata Consultancy"]).
 * `direction` is the verified close direction. `null` means skip direction
 * check for this symbol (data unknown / range-bound day).
 */
export interface SymbolDirection {
  aliases: string[];
  direction: 'UP' | 'DOWN' | 'FLAT' | null;
}

/**
 * Generic numeric whitelist + per-symbol direction validator.
 * Use this in any pipeline that builds a verified-facts dossier and feeds it
 * to the LLM. Daily pipeline keeps using validateScript() for backwards
 * compat; new pipelines should call validateGeneric().
 */
export function validateGeneric(
  script: string,
  approvedNums: number[],
  symbols: SymbolDirection[] = [],
): ValidationResult {
  const issues: string[] = [];
  const unexplainedNumbers: number[] = [];

  // Build approved set from raw numbers + their rounded variants
  const approved = new Set<number>();
  for (const v of approvedNums) {
    if (!Number.isFinite(v)) continue;
    const abs = Math.abs(v);
    approved.add(abs);
    approved.add(Math.round(abs));
    approved.add(Math.round(abs / 10) * 10);
    approved.add(Math.round(abs / 50) * 50);
    approved.add(Math.round(abs / 100) * 100);
    if (abs > 1000) approved.add(Math.round(abs / 500) * 500);
    if (abs < 100 && abs > 0) approved.add(+abs.toFixed(1));
  }

  // Per-symbol direction integrity
  for (const sym of symbols) {
    if (!sym.direction || sym.direction === 'FLAT') continue;
    const aliasPattern = sym.aliases.map(escapeForRegex).join('|');
    if (!aliasPattern) continue;
    const sentenceRe = new RegExp(`[^.!?\\n]*\\b(${aliasPattern})\\b[^.!?\\n]*[.!?\\n]`, 'gi');
    const sentences = script.match(sentenceRe) || [];
    for (const sent of sentences) {
      const usesUp = hasAnyWord(sent, UP_WORDS);
      const usesDown = hasAnyWord(sent, DOWN_WORDS);
      if (sym.direction === 'UP' && usesDown && !usesUp) {
        issues.push(`${sym.aliases[0]} closed UP but script uses down-direction word: "${sent.trim().slice(0, 100)}"`);
      } else if (sym.direction === 'DOWN' && usesUp && !usesDown) {
        issues.push(`${sym.aliases[0]} closed DOWN but script uses up-direction word: "${sent.trim().slice(0, 100)}"`);
      }
    }
  }

  // Number whitelist
  const found = extractNumbers(script);
  for (const n of found) {
    if (!isApproved(n, approved)) {
      unexplainedNumbers.push(n);
    }
  }
  if (unexplainedNumbers.length > 0) {
    issues.push(
      `Script cites ${unexplainedNumbers.length} number(s) not in verified facts: ` +
      unexplainedNumbers.slice(0, 8).join(', ') +
      (unexplainedNumbers.length > 8 ? `, +${unexplainedNumbers.length - 8} more` : '')
    );
  }

  return { valid: issues.length === 0, issues, unexplainedNumbers };
}

const UP_WORDS = [
  'rallied', 'rally', 'gained', 'gain', 'rose', 'up', 'higher', 'climbed', 'jumped',
  'surged', 'advanced', 'positive', 'green', 'bullish', 'closed up', 'closed higher',
  'tezi', 'badha', 'oopar',
];
const DOWN_WORDS = [
  'fell', 'fall', 'lost', 'declined', 'down', 'lower', 'dropped', 'tumbled', 'slumped',
  'plunged', 'retreated', 'negative', 'red', 'bearish', 'closed down', 'closed lower',
  'mandi', 'gira', 'neeche',
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnyWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(w => new RegExp(`\\b${escapeForRegex(w)}\\b`, 'i').test(lower));
}

/**
 * Approved-numbers set — the only numerics the LLM is allowed to cite.
 * We include both the raw value and likely paraphrased forms (rounded to
 * nearest 10/50/100/500) since narration says "around 22,500" when the
 * actual close is 22,567.
 */
function approvedNumbers(f: ScriptFacts): Set<number> {
  const s = new Set<number>();
  const candidates = [
    f.niftyValue, f.niftyChange, f.niftyChangePercent, f.niftySupport, f.niftyResistance,
    f.bnValue, f.bnChange, f.bnChangePercent, f.bnSupport, f.bnResistance,
  ];
  for (const v of candidates) {
    if (!Number.isFinite(v)) continue;
    const abs = Math.abs(v);
    s.add(abs);
    // Round-match equivalents (any reasonable paraphrase rounding)
    s.add(Math.round(abs));
    s.add(Math.round(abs / 10) * 10);
    s.add(Math.round(abs / 50) * 50);
    s.add(Math.round(abs / 100) * 100);
    if (abs > 1000) s.add(Math.round(abs / 500) * 500);
    // For percentages: also include 1-decimal-place form
    if (abs < 100 && abs > 0) s.add(+abs.toFixed(1));
  }
  return s;
}

/**
 * Extract numeric tokens from script text. Recognizes:
 *   - Plain integers / decimals: 22867, 22.5, 1.5
 *   - Comma-separated: 22,867 → 22867
 *   - Percentages: "2.4%" → 2.4
 *   - Skips: 4-digit years (1900-2099), single small ints used in lists
 */
// Standard market-speak constants that the LLM emits without any
// today-specific claim attached (e.g. "Nifty 50", "200 EMA", "20-period
// RSI"). Without this skip list, the validator rejected every May 5–11
// script for citing "50, 20, 20" — purely terminology, no factual claim.
// Anything <100 that ISN'T followed by % or ₹/lakh/cr suffix is generally
// safe to ignore; we list the specific market-period values explicitly so
// the intent is documented.
const STANDARD_MARKET_CONSTANTS = new Set<number>([
  9, 12, 14, 20, 26, 30, 50, 100, 200,
]);

// Round percentage thresholds the LLM uses rhetorically — "up to 50%
// chance", "20% retracement target", "10% drawdown" — these are
// characterizations, not specific factual claims about today's data.
// Without this skip list, every script gets rejected for "20%", "50%".
// We accept these ONLY when they appear with the `%` suffix (the bare
// integers are already handled by STANDARD_MARKET_CONSTANTS above).
const STANDARD_PERCENT_THRESHOLDS = new Set<number>([
  1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100,
]);

// Common date-of-month integers (1-31) — the LLM may say "26 May" or
// "May 26". We already skip 1-10 via the list-ordinal rule; here we
// extend it to 11-31 when the number appears NEAR a month name in the
// surrounding context. Cheaper than month-name proximity check: just
// allow all small integers (≤31) without a financial suffix.
function isLikelyDateOfMonth(n: number, suffix: string): boolean {
  return Number.isInteger(n) && n >= 11 && n <= 31 && !suffix;
}

function extractNumbers(script: string): number[] {
  const out: number[] = [];
  // Match number patterns including commas + optional decimal + optional %/currency
  // Capture trailing %, "lakh", "cr", "crore", "₹" so we can decide whether the
  // bare integer is a factual claim or pure terminology.
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|lakh|crore|cr|₹|rupees?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const intPart = m[1].replace(/,/g, '');
    const decPart = m[2] || '';
    const suffix = (m[3] || '').toLowerCase();
    const numStr = decPart ? `${intPart}.${decPart}` : intPart;
    const n = parseFloat(numStr);
    if (!Number.isFinite(n)) continue;

    // Skip 4-digit years (1900-2099)
    if (Number.isInteger(n) && n >= 1900 && n <= 2099) continue;
    // Skip very small single-digit list ordinals ("1.", "2.", "3.")
    if (Number.isInteger(n) && n >= 1 && n <= 10 && !decPart) continue;
    // Skip standard market terminology (Nifty 50, 200 EMA, 20-period RSI...)
    // when the number has no financial suffix.
    if (Number.isInteger(n) && !decPart && !suffix && STANDARD_MARKET_CONSTANTS.has(n)) continue;
    // Skip round percentage thresholds used rhetorically ("up to 50%",
    // "20% retracement"). Only round integers (no decimal) with `%` suffix.
    if (Number.isInteger(n) && !decPart && suffix === '%' && STANDARD_PERCENT_THRESHOLDS.has(n)) continue;
    // Skip likely day-of-month integers (11-31) with no suffix —
    // "26 May", "May 22", etc. Lists 1-10 already skipped above.
    if (isLikelyDateOfMonth(n, suffix)) continue;

    out.push(n);
  }
  return out;
}

/** Within ±0.5% of any approved value — covers paraphrase rounding. */
function isApproved(n: number, approved: Set<number>): boolean {
  if (approved.has(n)) return true;
  // Check rounded variants
  if (approved.has(Math.round(n))) return true;
  if (approved.has(Math.round(n / 10) * 10)) return true;
  // Tolerance check against each approved value (Array.from sidesteps the
  // older project tsconfig's downlevelIteration restriction on Set<number>).
  const arr = Array.from(approved);
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a === 0) continue;
    if (Math.abs(n - a) / Math.abs(a) <= 0.005) return true;
  }
  return false;
}

export function validateScript(script: string, facts: ScriptFacts): ValidationResult {
  const issues: string[] = [];
  const unexplainedNumbers: number[] = [];

  // ─── Direction integrity ─────────────────────────────────────────────────
  // Walk sentence-by-sentence so a sentence about Nifty and one about Bank
  // Nifty don't poison each other.
  //
  // Classification rule: a sentence is "Bank Nifty" if it contains the phrase
  // "bank nifty" / "banknifty". A sentence is "Nifty" if it contains "nifty"
  // BUT NOT "bank nifty". This avoids the prior bug where the lookahead-only
  // regex (`/nifty(?!\s*bank)/i`) classified "Bank Nifty was UP" as a Nifty
  // sentence because the "Nifty" suffix isn't followed by "bank" — making the
  // validator scream every day Nifty and Bank Nifty closed in opposite
  // directions.
  const isBnSentence = (s: string) => /bank\s*nifty|banknifty/i.test(s);
  const isNiftySentence = (s: string) => /nifty/i.test(s) && !isBnSentence(s);

  const allSentences = script.split(/[.!?\n]+/);
  const niftySentences = allSentences.filter(isNiftySentence);
  const bnSentences = allSentences.filter(isBnSentence);

  if (niftySentences.length > 0) {
    const expectedUp = facts.niftyDir === 'UP';
    const expectedDown = facts.niftyDir === 'DOWN';
    for (const sent of niftySentences) {
      const usesUp = hasAnyWord(sent, UP_WORDS);
      const usesDown = hasAnyWord(sent, DOWN_WORDS);
      if (expectedUp && usesDown && !usesUp) {
        issues.push(`Nifty closed UP but script uses down-direction word: "${sent.trim().slice(0, 100)}"`);
      } else if (expectedDown && usesUp && !usesDown) {
        issues.push(`Nifty closed DOWN but script uses up-direction word: "${sent.trim().slice(0, 100)}"`);
      }
    }
  }

  if (bnSentences.length > 0) {
    const expectedUp = facts.bnDir === 'UP';
    const expectedDown = facts.bnDir === 'DOWN';
    for (const sent of bnSentences) {
      const usesUp = hasAnyWord(sent, UP_WORDS);
      const usesDown = hasAnyWord(sent, DOWN_WORDS);
      if (expectedUp && usesDown && !usesUp) {
        issues.push(`Bank Nifty closed UP but script uses down-direction word: "${sent.trim().slice(0, 100)}"`);
      } else if (expectedDown && usesUp && !usesDown) {
        issues.push(`Bank Nifty closed DOWN but script uses up-direction word: "${sent.trim().slice(0, 100)}"`);
      }
    }
  }

  // ─── Number integrity ────────────────────────────────────────────────────
  const approved = approvedNumbers(facts);
  const found = extractNumbers(script);
  for (const n of found) {
    if (!isApproved(n, approved)) {
      unexplainedNumbers.push(n);
    }
  }
  if (unexplainedNumbers.length > 0) {
    issues.push(
      `Script cites ${unexplainedNumbers.length} number(s) not in verified facts: ` +
      unexplainedNumbers.slice(0, 8).join(', ') +
      (unexplainedNumbers.length > 8 ? `, +${unexplainedNumbers.length - 8} more` : '')
    );
  }

  return { valid: issues.length === 0, issues, unexplainedNumbers };
}

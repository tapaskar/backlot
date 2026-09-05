/**
 * LLM dispatcher: Gemini → Claude → Nova Pro
 *
 * Order of preference:
 *   1. Gemini 2.5 Flash (Google AI Studio) — cheapest, best Hindi/Hinglish, free tier
 *      covers >500 requests/day. No AWS Marketplace dependency.
 *   2. Claude 3.7 Sonnet (Bedrock) — best at constraint following; uses the
 *      apac-region inference profile which has a long-standing Marketplace
 *      agreement on this account. Resilient to newer-model payment hiccups
 *      (Haiku 4.5 / Sonnet 4 require fresh agreements that fail if the AWS
 *      payment instrument lapses; 3.7 Sonnet keeps working).
 *   3. Nova Pro (Bedrock) — last-resort fallback. Amazon-native, no
 *      Marketplace dependency. Always works on AWS-credentialed boxes.
 *
 * All three accept the same plain prompt; only the request envelope differs.
 *
 * Override the model with env vars:
 *   GEMINI_API_KEY — REQUIRED, provide via env / Secret Manager (never hardcode)
 *   GEMINI_MODEL   — e.g. "gemini-2.5-flash-lite" for even cheaper
 *   CLAUDE_MODEL_ID — override the Bedrock Claude model (e.g. swap back to
 *                     global.anthropic.claude-haiku-4-5-20251001-v1:0 once
 *                     the Marketplace agreement is restored)
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION || 'ap-south-1';
const bedrock = new BedrockRuntimeClient({ region: REGION });

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export async function callGemini(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts?.temperature ?? 0.4,
      maxOutputTokens: opts?.maxTokens ?? 4000,
      // Disable Gemini 2.5's "thinking" mode — saves latency and tokens; the
      // pre-computed VERIFIED FACTS in our prompts already do the heavy lifting.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Retry transient errors (429 rate-limit, 500/503 server-side spikes).
  const maxAttempts = 3;
  const backoffMs = [1500, 4000, 8000];
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) {
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        throw new Error(`Gemini returned empty content: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return text.trim();
    }
    const errBody = await res.text();
    lastErr = new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    // Only retry transient classes; fail fast on 4xx auth/quota/invalid errors
    const transient = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!transient || attempt === maxAttempts - 1) throw lastErr;
    await new Promise((r) => setTimeout(r, backoffMs[attempt]));
  }
  throw lastErr || new Error('Gemini retry loop exhausted');
}

// Default to Claude 3.7 Sonnet — its Marketplace agreement on this account
// is established and not blocked by INVALID_PAYMENT_INSTRUMENT (unlike the
// newer Haiku 4.5 / Sonnet 4 inference profiles which require a fresh
// agreement that fails when AWS billing has a hiccup).
const CLAUDE_MODEL_ID =
  process.env.CLAUDE_MODEL_ID || 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0';

export async function callClaude(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: CLAUDE_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: opts?.maxTokens ?? 3000,
        temperature: opts?.temperature ?? 0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  );
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return (body.content?.[0]?.text || '').trim();
}

// Backwards-compat alias so existing imports keep working.
export const callClaudeHaiku = callClaude;

export async function callNovaPro(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: 'apac.amazon.nova-pro-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: opts?.maxTokens ?? 3000, temperature: opts?.temperature ?? 0.4 },
      }),
    })
  );
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return (body.output?.message?.content?.[0]?.text || '').trim();
}

// Set SKIP_CLAUDE=1 in the environment to bypass Claude entirely — used when
// the AWS Marketplace agreement is in a known-broken state (e.g. payment
// instrument failure) so we don't burn 3-5 seconds per call waiting for a
// guaranteed AccessDeniedException. Set the flag in /opt/aalsi-video/.env
// during an outage; clear it once the agreement is healthy again.
const SKIP_CLAUDE = process.env.SKIP_CLAUDE === '1' || process.env.SKIP_CLAUDE === 'true';

// Process-level self-healing flag: once Claude returns
// INVALID_PAYMENT_INSTRUMENT, skip it for the remainder of this process so
// retries in the same run (e.g. script-validator regenerate) don't pay the
// failure latency twice. Reset on every new process invocation.
let _claudePaymentBroken = false;

function isPaymentInstrumentError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return msg.includes('INVALID_PAYMENT_INSTRUMENT') || msg.includes('aws-marketplace:Subscribe');
}

export async function callLLM(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
  // 1. Gemini 2.5 Flash — primary
  try {
    return await callGemini(prompt, opts);
  } catch (err: any) {
    const next = SKIP_CLAUDE || _claudePaymentBroken ? 'Nova Pro' : 'Claude';
    console.log(`  (Gemini unavailable — ${String(err?.message || err).slice(0, 120)}; trying ${next})`);
  }

  // 2. Claude — secondary (skipped if user set SKIP_CLAUDE or we already
  // learned in this process that the Marketplace agreement is broken)
  if (!SKIP_CLAUDE && !_claudePaymentBroken) {
    try {
      return await callClaude(prompt, opts);
    } catch (err: any) {
      if (isPaymentInstrumentError(err)) {
        _claudePaymentBroken = true;
        console.log(`  (Claude blocked by Marketplace payment instrument — skipping Claude for the rest of this run; falling back to Nova Pro)`);
      } else {
        console.log(`  (Claude unavailable — ${String(err?.message || err).slice(0, 120)}; falling back to Nova Pro)`);
      }
    }
  }

  // 3. Nova Pro — last resort
  return await callNovaPro(prompt, opts);
}

/**
 * Strip markdown so the TTS engine doesn't read asterisks or hashes literally.
 * Claude obeys "no markdown" rules; Nova Pro and Gemini sometimes leak headings.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/gm, '') // ATX headings: ## Heading
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** → bold
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1') // *italic* → italic
    .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullet markers
    .replace(/`([^`]+)`/g, '$1') // `code` → code
    .replace(/\n{3,}/g, '\n\n') // collapse big gaps
    .trim();
}

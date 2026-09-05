/**
 * Audio Sync — Polly Speech Marks driven scene timing
 *
 * Gets exact word/sentence timestamps from Polly, then maps sentences
 * to scene types using keyword matching. No AI classification needed.
 */

export interface SpeechMark {
  time: number;       // milliseconds from audio start
  type: 'word' | 'sentence';
  start: number;      // character offset in text
  end: number;
  value: string;
}

export interface TimedSentence {
  text: string;
  startMs: number;
  endMs: number;       // start of next sentence, or audio end
  topic: SceneTopic;
  words: SpeechMark[];
}

export type SceneTopic = 'intro' | 'nifty' | 'banknifty' | 'sensex' | 'fii-dii' | 'outlook' | 'closing';

export interface TimedScene {
  id: string;
  topic: SceneTopic;
  startMs: number;
  endMs: number;
  startFrame: number;
  durationFrames: number;
  sentences: TimedSentence[];
  narration: string;
}

/**
 * Parse Polly speech marks JSONL into structured objects.
 */
export function parseSpeechMarks(jsonl: string): SpeechMark[] {
  return jsonl
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SpeechMark);
}

/**
 * Classify a sentence by topic using keyword matching.
 * Fast, deterministic, free — no AI call needed.
 *
 * Uses previousTopic for S/R sentences and continuations that don't
 * explicitly name an index (e.g. "Resistance 22800 par hai").
 */
function classifySentence(text: string, index: number, total: number, previousTopic: SceneTopic): SceneTopic {
  const lower = text.toLowerCase();

  // First two sentences are intro (greeting + "This is Prime from AalsiTrader")
  if (index === 0) return 'intro';
  if (index === 1 && (lower.includes('prime') || lower.includes('aalsitrader') || lower.includes('aalsi trader'))) return 'intro';

  // Closing: catchphrase or last sentence
  if (lower.includes('aalsi rahein') || lower.includes('data bolta hai') || lower.includes('milte hain')) return 'closing';
  if (index >= total - 1) return 'closing';
  // Second-to-last + last are both closing if near end
  if (index >= total - 2 && (lower.includes('patience') || lower.includes('yaad rakhna') || lower.includes('invest karein'))) return 'closing';

  // Specific index mentions — Bank Nifty first (to avoid "Nifty" matching in "Bank Nifty")
  if (lower.includes('bank nifty') || lower.includes('banknifty')) return 'banknifty';
  if (lower.includes('nifty 50') || lower.includes('nifty ') || lower.includes('nifty,') || lower.includes('nifty.') || lower.includes('nifty ke')) return 'nifty';
  if (lower.includes('sensex')) return 'sensex';

  // FII/DII
  if (lower.includes('fii') || lower.includes('dii') || lower.includes('institutional') || lower.includes('foreign')) return 'fii-dii';

  // Outlook keywords
  if (lower.includes('kal') || lower.includes('tomorrow') || lower.includes('outlook') || lower.includes('aage')) return 'outlook';

  // S/R or continuation sentences: inherit previous topic
  // "Resistance 22800 par hai" → still talking about whatever index was before
  if (lower.includes('support') || lower.includes('resistance') || lower.includes('level')) return previousTopic;

  // General market/investor sentences inherit previous if it was an index
  if (['nifty', 'banknifty', 'sensex'].includes(previousTopic)) {
    if (lower.includes('gain') || lower.includes('volume') || lower.includes('momentum') || lower.includes('technical') || lower.includes('indicator') || lower.includes('uppar') || lower.includes('neeche') || lower.includes('positive') || lower.includes('negative')) {
      return previousTopic;
    }
  }

  // If previous was an index topic and this is a continuation, keep it
  if (['nifty', 'banknifty', 'sensex'].includes(previousTopic) && !lower.includes('ab aate') && !lower.includes('now let')) {
    return previousTopic;
  }

  return 'outlook';
}

/**
 * Build timed sentences from speech marks.
 * Groups word marks under their parent sentence.
 */
export function buildTimedSentences(marks: SpeechMark[], audioDurationMs: number): TimedSentence[] {
  const sentenceMarks = marks.filter((m) => m.type === 'sentence');
  const wordMarks = marks.filter((m) => m.type === 'word');

  const sentences: TimedSentence[] = [];
  let previousTopic: SceneTopic = 'intro';

  for (let i = 0; i < sentenceMarks.length; i++) {
    const sent = sentenceMarks[i];
    const nextSent = sentenceMarks[i + 1];
    const endMs = nextSent ? nextSent.time : audioDurationMs;

    // Collect words belonging to this sentence (by character range)
    const words = wordMarks.filter((w) => w.start >= sent.start && w.end <= sent.end);

    const topic = classifySentence(sent.value, i, sentenceMarks.length, previousTopic);
    sentences.push({
      text: sent.value,
      startMs: sent.time,
      endMs,
      topic,
      words,
    });
    previousTopic = topic;
  }

  return sentences;
}

/**
 * Group consecutive sentences with the same topic into scenes.
 * This creates natural scene boundaries driven by what Prime is talking about.
 *
 * Rules:
 * - Intro scene: max 5 seconds (first sentence only, even if classified as intro)
 * - Merge consecutive same-topic sentences
 * - Minimum scene duration: 3 seconds
 * - Closing scene: last sentence(s)
 */
export function buildTimedScenes(sentences: TimedSentence[], fps: number): TimedScene[] {
  if (sentences.length === 0) return [];

  const scenes: TimedScene[] = [];
  let currentGroup: TimedSentence[] = [sentences[0]];
  let currentTopic = sentences[0].topic;

  for (let i = 1; i < sentences.length; i++) {
    const sent = sentences[i];

    // Force scene break when topic changes
    if (sent.topic !== currentTopic) {
      // Flush current group as a scene
      scenes.push(groupToScene(currentGroup, currentTopic, scenes.length, fps));
      currentGroup = [sent];
      currentTopic = sent.topic;
    } else {
      currentGroup.push(sent);
    }
  }

  // Flush remaining
  if (currentGroup.length > 0) {
    scenes.push(groupToScene(currentGroup, currentTopic, scenes.length, fps));
  }

  return scenes;
}

function groupToScene(
  sentences: TimedSentence[],
  topic: SceneTopic,
  index: number,
  fps: number,
): TimedScene {
  const startMs = sentences[0].startMs;
  const endMs = sentences[sentences.length - 1].endMs;
  const startFrame = Math.round((startMs / 1000) * fps);
  const durationFrames = Math.max(fps, Math.round(((endMs - startMs) / 1000) * fps)); // min 1 second

  return {
    id: `scene-${index}`,
    topic,
    startMs,
    endMs,
    startFrame,
    durationFrames,
    sentences,
    narration: sentences.map((s) => s.text).join(' '),
  };
}

/**
 * Extract support/resistance levels mentioned in a scene's narration.
 */
export function extractLevels(narration: string): { support?: number; resistance?: number } {
  const lower = narration.toLowerCase();
  let support: number | undefined;
  let resistance: number | undefined;

  // Match patterns like "support 22500", "support level 22,500", "support at 22500"
  const supportMatch = lower.match(/support\s*(?:level\s*)?(?:(?:at|of|ka|ke|par)\s*)?(\d[\d,]*)/);
  if (supportMatch) support = parseInt(supportMatch[1].replace(/,/g, ''), 10);

  // Match patterns like "resistance 23000", "resistance level 23,000"
  const resistanceMatch = lower.match(/resistance\s*(?:level\s*)?(?:(?:at|of|ka|ke|par)\s*)?(\d[\d,]*)/);
  if (resistanceMatch) resistance = parseInt(resistanceMatch[1].replace(/,/g, ''), 10);

  return { support, resistance };
}

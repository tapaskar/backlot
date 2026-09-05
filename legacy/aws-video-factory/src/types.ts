/**
 * Scene types shared between backend scene parser and Remotion renderer.
 */

export type SceneType = 'intro' | 'chart' | 'fii-dii' | 'signal' | 'summary';

export interface SceneTimeline {
  totalDurationFrames: number;
  totalDurationSeconds: number;
  fps: number;
  scenes: Scene[];
}

export type Scene = IntroScene | ChartScene | FIIDIIScene | SignalScene | SummaryScene;

interface BaseScene {
  id: string;
  type: SceneType;
  narration: string;
  startFrame: number;
  durationFrames: number;
  durationSeconds: number;
}

export interface IntroScene extends BaseScene {
  type: 'intro';
  title: string;
  subtitle: string;
  date: string;
}

export interface ChartScene extends BaseScene {
  type: 'chart';
  symbol: string;
  displayName: string;
  price: number;
  change: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
  supportLevel?: number;
  resistanceLevel?: number;
  annotation?: string;
  ohlcData?: OHLCBar[];
}

export interface FIIDIIScene extends BaseScene {
  type: 'fii-dii';
  fiiNetCr: number;
  diiNetCr: number;
  fiiSentiment: string;
  diiSentiment: string;
}

export interface SignalScene extends BaseScene {
  type: 'signal';
  signals: Array<{
    symbol: string;
    signal: 'BUY' | 'SELL' | 'NEUTRAL';
    structure: string;
    price: number;
    rsi: number;
  }>;
}

export interface SummaryScene extends BaseScene {
  type: 'summary';
  outlook: string;
  keyLevels: Array<{ index: string; support: number; resistance: number }>;
  catchphrase: string;
}

export interface OHLCBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface EpisodeProps {
  timeline: SceneTimeline;
  audioUrl?: string;
}

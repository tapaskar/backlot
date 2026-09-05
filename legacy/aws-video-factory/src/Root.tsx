import React from 'react';
import { Composition } from 'remotion';
import { MarketPulse } from './MarketPulse';
import type { SceneTimeline } from './types';

// Default timeline for Remotion Studio preview
const defaultTimeline: SceneTimeline = {
  totalDurationFrames: 4200, // ~140 seconds at 30fps
  totalDurationSeconds: 140,
  fps: 30,
  scenes: [
    {
      id: 'scene-0',
      type: 'intro',
      narration: 'Namaste traders!',
      startFrame: 0,
      durationFrames: 300,
      durationSeconds: 10,
      title: "PRIME'S MARKET PULSE",
      subtitle: 'Your Daily AI Market Analysis',
      date: 'Tuesday, April 1, 2026',
    },
    {
      id: 'scene-1',
      type: 'chart',
      narration: 'Nifty 50 aaj 22,867 par band hua...',
      startFrame: 300,
      durationFrames: 900,
      durationSeconds: 30,
      symbol: '^NSEI',
      displayName: 'NIFTY 50',
      price: 22867.85,
      change: 536.45,
      changePercent: 2.4,
      direction: 'up',
      supportLevel: 22500,
      resistanceLevel: 23000,
      annotation: 'Broke 22,500 resistance',
      ohlcData: [],
    },
    {
      id: 'scene-2',
      type: 'chart',
      narration: 'Bank Nifty bhi aaj 51,845 par settle hua...',
      startFrame: 1200,
      durationFrames: 750,
      durationSeconds: 25,
      symbol: '^NSEBANK',
      displayName: 'BANK NIFTY',
      price: 51845.05,
      change: 1569.7,
      changePercent: 3.12,
      direction: 'up',
      supportLevel: 51000,
      resistanceLevel: 52000,
      ohlcData: [],
    },
    {
      id: 'scene-3',
      type: 'fii-dii',
      narration: 'FIIs ne aaj buying kari...',
      startFrame: 1950,
      durationFrames: 750,
      durationSeconds: 25,
      fiiNetCr: 2450.5,
      diiNetCr: 1230.8,
      fiiSentiment: 'buying',
      diiSentiment: 'buying',
    },
    {
      id: 'scene-4',
      type: 'signal',
      narration: 'Smart Money Screener se kuch signals...',
      startFrame: 2700,
      durationFrames: 750,
      durationSeconds: 25,
      signals: [
        { symbol: 'RELIANCE', signal: 'BUY', structure: 'BOS_BULLISH', price: 2890, rsi: 58.2 },
        { symbol: 'TATASTEEL', signal: 'BUY', structure: 'CHOCH_BULLISH', price: 156.4, rsi: 42.5 },
        { symbol: 'HDFCBANK', signal: 'SELL', structure: 'BOS_BEARISH', price: 1650, rsi: 72.1 },
      ],
    },
    {
      id: 'scene-5',
      type: 'summary',
      narration: 'Kal ka outlook dekhte hain...',
      startFrame: 3450,
      durationFrames: 750,
      durationSeconds: 25,
      outlook: 'Positive sentiment likely to continue tomorrow',
      keyLevels: [
        { index: 'NIFTY', support: 22500, resistance: 23000 },
        { index: 'BANK NIFTY', support: 51000, resistance: 52000 },
      ],
      catchphrase: 'Data bolta hai, hum sunte hain. Aalsi rahein, smart rahein!',
    },
  ],
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketPulse"
        component={MarketPulse}
        durationInFrames={defaultTimeline.totalDurationFrames}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          timeline: defaultTimeline,
          audioUrl: undefined,
        }}
      />
    </>
  );
};

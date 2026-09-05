import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { ChartScene as ChartSceneType } from '../types';
import { CandlestickChart } from '../components/CandlestickChart';
import { PriceTag } from '../components/PriceTag';
import { LowerThird } from '../components/LowerThird';

export const ChartSceneView: React.FC<{ scene: ChartSceneType }> = ({ scene }) => {
  return (
    <AbsoluteFill
      style={{
        background: '#0f172a',
      }}
    >
      {/* Price info */}
      <PriceTag
        displayName={scene.displayName}
        price={scene.price}
        change={scene.change}
        changePercent={scene.changePercent}
        direction={scene.direction}
      />

      {/* Chart area */}
      <div
        style={{
          position: 'absolute',
          top: 160,
          left: 40,
          right: 40,
          bottom: 140,
        }}
      >
        <CandlestickChart
          data={scene.ohlcData || []}
          width={1840}
          height={680}
          supportLevel={scene.supportLevel}
          resistanceLevel={scene.resistanceLevel}
          annotation={scene.annotation}
          direction={scene.direction}
        />
      </div>

      {/* Lower third */}
      <LowerThird
        title={`PRIME'S MARKET PULSE`}
        subtitle={scene.displayName}
      />
    </AbsoluteFill>
  );
};

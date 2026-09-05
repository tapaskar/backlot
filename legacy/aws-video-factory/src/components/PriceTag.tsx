import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

interface PriceTagProps {
  displayName: string;
  price: number;
  change: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
}

export const PriceTag: React.FC<PriceTagProps> = ({
  displayName,
  price,
  change,
  changePercent,
  direction,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const slideDown = interpolate(frame, [0, 15], [-30, 0], { extrapolateRight: 'clamp' });

  const color = direction === 'up' ? '#22c55e' : direction === 'down' ? '#ef4444' : '#94a3b8';
  const arrow = direction === 'up' ? '\u25B2' : direction === 'down' ? '\u25BC' : '';
  const sign = change >= 0 ? '+' : '';

  return (
    <div
      style={{
        position: 'absolute',
        top: 40,
        left: 60,
        opacity,
        transform: `translateY(${slideDown}px)`,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <span
          style={{
            color: '#f8fafc',
            fontSize: 42,
            fontWeight: 800,
            fontFamily: 'system-ui',
            letterSpacing: '-1px',
          }}
        >
          {displayName}
        </span>
        <span style={{ color: '#64748b', fontSize: 24, fontFamily: 'system-ui' }}>
          Daily Chart
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
        <span
          style={{
            color: '#f8fafc',
            fontSize: 56,
            fontWeight: 800,
            fontFamily: 'system-ui',
            letterSpacing: '-2px',
          }}
        >
          {price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
        </span>
        <span style={{ color, fontSize: 32, fontWeight: 700, fontFamily: 'system-ui' }}>
          {arrow} {sign}{change.toFixed(2)} ({sign}{changePercent.toFixed(2)}%)
        </span>
      </div>
    </div>
  );
};

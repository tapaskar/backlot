import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { SignalScene as SignalSceneType } from '../types';
import { LowerThird } from '../components/LowerThird';

export const SignalSceneView: React.FC<{ scene: SignalSceneType }> = ({ scene }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ background: '#0f172a' }}>
      {/* Title */}
      <div style={{ position: 'absolute', top: 60, left: 60 }}>
        <span
          style={{
            color: '#f8fafc',
            fontSize: 48,
            fontWeight: 800,
            fontFamily: 'system-ui',
            letterSpacing: '-1px',
          }}
        >
          Smart Money Signals
        </span>
      </div>

      {/* Signal cards */}
      <div
        style={{
          position: 'absolute',
          top: 180,
          left: 60,
          right: 60,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {scene.signals.map((sig, i) => {
          const cardOpacity = interpolate(frame, [10 + i * 12, 22 + i * 12], [0, 1], {
            extrapolateRight: 'clamp',
          });
          const slideX = interpolate(frame, [10 + i * 12, 22 + i * 12], [40, 0], {
            extrapolateRight: 'clamp',
          });

          const signalColor =
            sig.signal === 'BUY' ? '#22c55e' : sig.signal === 'SELL' ? '#ef4444' : '#64748b';

          return (
            <div
              key={sig.symbol}
              style={{
                opacity: cardOpacity,
                transform: `translateX(${slideX}px)`,
                background: 'rgba(30, 41, 59, 0.8)',
                borderRadius: 16,
                padding: '28px 40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                border: `1px solid ${signalColor}44`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                {/* Signal badge */}
                <div
                  style={{
                    background: signalColor,
                    padding: '8px 20px',
                    borderRadius: 8,
                    fontSize: 22,
                    fontWeight: 800,
                    color: '#fff',
                    fontFamily: 'system-ui',
                    minWidth: 80,
                    textAlign: 'center',
                  }}
                >
                  {sig.signal}
                </div>
                {/* Symbol */}
                <span
                  style={{
                    color: '#f8fafc',
                    fontSize: 36,
                    fontWeight: 700,
                    fontFamily: 'system-ui',
                  }}
                >
                  {sig.symbol}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 48, alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ color: '#64748b', fontSize: 16, fontFamily: 'system-ui' }}>
                    Price
                  </span>
                  <span
                    style={{ color: '#f8fafc', fontSize: 28, fontWeight: 700, fontFamily: 'system-ui' }}
                  >
                    {'\u20B9'}{sig.price.toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ color: '#64748b', fontSize: 16, fontFamily: 'system-ui' }}>
                    RSI
                  </span>
                  <span
                    style={{
                      color: sig.rsi > 70 ? '#ef4444' : sig.rsi < 30 ? '#22c55e' : '#f8fafc',
                      fontSize: 28,
                      fontWeight: 700,
                      fontFamily: 'system-ui',
                    }}
                  >
                    {sig.rsi.toFixed(1)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ color: '#64748b', fontSize: 16, fontFamily: 'system-ui' }}>
                    Structure
                  </span>
                  <span
                    style={{ color: signalColor, fontSize: 20, fontWeight: 600, fontFamily: 'system-ui' }}
                  >
                    {sig.structure.replace('_', ' ')}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <LowerThird title="PRIME'S MARKET PULSE" subtitle="Smart Money Screener" />
    </AbsoluteFill>
  );
};

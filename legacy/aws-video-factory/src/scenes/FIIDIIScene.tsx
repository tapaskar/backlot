import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { FIIDIIScene as FIIDIISceneType } from '../types';
import { LowerThird } from '../components/LowerThird';

export const FIIDIISceneView: React.FC<{ scene: FIIDIISceneType }> = ({ scene }) => {
  const frame = useCurrentFrame();

  const barMaxHeight = 400;
  const maxVal = Math.max(Math.abs(scene.fiiNetCr), Math.abs(scene.diiNetCr), 1);

  const fiiHeight = (Math.abs(scene.fiiNetCr) / maxVal) * barMaxHeight;
  const diiHeight = (Math.abs(scene.diiNetCr) / maxVal) * barMaxHeight;

  const fiiAnimated = interpolate(frame, [10, 40], [0, fiiHeight], { extrapolateRight: 'clamp' });
  const diiAnimated = interpolate(frame, [20, 50], [0, diiHeight], { extrapolateRight: 'clamp' });
  const labelOpacity = interpolate(frame, [30, 45], [0, 1], { extrapolateRight: 'clamp' });

  const fiiColor = scene.fiiNetCr >= 0 ? '#22c55e' : '#ef4444';
  const diiColor = scene.diiNetCr >= 0 ? '#22c55e' : '#ef4444';

  return (
    <AbsoluteFill style={{ background: '#0f172a' }}>
      {/* Title */}
      <div
        style={{
          position: 'absolute',
          top: 60,
          left: 60,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <span
          style={{
            color: '#f8fafc',
            fontSize: 48,
            fontWeight: 800,
            fontFamily: 'system-ui',
            letterSpacing: '-1px',
          }}
        >
          FII / DII Flows
        </span>
        <span style={{ color: '#64748b', fontSize: 24, fontFamily: 'system-ui' }}>
          Net Institutional Activity (in Crores)
        </span>
      </div>

      {/* Bar chart */}
      <div
        style={{
          position: 'absolute',
          top: 200,
          left: 0,
          right: 0,
          bottom: 160,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          gap: 200,
          paddingBottom: 80,
        }}
      >
        {/* FII Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ opacity: labelOpacity, color: fiiColor, fontSize: 36, fontWeight: 800, fontFamily: 'system-ui' }}>
            {scene.fiiNetCr >= 0 ? '+' : ''}{'\u20B9'}{scene.fiiNetCr.toLocaleString()} Cr
          </div>
          <div
            style={{
              width: 180,
              height: fiiAnimated,
              background: `linear-gradient(180deg, ${fiiColor}cc, ${fiiColor})`,
              borderRadius: '12px 12px 4px 4px',
              boxShadow: `0 0 30px ${fiiColor}44`,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#f8fafc', fontSize: 28, fontWeight: 700, fontFamily: 'system-ui' }}>
              FII / FPI
            </span>
            <span
              style={{
                color: fiiColor,
                fontSize: 20,
                fontWeight: 600,
                fontFamily: 'system-ui',
                textTransform: 'uppercase',
                letterSpacing: '2px',
              }}
            >
              {scene.fiiSentiment}
            </span>
          </div>
        </div>

        {/* DII Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ opacity: labelOpacity, color: diiColor, fontSize: 36, fontWeight: 800, fontFamily: 'system-ui' }}>
            {scene.diiNetCr >= 0 ? '+' : ''}{'\u20B9'}{scene.diiNetCr.toLocaleString()} Cr
          </div>
          <div
            style={{
              width: 180,
              height: diiAnimated,
              background: `linear-gradient(180deg, ${diiColor}cc, ${diiColor})`,
              borderRadius: '12px 12px 4px 4px',
              boxShadow: `0 0 30px ${diiColor}44`,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#f8fafc', fontSize: 28, fontWeight: 700, fontFamily: 'system-ui' }}>
              DII
            </span>
            <span
              style={{
                color: diiColor,
                fontSize: 20,
                fontWeight: 600,
                fontFamily: 'system-ui',
                textTransform: 'uppercase',
                letterSpacing: '2px',
              }}
            >
              {scene.diiSentiment}
            </span>
          </div>
        </div>
      </div>

      <LowerThird title="PRIME'S MARKET PULSE" subtitle="Institutional Flows" />
    </AbsoluteFill>
  );
};

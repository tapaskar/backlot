import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { IntroScene as IntroSceneType } from '../types';

export const IntroSceneView: React.FC<{ scene: IntroSceneType }> = ({ scene }) => {
  const frame = useCurrentFrame();

  const titleScale = interpolate(frame, [0, 20], [0.8, 1], { extrapolateRight: 'clamp' });
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const subtitleOpacity = interpolate(frame, [10, 25], [0, 1], { extrapolateRight: 'clamp' });
  const dateOpacity = interpolate(frame, [20, 35], [0, 1], { extrapolateRight: 'clamp' });
  const lineWidth = interpolate(frame, [15, 40], [0, 400], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
      }}
    >
      {/* Logo/Brand */}
      <div
        style={{
          fontSize: 28,
          color: '#10b981',
          fontWeight: 700,
          fontFamily: 'system-ui',
          letterSpacing: '4px',
          textTransform: 'uppercase',
          opacity: titleOpacity,
        }}
      >
        AALSITRADER
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 72,
          color: '#f8fafc',
          fontWeight: 800,
          fontFamily: 'system-ui',
          textAlign: 'center',
          letterSpacing: '-2px',
          transform: `scale(${titleScale})`,
          opacity: titleOpacity,
        }}
      >
        {scene.title}
      </div>

      {/* Animated line */}
      <div
        style={{
          width: lineWidth,
          height: 3,
          background: 'linear-gradient(90deg, transparent, #10b981, transparent)',
          borderRadius: 2,
        }}
      />

      {/* Subtitle */}
      <div
        style={{
          fontSize: 32,
          color: '#94a3b8',
          fontFamily: 'system-ui',
          opacity: subtitleOpacity,
        }}
      >
        {scene.subtitle}
      </div>

      {/* Date */}
      <div
        style={{
          fontSize: 24,
          color: '#64748b',
          fontFamily: 'system-ui',
          opacity: dateOpacity,
          marginTop: 16,
        }}
      >
        {scene.date}
      </div>

      {/* Prime badge */}
      <div
        style={{
          position: 'absolute',
          bottom: 60,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          opacity: dateOpacity,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: '#10b981',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            fontWeight: 800,
            color: '#fff',
            fontFamily: 'system-ui',
          }}
        >
          {'\u03A3'}
        </div>
        <span style={{ color: '#94a3b8', fontSize: 20, fontFamily: 'system-ui' }}>
          Powered by Prime AI
        </span>
      </div>
    </AbsoluteFill>
  );
};

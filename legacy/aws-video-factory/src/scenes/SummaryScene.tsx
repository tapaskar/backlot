import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { SummaryScene as SummarySceneType } from '../types';

export const SummarySceneView: React.FC<{ scene: SummarySceneType }> = ({ scene }) => {
  const frame = useCurrentFrame();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const levelsOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateRight: 'clamp' });
  const catchphraseOpacity = interpolate(frame, [40, 55], [0, 1], { extrapolateRight: 'clamp' });
  const catchphraseScale = interpolate(frame, [40, 55], [0.9, 1], { extrapolateRight: 'clamp' });

  // CTA: fades in during the last ~6 seconds (180 frames at 30fps) of the
  // 750-frame summary scene. Pulses gently to draw attention without being
  // obnoxious. Visual only — no narration change so we don't have to
  // regenerate Polly audio across the back catalog.
  const CTA_FADE_START = 540; // 18s into the scene
  const CTA_FADE_END = 600;   // fully visible by 20s
  const ctaOpacity = interpolate(frame, [CTA_FADE_START, CTA_FADE_END], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // Gentle pulse on the icons after fade-in completes (~once per second)
  const ctaPulse = 1 + 0.05 * Math.sin(((frame - CTA_FADE_END) / 30) * Math.PI);

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontSize: 42,
          color: '#f8fafc',
          fontWeight: 800,
          fontFamily: 'system-ui',
          opacity: titleOpacity,
          letterSpacing: '-1px',
        }}
      >
        KEY LEVELS TO WATCH
      </div>

      {/* Levels table */}
      <div
        style={{
          display: 'flex',
          gap: 60,
          opacity: levelsOpacity,
        }}
      >
        {scene.keyLevels.map((level) => (
          <div
            key={level.index}
            style={{
              background: 'rgba(30, 41, 59, 0.8)',
              borderRadius: 16,
              padding: '32px 48px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 20,
              border: '1px solid #334155',
            }}
          >
            <span
              style={{
                color: '#f8fafc',
                fontSize: 32,
                fontWeight: 700,
                fontFamily: 'system-ui',
              }}
            >
              {level.index}
            </span>
            <div style={{ display: 'flex', gap: 40 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#3b82f6', fontSize: 18, fontFamily: 'system-ui', fontWeight: 600 }}>
                  SUPPORT
                </span>
                <span style={{ color: '#3b82f6', fontSize: 36, fontWeight: 800, fontFamily: 'system-ui' }}>
                  {level.support.toLocaleString()}
                </span>
              </div>
              <div
                style={{
                  width: 1,
                  background: '#334155',
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#f97316', fontSize: 18, fontFamily: 'system-ui', fontWeight: 600 }}>
                  RESISTANCE
                </span>
                <span style={{ color: '#f97316', fontSize: 36, fontWeight: 800, fontFamily: 'system-ui' }}>
                  {level.resistance.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Catchphrase */}
      <div
        style={{
          fontSize: 36,
          color: '#10b981',
          fontWeight: 700,
          fontFamily: 'system-ui',
          fontStyle: 'italic',
          opacity: catchphraseOpacity,
          transform: `scale(${catchphraseScale})`,
          textAlign: 'center',
          maxWidth: 900,
          lineHeight: 1.4,
        }}
      >
        "{scene.catchphrase}"
      </div>

      {/* CTA banner — last ~6s. "Like + Subscribe" call-to-action overlay
          for YouTube viewers. Stacks above the brand strip. Pulses gently to
          draw attention. Visual only — narration not changed. */}
      <div
        style={{
          position: 'absolute',
          bottom: 130,
          background: 'rgba(220, 38, 38, 0.95)',
          padding: '14px 32px',
          borderRadius: 999,
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          opacity: ctaOpacity,
          boxShadow: '0 8px 32px rgba(220, 38, 38, 0.4)',
          border: '2px solid rgba(255, 255, 255, 0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, transform: `scale(${ctaPulse})` }}>
          <span style={{ fontSize: 28 }}>👍</span>
          <span style={{ color: '#ffffff', fontSize: 22, fontWeight: 800, fontFamily: 'system-ui', letterSpacing: '0.5px' }}>LIKE</span>
        </div>
        <div style={{ width: 1, height: 28, background: 'rgba(255, 255, 255, 0.4)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, transform: `scale(${ctaPulse})` }}>
          <span style={{ fontSize: 28 }}>🔔</span>
          <span style={{ color: '#ffffff', fontSize: 22, fontWeight: 800, fontFamily: 'system-ui', letterSpacing: '0.5px' }}>SUBSCRIBE</span>
        </div>
      </div>

      {/* Brand */}
      <div
        style={{
          position: 'absolute',
          bottom: 50,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          opacity: catchphraseOpacity,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            background: '#10b981',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 800,
            color: '#fff',
            fontFamily: 'system-ui',
          }}
        >
          {'\u03A3'}
        </div>
        <span style={{ color: '#64748b', fontSize: 22, fontFamily: 'system-ui' }}>
          aalsitrader.com
        </span>
      </div>
    </AbsoluteFill>
  );
};

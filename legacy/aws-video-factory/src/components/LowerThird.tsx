import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

interface LowerThirdProps {
  title: string;
  subtitle?: string;
}

export const LowerThird: React.FC<LowerThirdProps> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();

  const slideIn = interpolate(frame, [0, 15], [100, 0], {
    extrapolateRight: 'clamp',
  });

  const opacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 60,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '0 60px',
        transform: `translateX(${slideIn}px)`,
        opacity,
      }}
    >
      <div
        style={{
          background: 'linear-gradient(90deg, #10b981 0%, #10b981cc 70%, transparent 100%)',
          padding: '12px 24px',
          borderRadius: '4px 4px 0 0',
          display: 'inline-block',
          alignSelf: 'flex-start',
        }}
      >
        <span style={{ color: '#fff', fontSize: 28, fontWeight: 700, fontFamily: 'system-ui' }}>
          {title}
        </span>
      </div>
      {subtitle && (
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.9)',
            padding: '8px 24px',
            borderRadius: '0 0 4px 4px',
            display: 'inline-block',
            alignSelf: 'flex-start',
          }}
        >
          <span style={{ color: '#94a3b8', fontSize: 20, fontFamily: 'system-ui' }}>
            {subtitle}
          </span>
        </div>
      )}
    </div>
  );
};

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

interface TransitionProps {
  durationFrames: number;
  children: React.ReactNode;
}

/**
 * Wraps a scene with fade-in at start and fade-out at end.
 */
export const SceneTransition: React.FC<TransitionProps> = ({ durationFrames, children }) => {
  const frame = useCurrentFrame();
  const fadeInFrames = 6;   // ~0.2s — fast entry
  const fadeOutFrames = 6;  // ~0.2s — fast exit

  const opacity = Math.min(
    interpolate(frame, [0, fadeInFrames], [0, 1], { extrapolateRight: 'clamp' }),
    interpolate(frame, [durationFrames - fadeOutFrames, durationFrames], [1, 0], { extrapolateLeft: 'clamp' }),
  );

  return (
    <AbsoluteFill style={{ opacity }}>
      {children}
    </AbsoluteFill>
  );
};

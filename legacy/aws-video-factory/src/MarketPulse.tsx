import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import type { EpisodeProps, Scene } from './types';
import { IntroSceneView } from './scenes/IntroScene';
import { ChartSceneView } from './scenes/ChartScene';
import { FIIDIISceneView } from './scenes/FIIDIIScene';
import { SignalSceneView } from './scenes/SignalScene';
import { SummarySceneView } from './scenes/SummaryScene';
import { SceneTransition } from './components/Transition';

const SceneRenderer: React.FC<{ scene: Scene }> = ({ scene }) => {
  switch (scene.type) {
    case 'intro':
      return <IntroSceneView scene={scene} />;
    case 'chart':
      return <ChartSceneView scene={scene} />;
    case 'fii-dii':
      return <FIIDIISceneView scene={scene} />;
    case 'signal':
      return <SignalSceneView scene={scene} />;
    case 'summary':
      return <SummarySceneView scene={scene} />;
    default:
      return null;
  }
};

export const MarketPulse: React.FC<EpisodeProps> = ({ timeline, audioUrl }) => {
  const resolvedAudioUrl = audioUrl
    ? (audioUrl.startsWith('http') ? audioUrl : staticFile(audioUrl))
    : undefined;

  return (
    <AbsoluteFill style={{ background: '#0f172a' }}>
      {timeline.scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationFrames}
          name={`${scene.type}-${scene.id}`}
        >
          <SceneTransition durationFrames={scene.durationFrames}>
            <SceneRenderer scene={scene} />
          </SceneTransition>
        </Sequence>
      ))}

      {resolvedAudioUrl && (
        <Audio src={resolvedAudioUrl} />
      )}
    </AbsoluteFill>
  );
};

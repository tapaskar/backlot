/**
 * Video Compose — FFmpeg pipeline to stitch chart screenshots + audio into MP4
 *
 * Takes: scene images (PNG) + audio (MP3) + timing data
 * Outputs: 1080p MP4 with crossfade transitions
 */

import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import type { ChartCapture } from './chart-capture';

export interface ComposeOptions {
  captures: ChartCapture[];
  audioPath: string;
  outputPath: string;
  fps?: number;
  transitionDurationMs?: number;
}

/**
 * Compose final video using FFmpeg.
 *
 * Strategy:
 * 1. Convert each scene image → video clip of correct duration
 * 2. Concatenate clips with crossfade transitions
 * 3. Mix in the audio track
 * 4. Output as H.264 MP4
 */
export function composeVideo(options: ComposeOptions): void {
  const { captures, audioPath, outputPath, fps = 30, transitionDurationMs = 300 } = options;
  const transitionSec = transitionDurationMs / 1000;

  if (captures.length === 0) throw new Error('No captures to compose');

  const tmpDir = resolve(outputPath, '..', 'tmp-ffmpeg');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  // Step 1: Create individual video clips from each image
  const clipPaths: string[] = [];
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i];
    const clipPath = resolve(tmpDir, `clip-${i}.mp4`);
    const durationSec = Math.max(0.5, cap.durationMs / 1000);

    execSync(
      `ffmpeg -y -loop 1 -i "${cap.imagePath}" -c:v libx264 -t ${durationSec} ` +
      `-pix_fmt yuv420p -vf "scale=1920:1080,fps=${fps}" -preset ultrafast ` +
      `-tune stillimage "${clipPath}"`,
      { stdio: 'pipe' },
    );
    clipPaths.push(clipPath);
  }

  // Step 2: Build FFmpeg complex filter for crossfade transitions
  if (clipPaths.length === 1) {
    // Single clip — just add audio
    execSync(
      `ffmpeg -y -i "${clipPaths[0]}" -i "${audioPath}" ` +
      `-c:v libx264 -c:a aac -b:a 192k -shortest -preset fast "${outputPath}"`,
      { stdio: 'pipe' },
    );
  } else {
    // Multiple clips — use xfade for transitions
    const inputs = clipPaths.map((p) => `-i "${p}"`).join(' ');

    // Build xfade filter chain
    // [0][1]xfade=transition=fade:duration=0.3:offset=X[v1]; [v1][2]xfade=...[v2]; ...
    let filterParts: string[] = [];
    let prevLabel = '0:v';
    let cumulativeOffset = 0;

    for (let i = 1; i < clipPaths.length; i++) {
      const prevDuration = captures[i - 1].durationMs / 1000;
      cumulativeOffset += prevDuration - transitionSec;
      const outLabel = i === clipPaths.length - 1 ? 'vout' : `v${i}`;

      filterParts.push(
        `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${transitionSec}:offset=${cumulativeOffset.toFixed(3)}[${outLabel}]`
      );
      prevLabel = outLabel;
    }

    const filterComplex = filterParts.join('; ');

    execSync(
      `ffmpeg -y ${inputs} -i "${audioPath}" ` +
      `-filter_complex "${filterComplex}" ` +
      `-map "[vout]" -map "${clipPaths.length}:a" ` +
      `-c:v libx264 -c:a aac -b:a 192k -preset ultrafast -shortest ` +
      `-pix_fmt yuv420p "${outputPath}"`,
      // 30 min ceiling — long-form thematic videos (5–8 min runtime) take
      // ~3–6 min on a t3a.large with ultrafast preset; if there's CPU
      // contention from another pipeline running in parallel they can take
      // 2–3× longer. YouTube re-encodes anyway so ultrafast is fine.
      { stdio: 'pipe', timeout: 1800000 },
    );
  }

  // Cleanup temp clips
  for (const p of clipPaths) {
    try { execSync(`rm "${p}"`, { stdio: 'pipe' }); } catch {}
  }
  try { execSync(`rmdir "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
}

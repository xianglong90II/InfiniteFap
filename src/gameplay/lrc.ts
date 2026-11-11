import type { Beat } from '../types';

export function formatLrcTimestamp(time: number): string {
  const centiseconds = Math.max(0, Math.round(time * 100));
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const fraction = centiseconds % 100;
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}]`;
}

export function beatsToLrc(beats: Beat[]): string {
  return [...beats]
    .sort((a, b) => a.time - b.time)
    .map((beat) => `${formatLrcTimestamp(beat.time)}${beat.strength}`)
    .join('\n');
}

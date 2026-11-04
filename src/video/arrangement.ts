import type { Note } from '../types';
import type { VideoClip } from './sceneDetection';

export type VideoSource = { id: string; clips: VideoClip[] };
export type ArrangementItem = { start: number; end: number; mediaId: string; clip: VideoClip };

export function findFirstIntervalEndingAfter<T extends { end: number }>(items: T[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].end <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function shouldInitializeVideoSync(previousKey: string | undefined, nextKey: string): boolean {
  return previousKey !== nextKey;
}

export function getClipPlaybackTime(playbackStart: number, videoDuration: number, arrangementStart: number, playhead: number): number {
  return Math.min(Math.max(0, videoDuration - 0.01), playbackStart + Math.max(0, playhead - arrangementStart));
}

export function buildVideoArrangement(
  notes: Note[],
  videos: VideoSource[],
  duration: number,
  minClipLength: number,
): ArrangementItem[] {
  const clips = videos.flatMap((video) => video.clips.map((clip) => ({ mediaId: video.id, clip })));
  if (!duration || clips.length === 0) return [];
  const starts = [0];
  let lastStart = 0;
  for (const note of notes) {
    if (note.time - lastStart >= minClipLength && note.time < duration) {
      starts.push(note.time);
      lastStart = note.time;
    }
  }
  let previousClipIndex = -1;
  return starts.map((start, index) => {
    const nextClipIndex = clips.length > 1 ? (previousClipIndex + 1) % clips.length : 0;
    previousClipIndex = nextClipIndex;
    return {
      start,
      end: starts[index + 1] ?? duration,
      mediaId: clips[nextClipIndex].mediaId,
      clip: clips[nextClipIndex].clip,
    };
  });
}

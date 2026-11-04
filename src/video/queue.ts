import type { VideoClip } from './sceneDetection';

export type QueueClip = { mediaId: string; clip: VideoClip };
export type RandomizationMode = 'ordered' | 'grouped' | 'all' | 'motion';
export type ClipStartMode = 'middle' | 'random' | 'custom';

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function randomizeQueue<T extends QueueClip>(clips: T[], mode: RandomizationMode, random: () => number = Math.random): T[] {
  if (mode === 'ordered') return [...clips];
  if (mode === 'all') return shuffled(clips, random);
  if (mode === 'motion') return [...clips].sort((a, b) => b.clip.motion - a.clip.motion);
  const groups = new Map<string, T[]>();
  for (const item of clips) groups.set(item.mediaId, [...(groups.get(item.mediaId) ?? []), item]);
  return shuffled([...groups.values()], random).flat();
}

export function isShortClip(clip: VideoClip, threshold: number): boolean {
  return clip.end - clip.start < threshold;
}

export function getClipPlaybackRange(clip: VideoClip, mode: ClipStartMode, customPosition: number, transitionDuration: number, random: () => number = Math.random): { start: number; end: number } {
  const duration = Math.max(0, clip.end - clip.start);
  if (duration <= transitionDuration) return { start: clip.start, end: clip.end };
  const end = clip.end - transitionDuration;
  const playableDuration = end - clip.start;
  const lastStart = Math.max(clip.start, end - Math.min(0.1, playableDuration));
  const position = mode === 'middle' ? 0.5 : mode === 'random' ? random() : Math.max(0, Math.min(1, customPosition));
  const start = clip.start + (lastStart - clip.start) * position;
  return { start, end };
}

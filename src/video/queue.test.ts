import { describe, expect, it } from 'vitest';
import { getClipPlaybackRange, isShortClip, randomizeQueue, seededRandom, type QueueClip } from './queue';

const clips: QueueClip[] = [
  { mediaId: 'a', clip: { id: 'a1', start: 0, end: 1, thumbnail: '', motion: 0.1 } },
  { mediaId: 'a', clip: { id: 'a2', start: 1, end: 2, thumbnail: '', motion: 0.7 } },
  { mediaId: 'b', clip: { id: 'b1', start: 0, end: 1, thumbnail: '', motion: 0.9 } },
  { mediaId: 'b', clip: { id: 'b2', start: 1, end: 2, thumbnail: '', motion: 0.2 } },
];

describe('randomizeQueue', () => {
  it('shuffles source groups while keeping clips from each video together', () => {
    const result = randomizeQueue(clips, 'grouped', () => 0);
    expect(result.map(({ clip }) => clip.id)).toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  it('can shuffle every selected clip independently', () => {
    const result = randomizeQueue(clips, 'all', () => 0);
    expect(result.map(({ clip }) => clip.id)).toEqual(['a2', 'b1', 'b2', 'a1']);
  });

  it('keeps the original order or sorts by motion when selected', () => {
    expect(randomizeQueue(clips, 'ordered').map(({ clip }) => clip.id)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(randomizeQueue(clips, 'motion').map(({ clip }) => clip.id)).toEqual(['b1', 'a2', 'b2', 'a1']);
  });

  it('reproduces queue and random clip starts from the same seed', () => {
    const seededOrder = (seed: number) => randomizeQueue(clips, 'all', seededRandom(seed)).map(({ clip }) => clip.id);
    const seededStart = (seed: number) => getClipPlaybackRange(clips[0].clip, 'random', 0, 0.2, seededRandom(seed)).start;
    expect(seededOrder(123)).toEqual(seededOrder(123));
    expect(seededStart(123)).toBe(seededStart(123));
    expect(seededOrder(123)).not.toEqual(seededOrder(456));
  });
});

describe('clip playback range', () => {
  const clip = { id: 'c', start: 10, end: 20, thumbnail: '', motion: 0.5 };

  it('reserves the transition tail and keeps a playable interval at the last start position', () => {
    expect(getClipPlaybackRange(clip, 'custom', 1, 2)).toEqual({ start: 17.9, end: 18 });
    expect(getClipPlaybackRange(clip, 'custom', 0.25, 2)).toEqual({ start: 11.975, end: 18 });
  });

  it('starts short clips at their beginning and identifies them by threshold', () => {
    const shortClip = { ...clip, end: 10.4 };
    expect(getClipPlaybackRange(shortClip, 'custom', 0.9, 0.5)).toEqual({ start: 10, end: 10.4 });
    expect(isShortClip(shortClip, 1)).toBe(true);
    expect(isShortClip(clip, 1)).toBe(false);
  });
});

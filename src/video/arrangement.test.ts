import { describe, expect, it } from 'vitest';
import { findFirstIntervalEndingAfter, getClipPlaybackTime, shouldInitializeVideoSync } from './arrangement';

describe('findFirstIntervalEndingAfter', () => {
  const intervals = Array.from({ length: 10_000 }, (_, index) => ({ start: index, end: index + 1 }));

  it('finds the active interval at boundaries without scanning the full queue', () => {
    expect(findFirstIntervalEndingAfter(intervals, 0)).toBe(0);
    expect(findFirstIntervalEndingAfter(intervals, 4_321)).toBe(4_321);
    expect(findFirstIntervalEndingAfter(intervals, 9_999.99)).toBe(9_999);
    expect(findFirstIntervalEndingAfter(intervals, 10_000)).toBe(10_000);
  });
});

describe('shouldInitializeVideoSync', () => {
  it('does not re-seek during normal frame drops and reinitializes only on an explicit timeline change', () => {
    expect(shouldInitializeVideoSync('source:clip:1', 'source:clip:1')).toBe(false);
    expect(shouldInitializeVideoSync('source:clip:1', 'source:clip:2')).toBe(true);
    expect(shouldInitializeVideoSync(undefined, 'source:clip:1')).toBe(true);
  });
});

describe('getClipPlaybackTime', () => {
  it('keeps moving forward past the detected clip and only clamps at the source end', () => {
    expect(getClipPlaybackTime(8, 30, 4, 5)).toBe(9);
    expect(getClipPlaybackTime(8, 30, 4, 20)).toBe(24);
    expect(getClipPlaybackTime(8, 30, 4, 100)).toBe(29.99);
    expect(getClipPlaybackTime(8, 10, 4, 3)).toBe(8);
  });
});
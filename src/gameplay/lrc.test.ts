import { describe, expect, it } from 'vitest';
import { beatsToLrc, formatLrcTimestamp } from './lrc';
import type { Beat } from '../types';

describe('LRC export', () => {
  it('rounds centiseconds with carry across seconds and minutes', () => {
    expect(formatLrcTimestamp(59.999)).toBe('[01:00.00]');
  });

  it('sorts beats and writes strength symbols as lyric text', () => {
    const beats: Beat[] = [
      { time: 1.2, isDownbeat: false, confidence: 1, strength: 'mp' },
      { time: 0, isDownbeat: true, confidence: 1, strength: 'f' },
    ];
    expect(beatsToLrc(beats)).toBe('[00:00.00]f\n[00:01.20]mp');
  });
});

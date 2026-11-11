import { describe, expect, it } from 'vitest';
import { annotateBeats, estimateLocalBpm, getNoteSize, getStrengthEffectIntensity } from './rhythm';
import type { DetectedBeat } from '../types';

describe('professional beat strengths', () => {
  it('derives f, mp, mf, p accents from downbeats in a four-beat bar', () => {
    const events: DetectedBeat[] = Array.from({ length: 5 }, (_, index) => ({ time: index * 0.5, isDownbeat: index === 0 || index === 4, confidence: 1 }));
    expect(annotateBeats(events).map((beat) => beat.strength)).toEqual(['f', 'mp', 'mf', 'p', 'f']);
  });

  it('estimates BPM locally so different tempo sections remain distinct', () => {
    const times = Array.from({ length: 8 }, (_, index) => index * 0.5);
    for (let index = 8; index < 16; index += 1) times.push(times[index - 1] + 2 / 3);
    const beats = annotateBeats(times.map((time) => ({ time, isDownbeat: false, confidence: 1 })));
    expect(estimateLocalBpm(beats, 1.5)).toBe(120);
    expect(estimateLocalBpm(beats, 8)).toBe(90);
  });
});

describe('strength presentation controls', () => {
  it('scales the size difference coefficient around the mf reference size', () => {
    expect(getNoteSize('f', 0)).toBe(44);
    expect(getNoteSize('mf', 1)).toBe(44);
    expect(getNoteSize('f', 1)).toBe(55);
    expect(getNoteSize('p', 1)).toBeCloseTo(26.4);
  });

  it('blends hit-effect intensity toward the note strength factor', () => {
    expect(getStrengthEffectIntensity(0.8, 0, 'p')).toBe(0.8);
    expect(getStrengthEffectIntensity(0.8, 1, 'f')).toBe(0.8);
    expect(getStrengthEffectIntensity(0.8, 1, 'p')).toBeCloseTo(0.28);
    expect(getStrengthEffectIntensity(0.8, 0.5, 'mf')).toBeCloseTo(0.72);
  });
});

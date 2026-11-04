import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty';
import { pickBeatPeaks } from '../audio/peakPicking';

describe('difficulty presets', () => {
  it('keeps a playable consecutive beat chain on easy', () => {
    const activations = new Float32Array(400);
    for (const frame of [10, 60, 110, 160, 210, 260, 310, 360]) activations[frame] = 0.8;
    const easy = DIFFICULTIES.easy;
    const beats = pickBeatPeaks(activations, easy.threshold, easy.minInterval);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats.slice(1).every((time, index) => time - beats[index] <= 0.55)).toBe(true);
    expect(beats.slice(1).every((time, index) => time - beats[index] >= 0.44)).toBe(true);
  });

  it('reduces dense subdivisions on easy and increases them on hard', () => {
    const activations = new Float32Array(400);
    for (let frame = 10; frame < activations.length; frame += 15) activations[frame] = 0.8;
    const easy = pickBeatPeaks(activations, DIFFICULTIES.easy.threshold, DIFFICULTIES.easy.minInterval);
    const normal = pickBeatPeaks(activations, DIFFICULTIES.normal.threshold, DIFFICULTIES.normal.minInterval);
    const hard = pickBeatPeaks(activations, DIFFICULTIES.hard.threshold, DIFFICULTIES.hard.minInterval);
    expect(easy.length).toBeLessThan(normal.length);
    expect(hard.length).toBeGreaterThan(normal.length);
    expect(DIFFICULTIES.easy.threshold).toBe(DIFFICULTIES.normal.threshold);
    expect(DIFFICULTIES.easy.minInterval).toBeGreaterThan(DIFFICULTIES.normal.minInterval);
    expect(DIFFICULTIES.normal.minInterval).toBeGreaterThan(DIFFICULTIES.hard.minInterval);
  });
});

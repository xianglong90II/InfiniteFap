import { describe, expect, it } from 'vitest';
import { computeLogMel } from './features';
import { pickBeatPeaks } from './peakPicking';

describe('TCN audio preprocessing', () => {
  it('creates 81 log-mel bands at 100 fps with finite values', () => {
    const samples = Float32Array.from({ length: 22050 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 22050) * 0.1);
    const mel = computeLogMel(samples);
    expect(mel.frames).toBe(101);
    expect(mel.data).toHaveLength(81 * 101);
    expect(mel.data.every(Number.isFinite)).toBe(true);
    expect(mel.data.some((value) => value > 0)).toBe(true);
  });

  it('picks the strongest activation and enforces a 200ms minimum interval', () => {
    const activations = new Float32Array(100);
    activations[10] = 0.5;
    activations[15] = 0.9;
    activations[35] = 0.8;
    const beats = pickBeatPeaks(activations);
    expect(beats).toEqual([15 / (22050 / 220), 35 / (22050 / 220)]);
  });
});

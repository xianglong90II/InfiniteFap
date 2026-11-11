import { describe, expect, it } from 'vitest';
import { beatThisWindowStarts, computeBeatThisLogMel, pickBeatThisEvents } from './beatThis';

describe('Beat This! preprocessing', () => {
  it('creates centered 50fps, 128-bin finite log-mel features', () => {
    const samples = Float32Array.from({ length: 22050 }, (_, index) => Math.sin((2 * Math.PI * 440 * index) / 22050) * 0.1);
    const filterbank = new Float32Array(513 * 128);
    filterbank[20 * 128] = 1;
    const result = computeBeatThisLogMel(samples, filterbank);
    expect(result.frames).toBe(51);
    expect(result.data).toHaveLength(51 * 128);
    expect(result.data.every(Number.isFinite)).toBe(true);
    expect(result.data.some((value) => value > 0)).toBe(true);
  });

  it('uses the model 1500-frame windows with 6-frame borders and a shifted final window', () => {
    expect(beatThisWindowStarts(100)).toEqual([-6]);
    expect(beatThisWindowStarts(2000)).toEqual([-6, 506]);
  });
});

describe('Beat This! beat/downbeat postprocessing', () => {
  it('detects local beat and downbeat peaks on the model 20ms grid', () => {
    const beat = new Float32Array(80).fill(-1);
    const downbeat = new Float32Array(80).fill(-1);
    for (const [frame, confidence] of [[10, 2], [35, 1], [60, 2]] as const) beat[frame] = confidence;
    downbeat[10] = 3;
    downbeat[60] = 3;
    expect(pickBeatThisEvents(beat, downbeat)).toEqual([
      { time: 0.2, isDownbeat: true, confidence: 1 / (1 + Math.exp(-2)) },
      { time: 0.7, isDownbeat: false, confidence: 1 / (1 + Math.exp(-1)) },
      { time: 1.2, isDownbeat: true, confidence: 1 / (1 + Math.exp(-2)) },
    ]);
  });
});

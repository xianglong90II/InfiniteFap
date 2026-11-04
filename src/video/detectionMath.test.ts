import { describe, expect, it } from 'vitest';
import { scoreFrameDifference, scoreHistogramDifference } from './detectionMath';

describe('scoreFrameDifference', () => {
  it('returns zero for identical frames', () => {
    const frame = new Uint8ClampedArray([40, 80, 120, 255, 40, 80, 120, 255]);
    expect(scoreFrameDifference(frame, frame)).toBe(0);
  });

  it('increases as frame colors change', () => {
    const previous = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const slightChange = new Uint8ClampedArray([25, 25, 25, 255, 25, 25, 25, 255]);
    const largeChange = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(scoreFrameDifference(previous, slightChange)).toBeLessThan(scoreFrameDifference(previous, largeChange));
  });
});

describe('scoreHistogramDifference', () => {
  it('returns zero for identical luminance distributions', () => {
    const frame = new Uint8ClampedArray([40, 80, 120, 255, 40, 80, 120, 255]);
    expect(scoreHistogramDifference(frame, frame)).toBe(0);
  });

  it('detects a change in luminance distribution', () => {
    const previous = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const current = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(scoreHistogramDifference(previous, current)).toBe(1);
  });
});
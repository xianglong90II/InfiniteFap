import { describe, expect, it } from 'vitest';
import { getNotePosition } from './notePosition';

describe('getNotePosition', () => {
  it('moves vertical notes down into the judgement point', () => {
    expect(getNotePosition('vertical', 0)).toBe(80);
    expect(getNotePosition('vertical', 1)).toBeLessThan(80);
    expect(getNotePosition('vertical', 1)).toBeGreaterThan(getNotePosition('vertical', 2));
  });

  it('moves horizontal notes from the right toward the left-side judgement key', () => {
    expect(getNotePosition('horizontal', 0)).toBe(18);
    expect(getNotePosition('horizontal', 2)).toBeGreaterThan(18);
    expect(getNotePosition('horizontal', 2)).toBeLessThan(getNotePosition('horizontal', 3));
  });
});

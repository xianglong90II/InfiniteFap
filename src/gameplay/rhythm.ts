import type { Beat, BeatStrength, DetectedBeat } from '../types';

const median = (values: number[]) => {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};

const strengthSizeFactors: Record<BeatStrength, number> = { f: 1.25, mf: 1, mp: 0.8, p: 0.6 };
const strengthEffectFactors: Record<BeatStrength, number> = { f: 1, mf: 0.8, mp: 0.55, p: 0.35 };

export function getNoteSize(strength: BeatStrength, difference: number, baseSize = 44): number {
  return baseSize * (1 + (strengthSizeFactors[strength] - 1) * Math.max(0, difference));
}

export function getStrengthEffectIntensity(baseIntensity: number, influence: number, strength: BeatStrength): number {
  const amount = Math.max(0, Math.min(1, influence));
  return baseIntensity * (1 - amount + amount * strengthEffectFactors[strength]);
}

export function estimateLocalBpm(beats: Beat[], time: number): number {
  if (beats.length < 2) return 0;
  let low = 0;
  let high = beats.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (beats[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const start = Math.max(0, low - 5);
  const end = Math.min(beats.length, low + 5);
  const intervals = beats.slice(start, end).slice(1).map((beat, index) => beat.time - beats[start + index].time).filter((interval) => interval > 0);
  const interval = median(intervals);
  return interval ? Math.round(60 / interval) : 0;
}

function meterAt(index: number, downbeatIndices: number[]): { meter: number; phase: number } | undefined {
  let previous = -1;
  let next = -1;
  for (const downbeatIndex of downbeatIndices) {
    if (downbeatIndex <= index) previous = downbeatIndex;
    if (downbeatIndex > index) { next = downbeatIndex; break; }
  }
  const barBeats = previous >= 0 && next > previous ? next - previous : previous >= 0 ? undefined : undefined;
  if (barBeats && (barBeats === 3 || barBeats === 4)) return { meter: barBeats, phase: index - previous };
  if (previous >= 0 && index > previous) return { meter: 4, phase: (index - previous) % 4 };
  return undefined;
}

function strengthForBeat(beats: DetectedBeat[], index: number, downbeatIndices: number[]): BeatStrength {
  const beat = beats[index];
  if (beat.isDownbeat) return 'f';
  const bar = meterAt(index, downbeatIndices);
  if (bar) {
    if (bar.meter === 4) return (['f', 'mp', 'mf', 'p'] as const)[bar.phase % 4];
    return (['f', 'mp', 'p'] as const)[bar.phase % 3];
  }
  if (beat.confidence >= 0.97) return 'mf';
  if (beat.confidence >= 0.75) return 'mp';
  return 'p';
}

export function annotateBeats(events: DetectedBeat[]): Beat[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const downbeatIndices = sorted.flatMap((beat, index) => beat.isDownbeat ? [index] : []);
  return sorted.map((beat, index) => ({ ...beat, strength: strengthForBeat(sorted, index, downbeatIndices) }));
}

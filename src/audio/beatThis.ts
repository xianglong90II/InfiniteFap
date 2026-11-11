export const BEAT_THIS = {
  sampleRate: 22050,
  nFft: 1024,
  hopLength: 441,
  melBins: 128,
  fps: 50,
  chunkSize: 1500,
  borderSize: 6,
} as const;

function reflectIndex(index: number, length: number): number {
  if (length < 2) return 0;
  const period = 2 * (length - 1);
  const wrapped = ((index % period) + period) % period;
  return wrapped < length ? wrapped : period - wrapped;
}

export function beatThisWindowStarts(frames: number): number[] {
  const stride = BEAT_THIS.chunkSize - 2 * BEAT_THIS.borderSize;
  const starts: number[] = [];
  for (let start = -BEAT_THIS.borderSize; start < frames - BEAT_THIS.borderSize; start += stride) starts.push(start);
  if (frames > stride && starts.length) starts[starts.length - 1] = frames - (BEAT_THIS.chunkSize - BEAT_THIS.borderSize);
  return starts;
}

export function computeBeatThisLogMel(samples: Float32Array, filterbank: Float32Array): { data: Float32Array; frames: number } {
  const { nFft, hopLength, melBins } = BEAT_THIS;
  const bins = nFft / 2 + 1;
  if (!samples.length) throw new Error('音频没有可分析的采样点');
  if (filterbank.length !== bins * melBins) throw new Error(`Beat This! Mel filterbank 长度错误：${filterbank.length}`);

  const frames = Math.floor(samples.length / hopLength) + 1;
  const real = new Float64Array(nFft);
  const imag = new Float64Array(nFft);
  const hann = Float64Array.from({ length: nFft }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft));
  const bitReverse = new Uint16Array(nFft);
  for (let i = 0; i < nFft; i += 1) {
    let value = i;
    let reversed = 0;
    for (let bit = 0; bit < 10; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>>= 1;
    }
    bitReverse[i] = reversed;
  }
  const cosTable = new Float64Array(nFft / 2);
  const sinTable = new Float64Array(nFft / 2);
  for (let i = 0; i < nFft / 2; i += 1) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / nFft);
    sinTable[i] = Math.sin((2 * Math.PI * i) / nFft);
  }

  const output = new Float32Array(frames * melBins);
  const fftScale = 1 / Math.sqrt(nFft);
  for (let frame = 0; frame < frames; frame += 1) {
    const center = frame * hopLength;
    for (let i = 0; i < nFft; i += 1) {
      real[i] = samples[reflectIndex(center + i - nFft / 2, samples.length)] * hann[i];
      imag[i] = 0;
    }
    for (let i = 0; i < nFft; i += 1) {
      const reversed = bitReverse[i];
      if (reversed > i) {
        [real[i], real[reversed]] = [real[reversed], real[i]];
        [imag[i], imag[reversed]] = [imag[reversed], imag[i]];
      }
    }
    for (let size = 2; size <= nFft; size *= 2) {
      const stride = nFft / size;
      const halfSize = size / 2;
      for (let start = 0; start < nFft; start += size) {
        for (let j = 0; j < halfSize; j += 1) {
          const tableIndex = j * stride;
          const even = start + j;
          const odd = even + halfSize;
          const tr = real[odd] * cosTable[tableIndex] + imag[odd] * sinTable[tableIndex];
          const ti = imag[odd] * cosTable[tableIndex] - real[odd] * sinTable[tableIndex];
          real[odd] = real[even] - tr;
          imag[odd] = imag[even] - ti;
          real[even] += tr;
          imag[even] += ti;
        }
      }
    }
    const row = frame * melBins;
    for (let mel = 0; mel < melBins; mel += 1) {
      let energy = 0;
      for (let bin = 0; bin < bins; bin += 1) {
        energy += Math.hypot(real[bin], imag[bin]) * fftScale * filterbank[bin * melBins + mel];
      }
      output[row + mel] = Math.log1p(1000 * energy);
    }
  }
  return { data: output, frames };
}

export type BeatThisEvent = { time: number; isDownbeat: boolean; confidence: number };

function pickLogitPeaks(logits: Float32Array, frameOffset: number): { frame: number; value: number }[] {
  const peaks: { frame: number; value: number }[] = [];
  const radius = 3;
  for (let frame = 0; frame < logits.length; frame += 1) {
    const value = logits[frame];
    if (!(value > 0)) continue;
    let maximum = true;
    for (let nearby = Math.max(0, frame - radius); nearby <= Math.min(logits.length - 1, frame + radius); nearby += 1) {
      if (logits[nearby] > value || (nearby < frame && logits[nearby] === value)) { maximum = false; break; }
    }
    if (!maximum) continue;
    const last = peaks[peaks.length - 1];
    const peak = { frame: frame + frameOffset, value };
    if (last && peak.frame - last.frame <= 1) {
      if (peak.value > last.value) peaks[peaks.length - 1] = peak;
    } else peaks.push(peak);
  }
  return peaks;
}

export function pickBeatThisEvents(beatLogits: Float32Array, downbeatLogits: Float32Array): BeatThisEvent[] {
  const beats = pickLogitPeaks(beatLogits, 0).map((peak) => ({ ...peak, isDownbeat: false }));
  const downbeats = pickLogitPeaks(downbeatLogits, 0);
  const snapTolerance = Math.round(BEAT_THIS.fps * 0.14);
  for (const downbeat of downbeats) {
    let nearest = -1;
    let distance = snapTolerance + 1;
    for (let i = 0; i < beats.length; i += 1) {
      const delta = Math.abs(beats[i].frame - downbeat.frame);
      if (delta < distance) { nearest = i; distance = delta; }
    }
    if (nearest >= 0 && distance <= snapTolerance) beats[nearest].isDownbeat = true;
    else beats.push({ ...downbeat, isDownbeat: true });
  }
  beats.sort((a, b) => a.frame - b.frame);
  const result: BeatThisEvent[] = [];
  for (const beat of beats) {
    const time = beat.frame / BEAT_THIS.fps;
    const confidence = 1 / (1 + Math.exp(-beat.value));
    const previous = result[result.length - 1];
    if (previous && time - previous.time <= 1 / BEAT_THIS.fps) {
      if (beat.isDownbeat || confidence > previous.confidence) {
        previous.time = time;
        previous.confidence = confidence;
      }
      previous.isDownbeat ||= beat.isDownbeat;
    } else result.push({ time, isDownbeat: beat.isDownbeat, confidence });
  }
  return result;
}

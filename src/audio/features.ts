const SAMPLE_RATE = 22050;
const FFT_SIZE = 2048;
const HOP_LENGTH = 220;
const MEL_BANDS = 81;
const FMIN = 30;
const FMAX = 11000;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function reflectIndex(index: number, length: number): number {
  if (length < 2) return 0;
  const period = 2 * (length - 1);
  const wrapped = ((index % period) + period) % period;
  return wrapped < length ? wrapped : period - wrapped;
}

export function computeLogMel(samples: Float32Array): { data: Float32Array; frames: number } {
  if (!samples.length) throw new Error('音频没有可分析的采样点');
  const frames = Math.floor(samples.length / HOP_LENGTH) + 1;
  const half = FFT_SIZE / 2;
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const bitReverse = new Uint16Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    let x = i;
    let reversed = 0;
    for (let bit = 0; bit < 11; bit += 1) {
      reversed = (reversed << 1) | (x & 1);
      x >>>= 1;
    }
    bitReverse[i] = reversed;
  }
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  for (let i = 0; i < half; i += 1) {
    cosTable[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
    sinTable[i] = Math.sin((2 * Math.PI * i) / FFT_SIZE);
  }
  const melLow = hzToMel(FMIN);
  const melHigh = hzToMel(FMAX);
  const melPoints = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz(melLow + ((melHigh - melLow) * i) / (MEL_BANDS + 1)));
  const filters = Array.from({ length: MEL_BANDS }, (_, band) => {
    const [left, center, right] = melPoints.slice(band, band + 3);
    const start = Math.max(0, Math.floor((left * FFT_SIZE) / SAMPLE_RATE));
    const end = Math.min(half, Math.ceil((right * FFT_SIZE) / SAMPLE_RATE));
    const indices: number[] = [];
    const weights: number[] = [];
    for (let bin = start; bin <= end; bin += 1) {
      const hz = (bin * SAMPLE_RATE) / FFT_SIZE;
      const weight = hz <= center ? (hz - left) / (center - left) : (right - hz) / (right - center);
      if (weight > 0) {
        indices.push(bin);
        weights.push(weight);
      }
    }
    return { indices, weights };
  });
  const output = new Float32Array(MEL_BANDS * frames);
  const log = Math.log1p;

  for (let frame = 0; frame < frames; frame += 1) {
    const center = frame * HOP_LENGTH;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      real[i] = samples[reflectIndex(center + i - half, samples.length)] * window[i];
      imag[i] = 0;
    }
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const j = bitReverse[i];
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const stride = FFT_SIZE / size;
      const halfSize = size / 2;
      for (let start = 0; start < FFT_SIZE; start += size) {
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
    for (let band = 0; band < MEL_BANDS; band += 1) {
      const filter = filters[band];
      let energy = 0;
      for (let i = 0; i < filter.indices.length; i += 1) {
        const bin = filter.indices[i];
        energy += (real[bin] * real[bin] + imag[bin] * imag[bin]) * filter.weights[i];
      }
      output[band * frames + frame] = log(energy);
    }
  }
  return { data: output, frames };
}

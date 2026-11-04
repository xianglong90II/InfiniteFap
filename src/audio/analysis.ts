export function makeWaveform(buffer: AudioBuffer, bars = 180): number[] {
  const channel = buffer.getChannelData(0);
  const samplesPerBar = Math.max(1, Math.floor(channel.length / bars));
  const peaks: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const from = bar * samplesPerBar;
    const to = Math.min(channel.length, from + samplesPerBar);
    let peak = 0;
    for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(channel[i]));
    peaks.push(peak);
  }
  return peaks;
}


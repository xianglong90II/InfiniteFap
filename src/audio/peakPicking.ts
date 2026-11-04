export function pickBeatPeaks(activations: Float32Array, threshold = 0.3, minInterval = 0.2): number[] {
  const fps = 22050 / 220;
  const minFrames = Math.max(1, Math.floor(minInterval * fps));
  const beats: number[] = [];
  let frame = 0;
  while (frame < activations.length) {
    if (activations[frame] >= threshold) {
      const end = Math.min(frame + minFrames, activations.length);
      let peak = frame;
      for (let i = frame + 1; i < end; i += 1) if (activations[i] > activations[peak]) peak = i;
      beats.push(peak / fps);
      frame = peak + minFrames;
    } else {
      frame += 1;
    }
  }
  return beats;
}

export function scoreFrameDifference(previous: Uint8ClampedArray, current: Uint8ClampedArray): number {
  let hueDifference = 0;
  let saturationDifference = 0;
  let valueDifference = 0;
  let frameDifference = 0;

  for (let index = 0; index < current.length; index += 4) {
    const r1 = previous[index] / 255;
    const g1 = previous[index + 1] / 255;
    const b1 = previous[index + 2] / 255;
    const r2 = current[index] / 255;
    const g2 = current[index + 1] / 255;
    const b2 = current[index + 2] / 255;
    const [h1, s1, v1] = rgbToHsv(r1, g1, b1);
    const [h2, s2, v2] = rgbToHsv(r2, g2, b2);
    hueDifference += Math.abs(h1 - h2);
    saturationDifference += Math.abs(s1 - s2);
    valueDifference += Math.abs(v1 - v2);
    frameDifference += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  }

  const pixels = current.length / 4;
  const hsvChange = (hueDifference / pixels) * 0.35 + (saturationDifference / pixels) * 0.3 + (valueDifference / pixels) * 0.35;
  return Math.max(hsvChange, frameDifference / (pixels * 3));
}

export function scoreHistogramDifference(previous: Uint8ClampedArray, current: Uint8ClampedArray): number {
  const previousBins = new Uint32Array(256);
  const currentBins = new Uint32Array(256);
  for (let index = 0; index < current.length; index += 4) {
    const previousLuma = Math.floor(previous[index] * 0.299 + previous[index + 1] * 0.587 + previous[index + 2] * 0.114);
    const currentLuma = Math.floor(current[index] * 0.299 + current[index + 1] * 0.587 + current[index + 2] * 0.114);
    previousBins[previousLuma] += 1;
    currentBins[currentLuma] += 1;
  }
  let difference = 0;
  for (let bin = 0; bin < 256; bin += 1) difference += Math.abs(previousBins[bin] - currentBins[bin]);
  return current.length ? difference / (current.length / 2) : 0;
}

function rgbToHsv(red: number, green: number, blue: number): [number, number, number] {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6;
    else if (maximum === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, maximum === 0 ? 0 : delta / maximum, maximum];
}
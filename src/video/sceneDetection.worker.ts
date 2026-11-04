import { scoreFrameDifference, scoreHistogramDifference } from './detectionMath';

const WIDTH = 320;
const HEIGHT = 180;
const PIXELS = WIDTH * HEIGHT;
type AnalysisMode = 'hybrid' | 'frame-difference' | 'histogram';
let previousPixels: Uint8ClampedArray | undefined;
let cpuCanvas: OffscreenCanvas | undefined;
let cpuContext: OffscreenCanvasRenderingContext2D | null = null;
let gpu: any;
let previousTexture: any;
let currentTexture: any;
let metricBuffer: any;
let resultBuffer: any;
let readBuffer: any;
let framePipeline: any;
let reducePipeline: any;
let histogramPipeline: any;
let histogramDifferencePipeline: any;
let previousHistogram: any;
let currentHistogram: any;
let useGpu = false;
let gpuHasPrevious = false;
let analysisMode: AnalysisMode = 'frame-difference';

const frameShader = `
struct Metrics { values: array<vec2<f32>> };
@group(0) @binding(0) var currentFrame: texture_2d<f32>;
@group(0) @binding(1) var previousFrame: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> metrics: Metrics;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= ${PIXELS}u) { return; }
  let coord = vec2<i32>(i32(index % ${WIDTH}u), i32(index / ${WIDTH}u));
  let current = textureLoad(currentFrame, coord, 0).rgb;
  let previous = textureLoad(previousFrame, coord, 0).rgb;
  let difference = (abs(current.r - previous.r) + abs(current.g - previous.g) + abs(current.b - previous.b)) / 3.0;
  metrics.values[index] = vec2<f32>(difference, 0.0);
}`;

const reduceShader = `
struct Metrics { values: array<vec2<f32>> };
struct Result { values: array<vec2<f32>, 1> };
@group(0) @binding(0) var<storage, read> metrics: Metrics;
@group(0) @binding(1) var<storage, read_write> result: Result;
var<workgroup> partial: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local: vec3<u32>) {
  let lane = local.x;
  var sum = 0.0;
  for (var index = lane; index < ${PIXELS}u; index = index + 256u) { sum += metrics.values[index].x; }
  partial[lane] = sum;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride = stride / 2u) {
    if (lane < stride) { partial[lane] += partial[lane + stride]; }
    workgroupBarrier();
  }
  if (lane == 0u) { result.values[0] = vec2<f32>(partial[0] / f32(${PIXELS}u), 0.0); }
}`;

const histogramShader = `
struct Histogram { bins: array<atomic<u32>, 256> };
@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: Histogram;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= ${PIXELS}u) { return; }
  let coord = vec2<i32>(i32(index % ${WIDTH}u), i32(index / ${WIDTH}u));
  let color = textureLoad(frame, coord, 0).rgb;
  let luminance = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  let bin = min(255u, u32(luminance * 255.0));
  atomicAdd(&histogram.bins[bin], 1u);
}`;

const histogramDifferenceShader = `
struct Histogram { bins: array<atomic<u32>, 256> };
struct Result { values: array<vec2<f32>, 1> };
@group(0) @binding(0) var<storage, read_write> previous: Histogram;
@group(0) @binding(1) var<storage, read_write> current: Histogram;
@group(0) @binding(2) var<storage, read_write> result: Result;
var<workgroup> partial: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local: vec3<u32>) {
  let bin = local.x;
  let a = atomicLoad(&previous.bins[bin]);
  let b = atomicLoad(&current.bins[bin]);
  partial[bin] = abs(f32(a) - f32(b));
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride = stride / 2u) {
    if (bin < stride) { partial[bin] += partial[bin + stride]; }
    workgroupBarrier();
  }
  if (bin == 0u) { result.values[0] = vec2<f32>(partial[0] / (2.0 * f32(${PIXELS}u)), 0.0); }
}`;

async function initializeGpu(): Promise<boolean> {
  try {
    const webgpu = (self.navigator as any).gpu;
    const adapter = await webgpu?.requestAdapter();
    if (!adapter) return false;
    gpu = await adapter.requestDevice();
    previousTexture = gpu.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: 0x04 | 0x02 | 0x10 });
    currentTexture = gpu.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: 0x04 | 0x02 | 0x10 });
    resultBuffer = gpu.createBuffer({ size: 8, usage: 0x80 | 0x04 });
    readBuffer = gpu.createBuffer({ size: 8, usage: 0x01 | 0x08 });
    metricBuffer = gpu.createBuffer({ size: PIXELS * 8, usage: 0x80 | 0x08 });
    framePipeline = gpu.createComputePipeline({ layout: 'auto', compute: { module: gpu.createShaderModule({ code: frameShader }), entryPoint: 'main' } });
    reducePipeline = gpu.createComputePipeline({ layout: 'auto', compute: { module: gpu.createShaderModule({ code: reduceShader }), entryPoint: 'main' } });
    previousHistogram = gpu.createBuffer({ size: 256 * 4, usage: 0x80 | 0x08 });
    currentHistogram = gpu.createBuffer({ size: 256 * 4, usage: 0x80 | 0x08 });
    histogramPipeline = gpu.createComputePipeline({ layout: 'auto', compute: { module: gpu.createShaderModule({ code: histogramShader }), entryPoint: 'main' } });
    histogramDifferencePipeline = gpu.createComputePipeline({ layout: 'auto', compute: { module: gpu.createShaderModule({ code: histogramDifferenceShader }), entryPoint: 'main' } });
    return true;
  } catch {
    gpu?.destroy();
    gpu = undefined;
    return false;
  }
}

async function readGpuScore(encoder: any): Promise<number> {
  encoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, 8);
  gpu.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(1);
  const score = new Float32Array(readBuffer.getMappedRange().slice(0))[0];
  readBuffer.unmap();
  return score;
}

async function scoreFrameDifferenceGpu(): Promise<number | null> {
  const encoder = gpu.createCommandEncoder();
  const frameGroup = gpu.createBindGroup({ layout: framePipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: currentTexture.createView() },
    { binding: 1, resource: previousTexture.createView() },
    { binding: 2, resource: { buffer: metricBuffer } },
  ] });
  const framePass = encoder.beginComputePass();
  framePass.setPipeline(framePipeline);
  framePass.setBindGroup(0, frameGroup);
  framePass.dispatchWorkgroups(Math.ceil(PIXELS / 256));
  framePass.end();
  const reduceGroup = gpu.createBindGroup({ layout: reducePipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: metricBuffer } },
    { binding: 1, resource: { buffer: resultBuffer } },
  ] });
  const reducePass = encoder.beginComputePass();
  reducePass.setPipeline(reducePipeline);
  reducePass.setBindGroup(0, reduceGroup);
  reducePass.dispatchWorkgroups(1);
  reducePass.end();
  return readGpuScore(encoder);
}

async function scoreHistogramGpu(seedOnly = false): Promise<number | null> {
  gpu.queue.writeBuffer(currentHistogram, 0, new Uint32Array(256));
  const encoder = gpu.createCommandEncoder();
  const histogramGroup = gpu.createBindGroup({ layout: histogramPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: currentTexture.createView() },
    { binding: 1, resource: { buffer: currentHistogram } },
  ] });
  const histogramPass = encoder.beginComputePass();
  histogramPass.setPipeline(histogramPipeline);
  histogramPass.setBindGroup(0, histogramGroup);
  histogramPass.dispatchWorkgroups(Math.ceil(PIXELS / 256));
  histogramPass.end();
  if (seedOnly) {
    gpu.queue.submit([encoder.finish()]);
    return null;
  }
  const differenceGroup = gpu.createBindGroup({ layout: histogramDifferencePipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: previousHistogram } },
    { binding: 1, resource: { buffer: currentHistogram } },
    { binding: 2, resource: { buffer: resultBuffer } },
  ] });
  const differencePass = encoder.beginComputePass();
  differencePass.setPipeline(histogramDifferencePipeline);
  differencePass.setBindGroup(0, differenceGroup);
  differencePass.dispatchWorkgroups(1);
  differencePass.end();
  return readGpuScore(encoder);
}

async function scoreGpuFrame(): Promise<number | null> {
  if (!gpuHasPrevious) {
    if (analysisMode !== 'frame-difference') await scoreHistogramGpu(true);
    gpuHasPrevious = true;
  [previousTexture, currentTexture] = [currentTexture, previousTexture];
    if (analysisMode !== 'frame-difference') [previousHistogram, currentHistogram] = [currentHistogram, previousHistogram];
    return null;
  }
  const frameScore = analysisMode === 'histogram' ? null : await scoreFrameDifferenceGpu();
  const histogramScore = analysisMode === 'frame-difference' ? null : await scoreHistogramGpu();
  [previousTexture, currentTexture] = [currentTexture, previousTexture];
  if (analysisMode !== 'frame-difference') [previousHistogram, currentHistogram] = [currentHistogram, previousHistogram];
  return analysisMode === 'hybrid'
    ? (frameScore ?? 0) * 0.65 + (histogramScore ?? 0) * 0.35
    : frameScore ?? histogramScore;
}

function scoreCpu(bitmap: ImageBitmap): number | null {
  cpuCanvas ??= new OffscreenCanvas(WIDTH, HEIGHT);
  cpuContext ??= cpuCanvas.getContext('2d', { willReadFrequently: true });
  if (!cpuContext) throw new Error('无法创建视频分析画布');
  cpuContext.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
  const current = cpuContext.getImageData(0, 0, WIDTH, HEIGHT).data;
  const hasPrevious = previousPixels?.length === current.length;
  const frameScore = hasPrevious && analysisMode !== 'histogram' ? scoreFrameDifference(previousPixels!, current) : null;
  const histogramScore = hasPrevious && analysisMode !== 'frame-difference' ? scoreHistogramDifference(previousPixels!, current) : null;
  const score = analysisMode === 'hybrid'
    ? frameScore === null || histogramScore === null ? null : frameScore * 0.65 + histogramScore * 0.35
    : frameScore ?? histogramScore;
  previousPixels = new Uint8ClampedArray(current);
  return score;
}

self.onmessage = async (event: MessageEvent<{ type: 'init'; mode: AnalysisMode } | { type: 'frame'; bitmap: ImageBitmap }>) => {
  if (event.data.type === 'init') {
    analysisMode = event.data.mode;
    useGpu = await initializeGpu();
    self.postMessage({ type: 'ready', backend: useGpu ? 'WebGPU' : 'CPU' });
    return;
  }
  const { bitmap } = event.data;
  try {
    gpu?.queue.copyExternalImageToTexture({ source: bitmap }, { texture: currentTexture }, [WIDTH, HEIGHT]);
    const score = useGpu ? await scoreGpuFrame() : scoreCpu(bitmap);
    self.postMessage({ type: 'score', score, backend: useGpu ? 'WebGPU' : 'CPU' });
  } catch (error) {
    useGpu = false;
    gpu?.destroy();
    gpu = undefined;
    gpuHasPrevious = false;
    previousPixels = undefined;
    self.postMessage({ type: 'score', score: scoreCpu(bitmap), backend: 'CPU', warning: error instanceof Error ? error.message : String(error) });
  } finally {
    bitmap.close();
  }
};

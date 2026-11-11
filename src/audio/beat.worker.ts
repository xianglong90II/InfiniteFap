import * as ort from 'onnxruntime-web';
import { BEAT_THIS, beatThisWindowStarts, computeBeatThisLogMel, pickBeatThisEvents } from './beatThis';
import type { DetectedBeat } from '../types';

type WorkerRequest = { samples: ArrayBuffer };
type WorkerResponse = { type: 'status'; message: string } | { type: 'result'; beats: DetectedBeat[]; backend: string } | { type: 'error'; message: string };

let sessionPromise: Promise<{ session: ort.InferenceSession; backend: string }> | undefined;
let filterbankPromise: Promise<Float32Array> | undefined;

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const modelUrl = new URL(`${import.meta.env.BASE_URL}models/beat_this.onnx`, self.location.origin).href;
      try {
        if ('gpu' in navigator) {
          const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
          return { session, backend: 'WebGPU' };
        }
      } catch {
        // Fall back to the portable CPU/WASM provider on unsupported WebGPU implementations.
      }
      const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
      return { session, backend: 'WASM' };
    })();
  }
  return sessionPromise;
}

async function getFilterbank() {
  if (!filterbankPromise) {
    filterbankPromise = (async () => {
      const url = new URL(`${import.meta.env.BASE_URL}models/mel-filterbank.bin`, self.location.origin);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Mel filterbank 加载失败：HTTP ${response.status}`);
      return new Float32Array(await response.arrayBuffer());
    })();
  }
  return filterbankPromise;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const post = (message: WorkerResponse) => self.postMessage(message);
  try {
    post({ type: 'status', message: '载入 Beat This! 模型与 Mel filterbank…' });
    const [{ session, backend }, filterbank] = await Promise.all([getSession(), getFilterbank()]);
    const { data, frames } = computeBeatThisLogMel(new Float32Array(event.data.samples), filterbank);
    const starts = beatThisWindowStarts(frames);
    const beatLogits = new Float32Array(frames).fill(Number.NEGATIVE_INFINITY);
    const downbeatLogits = new Float32Array(frames).fill(Number.NEGATIVE_INFINITY);
    const assigned = new Uint8Array(frames);
    const inputName = session.inputNames.includes('spect') ? 'spect' : session.inputNames[0];
    const beatOutput = session.outputNames.find((name) => name.toLowerCase().includes('beat') && !name.toLowerCase().includes('downbeat'));
    const downbeatOutput = session.outputNames.find((name) => name.toLowerCase().includes('downbeat'));
    if (!beatOutput || !downbeatOutput) throw new Error(`Beat This! 输出签名不符：${session.outputNames.join(', ')}`);

    const inputData = new Float32Array(BEAT_THIS.chunkSize * BEAT_THIS.melBins);
    for (let windowIndex = 0; windowIndex < starts.length; windowIndex += 1) {
      const start = starts[windowIndex];
      inputData.fill(0);
      for (let localFrame = 0; localFrame < BEAT_THIS.chunkSize; localFrame += 1) {
        const sourceFrame = start + localFrame;
        if (sourceFrame < 0 || sourceFrame >= frames) continue;
        inputData.set(data.subarray(sourceFrame * BEAT_THIS.melBins, (sourceFrame + 1) * BEAT_THIS.melBins), localFrame * BEAT_THIS.melBins);
      }
      const outputs = await session.run({ [inputName]: new ort.Tensor('float32', inputData, [1, BEAT_THIS.chunkSize, BEAT_THIS.melBins]) });
      const beatWindow = outputs[beatOutput].data as Float32Array;
      const downbeatWindow = outputs[downbeatOutput].data as Float32Array;
      const destinationStart = start + BEAT_THIS.borderSize;
      const sourceStart = BEAT_THIS.borderSize;
      const count = Math.min(BEAT_THIS.chunkSize - 2 * BEAT_THIS.borderSize, frames - destinationStart);
      for (let offset = 0; offset < count; offset += 1) {
        const destination = destinationStart + offset;
        if (destination < 0 || assigned[destination]) continue;
        assigned[destination] = 1;
        beatLogits[destination] = beatWindow[sourceStart + offset];
        downbeatLogits[destination] = downbeatWindow[sourceStart + offset];
      }
      post({ type: 'status', message: `Beat This! 正在分析节拍与小节重拍（${windowIndex + 1}/${starts.length}，${backend}）…` });
    }
    post({ type: 'result', beats: pickBeatThisEvents(beatLogits, downbeatLogits), backend });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  }
};

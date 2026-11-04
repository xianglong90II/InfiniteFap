import * as ort from 'onnxruntime-web';
import { computeLogMel } from './features';
import { pickBeatPeaks } from './peakPicking';

type WorkerRequest = { samples: ArrayBuffer; threshold?: number; minInterval?: number };
type WorkerResponse = { type: 'status'; message: string } | { type: 'result'; beats: number[]; backend: string } | { type: 'error'; message: string };

let sessionPromise: Promise<{ session: ort.InferenceSession; backend: string }> | undefined;

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const modelUrl = new URL(`${import.meta.env.BASE_URL}models/beat-detection-tcn.onnx`, self.location.origin).href;
      try {
        if ('gpu' in navigator) {
          const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['webgpu'] });
          return { session, backend: 'WebGPU' };
        }
      } catch {
        // WebGPU drivers may not support every ONNX operator; WASM is the local fallback.
      }
      const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
      return { session, backend: 'WASM' };
    })();
  }
  return sessionPromise;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const post = (message: WorkerResponse) => self.postMessage(message);
    post({ type: 'status', message: '载入本地 TCN ONNX 模型…' });
    const [{ session, backend }, { data, frames }] = await Promise.all([
      getSession(),
      Promise.resolve().then(() => computeLogMel(new Float32Array(event.data.samples))),
    ]);
    post({ type: 'status', message: `TCN 正在分析 ${frames.toLocaleString()} 帧（${backend}）…` });
    const tensor = new ort.Tensor('float32', data, [1, 81, frames]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const logits = outputs[session.outputNames[0]].data as Float32Array;
    const activations = Float32Array.from(logits, (value) => 1 / (1 + Math.exp(-value)));
    post({ type: 'result', beats: pickBeatPeaks(activations, event.data.threshold ?? 0.3, event.data.minInterval ?? 0.2), backend });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  }
};

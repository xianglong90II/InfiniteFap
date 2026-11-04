export type AnalysisMode = 'hybrid' | 'frame-difference' | 'histogram';
export type VideoClip = { id: string; start: number; end: number; thumbnail: string; motion: number };
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 180;

type AnalysisWorkerMessage =
  | { type: 'ready'; backend: string }
  | { type: 'score'; score: number | null; backend: string }
  | { type: 'error'; message: string };

function waitForVideo(video: HTMLVideoElement, event: 'loadedmetadata' | 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('视频解码失败')); };
    const cleanup = () => {
      video.removeEventListener(event, onReady);
      video.removeEventListener('error', onError);
    };
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function workerRequest(worker: Worker, message: unknown, transfer: Transferable[] = []): Promise<AnalysisWorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<AnalysisWorkerMessage>) => {
      if (event.data.type === 'error') { cleanup(); reject(new Error(event.data.message)); }
      else { cleanup(); resolve(event.data); }
    };
    const onError = (event: ErrorEvent) => { cleanup(); reject(new Error(event.message || '视频分析工作线程异常')); };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(message, transfer);
  });
}

export async function detectVideoClips(
  file: File,
  threshold: number,
  minClipLength: number,
  onProgress: (progress: number) => void = () => {},
  onBackend: (backend: string) => void = () => {},
  analysisMode: AnalysisMode = 'hybrid',
): Promise<{ duration: number; clips: VideoClip[] }> {
  const video = document.createElement('video');
  const sourceUrl = URL.createObjectURL(file);
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = sourceUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d');
  if (!context) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error('浏览器无法创建视频分析画布');
  }

  const worker = new Worker(new URL('./sceneDetection.worker.ts', import.meta.url), { type: 'module' });
  try {
    const metadata = waitForVideo(video, 'loadedmetadata');
    video.load();
    await metadata;
    if (video.readyState < 2) await waitForVideo(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error('视频时长无效');
    const ready = await workerRequest(worker, { type: 'init', mode: analysisMode });
    if (ready.type !== 'ready') throw new Error('视频分析工作线程初始化失败');
    onBackend(ready.backend);

    const sampleStep = 0.3;
    const boundaries = [0];
    const scores: { time: number; score: number }[] = [];
    let lastBoundary = 0;
    for (let time = 0; time < duration; time += sampleStep) {
      if (time > 0) {
        const seeked = waitForVideo(video, 'seeked');
        video.currentTime = Math.min(time, duration - 0.001);
        await seeked;
      }
      const bitmap = await createImageBitmap(video, { resizeWidth: ANALYSIS_WIDTH, resizeHeight: ANALYSIS_HEIGHT, resizeQuality: 'low' });
      const result = await workerRequest(worker, { type: 'frame', bitmap }, [bitmap]);
      if (result.type !== 'score') throw new Error('视频帧分析失败');
      onBackend(result.backend);
      if (result.score !== null) scores.push({ time, score: result.score });
      if (result.score !== null && result.score >= threshold && time - lastBoundary >= minClipLength) {
        boundaries.push(time);
        lastBoundary = time;
      }
      onProgress(Math.min(1, time / duration));
    }

    if (duration - boundaries[boundaries.length - 1] < minClipLength && boundaries.length > 1) boundaries.pop();
    boundaries.push(duration);
    const result: VideoClip[] = [];
    for (const [index, start] of boundaries.slice(0, -1).entries()) {
      const end = boundaries[index + 1];
      const thumbnailTime = Math.min(end - 0.01, start + Math.min(0.12, (end - start) / 3));
      const seeked = waitForVideo(video, 'seeked');
      video.currentTime = thumbnailTime;
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const clipScores = scores.filter((sample) => sample.time >= start && sample.time < end).map((sample) => sample.score);
      const motion = clipScores.length ? clipScores.reduce((sum, score) => sum + score, 0) / clipScores.length : 0;
      result.push({ id: `${file.name}-${index}-${start.toFixed(2)}`, start, end, thumbnail: canvas.toDataURL('image/jpeg', 0.65), motion });
    }
    onProgress(1);
    return { duration, clips: result };
  } finally {
    worker.terminate();
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
}
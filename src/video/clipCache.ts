import type { VideoClip } from './sceneDetection';
import type { AnalysisMode } from './sceneDetection';

type CachedAnalysis = { key: string; duration: number; clips: VideoClip[]; backend: string; mode: AnalysisMode; savedAt: number };
const DATABASE = 'infinitefap-video-analysis';
const STORE = 'clips';
const VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开视频缓存'));
  });
}

async function cacheKey(file: File, threshold: number, minClipLength: number, mode: AnalysisMode): Promise<string> {
  const chunkSize = 64 * 1024;
  const middle = Math.floor(file.size / 2);
  const samples = [file.slice(0, chunkSize), file.slice(Math.max(0, middle - chunkSize / 2), middle + chunkSize / 2), file.slice(Math.max(0, file.size - chunkSize))];
  const bytes = await Promise.all(samples.map((sample) => sample.arrayBuffer()));
  const input = new Uint8Array(bytes.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of bytes) { input.set(new Uint8Array(part), offset); offset += part.byteLength; }
  const digest = await crypto.subtle.digest('SHA-256', input);
  const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${file.name}:${file.size}:${file.lastModified}:${signature}:scene-v3:${threshold}:${minClipLength}:${mode}`;
}

export async function readClipCache(file: File, threshold: number, minClipLength: number, mode: AnalysisMode = 'hybrid'): Promise<CachedAnalysis | undefined> {
  try {
    const key = await cacheKey(file, threshold, minClipLength, mode);
    const database = await openDatabase();
    return await new Promise<CachedAnalysis | undefined>((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as CachedAnalysis | undefined);
      request.onerror = () => reject(request.error);
    }).finally(() => database.close());
  } catch {
    return undefined;
  }
}

export async function writeClipCache(file: File, threshold: number, minClipLength: number, analysis: Omit<CachedAnalysis, 'key' | 'mode' | 'savedAt'>, mode: AnalysisMode = 'hybrid'): Promise<boolean> {
  try {
    const key = await cacheKey(file, threshold, minClipLength, mode);
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put({ ...analysis, key, mode, savedAt: Date.now() } satisfies CachedAnalysis);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).finally(() => database.close());
    return true;
  } catch {
    // Keep the in-session result even if browser storage is disabled or full.
    return false;
  }
}
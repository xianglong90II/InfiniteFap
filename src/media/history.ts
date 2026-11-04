import type { AnalysisMode } from '../video/sceneDetection';

export type AudioHistoryItem = { id: string; kind: 'audio'; name: string; file: File; savedAt: number };
export type VideoHistoryItem = {
  id: string;
  kind: 'video';
  name: string;
  file: File;
  analysisMode: AnalysisMode;
  threshold: number;
  minClipLength: number;
  savedAt: number;
};

type NewVideoHistoryItem = Omit<VideoHistoryItem, 'savedAt'>;
const DATABASE = 'infinitefap-media-history';
const AUDIO_STORE = 'audio';
const VIDEO_STORE = 'video';
const VERSION = 1;

function fileId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(AUDIO_STORE)) database.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(VIDEO_STORE)) database.createObjectStore(VIDEO_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开媒体历史记录'));
  });
}

async function listItems<T>(store: string): Promise<T[]> {
  const database = await openDatabase();
  try {
    const items = await new Promise<T[]>((resolve, reject) => {
      const request = database.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error('无法读取媒体历史记录'));
    });
    return items.sort((a, b) => (b as { savedAt: number }).savedAt - (a as { savedAt: number }).savedAt);
  } finally {
    database.close();
  }
}

async function saveItem<T extends { id: string; savedAt: number }>(store: string, item: Omit<T, 'savedAt'>): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).put({ ...item, savedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法保存媒体历史记录'));
      transaction.onabort = () => reject(transaction.error ?? new Error('媒体历史记录保存已取消'));
    });
  } finally {
    database.close();
  }
}

async function deleteItem(store: string, file: File): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).delete(fileId(file));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('无法删除媒体历史记录'));
      transaction.onabort = () => reject(transaction.error ?? new Error('媒体历史记录删除已取消'));
    });
  } finally {
    database.close();
  }
}

export async function listAudioHistory(): Promise<AudioHistoryItem[]> {
  return listItems<AudioHistoryItem>(AUDIO_STORE);
}

export async function saveAudioHistory(file: File): Promise<void> {
  const item: Omit<AudioHistoryItem, 'savedAt'> = { id: fileId(file), kind: 'audio', name: file.name, file };
  return saveItem<AudioHistoryItem>(AUDIO_STORE, item);
}

export async function deleteAudioHistory(file: File): Promise<void> {
  return deleteItem(AUDIO_STORE, file);
}

export async function listVideoHistory(): Promise<VideoHistoryItem[]> {
  return listItems<VideoHistoryItem>(VIDEO_STORE);
}

export async function saveVideoHistory(item: NewVideoHistoryItem): Promise<void> {
  return saveItem<VideoHistoryItem>(VIDEO_STORE, item);
}

export async function deleteVideoHistory(file: File): Promise<void> {
  return deleteItem(VIDEO_STORE, file);
}

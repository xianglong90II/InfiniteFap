import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Check, CircleHelp, Crosshair, Film, Maximize, Minimize, Music2, Pause, Play, RefreshCw, Scissors, Settings2, Shirt, Shuffle, Sparkles, Timer, TimerOff, Upload, Volume2, VolumeX, X, Zap } from 'lucide-react';
import ShaderCanvas, { DEFAULT_FRAGMENT_SHADER, type BlastShaderEffects, type ShaderEffects } from './ShaderCanvas';
import { getNotePosition } from './gameplay/notePosition';
import { DIFFICULTIES, type Difficulty } from './gameplay/difficulty';
import { decodeAudioFile } from './audio/decoder';
import { makeWaveform } from './audio/analysis';
import { resampleToMono22050 } from './audio/resample';
import { detectVideoClips, type AnalysisMode, type VideoClip } from './video/sceneDetection';
import { findFirstIntervalEndingAfter, getClipPlaybackTime, shouldInitializeVideoSync } from './video/arrangement';
import { readClipCache, writeClipCache } from './video/clipCache';
import { getClipPlaybackRange, isShortClip, randomizeQueue, seededRandom, type ClipStartMode, type RandomizationMode } from './video/queue';
import { deleteAudioHistory, deleteVideoHistory, listAudioHistory, listVideoHistory, saveAudioHistory, saveVideoHistory, type AudioHistoryItem } from './media/history';
import type { Beat, Note } from './types';

const NOTE_ICONS = [
  { id: 'heart', label: '爱心', source: 'favorite' },
  { id: 'star', label: '星星', source: 'star' },
  { id: 'flare', label: '闪光', source: 'flare' },
] as const;
const ICON_BASE = `${import.meta.env.BASE_URL}notes/`;
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

type WorkerMessage =
  | { type: 'status'; message: string }
  | { type: 'result'; beats: number[]; backend: string }
  | { type: 'error'; message: string };

type BackgroundVideo = { id: string; name: string; file: File; url: string; duration: number; clips: VideoClip[]; analysisMode: AnalysisMode; analysisThreshold: number; analysisMinClipLength: number };
type NoteLayout = 'vertical' | 'horizontal';
type VideoPanelTab = 'import' | 'manage' | 'arrange';
type AudioPanelTab = 'select' | 'import' | 'online';
type ArrangementMode = 'none' | 'auto';
type TransitionPreset = 'crossfade' | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down' | 'zoom' | 'blur' | 'flash';
type FillMode = 'cover' | 'contain' | 'stretch';
type CanvasPreset = '1080p' | '720p' | 'portrait' | 'square';
type ArrangementItem = { start: number; end: number; mediaId: string; clip: VideoClip; queueKey: string; playbackStart: number; playbackEnd: number };
type ExplosionScene = { mediaId: string; clip: VideoClip; playbackStart: number; playbackEnd: number };
const TRANSITION_PRESETS: { id: TransitionPreset; label: string }[] = [
  { id: 'crossfade', label: '交叉淡化' },
  { id: 'wipe-left', label: '向左擦除' },
  { id: 'wipe-right', label: '向右擦除' },
  { id: 'wipe-up', label: '向上擦除' },
  { id: 'wipe-down', label: '向下擦除' },
  { id: 'zoom', label: '缩放淡出' },
  { id: 'blur', label: '模糊淡出' },
  { id: 'flash', label: '闪白切换' },
];
const clipQueueKey = (mediaId: string, clipId: string) => `${mediaId}:${clipId}`;
const makeRandomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const CANVAS_PRESETS: Record<CanvasPreset, { label: string; width: number; height: number }> = {
  '1080p': { label: '1080p 横屏', width: 1920, height: 1080 },
  '720p': { label: '720p 横屏', width: 1280, height: 720 },
  portrait: { label: '1080p 竖屏', width: 1080, height: 1920 },
  square: { label: '1080p 方形', width: 1080, height: 1080 },
};
const JUDGEMENT_TYPES = ['PERFECT', 'GOOD', 'BAD', 'MISS'] as const;
const HIT_STOP_MS = 55;
const NOTE_COLORS = [
  { id: 'mint', label: '薄荷绿', value: '#caff90', filter: 'brightness(0) saturate(100%) invert(91%) sepia(30%) saturate(658%) hue-rotate(29deg) brightness(105%)' },
  { id: 'violet', label: '薰衣草紫', value: '#c9a7ff', filter: 'brightness(0) saturate(100%) invert(76%) sepia(24%) saturate(1046%) hue-rotate(213deg) brightness(105%)' },
  { id: 'cyan', label: '冰蓝', value: '#91e5ff', filter: 'brightness(0) saturate(100%) invert(78%) sepia(52%) saturate(625%) hue-rotate(157deg) brightness(104%)' },
  { id: 'rose', label: '玫瑰粉', value: '#ff9ac4', filter: 'brightness(0) saturate(100%) invert(72%) sepia(38%) saturate(1000%) hue-rotate(289deg) brightness(104%)' },
  { id: 'gold', label: '暖金色', value: '#ffd36e', filter: 'brightness(0) saturate(100%) invert(87%) sepia(58%) saturate(545%) hue-rotate(334deg) brightness(103%)' },
  { id: 'white', label: '月光白', value: '#f5f2ff', filter: 'brightness(0) saturate(100%) invert(97%) sepia(9%) saturate(184%) hue-rotate(213deg) brightness(104%)' },
] as const;
type MenuTab = 'chart' | 'effects' | 'blast' | 'video';

function findNextBeat(beats: Beat[], time: number): number {
  let low = 0;
  let high = beats.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (beats[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'loadeddata' | 'seeked', signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('等待视频解码超时')); }, 30_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(video.error?.message || '视频解码失败')); };
    const onAbort = () => { cleanup(); reject(new DOMException('预热已取消', 'AbortError')); };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export default function GameApp() {
  const [audioFile, setAudioFile] = useState<File>();
  const [audioPanelOpen, setAudioPanelOpen] = useState(false);
  const [audioPanelTab, setAudioPanelTab] = useState<AudioPanelTab>('select');
  const [audioHistory, setAudioHistory] = useState<AudioHistoryItem[]>([]);
  const [onlineAudioUrl, setOnlineAudioUrl] = useState('');
  const [audioImportBusy, setAudioImportBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [hitNotes, setHitNotes] = useState<Set<number>>(() => new Set());
  const [backgrounds, setBackgrounds] = useState<BackgroundVideo[]>([]);
  const [backgroundId, setBackgroundId] = useState('');
  const [videoPanelOpen, setVideoPanelOpen] = useState(false);
  const [videoPanelTab, setVideoPanelTab] = useState<VideoPanelTab>('import');
  const [importTasks, setImportTasks] = useState<{ id: string; name: string; progress: number; backend: string }[]>([]);
  const [shortClipThreshold, setShortClipThreshold] = useState(1);
  const [arrangementMode, setArrangementMode] = useState<ArrangementMode>('none');
  const [videoOrder, setVideoOrder] = useState<string[]>([]);
  const [enabledClips, setEnabledClips] = useState<Record<string, boolean>>({});
  const [clipStartModes, setClipStartModes] = useState<Record<string, ClipStartMode>>({});
  const [clipCustomPositions, setClipCustomPositions] = useState<Record<string, number>>({});
  const [explosionClipKey, setExplosionClipKey] = useState('');
  const [explosionScene, setExplosionScene] = useState<ExplosionScene | null>(null);
  const [randomizationMode, setRandomizationMode] = useState<RandomizationMode>('ordered');
  const [randomSeed, setRandomSeed] = useState(makeRandomSeed);
  const [randomSeedDraft, setRandomSeedDraft] = useState(() => String(randomSeed));
  const [transitionPreset, setTransitionPreset] = useState<TransitionPreset>('crossfade');
  const [transitionDuration, setTransitionDuration] = useState(0.45);
  const [explosionPoints, setExplosionPoints] = useState<{ id: string; time: number }[]>([]);
  const [activeExplosionTime, setActiveExplosionTime] = useState<number | null>(null);
  const [explosionCountdown, setExplosionCountdown] = useState<number | null>(null);
  const [explosionSequence, setExplosionSequence] = useState(0);
  const [explosionActive, setExplosionActive] = useState(false);
  const [explosionStyle, setExplosionStyle] = useState<'nova' | 'shockwave' | 'prism' | 'pulsar'>('nova');
  const [explosionIntensity, setExplosionIntensity] = useState(0.9);
  const [explosionDuration, setExplosionDuration] = useState(3);
  const [blastShaderEffects, setBlastShaderEffects] = useState<BlastShaderEffects>({ caustics: true, whiteEdge: true });
  const [sceneThreshold, setSceneThreshold] = useState(0.12);
  const [minClipLength, setMinClipLength] = useState(3);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('hybrid');
  const [videoBusy, setVideoBusy] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoBackend, setVideoBackend] = useState('WebGPU');
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [canvasPreset, setCanvasPreset] = useState<CanvasPreset>('1080p');
  const [fillMode, setFillMode] = useState<FillMode>('cover');
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [currentTime, setCurrentTime] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [videoSeekSequence, setVideoSeekSequence] = useState(0);
  const [, setVideoPoolVersion] = useState(0);
  const [videoWarmupRequested, setVideoWarmupRequested] = useState(false);
  const [warmedVideoUrls, setWarmedVideoUrls] = useState<Set<string>>(() => new Set());
  const [warmedTransitionKeys, setWarmedTransitionKeys] = useState<Set<string>>(() => new Set());
  const [videoWarmupProgress, setVideoWarmupProgress] = useState({ done: 0, total: 0, running: false, error: '' });
  const [playing, setPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [debugOpen, setDebugOpen] = useState(false);
  const [performanceStats, setPerformanceStats] = useState({ fps: 0, frameMs: 0, slowFrames: 0, videoFps: 0, heapMb: 0 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noteIcon, setNoteIcon] = useState<(typeof NOTE_ICONS)[number]['id']>('heart');
  const [backend, setBackend] = useState('本地 ONNX');
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [combo, setCombo] = useState(0);
  const [showRemaining, setShowRemaining] = useState(true);
  const [hitSoundEnabled, setHitSoundEnabled] = useState(true);
  const [hitSequence, setHitSequence] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTab, setMenuTab] = useState<MenuTab>('chart');
  const [noteColor, setNoteColor] = useState<(typeof NOTE_COLORS)[number]['id']>('mint');
  const [noteLayout, setNoteLayout] = useState<NoteLayout>('horizontal');
  const [laneWidthPercent, setLaneWidthPercent] = useState(44);
  const [laneHeightPercent, setLaneHeightPercent] = useState(10);
  const [laneOpacity, setLaneOpacity] = useState(0.72);
  const [keyPressSequence, setKeyPressSequence] = useState(0);
  const [pressedKey, setPressedKey] = useState(false);
  const [frozenNoteId, setFrozenNoteId] = useState<number | null>(null);
  const [effectIntensity, setEffectIntensity] = useState(0.85);
  const [effectDuration, setEffectDuration] = useState(0.48);
  const [previewSymbol, setPreviewSymbol] = useState(0);
  const [shaderSymbol, setShaderSymbol] = useState(0);
  const [feedbackSymbol, setFeedbackSymbol] = useState(0);
  const [shaderEffects, setShaderEffects] = useState<ShaderEffects>({ flash: true, zoom: true, shake: true, negative: false, redEdge: true });
  const [fragmentShader, setFragmentShader] = useState(() => {
    try { return localStorage.getItem('infinitefap.fragmentShader') || DEFAULT_FRAGMENT_SHADER; }
    catch { return DEFAULT_FRAGMENT_SHADER; }
  });
  const [shaderNotice, setShaderNotice] = useState('Shader 将在浏览器 WebGL 中即时编译');
  const shaderFileRef = useRef<HTMLInputElement>(null);
  const timelineViewportRef = useRef<HTMLDivElement>(null);
  const timelineDragRef = useRef<{ pointerId: number; x: number; offset: number; moved: boolean; seekOnClick: boolean } | null>(null);
  const transportDragRef = useRef<{ pointerId: number; x: number; moved: boolean } | null>(null);
  const importSlotsRef = useRef(0);
  const importWaitersRef = useRef<Array<() => void>>([]);
  const triggeredExplosionPointsRef = useRef<Set<string>>(new Set());
  const explosionTimerRef = useRef<number | undefined>(undefined);
  const fullscreenTargetRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoElementsRef = useRef(new Map<string, HTMLVideoElement>());
  const videoElementRefsRef = useRef(new Map<string, { current: HTMLVideoElement | null }>());
  const videoElementCallbacksRef = useRef(new Map<string, (element: HTMLVideoElement | null) => void>());
  const warmedVideoUrlsRef = useRef(new Set<string>());
  const warmedTransitionKeysRef = useRef(new Set<string>());
  const videoWarmupTaskRef = useRef<Promise<boolean> | null>(null);
  const videoWarmupAbortRef = useRef<AbortController | null>(null);
  const videoSyncRef = useRef({ playing: false });
  const activeVideoSyncKeysRef = useRef(new WeakMap<HTMLVideoElement, string>());
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const urlRef = useRef('');
  const samplesRef = useRef<Float32Array | undefined>(undefined);
  const backgroundUrlsRef = useRef<string[]>([]);
  const beatCursorRef = useRef(0);
  const lastPlayheadRef = useRef(0);
  const keyReleaseTimerRef = useRef<number | undefined>(undefined);
  const noteReleaseTimerRef = useRef<number | undefined>(undefined);
  const hitStopUntilRef = useRef(0);
  const hitStopTimeRef = useRef(0);
  function getVideoElementHandle(id: string) {
    let elementRef = videoElementRefsRef.current.get(id);
    if (!elementRef) {
      elementRef = { current: null };
      videoElementRefsRef.current.set(id, elementRef);
    }
    return elementRef;
  }
  function getVideoElementRef(id: string) {
    const elementRef = getVideoElementHandle(id);
    let callback = videoElementCallbacksRef.current.get(id);
    if (!callback) {
      callback = (element) => {
        elementRef!.current = element;
        if (element) videoElementsRef.current.set(id, element);
        else {
          videoElementsRef.current.delete(id);
          videoElementRefsRef.current.delete(id);
          videoElementCallbacksRef.current.delete(id);
        }
        setVideoPoolVersion((version) => version + 1);
      };
      videoElementCallbacksRef.current.set(id, callback);
    }
    return callback;
  }
  const pressKey = useCallback(() => {
    setPressedKey(true);
    setKeyPressSequence((sequence) => sequence + 1);
    window.clearTimeout(keyReleaseTimerRef.current);
    keyReleaseTimerRef.current = window.setTimeout(() => setPressedKey(false), HIT_STOP_MS + 35);
  }, []);
  const notes = useMemo<Note[]>(() => beats.map((beat, id) => ({ id, time: beat.time, type: 'tap' })), [beats]);
  const tempo = useMemo(() => {
    const intervals = beats.slice(1).map((beat, index) => beat.time - beats[index].time).filter((value) => value > 0);
    if (!intervals.length) return 0;
    intervals.sort((a, b) => a - b);
    return Math.round(60 / intervals[Math.floor(intervals.length / 2)]);
  }, [beats]);
  const visibleNotes = notes.filter((note) => !hitNotes.has(note.id) && note.time >= currentTime - 0.8 && note.time <= currentTime + 3.2);
  const waveformBars = useMemo(() => waveform.map((height, index) => <i key={index} style={{ height: `${Math.max(3, height * 34)}px` }} />), [waveform]);
  const icon = NOTE_ICONS.find((item) => item.id === noteIcon) ?? NOTE_ICONS[0];
  const selectedNoteColor = NOTE_COLORS.find((color) => color.id === noteColor) ?? NOTE_COLORS[0];
  const timelineNoteElements = useMemo(() => notes.map((note) => <span className="chart-note" key={note.id} style={{ left: `${duration ? (note.time / duration) * 100 : 0}%` }} title={`${note.time.toFixed(2)} 秒`}><img src={`${ICON_BASE}${icon.id}.svg`} alt="" style={{ filter: selectedNoteColor.filter }} /></span>), [notes, duration, icon.id, selectedNoteColor.filter]);
  const selectedBackground = backgrounds.find((video) => video.id === backgroundId);
  const analysisSettingsStale = backgrounds.some((video) => video.analysisMode !== analysisMode || video.analysisThreshold !== sceneThreshold || video.analysisMinClipLength !== minClipLength);
  const orderedBackgrounds = useMemo(() => {
    const videosById = new Map(backgrounds.map((video) => [video.id, video]));
    const ids = [...videoOrder, ...backgrounds.map((video) => video.id).filter((id) => !videoOrder.includes(id))];
    return ids.flatMap((id) => videosById.get(id) ?? []);
  }, [backgrounds, videoOrder]);
  const queueEntries = useMemo(() => {
    return orderedBackgrounds.flatMap((video) => {
      return video.clips.flatMap((clip) => {
        const key = clipQueueKey(video.id, clip.id);
        return enabledClips[key] === false || key === explosionClipKey ? [] : [{ mediaId: video.id, clip, queueKey: key, name: video.name }];
      });
    });
  }, [enabledClips, explosionClipKey, orderedBackgrounds]);
  const configuredExplosionScene = useMemo<ExplosionScene | null>(() => {
    for (const video of orderedBackgrounds) {
      const id = video.id;
      const clip = video?.clips.find((item) => clipQueueKey(id, item.id) === explosionClipKey);
      if (!video || !clip) continue;
      const clipIndex = queueEntries.findIndex((entry) => entry.queueKey === explosionClipKey);
      const range = getClipPlaybackRange(clip, clipStartModes[explosionClipKey] ?? 'middle', clipCustomPositions[explosionClipKey] ?? 0.5, transitionDuration, seededRandom((randomSeed + Math.max(0, clipIndex)) >>> 0));
      return { mediaId: id, clip, playbackStart: range.start, playbackEnd: range.end };
    }
    return null;
  }, [clipCustomPositions, clipStartModes, explosionClipKey, orderedBackgrounds, queueEntries, randomSeed, transitionDuration]);
  const canvasSize = CANVAS_PRESETS[canvasPreset];
  const canvasAspect = canvasSize.width / canvasSize.height;
  const stageMaxHeight = viewport.height * (viewport.width < 700 ? 0.62 : 0.72);
  const stageWidth = Math.min(830, Math.max(280, viewport.width - 48), stageMaxHeight * canvasAspect);
  const stageStyle = { width: `${stageWidth}px`, height: `${stageWidth / canvasAspect}px`, '--stage-aspect': canvasAspect } as CSSProperties;
  const randomizedQueue = useMemo(() => randomizeQueue(queueEntries, randomizationMode, seededRandom(randomSeed)), [queueEntries, randomizationMode, randomSeed]);
  const arrangement = useMemo<ArrangementItem[]>(() => {
    if (arrangementMode !== 'auto' || !duration || !randomizedQueue.length) return [];
    const starts = [0];
    let lastStart = 0;
    for (const note of notes) {
      if (note.time - lastStart >= minClipLength && note.time < duration) {
        starts.push(note.time);
        lastStart = note.time;
      }
    }
    return starts.map((start, index) => {
      const queueIndex = index % randomizedQueue.length;
      const candidateIndex = randomizedQueue.length > 1 && index > 0 && randomizedQueue[queueIndex].queueKey === randomizedQueue[(index - 1) % randomizedQueue.length].queueKey
        ? (queueIndex + 1) % randomizedQueue.length
        : queueIndex;
      const candidate = randomizedQueue[candidateIndex];
      const end = starts[index + 1] ?? duration;
      const mode = clipStartModes[candidate.queueKey] ?? 'middle';
      const range = getClipPlaybackRange(candidate.clip, mode, clipCustomPositions[candidate.queueKey] ?? 0.5, transitionDuration, seededRandom((randomSeed + index) >>> 0));
      return { start, end, mediaId: candidate.mediaId, clip: candidate.clip, queueKey: candidate.queueKey, playbackStart: range.start, playbackEnd: range.end };
    });
  }, [arrangementMode, clipCustomPositions, clipStartModes, duration, minClipLength, notes, randomSeed, randomizedQueue, transitionDuration]);
  const arrangementIndex = arrangementMode === 'auto' ? findFirstIntervalEndingAfter(arrangement, videoTime) : -1;
  const currentArrangement = arrangementIndex >= 0 && arrangement[arrangementIndex]?.start <= videoTime ? arrangement[arrangementIndex] : undefined;
  const activeArrangement = currentArrangement;
  const incomingArrangement = explosionActive || arrangementIndex < 0 ? undefined : arrangement[arrangementIndex + 1];
  const incomingTransitionDuration = activeArrangement && incomingArrangement
    ? Math.max(0, Math.min(transitionDuration, activeArrangement.clip.end - activeArrangement.playbackEnd, incomingArrangement.playbackStart - incomingArrangement.clip.start, incomingArrangement.end - incomingArrangement.start))
    : 0;
  const directCycleDuration = backgrounds.reduce((total, video) => total + video.duration, 0);
  const directPlayback = useMemo(() => {
    if (!backgrounds.length || !directCycleDuration) return undefined;
    let remaining = videoTime % directCycleDuration;
    for (const video of orderedBackgrounds) {
      if (remaining < video.duration) return { video, offset: remaining };
      remaining -= video.duration;
    }
    return { video: orderedBackgrounds[0], offset: 0 };
  }, [videoTime, directCycleDuration, orderedBackgrounds]);
  const activeVideo = explosionActive && explosionScene
    ? backgrounds.find((item) => item.id === explosionScene.mediaId)
    : activeArrangement ? backgrounds.find((item) => item.id === activeArrangement.mediaId) : arrangementMode === 'none' ? directPlayback?.video : selectedBackground;
  const incomingVideo = incomingArrangement ? backgrounds.find((item) => item.id === incomingArrangement.mediaId) : undefined;
  const incomingVideoRef = useMemo(() => incomingVideo && incomingVideo.id !== activeVideo?.id ? getVideoElementHandle(incomingVideo.id) : { current: null }, [incomingVideo?.id, activeVideo?.id]);
  const incomingPreRollLead = 1.25;
  const incomingPreRollStart = incomingArrangement ? Math.max(incomingArrangement.clip.start, incomingArrangement.playbackStart - incomingTransitionDuration - incomingPreRollLead) : 0;
  const incomingTransitionAt = incomingArrangement ? incomingArrangement.start - incomingTransitionDuration : 0;
  const incomingPreRollAt = incomingArrangement ? incomingTransitionAt - Math.max(0, incomingArrangement.playbackStart - incomingTransitionDuration - incomingPreRollStart) : 0;
  const incomingTargetTime = incomingArrangement ? Math.min(incomingArrangement.playbackStart, incomingPreRollStart + Math.max(0, videoTime - incomingPreRollAt)) : 0;
  const incomingElement = incomingVideoRef.current;
  const incomingFrameReady = Boolean(incomingVideo && incomingVideo.id !== activeVideo?.id && incomingElement?.currentSrc === incomingVideo.url && incomingElement.readyState >= 2 && !incomingElement.seeking && Math.abs(incomingElement.currentTime - incomingTargetTime) < 0.35);
  const isVideoTransitioning = Boolean(!explosionActive && arrangementMode === 'auto' && activeArrangement && incomingArrangement && incomingFrameReady && incomingTransitionDuration > 0 && videoTime >= incomingTransitionAt && videoTime < incomingArrangement.start);
  const transitionElapsed = isVideoTransitioning && incomingArrangement ? Math.max(0, videoTime - incomingTransitionAt) : 0;
  const transitionWarmupPlan = useMemo(() => {
    const plan: { key: string; mediaId: string; start: number; end: number }[] = [];
    const seen = new Set<string>();
    for (let index = 1; index < arrangement.length; index += 1) {
      const previous = arrangement[index - 1];
      const next = arrangement[index];
      if (previous.mediaId === next.mediaId) continue;
      const length = Math.max(0, Math.min(transitionDuration, previous.clip.end - previous.playbackEnd, next.playbackStart - next.clip.start, next.end - next.start));
      if (!length) continue;
      const start = Math.max(next.clip.start, next.playbackStart - length);
      const key = `${next.mediaId}:${next.clip.id}:${start.toFixed(3)}:${next.playbackStart.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ key, mediaId: next.mediaId, start, end: next.playbackStart });
    }
    return plan;
  }, [arrangement, transitionDuration]);
  const primaryVideoRef = useMemo(() => activeVideo ? getVideoElementHandle(activeVideo.id) : { current: null }, [activeVideo?.id]);
  videoSyncRef.current = { playing };
  const timelineDuration = duration || directCycleDuration || selectedBackground?.duration || 0;
  const directTimeline = useMemo<ArrangementItem[]>(() => {
    if (!backgrounds.length || !timelineDuration) return [];
    const items: ArrangementItem[] = [];
    let start = 0;
    while (start < timelineDuration) {
      for (const video of orderedBackgrounds) {
        if (start >= timelineDuration) break;
        const end = Math.min(timelineDuration, start + video.duration);
        const clip = video.clips[0];
        if (clip) items.push({ start, end, mediaId: video.id, clip, queueKey: clipQueueKey(video.id, clip.id), playbackStart: 0, playbackEnd: video.duration });
        start = end;
      }
    }
    return items;
  }, [orderedBackgrounds, timelineDuration]);
  const timelineContentWidth = Math.max(timelineViewportWidth, timelineViewportWidth * timelineZoom);
  const timelineClips = useMemo(() => (arrangementMode === 'auto'
    ? arrangement.map((item, index) => ({ ...item, id: `${item.mediaId}-${item.clip.id}-${index}`, name: backgrounds.find((video) => video.id === item.mediaId)?.name ?? '视频片段' }))
    : directTimeline.map((item, index) => ({ ...item, id: `direct-${item.mediaId}-${index}`, name: backgrounds.find((video) => video.id === item.mediaId)?.name ?? '视频片段' }))).filter((item) => item.start < timelineDuration && item.end > 0), [arrangement, arrangementMode, backgrounds, directTimeline, timelineDuration]);
  const timelinePixelsPerSecond = timelineDuration > 0 ? timelineContentWidth / timelineDuration : 0;
  const visibleTimelineClips = useMemo(() => {
    if (!timelineViewportWidth || !timelinePixelsPerSecond) return timelineClips;
    const visibleStart = Math.max(0, -timelineOffset) / timelinePixelsPerSecond;
    const visibleEnd = Math.min(timelineDuration, (Math.max(0, -timelineOffset) + timelineViewportWidth) / timelinePixelsPerSecond);
    const first = findFirstIntervalEndingAfter(timelineClips, visibleStart);
    const visible: typeof timelineClips = [];
    for (let index = first; index < timelineClips.length && timelineClips[index].start < visibleEnd; index += 1) visible.push(timelineClips[index]);
    return visible;
  }, [timelineClips, timelineDuration, timelineOffset, timelinePixelsPerSecond, timelineViewportWidth]);
  const timelineStep = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((step) => step * timelinePixelsPerSecond >= 76) ?? 300;
  const timelineTicks = timelineDuration > 0 ? Array.from({ length: Math.floor(timelineDuration / timelineStep) + 1 }, (_, index) => index * timelineStep) : [];

  useEffect(() => () => {
    workerRef.current?.terminate();
    window.clearTimeout(keyReleaseTimerRef.current);
    window.clearTimeout(noteReleaseTimerRef.current);
    window.clearTimeout(explosionTimerRef.current);
    void audioContextRef.current?.close();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    backgroundUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === fullscreenTargetRef.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (!debugOpen) return;
    let frame = 0;
    let windowStart = performance.now();
    let frames = 0;
    let totalFrameMs = 0;
    let slowFrames = 0;
    let previousTime = 0;
    const update = () => {
      const now = performance.now();
      const interval = previousTime ? now - previousTime : 0;
      previousTime = now;
      frames += 1;
      if (Number.isFinite(interval) && interval > 0) {
        totalFrameMs += interval;
        if (interval > 25) slowFrames += 1;
      }
      if (now - windowStart >= 500) {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
        const elapsed = Math.max(1, now - windowStart);
        const stats = { fps: frames * 1000 / elapsed, frameMs: totalFrameMs / Math.max(1, frames - 1), slowFrames, heapMb: memory / (1024 * 1024) };
        setPerformanceStats((current) => ({ ...current, ...stats }));
        windowStart = now;
        frames = 0;
        totalFrameMs = 0;
        slowFrames = 0;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [debugOpen]);

  useEffect(() => {
    setPerformanceStats((current) => ({ ...current, videoFps: 0 }));
    if (!debugOpen || !playing) return;
    const video = primaryVideoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (callback: (now: number, metadata: { presentedFrames: number }) => void) => number; cancelVideoFrameCallback?: (handle: number) => void }) | null;
    let videoCallback = 0;
    let videoStart = 0;
    let previousPresented = 0;
    const onVideoFrame = (now: number, metadata: { presentedFrames: number }) => {
      if (!videoStart) { videoStart = now; previousPresented = metadata.presentedFrames; }
      if (now - videoStart >= 1000) {
        const videoFrames = metadata.presentedFrames - previousPresented;
        const fps = videoFrames * 1000 / (now - videoStart);
        setPerformanceStats((current) => ({ ...current, videoFps: fps }));
        videoStart = now;
        previousPresented = metadata.presentedFrames;
      }
      if (video && !video.paused && video.requestVideoFrameCallback) videoCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    if (playing && video?.requestVideoFrameCallback) videoCallback = video.requestVideoFrameCallback(onVideoFrame);
    return () => {
      if (videoCallback && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoCallback);
    };
  }, [debugOpen, playing, activeVideo?.id]);

  useEffect(() => {
    const element = timelineViewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setTimelineViewportWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [audioFile]);

  useEffect(() => {
    setTimelineZoom(1);
    setTimelineOffset(0);
  }, [audioFile]);

  useEffect(() => {
    setTimelineOffset((offset) => Math.max(timelineViewportWidth - timelineContentWidth, Math.min(0, offset)));
  }, [timelineContentWidth, timelineViewportWidth]);

  useEffect(() => {
    setVideoWarmupRequested(false);
    setWarmedVideoUrls(new Set());
    setWarmedTransitionKeys(new Set());
    warmedVideoUrlsRef.current = new Set();
    warmedTransitionKeysRef.current = new Set();
    setVideoWarmupProgress({ done: 0, total: backgrounds.length + transitionWarmupPlan.length, running: false, error: '' });
  }, [backgrounds, transitionWarmupPlan]);

  useEffect(() => {
    if (!backgrounds.length || !videoWarmupRequested || videoWarmupTaskRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    videoWarmupAbortRef.current = controller;
    const task = (async () => {
      const total = backgrounds.length + transitionWarmupPlan.length;
      const originals = new Map<string, number>();
      const updateProgress = () => setVideoWarmupProgress({ done: warmedVideoUrlsRef.current.size + warmedTransitionKeysRef.current.size, total, running: true, error: '' });
      setVideoWarmupProgress({ done: warmedVideoUrlsRef.current.size + warmedTransitionKeysRef.current.size, total, running: true, error: '' });
      try {
        for (const background of backgrounds) {
          if (cancelled) return false;
          if (warmedVideoUrlsRef.current.has(background.url)) continue;
          const video = videoElementsRef.current.get(background.id);
          if (!video) throw new Error(`播放器尚未就绪：${background.name}`);
          originals.set(background.id, video.currentTime);
          if (video.currentSrc !== background.url) {
            video.preload = 'auto';
            const metadata = video.readyState >= 1 ? Promise.resolve() : waitForVideoEvent(video, 'loadedmetadata', controller.signal);
            video.src = background.url;
            video.load();
            await metadata;
          }
          if (video.readyState < 2) await waitForVideoEvent(video, 'loadeddata', controller.signal);
          const seekTarget = Math.min(0.1, Math.max(0, video.duration - 0.01));
          if (Math.abs(video.currentTime - seekTarget) > 0.05) {
            const seeked = waitForVideoEvent(video, 'seeked', controller.signal);
            video.currentTime = seekTarget;
            await seeked;
          }
          if (video.readyState < 2) await waitForVideoEvent(video, 'loadeddata', controller.signal);
          if (cancelled) return false;
          warmedVideoUrlsRef.current.add(background.url);
          setWarmedVideoUrls(new Set(warmedVideoUrlsRef.current));
          updateProgress();
        }
        for (const transition of transitionWarmupPlan) {
          if (cancelled) return false;
          if (warmedTransitionKeysRef.current.has(transition.key)) continue;
          const video = videoElementsRef.current.get(transition.mediaId);
          if (!video) throw new Error('转场播放器尚未就绪');
          originals.set(transition.mediaId, video.currentTime);
          for (const target of [transition.start, transition.end]) {
            if (Math.abs(video.currentTime - target) < 0.04) continue;
            const seeked = waitForVideoEvent(video, 'seeked', controller.signal);
            video.currentTime = Math.min(target, video.duration - 0.01);
            await seeked;
            if (video.readyState < 2) await waitForVideoEvent(video, 'loadeddata', controller.signal);
          }
          if (cancelled) return false;
          warmedTransitionKeysRef.current.add(transition.key);
          setWarmedTransitionKeys(new Set(warmedTransitionKeysRef.current));
          updateProgress();
        }
        if (!cancelled) {
          for (const [id, time] of originals) {
            const video = videoElementsRef.current.get(id);
            if (video && Math.abs(video.currentTime - time) > 0.04) video.currentTime = Math.min(time, video.duration - 0.01);
          }
        }
        return true;
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setVideoWarmupProgress({ done: warmedVideoUrlsRef.current.size + warmedTransitionKeysRef.current.size, total, running: false, error: message });
          setNotice(`视频预热失败：${message}`);
        }
        return false;
      }
    })();
    videoWarmupTaskRef.current = task;
    void task.then((success) => {
      if (!cancelled && success) {
        setVideoWarmupProgress({ done: backgrounds.length + transitionWarmupPlan.length, total: backgrounds.length + transitionWarmupPlan.length, running: false, error: '' });
        setVideoSeekSequence((sequence) => sequence + 1);
      }
      if (!cancelled) setVideoWarmupRequested(false);
    }).finally(() => {
      videoWarmupTaskRef.current = null;
      if (videoWarmupAbortRef.current === controller) videoWarmupAbortRef.current = null;
    });
    return () => { cancelled = true; controller.abort(); };
  }, [backgrounds, transitionWarmupPlan, videoWarmupRequested]);

  useEffect(() => {
    const video = primaryVideoRef.current;
    if (!video || !activeVideo) {
      video?.pause();
      return;
    }
    const syncKey = explosionActive && explosionScene
      ? `${activeVideo.url}:${explosionScene.clip.id}:${activeExplosionTime ?? ''}:${explosionScene.playbackStart}:${videoSeekSequence}`
      : activeArrangement
      ? `${activeVideo.url}:${activeArrangement.clip.id}:${activeArrangement.start}:${activeArrangement.playbackStart}:${videoSeekSequence}`
      : `${activeVideo.url}:direct:${arrangementMode === 'none' ? Math.floor((audioRef.current?.currentTime ?? 0) / Math.max(0.01, directCycleDuration)) : ''}:${videoSeekSequence}`;
    const sync = () => {
      const { playing: shouldPlay } = videoSyncRef.current;
      if (shouldInitializeVideoSync(activeVideoSyncKeysRef.current.get(video), syncKey) && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
        const playhead = audioRef.current?.currentTime ?? videoTime;
        const clipStart = explosionActive && explosionScene && activeExplosionTime !== null ? activeExplosionTime : activeArrangement?.start;
        const clipPlaybackStart = explosionActive && explosionScene ? explosionScene.playbackStart : activeArrangement?.playbackStart;
        let target = clipStart !== undefined && clipPlaybackStart !== undefined
          ? getClipPlaybackTime(clipPlaybackStart, video.duration, clipStart, playhead)
          : playhead;
        if (clipStart === undefined && arrangementMode === 'none' && directCycleDuration > 0) {
          let offset = playhead % directCycleDuration;
          for (const source of orderedBackgrounds) {
            if (source.id === activeVideo.id) { target = offset; break; }
            offset -= source.duration;
          }
        }
        const targetTime = Math.min(target, video.duration - 0.01);
        if (Math.abs(video.currentTime - targetTime) > 0.04) video.currentTime = targetTime;
        activeVideoSyncKeysRef.current.set(video, syncKey);
      }
      if (!shouldPlay) video.pause();
      else if (video.paused) void video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('loadeddata', sync);
    video.addEventListener('canplay', sync);
    sync();
    return () => {
      if (video !== primaryVideoRef.current && video !== incomingVideoRef.current) video.pause();
      video.removeEventListener('loadedmetadata', sync);
      video.removeEventListener('loadeddata', sync);
      video.removeEventListener('canplay', sync);
    };
  }, [activeVideo?.url, activeVideo?.id, activeArrangement?.clip.id, activeArrangement?.start, activeArrangement?.playbackStart, activeArrangement?.playbackEnd, explosionScene?.clip.id, activeExplosionTime, explosionActive, playing, videoSeekSequence, primaryVideoRef, incomingVideoRef, arrangementMode, directCycleDuration, orderedBackgrounds]);

  useEffect(() => {
    const video = incomingVideoRef.current;
    if (!video || !incomingVideo || !incomingArrangement) {
      video?.pause();
      return;
    }
    const preRollAt = incomingPreRollAt;
    let frame = 0;
    const syncKey = `${incomingVideo.url}:${incomingArrangement.clip.id}:${incomingArrangement.start}:${incomingArrangement.playbackStart}:${videoSeekSequence}`;
    const sync = () => {
      const time = audioRef.current?.currentTime ?? videoTime;
      if (shouldInitializeVideoSync(activeVideoSyncKeysRef.current.get(video), syncKey) && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
        const targetTime = Math.min(incomingArrangement.playbackStart, incomingPreRollStart + Math.max(0, time - preRollAt));
        const boundedTarget = Math.min(targetTime, video.duration - 0.01);
        if (Math.abs(video.currentTime - boundedTarget) > 0.04) video.currentTime = boundedTarget;
        activeVideoSyncKeysRef.current.set(video, syncKey);
      }
      const shouldPlay = playing && time >= preRollAt && time < incomingArrangement.start;
      if (shouldPlay) {
        if (video.paused) void video.play().catch(() => {});
      } else {
        video.pause();
        if (playing && time < preRollAt) frame = requestAnimationFrame(sync);
      }
    };
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('loadeddata', sync);
    video.addEventListener('canplay', sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      if (video !== primaryVideoRef.current && video !== incomingVideoRef.current) video.pause();
      video.removeEventListener('loadedmetadata', sync);
      video.removeEventListener('loadeddata', sync);
      video.removeEventListener('canplay', sync);
    };
  }, [incomingVideo?.url, incomingArrangement?.clip.id, incomingArrangement?.start, incomingArrangement?.playbackStart, incomingPreRollAt, incomingPreRollStart, incomingTransitionDuration, playing, incomingVideoRef, primaryVideoRef, videoSeekSequence]);

  useEffect(() => {
    if (!notice || busy) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 2800);
    return () => window.clearTimeout(timer);
  }, [notice, busy]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    let last = 0;
    const update = (now: number) => {
      const time = audioRef.current?.currentTime ?? 0;
      const nextExplosion = explosionPoints.find((point) => !triggeredExplosionPointsRef.current.has(point.id));
      if (nextExplosion) {
        const remaining = nextExplosion.time - time;
        if (remaining > 0 && remaining <= 5) setExplosionCountdown(Math.ceil(remaining));
        else setExplosionCountdown(null);
        if (remaining <= 0) {
          triggeredExplosionPointsRef.current.add(nextExplosion.id);
          setExplosionCountdown(null);
          setActiveExplosionTime(nextExplosion.time);
          setExplosionScene(configuredExplosionScene);
          setExplosionActive(true);
          setExplosionSequence((sequence) => sequence + 1);
          window.clearTimeout(explosionTimerRef.current);
          explosionTimerRef.current = window.setTimeout(() => setExplosionActive(false), explosionDuration * 1000);
        }
      } else setExplosionCountdown(null);
      while (beatCursorRef.current < beats.length && beats[beatCursorRef.current].time <= time) {
        const beat = beats[beatCursorRef.current];
        if (beat.time >= lastPlayheadRef.current - 0.025 && time - beat.time < 0.12) {
          const hitNoteId = beatCursorRef.current;
          hitStopTimeRef.current = beat.time;
          hitStopUntilRef.current = now + HIT_STOP_MS;
          setCurrentTime(beat.time);
          setFrozenNoteId(hitNoteId);
          window.clearTimeout(noteReleaseTimerRef.current);
          noteReleaseTimerRef.current = window.setTimeout(() => {
            setHitNotes((previous) => new Set(previous).add(hitNoteId));
            setCombo((current) => current + 1);
            setFrozenNoteId((current) => current === hitNoteId ? null : current);
          }, HIT_STOP_MS);
          pressKey();
          setShaderSymbol(0);
          setFeedbackSymbol(0);
          setHitSequence((sequence) => sequence + 1);
          if (hitSoundEnabled && audioContextRef.current?.state === 'running') {
            const context = audioContextRef.current;
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'triangle';
            oscillator.frequency.setValueAtTime(1420, context.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(680, context.currentTime + 0.035);
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.13, context.currentTime + 0.003);
            gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.06);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.065);
          }
        } else setCombo(0);
        beatCursorRef.current += 1;
      }
      lastPlayheadRef.current = time;
      const displayedTime = now < hitStopUntilRef.current ? hitStopTimeRef.current : time;
      // Keep beat detection on RAF, but avoid reconciling the large waveform tree at 60 Hz.
      if (now - last >= 33) {
        if (audioRef.current) setCurrentTime(displayedTime);
        setVideoTime(time);
        last = now;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing, beats, hitSoundEnabled, pressKey, explosionPoints, explosionDuration, configuredExplosionScene]);

  function startModel(samples: Float32Array, level: Difficulty) {
    workerRef.current?.terminate();
    const worker = new Worker(new URL('./audio/beat.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const result = event.data;
      if (result.type === 'status') setNotice(result.message);
      if (result.type === 'result') {
        const nextBeats = result.beats.map((time) => ({ time }));
        setHitNotes(new Set());
        setCombo(0);
        beatCursorRef.current = findNextBeat(nextBeats, audioRef.current?.currentTime ?? 0);
        lastPlayheadRef.current = audioRef.current?.currentTime ?? 0;
        setBeats(nextBeats);
        setBackend(result.backend);
        setNotice(`铺面生成完成 · ${result.beats.length} 个 Note`);
        setBusy(false);
      }
      if (result.type === 'error') {
        setNotice(`TCN 推理失败：${result.message}`);
        setBusy(false);
      }
    };
    worker.onerror = (event) => {
      setNotice(`模型工作线程异常：${event.message}`);
      setBusy(false);
    };
    const transferable = samples.slice();
    const config = DIFFICULTIES[level];
    worker.postMessage({ samples: transferable.buffer, threshold: config.threshold, minInterval: config.minInterval }, [transferable.buffer]);
  }

  async function loadMusic(file?: File) {
    if (!file) return;
    workerRef.current?.terminate();
    audioRef.current?.pause();
    setPlaying(false);
    setBusy(true);
    setBeats([]);
    setHitNotes(new Set());
    setCombo(0);
    setExplosionPoints([]);
    setActiveExplosionTime(null);
    setExplosionCountdown(null);
    setExplosionActive(false);
    setExplosionScene(null);
    window.clearTimeout(explosionTimerRef.current);
    triggeredExplosionPointsRef.current.clear();
    setHitSequence(0);
    setFeedbackSymbol(0);
    setCurrentTime(0);
    setVideoTime(0);
    setNotice('正在解码音乐…');
    try {
      if (audioContextRef.current?.state !== 'closed') await audioContextRef.current?.close();
      const context = new AudioContext();
      audioContextRef.current = context;
      const decoded = await decodeAudioFile(file, context);
      setDuration(decoded.buffer.duration);
      setWaveform(makeWaveform(decoded.buffer));
      setAudioFile(file);
      void saveAudioHistory(file).then(() => listAudioHistory()).then(setAudioHistory).catch(() => {});
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(decoded.playable);
      setAudioUrl(urlRef.current);
      const samples = await resampleToMono22050(decoded.buffer);
      samplesRef.current = samples;
      setNotice('载入模型并分析节拍…');
      startModel(samples, difficulty);
    } catch (error) {
      setNotice(`音乐读取失败：${error instanceof Error ? error.message : String(error)}`);
      setBusy(false);
    }
  }

  async function importOnlineAudio() {
    const url = onlineAudioUrl.trim();
    if (!url) return;
    setAudioImportBusy(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
      const blob = await response.blob();
      const path = new URL(url).pathname;
      const name = decodeURIComponent(path.split('/').pop() || 'online-audio') || 'online-audio';
      if (!blob.type.startsWith('audio/') && !/\.(mp3|wav|flac|m4a|ogg|aac|opus)$/i.test(path)) throw new Error('链接返回的内容不是音频文件');
      const type = blob.type.startsWith('audio/') ? blob.type : 'audio/octet-stream';
      await loadMusic(new File([blob], name, { type }));
      setAudioPanelOpen(false);
    } catch (error) {
      setNotice(`在线音频导入失败：${error instanceof Error ? error.message : String(error)}（音频服务器需允许跨域访问）`);
    } finally { setAudioImportBusy(false); }
  }

  async function togglePlayback() {
    if (!audioRef.current || !audioUrl) return;
    if (playing) {
      audioRef.current.pause();
      videoElementsRef.current.forEach((video) => video.pause());
      setPlaying(false);
      return;
    }
    if (videoWarmupProgress.running) {
      videoWarmupAbortRef.current?.abort();
      setVideoWarmupRequested(false);
      setVideoWarmupProgress((progress) => ({ ...progress, running: false }));
      setVideoSeekSequence((sequence) => sequence + 1);
    }
    try {
      await audioContextRef.current?.resume();
      const time = audioRef.current.currentTime;
      setVideoTime(time);
      beatCursorRef.current = findNextBeat(beats, Math.max(0, time - 0.025));
      lastPlayheadRef.current = time - 0.025;
      await audioRef.current.play();
      setPlaying(true);
    } catch {
      setNotice('浏览器暂时无法播放这首音乐，请再次点击播放');
    }
  }

  function seekTo(time: number) {
    const seekDuration = duration || timelineDuration;
    const next = Math.max(0, Math.min(seekDuration, time));
    setCurrentTime(next);
    setVideoTime(next);
    setVideoSeekSequence((sequence) => sequence + 1);
    setHitNotes(new Set(notes.filter((note) => note.time < next - 0.025).map((note) => note.id)));
    setCombo(0);
    setExplosionCountdown(null);
    setExplosionActive(false);
    setActiveExplosionTime(null);
    setExplosionScene(null);
    window.clearTimeout(explosionTimerRef.current);
    triggeredExplosionPointsRef.current = new Set(explosionPoints.filter((point) => point.time < next).map((point) => point.id));
    beatCursorRef.current = findNextBeat(beats, next + 0.005);
    lastPlayheadRef.current = next;
    if (audioRef.current) audioRef.current.currentTime = next;
  }

  function applyQueueSettings(mode: RandomizationMode, seed = randomSeed) {
    const time = audioRef.current?.currentTime ?? videoTime;
    setRandomizationMode(mode);
    setRandomSeed(seed);
    setRandomSeedDraft(String(seed));
    setVideoTime(time);
    setVideoSeekSequence((sequence) => sequence + 1);
  }

  function previewVideoClip(video: BackgroundVideo, clip: VideoClip) {
    const videoIndex = orderedBackgrounds.findIndex((item) => item.id === video.id);
    const offset = orderedBackgrounds.slice(0, Math.max(0, videoIndex)).reduce((total, item) => total + item.duration, 0);
    setBackgroundId(video.id);
    setArrangementMode('none');
    setVideoTime(offset + clip.start);
    setVideoSeekSequence((sequence) => sequence + 1);
  }

  function addExplosionAtPlayhead() {
    setExplosionPoints((points) => [...points, { id: crypto.randomUUID(), time: currentTime }].sort((a, b) => a.time - b.time));
    setExplosionCountdown(null);
    setExplosionActive(false);
    setExplosionScene(null);
    window.clearTimeout(explosionTimerRef.current);
  }

  function removeExplosionPoint(id: string) {
    setExplosionPoints((points) => points.filter((point) => point.id !== id));
    triggeredExplosionPointsRef.current.delete(id);
  }

  async function toggleFullscreen() {
    const target = fullscreenTargetRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (target.requestFullscreen) await target.requestFullscreen();
      else setNotice('当前浏览器不支持舞台全屏');
    } catch { setNotice('浏览器拒绝了全屏请求'); }
  }

  async function addBackgroundVideos(files: FileList | null) {
    if (!files?.length) return;
    const filesToImport = Array.from(files);
    const tasks = filesToImport.map((file) => ({ id: crypto.randomUUID(), name: file.name, progress: 0, backend: '等待中' }));
    setImportTasks((current) => [...current, ...tasks]);
    await Promise.all(tasks.map(async (task, index) => {
      if (importSlotsRef.current >= 2) await new Promise<void>((resolve) => importWaitersRef.current.push(resolve));
      importSlotsRef.current += 1;
      const file = filesToImport[index];
      try {
        const cached = await readClipCache(file, sceneThreshold, minClipLength, analysisMode);
        let backendName = cached?.backend ?? 'WebGPU';
        const analysis = cached ?? await detectVideoClips(
          file,
          sceneThreshold,
          minClipLength,
          (progress) => setImportTasks((current) => current.map((item) => item.id === task.id ? { ...item, progress } : item)),
          (backend) => {
            backendName = backend;
            setVideoBackend(backend);
            setImportTasks((current) => current.map((item) => item.id === task.id ? { ...item, backend } : item));
          },
          analysisMode,
        );
        setImportTasks((current) => current.map((item) => item.id === task.id ? { ...item, progress: 1, backend: backendName } : item));
        const cacheWritten = cached || await writeClipCache(file, sceneThreshold, minClipLength, { ...analysis, backend: backendName }, analysisMode);
        await saveVideoHistory({ id: `${file.name}:${file.size}:${file.lastModified}`, kind: 'video', name: file.name, file, analysisMode, threshold: sceneThreshold, minClipLength }).catch(() => {});
        const url = URL.createObjectURL(file);
        backgroundUrlsRef.current.push(url);
        const video: BackgroundVideo = { id: task.id, name: file.name, file, url, duration: analysis.duration, clips: analysis.clips, analysisMode, analysisThreshold: sceneThreshold, analysisMinClipLength: minClipLength };
        setBackgrounds((current) => [...current, video]);
        setVideoOrder((current) => [...current, video.id]);
        setEnabledClips((current) => ({ ...current, ...Object.fromEntries(video.clips.map((clip) => [clipQueueKey(video.id, clip.id), true])) }));
        setBackgroundId((current) => current || video.id);
        setVideoBackend(backendName);
        setNotice(`已导入 ${file.name} · ${analysis.clips.length} 个片段 · ${backendName}${cacheWritten ? ' / 已缓存' : ' / 缓存不可用'}`);
      } catch (error) {
        setNotice(`${file.name} 导入失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        importSlotsRef.current -= 1;
        importWaitersRef.current.shift()?.();
        setImportTasks((current) => current.filter((item) => item.id !== task.id));
      }
    }));
  }

  async function resliceVideos() {
    if (!backgrounds.length) return;
    setVideoBusy(true);
    setVideoProgress(0);
    setNotice('正在重新识别视频并更新缓存…');
    try {
      const updated: BackgroundVideo[] = [];
      let cacheWritten = true;
      for (const [index, video] of backgrounds.entries()) {
        let backendName = 'WebGPU';
        const result = await detectVideoClips(video.file, sceneThreshold, minClipLength, (progress) => setVideoProgress((index + progress) / backgrounds.length), (backend) => { backendName = backend; setVideoBackend(backend); }, analysisMode);
        cacheWritten = await writeClipCache(video.file, sceneThreshold, minClipLength, { ...result, backend: backendName }, analysisMode) && cacheWritten;
        updated.push({ ...video, duration: result.duration, clips: result.clips, analysisMode, analysisThreshold: sceneThreshold, analysisMinClipLength: minClipLength });
      }
      setBackgrounds(updated);
      await Promise.all(updated.map((video) => saveVideoHistory({ id: `${video.file.name}:${video.file.size}:${video.file.lastModified}`, kind: 'video', name: video.name, file: video.file, analysisMode, threshold: sceneThreshold, minClipLength }).catch(() => {})));
      setNotice(`重新识别完成，共 ${updated.reduce((sum, video) => sum + video.clips.length, 0)} 个片段；${cacheWritten ? '结果已缓存' : '浏览器缓存不可用'}`);
    } catch (error) {
      setNotice(`重新识别失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVideoBusy(false);
    }
  }

  async function refreshClipCache() {
    if (!backgrounds.length) return;
    setVideoBusy(true);
    let restored = 0;
    try {
      const refreshed = await Promise.all(backgrounds.map(async (video) => {
        const cached = await readClipCache(video.file, sceneThreshold, minClipLength, analysisMode);
        if (!cached) return video;
        restored += 1;
        setVideoBackend(cached.backend);
        return { ...video, duration: cached.duration, clips: cached.clips, analysisMode: cached.mode, analysisThreshold: sceneThreshold, analysisMinClipLength: minClipLength };
      }));
      setBackgrounds(refreshed);
      setNotice(restored ? `已从浏览器缓存刷新 ${restored} 个视频分析结果` : '当前阈值没有缓存结果，请点击“重新识别”');
    } finally {
      setVideoBusy(false);
    }
  }

  function removeBackground(videoId: string) {
    const video = backgrounds.find((item) => item.id === videoId);
    if (!video) return;
    URL.revokeObjectURL(video.url);
    backgroundUrlsRef.current = backgroundUrlsRef.current.filter((url) => url !== video.url);
    const next = backgrounds.filter((item) => item.id !== videoId);
    setBackgrounds(next);
    setVideoOrder((order) => order.filter((id) => id !== videoId));
    const removedKeys = new Set(video.clips.map((clip) => clipQueueKey(video.id, clip.id)));
    if (removedKeys.has(explosionClipKey)) setExplosionClipKey('');
    setEnabledClips((enabled) => Object.fromEntries(Object.entries(enabled).filter(([key]) => !removedKeys.has(key))));
    if (backgroundId === videoId) setBackgroundId(next[0]?.id ?? '');
    void deleteVideoHistory(video.file).catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [audioItems, videoItems] = await Promise.all([listAudioHistory().catch(() => []), listVideoHistory().catch(() => [])]);
      if (cancelled) return;
      setAudioHistory(audioItems);
      if (audioItems[0]) void loadMusic(audioItems[0].file);
      const restored: (BackgroundVideo | undefined)[] = await Promise.all(videoItems.map(async (item): Promise<BackgroundVideo | undefined> => {
        const cached = await readClipCache(item.file, item.threshold, item.minClipLength, item.analysisMode);
        if (!cached) return undefined;
        const url = URL.createObjectURL(item.file);
        backgroundUrlsRef.current.push(url);
        return { id: crypto.randomUUID(), name: item.name, file: item.file, url, duration: cached.duration, clips: cached.clips, analysisMode: cached.mode, analysisThreshold: item.threshold, analysisMinClipLength: item.minClipLength } satisfies BackgroundVideo;
      }));
      if (cancelled) {
        restored.forEach((video) => { if (video) URL.revokeObjectURL(video.url); });
        return;
      }
      const videos = restored.filter((video): video is BackgroundVideo => Boolean(video));
      if (videos.length) {
        setBackgrounds(videos);
        setVideoOrder(videos.map((video) => video.id));
        setEnabledClips(Object.fromEntries(videos.flatMap((video) => video.clips.map((clip) => [clipQueueKey(video.id, clip.id), true]))));
        setBackgroundId(videos[0].id);
        setVideoBackend('IndexedDB 缓存');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function moveVideoInQueue(videoId: string, direction: -1 | 1) {
    setVideoOrder((order) => {
      const index = order.indexOf(videoId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return order;
      const updated = [...order];
      [updated[index], updated[target]] = [updated[target], updated[index]];
      return updated;
    });
  }

  async function importShader(file?: File) {
    if (!file) return;
    if (file.size > 128 * 1024) {
      setShaderNotice('Shader 文件过大：最大支持 128 KB');
      return;
    }
    const source = await file.text();
    setFragmentShader(source);
    setShaderNotice(`已载入 ${file.name}，正在 WebGL 中校验…`);
  }

  function saveShader() {
    try {
      localStorage.setItem('infinitefap.fragmentShader', fragmentShader);
      setShaderNotice('Shader 已保存到此浏览器');
    } catch {
      setShaderNotice('浏览器存储空间不足，无法保存 Shader');
    }
  }

  function downloadShader() {
    const url = URL.createObjectURL(new Blob([fragmentShader], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'infinitefap-effect.frag';
    link.click();
    URL.revokeObjectURL(url);
    setShaderNotice('已下载当前 Shader 源码');
  }

  function seekFromTransport(event: PointerEvent<HTMLDivElement>) {
    if (!duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  }

  function startTransportDrag(event: PointerEvent<HTMLDivElement>) {
    transportDragRef.current = { pointerId: event.pointerId, x: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTransportDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = transportDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
    if (drag.moved) seekFromTransport(event);
  }

  function endTransportDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = transportDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) seekFromTransport(event);
    transportDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleTimelineWheel(event: WheelEvent<HTMLDivElement>) {
    if (!timelineViewportWidth || !timelineDuration) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const nextZoom = Math.max(0.5, Math.min(16, timelineZoom * Math.exp(-event.deltaY * 0.002)));
    const timelineX = (pointerX - timelineOffset) / timelineZoom;
    const nextWidth = timelineViewportWidth * nextZoom;
    setTimelineOffset(Math.max(timelineViewportWidth - nextWidth, Math.min(0, pointerX - timelineX * nextZoom)));
    setTimelineZoom(nextZoom);
  }

  function handleTimelinePointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button,input,label') || !timelineDuration) return;
    timelineDragRef.current = { pointerId: event.pointerId, x: event.clientX, offset: timelineOffset, moved: false, seekOnClick: Boolean((event.target as HTMLElement).closest('.chart-timeline-ruler')) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleTimelinePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = timelineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.x;
    if (Math.abs(delta) > 3) drag.moved = true;
    if (!drag.moved) return;
    const minOffset = timelineViewportWidth - timelineContentWidth;
    setTimelineOffset(Math.max(minOffset, Math.min(0, drag.offset + delta)));
  }

  function handleTimelinePointerUp(event: PointerEvent<HTMLDivElement>) {
    const drag = timelineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    timelineDragRef.current = null;
    if (!drag.moved && drag.seekOnClick && timelineDuration > 0) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      seekTo(Math.max(0, Math.min(timelineDuration, (x - timelineOffset) / timelinePixelsPerSecond)));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const position = (time: number) => duration ? `${(time / duration) * 100}%` : '0%';
  const laneStyle = { '--lane-size': `${noteLayout === 'horizontal' ? laneHeightPercent : laneWidthPercent}%`, '--lane-opacity': laneOpacity } as CSSProperties;
  const transitionAnimationStyle = { animationDuration: `${incomingTransitionDuration}s`, animationDelay: `${-transitionElapsed}s`, animationPlayState: playing ? 'running' : 'paused' } as CSSProperties;

  return (
    <div className="rhythm-app">
      <header className="rhythm-topbar">
        <a className="rhythm-brand" href="#top"><span><AudioLines size={17} /></span>infinite<span className="brand-accent">fap</span></a>
        <div className="rhythm-breadcrumb">音乐游戏铺面预览 <i>/</i> <strong>单轨模式</strong></div>
        <div className="local-indicator"><span />浏览器本地运行</div>
      </header>

      <main className="rhythm-main" id="top">
        <section className="rhythm-intro">
          <div className="eyebrow"><Sparkles size={13} /> RHYTHM CHART PREVIEW</div>
          <h1>让音乐，<em>看得见。</em></h1>
          <p>导入一首歌，AI 节拍模型会为你生成一条单轨 Note 铺面。现在开始预览你的音乐律动。</p>
        </section>

        <section className="rhythm-workspace">
          <div className="game-topline">
            <div className="track-identity"><div className="track-art"><Music2 size={19} /></div><div><strong>{audioFile?.name ?? '尚未载入音乐'}</strong><span>{audioFile ? `${formatTime(duration)} · 单轨铺面` : '支持 MP3、WAV、FLAC、M4A'}</span></div></div>
          </div>

          <div ref={fullscreenTargetRef} className={`game-stage ${hitSequence ? 'has-hit' : ''}`} style={stageStyle}>
            <ShaderCanvas videoRef={primaryVideoRef} videoSource={activeVideo?.url ?? ''} playing={playing} fillMode={fillMode} outputWidth={canvasSize.width} outputHeight={canvasSize.height} effectSequence={hitSequence} intensity={effectIntensity} symbol={shaderSymbol} duration={effectDuration} effects={shaderEffects} blastSequence={explosionSequence} blastIntensity={explosionIntensity} blastDuration={explosionDuration} blastEffects={blastShaderEffects} fragmentSource={fragmentShader} />
            {backgrounds.map((video) => {
              const isActive = video.id === activeVideo?.id;
              const isIncoming = video.id === incomingVideo?.id;
              const isOutgoing = isVideoTransitioning && isActive;
              const showIncoming = isVideoTransitioning && isIncoming;
              const nextToWarm = backgrounds.find((item) => !warmedVideoUrls.has(item.url));
              const warmupThisVideo = videoWarmupRequested && nextToWarm?.id === video.id;
              return <video key={video.id} ref={getVideoElementRef(video.id)} className={`stage-background-source ${isOutgoing ? `scene-transition scene-transition-${transitionPreset}` : ''}`} src={video.url} muted loop={arrangementMode !== 'auto'} playsInline preload={isActive || isIncoming || warmupThisVideo ? 'auto' : 'metadata'} onLoadedData={() => setVideoPoolVersion((version) => version + 1)} onSeeked={() => setVideoPoolVersion((version) => version + 1)} style={{ objectFit: fillMode === 'cover' ? 'cover' : fillMode === 'contain' ? 'contain' : 'fill', opacity: isActive || showIncoming ? 1 : 0, zIndex: isOutgoing ? 2 : showIncoming ? 1 : 0, ...(isOutgoing ? transitionAnimationStyle : {}) }} />;
            })}
            <div className="stage-video-shade" />
            {explosionCountdown !== null && explosionCountdown > 0 && <div key={`countdown-${explosionCountdown}`} className="explosion-countdown"><span>爆点倒计时</span><strong>{explosionCountdown}</strong></div>}
            {explosionActive && <div key={`explosion-${explosionSequence}`} className={`explosion-effect explosion-${explosionStyle}`} style={{ '--explosion-intensity': explosionIntensity, '--explosion-duration': `${explosionDuration}s` } as CSSProperties}><i /><b>MAXIMUM</b></div>}
            <div className="stage-hud"><span className="model-chip"><span className="model-pulse" />TCN · {backend}</span><div className="stage-hud-actions">{combo > 0 && <span className="combo-chip" aria-live="polite">{combo} COMBO</span>}{showRemaining && audioFile && <span className="remaining-time">{formatTime(Math.max(0, duration - currentTime))}</span>}<button className={`hud-toggle ${showRemaining ? 'enabled' : ''}`} aria-label={showRemaining ? '隐藏剩余时间' : '显示剩余时间'} title={showRemaining ? '隐藏剩余时间' : '显示剩余时间'} onClick={() => setShowRemaining(!showRemaining)}>{showRemaining ? <Timer size={14} /> : <TimerOff size={14} />}</button><button className={`hud-toggle ${hitSoundEnabled ? 'enabled' : ''}`} aria-label={hitSoundEnabled ? '关闭打击音' : '开启打击音'} title={hitSoundEnabled ? '关闭打击音' : '开启打击音'} onClick={() => setHitSoundEnabled(!hitSoundEnabled)}>{hitSoundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}</button><button className="hud-toggle stage-fullscreen-button" aria-label={isFullscreen ? '退出全屏' : '全屏播放'} title={isFullscreen ? '退出全屏' : '全屏播放'} onClick={() => void toggleFullscreen()}>{isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}</button><button className="help-chip" title="预览会自动判定节拍并累计连击；简单难度减少密集 Note，同时保留可连续命中的节拍。"><CircleHelp size={15} /></button></div></div>
            <div className="stage-side-label side-left">SINGLE TRACK</div>
            {!audioFile && <div className="lane-empty"><div><Music2 size={25} /></div><strong>谱面将在这里出现</strong><span>导入音乐，生成你的第一条铺面</span></div>}
            {audioFile && notes.length === 0 && !busy && <div className="lane-empty"><strong>还没有检测到节拍</strong><span>可切换铺面难度后重新生成</span></div>}
            <div className={`game-lane layout-${noteLayout}`} style={laneStyle}>
              <div className="lane-lights" />
              <div className="lane-centerline" />
              <button className={`lane-judgement judgement-${noteLayout} ${pressedKey ? 'key-pressed' : ''}`} onPointerDown={pressKey} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); pressKey(); } }} aria-label="点按判定键"><span key={keyPressSequence} className="key-cap"><img src={`${ICON_BASE}heart-outline.svg`} alt="" style={{ filter: selectedNoteColor.filter }} /></span><i /></button>
              {visibleNotes.map((note) => {
                const delta = note.time - currentTime;
                const notePosition = getNotePosition(noteLayout, delta);
                const noteStyle = noteLayout === 'vertical'
                  ? { top: `${notePosition}%` }
                  : { left: `${notePosition}%`, top: '50%' };
                return <div key={note.id} data-note-id={note.id} className={`falling-note ${Math.abs(delta) < 0.11 ? 'on-beat' : ''} ${frozenNoteId === note.id ? 'hit-stop-note' : ''}`} style={noteStyle}><img src={`${ICON_BASE}${icon.id}.svg`} alt="" style={{ filter: selectedNoteColor.filter }} /></div>;
              })}
              {hitSequence > 0 && <><div key={`burst-${hitSequence}`} className={`hit-burst symbol-${feedbackSymbol}`} /><div key={`perfect-${hitSequence}`} className={`perfect-feedback symbol-${feedbackSymbol}`}>{JUDGEMENT_TYPES[feedbackSymbol]}</div></>}
              {busy && <div className="stage-loading"><span className="loading-ring" />{notice}</div>}
            </div>
            <div className="stage-side-label side-right">{tempo ? `${tempo} BPM` : '— BPM'}</div>
            <div className="stage-bottom-info"><span><span className="live-dot" />{playing ? 'PLAYING' : 'PREVIEW'}</span><span>{notes.length ? `${notes.length} NOTES` : 'WAITING FOR TRACK'}</span></div>
          </div>

          <div className="transport">
            <button className="transport-play" onClick={() => void togglePlayback()} disabled={!audioFile || busy} aria-label={playing ? '暂停' : '播放'}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
            <span className="transport-clock">{formatTime(currentTime)} <i>/</i> {formatTime(duration)}</span>
            <div className="transport-seek" onPointerDown={startTransportDrag} onPointerMove={moveTransportDrag} onPointerUp={endTransportDrag} onPointerCancel={endTransportDrag} role="slider" aria-label="音频播放进度" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={currentTime}><span style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} /></div>
            <Volume2 size={15} className="volume-icon" />
            <span className="transport-bpm">{tempo || '--'} <small>BPM</small></span>
          </div>

          <div className="chart-panel">
            <div className="chart-heading"><div><span className="section-kicker">FULL CHART</span><h2>单轨铺面</h2></div><div className="chart-actions"><button className={`explosion-point-button ${explosionPoints.length ? 'active' : ''}`} disabled={!audioFile} onClick={addExplosionAtPlayhead}><Crosshair size={13} />添加爆点 {explosionPoints.length ? `(${explosionPoints.length})` : ''}</button><label className="difficulty-control">难度<select aria-label="铺面难度" value={difficulty} onChange={(event) => setDifficulty(event.target.value as keyof typeof DIFFICULTIES)}>{Object.entries(DIFFICULTIES).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></label><button className="reanalyze-button" disabled={busy || !samplesRef.current} onClick={() => { if (samplesRef.current) { setBusy(true); setNotice(`正在按${DIFFICULTIES[difficulty].label}难度重新生成铺面…`); startModel(samplesRef.current, difficulty); } }}>重新铺面</button></div></div>
            {explosionPoints.length > 0 && <div className="explosion-point-list">{explosionPoints.map((point, index) => <button key={point.id} onClick={() => seekTo(point.time)} title="跳转到爆点">{index + 1} · {formatTime(point.time)}<span onClick={(event) => { event.stopPropagation(); removeExplosionPoint(point.id); }} role="button" aria-label={`删除爆点 ${index + 1}`}><X size={11} /></span></button>)}</div>}
            <div className="video-warmup-control"><button type="button" disabled={!backgrounds.length || playing || videoWarmupProgress.running || videoWarmupProgress.total > 0 && videoWarmupProgress.done >= videoWarmupProgress.total} onClick={() => { setVideoWarmupProgress((progress) => ({ ...progress, running: false, error: '' })); setVideoWarmupRequested(true); }}><Film size={13} />{videoWarmupProgress.running ? '正在预热影片与转场…' : videoWarmupProgress.total > 0 && videoWarmupProgress.done >= videoWarmupProgress.total ? '影片与转场已预热' : videoWarmupProgress.error ? '重试预热影片与转场' : '播放前预热影片与转场'}</button><span>{videoWarmupProgress.error || (backgrounds.length ? `${videoWarmupProgress.done}/${videoWarmupProgress.total || backgrounds.length + transitionWarmupPlan.length} 项完成（${warmedVideoUrls.size}/${backgrounds.length} 个影片，${warmedTransitionKeys.size}/${transitionWarmupPlan.length} 段转场）` : '导入影片后可在播放前预热')}</span><div className="video-warmup-progress" role="progressbar" aria-label="影片和转场预热进度" aria-valuemin={0} aria-valuemax={videoWarmupProgress.total || backgrounds.length + transitionWarmupPlan.length} aria-valuenow={videoWarmupProgress.done}><i style={{ width: `${(videoWarmupProgress.total || backgrounds.length + transitionWarmupPlan.length) ? (videoWarmupProgress.done / (videoWarmupProgress.total || backgrounds.length + transitionWarmupPlan.length)) * 100 : 0}%` }} /></div></div>
            <div className="chart-timeline-viewport" ref={timelineViewportRef} onWheel={handleTimelineWheel} onPointerDown={handleTimelinePointerDown} onPointerMove={handleTimelinePointerMove} onPointerUp={handleTimelinePointerUp} onPointerCancel={handleTimelinePointerUp} style={{ cursor: timelineDragRef.current?.moved ? 'grabbing' : 'grab' }}>
              <div className="chart-timeline-content" style={{ width: `${timelineContentWidth}px`, transform: `translateX(${timelineOffset}px)` }}>
                <div className="chart-ruler chart-timeline-ruler">{timelineTicks.map((tick) => <span key={tick} style={{ left: `${timelineDuration ? (tick / timelineDuration) * 100 : 0}%` }}>{formatTime(tick)}</span>)}{timelineDuration > 0 && explosionPoints.map((point, index) => <span key={point.id} className="explosion-timeline-marker" style={{ left: `${Math.min(100, (point.time / timelineDuration) * 100)}%` }} title={`爆点 ${index + 1} · ${formatTime(point.time)}`}><Zap size={11} />{index + 1}</span>)}</div>
                <div className="video-timeline-lane" aria-label="视频分镜轨道">
                  {visibleTimelineClips.map((item) => {
                    const start = Math.max(0, item.start);
                    const end = Math.min(timelineDuration, item.end);
                    if (end <= start) return null;
                    const widthPercent = Math.max(0.35, ((end - start) / timelineDuration) * 100);
                    const widthPixels = timelineContentWidth * (end - start) / timelineDuration;
                    const active = arrangementMode === 'auto'
                      ? (currentArrangement?.queueKey === item.queueKey || isVideoTransitioning && incomingArrangement?.queueKey === item.queueKey) && videoTime >= item.start - (isVideoTransitioning && incomingArrangement?.queueKey === item.queueKey ? incomingTransitionDuration : 0) && videoTime < item.end
                      : videoTime >= item.start && videoTime < item.end;
                    return <button key={item.id} className={`video-timeline-clip ${active ? 'active' : ''} ${widthPixels < 56 ? 'compact' : widthPixels < 82 ? 'thumbnail-only' : ''}`} style={{ left: `${(start / timelineDuration) * 100}%`, width: `${widthPercent}%` }} title={`${item.name} · ${formatTime(start)}–${formatTime(end)}`} onClick={() => { setBackgroundId(item.mediaId); seekTo(start); }}><img src={item.clip.thumbnail} alt="" /><span>{item.name}</span><small>{formatTime(end - start)}</small></button>;
                  })}
                  {!timelineClips.length && <span className="video-timeline-empty">导入视频后显示分镜片段</span>}
                  {timelineDuration > 0 && <span className="timeline-playhead video-timeline-playhead" style={{ left: `${Math.min(100, (videoTime / timelineDuration) * 100)}%` }} />}
                </div>
                <div className="chart-track chart-timeline-audio">
                  <div className="chart-waveform">{waveformBars}</div>
                  {timelineNoteElements}
                  {duration > 0 && <span className="chart-playhead" style={{ left: position(currentTime) }} />}
                  {!audioFile && <span className="chart-placeholder">导入音乐后显示波形与 Note</span>}
                </div>
              </div>
            </div>
            {timelineDuration > 0 && <div className="timeline-zoom-hint">滚轮缩放刻度 · 拖动平移/音轨定位 · 点击刻度跳转</div>}
            <div className="chart-footer"><span><span className="legend-heart">♥</span> {icon.label} Note <b>× {notes.length}</b></span><span>ONNX Runtime Web · {backend}</span></div>
          </div>

          <audio ref={audioRef} src={audioUrl || undefined} onEnded={() => { setPlaying(false); setExplosionCountdown(null); videoElementsRef.current.forEach((video) => video.pause()); }} />
        </section>

        {audioPanelOpen && <aside className="audio-side-panel" aria-label="音频素材">
          <div className="video-panel-heading"><div><span className="section-kicker">AUDIO LIBRARY</span><h2><Music2 size={16} />音频</h2></div><button className="menu-close" onClick={() => setAudioPanelOpen(false)} aria-label="关闭音频面板"><X size={17} /></button></div>
          <div className="audio-panel-tabs" role="tablist" aria-label="音频分类"><button role="tab" aria-selected={audioPanelTab === 'select'} className={audioPanelTab === 'select' ? 'active' : ''} onClick={() => setAudioPanelTab('select')}>音频选择</button><button role="tab" aria-selected={audioPanelTab === 'import'} className={audioPanelTab === 'import' ? 'active' : ''} onClick={() => setAudioPanelTab('import')}>音频导入</button><button role="tab" aria-selected={audioPanelTab === 'online'} className={audioPanelTab === 'online' ? 'active' : ''} onClick={() => setAudioPanelTab('online')}>在线音频</button></div>
          {audioPanelTab === 'select' && <div className="audio-panel-content"><div className="audio-current-item"><strong>当前音频</strong><span>{audioFile?.name ?? '尚未选择音频'}</span></div>{audioHistory.length ? audioHistory.map((item) => <div className={`audio-history-item ${audioFile?.name === item.name ? 'active' : ''}`} key={item.id}><button onClick={() => { void loadMusic(item.file); setAudioPanelOpen(false); }}><Music2 size={14} /><span>{item.name}</span><small>{new Date(item.savedAt).toLocaleDateString()}</small></button><button className="audio-history-remove" aria-label={`删除历史音频 ${item.name}`} onClick={() => { void deleteAudioHistory(item.file).then(() => listAudioHistory()).then(setAudioHistory).catch(() => {}); }}><X size={12} /></button></div>) : <p className="video-setting-help">导入过的音频会自动加入本机历史记录，下次打开时自动恢复最近一首。</p>}</div>}
          {audioPanelTab === 'import' && <div className="audio-panel-content"><label className="video-dropzone"><input type="file" accept="audio/*,.flac,.m4a,.mp3,.wav" disabled={audioImportBusy} onChange={(event) => { void loadMusic(event.target.files?.[0]); event.currentTarget.value = ''; setAudioPanelOpen(false); }} /><Upload size={19} /><strong>{audioImportBusy ? '正在导入…' : '选择音频文件'}</strong><span>MP3 · WAV · FLAC · M4A；文件保存在此浏览器的 IndexedDB</span></label></div>}
          {audioPanelTab === 'online' && <div className="audio-panel-content"><label className="online-audio-input">音频直链<input type="url" value={onlineAudioUrl} placeholder="https://example.com/audio.mp3" onChange={(event) => setOnlineAudioUrl(event.target.value)} /></label><button className="reslice-button" disabled={!onlineAudioUrl.trim() || audioImportBusy} onClick={() => void importOnlineAudio()}><Music2 size={14} />导入在线音频</button><p className="video-setting-help">使用可直接下载的音频文件 URL；目标站点必须允许跨域请求（CORS）。不会从未指定的音乐平台搜索或绕过访问限制。</p></div>}
        </aside>}

        <footer className="rhythm-footer"><span><Check size={13} /> 音频仅在本地分析，不会上传</span><span>TCN beat-detection · MIT <i>·</i> Note icons: Material Design Icons / Apache-2.0</span></footer>
        {videoPanelOpen && <aside className="video-side-panel" aria-label="视频素材和排片">
          <div className="video-panel-heading"><div><span className="section-kicker">VIDEO CLIPS</span><h2><Film size={16} />视频素材</h2></div><button className="menu-close" onClick={() => setVideoPanelOpen(false)} aria-label="关闭视频面板"><X size={17} /></button></div>
          <div className="video-panel-tabs" role="tablist" aria-label="视频面板分类"><button role="tab" aria-selected={videoPanelTab === 'import'} className={videoPanelTab === 'import' ? 'active' : ''} onClick={() => setVideoPanelTab('import')}>导入</button><button role="tab" aria-selected={videoPanelTab === 'manage'} className={videoPanelTab === 'manage' ? 'active' : ''} onClick={() => setVideoPanelTab('manage')}>素材管理</button><button role="tab" aria-selected={videoPanelTab === 'arrange'} className={videoPanelTab === 'arrange' ? 'active' : ''} onClick={() => setVideoPanelTab('arrange')}>排片</button></div>
          {videoPanelTab === 'import' ? <div className="video-panel-content" role="tabpanel" aria-label="导入视频">
            <label className="video-dropzone"><input type="file" accept="video/mp4,video/webm,video/quicktime,.mov" multiple onChange={(event) => { void addBackgroundVideos(event.target.files); event.currentTarget.value = ''; }} /><Upload size={19} /><strong>导入视频素材</strong><span>MP4 · WebM · MOV；导入过程中仍可继续添加，最多同时分析 2 个</span></label>
            {importTasks.length > 0 && <div className="video-import-tasks">{importTasks.map((task) => <div className="video-import-task" key={task.id}><span>{task.name}</span><small>{task.backend} · {Math.round(task.progress * 100)}%</small><i><b style={{ width: `${task.progress * 100}%` }} /></i></div>)}</div>}
            {videoBusy && <div className="video-progress" aria-label="重新识别进度"><span style={{ width: `${videoProgress * 100}%` }} /></div>}
            <label className="arrangement-source">场景分析算法<select value={analysisMode} onChange={(event) => setAnalysisMode(event.target.value as AnalysisMode)}><option value="hybrid">GPU 帧差 + 灰度直方图复合（推荐最快）</option><option value="frame-difference">GPU 帧差</option><option value="histogram">GPU 灰度直方图差分</option></select></label>
            <label className="menu-range">排片阈值<input type="range" min="0.02" max="0.75" step="0.01" value={sceneThreshold} onChange={(event) => setSceneThreshold(Number(event.target.value))} /><b>{sceneThreshold.toFixed(2)}</b></label><p className="video-setting-help">Motion Score 阈值，越低越容易切出新片段。</p>
            <label className="menu-range">分析最小片段长度<input type="range" min="0.2" max="10" step="0.1" value={minClipLength} onChange={(event) => setMinClipLength(Number(event.target.value))} /><b>{minClipLength.toFixed(1)}s</b></label>
            {analysisSettingsStale && <p className="video-setting-help">分析设置与已有素材不同；点击“重新识别”应用到现有素材。</p>}
            <div className="opencv-status"><span className="opencv-dot" />{analysisMode === 'hybrid' ? '帧差 65% + 灰度直方图差异 35%' : analysisMode === 'frame-difference' ? '帧差平均值' : '256-bin 灰度直方图差异'} · 2 FPS · 320×180 · WebGPU 优先，CPU 回退</div>
            {backgrounds.length > 0 && <div className="video-cache-actions"><button disabled={videoBusy} onClick={() => void refreshClipCache()}><RefreshCw size={13} />刷新缓存</button><button disabled={videoBusy} onClick={() => void resliceVideos()}><Scissors size={13} />重新识别</button><span>IndexedDB · {videoBackend}</span></div>}
            {backgrounds.length === 0 && !videoBusy && !importTasks.length && <div className="video-panel-empty"><Scissors size={20} /><span>每秒抽 2 帧并生成片段动感分数；可在导入页调整分析算法和阈值。</span></div>}
          </div> : videoPanelTab === 'manage' ? <div className="video-panel-content" role="tabpanel" aria-label="素材管理">
            <label className="menu-range">一键禁用短于<input type="number" min="0.1" max="60" step="0.1" value={shortClipThreshold} onChange={(event) => setShortClipThreshold(Math.max(0.1, Number(event.target.value) || 0.1))} /><b>秒的片段</b></label>
            <button className="reslice-button" disabled={!backgrounds.length} onClick={() => setEnabledClips((current) => ({ ...current, ...Object.fromEntries(backgrounds.flatMap((video) => video.clips.filter((clip) => isShortClip(clip, shortClipThreshold)).map((clip) => [clipQueueKey(video.id, clip.id), false]))) }))}>一键禁用短片段（{backgrounds.reduce((sum, video) => sum + video.clips.filter((clip) => isShortClip(clip, shortClipThreshold)).length, 0)} 段）</button>
            <p className="video-setting-help">仅影响自动排片队列，不删除素材；“无排片”模式仍播放完整视频。</p>
            <div className="video-assets-list">{orderedBackgrounds.map((video) => {
              const videoIndex = videoOrder.indexOf(video.id);
              return <details className="video-asset-card" key={video.id} open><summary><span className="video-asset-name">{video.name}</span><span>队列 {videoIndex + 1} · {video.clips.length} 段 · {formatTime(video.duration)}</span><div className="video-order-controls"><button type="button" disabled={videoIndex <= 0} title="影片队列提前" aria-label={`${video.name} 队列提前`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); moveVideoInQueue(video.id, -1); }}><ArrowUp size={12} /></button><button type="button" disabled={videoIndex < 0 || videoIndex >= backgrounds.length - 1} title="影片队列延后" aria-label={`${video.name} 队列延后`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); moveVideoInQueue(video.id, 1); }}><ArrowDown size={12} /></button></div><button type="button" className="video-remove" aria-label={`移除 ${video.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeBackground(video.id); }}><X size={13} /></button></summary><div className="video-clip-grid">{video.clips.map((clip, index) => {
              const key = clipQueueKey(video.id, clip.id);
              const startMode = clipStartModes[key] ?? 'middle';
              return <div key={clip.id} className={`video-clip-card ${backgroundId === video.id ? 'selected' : ''} ${enabledClips[key] === false ? 'disabled' : ''}`}>
                <button className="video-clip-preview" onClick={() => previewVideoClip(video, clip)} title={`${clip.start.toFixed(2)}–${clip.end.toFixed(2)} 秒 · 动感 ${clip.motion.toFixed(2)}`}><img src={clip.thumbnail} alt="" /><span>片段 {index + 1}</span><small>{formatTime(clip.end - clip.start)} · 动感 {clip.motion.toFixed(2)}</small></button>
                <div className="video-clip-controls"><label><input type="checkbox" checked={enabledClips[key] !== false && explosionClipKey !== key} disabled={explosionClipKey === key} onChange={(event) => setEnabledClips((current) => ({ ...current, [key]: event.target.checked }))} />普通排片</label><label className="explosion-clip-toggle"><input type="checkbox" checked={explosionClipKey === key} onChange={(event) => setExplosionClipKey(event.target.checked ? key : '')} />爆点专用</label><label>起播位置<select value={startMode} onChange={(event) => setClipStartModes((current) => ({ ...current, [key]: event.target.value as ClipStartMode }))}><option value="middle">中间</option><option value="random">随机</option><option value="custom">自定义</option></select></label>{startMode === 'custom' && <label className="clip-position-range"><span>{Math.round((clipCustomPositions[key] ?? 0.5) * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={clipCustomPositions[key] ?? 0.5} onChange={(event) => setClipCustomPositions((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>}</div>
              </div>;
            })}</div></details>;
            })}</div>
          </div> : <div className="video-panel-content" role="tabpanel" aria-label="视频排片">
            <section className="video-setting-block"><h3>排片模式</h3><div className="arrangement-options"><button className={arrangementMode === 'none' ? 'active' : ''} onClick={() => setArrangementMode('none')}>无排片 · 列表循环</button><button className={arrangementMode === 'auto' ? 'active' : ''} onClick={() => setArrangementMode('auto')}>自动排片</button></div><p>{arrangementMode === 'auto' ? `使用勾选片段按节拍排片 · 已选 ${queueEntries.length} 段 · 当前 ${arrangement.length} 段` : '按导入顺序连续循环播放完整影片，不裁切为场景片段。'}</p></section>
            {arrangementMode === 'auto' && <section className="video-setting-block"><h3>自动队列顺序</h3><div className="arrangement-options randomization-options"><button className={randomizationMode === 'ordered' ? 'active' : ''} onClick={() => applyQueueSettings('ordered')}>影片顺序</button><button className={randomizationMode === 'grouped' ? 'active' : ''} onClick={() => applyQueueSettings('grouped')}><Shuffle size={12} />影片分组随机</button><button className={randomizationMode === 'all' ? 'active' : ''} onClick={() => applyQueueSettings('all')}><Shuffle size={12} />片段完全随机</button><button className={randomizationMode === 'motion' ? 'active' : ''} onClick={() => applyQueueSettings('motion')}>运动优先</button></div><div className="seed-controls"><label>随机种子<input type="number" min="0" max="4294967295" step="1" value={randomSeedDraft} onChange={(event) => setRandomSeedDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { const seed = Number(randomSeedDraft); if (Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff) applyQueueSettings(randomizationMode, seed); } }} /></label><button onClick={() => applyQueueSettings(randomizationMode, makeRandomSeed())}><RefreshCw size={12} />换种子并应用</button></div><button className="reslice-button" disabled={!Number.isSafeInteger(Number(randomSeedDraft)) || Number(randomSeedDraft) < 0 || Number(randomSeedDraft) > 0xffffffff} onClick={() => applyQueueSettings(randomizationMode, Number(randomSeedDraft))}>应用种子</button><p>{randomizationMode === 'ordered' ? '按影片队列顺序播放；相同种子可复现随机起播位置。' : randomizationMode === 'grouped' ? '同种子会复现影片分组顺序及随机起播位置。' : randomizationMode === 'motion' ? '按片段平均 Motion Score 排序；随机起播位置仍由种子控制。' : '同种子会复现所有片段的随机顺序及随机起播位置。'}</p></section>}
            <section className="video-transition-settings"><h3>片段转场</h3><div className="transition-preset-grid">{TRANSITION_PRESETS.map((preset) => <button key={preset.id} className={transitionPreset === preset.id ? 'active' : ''} onClick={() => setTransitionPreset(preset.id)}>{preset.label}</button>)}</div><label className="menu-range">转场时长<input type="range" min="0.1" max="2" step="0.05" value={transitionDuration} onChange={(event) => setTransitionDuration(Number(event.target.value))} /><b>{transitionDuration.toFixed(2)}s</b></label></section>
          </div>}
        </aside>}
        {notice && <div className={`rhythm-toast ${busy ? 'is-busy' : ''}`} role="status">{busy && <span className="toast-spinner" />}{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
        {menuOpen && <section className="main-menu-panel" aria-label="铺面主体菜单">
          <div className="menu-panel-heading"><div><span className="section-kicker">PLAYFIELD SETTINGS</span><h2><Settings2 size={16} />主体菜单</h2></div><button className="menu-close" onClick={() => setMenuOpen(false)} aria-label="关闭菜单"><X size={17} /></button></div>

          <div className="menu-tabs" role="tablist" aria-label="主体菜单分类"><button role="tab" aria-selected={menuTab === 'chart'} className={menuTab === 'chart' ? 'active' : ''} onClick={() => setMenuTab('chart')}>琴谱设置</button><button role="tab" aria-selected={menuTab === 'effects'} className={menuTab === 'effects' ? 'active' : ''} onClick={() => setMenuTab('effects')}>命中特效</button><button role="tab" aria-selected={menuTab === 'blast'} className={menuTab === 'blast' ? 'active' : ''} onClick={() => setMenuTab('blast')}>爆点特效</button><button role="tab" aria-selected={menuTab === 'video'} className={menuTab === 'video' ? 'active' : ''} onClick={() => setMenuTab('video')}>视频显示</button></div>
          {menuTab === 'chart' && <>
          <section className="menu-section"><h3>Note 位置</h3><div className="layout-options"><button className={noteLayout === 'horizontal' ? 'active' : ''} onClick={() => setNoteLayout('horizontal')}><span className="layout-preview horizontal"><i /><b /></span><span>底部横条</span></button><button className={noteLayout === 'vertical' ? 'active' : ''} onClick={() => setNoteLayout('vertical')}><span className="layout-preview vertical"><i /><b /></span><span>中央竖轨</span></button></div>
            <label className="menu-range lane-size-range">{noteLayout === 'horizontal' ? '轨道高度' : '轨道宽度'} <input type="range" min={noteLayout === 'horizontal' ? 8 : 20} max="75" step="1" value={noteLayout === 'horizontal' ? laneHeightPercent : laneWidthPercent} onChange={(event) => noteLayout === 'horizontal' ? setLaneHeightPercent(Number(event.target.value)) : setLaneWidthPercent(Number(event.target.value))} /><b>{noteLayout === 'horizontal' ? laneHeightPercent : laneWidthPercent}%</b></label>
            <label className="menu-range lane-opacity-range">轨道透明度 <input type="range" min="0.15" max="1" step="0.05" value={laneOpacity} onChange={(event) => setLaneOpacity(Number(event.target.value))} /><b>{Math.round(laneOpacity * 100)}%</b></label>
          </section>
          <section className="menu-section"><div className="menu-section-title"><h3>Note 图库</h3><span>{icon.label}已选</span></div><div className="menu-note-library">{NOTE_ICONS.map((item) => <button key={item.id} className={noteIcon === item.id ? 'chosen' : ''} onClick={() => setNoteIcon(item.id)}><img src={`${ICON_BASE}${item.id}.svg`} alt="" /><span>{item.label}</span>{noteIcon === item.id && <Check size={13} />}</button>)}</div></section>
          <section className="menu-section"><div className="menu-section-title"><h3>Note 颜色</h3><span>{selectedNoteColor.label}</span></div><div className="note-color-options" role="radiogroup" aria-label="Note 颜色">{NOTE_COLORS.map((color) => <button key={color.id} type="button" role="radio" aria-checked={noteColor === color.id} aria-label={color.label} title={color.label} className={noteColor === color.id ? 'selected' : ''} style={{ '--swatch-color': color.value } as CSSProperties} onClick={() => setNoteColor(color.id)}><span /></button>)}</div></section>
          </>}

          {menuTab === 'effects' && <><section className="menu-section"><div className="menu-section-title"><h3>Shader 命中特效</h3><span>WebGL · GLSL</span></div>
            <label className="menu-range">效果强度 <input type="range" min="0" max="1" step="0.05" value={effectIntensity} onChange={(event) => setEffectIntensity(Number(event.target.value))} /><b>{Math.round(effectIntensity * 100)}%</b></label>
            <label className="menu-range">默认持续时间 <input type="range" min="0.1" max="1.5" step="0.05" value={effectDuration} onChange={(event) => setEffectDuration(Number(event.target.value))} /><b>{effectDuration.toFixed(2)}s</b></label>
            <div className="effect-switch-grid">{([['flash', '闪白'], ['zoom', '缩放'], ['shake', '晃动'], ['negative', '负片'], ['redEdge', '边缘红影']] as const).map(([key, label]) => <label key={key} className="effect-switch"><input type="checkbox" checked={shaderEffects[key]} onChange={(event) => setShaderEffects((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div>
            <div className="symbol-picker-label">判定符号（预览用；自动铺面均为 PERFECT）</div><div className="symbol-options">{JUDGEMENT_TYPES.map((label, index) => <button key={label} className={previewSymbol === index ? `symbol-${index} selected` : `symbol-${index}`} onClick={() => setPreviewSymbol(index)}>{label}</button>)}</div>
            <button className="shader-preview-button" onClick={() => { setShaderSymbol(previewSymbol); setFeedbackSymbol(previewSymbol); setHitSequence((sequence) => sequence + 1); setShaderNotice(`正在预览 ${JUDGEMENT_TYPES[previewSymbol]} Shader 效果`); }}>预览 Shader 效果</button>
          </section>

            <section className="menu-section shader-editor-section"><div className="menu-section-title"><h3>Shader 源码</h3><span>仅接受 GLSL，不执行脚本</span></div><textarea className="shader-code-editor" spellCheck={false} aria-label="GLSL 片元 Shader 源码" value={fragmentShader} onChange={(event) => { setFragmentShader(event.target.value); setShaderNotice('代码已更改，WebGL 正在即时编译…'); }} /><div className="shader-io-actions"><button onClick={() => shaderFileRef.current?.click()}><Upload size={13} />导入 .frag</button><button onClick={downloadShader}>下载源码</button><button onClick={() => { setFragmentShader(DEFAULT_FRAGMENT_SHADER); setShaderNotice('已恢复内置 Shader'); }}>重置</button><input ref={shaderFileRef} type="file" accept=".frag,.glsl,text/plain" hidden onChange={(event) => { void importShader(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div><button className="shader-save-button" onClick={saveShader}>保存到本地浏览器</button><p className="shader-status" role="status">{shaderNotice}</p><p className="shader-api-hint">命中效果 Uniform：<code>uIntensity</code>、<code>uSymbol</code>、<code>uDuration</code>、<code>uEffects</code>、<code>uRedEdge</code>；爆点效果另有 <code>uBlastIntensity</code>、<code>uBlastDuration</code>、<code>uBlastEffects</code>。通用纹理参数：<code>uTexture</code>、<code>uResolution</code>、<code>uVideoAspect</code>、<code>uTime</code>。</p></section>
          </>}
          {menuTab === 'blast' && <div className="menu-tab-content" role="tabpanel" aria-label="爆点特效设置"><section className="menu-section"><div className="menu-section-title"><h3>爆点爆发样式</h3><span>{explosionPoints.length} 个触发点</span></div><div className="blast-style-grid">{([['nova', '星爆'], ['shockwave', '冲击波'], ['prism', '棱镜'], ['pulsar', '脉冲']] as const).map(([style, label]) => <button key={style} className={explosionStyle === style ? 'active' : ''} onClick={() => setExplosionStyle(style)}><Zap size={13} />{label}</button>)}</div><div className="effect-switch-grid blast-effect-switches">{([['whiteEdge', '边缘白影'], ['caustics', '焦散']] as const).map(([key, label]) => <label key={key} className="effect-switch"><input type="checkbox" checked={blastShaderEffects[key]} onChange={(event) => setBlastShaderEffects((current) => ({ ...current, [key]: event.target.checked }))} /><span>{label}</span></label>)}</div><label className="menu-range">爆发强度<input type="range" min="0.2" max="1" step="0.05" value={explosionIntensity} onChange={(event) => setExplosionIntensity(Number(event.target.value))} /><b>{Math.round(explosionIntensity * 100)}%</b></label><label className="menu-range">持续时间<input type="range" min="0.5" max="6" step="0.1" value={explosionDuration} onChange={(event) => setExplosionDuration(Number(event.target.value))} /><b>{explosionDuration.toFixed(1)}s</b></label><button className="shader-preview-button" onClick={() => { setActiveExplosionTime(currentTime); setExplosionScene(configuredExplosionScene); setExplosionActive(true); setExplosionSequence((sequence) => sequence + 1); window.clearTimeout(explosionTimerRef.current); explosionTimerRef.current = window.setTimeout(() => setExplosionActive(false), explosionDuration * 1000); }}>预览爆点特效</button><p className="video-setting-help">可在时间轴上添加多个爆点，播放前 5 秒倒计时，到点触发。</p></section></div>}
          {menuTab === 'video' && <div className="menu-tab-content" role="tabpanel" aria-label="视频显示设置"><section className="menu-section"><div className="menu-section-title"><h3>画布尺寸</h3><span>{canvasSize.width} × {canvasSize.height}</span></div><div className="canvas-preset-options">{(Object.entries(CANVAS_PRESETS) as [CanvasPreset, (typeof CANVAS_PRESETS)[CanvasPreset]][]).map(([id, preset]) => <button key={id} className={canvasPreset === id ? 'active' : ''} onClick={() => setCanvasPreset(id)}><span className={`canvas-shape canvas-${id}`} /><span>{preset.label}</span></button>)}</div><p className="video-setting-help">默认 1080p。画布比例会同步调整预览区域与 WebGL 输出分辨率。</p></section><section className="menu-section"><div className="menu-section-title"><h3>视频填充模式</h3><span>铺面背景</span></div><div className="fill-mode-options"><button className={fillMode === 'cover' ? 'active' : ''} onClick={() => setFillMode('cover')}><strong>放大到填满</strong><span>铺满画布，超出部分裁切</span></button><button className={fillMode === 'contain' ? 'active' : ''} onClick={() => setFillMode('contain')}><strong>最长边填满</strong><span>完整显示视频，空余区域留底色</span></button><button className={fillMode === 'stretch' ? 'active' : ''} onClick={() => setFillMode('stretch')}><strong>拉伸</strong><span>强制铺满，可能改变画面比例</span></button></div></section></div>}
        </section>}
        <button className={`video-panel-toggle ${videoPanelOpen ? 'opened' : ''}`} onClick={() => { const open = !videoPanelOpen; setVideoPanelOpen(open); setAudioPanelOpen(false); setMenuOpen(false); setDebugOpen(false); }} aria-label={videoPanelOpen ? '关闭视频素材面板' : '打开视频素材面板'} aria-expanded={videoPanelOpen} title="视频素材"><Film size={19} /><span>视频</span></button>
        <button className={`audio-panel-toggle ${audioPanelOpen ? 'opened' : ''}`} onClick={() => { const open = !audioPanelOpen; setAudioPanelOpen(open); setVideoPanelOpen(false); setMenuOpen(false); setDebugOpen(false); }} aria-label={audioPanelOpen ? '关闭音频面板' : '打开音频面板'} aria-expanded={audioPanelOpen} title="音频素材"><Music2 size={18} /><span>音频</span></button>
        <button className={`debug-panel-toggle ${debugOpen ? 'opened' : ''}`} onClick={() => { const open = !debugOpen; setDebugOpen(open); setAudioPanelOpen(false); setVideoPanelOpen(false); setMenuOpen(false); }} aria-label={debugOpen ? '关闭性能诊断' : '打开性能诊断'} aria-expanded={debugOpen} title="页面性能"><Timer size={18} /><span>性能</span></button>
        <button className={`floating-menu ${menuOpen ? 'opened' : ''}`} onClick={() => { const open = !menuOpen; setMenuOpen(open); setVideoPanelOpen(false); setAudioPanelOpen(false); setDebugOpen(false); }} aria-label={menuOpen ? '关闭主体菜单' : '打开主体菜单'} aria-expanded={menuOpen} title="主体设置"><Shirt size={21} /></button>
        {debugOpen && <aside className="debug-panel" aria-label="整页性能诊断"><div><strong>整页性能</strong><button onClick={() => setDebugOpen(false)} aria-label="折叠性能面板"><X size={13} /></button></div><dl><dt>整页 FPS（RAF）</dt><dd>{pageVisible ? `${performanceStats.fps.toFixed(0)} FPS` : '后台节流'}</dd><dt>整页帧间隔均值</dt><dd>{pageVisible ? `${performanceStats.frameMs.toFixed(1)} ms` : '后台节流'}</dd><dt>慢帧（&gt;25ms）</dt><dd>{pageVisible ? performanceStats.slowFrames : '—'}</dd><dt>当前视频解码 FPS</dt><dd>{performanceStats.videoFps ? `${performanceStats.videoFps.toFixed(0)} FPS` : '等待视频帧'}</dd><dt>JS 堆内存</dt><dd>{performanceStats.heapMb ? `${performanceStats.heapMb.toFixed(0)} MB` : '浏览器不提供'}</dd></dl><p>整页帧率按窗口 requestAnimationFrame 采样，包含舞台与面板渲染；标签页隐藏时浏览器会节流，切回后再查看。视频解码帧率单独统计。</p></aside>}
      </main>
    </div>
  );
}

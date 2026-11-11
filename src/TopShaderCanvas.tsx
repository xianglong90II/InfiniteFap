import { useEffect, useRef, useState, type RefObject } from 'react';

export const TOP_SHADER_PRESETS = {
  none: { label: '无效果', source: '' },
  desaturate: { label: '低饱和', source: `precision mediump float;\nuniform sampler2D uTexture;\nuniform vec2 uResolution;\nuniform float uTime;\nuniform float uAudioLevel;\nuniform float uWaveform[32];\nvarying vec2 vUv;\nvoid main(){ vec4 c=texture2D(uTexture,vUv); float l=dot(c.rgb,vec3(0.299,0.587,0.114)); gl_FragColor=vec4(mix(vec3(l),c.rgb,0.28),c.a); }` },
  horror: { label: '黑白恐怖片', source: `precision mediump float;\nuniform sampler2D uTexture;\nuniform vec2 uResolution;\nuniform float uTime;\nuniform float uAudioLevel;\nuniform float uWaveform[32];\nvarying vec2 vUv;\nvoid main(){ vec2 p=vUv-0.5; vec3 c=texture2D(uTexture,vUv).rgb; float l=dot(c,vec3(0.299,0.587,0.114)); l=smoothstep(0.12,0.78,l); float grain=fract(sin(dot(gl_FragCoord.xy+uTime,vec2(12.9898,78.233)))*43758.5453)-0.5; l=clamp(l+grain*0.08,0.0,1.0); float vignette=1.0-0.42*smoothstep(0.2,0.72,length(p)); gl_FragColor=vec4(vec3(l*vignette),1.0); }` },
  pixelate: { label: '像素化', source: `precision mediump float;\nuniform sampler2D uTexture;\nuniform vec2 uResolution;\nuniform float uTime;\nuniform float uAudioLevel;\nuniform float uWaveform[32];\nvarying vec2 vUv;\nvoid main(){ vec2 grid=max(uResolution/180.0,vec2(1.0)); vec2 uv=(floor(vUv*grid)+0.5)/grid; gl_FragColor=texture2D(uTexture,uv); }` },
  outline: { label: '描边', source: `precision mediump float;\nuniform sampler2D uTexture;\nuniform vec2 uResolution;\nuniform float uTime;\nuniform float uAudioLevel;\nuniform float uWaveform[32];\nvarying vec2 vUv;\nvoid main(){ vec2 d=1.5/uResolution; vec3 c=texture2D(uTexture,vUv).rgb; float l=dot(c,vec3(0.299,0.587,0.114)); float n=dot(texture2D(uTexture,vUv+vec2(d.x,0.0)).rgb,vec3(0.299,0.587,0.114)); float m=dot(texture2D(uTexture,vUv+vec2(0.0,d.y)).rgb,vec3(0.299,0.587,0.114)); float edge=step(0.12,abs(l-n)+abs(l-m)); gl_FragColor=vec4(mix(c,vec3(0.02),edge*0.85),1.0); }` },
} as const;

export const DEFAULT_TOP_SHADER = TOP_SHADER_PRESETS.none.source;

type Props = {
  videoRef: RefObject<HTMLVideoElement>;
  incomingVideoRef: RefObject<HTMLVideoElement>;
  hitShaderRef: RefObject<HTMLCanvasElement>;
  enabled: boolean;
  playing: boolean;
  outputWidth: number;
  outputHeight: number;
  fillMode: 'cover' | 'contain' | 'stretch';
  transitionActive: boolean;
  transitionProgress: number;
  activeFrameReady: boolean;
  transitionPreset: 'crossfade' | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down' | 'zoom' | 'blur' | 'flash';
  hitSequence: number;
  hitDuration: number;
  audioLevel: number;
  waveform: number[];
  source: string;
};

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL Shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader 编译失败';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export default function TopShaderCanvas({ videoRef, incomingVideoRef, hitShaderRef, enabled, playing, outputWidth, outputHeight, fillMode, transitionActive, transitionProgress, activeFrameReady, transitionPreset, hitSequence, hitDuration, audioLevel, waveform, source }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const hitStartedAt = useRef(0);
  const latest = useRef({ enabled, playing, outputWidth, outputHeight, fillMode, transitionActive, transitionProgress, activeFrameReady, transitionPreset, hitSequence, hitDuration, audioLevel, waveform, source, videoRef, incomingVideoRef, hitShaderRef });
  const [error, setError] = useState('');
  latest.current = { enabled, playing, outputWidth, outputHeight, fillMode, transitionActive, transitionProgress, activeFrameReady, transitionPreset, hitSequence, hitDuration, audioLevel, waveform, source, videoRef, incomingVideoRef, hitShaderRef };

  useEffect(() => { hitStartedAt.current = performance.now(); invalidateRef.current(); }, [hitSequence]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl) { setError('WebGL 不可用'); return; }
    let program: WebGLProgram | null = null;
    let frame = 0;
    let alive = true;
    let hasRenderedFrame = false;
    const compositionCanvas = document.createElement('canvas');
    const compositionContext = compositionCanvas.getContext('2d');
    if (!compositionContext) { setError('无法创建画面合成上下文'); return; }
    try {
      const vertex = compile(gl, gl.VERTEX_SHADER, 'attribute vec2 aPosition; varying vec2 vUv; void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}');
      const fragment = compile(gl, gl.FRAGMENT_SHADER, source || TOP_SHADER_PRESETS.desaturate.source);
      program = gl.createProgram();
      if (!program) throw new Error('无法创建 Shader 程序');
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader 链接失败');
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      if (!texture) throw new Error('无法创建视频纹理');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const loc = (name: string) => gl.getUniformLocation(program!, name);
      const setFloat = (name: string, value: number) => { const at = loc(name); if (at) gl.uniform1f(at, value); };
      const draw = (now: number) => {
        frame = 0;
        if (!alive) return;
        const state = latest.current;
        const video = state.videoRef.current as FrameVideo | null;
        const incoming = state.incomingVideoRef.current;
        const width = Math.min(state.outputWidth, Math.max(1, canvas.clientWidth));
        const height = Math.min(state.outputHeight, Math.max(1, canvas.clientHeight));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0, 0, width, height); gl.useProgram(program); gl.bindTexture(gl.TEXTURE_2D, texture);
        if (compositionCanvas.width !== width || compositionCanvas.height !== height) {
          compositionCanvas.width = width;
          compositionCanvas.height = height;
        }
        const drawVideo = (sourceVideo: HTMLVideoElement | null, alpha = 1, preset?: Props['transitionPreset'], progress = 0) => {
          if (!sourceVideo || sourceVideo.readyState < 2 || !sourceVideo.videoWidth) return;
          const scale = state.fillMode === 'stretch' ? null : state.fillMode === 'cover'
            ? Math.max(width / sourceVideo.videoWidth, height / sourceVideo.videoHeight)
            : Math.min(width / sourceVideo.videoWidth, height / sourceVideo.videoHeight);
          const drawWidth = scale === null ? width : sourceVideo.videoWidth * scale;
          const drawHeight = scale === null ? height : sourceVideo.videoHeight * scale;
          compositionContext!.save();
          if (preset?.startsWith('wipe-')) {
            if (preset === 'wipe-left') compositionContext!.beginPath(), compositionContext!.rect(width * (1 - progress), 0, width * progress, height), compositionContext!.clip();
            if (preset === 'wipe-right') compositionContext!.beginPath(), compositionContext!.rect(0, 0, width * progress, height), compositionContext!.clip();
            if (preset === 'wipe-up') compositionContext!.beginPath(), compositionContext!.rect(0, height * (1 - progress), width, height * progress), compositionContext!.clip();
            if (preset === 'wipe-down') compositionContext!.beginPath(), compositionContext!.rect(0, 0, width, height * progress), compositionContext!.clip();
          }
          if (preset === 'zoom') {
            compositionContext!.translate(width / 2, height / 2);
            compositionContext!.scale(1.16 - progress * 0.16, 1.16 - progress * 0.16);
            compositionContext!.translate(-width / 2, -height / 2);
          }
          compositionContext!.globalAlpha = alpha;
          compositionContext!.filter = preset === 'blur' ? `blur(${(1 - progress) * 12}px)` : preset === 'flash' ? `brightness(${1 + Math.max(0, 1 - Math.abs(progress - 0.7) * 3) * 0.7})` : 'none';
          compositionContext!.drawImage(sourceVideo, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
          compositionContext!.restore();
        };
        compositionContext.fillStyle = '#101018';
        compositionContext.fillRect(0, 0, width, height);
        const hasVideo = Boolean(state.activeFrameReady && video && video.readyState >= 2 && video.videoWidth);
        const hasIncoming = Boolean(incoming && incoming.readyState >= 2 && incoming.videoWidth && !incoming.seeking);
        const hasComposition = hasVideo || (state.transitionActive && hasIncoming);
        if (hasComposition && hasVideo && video) drawVideo(video);
        if (state.transitionActive && hasIncoming && incoming) {
          const progress = 1 - (1 - state.transitionProgress) ** 3;
          drawVideo(incoming, hasVideo ? progress : 1, state.transitionPreset, progress);
        } else if (!hasComposition && video && video.readyState >= 2 && video.videoWidth && !video.seeking) {
          drawVideo(video);
        }
        const hitCanvas = state.hitShaderRef.current;
        const hitOpacity = hitCanvas ? Number.parseFloat(hitCanvas.style.opacity) : 0;
        if (hasComposition && hitCanvas && hitCanvas.width && hitOpacity > 0) {
          compositionContext.globalAlpha = Math.min(1, hitOpacity);
          compositionContext.drawImage(hitCanvas, 0, 0, width, height);
          compositionContext.globalAlpha = 1;
        }
        if (hasComposition || (!state.transitionActive && hasVideo)) {
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, compositionCanvas);
            hasRenderedFrame = true;
          } catch { /* Wait for the next frame. */ }
        }
        const tex = loc('uTexture'); if (tex) gl.uniform1i(tex, 0);
        const resolution = loc('uResolution'); if (resolution) gl.uniform2f(resolution, width, height);
        setFloat('uTime', now / 1000); setFloat('uAudioLevel', state.audioLevel);
        const samples = new Float32Array(32);
        for (let i = 0; i < samples.length; i += 1) samples[i] = state.waveform[Math.min(state.waveform.length - 1, Math.floor(i * state.waveform.length / samples.length))] || 0;
        const wave = loc('uWaveform[0]'); if (wave) gl.uniform1fv(wave, samples);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (state.enabled && hasRenderedFrame) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        canvas.style.opacity = state.enabled && hasRenderedFrame ? '1' : '0';
        if (state.enabled && (state.playing || state.hitSequence > 0 && performance.now() - hitStartedAt.current < state.hitDuration * 1000)) frame = requestAnimationFrame(draw);
      };
      const invalidate = () => { if (!frame && alive) frame = requestAnimationFrame(draw); };
      invalidateRef.current = invalidate;
      frame = requestAnimationFrame(draw);
      setError('');
      return () => { alive = false; cancelAnimationFrame(frame); if (invalidateRef.current === invalidate) invalidateRef.current = () => {}; if (program) gl.deleteProgram(program); gl.deleteTexture(texture); gl.deleteBuffer(buffer); };
    } catch (reason) {
      if (program) gl.deleteProgram(program);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [source]);

  useEffect(() => {
    const videos = [videoRef.current, incomingVideoRef.current].filter((video): video is HTMLVideoElement => Boolean(video)) as FrameVideo[];
    if (!videos.length) return;
    const callbacks = new Map<FrameVideo, number>();
    const listeners = new Map<FrameVideo, () => void>();
    const invalidate = () => invalidateRef.current();
    const watchFrame = (video: FrameVideo) => {
      const onFrame = () => { callbacks.set(video, 0); invalidate(); if (enabled && !video.paused && video.requestVideoFrameCallback) callbacks.set(video, video.requestVideoFrameCallback(onFrame)); };
      if (enabled && !video.paused && video.requestVideoFrameCallback && !callbacks.get(video)) callbacks.set(video, video.requestVideoFrameCallback(onFrame));
    };
    const onEvent = (video: FrameVideo) => { invalidate(); watchFrame(video); };
    videos.forEach((video) => {
      const listener = () => onEvent(video);
      listeners.set(video, listener);
      video.addEventListener('loadeddata', listener); video.addEventListener('seeked', listener); video.addEventListener('play', listener); video.addEventListener('pause', listener);
    });
    videos.forEach((video) => onEvent(video));
    return () => videos.forEach((video) => {
      const callback = callbacks.get(video);
      if (callback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
      const listener = listeners.get(video);
      if (listener) {
        video.removeEventListener('loadeddata', listener); video.removeEventListener('seeked', listener); video.removeEventListener('play', listener); video.removeEventListener('pause', listener);
      }
    });
  }, [videoRef, incomingVideoRef, enabled, playing]);

  useEffect(() => {
    invalidateRef.current();
  }, [enabled, playing, audioLevel, waveform, outputWidth, outputHeight, transitionActive, transitionProgress, activeFrameReady, transitionPreset, fillMode, hitSequence, hitDuration]);

  return <><canvas ref={canvasRef} className="top-shader-canvas" aria-label="Top Shader 视频特效层" />{error && enabled && <span className="shader-runtime-error" title={error}>Top Shader 错误</span>}</>;
}

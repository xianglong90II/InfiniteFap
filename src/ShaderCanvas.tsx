import { useEffect, useRef, useState, type RefObject } from 'react';

export type ShaderEffects = { flash: boolean; zoom: boolean; shake: boolean; negative: boolean; redEdge: boolean };
export type BlastShaderEffects = { caustics: boolean; whiteEdge: boolean };

export const DEFAULT_FRAGMENT_SHADER = `precision mediump float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uVideoAspect;
uniform float uFitMode;
uniform float uTime;
uniform float uHasVideo;
uniform float uIntensity;
uniform float uSymbol;
uniform float uDuration;
uniform vec4 uEffects;
uniform float uRedEdge;
uniform float uBlastIntensity;
uniform float uBlastDuration;
uniform float uBlastProgress;
uniform vec2 uBlastEffects;
varying vec2 vUv;
vec2 fitVideoUv(vec2 uv, float videoAspect, float canvasAspect, float fitMode, out float insideVideo) {
	insideVideo = 1.0;
	if (fitMode > 1.5) return uv;
	if (fitMode < 0.5) {
		if (videoAspect > canvasAspect) uv.x = 0.5 + (uv.x - 0.5) * canvasAspect / videoAspect;
		else uv.y = 0.5 + (uv.y - 0.5) * videoAspect / canvasAspect;
		return uv;
	}
	if (videoAspect > canvasAspect) {
		float visibleHeight = canvasAspect / videoAspect;
		insideVideo = step(0.5 - visibleHeight * 0.5, uv.y) * step(uv.y, 0.5 + visibleHeight * 0.5);
		uv.y = 0.5 + (uv.y - 0.5) / visibleHeight;
	} else {
		float visibleWidth = videoAspect / canvasAspect;
		insideVideo = step(0.5 - visibleWidth * 0.5, uv.x) * step(uv.x, 0.5 + visibleWidth * 0.5);
		uv.x = 0.5 + (uv.x - 0.5) / visibleWidth;
	}
	return uv;
}
void main() {
	float pulse = clamp(uIntensity, 0.0, 1.0);
	vec2 centered = vUv - 0.5;
	float canvasAspect = uResolution.x / max(uResolution.y, 1.0);
	float insideVideo;
	vec2 uv = fitVideoUv(vUv, max(uVideoAspect, 0.001), canvasAspect, uFitMode, insideVideo);
	float zoom = 1.0 - uEffects.y * pulse * 0.085;
	uv = 0.5 + (uv - 0.5) * zoom;
	uv += vec2(sin(uTime * 73.0), cos(uTime * 61.0)) * uEffects.z * pulse * 0.004;
	uv = clamp(uv, vec2(0.002), vec2(0.998));
	vec3 color = texture2D(uTexture, uv).rgb;
	float edge = smoothstep(0.25, 0.76, length(centered * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0)));
	color = mix(color, vec3(color.r + 0.48, color.g * 0.24, color.b * 0.3), clamp(edge * uRedEdge * pulse, 0.0, 0.8));
	color = mix(color, vec3(1.0) - color, uEffects.w * pulse);
	float flash = uEffects.x * pulse * (0.18 + 0.48 * pulse);
	color = mix(color, vec3(1.0), clamp(flash, 0.0, 0.86));
	float blast = clamp(uBlastIntensity, 0.0, 1.0);
	float ring = 1.0 - smoothstep(0.0, 0.045, abs(length(centered) - uBlastProgress * 0.72));
	float caustic = 0.65 + 0.35 * sin((centered.x + centered.y + uBlastProgress) * 44.0);
	color += vec3(0.24, 0.72, 1.0) * ring * caustic * blast * uBlastEffects.y * 0.55;
	color = mix(color, vec3(1.0), clamp(edge * blast * uBlastEffects.x * 0.75, 0.0, 0.9));
	gl_FragColor = vec4(color, insideVideo * uHasVideo);
}`;

type Props = {
	videoRef: RefObject<HTMLVideoElement>;
	videoSource: string;
	playing: boolean;
	fillMode: 'cover' | 'contain' | 'stretch';
	outputWidth: number;
	outputHeight: number;
	effectSequence: number;
	blastSequence: number;
	intensity: number;
	blastIntensity: number;
	symbol: number;
	duration: number;
	blastDuration: number;
	effects: ShaderEffects;
	blastEffects: BlastShaderEffects;
	fragmentSource: string;
};

type FrameVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: (now: number) => void) => number;
	cancelVideoFrameCallback?: (id: number) => void;
};

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

export default function ShaderCanvas(props: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [shaderError, setShaderError] = useState('');
	const latest = useRef(props);
	latest.current = props;
	const hitAt = useRef(0);
	const blastAt = useRef(0);
	const videoFrameDirty = useRef(true);
	const invalidateRef = useRef<() => void>(() => {});

	useEffect(() => {
		if (props.effectSequence) hitAt.current = performance.now();
	}, [props.effectSequence]);
	useEffect(() => {
		if (props.blastSequence) blastAt.current = performance.now();
	}, [props.blastSequence]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
		if (!gl) { setShaderError('当前浏览器无法创建 WebGL 上下文'); return; }
		let program: WebGLProgram | null = null;
		let frame = 0;
		let alive = true;
		try {
			const vertex = compile(gl, gl.VERTEX_SHADER, 'attribute vec2 aPosition; varying vec2 vUv; void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}');
			const fragment = compile(gl, gl.FRAGMENT_SHADER, latest.current.fragmentSource);
			program = gl.createProgram();
			if (!program) throw new Error('无法创建 WebGL 程序');
			gl.attachShader(program, vertex);
			gl.attachShader(program, fragment);
			gl.linkProgram(program);
			gl.deleteShader(vertex);
			gl.deleteShader(fragment);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader 链接失败');
			gl.useProgram(program);
			const buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
			const position = gl.getAttribLocation(program, 'aPosition');
			gl.enableVertexAttribArray(position);
			gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
			const texture = gl.createTexture();
			if (!texture) throw new Error('无法创建视频纹理');
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
			const uniform = (name: string) => gl.getUniformLocation(program!, name);
			const setFloat = (name: string, value: number) => { const loc = uniform(name); if (loc) gl.uniform1f(loc, value); };
			const render = (now: number) => {
				frame = 0;
				if (!alive) return;
				const current = latest.current;
				const video = current.videoRef.current as FrameVideo | null;
				const dpr = Math.min(1.25, window.devicePixelRatio || 1);
				const width = Math.min(current.outputWidth, Math.max(1, Math.round(canvas.clientWidth * dpr)));
				const height = Math.min(current.outputHeight, Math.max(1, Math.round(canvas.clientHeight * dpr)));
				if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
				gl.viewport(0, 0, canvas.width, canvas.height);
				gl.useProgram(program);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				if (current.playing && video && !video.requestVideoFrameCallback) videoFrameDirty.current = true;
				if (videoFrameDirty.current && video && video.readyState >= 2 && video.videoWidth > 0) {
					try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch { /* Wait for the next decoded frame. */ }
					videoFrameDirty.current = false;
				}
				const textureLocation = uniform('uTexture'); if (textureLocation) gl.uniform1i(textureLocation, 0);
				const resolution = uniform('uResolution'); if (resolution) gl.uniform2f(resolution, canvas.width, canvas.height);
				setFloat('uVideoAspect', video?.videoHeight ? video.videoWidth / video.videoHeight : 1);
				setFloat('uFitMode', current.fillMode === 'cover' ? 0 : current.fillMode === 'contain' ? 1 : 2);
				setFloat('uTime', now / 1000);
				setFloat('uHasVideo', video && video.readyState >= 2 ? 1 : 0);
				const pulse = current.effectSequence ? Math.max(0, 1 - (performance.now() - hitAt.current) / Math.max(80, current.duration * 1000)) * current.intensity : 0;
				const blastProgress = current.blastSequence ? Math.min(1, Math.max(0, (performance.now() - blastAt.current) / Math.max(100, current.blastDuration * 1000))) : 0;
				const blastPulse = current.blastSequence ? (1 - blastProgress) * current.blastIntensity : 0;
				setFloat('uIntensity', pulse);
				setFloat('uSymbol', current.symbol);
				setFloat('uDuration', current.duration);
				setFloat('uRedEdge', current.effects.redEdge ? 1 : 0);
				const effects = uniform('uEffects'); if (effects) gl.uniform4f(effects, current.effects.flash ? 1 : 0, current.effects.zoom ? 1 : 0, current.effects.shake ? 1 : 0, current.effects.negative ? 1 : 0);
				setFloat('uBlastIntensity', blastPulse);
				setFloat('uBlastDuration', current.blastDuration);
				setFloat('uBlastProgress', blastProgress);
				const blastEffects = uniform('uBlastEffects'); if (blastEffects) gl.uniform2f(blastEffects, current.blastEffects.whiteEdge ? 1 : 0, current.blastEffects.caustics ? 1 : 0);
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
				canvas.style.opacity = Math.max(pulse, blastPulse) > 0.005 ? '0.82' : '0';
				if (pulse > 0.005 || blastPulse > 0.005 || (current.playing && !video?.requestVideoFrameCallback)) frame = requestAnimationFrame(render);
			};
			const invalidate = () => { if (!frame && alive) frame = requestAnimationFrame(render); };
			invalidateRef.current = invalidate;
			frame = requestAnimationFrame(render);
			setShaderError('');
			return () => {
				alive = false;
				cancelAnimationFrame(frame);
				if (invalidateRef.current === invalidate) invalidateRef.current = () => {};
				if (program) gl.deleteProgram(program);
				gl.deleteTexture(texture);
				gl.deleteBuffer(buffer);
			};
		} catch (error) {
			if (program) gl.deleteProgram(program);
			setShaderError(error instanceof Error ? error.message : String(error));
		}
	}, [props.fragmentSource]);

	useEffect(() => {
		const video = props.videoRef.current as FrameVideo | null;
		if (!video) { invalidateRef.current(); return; }
		let alive = true;
		let callback = 0;
		const schedule = () => {
			if (alive && !video.paused && video.requestVideoFrameCallback && !callback) callback = video.requestVideoFrameCallback(onVideoFrame);
		};
		const onVideoFrame = () => {
			callback = 0;
			videoFrameDirty.current = true;
			invalidateRef.current();
			schedule();
		};
		const onVideoEvent = () => {
			videoFrameDirty.current = true;
			invalidateRef.current();
			if (video.paused && callback && video.cancelVideoFrameCallback) {
				video.cancelVideoFrameCallback(callback);
				callback = 0;
			} else schedule();
		};
		video.addEventListener('loadeddata', onVideoEvent);
		video.addEventListener('seeked', onVideoEvent);
		video.addEventListener('play', onVideoEvent);
		video.addEventListener('pause', onVideoEvent);
		onVideoEvent();
		return () => {
			alive = false;
			if (callback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callback);
			video.removeEventListener('loadeddata', onVideoEvent);
			video.removeEventListener('seeked', onVideoEvent);
			video.removeEventListener('play', onVideoEvent);
			video.removeEventListener('pause', onVideoEvent);
		};
	}, [props.videoRef, props.videoSource, props.playing]);

	useEffect(() => { invalidateRef.current(); }, [props.fillMode, props.outputWidth, props.outputHeight, props.effectSequence, props.intensity, props.symbol, props.duration, props.effects, props.blastSequence, props.blastIntensity, props.blastDuration, props.blastEffects]);

	return <>
		<canvas ref={canvasRef} className="shader-background-canvas" aria-label="WebGL Shader 铺面背景预览" />
		{shaderError && <span className="shader-runtime-error" title={shaderError}>Shader 错误</span>}
	</>;
}

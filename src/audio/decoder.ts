import { fetchFile } from '@ffmpeg/util';
import { getFFmpeg } from './ffmpegCore';

export type DecodedAudio = { buffer: AudioBuffer; playable: Blob };

export async function decodeAudioFile(file: File, context: AudioContext): Promise<DecodedAudio> {
  try {
    return { buffer: await context.decodeAudioData(await file.arrayBuffer()), playable: file };
  } catch {
    const engine = await getFFmpeg();
    const extension = file.name.split('.').pop()?.toLowerCase() || 'audio';
    const inputPath = `decode-input.${extension}`;
    const outputPath = 'decode-output.wav';
    try {
      await engine.writeFile(inputPath, await fetchFile(file));
      const result = await engine.exec(['-i', inputPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outputPath]);
      if (result !== 0) throw new Error('FFmpeg 无法解码该音频格式');
      const data = await engine.readFile(outputPath);
      if (typeof data === 'string') throw new Error('FFmpeg 未生成 WAV 音频');
      const wav = new Uint8Array(data);
      return {
        buffer: await context.decodeAudioData(wav.slice().buffer),
        playable: new Blob([wav], { type: 'audio/wav' }),
      };
    } finally {
      for (const path of [inputPath, outputPath]) {
        try { await engine.deleteFile(path); } catch { /* File may not have been written. */ }
      }
    }
  }
}

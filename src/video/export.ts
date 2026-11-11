import { getFFmpeg } from '../audio/ffmpegCore';

export type ExportFormat = 'mp4' | 'webp';

export async function convertWebm(blob: Blob, format: ExportFormat): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const prefix = `mv-export-${Date.now()}`;
  const inputPath = `${prefix}.webm`;
  const outputPath = `${prefix}.${format}`;
  try {
    await ffmpeg.writeFile(inputPath, new Uint8Array(await blob.arrayBuffer()));
    const args = format === 'mp4'
      ? ['-i', inputPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath]
      : ['-i', inputPath, '-an', '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80', '-loop', '0', outputPath];
    const result = await ffmpeg.exec(args);
    if (result !== 0) throw new Error(`FFmpeg 无法生成 ${format.toUpperCase()}，可能是当前 WASM 编码器未包含对应格式`);
    const data = await ffmpeg.readFile(outputPath);
    if (typeof data === 'string') throw new Error('视频编码器没有生成文件');
    return new Blob([data], { type: format === 'mp4' ? 'video/mp4' : 'image/webp' });
  } finally {
    for (const path of [inputPath, outputPath]) {
      try { await ffmpeg.deleteFile(path); } catch { /* Output may not exist when encoding fails. */ }
    }
  }
}

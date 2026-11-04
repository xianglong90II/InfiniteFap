import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import coreURL from '../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url';
import wasmURL from '../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url';

let instance: FFmpeg | undefined;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (!instance) {
    instance = new FFmpeg();
    await instance.load({
      coreURL: await toBlobURL(coreURL, 'text/javascript'),
      wasmURL: await toBlobURL(wasmURL, 'application/wasm'),
    });
  }
  return instance;
}

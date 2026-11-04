const TARGET_SAMPLE_RATE = 22050;

export async function resampleToMono22050(audio: AudioBuffer): Promise<Float32Array> {
  const length = Math.ceil(audio.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
  const mono = offline.createBuffer(1, audio.length, audio.sampleRate);
  const destination = mono.getChannelData(0);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const source = audio.getChannelData(channel);
    for (let i = 0; i < source.length; i += 1) destination[i] += source[i] / audio.numberOfChannels;
  }
  const source = offline.createBufferSource();
  source.buffer = mono;
  source.connect(offline.destination);
  source.start();
  return new Float32Array((await offline.startRendering()).getChannelData(0));
}

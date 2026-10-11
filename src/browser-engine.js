import { createDeepFilterNetAudioWorklet } from './vendor/deepfilternet/deepfilternet.js';

// 30 ms model latency plus the package's 512-sample reframing buffer, without the pause gate.
export const DFN_LATENCY = (1440 + 512) / 48000;

/** Owns one 48 kHz context and one mono model per channel. Close the context to release WASM memory. */
export class BrowserEngine {
  context = null;
  buffer = null;
  source = null;
  models = [];
  offset = 0;
  startedAt = 0;
  playing = false;
  ready = false;
  generation = 0;
  endTimer = null;
  trim = { start: 0, end: 0 };
  loop = false;

  constructor(onEnded, onError) {
    this.onEnded = onEnded;
    this.onError = onError;
  }

  async load(bytes) {
    const context = new AudioContext({ sampleRate: 48000 });
    let buffer;
    try {
      buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
      if (buffer.numberOfChannels > 2 || buffer.duration > 600 || !buffer.length) {
        throw new Error('Choose a nonempty mono/stereo clip no longer than 10 minutes.');
      }
      await context.suspend();
    } catch (error) {
      await context.close();
      throw error;
    }
    await this.close();
    this.context = context;
    this.buffer = buffer;
    this.trim = { start: 0, end: buffer.duration };
    this.offset = 0;
    return buffer;
  }

  async initialize() {
    if (this.ready) return;
    const context = this.context;
    if (!context) throw new Error('Open an audio clip first.');
    await context.resume();
    try {
      this.input = context.createAnalyser();
      this.output = context.createAnalyser();
      for (const analyser of [this.input, this.output]) {
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.65;
      }
      const channels = this.buffer.numberOfChannels;
      const splitter = context.createChannelSplitter(channels);
      const merger = context.createChannelMerger(channels);
      this.dry = context.createGain();
      this.wet = context.createGain();
      this.master = context.createGain();
      this.master.gain.value = 0;
      const dryDelay = context.createDelay(1);
      dryDelay.delayTime.value = DFN_LATENCY;
      this.input.connect(splitter);
      this.input.connect(dryDelay).connect(this.dry).connect(this.output);
      merger.connect(this.wet).connect(this.output);
      this.output.connect(this.master).connect(context.destination);
      // Keep feeding silence after a source ends so the model can flush its delayed output.
      this.silence = context.createConstantSource();
      this.silence.offset.value = 0;
      this.silence.connect(this.input);
      this.silence.start();
      for (let channel = 0; channel < channels; channel++) {
        const model = await createDeepFilterNetAudioWorklet(context, {
          speechAttenuationDb: 25,
          pauseAttenuationDb: 25, // Disable the extra speech gate: compare the denoiser itself.
          postGain: false,
          bypassUntilReady: false,
          onOverload: () =>
            this.onError('DeepFilterNet3 cannot keep up on this device. Try a mono clip.'),
        });
        this.models.push(model);
        model.node.port.addEventListener('message', (event) => {
          if (event.data.type === 'error') {
            this.master.gain.value = 0;
            void this.pause();
            this.onError(`DeepFilterNet3 failed: ${event.data.message}`);
          }
        });
        model.node.addEventListener('processorerror', () => {
          this.master.gain.value = 0;
          void this.pause();
          this.onError('DeepFilterNet3 stopped processing. Reopen the clip to retry.');
        });
        splitter.connect(model.node, channel, 0);
        model.node.connect(merger, 0, channel);
        await model.ready;
      }
      this.ready = true;
      await context.suspend();
    } catch (error) {
      // Retain the decoded clip, but dispose the failed graph before allowing a retry.
      for (const model of this.models) model.dispose();
      this.models = [];
      this.master?.disconnect();
      this.silence?.stop();
      await context.close();
      this.context = new AudioContext({ sampleRate: 48000 });
      await this.context.suspend();
      throw error;
    }
  }

  setMix(percent, enabled) {
    if (!this.ready) return;
    const wet = enabled ? percent / 100 : 0;
    this.wet.gain.setTargetAtTime(wet, this.context.currentTime, 0.01);
    this.dry.gain.setTargetAtTime(1 - wet, this.context.currentTime, 0.01);
  }

  position() {
    if (!this.playing) return this.offset;
    const elapsed = Math.max(0, this.context.currentTime - this.startedAt);
    const position = this.offset + elapsed;
    return this.loop
      ? this.trim.start + ((position - this.trim.start) % (this.trim.end - this.trim.start))
      : Math.min(this.trim.end, position);
  }

  stopSource() {
    this.generation++;
    clearTimeout(this.endTimer);
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }

  async pause() {
    if (!this.context) return;
    this.offset = this.position();
    this.playing = false;
    this.stopSource();
    if (this.master) this.master.gain.value = 0;
    await this.context.suspend();
  }

  async play({ trim, loop, mix, enabled, restart = false }) {
    await this.initialize();
    this.trim = trim;
    this.loop = loop;
    this.stopSource();
    if (restart || this.offset < trim.start || this.offset >= trim.end) this.offset = trim.start;
    await this.context.resume();
    this.setMix(mix, enabled);
    this.master.gain.value = 1;
    const source = this.context.createBufferSource();
    this.source = source;
    source.buffer = this.buffer;
    source.loop = loop;
    source.loopStart = trim.start;
    source.loopEnd = trim.end;
    source.connect(this.input);
    const token = this.generation;
    source.onended = () => {
      // Let the wet and latency-matched dry paths drain before reporting completion.
      this.endTimer = setTimeout(async () => {
        if (token !== this.generation) return;
        await this.pause();
        this.offset = trim.start;
        this.onEnded();
      }, DFN_LATENCY * 1000);
    };
    this.startedAt = this.context.currentTime;
    this.playing = true;
    if (loop) source.start(0, this.offset);
    else source.start(0, this.offset, trim.end - this.offset);
  }

  spectra() {
    if (!this.ready) return {};
    return Object.fromEntries(
      [
        ['input', this.input],
        ['output', this.output],
      ].map(([name, analyser]) => {
        const bins = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(bins);
        return [name, { bins, sampleRate: this.context.sampleRate }];
      }),
    );
  }

  async close() {
    this.stopSource();
    this.playing = false;
    this.ready = false;
    for (const model of this.models) model.dispose();
    this.models = [];
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}

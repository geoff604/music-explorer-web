/**
 * Decoding, playback and the piano-key tone. Replaces the original's temp-file transcoding,
 * AudioAbstract negotiation chain, hand-rolled ring buffer and waveOut wrapper: the browser does
 * all of that.
 *
 * Analysis always runs on a mono mixdown (arithmetic mean of channels), as the original did at
 * import. Playback uses the decoded buffer as-is, so stereo stays stereo.
 *
 * Note: decodeAudioData resamples to the AudioContext's rate, so `sampleRate` here is the
 * context's rather than the file's native rate. Pitch analysis is unaffected below Nyquist.
 */

import { mixToMono } from '../core/envelope';
import { midiToHz } from '../core/notes';
import sineWorkletUrl from './sine-worklet.ts?worker&url';

export interface LoadedAudio {
  name: string;
  /** Mono mixdown, -1..1. */
  mono: Float32Array;
  sampleRate: number;
  durationSeconds: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private sineNode: AudioWorkletNode | null = null;
  private sineReady: Promise<void> | null = null;

  private startedAt = 0; // ctx.currentTime when playback began
  private offsetSeconds = 0; // where in the file it began
  private endSeconds = 0; // where it will stop
  private playing = false;

  /** Called when playback ends by itself or via {@link stop}. */
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  async load(file: File): Promise<LoadedAudio> {
    this.stop();
    const ctx = this.context();
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    this.buffer = decoded;
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    return {
      name: file.name,
      mono: mixToMono(channels),
      sampleRate: decoded.sampleRate,
      durationSeconds: decoded.duration,
    };
  }

  /**
   * Play from `startSeconds` to `endSeconds`. When the two are equal (no selection) play to the
   * end of the file, as the original did.
   */
  async play(startSeconds: number, endSeconds: number): Promise<void> {
    if (!this.buffer) return;
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();

    const total = this.buffer.duration;
    const from = Math.min(Math.max(0, startSeconds), total);
    const to = endSeconds > startSeconds ? Math.min(endSeconds, total) : total;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source !== source) return; // superseded by a newer play()/stop()
      this.playing = false;
      this.source = null;
      this.onEnded?.();
    };
    source.start(0, from, to - from);

    this.source = source;
    this.startedAt = ctx.currentTime;
    this.offsetSeconds = from;
    this.endSeconds = to;
    this.playing = true;
  }

  stop(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    this.playing = false;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    this.onEnded?.();
  }

  /** Playback position in seconds from the start of the file, or null when stopped. */
  get positionSeconds(): number | null {
    if (!this.playing || !this.ctx) return null;
    const pos = this.offsetSeconds + (this.ctx.currentTime - this.startedAt);
    return Math.min(pos, this.endSeconds);
  }

  // --- piano key tone -------------------------------------------------------------------

  private async ensureSine(): Promise<AudioWorkletNode> {
    const ctx = this.context();
    if (!this.sineReady) {
      this.sineReady = ctx.audioWorklet.addModule(sineWorkletUrl).then(() => {
        const node = new AudioWorkletNode(ctx, 'music-explorer-sine', { outputChannelCount: [2] });
        node.connect(ctx.destination);
        this.sineNode = node;
      });
    }
    await this.sineReady;
    return this.sineNode as AudioWorkletNode;
  }

  async noteOn(midi: number): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
    const node = await this.ensureSine();
    node.port.postMessage({ type: 'on', hz: midiToHz(midi) });
  }

  noteOff(): void {
    this.sineNode?.port.postMessage({ type: 'off' });
  }
}

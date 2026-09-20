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
import { VoiceBank } from '../core/voiceBank';
import sineWorkletUrl from './sine-worklet.ts?worker&url';

export interface LoadedAudio {
  name: string;
  /** Mono mixdown, -1..1. */
  mono: Float32Array;
  sampleRate: number;
  durationSeconds: number;
}

/** A key released before its tone could start still sounds this long, so a quick first tap is heard. */
export const MIN_TAP_MS = 250;
const MAX_EVENTS = 8;

/**
 * Block size for the fallback tone, in frames. The fallback runs on the main thread, and a block
 * is only delivered on time if the page is idle when it is due; a bigger block gives the page more
 * time to be busy (repainting after a tap, say) before the audio runs dry and drops out. The cost
 * is latency: 4096 frames is about 85 ms at 48 kHz. The allowed sizes are the ones Web Audio takes.
 */
export const DEFAULT_FALLBACK_BUFFER = 4096;
const BUFFER_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384];

/** The requested block size if it is one Web Audio accepts, otherwise the default. */
export function chooseBufferSize(requested?: number): number {
  return requested !== undefined && BUFFER_SIZES.includes(requested) ? requested : DEFAULT_FALLBACK_BUFFER;
}

export interface AudioEngineOptions {
  /** Block size for the fallback tone; see {@link DEFAULT_FALLBACK_BUFFER}. */
  fallbackBufferSize?: number;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The piano-key tone, however it is produced. */
interface Tone {
  on(hz: number): void;
  off(): void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private tone: Tone | null = null;
  private toneReady: Promise<Tone> | null = null;

  /** Which key press is current, and whether it is still held; see {@link noteOn}. */
  private noteSerial = 0;
  private held = false;
  /** Recent audio events, shown by the `?debug` readout. */
  private readonly events: string[] = [];
  private usingFallback = false;
  /** Fallback tone blocks that arrived late, i.e. audible dropouts. */
  private underruns = 0;
  private readonly fallbackBufferSize: number;

  constructor(options: AudioEngineOptions = {}) {
    this.fallbackBufferSize = chooseBufferSize(options.fallbackBufferSize);
  }

  private startedAt = 0; // ctx.currentTime when playback began
  private offsetSeconds = 0; // where in the file it began
  private endSeconds = 0; // where it will stop
  private playing = false;

  /** Called when playback ends by itself or via {@link stop}. */
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    if (!this.ctx) {
      // iOS silences Web Audio while the ringer switch is on unless the page says it is playing
      // media. Not in the DOM typings yet, so feature-detect it.
      const session = (navigator as { audioSession?: { type: string } }).audioSession;
      if (session) {
        try {
          session.type = 'playback';
        } catch {
          // not settable here
        }
      }
      this.ctx = new AudioContext();
      this.log(`context created, ${this.ctx.state}`);
    }
    return this.ctx;
  }

  private log(message: string): void {
    this.events.push(`${Math.round(performance.now())}ms ${message}`);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  /** Audio state and recent events, for the `?debug` readout. */
  debugLines(): string[] {
    const dropouts = this.usingFallback ? [`fallback tone dropouts: ${this.underruns}`] : [];
    return [`audio ${this.ctx?.state ?? 'no context'}`, ...dropouts, ...this.events];
  }

  private get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Start audio from a real user gesture. Browsers only let an AudioContext run once the user has
   * acted on the page, and touch screens count the release (or click), not the initial press, so
   * a context first made inside a key's pointerdown can stay silent. Call this from any gesture;
   * it is cheap to repeat. Resolves true once the context is running.
   */
  async unlock(): Promise<boolean> {
    const ctx = this.context();
    // Everything that must happen inside the gesture is started before the first await.
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    this.playSilence(ctx);
    void this.ensureTone().catch(() => undefined); // get the tone ready before the first key
    try {
      await resumed;
    } catch (e) {
      this.log(`resume failed: ${errorText(e)}`);
    }
    this.log(`unlock -> ${ctx.state}`);
    return this.running;
  }

  /** A one-sample silent buffer: some iOS versions only open the audio session once something plays. */
  private playSilence(ctx: AudioContext): void {
    try {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // not essential
    }
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

  private ensureTone(): Promise<Tone> {
    this.toneReady ??= this.createTone(this.context())
      .then((tone) => (this.tone = tone))
      .catch((e: unknown) => {
        // Forget the failure so the next key press tries again, rather than failing for good.
        this.toneReady = null;
        this.log(`tone failed: ${errorText(e)}`);
        throw e;
      });
    return this.toneReady;
  }

  /** async, so that any failure here is a rejection the caller can handle, never a sync throw. */
  private async createTone(ctx: AudioContext): Promise<Tone> {
    // AudioWorklet only exists in a secure context (https, or localhost), so it is missing when
    // the page is opened over plain http, e.g. a dev server reached from a phone on the LAN.
    if (!ctx.audioWorklet) return this.createFallbackTone(ctx);

    await ctx.audioWorklet.addModule(sineWorkletUrl);
    const node = new AudioWorkletNode(ctx, 'music-explorer-sine', { outputChannelCount: [2] });
    node.connect(ctx.destination);
    this.log('tone worklet ready');
    return {
      on: (hz) => node.port.postMessage({ type: 'on', hz }),
      off: () => node.port.postMessage({ type: 'off' }),
    };
  }

  /**
   * The same tone from a ScriptProcessorNode, which runs on the main thread and is deprecated, but
   * works without AudioWorklet. Used only when the worklet is unavailable.
   */
  private createFallbackTone(ctx: AudioContext): Tone {
    const voices = new VoiceBank(ctx.sampleRate);
    const node = ctx.createScriptProcessor(this.fallbackBufferSize, 1, 2);
    let lastPlaybackTime = -1;
    // A key struck and released between two blocks would never be rendered, and so never heard.
    // With a big block that is a quick tap. So a released note waits for one block to play it.
    let unheard = false;
    let releaseWhenHeard = false;
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer;
      // This runs on the main thread, so a busy page (repainting the canvases, say) can make a
      // block late, and a late block is heard as a dropout. Blocks are a fixed length, so a gap
      // between playback times much longer than that means one was missed.
      const blockSeconds = out.length / ctx.sampleRate;
      if (lastPlaybackTime >= 0 && e.playbackTime - lastPlaybackTime > blockSeconds * 1.5) this.underruns++;
      lastPlaybackTime = e.playbackTime;

      const first = out.getChannelData(0);
      voices.render(first);
      for (let c = 1; c < out.numberOfChannels; c++) out.getChannelData(c).set(first);

      if (unheard) {
        unheard = false;
        if (releaseWhenHeard) voices.noteOff();
        releaseWhenHeard = false;
      }
    };
    node.connect(ctx.destination);
    this.usingFallback = true;
    const latencyMs = Math.round((this.fallbackBufferSize / ctx.sampleRate) * 1000);
    this.log(`AudioWorklet unavailable (page not https?): fallback tone, ${this.fallbackBufferSize}-frame blocks (${latencyMs} ms)`);
    return {
      on: (hz) => {
        voices.noteOn(hz);
        unheard = true;
        releaseWhenHeard = false;
      },
      off: () => {
        if (unheard) releaseWhenHeard = true;
        else voices.noteOff();
      },
    };
  }

  /**
   * Sound a key. The first press has to create the context and load the worklet, which takes a
   * moment, so the key may be released (or another pressed) before the tone can start. `held` and
   * `noteSerial` keep that from leaving a tone stuck on: a superseded press stays silent, and one
   * released while starting is sounded briefly instead of being dropped.
   */
  async noteOn(midi: number): Promise<void> {
    const serial = ++this.noteSerial;
    this.held = true;
    const ctx = this.context();
    if (!this.running) await ctx.resume();
    const tone = await this.ensureTone();
    if (serial !== this.noteSerial) return;

    tone.on(midiToHz(midi));
    this.log(`note ${midi} on${this.held ? '' : ' (already released)'}`);
    if (!this.held) {
      setTimeout(() => {
        if (serial === this.noteSerial && !this.held) tone.off();
      }, MIN_TAP_MS);
    }
  }

  noteOff(): void {
    this.held = false;
    this.tone?.off();
  }
}

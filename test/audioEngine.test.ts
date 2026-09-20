import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, DEFAULT_FALLBACK_BUFFER, MIN_TAP_MS, chooseBufferSize } from '../src/audio/AudioEngine';

// The engine is written against the browser's Web Audio classes; these stand-ins record what it
// does and let each test decide when the (slow) worklet load and the resume finish.

type Message = { type: 'on'; hz: number } | { type: 'off' };

let contexts: FakeContext[];
let nodes: FakeNode[];
/** How the next context behaves. */
let startRunning: boolean;
let workletLoads: Array<{ resolve: () => void; reject: (e: Error) => void }>;
/** False models a page that is not a secure context, where `audioWorklet` does not exist. */
let hasWorklet: boolean;
let processors: FakeProcessor[];

class FakeProcessor {
  onaudioprocess: ((e: { outputBuffer: FakeBuffer; playbackTime: number }) => void) | null = null;
  connected = false;
  private nextTime = 1;
  constructor(readonly bufferSize: number) {
    processors.push(this);
  }
  connect(): void {
    this.connected = true;
  }
  /**
   * Run one audio block and return what was written to each output channel. Blocks follow one
   * another on time unless `skipBlocks` says that many were missed first.
   */
  process(frames = 1024, skipBlocks = 0): Float32Array[] {
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    this.nextTime += skipBlocks * (frames / 48000);
    this.onaudioprocess?.({ outputBuffer: new FakeBuffer(channels), playbackTime: this.nextTime });
    this.nextTime += frames / 48000;
    return channels;
  }
}

class FakeBuffer {
  constructor(private readonly channels: Float32Array[]) {}
  get length(): number {
    return (this.channels[0] as Float32Array).length;
  }
  get numberOfChannels(): number {
    return this.channels.length;
  }
  getChannelData(c: number): Float32Array {
    return this.channels[c] as Float32Array;
  }
}

class FakeNode {
  readonly posted: Message[] = [];
  readonly port = { postMessage: (m: Message) => void this.posted.push(m) };
  constructor() {
    nodes.push(this);
  }
  connect(): void {}
}

class FakeContext {
  state: 'running' | 'suspended' = startRunning ? 'running' : 'suspended';
  sampleRate = 48000;
  destination = {};
  resumeCalls = 0;
  silentSources = 0;
  audioWorklet = hasWorklet
    ? { addModule: () => new Promise<void>((resolve, reject) => workletLoads.push({ resolve, reject })) }
    : undefined;
  constructor() {
    contexts.push(this);
  }
  createScriptProcessor(bufferSize: number): FakeProcessor {
    return new FakeProcessor(bufferSize);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
  createBuffer(): object {
    return {};
  }
  createBufferSource(): object {
    this.silentSources++;
    return { connect() {}, start() {} };
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  contexts = [];
  nodes = [];
  workletLoads = [];
  processors = [];
  hasWorklet = true;
  startRunning = false;
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('navigator', {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AudioEngine keyboard tone', () => {
  it('plays while held and stops on release', async () => {
    const engine = new AudioEngine();
    const pending = engine.noteOn(60);
    await flush();
    workletLoads[0]?.resolve();
    await pending;
    expect(nodes[0]?.posted).toEqual([{ type: 'on', hz: expect.closeTo(261.63, 1) }]);

    engine.noteOff();
    expect(nodes[0]?.posted.at(-1)).toEqual({ type: 'off' });
  });

  it('does not leave a tone stuck on when released before the worklet has loaded', async () => {
    vi.useFakeTimers();
    const engine = new AudioEngine();
    const pending = engine.noteOn(60);
    await vi.advanceTimersByTimeAsync(0);

    engine.noteOff(); // the worklet does not exist yet, so there is nothing to tell
    workletLoads[0]?.resolve();
    await pending;

    // It still sounds, so a quick first tap is heard...
    expect(nodes[0]?.posted).toEqual([{ type: 'on', hz: expect.any(Number) }]);
    // ...and it is switched off again rather than droning on.
    await vi.advanceTimersByTimeAsync(MIN_TAP_MS);
    expect(nodes[0]?.posted.at(-1)).toEqual({ type: 'off' });
  });

  it('does not cut off a newer key when an earlier, late-starting one times out', async () => {
    vi.useFakeTimers();
    const engine = new AudioEngine();
    const first = engine.noteOn(60);
    await vi.advanceTimersByTimeAsync(0);
    engine.noteOff();
    workletLoads[0]?.resolve();
    await first; // sounds briefly, off scheduled

    const second = engine.noteOn(64); // pressed again inside that window, and still held
    await second;
    await vi.advanceTimersByTimeAsync(MIN_TAP_MS);
    const offs = nodes[0]?.posted.filter((m) => m.type === 'off') ?? [];
    expect(offs).toHaveLength(0);
  });

  it('keeps a superseded press silent', async () => {
    const engine = new AudioEngine();
    const first = engine.noteOn(60);
    await flush();
    const second = engine.noteOn(64);
    await flush();
    workletLoads[0]?.resolve();
    await Promise.all([first, second]);
    const ons = nodes[0]?.posted.filter((m) => m.type === 'on') ?? [];
    expect(ons).toHaveLength(1);
    expect(ons[0]).toEqual({ type: 'on', hz: expect.closeTo(329.63, 1) });
  });

  it('retries after the worklet fails to load, instead of failing for good', async () => {
    const engine = new AudioEngine();
    const failed = engine.noteOn(60);
    await flush();
    workletLoads[0]?.reject(new Error('network down'));
    await expect(failed).rejects.toThrow('network down');

    engine.noteOff();
    const retry = engine.noteOn(60);
    await flush();
    expect(workletLoads).toHaveLength(2); // a second attempt was made
    workletLoads[1]?.resolve();
    await retry;
    expect(nodes).toHaveLength(1);
  });
});

describe('AudioEngine without AudioWorklet (page not served over https)', () => {
  beforeEach(() => {
    hasWorklet = false;
  });

  it('still plays the tone, through a script processor', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(69);
    const processor = processors[0];
    expect(processor?.connected).toBe(true);
    expect(workletLoads).toHaveLength(0); // no worklet was attempted

    const [left, right] = processor?.process() ?? [];
    expect(Math.max(...(left as Float32Array))).toBeGreaterThan(0.3); // the tone, not silence
    expect(right).toEqual(left); // centred: both channels carry it
  });

  it('still sounds a key that is struck and released within one block', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(69);
    engine.noteOff(); // a quick tap: over before the next block has been rendered
    const [first] = processors[0]?.process(4096) ?? [];
    expect(Math.max(...(first as Float32Array))).toBeGreaterThan(0.3); // heard, not skipped
    // ...and it then dies away by itself rather than droning on.
    processors[0]?.process(4096);
    const [later] = processors[0]?.process(4096) ?? [];
    expect(Math.max(...Array.from(later as Float32Array).map(Math.abs))).toBe(0);
  });

  it('releases a held key straight away once it has been heard', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(69);
    processors[0]?.process(4096); // rendered: now it has been heard
    engine.noteOff();
    const [next] = processors[0]?.process(4096) ?? [];
    // The fade-out starts at the very start of this block, so the tail is already silent.
    expect(Math.max(...Array.from((next as Float32Array).subarray(-256)).map(Math.abs))).toBe(0);
  });

  it('fades out after the key is released', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(69);
    processors[0]?.process(); // heard
    engine.noteOff();
    processors[0]?.process(); // covers the release fade
    const [left] = processors[0]?.process() ?? [];
    expect(Math.max(...(left as Float32Array).map(Math.abs))).toBe(0);
  });

  describe('block size', () => {
    it('defaults to a large block, to ride out a busy main thread', async () => {
      await new AudioEngine().noteOn(60);
      expect(processors[0]?.bufferSize).toBe(DEFAULT_FALLBACK_BUFFER);
      expect(DEFAULT_FALLBACK_BUFFER).toBeGreaterThanOrEqual(4096);
    });

    it('takes a size from the options, and reports it with its latency', async () => {
      const engine = new AudioEngine({ fallbackBufferSize: 2048 });
      await engine.noteOn(60);
      expect(processors[0]?.bufferSize).toBe(2048);
      expect(engine.debugLines().join('\n')).toContain('2048-frame blocks (43 ms)');
    });

    it('ignores a size Web Audio would reject', () => {
      for (const bad of [0, 1000, 3000, 32768, -4096, Number.NaN]) {
        expect(chooseBufferSize(bad)).toBe(DEFAULT_FALLBACK_BUFFER);
      }
      expect(chooseBufferSize(undefined)).toBe(DEFAULT_FALLBACK_BUFFER);
      for (const good of [256, 512, 1024, 2048, 4096, 8192, 16384]) expect(chooseBufferSize(good)).toBe(good);
    });
  });

  it('unlock does not throw, and prepares the tone ahead of the first key', async () => {
    const engine = new AudioEngine();
    await expect(engine.unlock()).resolves.toBe(true);
    await flush();
    expect(processors).toHaveLength(1);
    await engine.noteOn(60);
    expect(processors).toHaveLength(1); // reused, not created again
  });

  it('counts blocks that arrive late as dropouts, and not blocks that are on time', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(69);
    const dropouts = () => engine.debugLines().find((l) => l.startsWith('fallback tone dropouts'));
    const p = processors[0];

    for (let i = 0; i < 5; i++) p?.process();
    expect(dropouts()).toBe('fallback tone dropouts: 0');

    p?.process(1024, 3); // the main thread was busy: three blocks' worth of time went by
    expect(dropouts()).toBe('fallback tone dropouts: 1');
    p?.process();
    expect(dropouts()).toBe('fallback tone dropouts: 1'); // back on time
  });

  it('crossfades between keys through the script processor too', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(45); // A2
    processors[0]?.process(4096);
    engine.noteOff();
    await engine.noteOn(93); // A6, struck while A2 is still fading
    const [left] = processors[0]?.process(2048) ?? [];
    const dips = Array.from({ length: 30 }, (_, i) => Math.max(...Array.from((left as Float32Array).subarray(i * 16, i * 16 + 64)).map(Math.abs)));
    expect(Math.min(...dips)).toBeGreaterThan(0.1); // never falls silent between the two
  });

  it('says why in the debug lines', async () => {
    const engine = new AudioEngine();
    await engine.noteOn(60);
    expect(engine.debugLines().join('\n')).toContain('AudioWorklet unavailable');
  });
});

describe('AudioEngine.unlock', () => {
  it('resumes a suspended context and loads the worklet ahead of the first key', async () => {
    const engine = new AudioEngine();
    const running = await engine.unlock();
    expect(running).toBe(true);
    expect(contexts[0]?.resumeCalls).toBe(1);
    expect(contexts[0]?.silentSources).toBe(1);
    expect(workletLoads).toHaveLength(1); // requested without any key being pressed
  });

  it('does not resume a context that is already running', async () => {
    startRunning = true;
    const engine = new AudioEngine();
    await engine.unlock();
    expect(contexts[0]?.resumeCalls).toBe(0);
  });

  it('shares one worklet load with a key pressed straight afterwards', async () => {
    const engine = new AudioEngine();
    await engine.unlock();
    const pending = engine.noteOn(69);
    await flush();
    expect(workletLoads).toHaveLength(1);
    workletLoads[0]?.resolve();
    await pending;
    expect(nodes[0]?.posted).toEqual([{ type: 'on', hz: expect.closeTo(440, 1) }]);
  });

  it('asks iOS to play through the ringer switch when it can', async () => {
    const audioSession = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession });
    await new AudioEngine().unlock();
    expect(audioSession.type).toBe('playback');
  });
});

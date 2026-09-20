import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_SECOND,
  formatTicks,
  sampleToTicks,
  smpteToTicks,
  subtractTicks,
  ticksToSample,
  ticksToSmpte,
} from '../src/core/AudioTime';
import { hzToMidi, hzToSemitones, isBlackKey, midiToHz, noteName, noteStatusText, octaveOf } from '../src/core/notes';
import { dftReal, fftInPlace, floorPowerOfTwo, isPowerOfTwo, nextPowerOfTwo } from '../src/core/fft';
import { MU, compandSeries, muLaw, visibleMax } from '../src/core/scaling';
import { buildEnvelope, mixToMono } from '../src/core/envelope';
import { ARBITRARY_LENGTH_LIMIT, analyzeRange, hannWindow } from '../src/core/spectrum';
import { findPeaks } from '../src/core/peaks';
import { findClump } from '../src/core/clump';
import { graphSemitoneRange, hitTestKey, keyLeft, keyWidth, noteToFraction } from '../src/core/keyboardGeometry';

describe('AudioTime', () => {
  it('runs at 120 ticks per second', () => {
    expect(TICKS_PER_SECOND).toBe(120);
  });

  it('matches the original GetAllInSubframes formula', () => {
    // (h*108000 + m*1800 + s*30 + f) * 4 + subframes
    expect(smpteToTicks({ hours: 1, minutes: 2, seconds: 3, frames: 4, subframes: 1 })).toBe(
      (108000 + 2 * 1800 + 3 * 30 + 4) * 4 + 1,
    );
  });

  it('round-trips ticks <-> SMPTE', () => {
    for (const t of [0, 1, 3, 4, 119, 120, 7199, 7200, 432000, 1234567]) {
      expect(smpteToTicks(ticksToSmpte(t))).toBe(t);
    }
  });

  it('formats HH:MM:SS:FF, hiding subframes', () => {
    expect(formatTicks(0)).toBe('00:00:00:00');
    // The screenshot shows "00:00:03:10": 3 s + 10 frames.
    expect(formatTicks(3 * 120 + 10 * 4 + 3)).toBe('00:00:03:10');
    expect(formatTicks(smpteToTicks({ hours: 1, minutes: 1, seconds: 1, frames: 1 }))).toBe('01:01:01:01');
  });

  it('has 367.5 samples per tick and 1470 per frame at 44.1 kHz', () => {
    expect(ticksToSample(2, 44100)).toBe(735);
    expect(ticksToSample(4, 44100)).toBe(1470);
    expect(ticksToSample(120, 44100)).toBe(44100);
  });

  it('maps samples back to their tick', () => {
    expect(sampleToTicks(0, 44100)).toBe(0);
    expect(sampleToTicks(367, 44100)).toBe(0);
    expect(sampleToTicks(368, 44100)).toBe(1);
    expect(sampleToTicks(44100, 44100)).toBe(120);
  });

  it('clamps subtraction at zero like the original', () => {
    expect(subtractTicks(5, 9)).toBe(0);
    expect(subtractTicks(9, 5)).toBe(4);
  });
});

describe('notes', () => {
  it('maps A4 to exactly 440 Hz', () => {
    expect(midiToHz(69)).toBe(440);
  });

  it('gives middle C as 261.6256 Hz and calls it C4', () => {
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
    expect(noteName(60)).toBe('C4');
    expect(octaveOf(60)).toBe(4);
    expect(noteStatusText(60)).toBe('60 (C4)');
  });

  it('spans the piano: A0 = 27.5 Hz, C8 = MIDI 108', () => {
    expect(midiToHz(21)).toBeCloseTo(27.5, 10);
    expect(noteName(21)).toBe('A0');
    expect(noteName(108)).toBe('C8');
  });

  it('names F as F (original returned "Fb")', () => {
    expect(noteName(65)).toBe('F4');
  });

  it('identifies black keys', () => {
    const black = [61, 63, 66, 68, 70];
    for (let n = 60; n < 72; n++) expect(isBlackKey(n)).toBe(black.includes(n) || black.includes(n - 12));
  });

  it('inverts hz <-> semitones <-> midi', () => {
    for (const n of [21, 40, 60, 69, 96, 108]) {
      expect(hzToMidi(midiToHz(n))).toBeCloseTo(n, 10);
      expect(hzToSemitones(midiToHz(n))).toBeCloseTo(n - 69, 10);
    }
  });
});

describe('fft', () => {
  it('classifies powers of two', () => {
    expect(isPowerOfTwo(1024)).toBe(true);
    expect(isPowerOfTwo(1000)).toBe(false);
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(floorPowerOfTwo(1000)).toBe(512);
    expect(floorPowerOfTwo(1024)).toBe(1024);
  });

  it('puts all the power of a bin-centred sine in that bin', () => {
    const n = 1024;
    const k0 = 37;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k0 * i) / n);
    fftInPlace(re, im);
    const power = (k: number) => (re[k] as number) ** 2 + (im[k] as number) ** 2;
    const total = Array.from({ length: n / 2 }, (_, k) => power(k)).reduce((a, b) => a + b, 0);
    expect(power(k0) / total).toBeGreaterThan(0.999999);
  });

  it('obeys Parseval', () => {
    const n = 512;
    const x = new Float64Array(n).map(() => Math.random() * 2 - 1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fftInPlace(re, im);
    const time = x.reduce((a, v) => a + v * v, 0);
    let freq = 0;
    for (let k = 0; k < n; k++) freq += (re[k] as number) ** 2 + (im[k] as number) ** 2;
    expect(freq / n).toBeCloseTo(time, 8);
  });

  it('agrees with the naive DFT at a power-of-two length', () => {
    const n = 128;
    const x = new Float64Array(n).map(() => Math.random() * 2 - 1);
    const fast = { re: Float64Array.from(x), im: new Float64Array(n) };
    fftInPlace(fast.re, fast.im);
    const slow = dftReal(x);
    for (let k = 0; k < n; k++) {
      expect(fast.re[k]).toBeCloseTo(slow.re[k] as number, 9);
      expect(fast.im[k]).toBeCloseTo(slow.im[k] as number, 9);
    }
  });

  it('handles non-power-of-two lengths via the DFT', () => {
    const n = 100;
    const k0 = 7;
    const x = new Float64Array(n).map((_, i) => Math.cos((2 * Math.PI * k0 * i) / n));
    const { re, im } = dftReal(x);
    expect(Math.hypot(re[k0] as number, im[k0] as number)).toBeCloseTo(n / 2, 8);
  });
});

describe('scaling', () => {
  it('is mu-law with mu = 255', () => {
    expect(MU).toBe(255);
    expect(muLaw(0)).toBe(0);
    expect(muLaw(1)).toBeCloseTo(1, 12);
    expect(muLaw(0.5)).toBeCloseTo(Math.log(1 + 255 * 0.5) / Math.log(256), 12);
  });

  it('is symmetric in sign', () => {
    expect(muLaw(-0.3)).toBeCloseTo(-muLaw(0.3), 12);
  });

  it('autoscales to the loudest point inside the visible range only', () => {
    const xs = [-20, -5, 0, 5, 20];
    const ys = [1000, 4, 8, 2, 1000];
    expect(visibleMax(xs, ys, -10, 10)).toBe(8);
    const c = compandSeries(xs, ys, -10, 10);
    expect(c[2]).toBeCloseTo(1, 12); // loudest visible bin sits at the top
    expect(c[0]).toBeGreaterThan(1); // out-of-range points may exceed 1
  });

  it('returns zeros for silence instead of dividing by zero', () => {
    const c = compandSeries([0, 1, 2], [0, 0, 0], -1, 3);
    expect(Array.from(c)).toEqual([0, 0, 0]);
  });
});

describe('envelope', () => {
  it('averages absolute sample values per tick', () => {
    const sr = 1200; // 10 samples per tick
    const samples = new Float32Array(30);
    samples.fill(0.5, 0, 10);
    samples.fill(-0.25, 10, 20);
    samples.fill(1, 20, 30);
    const env = buildEnvelope(samples, sr);
    expect(env.length).toBe(3);
    expect(env[0]).toBeCloseTo(0.5, 6);
    expect(env[1]).toBeCloseTo(0.25, 6);
    expect(env[2]).toBeCloseTo(1, 6);
  });

  it('produces 120 buckets per second', () => {
    expect(buildEnvelope(new Float32Array(44100), 44100).length).toBe(120);
  });

  it('mixes channels by arithmetic mean', () => {
    const mono = mixToMono([Float32Array.of(1, 0, -1), Float32Array.of(0, 1, -1)]);
    expect(Array.from(mono)).toEqual([0.5, 0.5, -1]);
  });
});

function tone(freqs: number[], seconds: number, sr: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  for (const f of freqs) {
    for (let i = 0; i < out.length; i++) {
      (out as Float32Array)[i] = (out[i] as number) + (0.3 * Math.sin((2 * Math.PI * f * i) / sr)) / freqs.length;
    }
  }
  return out;
}

describe('spectrum', () => {
  const sr = 44100;

  it('puts an A440 peak on the 0-semitone position', () => {
    const s = analyzeRange(tone([440], 1, sr), 0, sr, sr, { window: 'hann' })!;
    let best = 0;
    for (let i = 1; i < s.power.length; i++) if ((s.power[i] as number) > (s.power[best] as number)) best = i;
    expect(Math.abs(s.semitones[best] as number)).toBeLessThan(0.1);
  });

  it('finds every note of a D9(#11) chord', () => {
    // D, F#, A, C, E, G# from the original help page (MIDI 62, 66, 69, 72, 76, 80).
    const midis = [62, 66, 69, 72, 76, 80];
    const s = analyzeRange(tone(midis.map((m) => midiToHz(m)), 2, sr), 0, 2 * sr, sr, { window: 'hann' })!;
    const heights = compandSeries(s.semitones, s.power, -30, 30);
    const peaks = findPeaks(s.semitones, heights, -30, 30, { maxPeaks: 6 });
    const found = peaks.map((p) => Math.round(p.semitone + 69)).sort((a, b) => a - b);
    expect(found).toEqual(midis);
  });

  it('never emits the DC bin', () => {
    const s = analyzeRange(tone([440], 0.5, sr), 0, sr / 2, sr)!;
    expect(s.semitones.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('zero-pads up (hann) or truncates down (rectangular), as designed', () => {
    const x = tone([440], 1, sr);
    expect(analyzeRange(x, 0, 30000, sr, { window: 'hann' })!.fftSize).toBe(32768);
    expect(analyzeRange(x, 0, 40000, sr, { window: 'rectangular' })!.fftSize).toBe(32768);
    expect(analyzeRange(x, 0, 33000, sr, { window: 'rectangular' })!.fftSize).toBe(32768);
  });

  it('uses the exact length at or below the 5000 sample limit in rectangular mode', () => {
    const x = tone([440], 1, sr);
    expect(analyzeRange(x, 0, ARBITRARY_LENGTH_LIMIT, sr, { window: 'rectangular' })!.fftSize).toBe(5000);
    expect(analyzeRange(x, 0, 3001, sr, { window: 'rectangular' })!.fftSize).toBe(3001);
  });

  it('returns raw int16-scaled power with no normalisation', () => {
    // Rectangular, bin-centred sine, amplitude a: power at the bin = (a * 32768 * N / 2)^2.
    const n = 1024;
    const a = 0.5;
    const k0 = 50;
    const x = new Float32Array(n).map((_, i) => a * Math.sin((2 * Math.PI * k0 * i) / n));
    const s = analyzeRange(x, 0, n, 44100, { window: 'rectangular' })!;
    const peak = Math.max(...Array.from(s.power));
    expect(peak / (a * 32768 * (n / 2)) ** 2).toBeCloseTo(1, 4);
  });

  it('averages frames (Welch) for selections beyond the FFT size cap, keeping the peak in place', () => {
    const x = tone([midiToHz(69)], 1, sr);
    const capped = analyzeRange(x, 0, 30000, sr, { window: 'hann', maxFftSize: 4096 })!;
    expect(capped.frames).toBe(Math.ceil(30000 / 4096));
    expect(capped.fftSize).toBeLessThanOrEqual(4096);
    let best = 0;
    for (let i = 1; i < capped.power.length; i++) if ((capped.power[i] as number) > (capped.power[best] as number)) best = i;
    expect(Math.abs(capped.semitones[best] as number)).toBeLessThan(0.3);
  });

  it('caps the rectangular transform at maxFftSize too', () => {
    const x = tone([440], 1, sr);
    expect(analyzeRange(x, 0, 40000, sr, { window: 'rectangular', maxFftSize: 8192 })!.fftSize).toBe(8192);
  });

  it('includes the Nyquist bin for even transform lengths and not for odd', () => {
    const x = tone([440], 1, sr);
    const even = analyzeRange(x, 0, 4000, sr, { window: 'rectangular' })!;
    const odd = analyzeRange(x, 0, 4001, sr, { window: 'rectangular' })!;
    expect(even.semitones.length).toBe(4000 / 2); // bins 1..1999 plus Nyquist
    expect(odd.semitones.length).toBe(2000); // bins 1..2000, no Nyquist
  });

  it('reports null for a selection too short to analyse', () => {
    expect(analyzeRange(new Float32Array(100), 10, 11, sr)).toBeNull();
  });

  it('builds a Hann window that starts at zero and peaks in the middle', () => {
    const w = hannWindow(8);
    expect(w[0]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 12);
  });
});

describe('keyboard geometry', () => {
  const range = { left: 21, right: 108 }; // full 88-key piano
  const W = 880;
  const H = 50;

  it('gives every key the same width', () => {
    expect(keyWidth(range, W)).toBeCloseTo(10, 10);
    expect(keyLeft(22, range, W) - keyLeft(21, range, W)).toBeCloseTo(10, 10);
  });

  it('centres a note over its key, matching the graph range padding', () => {
    const { left, right } = graphSemitoneRange(range);
    const noteSemitone = 60 - 69;
    const graphFrac = (noteSemitone - left) / (right - left);
    expect(graphFrac).toBeCloseTo(noteToFraction(60, range), 10);
  });

  it('resolves the upper half on the uniform grid', () => {
    // MIDI 61 (Db) is black; its cell is x in [400, 410).
    expect(hitTestKey(405, 10, W, H, range)).toBe(61);
    expect(hitTestKey(401, 10, W, H, range)).toBe(61);
  });

  it('remaps the lower half of a black-key column to the neighbouring white key', () => {
    // Db(61) cell [400,410): left of its midpoint -> C(60), right -> D(62).
    expect(hitTestKey(402, 40, W, H, range)).toBe(60);
    expect(hitTestKey(408, 40, W, H, range)).toBe(62);
  });

  it('leaves white-key columns alone in the lower half', () => {
    expect(hitTestKey(395, 40, W, H, range)).toBe(60); // C cell [390,400)
  });

  it('returns -1 outside the keyboard and clamps at the edges', () => {
    expect(hitTestKey(-1, 10, W, H, range)).toBe(-1);
    expect(hitTestKey(10, 60, W, H, range)).toBe(-1);
    expect(hitTestKey(W, 10, W, H, range)).toBe(108);
    expect(hitTestKey(0, 10, W, H, range)).toBe(21);
  });
});

describe('findClump', () => {
  const quiet = (n: number) => new Float32Array(n).fill(0.01);

  it('returns null for silence and for empty windows', () => {
    expect(findClump(new Float32Array(100), 0, 100)).toBeNull();
    expect(findClump(quiet(100), 50, 50)).toBeNull();
  });

  it('finds a single clump in a quiet window', () => {
    const env = quiet(1000);
    env.fill(0.8, 400, 440);
    const clump = findClump(env, 0, 1000)!;
    expect(clump.start).toBeGreaterThanOrEqual(395);
    expect(clump.end).toBeLessThanOrEqual(445);
    expect(clump.start).toBeLessThan(410);
    expect(clump.end).toBeGreaterThan(430);
  });

  it('prefers the clump with more energy', () => {
    const env = quiet(1000);
    env.fill(0.5, 100, 130);
    env.fill(0.9, 600, 660);
    const clump = findClump(env, 0, 1000)!;
    expect(clump.start).toBeGreaterThanOrEqual(590);
    expect(clump.end).toBeLessThanOrEqual(670);
  });

  it('merges small dips into one clump', () => {
    const env = quiet(1000);
    env.fill(0.8, 300, 330);
    env.fill(0.8, 335, 365);
    const clump = findClump(env, 0, 1000)!;
    expect(clump.start).toBeLessThan(310);
    expect(clump.end).toBeGreaterThan(355);
  });

  it('narrows a clump that fills the window to about a third of it', () => {
    const env = new Float32Array(1000).fill(0.7);
    const clump = findClump(env, 0, 1000)!;
    expect(clump.end - clump.start).toBe(350);
    expect(clump.start).toBeGreaterThanOrEqual(0);
    expect(clump.end).toBeLessThanOrEqual(1000);
  });

  it('widens a sliver to a draggable width', () => {
    const env = quiet(1000);
    env[500] = 1;
    const clump = findClump(env, 0, 1000)!;
    expect(clump.end - clump.start).toBe(50);
    expect(clump.start).toBeLessThanOrEqual(500);
    expect(clump.end).toBeGreaterThan(500);
  });

  it('only looks inside the requested window', () => {
    const env = quiet(1000);
    env.fill(1, 100, 200);
    env.fill(0.4, 700, 760);
    const clump = findClump(env, 600, 900)!;
    expect(clump.start).toBeGreaterThanOrEqual(600);
    expect(clump.end).toBeLessThanOrEqual(900);
  });

  it('stays inside the window when the clump touches its edge', () => {
    const env = quiet(1000);
    env.fill(0.9, 0, 3);
    const clump = findClump(env, 0, 1000)!;
    expect(clump.start).toBeGreaterThanOrEqual(0);
    expect(clump.end - clump.start).toBe(50);
  });
});

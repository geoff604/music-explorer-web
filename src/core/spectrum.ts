/**
 * One-shot spectrum of a selected range of samples.
 *
 * This is the port of CSampleFileManager::AnalyzeSelectionToGraph (SampleFileManager.cpp:
 * 326-426). It is NOT a rolling STFT: a single transform is taken over the whole selection and
 * drawn as a static graph.
 *
 * What is kept from the original:
 *   - intensity is raw power, Re^2 + Im^2 (no sqrt, no 1/N normalisation)
 *   - bin k sits at k / N * sampleRate
 *   - x is semitones from A440; the DC bin is dropped (frequency < 0.001)
 *   - input is scaled to the int16 range the original fed to FFTW
 *
 * What differs, by design:
 *   - 'hann' (default) applies a Hann window and zero-pads UP to the next power of two, so
 *     the whole selection is analysed. Selections longer than `maxFftSize` are split into equal
 *     frames whose power spectra are averaged (Welch), rather than allocating huge buffers.
 *   - 'rectangular' reproduces the original: no window, and above 5000 samples the selection
 *     is truncated DOWN to a power of two (capped at `maxFftSize`); at or below 5000 it uses the
 *     exact length.
 *   - the Nyquist bin is included whenever the transform length is even. The original tested
 *     the pre-truncation sample count instead, which silently dropped it in some cases.
 */

import { dftReal, fftInPlace, floorPowerOfTwo, isPowerOfTwo, nextPowerOfTwo } from './fft';
import { hzToSemitones } from './notes';

export type WindowKind = 'hann' | 'rectangular';

/** Above this many samples the original switched to a power-of-two FFT. */
export const ARBITRARY_LENGTH_LIMIT = 5000;

/** Scale from Web Audio's -1..1 floats to the int16 range the original operated on. */
export const INT16_SCALE = 32768;

/** Largest single transform (2^21 = 2M points, ~32 MB of working memory). */
export const DEFAULT_MAX_FFT_SIZE = 1 << 21;

export interface Spectrum {
  /** Bin position in semitones from A440 (MIDI note number minus 69). Ascending. */
  semitones: Float64Array;
  /** Power (Re^2 + Im^2) of each bin, in int16-squared units. */
  power: Float64Array;
  /** Transform length actually used. */
  fftSize: number;
  /** Width of one bin in Hz. */
  binHz: number;
  /** Number of frames averaged (1 except for very long Hann selections). */
  frames: number;
}

export interface AnalyzeOptions {
  window?: WindowKind;
  /** Cap on the transform length; defaults to {@link DEFAULT_MAX_FFT_SIZE}. A power of two. */
  maxFftSize?: number;
}

/** Hann window of length n: 0.5 * (1 - cos(2*pi*i / n)) (periodic form, suited to spectra). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * Power of bins 0..floor(N/2) for `used` samples starting at `from`, zero-padded to `n` and
 * optionally Hann-windowed over the real samples. Returns Re^2 + Im^2 per bin.
 */
function framePower(
  samples: Float32Array,
  from: number,
  used: number,
  n: number,
  windowed: boolean,
): Float64Array {
  const re = new Float64Array(n); // zero-padded past `used`
  if (windowed) {
    const w = hannWindow(used);
    for (let i = 0; i < used; i++) {
      re[i] = (samples[from + i] as number) * INT16_SCALE * (w[i] as number);
    }
  } else {
    for (let i = 0; i < used; i++) re[i] = (samples[from + i] as number) * INT16_SCALE;
  }

  let im: Float64Array;
  let outRe: Float64Array = re;
  if (isPowerOfTwo(n)) {
    im = new Float64Array(n);
    fftInPlace(re, im);
  } else {
    const t = dftReal(re);
    outRe = t.re;
    im = t.im;
  }

  const bins = (n >> 1) + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const r = outRe[k] as number;
    const i = im[k] as number;
    power[k] = r * r + i * i;
  }
  return power;
}

export function analyzeRange(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
  options: AnalyzeOptions = {},
): Spectrum | null {
  const kind = options.window ?? 'hann';
  const maxFft = options.maxFftSize ?? DEFAULT_MAX_FFT_SIZE;
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(samples.length, Math.floor(endSample));
  const count = end - start;
  if (count < 2) return null;

  let n: number; // transform length
  let frames = 1;
  let acc: Float64Array;

  if (kind === 'hann') {
    frames = Math.ceil(count / maxFft);
    const frameLen = Math.ceil(count / frames);
    n = nextPowerOfTwo(frameLen);
    acc = new Float64Array((n >> 1) + 1);
    for (let f = 0; f < frames; f++) {
      const from = start + f * frameLen;
      const used = Math.min(frameLen, end - from);
      if (used < 2) continue;
      const p = framePower(samples, from, used, n, true);
      for (let k = 0; k < acc.length; k++) acc[k] = (acc[k] as number) + (p[k] as number);
    }
    if (frames > 1) for (let k = 0; k < acc.length; k++) acc[k] = (acc[k] as number) / frames;
  } else {
    n = count > ARBITRARY_LENGTH_LIMIT ? Math.min(floorPowerOfTwo(count), maxFft) : count;
    acc = framePower(samples, start, n, n, false);
  }

  const semitones: number[] = [];
  const power: number[] = [];
  const push = (k: number) => {
    const hz = (k / n) * sampleRate;
    if (hz < 0.001) return; // MusicGraph::AddFrequency drops the DC bin
    semitones.push(hzToSemitones(hz));
    power.push(acc[k] as number);
  };

  // Bins 1 .. floor((N-1)/2): each folds the conjugate pair into one power value. Then the
  // Nyquist bin, which exists only for even N and is purely real.
  const half = (n + 1) >> 1;
  for (let k = 1; k < half; k++) push(k);
  if (n % 2 === 0) push(n >> 1);

  return {
    semitones: Float64Array.from(semitones),
    power: Float64Array.from(power),
    fftSize: n,
    binHz: sampleRate / n,
    frames,
  };
}

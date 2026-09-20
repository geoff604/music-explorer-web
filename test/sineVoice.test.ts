import { describe, expect, it } from 'vitest';
import {
  RAMP_SECONDS,
  SineVoice,
  TABLE_AMPLITUDE,
  TABLE_LENGTH,
  buildSineTable,
  effectiveHz,
  phaseIncrement,
} from '../src/core/sineVoice';

describe('sine table', () => {
  const table = buildSineTable();

  it('has 1024 entries peaking at the original amplitude', () => {
    expect(table.length).toBe(TABLE_LENGTH);
    expect(Math.max(...Array.from(table))).toBe(TABLE_AMPLITUDE);
    expect(table[0]).toBe(0);
  });

  it('is antisymmetric about half a cycle, truncated toward zero', () => {
    expect(table[256]).toBe(15000);
    expect(table[768]).toBe(-15000);
    // Truncation toward zero (not floor) keeps positive and negative halves symmetric.
    for (let i = 1; i < 512; i++) expect(table[i + 512]).toBe(-(table[i] as number));
  });
});

describe('phase increment', () => {
  it('truncates to an integer, as the original did', () => {
    // A440 at 44.1 kHz: (440/44100) * 2^20 = 10461.98... -> 10461 (truncated, not rounded)
    expect(phaseIncrement(440, 44100)).toBe(10461);
  });

  it('always errs flat, by less than one phase step', () => {
    const step = 44100 / 1048576; // ~0.042 Hz
    for (const hz of [27.5, 110, 261.6256, 440, 1046.5, 3951.07]) {
      const err = hz - effectiveHz(hz, 44100);
      expect(err).toBeGreaterThanOrEqual(0);
      expect(err).toBeLessThan(step);
    }
    // A440 is close to the worst case: the fractional part is .98, all of which is dropped.
    expect(effectiveHz(440, 44100)).toBeCloseTo(439.9587, 4);
  });
});

describe('SineVoice', () => {
  const sr = 44100;

  it('is silent until a note is on', () => {
    const v = new SineVoice(sr);
    const out = new Float32Array(256);
    v.render(out);
    expect(out.every((s) => s === 0)).toBe(true);
    expect(v.silent).toBe(true);
  });

  it('ramps in rather than starting at full amplitude', () => {
    const v = new SineVoice(sr);
    v.noteOn(440);
    const out = new Float32Array(2048);
    v.render(out);
    const rampSamples = Math.ceil(RAMP_SECONDS * sr);
    expect(Math.abs(out[1] as number)).toBeLessThan(0.05);
    const tail = out.subarray(rampSamples + 10);
    expect(Math.max(...Array.from(tail).map(Math.abs))).toBeGreaterThan(0.4);
  });

  it('peaks at amplitude 15000/32768 (~0.4578)', () => {
    const v = new SineVoice(sr);
    v.noteOn(440);
    const out = new Float32Array(4096);
    v.render(out);
    const peak = Math.max(...Array.from(out).map(Math.abs));
    expect(peak).toBeCloseTo(15000 / 32768, 2);
  });

  it('fades to silence after noteOff', () => {
    const v = new SineVoice(sr);
    v.noteOn(440);
    v.render(new Float32Array(1024));
    v.noteOff();
    v.render(new Float32Array(1024));
    expect(v.silent).toBe(true);
  });

  it('produces the right pitch', () => {
    const v = new SineVoice(sr);
    v.noteOn(440);
    const out = new Float32Array(sr);
    v.render(out);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] as number) < 0 && (out[i] as number) >= 0) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });
});

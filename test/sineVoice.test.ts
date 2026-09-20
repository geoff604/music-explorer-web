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

  describe('switching tones', () => {
    /** Loudest sample in each 32-sample window: a rough amplitude envelope. */
    const envelope = (samples: Float32Array): number[] => {
      const out: number[] = [];
      for (let i = 0; i + 32 <= samples.length; i += 32) {
        out.push(Math.max(...Array.from(samples.subarray(i, i + 32)).map(Math.abs)));
      }
      return out;
    };

    it('only changes pitch once the old tone has faded to silence, so it cannot click', () => {
      const v = new SineVoice(sr);
      v.noteOn(110);
      v.render(new Float32Array(4096)); // fully up
      v.noteOn(1760); // pressed while 110 Hz is still sounding
      const out = new Float32Array(4096);
      v.render(out);

      const env = envelope(out);
      // The amplitude dips to (near) nothing between the two tones. A pitch change at full
      // amplitude never would, and that abrupt change is what is heard as a click.
      expect(Math.min(...env)).toBeLessThan(0.01);
      // ...and the new tone does arrive at full level afterwards.
      expect(Math.max(...env.slice(-20))).toBeGreaterThan(0.4);
    });

    it('plays the new pitch after the switch', () => {
      const v = new SineVoice(sr);
      v.noteOn(110);
      v.render(new Float32Array(4096));
      v.noteOn(440);
      v.render(new Float32Array(2048)); // through the gap
      const out = new Float32Array(sr);
      v.render(out);
      let crossings = 0;
      for (let i = 1; i < out.length; i++) if ((out[i - 1] as number) < 0 && (out[i] as number) >= 0) crossings++;
      expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
    });

    it('does not dip when the same pitch is struck again', () => {
      const v = new SineVoice(sr);
      v.noteOn(440);
      v.render(new Float32Array(4096));
      v.noteOn(440);
      const out = new Float32Array(2048);
      v.render(out);
      expect(Math.min(...envelope(out))).toBeGreaterThan(0.3);
    });

    it('lets a release cancel a switch that has not happened yet', () => {
      const v = new SineVoice(sr);
      v.noteOn(110);
      v.render(new Float32Array(4096));
      v.noteOn(440);
      v.noteOff();
      v.render(new Float32Array(4096));
      expect(v.silent).toBe(true);
      const later = new Float32Array(1024);
      v.render(later);
      expect(later.every((s) => s === 0)).toBe(true); // the cancelled note never starts
    });

    it('eases in gently over a fade that is not too short to remove the click', () => {
      expect(RAMP_SECONDS).toBeGreaterThanOrEqual(0.005);
      const v = new SineVoice(sr);
      v.noteOn(440);
      const firstMs = new Float32Array(Math.round(sr / 1000));
      v.render(firstMs);
      // A straight-line fade would already be at ~10% by now; an eased one has barely started.
      expect(Math.max(...Array.from(firstMs).map(Math.abs))).toBeLessThan(0.05 * (15000 / 32768));
    });

    it('fades in and out with no jump between samples larger than the tone itself makes', () => {
      const maxStep = (block: Float32Array): number => {
        let m = 0;
        for (let i = 1; i < block.length; i++) m = Math.max(m, Math.abs((block[i] as number) - (block[i - 1] as number)));
        return m;
      };
      const v = new SineVoice(sr);
      v.noteOn(220);
      const on = new Float32Array(2048);
      v.render(on);
      const steady = new Float32Array(2048);
      v.render(steady);
      // Measured, not derived: the tone reads an unsmoothed table, so its own steps are not ideal.
      const limit = maxStep(steady) * 1.02;
      v.noteOff();
      const off = new Float32Array(2048);
      v.render(off);
      expect(maxStep(on)).toBeLessThanOrEqual(limit);
      expect(maxStep(off)).toBeLessThanOrEqual(limit);
    });
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

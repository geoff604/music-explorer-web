import { describe, expect, it } from 'vitest';
import { RAMP_SECONDS, SineVoice } from '../src/core/sineVoice';
import { VOICE_COUNT, VoiceBank } from '../src/core/voiceBank';

const sr = 44100;
const rampSamples = Math.ceil(RAMP_SECONDS * sr);

const render = (bank: VoiceBank, frames: number): Float32Array => {
  const out = new Float32Array(frames);
  bank.render(out);
  return out;
};

/** Largest change between neighbouring samples: a discontinuity (a click) shows up as a big one. */
const maxStep = (block: Float32Array): number => {
  let m = 0;
  for (let i = 1; i < block.length; i++) m = Math.max(m, Math.abs((block[i] as number) - (block[i - 1] as number)));
  return m;
};

/** Loudest sample in each window: a rough amplitude envelope. */
const envelope = (samples: Float32Array, window: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i + window <= samples.length; i += window) {
    out.push(Math.max(...Array.from(samples.subarray(i, i + window)).map(Math.abs)));
  }
  return out;
};

/** The steepest step a full-level tone of this pitch makes on its own, measured. */
const steadyStep = (hz: number): number => {
  const v = new SineVoice(sr);
  v.noteOn(hz);
  v.render(new Float32Array(rampSamples * 2));
  const out = new Float32Array(sr / 4);
  v.render(out);
  return maxStep(out);
};

describe('VoiceBank', () => {
  it('is silent until a note is on, and plays the same tone a single voice does', () => {
    const bank = new VoiceBank(sr);
    expect(bank.silent).toBe(true);
    expect(render(bank, 256).every((s) => s === 0)).toBe(true);

    bank.noteOn(440);
    const out = render(bank, 4096);
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeCloseTo(15000 / 32768, 2);
  });

  it('crossfades between keys: the tone never drops out while switching', () => {
    const bank = new VoiceBank(sr);
    bank.noteOn(110);
    render(bank, 4096);
    bank.noteOn(1760); // pressed while 110 Hz is still sounding
    const out = render(bank, 4096);
    // The old voice is fading out while the new one fades in, so there is sound all the way
    // through. (A single voice had to fall silent between the two.)
    expect(Math.min(...envelope(out.subarray(0, rampSamples * 2), 64))).toBeGreaterThan(0.15);
    // ...and the new tone settles at full level.
    expect(Math.max(...envelope(out, 64).slice(-10))).toBeGreaterThan(0.4);
  });

  it('switches with no bigger step between samples than the two tones make on their own', () => {
    const bank = new VoiceBank(sr);
    bank.noteOn(110);
    render(bank, 4096);
    bank.noteOn(1760);
    const across = render(bank, 4096);
    // Two tones sounding together can at most add their own steps. A retune mid-wave, or a voice
    // cut off at full level, would step by far more than that: that is the click.
    const limit = (steadyStep(110) + steadyStep(1760)) * 1.05;
    expect(maxStep(across)).toBeLessThanOrEqual(limit);
  });

  it('switches cleanly however quickly the keys are struck', () => {
    const bank = new VoiceBank(sr);
    const pitches = [220, 330, 262, 494, 392, 147, 523, 349];
    // One continuous stream, as the speaker would get it, with a strike every ~2 ms: each fade has
    // barely begun when the next key lands.
    const stream = new Float32Array(pitches.length * 100);
    pitches.forEach((hz, i) => {
      bank.noteOn(hz);
      stream.set(render(bank, 100), i * 100);
    });
    // Overlapping tones can at most add their steps; two is the most that overlap heavily here.
    const limit = Math.max(...pitches.map(steadyStep)) * 2 * 1.05;
    expect(maxStep(stream)).toBeLessThanOrEqual(limit);
  });

  it('gives each key its own voice, so releasing one leaves the other to finish its fade', () => {
    const bank = new VoiceBank(sr);
    bank.noteOn(220);
    render(bank, 4096);
    bank.noteOn(440);
    render(bank, 100); // mid-crossfade
    bank.noteOff(); // release the new key while the old one is still fading
    const tail = render(bank, rampSamples * 3);
    expect(Math.max(...Array.from(tail.subarray(-64)).map(Math.abs))).toBe(0); // all done, no stray tone
    expect(bank.silent).toBe(true);
  });

  it('does not restart a released key when another is struck and released', () => {
    const bank = new VoiceBank(sr);
    bank.noteOn(220);
    render(bank, 4096);
    bank.noteOff();
    render(bank, rampSamples * 2);
    bank.noteOn(330);
    bank.noteOff();
    const out = render(bank, rampSamples * 4);
    expect(bank.silent).toBe(true);
    expect(Math.max(...Array.from(out.subarray(-64)).map(Math.abs))).toBe(0);
  });

  it('never gets louder than a single tone, however the keys are timed', () => {
    const single = 15000 / 32768;
    for (const gap of [20, 60, 100, 150, 220, 300, 441, 600, 900]) {
      for (const base of [110, 220, 440, 880]) {
        const bank = new VoiceBank(sr);
        for (let i = 0; i < VOICE_COUNT * 6; i++) {
          bank.noteOn(base * (1 + (i % 5) * 0.12));
          const peak = Math.max(...Array.from(render(bank, gap)).map(Math.abs));
          expect(peak).toBeLessThanOrEqual(single + 1e-6);
        }
      }
    }
  });

  it('keeps the pitch of the newest key when every voice is busy', () => {
    const bank = new VoiceBank(sr);
    for (let i = 0; i < VOICE_COUNT + 2; i++) {
      bank.noteOn(150 + i * 60);
      render(bank, 40);
    }
    bank.noteOn(440);
    render(bank, rampSamples * 6); // let every older voice finish
    const out = render(bank, sr);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] as number) < 0 && (out[i] as number) >= 0) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });
});

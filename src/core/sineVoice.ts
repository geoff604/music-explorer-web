/**
 * The piano-key tone generator, ported from SineWave (common/sinewave.cpp:73-118).
 *
 * The original is deliberately not a clean oscillator, and this keeps its character:
 *   - a 1024-entry table of int16 values, amplitude 15000 of 32767, truncated toward zero
 *   - a 2^20-entry "virtual" table indexed by a phase accumulator, read with `pos >> 10`
 *   - the phase increment is truncated (not rounded) to an integer, so every note is flat by
 *     somewhere between 0 and one step, sampleRate / 2^20 (~0.042 Hz at 44.1 kHz); A440 plays
 *     at 439.9587 Hz. There is no interpolation between table entries.
 *   - pi is the literal 3.14159265358
 * The phase accumulator is never reset between notes.
 *
 * One deliberate change: the original starts and stops at full amplitude, which clicks. Here the
 * gate ramps over a few milliseconds.
 */

export const TABLE_LENGTH = 1024;
export const VIRTUAL_LENGTH = 1048576; // 2^20
export const TABLE_AMPLITUDE = 15000; // out of 32767
export const ORIGINAL_PI = 3.14159265358;
export const RAMP_SECONDS = 0.005;

/** Build the int16 table exactly as SineWave::BuildTable does. */
export function buildSineTable(): Int16Array {
  const table = new Int16Array(TABLE_LENGTH);
  const scale = (2.0 * ORIGINAL_PI) / TABLE_LENGTH;
  for (let i = 0; i < TABLE_LENGTH; i++) {
    table[i] = Math.trunc(TABLE_AMPLITUDE * Math.sin(i * scale));
  }
  return table;
}

/** Phase step per output sample: `long increment = (freq / rate) * virtual_length` (truncated). */
export function phaseIncrement(hz: number, sampleRate: number): number {
  return Math.trunc((hz / sampleRate) * VIRTUAL_LENGTH);
}

/** The frequency actually produced once the increment has been truncated. */
export function effectiveHz(hz: number, sampleRate: number): number {
  return (phaseIncrement(hz, sampleRate) * sampleRate) / VIRTUAL_LENGTH;
}

export class SineVoice {
  private readonly table = buildSineTable();
  private pos = 0;
  private increment = 0;
  private gain = 0;
  private target = 0;
  private readonly gainStep: number;

  constructor(private readonly sampleRate: number) {
    this.gainStep = 1 / Math.max(1, RAMP_SECONDS * sampleRate);
  }

  /** Begin sounding `hz`. The phase is deliberately left where it was. */
  noteOn(hz: number): void {
    this.increment = phaseIncrement(hz, this.sampleRate);
    this.target = 1;
  }

  /** Fade out. The tone keeps running until the gain reaches zero. */
  noteOff(): void {
    this.target = 0;
  }

  get silent(): boolean {
    return this.gain === 0 && this.target === 0;
  }

  /** Fill `out` with samples in the -1..1 range. */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      if (this.gain < this.target) this.gain = Math.min(this.target, this.gain + this.gainStep);
      else if (this.gain > this.target) this.gain = Math.max(this.target, this.gain - this.gainStep);

      if (this.gain === 0) {
        out[i] = 0;
        continue;
      }
      const s = this.table[this.pos >> 10] as number;
      this.pos = (this.pos + this.increment) & (VIRTUAL_LENGTH - 1);
      out[i] = (s / 32768) * this.gain;
    }
  }
}

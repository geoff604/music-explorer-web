/**
 * Several {@link SineVoice}s mixed together, so each key sounds on a voice of its own.
 *
 * With a single voice a new key had to retune the tone that was still sounding, which meant fading
 * it out completely first (a gap) or changing pitch mid-wave (a click). Here the new key takes a
 * free voice and fades in while the previous key's voice fades out on its own, so the two
 * crossfade and never touch each other's phase.
 */

import { SineVoice } from './sineVoice';

export const VOICE_COUNT = 4;

export class VoiceBank {
  private readonly voices: SineVoice[];
  /** The voice for the key currently held, if any. */
  private held: SineVoice | null = null;
  private scratch = new Float32Array(0);

  constructor(sampleRate: number, count = VOICE_COUNT) {
    this.voices = Array.from({ length: count }, () => new SineVoice(sampleRate));
  }

  /** Sound `hz` on a voice of its own, releasing the previous key's voice. */
  noteOn(hz: number): void {
    this.held?.noteOff();
    const voice = this.freeVoice();
    voice.noteOn(hz);
    this.held = voice;
  }

  /** Release the current key. Its voice fades out; any others already fading carry on. */
  noteOff(): void {
    this.held?.noteOff();
    this.held = null;
  }

  get silent(): boolean {
    return this.voices.every((v) => v.silent);
  }

  /** A silent voice if there is one; otherwise the quietest, which SineVoice fades out before retuning. */
  private freeVoice(): SineVoice {
    let quietest = this.voices[0] as SineVoice;
    for (const v of this.voices) {
      if (v.silent) return v;
      if (v.level < quietest.level) quietest = v;
    }
    return quietest;
  }

  /** Fill `out` with the mix, in the -1..1 range. */
  render(out: Float32Array): void {
    // Reallocates only if the block size changes, which it does not in practice, so this never
    // allocates while audio is running.
    if (this.scratch.length !== out.length) this.scratch = new Float32Array(out.length);
    out.fill(0);
    for (const voice of this.voices) {
      if (voice.silent) continue;
      voice.render(this.scratch);
      for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (this.scratch[i] as number);
    }
    // No clamp needed: a new key fades in exactly as the ones it replaces fade out (the smoothstep
    // fades of complementary levels sum to one), so the mix never gets louder than a single tone.
  }
}

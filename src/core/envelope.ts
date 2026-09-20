/**
 * Waveform overview: one value per tick (1/120 s), the MEAN ABSOLUTE amplitude of the samples in
 * that tick. Not RMS and not peak (SampleFileManager.cpp:490-506). This averaging was the 1.01
 * change; 1.00 used the first sample of each interval.
 *
 * Values are normalised to 0..1 (1.0 == full scale) instead of the original's int16 units.
 */

import { TICKS_PER_SECOND } from './AudioTime';

export function buildEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const ticks = Math.ceil((samples.length * TICKS_PER_SECOND) / sampleRate);
  const env = new Float32Array(ticks);
  const samplesPerTick = sampleRate / TICKS_PER_SECOND;

  for (let t = 0; t < ticks; t++) {
    // Same sample<->tick mapping as AudioTime: tick t owns [floor(t*spt), floor((t+1)*spt)).
    const from = Math.floor(t * samplesPerTick);
    const to = Math.min(samples.length, Math.floor((t + 1) * samplesPerTick));
    if (to <= from) continue;
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.abs(samples[i] as number);
    env[t] = sum / (to - from);
  }
  return env;
}

/** Mix decoded channels down to mono by arithmetic mean. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  const inv = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (ch[i] as number) * inv;
  }
  return out;
}

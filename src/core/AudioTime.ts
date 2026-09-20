/**
 * SMPTE-style time, as used by the original Music Explorer (AudioTime.cpp).
 *
 * 30 frames per second, 4 subframes per frame => 120 "ticks" per second. Selections and the
 * waveform envelope are quantised to this grid. The UI only ever shows down to frames; the
 * subframes exist so the waveform can be drawn in finer detail.
 *
 * Internally a time is just an integer tick count. Everything else is derived from that.
 */

export const FRAMES_PER_SECOND = 30;
export const SUBFRAMES_PER_FRAME = 4;
export const TICKS_PER_SECOND = FRAMES_PER_SECOND * SUBFRAMES_PER_FRAME; // 120

const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;
const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

export interface Smpte {
  hours: number;
  minutes: number;
  seconds: number;
  /** 0..29 */
  frames: number;
  /** 0..3 */
  subframes: number;
}

/** Split a tick count into hours / minutes / seconds / frames / subframes. */
export function ticksToSmpte(ticks: number): Smpte {
  let rest = Math.max(0, Math.floor(ticks));
  const hours = Math.floor(rest / TICKS_PER_HOUR);
  rest -= hours * TICKS_PER_HOUR;
  const minutes = Math.floor(rest / TICKS_PER_MINUTE);
  rest -= minutes * TICKS_PER_MINUTE;
  const seconds = Math.floor(rest / TICKS_PER_SECOND);
  rest -= seconds * TICKS_PER_SECOND;
  const frames = Math.floor(rest / SUBFRAMES_PER_FRAME);
  const subframes = rest - frames * SUBFRAMES_PER_FRAME;
  return { hours, minutes, seconds, frames, subframes };
}

/** Inverse of {@link ticksToSmpte}. Mirrors CAudioTime::GetAllInSubframes. */
export function smpteToTicks(t: Partial<Smpte>): number {
  const { hours = 0, minutes = 0, seconds = 0, frames = 0, subframes = 0 } = t;
  return (
    hours * TICKS_PER_HOUR +
    minutes * TICKS_PER_MINUTE +
    seconds * TICKS_PER_SECOND +
    frames * SUBFRAMES_PER_FRAME +
    subframes
  );
}

/**
 * Format as `HH:MM:SS:FF` (subframes are not shown, as in the original). Each field is padded
 * to two digits; hours may grow beyond two.
 */
export function formatTicks(ticks: number): string {
  const s = ticksToSmpte(ticks);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(s.hours)}:${pad(s.minutes)}:${pad(s.seconds)}:${pad(s.frames)}`;
}

/** Ticks -> index of the first sample in that tick. CAudioTime::CalculateStartingSample. */
export function ticksToSample(ticks: number, sampleRate: number): number {
  return Math.floor((ticks * sampleRate) / TICKS_PER_SECOND);
}

/** Sample index -> tick containing it. CAudioTime::SetFromSampleCount. */
export function sampleToTicks(sample: number, sampleRate: number): number {
  return Math.floor((sample * TICKS_PER_SECOND) / sampleRate);
}

/** Seconds -> nearest tick at or below. */
export function secondsToTicks(seconds: number): number {
  return Math.floor(seconds * TICKS_PER_SECOND);
}

/** Ticks -> seconds. */
export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

/** Subtraction that clamps at zero, as CAudioTime::operator- does. */
export function subtractTicks(a: number, b: number): number {
  return Math.max(0, a - b);
}

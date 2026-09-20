/**
 * Peak picking for the note labels above the spectrum. NEW in the port: the original left "which
 * notes are these?" entirely to the user's eye and had no peak detection at all.
 */

export interface Peak {
  /** Continuous semitones from A440 (x axis). */
  semitone: number;
  /** Companded height, 0..1. */
  height: number;
}

export interface PeakOptions {
  /** Ignore peaks lower than this companded height. */
  minHeight?: number;
  /** Suppress smaller peaks closer than this many semitones to a taller accepted one. */
  minSeparation?: number;
  /** Cap on the number of peaks returned. */
  maxPeaks?: number;
}

export function findPeaks(
  semitones: ArrayLike<number>,
  heights: ArrayLike<number>,
  left: number,
  right: number,
  options: PeakOptions = {},
): Peak[] {
  const { minHeight = 0.55, minSeparation = 0.7, maxPeaks = 12 } = options;
  const candidates: Peak[] = [];

  for (let i = 1; i < heights.length - 1; i++) {
    const x = semitones[i] as number;
    if (x < left || x > right) continue;
    const h = heights[i] as number;
    if (h < minHeight) continue;
    if (h >= (heights[i - 1] as number) && h > (heights[i + 1] as number)) {
      candidates.push({ semitone: x, height: h });
    }
  }

  candidates.sort((a, b) => b.height - a.height);
  const accepted: Peak[] = [];
  for (const c of candidates) {
    if (accepted.length >= maxPeaks) break;
    if (accepted.every((a) => Math.abs(a.semitone - c.semitone) >= minSeparation)) accepted.push(c);
  }
  return accepted.sort((a, b) => a.semitone - b.semitone);
}

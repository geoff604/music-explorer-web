/**
 * Piano keyboard geometry and hit-testing, independent of any canvas (keyboard.cpp:183-377).
 *
 * The keyboard is drawn with every key, black or white, at exactly the same width. That is what
 * lets the spectrum above it line up: MIDI note n's cell is the same x-range on both. The
 * cost is that the lower half (where real white keys are wider than black ones) needs the
 * remapping in {@link hitTestKey}.
 */

import { isBlackKey, pitchClass } from './notes';

export interface KeyRange {
  /** Lowest MIDI note shown (inclusive). */
  left: number;
  /** Highest MIDI note shown (inclusive). */
  right: number;
}

export function keyCount(range: KeyRange): number {
  return range.right - range.left + 1;
}

/** Width of one key cell in pixels. */
export function keyWidth(range: KeyRange, width: number): number {
  return width / keyCount(range);
}

/** Left edge of a key's cell, in pixels from the keyboard's left. */
export function keyLeft(midi: number, range: KeyRange, width: number): number {
  return (midi - range.left) * keyWidth(range, width);
}

/**
 * x-fraction (0..1) of a continuous note position across the keyboard/graph. A note's own
 * centre lands at (n - left + 0.5) / count, which is what the +-0.5 padding on the graph's
 * data range buys.
 */
export function noteToFraction(midi: number, range: KeyRange): number {
  return (midi - range.left + 0.5) / keyCount(range);
}

/** Visible semitone range (from A440) of the spectrum graph for a given key range. */
export function graphSemitoneRange(range: KeyRange): { left: number; right: number } {
  return { left: range.left - 69 - 0.5, right: range.right - 69 + 0.5 };
}

/**
 * Which note is at (x, y), measured from the keyboard's top-left? Returns -1 outside it.
 *
 * Upper half: the uniform grid is exact. Lower half: if the cell under the cursor belongs to a
 * black key, the white key lines are drawn at the black key's centre, so a click left of that
 * centre is the previous white key and right of it is the next one.
 */
export function hitTestKey(
  x: number,
  y: number,
  width: number,
  height: number,
  range: KeyRange,
): number {
  if (x < 0 || x > width || y < 0 || y > height) return -1;

  const w = keyWidth(range, width);
  let index = Math.floor(x / w);
  if (y > height / 2) {
    if (isBlackKey(range.left + index)) {
      const centre = Math.floor(index * w + 0.5 * w);
      index += x < centre ? -1 : 1;
    }
  }
  const note = range.left + index;
  return Math.min(range.right, Math.max(range.left, note));
}

/** Notes whose left divider is a full-height line: C and F (preceded by a white key). */
export function hasFullHeightDivider(midi: number): boolean {
  const pc = pitchClass(midi);
  return pc === 0 || pc === 5;
}

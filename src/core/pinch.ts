/**
 * The maths of a two-finger pan and pinch along one axis, independent of any DOM. The waveform
 * (a window of time) and the keyboard (a window of notes) are both "a window onto a line", so they
 * share it.
 */

/** The part of the line that is visible: starts at `left`, covers `span` units. */
export interface Window1D {
  left: number;
  span: number;
}

export interface Bounds1D {
  /** Smallest and largest span allowed (most zoomed in, most zoomed out). */
  minSpan: number;
  maxSpan: number;
  /** The whole line: the window must stay inside [lo, hi]. */
  lo: number;
  hi: number;
}

export interface PinchInput {
  /** Midpoint of the two fingers when the gesture began, and now, in px from the pane's left edge. */
  startCentre: number;
  centre: number;
  /** Finger distance now over finger distance at the start: above 1 the fingers have moved apart. */
  scale: number;
  /** Pane width in px. */
  width: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The window that keeps the same point of the line under the fingers' midpoint.
 *
 * Whatever was under the midpoint when the gesture began stays under it as the fingers move, so
 * dragging both fingers sideways scrolls, and moving them apart zooms in around where they are,
 * and the two can happen together. Everything is measured from the start of the gesture rather
 * than from the previous move, so rounding the window to whole units on each update cannot build
 * up drift or leave a small zoom stuck.
 */
export function zoomPanWindow(start: Window1D, pinch: PinchInput, bounds: Bounds1D): Window1D {
  if (pinch.width <= 0 || !(pinch.scale > 0)) return start;

  const anchor = start.left + (pinch.startCentre / pinch.width) * start.span;
  const span = clamp(start.span / pinch.scale, bounds.minSpan, bounds.maxSpan);
  const left = anchor - (pinch.centre / pinch.width) * span;
  return { left: clamp(left, bounds.lo, Math.max(bounds.lo, bounds.hi - span)), span };
}

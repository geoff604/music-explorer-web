/**
 * Vertical scaling of the spectrum graph (LineGraph.cpp:72-148).
 *
 * The original does NOT use dB. It applies mu-law companding, mu = 255 (the G.711 constant):
 *
 *     y = log(1 + 255 * |P / Pmax|) / log(256)
 *
 * and Pmax is recomputed on every repaint from only the points inside the visible horizontal
 * range, so zooming the keyboard rescales the plot to the loudest visible bin.
 */

export const MU = 255;
const LOG_1_PLUS_MU = Math.log(1 + MU); // log(256)

/** mu-law compand a value already normalised to 0..1 (sign handled as in the original). */
export function muLaw(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return (sign / LOG_1_PLUS_MU) * Math.log(1 + MU * Math.abs(x));
}

/** Largest power among points whose x lies within [left, right]. 0 if none. */
export function visibleMax(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  left: number,
  right: number,
): number {
  let max = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (left <= x && x <= right && y > max) max = y;
  }
  return max;
}

/**
 * Compand every point to 0..1 relative to the loudest point in [left, right]. Points outside
 * the range are still returned (they may clip above 1) so a line can run off the edge.
 * A silent selection (max 0) yields all zeros rather than the original's divide-by-zero.
 */
export function compandSeries(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  left: number,
  right: number,
): Float64Array {
  const max = visibleMax(xs, ys, left, right);
  const out = new Float64Array(ys.length);
  if (max <= 0) return out;
  for (let i = 0; i < ys.length; i++) out[i] = muLaw((ys[i] as number) / max);
  return out;
}

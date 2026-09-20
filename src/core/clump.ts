/**
 * Picks a "clump" of audio in a window of the envelope to suggest as a selection. NEW in the port:
 * it drives the hint box that shows a first-time user what to drag over.
 */

export interface TickRange {
  start: number;
  end: number;
}

/** Runs closer together than this fraction of the window are treated as one clump. */
const GAP_FRACTION = 0.02;
/** The suggestion is kept between these fractions of the window's width. */
const MIN_FRACTION = 0.05;
const MAX_FRACTION = 0.35;
/** Below this the window is treated as silent. */
const SILENCE = 1e-4;

/**
 * The loudest contiguous clump of `env` within ticks [from, to), or null if that window is silent.
 *
 * "Clump" means a run of ticks above a threshold between the window's mean and peak level, with
 * small dips merged in. The run with the most total energy wins. A run wider than a third of the
 * window is narrowed to that width around its loudest tick, and a sliver is widened, so the result
 * is always a sensible thing to drag.
 */
export function findClump(env: ArrayLike<number>, from: number, to: number): TickRange | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(env.length, Math.ceil(to));
  const n = b - a;
  if (n < 2) return null;

  let max = 0;
  let sum = 0;
  for (let t = a; t < b; t++) {
    const v = env[t] as number;
    sum += v;
    if (v > max) max = v;
  }
  if (max < SILENCE) return null;
  const mean = sum / n;
  const threshold = mean + 0.25 * (max - mean);

  const maxGap = Math.max(1, Math.floor(n * GAP_FRACTION));
  let best: { start: number; end: number; energy: number } | null = null;
  let run: { start: number; end: number; energy: number } | null = null;
  const close = () => {
    if (run && (!best || run.energy > best.energy)) best = run;
    run = null;
  };
  for (let t = a; t < b; t++) {
    const v = env[t] as number;
    if (v < threshold) continue;
    if (run && t - run.end <= maxGap) {
      run.energy += v;
      run.end = t + 1;
    } else {
      close();
      run = { start: t, end: t + 1, energy: v };
    }
  }
  close();
  const found = best as { start: number; end: number } | null;
  if (!found) return null;

  let { start, end } = found;
  const minW = Math.max(2, Math.round(n * MIN_FRACTION));
  const maxW = Math.max(minW, Math.round(n * MAX_FRACTION));
  if (end - start > maxW) {
    let peak = start;
    for (let t = start; t < end; t++) if ((env[t] as number) > (env[peak] as number)) peak = t;
    start = peak - Math.floor(maxW / 2);
    end = start + maxW;
    if (start < found.start) [start, end] = [found.start, found.start + maxW];
    if (end > found.end) [start, end] = [found.end - maxW, found.end];
  } else if (end - start < minW) {
    const centre = Math.round((start + end) / 2);
    start = centre - Math.floor(minW / 2);
    end = start + minW;
    if (start < a) [start, end] = [a, a + minW];
    if (end > b) [start, end] = [b - minW, b];
  }
  return { start, end };
}

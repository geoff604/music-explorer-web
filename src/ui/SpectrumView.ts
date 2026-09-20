import { KeyRange, graphSemitoneRange } from '../core/keyboardGeometry';
import { A4_MIDI, noteName } from '../core/notes';
import { findPeaks } from '../core/peaks';
import { compandSeries } from '../core/scaling';
import type { Spectrum } from '../core/spectrum';
import { COLORS, CanvasView, UI_FONT } from './CanvasView';

/** First index in ascending `xs` whose value is >= x. */
function lowerBound(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The spectrum graph (MusicGraph.cpp / LineGraph.cpp): a bare black outline with no axes.
 *
 * The x axis is semitones from A440 with the visible range padded by half a semitone each side,
 * so MIDI note n lands on the centre of key n's cell in the keyboard directly below. The y axis
 * is mu-law compressed and auto-scaled to the loudest bin currently in view.
 */
export class SpectrumView extends CanvasView {
  spectrum: Spectrum | null = null;
  range: KeyRange = { left: 21, right: 108 };
  showPeakLabels = true;
  /** Whether a file is open (drives the placeholder text). */
  hasFile = false;

  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const s = this.spectrum;
    if (!s) {
      if (this.hasFile) this.drawHint(ctx, w, h, 'Drag across the waveform to select a range');
      return;
    }

    const { left, right } = graphSemitoneRange(this.range);
    const span = right - left;

    // Only the visible slice (plus one neighbour each side so the line runs off the edges).
    const i0 = Math.max(0, lowerBound(s.semitones, left) - 1);
    const i1 = Math.min(s.semitones.length, lowerBound(s.semitones, right) + 1);
    if (i1 - i0 < 1) return;
    const xs = s.semitones.subarray(i0, i1);
    const heights = compandSeries(xs, s.power.subarray(i0, i1), left, right);

    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COLORS.ink;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const x = (((xs[i] as number) - left) / span) * w;
      const y = h - (heights[i] as number) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (this.showPeakLabels) this.drawPeakLabels(ctx, w, h, xs, heights, left, right);
  }

  private drawPeakLabels(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    xs: Float64Array,
    heights: Float64Array,
    left: number,
    right: number,
  ): void {
    const span = right - left;
    const peaks = findPeaks(xs, heights, left, right);
    ctx.font = `bold 12px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.peak;

    // Tallest first, so the most prominent notes win any contested space. Each label sits just
    // above its peak; one that would overlap a label already placed tries the neighbouring rows
    // (up first, then down, since the tallest peaks are already against the top edge) and is
    // dropped only if all of them are taken. A thin white halo keeps it readable over spike lines.
    const LINE = 14;
    const ROWS = [0, -1, 1, -2, 2];
    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    const byHeight = [...peaks].sort((a, b) => b.height - a.height);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.paper;
    for (const p of byHeight) {
      const text = noteName(Math.round(p.semitone + A4_MIDI));
      const x = ((p.semitone - left) / span) * w;
      const half = ctx.measureText(text).width / 2 + 1;
      const baseline = Math.max(13, h - p.height * h - 5);
      for (const row of ROWS) {
        const y = baseline + row * LINE;
        if (y < 12 || y > h - 4) continue;
        const box = { x0: x - half, x1: x + half, y0: y - 12, y1: y + 2 };
        const clash = placed.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0);
        if (clash) continue;
        placed.push(box);
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
        break;
      }
    }
  }

  private drawHint(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
    ctx.font = `14px ${UI_FONT}`;
    ctx.fillStyle = COLORS.hint;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }
}

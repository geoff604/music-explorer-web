import { KeyRange, graphSemitoneRange } from '../core/keyboardGeometry';
import { A4_MIDI, noteName, noteStatusText } from '../core/notes';
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

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

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
  /** MIDI note held down on the keyboard, or -1. */
  pressed = -1;

  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.drawPressedColumn(ctx, w, h);
    const s = this.spectrum;
    let taken: Box[] = [];
    if (s) taken = this.drawSpectrum(ctx, w, h, s);
    else if (this.hasFile) this.drawPrompt(ctx, w, h);
    const readout = this.drawPressedReadout(ctx);
    if (readout) taken.push(readout);
    this.drawPressedNote(ctx, w, taken);
  }

  /**
   * A faint band over the pressed key's column, so its pitch can be matched to the spikes. Each
   * note owns the same x-range here as on the keyboard below, so this lines up with the key.
   */
  private drawPressedColumn(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { left, right } = this.range;
    if (this.pressed < left || this.pressed > right) return;
    const kw = w / (right - left + 1);
    ctx.fillStyle = 'rgba(0, 200, 0, 0.2)';
    ctx.fillRect((this.pressed - left) * kw, 0, kw, h);
  }

  /** Top-left readout in the waveform's style: which key is held. */
  private drawPressedReadout(ctx: CanvasRenderingContext2D): Box | null {
    const { left, right } = this.range;
    if (this.pressed < left || this.pressed > right) return null;
    ctx.font = `bold 14px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const text = `Key Pressed: ${noteStatusText(this.pressed)}`;
    // A thin halo keeps it readable where the spectrum line passes behind it.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.paper;
    ctx.strokeText(text, 4, 6);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(text, 4, 6);
    return { x0: 4, x1: 4 + ctx.measureText(text).width, y0: 6, y1: 6 + 17 };
  }

  /**
   * The pressed note's name at the top of its band. It always sits on the top row, so it is skipped
   * only if a name that is already showing (a peak label, or the readout) occupies that spot.
   */
  private drawPressedNote(ctx: CanvasRenderingContext2D, w: number, taken: Box[]): void {
    const { left, right } = this.range;
    if (this.pressed < left || this.pressed > right) return;
    const kw = w / (right - left + 1);
    const text = noteName(this.pressed);
    ctx.font = `bold 12px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const half = ctx.measureText(text).width / 2 + 1;
    const x = Math.min(Math.max((this.pressed - left + 0.5) * kw, half), w - half);
    const y = 13; // the same top row the tallest peak labels use
    const box = { x0: x - half, x1: x + half, y0: y - 12, y1: y + 2 };
    if (taken.some((o) => overlaps(box, o))) return;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.paper;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#006b1f';
    ctx.fillText(text, x, y);
  }

  /** Draws the spectrum and returns the boxes of any note labels it placed. */
  private drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, s: Spectrum): Box[] {
    const { left, right } = graphSemitoneRange(this.range);
    const span = right - left;

    // Only the visible slice (plus one neighbour each side so the line runs off the edges).
    const i0 = Math.max(0, lowerBound(s.semitones, left) - 1);
    const i1 = Math.min(s.semitones.length, lowerBound(s.semitones, right) + 1);
    if (i1 - i0 < 1) return [];
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

    return this.showPeakLabels ? this.drawPeakLabels(ctx, w, h, xs, heights, left, right) : [];
  }

  private drawPeakLabels(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    xs: Float64Array,
    heights: Float64Array,
    left: number,
    right: number,
  ): Box[] {
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
    const placed: Box[] = [];
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
        const clash = placed.some((o) => overlaps(box, o));
        if (clash) continue;
        placed.push(box);
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
        break;
      }
    }
    return placed;
  }

  /** Empty state once a file is open: an up arrow toward the waveform, and what to do there. */
  private drawPrompt(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const arrow = h >= 120;
    const top = h / 2 - (arrow ? 40 : 20);
    const cx = w / 2;
    let y = top;
    ctx.fillStyle = COLORS.hint;
    ctx.strokeStyle = COLORS.hint;
    if (arrow) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, y + 24);
      ctx.lineTo(cx, y);
      ctx.moveTo(cx - 9, y + 9);
      ctx.lineTo(cx, y);
      ctx.lineTo(cx + 9, y + 9);
      ctx.stroke();
      y += 40;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `600 17px ${UI_FONT}`;
    ctx.fillStyle = '#4a4f58';
    ctx.fillText('Select part of the waveform', cx, y);
    ctx.font = `14px ${UI_FONT}`;
    ctx.fillStyle = COLORS.hint;
    ctx.fillText('to see which notes are playing', cx, y + 24);
  }
}

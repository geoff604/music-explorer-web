import { formatTicks } from '../core/AudioTime';
import { COLORS, CanvasView, UI_FONT } from './CanvasView';

export interface TickSelection {
  start: number;
  end: number;
}

/**
 * The waveform overview (WaveformGraph.cpp:100-213).
 *
 *  - blue bars mirrored about a blue zero line, one per 1/120 s tick (mean |sample|)
 *  - a committed selection is drawn by inverting its rectangle, which turns blue-on-white into
 *    yellow-on-black. `difference` blending against white is exactly GDI's InvertRect.
 *  - while dragging: a red dash-dot-dot line at the anchor (as the original), plus, new here, the
 *    region being swept out
 *  - the two magenta readouts at the top left
 */
export class WaveformView extends CanvasView {
  /** Mean |sample| per tick, 0..1. */
  envelope: Float32Array | null = null;
  /** First visible tick, and how many are visible. */
  left = 0;
  span = 1;
  /** Full-scale value for the vertical axis, 0..1 (1 = full scale). */
  extent = 1;
  selection: TickSelection | null = null;
  drag: { anchor: number; current: number } | null = null;
  /** Playhead position in ticks, or null. */
  playhead: number | null = null;

  tickToX(tick: number): number {
    return ((tick - this.left) / this.span) * this.width;
  }

  xToTick(x: number): number {
    return this.left + (x / this.width) * this.span;
  }

  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const env = this.envelope;
    if (!env) return; // the page shows an Open button over the empty pane

    const zero = h / 2;
    ctx.fillStyle = COLORS.wave;
    ctx.fillRect(0, Math.floor(zero), w, 1);
    this.drawBars(ctx, env, w, zero);
    this.drawSelection(ctx, h);
    this.drawPlayhead(ctx, h);
    this.drawReadouts(ctx);
  }

  private drawBars(ctx: CanvasRenderingContext2D, env: Float32Array, w: number, zero: number): void {
    ctx.fillStyle = COLORS.wave;
    const scale = zero / this.extent;
    const bar = (x: number, bw: number, v: number) => {
      const a = Math.min(zero, v * scale);
      if (a >= 0.5) ctx.fillRect(x, zero - a, bw, 2 * a);
    };

    const ticksPerPixel = this.span / w;
    if (ticksPerPixel <= 1) {
      // Zoomed in: each tick is a bar spanning to the next one, so the envelope stays continuous.
      const first = Math.max(0, Math.floor(this.left));
      const last = Math.min(env.length - 1, Math.ceil(this.left + this.span));
      for (let t = first; t <= last; t++) {
        const x0 = this.tickToX(t);
        const x1 = this.tickToX(t + 1);
        bar(x0, Math.max(1, x1 - x0), env[t] as number);
      }
    } else {
      // Zoomed out: many ticks per pixel. Overdrawing every bar leaves the tallest, so take the max.
      for (let px = 0; px < w; px++) {
        const a = Math.max(0, Math.floor(this.left + px * ticksPerPixel));
        const b = Math.min(env.length, Math.max(a + 1, Math.ceil(this.left + (px + 1) * ticksPerPixel)));
        let m = 0;
        for (let t = a; t < b; t++) if ((env[t] as number) > m) m = env[t] as number;
        bar(px, 1, m);
      }
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D, h: number): void {
    const invert = (a: number, b: number) => {
      const x0 = Math.max(0, Math.min(this.tickToX(a), this.tickToX(b)));
      const x1 = Math.min(this.width, Math.max(this.tickToX(a), this.tickToX(b)));
      if (x1 <= x0) return;
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.globalCompositeOperation = 'source-over';
    };

    if (this.drag) {
      invert(this.drag.anchor, this.drag.current);
      const x = Math.round(this.tickToX(this.drag.anchor)) + 0.5;
      ctx.save();
      ctx.strokeStyle = COLORS.anchor;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 3, 2, 3, 2, 3]); // PS_DASHDOTDOT
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.restore();
    } else if (this.selection && this.selection.end > this.selection.start) {
      invert(this.selection.start, this.selection.end);
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number): void {
    if (this.playhead === null) return;
    if (this.playhead < this.left || this.playhead > this.left + this.span) return;
    const x = Math.round(this.tickToX(this.playhead));
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x - 1, 0, 2, h);
  }

  private drawReadouts(ctx: CanvasRenderingContext2D): void {
    // The original's readouts came out magenta by accident (the keyboard left its text colour on
    // the shared device context). That is how the app has always looked, so it is kept on purpose.
    const view = `Time Displayed: ${formatTicks(this.left)} to ${formatTicks(this.left + this.span - 1)}`;
    const sel = this.drag
      ? [Math.min(this.drag.anchor, this.drag.current), Math.max(this.drag.anchor, this.drag.current)]
      : this.selection
        ? [this.selection.start, this.selection.end]
        : [0, 0];
    const range = `Selected Range: ${formatTicks(sel[0] as number)} to ${formatTicks(sel[1] as number)}`;

    ctx.font = `bold 14px ${UI_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.label;
    ctx.fillText(view, 4, 6);
    ctx.fillText(range, 4, 25);
  }
}

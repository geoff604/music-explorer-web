import { KeyRange, hasFullHeightDivider, keyWidth } from '../core/keyboardGeometry';
import { isBlackKey, octaveOf, pitchClass } from '../core/notes';
import { COLORS, CanvasView, UI_FONT } from './CanvasView';

/**
 * The piano keyboard (keyboard.cpp:183-304).
 *
 * Every key, black or white, gets the same width so the spectrum above lines up with it. Only
 * black keys are filled (top half); white keys are just dividing lines. C and F, which follow
 * a white key, get a full-height line at their own left edge; the other white keys get a
 * half-height line through the middle of the black key before them.
 *
 * A pressed key is lit as a whole: its entire outline is filled, so it cannot be hidden by the
 * mouse cursor. (The original drew a small dot on the key, which the cursor covered.)
 */
export class KeyboardView extends CanvasView {
  range: KeyRange = { left: 21, right: 108 };
  /** MIDI note currently held down, or -1. */
  pressed = -1;

  protected paint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { left, right } = this.range;
    const kw = keyWidth(this.range, w);
    const half = h / 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.ink;
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();

    for (let note = left; note <= right; note++) {
      const x = (note - left) * kw;
      if (isBlackKey(note)) {
        ctx.fillRect(x, 0, kw, half);
      } else if (hasFullHeightDivider(note)) {
        const px = Math.round(x) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
      } else {
        const px = Math.round(x - kw / 2) + 0.5;
        ctx.moveTo(px, half);
        ctx.lineTo(px, h);
      }
    }
    ctx.stroke();
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    if (this.pressed >= left && this.pressed <= right) this.drawPressed(ctx, w, kw, h);
    this.drawOctaveLabels(ctx, kw);
  }

  private drawPressed(ctx: CanvasRenderingContext2D, w: number, kw: number, h: number): void {
    const note = this.pressed;
    const { left, right } = this.range;
    const half = h / 2;
    // Same rounding as the divider lines in paint(), so the outline lands exactly on them.
    const px = (x: number) => Math.min(w - 0.5, Math.max(0.5, Math.round(x) + 0.5));
    const x = (note - left) * kw;
    const x0 = px(x);
    const x1 = px(x + kw);

    ctx.beginPath();
    if (isBlackKey(note)) {
      ctx.rect(x0, 0.5, x1 - x0, half - 0.5);
    } else {
      // A white key is a cell wide across the top, but wider below the black keys' bottom edge:
      // it reaches to the dividers at the middle of the black key on either side.
      const lo = hasFullHeightDivider(note) ? x0 : px(x - kw / 2);
      const hi = note < right && isBlackKey(note + 1) ? px(x + kw * 1.5) : x1;
      ctx.moveTo(x0, 0.5);
      ctx.lineTo(x1, 0.5);
      ctx.lineTo(x1, half);
      ctx.lineTo(hi, half);
      ctx.lineTo(hi, h - 0.5);
      ctx.lineTo(lo, h - 0.5);
      ctx.lineTo(lo, half);
      ctx.lineTo(x0, half);
      ctx.closePath();
    }
    ctx.fillStyle = COLORS.pressed;
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawOctaveLabels(ctx: CanvasRenderingContext2D, kw: number): void {
    // An octave must be wide enough to hold its label, or they run together.
    if (kw * 12 < 28) return;
    ctx.font = `bold 11px ${UI_FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.label;
    for (let note = this.range.left; note <= this.range.right; note++) {
      if (pitchClass(note) !== 0) continue;
      ctx.fillText(`C${octaveOf(note)}`, (note - this.range.left) * kw + 2, 3);
    }
  }
}

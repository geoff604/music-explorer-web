/** Colours from the original (all GDI RGB values from the C++ source). */
export const COLORS = {
  paper: '#ffffff',
  ink: '#000000',
  /** Waveform bars and zero line: RGB(0,0,255). */
  wave: '#0000ff',
  /** Octave labels and the waveform's time readouts: RGB(255,0,255). */
  label: '#ff00ff',
  /** Pressed key's fill: RGB(0,255,0), the colour the original used for its pressed-key dot. */
  pressed: '#00ff00',
  /** Selection anchor while dragging: RGB(255,0,0). */
  anchor: '#ff0000',
  /** Playhead (new). Bright enough to read on both the white and the inverted-black regions. */
  playhead: '#ff2d2d',
  hint: '#8a8f98',
  peak: '#00307a',
} as const;

export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * A canvas that tracks its CSS size and the device pixel ratio, and repaints on demand.
 * Subclasses draw in CSS pixels; the base class applies the DPR transform.
 */
export abstract class CanvasView {
  protected readonly ctx: CanvasRenderingContext2D;
  /** Size in CSS pixels. */
  width = 0;
  height = 0;
  private frame = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize(true)).observe(canvas);
    // Not a synchronous paint: subclass fields are not initialised until this constructor returns.
    this.resize(false);
    this.invalidate();
  }

  private resize(repaintNow: boolean): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.width = w;
    this.height = h;
    // Resizing clears a canvas, so repaint straight away rather than waiting a frame (no flicker).
    if (repaintNow) this.paintNow();
  }

  /** Schedule a repaint on the next animation frame (coalesces repeated calls). */
  invalidate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paintNow();
    });
  }

  paintNow(): void {
    if (this.width === 0 || this.height === 0) return;
    const dpr = this.canvas.width / this.width;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, this.width, this.height);
    this.paint(ctx, this.width, this.height);
  }

  protected abstract paint(ctx: CanvasRenderingContext2D, w: number, h: number): void;
}

import { AudioEngine, AudioEngineOptions, LoadedAudio } from '../audio/AudioEngine';
import { TICKS_PER_SECOND, formatTicks, ticksToSample, ticksToSeconds } from '../core/AudioTime';
import { buildEnvelope } from '../core/envelope';
import { hitTestKey } from '../core/keyboardGeometry';
import { Window1D, zoomPanWindow } from '../core/pinch';
import { WindowKind, analyzeRange } from '../core/spectrum';
import { KeyboardView } from './KeyboardView';
import { SpectrumView } from './SpectrumView';
import { TwoFingerGesture } from './gestures';
import { WaveformView } from './WaveformView';
import { selectRange, showAbout } from './dialogs';
import { ICONS, MenuDef, Refreshable, buildMenuBar, buildToolbar } from './menu';

const MIDI_NOTES = 128; // 0..127
const MIN_KEYS = 12;
const DEFAULT_KEY_LEFT = 21; // A0, the bottom of an 88-key piano
const DEFAULT_KEY_COUNT = 88;
const DEFAULT_SPAN_TICKS = 3 * TICKS_PER_SECOND; // the original opens showing 3 seconds
const MIN_SPAN_TICKS = 8;
const VERTICAL_ZOOM_STEP = 1.4;
const MIN_EXTENT = 0.01;
const ZOOM_BUTTON_FACTOR = 1.5; // view span / key count changes by this much per click
const AUTO_SCROLL_MARGIN = 0.05; // fraction of the view left before the playhead after a page turn
const MAX_ERRORS = 5; // how many recent errors the debug readout keeps

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A touch tap makes the browser fire a click as well, and mobile browsers retarget that click to
 * the nearest control within reach of the finger. The keyboard is only 50px tall with the zoom/pan
 * sliders directly beneath it, so tapping the lower part of the keys clicked the slider and
 * jumped the keyboard's position. Cancelling touchend stops that click being generated. The
 * canvases work from pointer events, which are unaffected.
 */
function ignoreTouchClicks(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
}

/** Wheel deltas normalised to pixels. */
function wheelDelta(e: WheelEvent): { x: number; y: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  return { x: e.deltaX * k, y: e.deltaY * k };
}

export class App {
  private readonly engine: AudioEngine;
  private readonly wave: WaveformView;
  private readonly spectrum: SpectrumView;
  private readonly keys: KeyboardView;
  private readonly waveGesture: TwoFingerGesture;
  private readonly spectrumGesture: TwoFingerGesture;
  private readonly keysGesture: TwoFingerGesture;

  private audio: LoadedAudio | null = null;
  private totalTicks = 0;
  private windowKind: WindowKind = 'hann';
  private playbackFrame = 0;
  private autoScroll = true;
  private noteHeld = false;
  /** A right/middle/Alt drag scrolling the keyboard range, if one is under way. */
  private keyPanDrag: { pointerId: number; x: number; left: number; count: number; canvas: HTMLCanvasElement } | null = null;

  private readonly waveZoom = el<HTMLInputElement>('wave-zoom');
  private readonly wavePan = el<HTMLInputElement>('wave-pan');
  private readonly keyZoom = el<HTMLInputElement>('key-zoom');
  private readonly keyPan = el<HTMLInputElement>('key-pan');
  private readonly statusMsg = el<HTMLElement>('status-msg');
  private readonly fileInput = el<HTMLInputElement>('file');
  private readonly emptyState = el<HTMLElement>('empty-state');

  private readonly chrome: Refreshable[] = [];
  private readonly errors: string[] = [];

  constructor(audioOptions?: AudioEngineOptions) {
    this.engine = new AudioEngine(audioOptions);
    this.wave = new WaveformView(el<HTMLCanvasElement>('wave'));
    this.spectrum = new SpectrumView(el<HTMLCanvasElement>('spectrum'));
    this.keys = new KeyboardView(el<HTMLCanvasElement>('keys'));
    for (const view of [this.wave, this.spectrum, this.keys]) ignoreTouchClicks(view.canvas);
    this.waveGesture = this.waveTwoFingerGesture();
    this.spectrumGesture = this.keyTwoFingerGesture(this.spectrum.canvas);
    this.keysGesture = this.keyTwoFingerGesture(this.keys.canvas);

    this.buildChrome();
    this.wireWaveform();
    this.wireSpectrum();
    this.wireKeyboard();
    this.wireBars();
    this.wireFileInput();
    this.wireShortcuts();
    this.wireAudioUnlock();

    this.engine.onEnded = () => this.playbackEnded();
    this.setKeyView(DEFAULT_KEY_LEFT, DEFAULT_KEY_COUNT);
    this.syncWaveBars();
    this.refreshChrome();
  }

  // ---- menus & toolbar ------------------------------------------------------------------

  private get hasFile(): boolean {
    return this.audio !== null;
  }

  private buildChrome(): void {
    const menus: MenuDef[] = [
      {
        label: 'File',
        items: [{ label: 'Open…', accel: 'Ctrl+O', run: () => this.fileInput.click() }],
      },
      {
        label: 'View',
        items: [
          { label: 'Vertical Zoom In', accel: 'Ctrl+I', run: () => this.verticalZoom(1), enabled: () => this.hasFile },
          { label: 'Vertical Zoom Out', accel: 'Ctrl+U', run: () => this.verticalZoom(-1), enabled: () => this.hasFile },
          { separator: true },
          {
            label: 'Toolbar',
            checked: () => !el('toolbar').hidden,
            run: () => (el('toolbar').hidden = !el('toolbar').hidden),
          },
          {
            label: 'Status Bar',
            checked: () => !document.querySelector<HTMLElement>('.statusbar')!.hidden,
            run: () => {
              const bar = document.querySelector<HTMLElement>('.statusbar')!;
              bar.hidden = !bar.hidden;
            },
          },
          { separator: true },
          {
            label: 'Auto Scroll',
            checked: () => this.autoScroll,
            run: () => (this.autoScroll = !this.autoScroll),
          },
          {
            label: 'Peak Note Labels',
            checked: () => this.spectrum.showPeakLabels,
            run: () => {
              this.spectrum.showPeakLabels = !this.spectrum.showPeakLabels;
              this.spectrum.invalidate();
            },
          },
          { separator: true },
          {
            label: 'Hann Window (sharper peaks)',
            radio: true,
            checked: () => this.windowKind === 'hann',
            run: () => this.setWindow('hann'),
          },
          {
            label: 'Rectangular Window (as original)',
            radio: true,
            checked: () => this.windowKind === 'rectangular',
            run: () => this.setWindow('rectangular'),
          },
        ],
      },
      {
        label: 'Functions',
        items: [
          { label: 'Select Range…', run: () => void this.openSelectRange(), enabled: () => this.hasFile },
          { label: 'Play', accel: 'Space', run: () => void this.play(), enabled: () => this.hasFile },
          { label: 'Stop', accel: 'Space', run: () => this.engine.stop(), enabled: () => this.engine.isPlaying },
        ],
      },
      { label: 'Help', items: [{ label: 'About Music Explorer…', run: showAbout }] },
    ];
    this.chrome.push(buildMenuBar(el('menubar'), menus));

    this.chrome.push(
      buildToolbar(el('toolbar'), [
        { title: 'Open\nOpen an audio file', icon: ICONS.open, run: () => this.fileInput.click() },
        { title: 'Play\nPlays the current selection', icon: ICONS.play, run: () => void this.play(), enabled: () => this.hasFile, separatorBefore: true },
        { title: 'Stop\nStops playing', icon: ICONS.stop, run: () => this.engine.stop(), enabled: () => this.engine.isPlaying },
        { title: 'Zoom in\nZooms in on the waveform', icon: ICONS.zoomIn, run: () => this.verticalZoom(1), enabled: () => this.hasFile, separatorBefore: true },
        { title: 'Zoom out\nZooms out on the waveform', icon: ICONS.zoomOut, run: () => this.verticalZoom(-1), enabled: () => this.hasFile },
        { title: 'About\nProgram information', icon: ICONS.help, run: showAbout, separatorBefore: true },
      ]),
    );
  }

  private refreshChrome(): void {
    for (const c of this.chrome) c.refresh();
  }

  private setStatus(message: string, isError = false, detail?: string): void {
    this.statusMsg.textContent = message;
    this.statusMsg.style.color = isError ? 'var(--error)' : '';
    if (isError) {
      // The status bar cuts long text off, so keep the whole message (and the underlying cause,
      // which the bar does not show) for the `?debug` readout.
      this.errors.push(detail ? `${message} [${detail}]` : message);
      if (this.errors.length > MAX_ERRORS) this.errors.shift();
    }
  }

  /** Errors shown so far, for the `?debug` readout. */
  debugErrors(): string[] {
    return this.errors;
  }

  // ---- opening files --------------------------------------------------------------------

  private wireFileInput(): void {
    el('open-button').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = ''; // so choosing the same file again still fires
      if (file) void this.openFile(file);
    });

    const panes = el('panes');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      panes.classList.add('drop');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) panes.classList.remove('drop');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      panes.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.openFile(file);
    });
  }

  private async openFile(file: File): Promise<void> {
    this.setStatus(`Opening ${file.name}…`);
    try {
      const audio = await this.engine.load(file);
      if (audio.mono.length < 2) throw new Error('empty');
      const envelope = buildEnvelope(audio.mono, audio.sampleRate);

      this.audio = audio;
      this.emptyState.hidden = true;
      this.totalTicks = envelope.length;
      this.wave.envelope = envelope;
      this.wave.selection = null;
      this.wave.drag = null;
      this.wave.playhead = null;
      this.wave.introStart = performance.now();
      this.wave.extent = 1;
      this.spectrum.spectrum = null;
      this.spectrum.hasFile = true;
      this.setKeyView(DEFAULT_KEY_LEFT, DEFAULT_KEY_COUNT);
      this.setWaveView(0, DEFAULT_SPAN_TICKS);
      this.wave.hintDismissed = false; // after the line above, which dismisses it like any view change

      document.title = `${audio.name} – Music Explorer`;
      // No sample rate here: decodeAudioData resamples to the audio context's rate, so what we
      // hold is not the file's own rate and quoting it would mislead.
      this.setStatus(`${audio.name} · ${formatTicks(this.totalTicks)}`);
    } catch (e) {
      this.setStatus(`Unable to open ${file.name}: this browser could not decode it as audio.`, true, errorText(e));
    }
    this.spectrum.invalidate();
    this.refreshChrome();
  }

  // ---- waveform view state --------------------------------------------------------------

  private get minSpan(): number {
    return Math.min(this.totalTicks, MIN_SPAN_TICKS);
  }

  private setWaveView(left: number, span: number): void {
    if (!this.hasFile) return;
    // Any pan, zoom or auto-scroll page turn: the suggestion no longer matches what they see.
    this.wave.hintDismissed = true;
    const s = clamp(Math.round(span), this.minSpan, this.totalTicks);
    this.wave.span = s;
    this.wave.left = clamp(Math.round(left), 0, this.totalTicks - s);
    this.syncWaveBars();
    this.wave.invalidate();
  }

  /** Zoom slider is logarithmic: linear would make a 3 s view of a 10 min file unreachable. */
  private spanToSlider(span: number): number {
    const lo = Math.log(this.minSpan);
    const hi = Math.log(this.totalTicks);
    return hi > lo ? (Math.log(span) - lo) / (hi - lo) : 1;
  }

  private sliderToSpan(t: number): number {
    const lo = Math.log(this.minSpan);
    const hi = Math.log(this.totalTicks);
    return Math.exp(lo + t * (hi - lo));
  }

  private syncWaveBars(): void {
    const on = this.hasFile && this.totalTicks > this.minSpan;
    this.waveZoom.disabled = !on;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#wave-bars .zoom-btn')) b.disabled = !on;
    this.wavePan.disabled = !on;
    if (!this.hasFile) {
      this.setZoomSlider(this.waveZoom, 0, 1000, 0);
      this.wavePan.value = '0';
      return;
    }
    this.waveZoom.step = '1';
    // Right = zoom in, so the slider runs opposite to the span.
    this.setZoomSlider(this.waveZoom, 0, 1000, Math.round((1 - this.spanToSlider(this.wave.span)) * 1000));
    this.wavePan.min = '0';
    this.wavePan.max = String(Math.max(0, this.totalTicks - this.wave.span));
    this.wavePan.step = '1';
    this.wavePan.value = String(this.wave.left);
  }

  private verticalZoom(direction: 1 | -1): void {
    if (!this.hasFile) return;
    const factor = direction > 0 ? 1 / VERTICAL_ZOOM_STEP : VERTICAL_ZOOM_STEP;
    this.wave.extent = clamp(this.wave.extent * factor, MIN_EXTENT, 1);
    this.wave.invalidate();
  }

  // ---- keyboard / spectrum view state ---------------------------------------------------

  private setKeyView(left: number, count: number): void {
    const n = clamp(Math.round(count), MIN_KEYS, MIDI_NOTES);
    const l = clamp(Math.round(left), 0, MIDI_NOTES - n);
    const range = { left: l, right: l + n - 1 };
    this.keys.range = range;
    this.spectrum.range = range;
    // Right = zoom in = fewer keys.
    this.keyZoom.step = '1';
    this.setZoomSlider(this.keyZoom, 0, MIDI_NOTES - MIN_KEYS, MIDI_NOTES - n);
    this.keyPan.min = '0';
    this.keyPan.max = String(MIDI_NOTES - n);
    this.keyPan.step = '1';
    this.keyPan.value = String(l);
    this.keyPan.disabled = MIDI_NOTES - n === 0;
    this.keys.invalidate();
    this.spectrum.invalidate();
  }

  private setZoomSlider(input: HTMLInputElement, min: number, max: number, value: number): void {
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.style.setProperty('--fill', String(max > min ? (value - min) / (max - min) : 0));
  }

  /**
   * The tick a button or slider zoom pivots on: the playhead, else the visible part of the
   * selection (or the cursor, which is an empty selection), else the middle of the view. Whatever
   * is chosen stays where it is on screen, so it cannot be zoomed out of view.
   */
  private zoomAnchor(): number {
    const { left, span, playhead, selection: sel } = this.wave;
    const right = left + span;
    if (playhead !== null && playhead >= left && playhead <= right) return playhead;
    if (sel) {
      const lo = Math.max(sel.start, left);
      const hi = Math.min(sel.end, right);
      if (lo <= hi) return (lo + hi) / 2;
    }
    return left + span / 2;
  }

  private zoomWave(factor: number): void {
    const { left, span: oldSpan } = this.wave;
    const anchor = this.zoomAnchor();
    const fraction = (anchor - left) / oldSpan;
    const span = oldSpan * factor;
    this.setWaveView(anchor - fraction * span, span);
  }

  private zoomKeys(factor: number): void {
    const { left, right } = this.keys.range;
    const count = right - left + 1;
    let next = count * factor;
    // Small factors would round back to the same count and get stuck.
    if (Math.round(next) === count) next = count + Math.sign(factor - 1);
    this.setKeyView(left + count / 2 - next / 2, next);
  }

  private wireBars(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.zoom-btn')) {
      const zoomIn = b.dataset.zoom === 'in';
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${zoomIn ? ICONS.magnifyIn : ICONS.magnifyOut}</svg>`;
      const factor = zoomIn ? 1 / ZOOM_BUTTON_FACTOR : ZOOM_BUTTON_FACTOR;
      const wave = b.closest('#wave-bars') !== null;
      b.addEventListener('click', () => (wave ? this.zoomWave(factor) : this.zoomKeys(factor)));
    }
    this.waveZoom.addEventListener('input', () => {
      const span = this.sliderToSpan(1 - Number(this.waveZoom.value) / 1000);
      this.zoomWave(span / this.wave.span);
    });
    this.wavePan.addEventListener('input', () => this.setWaveView(Number(this.wavePan.value), this.wave.span));
    this.keyZoom.addEventListener('input', () => {
      const count = MIDI_NOTES - Number(this.keyZoom.value);
      this.zoomKeys(count / (this.keys.range.right - this.keys.range.left + 1));
    });
    this.keyPan.addEventListener('input', () => this.setKeyView(Number(this.keyPan.value), this.keys.range.right - this.keys.range.left + 1));
  }

  // ---- waveform interaction -------------------------------------------------------------

  private wireWaveform(): void {
    const canvas = this.wave.canvas;
    let pan: { x: number; left: number } | null = null;

    const tickAt = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const tick = this.wave.xToTick(clamp(e.clientX - rect.left, 0, rect.width));
      return clamp(Math.round(tick), 0, this.totalTicks);
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (this.waveGesture.down(e)) return; // a second finger: scrolling/zooming, not selecting
      if (!this.hasFile) return;
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2 || e.altKey) {
        pan = { x: e.clientX, left: this.wave.left };
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
      } else if (e.button === 0) {
        const t = tickAt(e);
        this.wave.drag = { anchor: t, current: t };
        this.wave.invalidate();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.waveGesture.move(e)) return;
      if (pan) {
        const dx = e.clientX - pan.x;
        this.setWaveView(pan.left - (dx / canvas.clientWidth) * this.wave.span, this.wave.span);
      } else if (this.wave.drag) {
        this.wave.drag.current = tickAt(e);
        this.wave.invalidate();
      }
    });

    const finish = (e: PointerEvent, commit: boolean) => {
      if (this.waveGesture.up(e)) return; // a finger of a two-finger gesture lifting: no selection
      if (pan) {
        pan = null;
        canvas.style.cursor = '';
        return;
      }
      const drag = this.wave.drag;
      if (!drag) return;
      this.wave.drag = null;
      if (commit) {
        const current = tickAt(e);
        this.wave.selection = {
          start: Math.min(drag.anchor, current),
          end: Math.max(drag.anchor, current),
        };
        this.analyze(); // the original also analyses on release, not during the drag
      }
      this.wave.invalidate();
    };
    canvas.addEventListener('pointerup', (e) => finish(e, true));
    canvas.addEventListener('pointercancel', (e) => finish(e, false));

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.hasFile) return;
        e.preventDefault();
        const d = wheelDelta(e);
        const w = canvas.clientWidth;
        if (e.shiftKey || Math.abs(d.x) > Math.abs(d.y)) {
          const dx = d.x || d.y;
          this.setWaveView(this.wave.left + (dx / w) * this.wave.span, this.wave.span);
        } else {
          const rect = canvas.getBoundingClientRect();
          const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          const anchor = this.wave.left + f * this.wave.span;
          const span = this.wave.span * Math.exp(d.y * 0.0015);
          this.setWaveView(anchor - f * span, span);
        }
      },
      { passive: false },
    );
  }

  // ---- analysis -------------------------------------------------------------------------

  private setWindow(kind: WindowKind): void {
    if (this.windowKind === kind) return;
    this.windowKind = kind;
    this.analyze();
    this.refreshChrome();
  }

  private analyze(): void {
    const audio = this.audio;
    const sel = this.wave.selection;
    if (!audio || !sel || sel.end <= sel.start) {
      this.spectrum.spectrum = null;
      this.spectrum.invalidate();
      return;
    }
    const start = ticksToSample(sel.start, audio.sampleRate);
    const end = ticksToSample(sel.end, audio.sampleRate);
    const result = analyzeRange(audio.mono, start, end, audio.sampleRate, { window: this.windowKind });
    this.spectrum.spectrum = result;
    this.spectrum.invalidate();
    if (result) {
      const averaged = result.frames > 1 ? ` × ${result.frames} averaged` : '';
      const kind = this.windowKind === 'hann' ? 'Hann' : 'rectangular';
      this.setStatus(
        `${((end - start) / audio.sampleRate).toFixed(2)} s selected · ${result.fftSize.toLocaleString()}-point FFT${averaged} · ${result.binHz.toFixed(2)} Hz/bin · ${kind} window`,
      );
    }
  }

  private async openSelectRange(): Promise<void> {
    if (!this.audio) return;
    const chosen = await selectRange({
      fileName: this.audio.name,
      lengthTicks: this.totalTicks,
      selection: this.wave.selection,
    });
    if (!chosen) return;
    this.wave.selection = chosen;
    this.analyze();
    this.wave.invalidate();
  }

  // ---- two-finger scroll and zoom -------------------------------------------------------

  /**
   * Two fingers on the waveform scroll and zoom the time axis together: both fingers moving
   * sideways scrolls, moving apart or together zooms around them. Pointer handlers hand their
   * events to the gesture first and stand down while it owns them.
   */
  private waveTwoFingerGesture(): TwoFingerGesture {
    let start: Window1D = { left: 0, span: 1 };
    return new TwoFingerGesture(this.wave.canvas, {
      begin: () => {
        // The first finger began a selection drag. Two fingers mean scroll, so drop it uncommitted.
        this.wave.drag = null;
        this.wave.invalidate();
        start = { left: this.wave.left, span: this.wave.span };
      },
      update: (pinch) => {
        if (!this.hasFile) return;
        const next = zoomPanWindow(start, pinch, {
          minSpan: this.minSpan,
          maxSpan: this.totalTicks,
          lo: 0,
          hi: this.totalTicks,
        });
        this.setWaveView(next.left, next.span);
      },
    });
  }

  /** The spectrum and the keyboard show the same range of notes, so each drives it the same way. */
  private keyTwoFingerGesture(canvas: HTMLCanvasElement): TwoFingerGesture {
    let start: Window1D = { left: 0, span: MIDI_NOTES };
    return new TwoFingerGesture(canvas, {
      begin: () => {
        this.releaseNote(); // the first finger pressed a key; two fingers mean scroll, so let it go
        const { left, right } = this.keys.range;
        start = { left, span: right - left + 1 };
      },
      update: (pinch) => {
        const next = zoomPanWindow(start, pinch, { minSpan: MIN_KEYS, maxSpan: MIDI_NOTES, lo: 0, hi: MIDI_NOTES });
        this.setKeyView(next.left, next.span);
      },
    });
  }

  // ---- spectrum + keyboard interaction --------------------------------------------------

  private wireSpectrum(): void {
    const canvas = this.spectrum.canvas;

    // Pressing sounds the note under the pointer, as clicking that key below would.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (this.spectrumGesture.down(e)) return;
      if (this.startKeyPan(e, canvas)) return;
      if (e.button !== 0) return;
      // The graph and the keyboard share one uniform note grid, so any y in the upper half works.
      const rect = canvas.getBoundingClientRect();
      const note = hitTestKey(e.clientX - rect.left, 0, rect.width, 1, this.keys.range);
      if (note < 0) return;
      canvas.setPointerCapture(e.pointerId);
      this.pressNote(note);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.moveKeyPan(e)) this.spectrumGesture.move(e);
    });
    const lift = (e: PointerEvent) => {
      if (this.endKeyPan(e)) return;
      if (!this.spectrumGesture.up(e)) this.releaseNote();
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    this.wireKeyWheel(canvas);
  }

  /**
   * Right- or middle-button drag, or Alt-drag, scrolls the keyboard range, as on the waveform.
   * (Plain left drag is taken: pressing there plays a key.) The spectrum and the keyboard show the
   * same range, so dragging either scrolls both. Returns true if this press began a pan.
   */
  private startKeyPan(e: PointerEvent, canvas: HTMLCanvasElement): boolean {
    if (e.button !== 1 && e.button !== 2 && !e.altKey) return false;
    canvas.setPointerCapture(e.pointerId);
    const { left, right } = this.keys.range;
    this.keyPanDrag = { pointerId: e.pointerId, x: e.clientX, left, count: right - left + 1, canvas };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return true;
  }

  /** Measured from where the drag began, so rounding to whole keys never builds up. */
  private moveKeyPan(e: PointerEvent): boolean {
    const drag = this.keyPanDrag;
    if (!drag || e.pointerId !== drag.pointerId) return false;
    const dx = e.clientX - drag.x;
    this.setKeyView(drag.left - (dx / drag.canvas.clientWidth) * drag.count, drag.count);
    return true;
  }

  private endKeyPan(e: PointerEvent): boolean {
    const drag = this.keyPanDrag;
    if (!drag || e.pointerId !== drag.pointerId) return false;
    drag.canvas.style.cursor = '';
    this.keyPanDrag = null;
    return true;
  }

  private wireKeyWheel(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const d = wheelDelta(e);
        const { left, right } = this.keys.range;
        const count = right - left + 1;
        if (e.shiftKey || Math.abs(d.x) > Math.abs(d.y)) {
          const dx = d.x || d.y;
          this.setKeyView(left + (dx / canvas.clientWidth) * count, count);
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        let next = count * Math.exp(d.y * 0.0015);
        // Small trackpad deltas would round back to the same count and get stuck.
        if (Math.round(next) === count && d.y !== 0) next = count + Math.sign(d.y);
        this.setKeyView(left + f * count - f * next, next);
      },
      { passive: false },
    );
  }

  private wireKeyboard(): void {
    const canvas = this.keys.canvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (this.keysGesture.down(e)) return;
      if (this.startKeyPan(e, canvas)) return;
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const note = hitTestKey(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, this.keys.range);
      if (note < 0) return;
      canvas.setPointerCapture(e.pointerId);
      this.pressNote(note);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.moveKeyPan(e)) this.keysGesture.move(e);
    });
    const lift = (e: PointerEvent) => {
      if (this.endKeyPan(e)) return;
      if (!this.keysGesture.up(e)) this.releaseNote();
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    window.addEventListener('blur', () => this.releaseNote());
    this.wireKeyWheel(canvas);
  }

  /** Sound a note and mark it on the keyboard and the spectrum. Shared by both panes' clicks. */
  private pressNote(note: number): void {
    this.noteHeld = true;
    this.keys.pressed = note;
    this.spectrum.pressed = note;
    this.spectrum.invalidate();
    this.keys.invalidate();
    this.engine.noteOn(note).catch((e: unknown) => {
      this.setStatus(`Could not play the note: ${errorText(e)}`, true);
    });
  }

  /**
   * Browsers only start audio after a user gesture, and on touch screens a press does not count
   * until it is released. Unlock on the first release/click/key, so a key pressed afterwards has a
   * running audio context waiting for it. Stops listening once the context is running.
   */
  private wireAudioUnlock(): void {
    const events = ['pointerup', 'touchend', 'click', 'keydown'];
    const onGesture = () => {
      void this.engine.unlock().then((running) => {
        if (!running) return; // try again on the next gesture
        for (const type of events) window.removeEventListener(type, onGesture, true);
      });
    };
    for (const type of events) window.addEventListener(type, onGesture, { capture: true, passive: true });
  }

  /** Audio state and recent audio events, for the `?debug` readout. */
  audioDebugLines(): string[] {
    return this.engine.debugLines();
  }

  private releaseNote(): void {
    if (!this.noteHeld) return;
    this.noteHeld = false;
    this.engine.noteOff();
    this.keys.pressed = -1;
    this.spectrum.pressed = -1;
    this.spectrum.invalidate();
    this.keys.invalidate();
  }

  // ---- playback -------------------------------------------------------------------------

  private async play(): Promise<void> {
    if (!this.audio) return;
    const sel = this.wave.selection;
    const start = sel?.start ?? 0;
    // No selection (or an empty one) plays from the start point to the end of the file.
    const end = sel && sel.end > sel.start ? sel.end : start;
    try {
      await this.engine.play(ticksToSeconds(start), ticksToSeconds(end));
    } catch (e) {
      this.setStatus(`Could not play: ${errorText(e)}`, true);
      this.refreshChrome();
      return;
    }
    this.trackPlayhead();
    this.refreshChrome();
  }

  private trackPlayhead(): void {
    cancelAnimationFrame(this.playbackFrame);
    const step = () => {
      const pos = this.engine.positionSeconds;
      if (pos === null) return;
      this.wave.playhead = pos * TICKS_PER_SECOND;
      if (this.autoScroll) this.followPlayhead(this.wave.playhead);
      this.wave.invalidate();
      this.playbackFrame = requestAnimationFrame(step);
    };
    step();
  }

  /** Pages the view along when the playhead leaves it, leaving a little context before the playhead. */
  private followPlayhead(tick: number): void {
    const { left, span } = this.wave;
    if (tick >= left && tick <= left + span) return;
    this.setWaveView(tick - span * AUTO_SCROLL_MARGIN, span);
  }

  private playbackEnded(): void {
    cancelAnimationFrame(this.playbackFrame);
    this.wave.playhead = null;
    this.wave.invalidate();
    this.refreshChrome();
  }

  // ---- keyboard shortcuts ---------------------------------------------------------------

  private wireShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'o') {
        e.preventDefault();
        this.fileInput.click();
      } else if (mod && key === 'i') {
        e.preventDefault();
        this.verticalZoom(1);
      } else if (mod && key === 'u') {
        e.preventDefault();
        this.verticalZoom(-1);
      } else if (e.key === ' ' && !mod) {
        // Leave Space alone where it already means something (buttons, sliders, fields).
        const t = e.target as HTMLElement;
        if (t === document.body || t instanceof HTMLCanvasElement) {
          e.preventDefault();
          if (this.engine.isPlaying) this.engine.stop();
          else void this.play();
        }
      }
    });
  }
}

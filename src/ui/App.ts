import { AudioEngine, LoadedAudio } from '../audio/AudioEngine';
import { TICKS_PER_SECOND, formatTicks, ticksToSample, ticksToSeconds } from '../core/AudioTime';
import { buildEnvelope } from '../core/envelope';
import { hitTestKey } from '../core/keyboardGeometry';
import { noteStatusText } from '../core/notes';
import { WindowKind, analyzeRange } from '../core/spectrum';
import { KeyboardView } from './KeyboardView';
import { SpectrumView } from './SpectrumView';
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

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Wheel deltas normalised to pixels. */
function wheelDelta(e: WheelEvent): { x: number; y: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  return { x: e.deltaX * k, y: e.deltaY * k };
}

export class App {
  private readonly engine = new AudioEngine();
  private readonly wave: WaveformView;
  private readonly spectrum: SpectrumView;
  private readonly keys: KeyboardView;

  private audio: LoadedAudio | null = null;
  private totalTicks = 0;
  private windowKind: WindowKind = 'hann';
  private playbackFrame = 0;

  private readonly waveZoom = el<HTMLInputElement>('wave-zoom');
  private readonly wavePan = el<HTMLInputElement>('wave-pan');
  private readonly keyZoom = el<HTMLInputElement>('key-zoom');
  private readonly keyPan = el<HTMLInputElement>('key-pan');
  private readonly statusMsg = el<HTMLElement>('status-msg');
  private readonly statusNote = el<HTMLElement>('status-note');
  private readonly fileInput = el<HTMLInputElement>('file');

  private readonly chrome: Refreshable[] = [];

  constructor() {
    this.wave = new WaveformView(el<HTMLCanvasElement>('wave'));
    this.spectrum = new SpectrumView(el<HTMLCanvasElement>('spectrum'));
    this.keys = new KeyboardView(el<HTMLCanvasElement>('keys'));

    this.buildChrome();
    this.wireWaveform();
    this.wireSpectrum();
    this.wireKeyboard();
    this.wireBars();
    this.wireFileInput();
    this.wireShortcuts();

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

  private setStatus(message: string, isError = false): void {
    this.statusMsg.textContent = message;
    this.statusMsg.style.color = isError ? 'var(--error)' : '';
  }

  // ---- opening files --------------------------------------------------------------------

  private wireFileInput(): void {
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
      this.totalTicks = envelope.length;
      this.wave.envelope = envelope;
      this.wave.selection = null;
      this.wave.drag = null;
      this.wave.playhead = null;
      this.wave.extent = 1;
      this.spectrum.spectrum = null;
      this.spectrum.hasFile = true;
      this.setKeyView(DEFAULT_KEY_LEFT, DEFAULT_KEY_COUNT);
      this.setWaveView(0, DEFAULT_SPAN_TICKS);

      document.title = `${audio.name} – Music Explorer`;
      // No sample rate here: decodeAudioData resamples to the audio context's rate, so what we
      // hold is not the file's own rate and quoting it would mislead.
      this.setStatus(`${audio.name} · ${formatTicks(this.totalTicks)}`);
    } catch {
      this.setStatus(`Unable to open ${file.name}: this browser could not decode it as audio.`, true);
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
    this.wavePan.disabled = !on;
    if (!this.hasFile) {
      this.waveZoom.value = this.wavePan.value = '0';
      return;
    }
    this.waveZoom.min = '0';
    this.waveZoom.max = '1000';
    this.waveZoom.step = '1';
    this.waveZoom.value = String(Math.round(this.spanToSlider(this.wave.span) * 1000));
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
    this.keyZoom.min = String(MIN_KEYS);
    this.keyZoom.max = String(MIDI_NOTES);
    this.keyZoom.step = '1';
    this.keyZoom.value = String(n);
    this.keyPan.min = '0';
    this.keyPan.max = String(MIDI_NOTES - n);
    this.keyPan.step = '1';
    this.keyPan.value = String(l);
    this.keyPan.disabled = MIDI_NOTES - n === 0;
    this.keys.invalidate();
    this.spectrum.invalidate();
  }

  private wireBars(): void {
    this.waveZoom.addEventListener('input', () => {
      // Keep the centre of the view fixed while zooming with the slider.
      const centre = this.wave.left + this.wave.span / 2;
      const span = this.sliderToSpan(Number(this.waveZoom.value) / 1000);
      this.setWaveView(centre - span / 2, span);
    });
    this.wavePan.addEventListener('input', () => this.setWaveView(Number(this.wavePan.value), this.wave.span));
    this.keyZoom.addEventListener('input', () => {
      const { left, right } = this.keys.range;
      const centre = (left + right + 1) / 2;
      const count = Number(this.keyZoom.value);
      this.setKeyView(centre - count / 2, count);
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
      if (pan) {
        const dx = e.clientX - pan.x;
        this.setWaveView(pan.left - (dx / canvas.clientWidth) * this.wave.span, this.wave.span);
      } else if (this.wave.drag) {
        this.wave.drag.current = tickAt(e);
        this.wave.invalidate();
      }
    });

    const finish = (e: PointerEvent, commit: boolean) => {
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

  // ---- spectrum + keyboard interaction --------------------------------------------------

  private wireSpectrum(): void {
    const canvas = this.spectrum.canvas;
    let drag: { x: number; left: number } | null = null;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, left: this.keys.range.left };
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const count = this.keys.range.right - this.keys.range.left + 1;
      const dNotes = ((e.clientX - drag.x) / canvas.clientWidth) * count;
      this.setKeyView(drag.left - dNotes, count);
    });
    const end = () => {
      drag = null;
      canvas.classList.remove('dragging');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    this.wireKeyWheel(canvas);
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
    let held = false;

    const release = () => {
      if (!held) return;
      held = false;
      this.engine.noteOff();
      this.keys.pressed = -1;
      this.statusNote.textContent = '';
      this.keys.invalidate();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const note = hitTestKey(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, this.keys.range);
      if (note < 0) return;
      canvas.setPointerCapture(e.pointerId);
      held = true;
      this.keys.pressed = note;
      this.statusNote.textContent = `Clicked: ${noteStatusText(note)}`;
      this.keys.invalidate();
      void this.engine.noteOn(note);
    });
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    this.wireKeyWheel(canvas);
  }

  // ---- playback -------------------------------------------------------------------------

  private async play(): Promise<void> {
    if (!this.audio) return;
    const sel = this.wave.selection;
    const start = sel?.start ?? 0;
    // No selection (or an empty one) plays from the start point to the end of the file.
    const end = sel && sel.end > sel.start ? sel.end : start;
    await this.engine.play(ticksToSeconds(start), ticksToSeconds(end));
    this.trackPlayhead();
    this.refreshChrome();
  }

  private trackPlayhead(): void {
    cancelAnimationFrame(this.playbackFrame);
    const step = () => {
      const pos = this.engine.positionSeconds;
      if (pos === null) return;
      this.wave.playhead = pos * TICKS_PER_SECOND;
      this.wave.invalidate();
      this.playbackFrame = requestAnimationFrame(step);
    };
    step();
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

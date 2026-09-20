/**
 * Diagnostics, loaded only when the page URL contains `?debug`. Outlines each region and prints
 * its measured size, the audio state and any errors on screen, so a screenshot from a device that
 * cannot be inspected remotely (iOS Safari, from a Windows machine) shows what went wrong.
 *
 * Errors come first and wrap in full: the status bar cuts a long message off, and anything below
 * them in this readout is the part that can safely be clipped.
 */
export interface DebugSources {
  /** Errors the app has shown, most recent last. */
  errors: () => string[];
  /** Audio state and recent audio events. */
  audio: () => string[];
}

export function showLayoutDebug(sources: DebugSources): void {
  document.body.classList.add('debug-layout');

  // Reads the safe-area insets, which are only visible to CSS.
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);

  const out = document.createElement('div');
  out.id = 'debug-readout';
  const errorBox = document.createElement('div');
  errorBox.className = 'debug-errors';
  const infoBox = document.createElement('pre');
  out.append(errorBox, infoBox);
  document.body.appendChild(out);

  // Anything the app did not catch itself (a rejected promise, a script error).
  const uncaught: string[] = [];
  const remember = (text: string) => {
    if (uncaught.at(-1) === text) return; // a failure repeated on every tap would crowd out the rest
    uncaught.push(text);
    if (uncaught.length > 5) uncaught.shift();
  };
  window.addEventListener('error', (e) => remember(`Uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    remember(`Unhandled: ${r instanceof Error ? r.message : String(r)}`);
  });

  const box = (sel: string): string => {
    const e = document.querySelector(sel);
    if (!e) return 'missing';
    const b = e.getBoundingClientRect();
    return `y${Math.round(b.top)} h${Math.round(b.height)} w${Math.round(b.width)}`;
  };
  const canvas = (id: string): string => {
    const c = document.getElementById(id) as HTMLCanvasElement | null;
    return c ? `bitmap ${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight}` : 'missing';
  };

  const update = () => {
    const errors = [...sources.errors(), ...uncaught];
    errorBox.hidden = errors.length === 0;
    errorBox.textContent = errors.map((e) => `! ${e}`).join('\n');

    const vv = window.visualViewport;
    const cs = getComputedStyle(probe);
    const rows = getComputedStyle(document.getElementById('panes') as HTMLElement).gridTemplateRows;
    infoBox.textContent = [
      ...sources.audio(),
      `inner ${innerWidth}x${innerHeight}  dpr ${devicePixelRatio}`,
      `visual ${vv ? `${vv.width}x${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}` : 'n/a'}`,
      `--app-height ${document.documentElement.style.getPropertyValue('--app-height') || 'unset'}`,
      `safe t${cs.paddingTop} b${cs.paddingBottom}`,
      `scroll ${Math.round(scrollY)}/${document.documentElement.scrollHeight}`,
      `html ${box('html')}`,
      `body ${box('body')}`,
      `#app ${box('#app')}`,
      `chrome ${box('.chrome')}`,
      `panes ${box('#panes')}`,
      `cellWave ${box('.cell-wave')}`,
      `wave ${box('#wave')}`,
      `waveBars ${box('#wave-bars')}`,
      `cellSpec ${box('.cell-spectrum')}`,
      `spectrum ${box('#spectrum')}`,
      `cellKeys ${box('.cell-keys')}`,
      `keys ${box('#keys')}`,
      `keyBars ${box('#key-bars')}`,
      `status ${box('.statusbar')}`,
      `rows ${rows}`,
      `wave ${canvas('wave')}`,
      `keys ${canvas('keys')}`,
    ].join('\n');
  };

  update();
  setInterval(update, 500);
}

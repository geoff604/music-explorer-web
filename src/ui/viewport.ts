/**
 * Keeps `--app-height` (used by the page's height in style.css) equal to the height actually
 * visible. iOS Safari's viewport units can include the area behind its toolbars, which pushes the
 * bottom of the app out of sight; `visualViewport` reports what is really on screen.
 */
export function trackViewportHeight(): void {
  const root = document.documentElement;

  const update = () => {
    // The soft keyboard shrinks the visual viewport; the Select Range dialog's fields raise it.
    // The layout behind a modal should not jump about, so hold the last height until it closes.
    if (document.querySelector('dialog[open]')) return;
    const height = window.visualViewport?.height ?? window.innerHeight;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
  };

  update();
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('pageshow', update);
  // Dialogs close without a resize; catch up with whatever changed while one was open.
  document.addEventListener('close', update, true);
}

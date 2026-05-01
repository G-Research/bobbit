/**
 * Cursor overlay — visible-cursor injection for Tier 2.5 video capture.
 *
 * Playwright's headless screenshots don't capture the OS cursor, so without
 * this you can't see where clicks land in the recorded video. The script
 * tracks DOM mouse / pointer events (which Playwright fires even in
 * headless), draws a red dot at the pointer position, and flashes yellow
 * on mousedown so clicks pop visually.
 *
 * Self-contained IIFE, idempotent (`window.__protoCursorInstalled` guard),
 * no external assets, no runtime cost worth caring about. Designed to be
 * passed to Playwright's `addInitScript` so it re-installs on every page
 * navigation.
 *
 * Verbatim port from `tests/prototype/scenario-runner.spec.ts` (the original
 * Tier 2.5 prototype).
 */

export const CURSOR_OVERLAY_SCRIPT = `
(() => {
  if (window.__protoCursorInstalled) return;
  window.__protoCursorInstalled = true;
  const install = () => {
    if (!document.documentElement) return;
    const dot = document.createElement('div');
    dot.id = '__proto_cursor';
    dot.style.cssText = [
      'position:fixed','width:22px','height:22px','border-radius:50%',
      'background:rgba(255,70,70,0.78)','border:2px solid white',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.35)',
      'pointer-events:none','z-index:2147483647',
      'transform:translate(-50%,-50%)','left:-100px','top:-100px',
      'transition:background-color 80ms linear'
    ].join(';');
    document.documentElement.appendChild(dot);
    const move = (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('mousedown', () => { dot.style.background = 'rgba(255,210,40,0.95)'; }, true);
    window.addEventListener('mouseup', () => { dot.style.background = 'rgba(255,70,70,0.78)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
`;

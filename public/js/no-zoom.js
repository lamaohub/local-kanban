/** Stop the page from being zoomed by a gesture: a pinch on a trackpad or a screen, Ctrl with the wheel. */
export function blockZoom(doc) {
  const stop = (e) => e.preventDefault();
  doc.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) doc.addEventListener(type, stop, { passive: false });
  doc.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

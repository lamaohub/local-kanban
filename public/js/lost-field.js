/** Whether a key pressed on this element is typing, not a board shortcut. */
export const isField = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '') || el.isContentEditable === true);

export const ENTER_CLOSES_MS = 300; // a field gone this soon after its own Enter was closed by it

/** Watch where the person types; the returned function says whether that field went away under them. */
export function watchTyping(doc) {
  let field = null;
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { field = null; return; }
    if (!isField(e.target)) return;
    field = e.target;
    if (e.key === 'Enter' && !e.shiftKey) {
      const f = field;
      setTimeout(() => { if (field === f && doc.activeElement !== f) field = null; }, ENTER_CLOSES_MS);
    }
  }, true);
  doc.addEventListener('pointerdown', () => { field = null; }, true);
  doc.addEventListener('focusin', (e) => { if (e.target !== field) field = null; }, true);
  return () => !!field && doc.activeElement !== field;
}

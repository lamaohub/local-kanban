function storeOf(name) {
  const kept = new Map(); // what the browser refused to store
  const area = () => globalThis[name]; // the getter itself throws when the browser forbids storage
  return {
    getItem(k) {
      if (kept.has(k)) return kept.get(k);
      try { return area().getItem(k); } catch { return null; }
    },
    setItem(k, v) {
      const s = String(v);
      try { area().setItem(k, s); kept.delete(k); } catch { kept.set(k, s); }
    },
    removeItem(k) {
      try { area().removeItem(k); kept.delete(k); } catch { kept.set(k, null); }
    },
  };
}

/** `localStorage` that never throws: what it could not store lives in the tab until a reload. */
export const localStore = storeOf('localStorage');
/** `sessionStorage` that never throws, the same way. */
export const sessionStore = storeOf('sessionStorage');

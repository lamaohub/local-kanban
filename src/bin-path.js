
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The first `name` in PATH that may be run, or null. */
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
}

const found = new Map(); // PATH + name → full path
/** `name` for execFile/spawn: its full path when PATH has it, else the name itself (the start then fails as it would).
    Found once for a PATH; a miss is not kept — a program installed later is found. */
export function bin(name) {
  const key = `${process.env.PATH || ''}\0${name}`;
  let p = found.get(key);
  if (!p) {
    p = onPath(name);
    if (p) found.set(key, p);
  }
  return p || name;
}

export const EDITORS = { vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' };

/** The address that opens `path` (absolute) at `line` in `editor`, or null: no editor picked, no absolute path. */
export function editorLink(editor, path, line = null) {
  if (!Object.hasOwn(EDITORS, editor) || typeof path !== 'string' || !path.startsWith('/')) return null;
  const where = encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const at = Number.isInteger(line) && line > 0 ? `:${line}${editor === 'zed' ? '' : ':1'}` : '';
  return `${editor}://file${where}${at}`;
}

const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^.:/]+\.local\b)/i;
export function previewUrl(domain) {
  const first = String(domain || '').trim().split(/[\s,]+/)[0];
  if (!first) return null;
  const withScheme = /^https?:\/\//i.test(first) ? first : `${LOCAL.test(first) ? 'http' : 'https'}://${first}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || (!u.hostname.includes('.') && !LOCAL.test(u.host) && u.hostname !== 'localhost')) return null;
  return u.href;
}

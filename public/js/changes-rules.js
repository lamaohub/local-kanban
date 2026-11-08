
/** «file:line» of a remark — the line of the new side, or of the old one for a line that was removed. */
export const remarkPlace = (r) => `${r.file}:${r.line}${r.removed ? ` (${r.removedWord || 'removed'})` : ''}`;

/** The message: a heading with the task's key, then a remark a line — the place, the line of code it is about, the words. */
export function remarksMessage(key, remarks, tr = (s) => s) {
  const head = tr('Remarks on the changes of {key} — fix each, then tell me what you did:').replace('{key}', key);
  const body = remarks.map((r) => {
    const code = String(r.code || '').trim();
    return `- ${r.file}:${r.line}${r.removed ? ` (${tr('a removed line')})` : ''}${code ? ` \`${code.length > 120 ? `${code.slice(0, 117)}…` : code}\`` : ''} — ${String(r.text).trim()}`;
  });
  return [head, ...body].join('\n');
}

/** A remark is kept once per place: a second one on the same line takes the place of the first. */
export function addRemark(list, r) {
  const same = (x) => x.file === r.file && x.line === r.line && Boolean(x.removed) === Boolean(r.removed);
  return [...list.filter((x) => !same(x)), r];
}

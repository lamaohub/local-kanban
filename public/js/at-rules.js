
export const DEFAULT_TEMPLATES = [
  { name: 'bug', text: 'Steps:\n1. \n\nExpected:\n\nGot:\n' },
  { name: 'criteria', text: 'Acceptance criteria:\n- [ ] \n- [ ] \n- [ ] \n' },
  { name: 'question', text: 'What I want to understand:\n\nWhat I know already:\n\nWhat the answer should be (a note, a plan, a decision):\n' },
];

/** The «@word» the caret stands right after — {start, query} — or null. «@» counts at the start of the field or after a
    space or a line break (an e-mail address is not a mention); the word runs to the caret, without spaces. */
export function atQuery(value, caret) {
  const before = String(value).slice(0, caret);
  const m = /(^|[\s(])@([^\s@]*)$/u.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** `value` with the «@word» from `start` to `caret` replaced by `text`: {value, caret} — the caret after what went in. */
export function insertAt(value, start, caret, text) {
  const v = String(value);
  return { value: v.slice(0, start) + text + v.slice(caret), caret: start + text.length };
}

/** The templates whose name starts with `query` (any case), then the ones holding it. */
export function matchTemplates(list, query) {
  const q = String(query || '').toLowerCase();
  const starts = list.filter((t) => t.name.toLowerCase().startsWith(q));
  return [...starts, ...list.filter((t) => !starts.includes(t) && t.name.toLowerCase().includes(q))];
}

/** A file named in the chat as Claude Code takes it: «@path» — a path with a space goes in quotes. */
export const fileMention = (path) => (/\s/.test(path) ? `@"${path}" ` : `@${path} `);

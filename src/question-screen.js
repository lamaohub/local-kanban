
const RULE = /^\s*─{8,}/;
const FOOTER = /Esc to (cancel|exit)|Enter to (confirm|select)/;
const OPTION = /^(\s*)(❯\s*)?(\d{1,2})\.\s+(\S.*)$/;
const BOX = /^(?:\[([ xX✓✔])\]|([☐☒☑◯◉]))\s+/;
const TAB = /^([☐☒☑✔✓])\s*(.+)$/;
const DEEPER = 3; // a row of an option goes deeper than its number
const WRAP_SLACK = 4;
const ABOVE_MAX = 200; // rows of a question over its options: a tall one comes from the history over the window
const HINTS = 3; // rows that may stand under the options of a dialog without a footer
const INPUT_OPTION = /^(Type something\.?|No, keep planning)$/i; // an option that takes the person's own words
const ESCAPE = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

/** A captured row without its escapes, and whether all its words are drawn faint (null: no escapes in the row). */
function readRow(row) {
  if (!row.includes('\x1b')) return { text: row, faint: null };
  let text = '';
  let dim = false;
  let bright = false;
  let faint = false;
  let last = 0;
  const take = (s) => { text += s; if (/\S/.test(s)) { if (dim) faint = true; else bright = true; } };
  for (const m of row.matchAll(ESCAPE)) {
    take(row.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const ps = m[1] === '' ? ['0'] : m[1].split(';');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === '0' || p === '' || p === '22') dim = false;
      else if (p === '2') dim = true;
      else if (/^[345]8$/.test(p)) i += ps[i + 1] === '5' ? 2 : ps[i + 1] === '2' ? 4 : 0; // a colour's own numbers
    }
  }
  take(row.slice(last));
  return { text, faint: faint && !bright };
}
/** A screen captured with its attributes, as plain text. */
export const plainScreen = (screen) => String(screen ?? '').split('\n').map((l) => readRow(l).text).join('\n');

/** Where a dialog without a footer ends (the approval of a plan): the row under its options — only a few hints under
    them, no rule (the input box has its rules around «❯ …») and no prompt row; -1 — the bottom is not such a dialog. */
function footless(lines, indent) {
  let i = lines.length - 1;
  for (let hints = 0; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (OPTION.test(l)) return i + 1;
    if (indent(l) >= DEEPER) { // the description of the last option — over it its other rows, then the option itself
      let k = i - 1;
      while (k >= 0 && lines[k].trim() && !OPTION.test(lines[k]) && indent(lines[k]) >= DEEPER) k--;
      return k >= 0 && OPTION.test(lines[k]) ? i + 1 : -1; // a status row standing right, a rule over it — not a dialog
    }
    if (RULE.test(l) || /^\s*❯/.test(l) || ++hints > HINTS) return -1;
  }
  return -1;
}

/** {tabs: [{label, done}], text, options: [{n, label, note, cursor, checked?, other?}], multi, cut?, ruled?} of the
    choice the screen shows above its footer, or null — no footer, or no numbered options over it. `cut` — its question
    goes on over the top of the screen; `ruled` — read whole, up to the rule over the dialog. */
export function screenQuestion(screen) {
  const rows = String(screen ?? '').split('\n').map(readRow);
  const lines = rows.map((r) => r.text.replace(/\s+$/, ''));
  // a screen captured with its attributes: a row is faint or bright; one without them (plain text) — unknown (null)
  const attrs = rows.some((r) => r.faint !== null);
  const faint = rows.map((r) => (attrs ? r.faint === true : null));
  const indent = (l) => l.match(/^\s*/)[0].length;
  // the footer — the last rows that say how to answer (wrapped onto two in a narrow window), the input box under it
  let foot = -1;
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 8; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    if (FOOTER.test(lines[i])) { foot = i; break; }
  }
  const bare = foot < 0;
  if (bare) foot = footless(lines, indent);
  if (foot < 0) return null;
  if (!bare) while (foot > 0 && lines[foot - 1].trim() && !OPTION.test(lines[foot - 1]) && !RULE.test(lines[foot - 1]) && indent(lines[foot - 1]) < DEEPER) foot--;
  // the options, from the footer up: numbered rows, the rows under them (deeper), a rule between them
  let first = -1;
  let i = foot - 1;
  for (; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || RULE.test(l)) continue;
    if (OPTION.test(l)) { first = i; continue; }
    if (indent(l) >= DEEPER && !l.trimStart().startsWith('│')) continue;
    break;
  }
  if (first < 0) return null;
  if (bare && !lines.slice(first, foot).some((l) => /^\s*❯\s*\d{1,2}\./.test(l))) return null;
  // the question over them: up to the rule above the dialog; the row of its tabs, the bar of its text taken off
  const above = [];
  let j = first - 1;
  for (; j >= 0 && first - j <= ABOVE_MAX && !RULE.test(lines[j]); j--) above.unshift(lines[j]);
  // a question of AskUserQuestion taller than the window: the top row of the capture is its text, under the bar «│»;
  // read with the history, it is whole when the rows up to the rule are its own — the bar, its tabs, empty rows (not the
  // rule of the input box or Claude's «---» over other words)
  const bar = (l) => /^\s*│/.test(l);
  const cut = j < 0 && bar(lines[0] ?? '');
  const ruled = j >= 0 && RULE.test(lines[j]) && above.some(bar) && above.every((l) => !l.trim() || bar(l) || /[☐☒☑✔]/.test(l));
  if (above.length && !(j >= 0 && RULE.test(lines[j]))) { // no rule over it: only the block right over the options
    while (above.length && !above.at(-1).trim()) above.pop();
    const gap = above.map((l) => !l.trim()).lastIndexOf(true);
    above.splice(0, gap + 1);
  }
  // the width of the window — by the rules of the dialog itself: the history over it may hold rules of a wider window
  const rules = lines.slice(Math.max(0, j), foot + 1).filter((l) => RULE.test(l)).map((l) => l.length);
  const width = rules.length ? Math.max(...rules) : Math.max(0, ...lines.slice(first - above.length, foot).map((l) => l.length));
  // Claude Code wraps a little short of the window's edge (its padding): «— the» went to the next row at 42 of 45
  const wrappedAfter = (prev, next) => prev.length + 1 + next.split(/\s+/)[0].length > width - WRAP_SLACK;
  let tabs = [];
  const paras = [];
  let para = '';
  let prevText = '';
  let prevFaint = null;
  const aboveFrom = first - above.length;
  for (const [k, l] of above.entries()) {
    const f = faint[aboveFrom + k];
    const t = l.trim();
    if (!tabs.length && !paras.length && !para && /[☐☒☑✔]/.test(t)) {
      tabs = t.replace(/^←\s*|\s*→$/g, '').split(/\s{2,}/).map((c) => c.match(TAB)).filter(Boolean)
        .map((m) => ({ label: m[2].trim(), done: m[1] !== '☐' }));
      continue;
    }
    const words = l.replace(/^\s*│ ?/, '').trim();
    if (!words) { if (para) paras.push(para); para = ''; prevText = ''; continue; }
    // the terminal's own wraps are put back together; a row that ended short ended there in the question too
    if (para) para += wrappedAfter(prevText, words) && !(attrs && f !== prevFaint) ? ' ' : '\n';
    para += words;
    prevText = l;
    prevFaint = f;
  }
  if (para) paras.push(para);
  const text = paras.join('\n\n');
  // the options top to bottom: a label, wrapped on, then its description
  const options = [];
  // the rows under the options' numbers: when some are faint, faintness says which is a description
  const marked = lines.slice(first, foot).some((l, k) => faint[first + k] === true && !OPTION.test(l));
  let cur = null;
  let part = 'label';
  let prev = '';
  for (let j = first; j < foot; j++) {
    const l = lines[j];
    if (RULE.test(l)) { prev = ''; continue; }
    if (!l.trim()) { if (cur) part = 'note'; prev = ''; continue; }
    const m = l.match(OPTION);
    if (m) {
      let label = m[4].trim();
      const box = label.match(BOX);
      cur = { n: Number(m[3]), label, note: '', cursor: Boolean(m[2]) };
      if (box) {
        cur.checked = !(box[1] === ' ' || box[2] === '☐' || box[2] === '◯');
        label = label.slice(box[0].length).trim();
        cur.label = label;
      }
      options.push(cur);
      part = 'label';
      prev = l;
      continue;
    }
    if (!cur) continue;
    const t = l.trim();
    const wrapped = marked ? faint[j] !== true : prev && wrappedAfter(prev, t);
    if (part === 'label' && wrapped) cur.label += ` ${t}`;
    else {
      part = 'note';
      cur.note = cur.note ? `${cur.note} ${t}` : t;
    }
    prev = l;
  }
  if (!options.length) return null;
  for (const o of options) if (INPUT_OPTION.test(o.label)) o.other = true;
  const choice = { tabs, text, options, multi: options.some((o) => o.checked !== undefined) };
  if (cut) choice.cut = true;
  if (ruled) choice.ruled = true;
  return choice;
}

export async function wholeChoice(screen, withHistory) {
  let choice = screenQuestion(screen);
  if (choice?.cut) {
    const whole = screenQuestion((await withHistory()) ?? '');
    if (whole?.ruled) choice = whole;
  }
  if (choice) { delete choice.cut; delete choice.ruled; }
  return choice;
}

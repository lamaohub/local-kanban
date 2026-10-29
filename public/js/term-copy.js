
// how many columns short of its box a row of Claude's text may end and still have been broken by the width — its rows
// sometimes break a word or two earlier than the box would hold
const SLACK = 2;
// a tool's answer ("⎿") keeps this many columns free on the right of the window
const ANSWER_MARGIN = 5;
// how many rows around a paragraph tell the width of the window it was drawn in
const NEAR = 40;
// how much narrower than the window they must all be to tell it — a row a few columns short of the edge is everywhere
const NARROWER = 10;
// how many of them must reach that narrower edge, give or take a short word, to tell it: rows broken by a width end near
// was taken for the edge, and "git push" under it was joined to it)
const EDGE_ROWS = 2;
const EDGE_NEAR = 4;
// and no window the board draws is narrower than this (the card holds 44–46 columns): short rows of a tool's answer
// ("app.js" / "db.js") reach their own longest one, and are no edge either
const DRAWN_MIN = 40;
// a row that starts a list item, a message, a tool's answer or the prompt is a line of its own, never the rest of one
const MARKER = /^(?:[-*•◦▪‣⏺⎿❯>✻✶✳✢·]|\d{1,3}[.)])(?=\s)/;
// the frame of a box (the input box, a dialog) — its rows are never joined to anything
const BOX = /^\s*[─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║]/;
// the head of a tool's call: "⏺ Bash(" — the command after it is laid out from there on its first row
const CALL = /^[A-Z][\w ]{0,30}\(/;
// a word of code — a path, an address, a call: the kind of word long enough to be cut in the middle at the width
const CODE = /[/\\:._=~(),;[\]{}"'$|&<>]/;
// inside a tool's answer only these start a row of their own: a list there is its output, and "- " a line of a diff
const ANSWER_MARKER = /^[⏺⎿❯✻✶✳✢]/;
// the gutter of a diff in a tool's answer ("  33 -text", "  30  text") — its rows are laid out by the diff, not cut
const DIFF = /^\s{4,}\d+ [ +-]/;

const indentOf = (s) => s.match(/^[ \u00a0]*/)[0].length;
const firstWord = (s) => s.trimStart().split(/\s/)[0];
const lastWord = (s) => s.trimEnd().split(/\s/).pop();
/** Where the text of a row stands: past its indent and past a marker it starts with ("⏺ ", "1. ", "⎿  "), and on the
    first row of a tool's call past its head ("⏺ Bash(") — the rows that go on with it are laid out in that box. */
function textStart(row, head) {
  const lead = indentOf(row);
  const m = row.slice(lead).match(MARKER);
  if (!m) return lead;
  const after = lead + m[0].length;
  const at = after + Math.min(2, row.slice(after).match(/^\s*/)[0].length);
  const call = head && m[0] === '⏺' ? row.slice(at).match(CALL) : null;
  return at + (call ? call[0].length : 0);
}

/** The paragraphs of the rows — a marker or a blank row starts one: {kind, edge} for each row. `kind` — 'answer' for a
    tool's answer, which Claude Code cuts at the width letter by letter, else 'text', wrapped at spaces; `edge` — the
    width a row of it is cut at: an answer's right column, the columns of a text's box. The window's width is the one
    it was drawn in, not the one it has now: the card and the Terminals view lay the window out for themselves, so
    the history holds rows of several widths. A window that got narrower since is in the paragraph's own rows (tmux
    put them back together); one that got wider is told by the screen rows near it: none of them comes close to the
    edge it has now. Too wide a guess only leaves a break in, too narrow a one joins lines Claude ended — so the window
    it has now, unless they all stop well short of it. `wide[k]` — the longest screen row of row `k`. */
function paragraphs(rows, wide, cols) {
  const out = new Array(rows.length);
  const near = (i, j) => {
    const around = wide.slice(Math.max(0, i - NEAR), j + NEAR);
    const most = Math.max(0, ...around);
    const told = around.filter((w) => w >= most - EDGE_NEAR).length >= EDGE_ROWS;
    return most >= DRAWN_MIN && told && most <= cols - NARROWER ? most : cols;
  };
  for (let i = 0; i < rows.length;) {
    const answer = rows[i].trimStart().startsWith('⎿');
    const ends = answer ? (r) => ANSWER_MARKER.test(r.trimStart()) || indentOf(r) < textStart(rows[i], false)
      : (r) => MARKER.test(r.trimStart());
    let j = i + 1;
    while (rows[i].trim() && j < rows.length && rows[j].trim() && !ends(rows[j]) && !BOX.test(rows[j])) j++;
    const own = rows.slice(i, j);
    const width = near(i, j);
    const p = answer
      ? { kind: own.some((r) => DIFF.test(r)) ? 'diff' : 'answer', base: textStart(rows[i], false),
        edge: Math.max(width - ANSWER_MARGIN, ...own.map((r) => r.length)) }
      : { kind: 'text', first: i, edge: Math.max(width - textStart(rows[i], true),
        ...rows.slice(i, j).map((r, k) => r.length - textStart(r, k === 0))) };
    out.fill(p, i, j);
    i = j;
  }
  return out;
}

/** How row `k + 1` goes on from row `k`: null — a line of its own; ' ' — the width broke a line at a space; '' — it
    cut a word. `p` — the paragraph of row `k` (`paragraphs`). */
export function joinOf(rows, k, p) {
  const a = rows[k];
  const b = rows[k + 1];
  if (p.kind === 'diff' || !a.trim() || !b.trim() || BOX.test(a) || BOX.test(b)) return null;
  if ((p.kind === 'answer' ? ANSWER_MARKER : MARKER).test(b.trimStart())) return null;
  // the rest of a row is laid out under its text: a row that stands left of that starts something of its own
  if (indentOf(b) < (k === p.first ? textStart(a, false) : indentOf(a))) return null;
  if (p.kind === 'answer') {
    // an answer's row cut in the middle of a word ends at the edge; cut at a space, the space was trimmed off its end —
    // or went to the start of the next row, which then stands a column further right than the answer's text
    if (a.length >= p.edge) return ' '.repeat(Math.max(0, indentOf(b) - p.base));
    return a.length === p.edge - 1 ? ' ' : null;
  }
  const len = a.length - textStart(a, k === p.first);
  if (len + 1 + firstWord(b).length <= p.edge - SLACK) return null; // its next word would have fit: Claude ended it
  // Claude's own text and commands wrap at spaces, and a word is cut only when it is longer than a whole row — a word
  // that would have fit on one was not cut (">/dev/null" / "2>&1" is two). A row the cut word started on is all of it,
  // or ends in a word of code ("…print(json" / ".load(sys.stdin)"), not in a flag or a word of prose ("curl -s" /
  // "http://…"). The first row of a command starts a column further right than the rest ("⏺ Bash(" against six
  // spaces) and sometimes ends a column short of their box: a column short is full there
  const word = lastWord(a);
  const cut = len >= p.edge - (k === p.first ? 1 : 0) && (word + firstWord(b)).length > p.edge
    && (word.length >= len || CODE.test(word));
  return cut ? '' : ' ';
}

/** The rows of the screen with the ones tmux wrapped put back together: [{text, starts}] — `starts[k]` is where the
    screen's row `first + k` begins in `text`. */
function logicalRows(rows, wraps, width) {
  const out = [];
  rows.forEach((row, i) => {
    const prev = out[out.length - 1];
    if (prev && wraps.has(i)) {
      // a row tmux wrapped is the window's width: shorter, its end was spaces the capture trimmed — one stands for them
      if (width && rows[i - 1].length < width) prev.text += ' ';
      prev.starts.push(prev.text.length);
      prev.text += row;
    } else out.push({ text: row, first: i, starts: [0] });
  });
  return out;
}

/** The text a selection from offset `from` to `to` of the screen's text copies — or null when it is within one row:
    the browser's own copy is right there. `info` — {wraps: [rows tmux wrapped], cols: the window's columns}. */
export function screenCopy(screen, info, from, to) {
  const rows = screen.split('\n');
  const at = (off) => {
    let line = 0;
    let rest = Math.max(0, off);
    while (line < rows.length - 1 && rest > rows[line].length) { rest -= rows[line].length + 1; line++; }
    return { line, ch: Math.min(rest, rows[line].length) };
  };
  const s = at(Math.min(from, to));
  const e = at(Math.max(from, to));
  if (s.line === e.line) return null;
  const width = Number(info?.cols) || 0;
  const logical = logicalRows(rows, new Set(info?.wraps || []), width);
  const where = (p) => {
    const k = logical.findIndex((l) => p.line >= l.first && p.line < l.first + l.starts.length);
    return { k, off: logical[k].starts[p.line - logical[k].first] + p.ch };
  };
  const a = where(s);
  const b = where(e);
  // the frame of the input box spans the window as it is now, whatever the text above it was drawn in, and so does a
  // row tmux wraps itself: it is laid out again for every window — neither tells the width Claude drew in
  const wide = logical.map((l) => (BOX.test(l.text) || l.starts.length > 1 ? 0 : rows[l.first].length));
  const para = paragraphs(logical.map((l) => l.text), wide, width);
  const texts = logical.map((l) => l.text);
  const lines = []; // {text, whole} — `whole`: the line starts where its row starts, its indent is a real one
  for (let k = a.k; k <= b.k; k++) {
    const full = logical[k].text;
    // a selection begun in the indent of its row (or right where its text starts) takes the indent too: it is the
    // row's, and the copy loses the indent all its rows share
    const from = k === a.k && a.off > indentOf(full) ? a.off : 0;
    const piece = full.slice(from, k === b.k ? b.off : undefined);
    const how = k > a.k ? joinOf(texts, k - 1, para[k - 1]) : null;
    if (k > a.k && how !== null) {
      lines[lines.length - 1].text = lines[lines.length - 1].text.replace(/[ \u00a0]+$/, '') + how + piece.trimStart();
    } else lines.push({ text: piece, whole: from === 0 });
  }
  const cut = Math.min(...lines.filter((l) => l.whole && l.text.trim()).map((l) => indentOf(l.text)), Infinity);
  return lines.map((l) => (l.whole && Number.isFinite(cut) ? l.text.slice(Math.min(cut, indentOf(l.text))) : l.text.trimStart())
    .replace(/[ \u00a0]+$/, '')).join('\n');
}

/** Makes the copy of a selection on `pre` (a screen drawn as its text alone) the text Claude wrote. `info()` — the
    {wraps, cols} of the screen drawn there now. */
export function wireTermCopy(pre, info) {
  pre.oncopy = (e) => {
    const sel = globalThis.document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = pre.textContent;
    const offset = (node, off, outside) => {
      if (!pre.contains(node)) return outside;
      const r = globalThis.document.createRange();
      r.setStart(pre, 0);
      r.setEnd(node, off);
      return r.toString().length;
    };
    const out = screenCopy(text, info(), offset(range.startContainer, range.startOffset, 0),
      offset(range.endContainer, range.endOffset, text.length));
    if (out === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', out);
    e.preventDefault();
  };
}

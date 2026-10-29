
const RULE = /^\s*─{8,}/;
const MARK = /^\s*❯[\s ]?/;

/** One captured row (`capture-pane -e`) without its escapes and without the text it draws faint. */
export function undim(row) {
  let out = '';
  let dim = false;
  let last = 0;
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
  for (let m; (m = re.exec(row));) {
    if (!dim) out += row.slice(last, m.index);
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const ps = m[1] === '' ? ['0'] : m[1].split(';');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === '0' || p === '' || p === '22') dim = false;
      else if (p === '2') dim = true;
      else if (/^[345]8$/.test(p)) i += ps[i + 1] === '5' ? 2 : ps[i + 1] === '2' ? 4 : 0; // a colour's own numbers
    }
  }
  if (!dim) out += row.slice(last);
  return out;
}

/** The input field on a screen (rows, faint text already gone): {text, rows} — `rows` it takes; null — none is drawn
    (a question in its place, Claude not up yet). */
export function promptBox(rows) {
  const box = findBox(rows);
  return box && { text: box.text, rows: box.rows };
}
function findBox(rows) {
  for (let i = rows.length - 1; i > 0; i--) {
    if (!MARK.test(rows[i]) || !RULE.test(rows[i - 1])) continue;
    let j = i + 1;
    while (j < rows.length && !RULE.test(rows[j])) j++;
    if (j >= rows.length) return null; // the field runs past the screen's bottom: not one to read
    const lines = [rows[i].replace(MARK, ''), ...rows.slice(i + 1, j).map((r) => r.replace(/^ {0,2}/, ''))];
    return { text: lines.join('\n').replace(/ /g, ' ').trim(), rows: j - i, top: i, bottom: j };
  }
  return null;
}

/** The field taller than the window: `rows` — the history over the window and the window (its `shown` last rows).
    Taken only when its "❯" row is in the history and its closing rule in the window: a field all in the history is an
    old one. Null otherwise. */
export function tallBox(rows, shown) {
  const box = findBox(rows);
  const from = rows.length - shown;
  if (!box || box.top >= from || box.bottom < from) return null;
  return { text: box.text, rows: box.rows };
}

const flat = (s) => String(s ?? '').replace(/[\s ]+/g, '');
const SIG = 24; // characters of each end of long words looked for in the field: the screen wraps the middle anywhere

/** Whether `text` and the pictures `images` (paths) stand in the field `boxText`. A long paste Claude Code folds into
    "[Pasted text #N +M lines]", a picture into "[Image #N]" — or leaves its path, when it may not read the file. */
export function inField(boxText, text, images = []) {
  const box = flat(boxText);
  if (images.length) {
    const pictures = (String(boxText ?? '').match(/\[Image #\d+\]/g) || []).length;
    const paths = images.filter((p) => box.includes(flat(p))).length;
    if (pictures + paths < images.length) return false;
  }
  const t = flat(text);
  if (!t) return true;
  if (/\[Pasted text #\d+/.test(String(boxText ?? ''))) return true;
  return t.length <= SIG * 2 ? box.includes(t) : box.includes(t.slice(0, SIG)) && box.includes(t.slice(-SIG));
}

/** Keys that empty the field from anywhere in it: Ctrl+K cuts to the row's end (at its end — the line break), Ctrl+U to
    its start (at its start — the break before); twice per row and some over, as Ghostex does. Harmless on an empty field. */
export function clearKeys(rows) {
  const n = 2 * Math.max(1, rows) + 8;
  return [...Array(n).fill('C-k'), ...Array(n).fill('C-u')];
}

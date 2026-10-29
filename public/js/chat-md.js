
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ESC[ch]);
const HOLD = ''; // a character of the private area: a code span waits under it while the other rules run

const CMD_WORDS = new Set(['ssh', 'scp', 'rsync', 'git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'kb', 'curl', 'wget', 'pm2', 'sudo',
  'brew', 'python', 'python3', 'pip', 'pip3', 'cd', 'ls', 'cat', 'tail', 'head', 'grep', 'rg', 'find', 'docker', 'kubectl', 'systemctl',
  'journalctl', 'tmux', 'open', 'make', 'cargo', 'go', 'bash', 'sh', 'zsh', 'chmod', 'chown', 'mkdir', 'rm', 'mv', 'cp', 'echo', 'export',
  'psql', 'sqlite3', 'launchctl', 'defaults', 'xcodebuild', 'claude', 'lsof', 'kill', 'ps', 'tar', 'unzip', 'nginx', 'certbot', 'crontab']);
export const CMD_MIN = 16;
/** Does a code span (its raw text) read as a command to copy? */
export function isCommand(code) {
  const c = String(code).trim();
  if (/^[!$] \S/.test(c)) return true;
  const word = /^(\S+) \S/.exec(c)?.[1];
  return Boolean(word) && CMD_WORDS.has(word) && c.length >= CMD_MIN;
}

export function inlineMd(s, tools = null) {
  const held = [];
  let out = esc(String(s).replaceAll(HOLD, '')).replace(/`([^`\n]+)`([.,;:](?=\s|$))?/g, (all, c, mark) => {
    const raw = c.replace(/&(amp|lt|gt|quot|#39);/g, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[e]);
    if (tools && isCommand(raw)) held.push(`<span class="chat-code-box chat-cmd"><span class="chat-code">${c}</span>${tools('', false, raw)}</span>`);
    else { held.push(`<code>${c}</code>`); return `${HOLD}${held.length - 1}${HOLD}${mark || ''}`; }
    return `${HOLD}${held.length - 1}${HOLD}`;
  });
  out = out
    .replace(/\[([^[\]\n]+)\]\((https?:\/\/[^)\s\uE000]+)\)/g, (_, t, u) => { held.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`); return `${HOLD}${held.length - 1}${HOLD}`; })
    .replace(/(^|[\s(])(https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<\uE000])*(?:(?!&(?:quot|#39|lt|gt);)[^\s<.,;:!?)'"&\uE000]))/g, (_, pre, u) => { held.push(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); return `${pre}${HOLD}${held.length - 1}${HOLD}`; })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  const back = new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g');
  // a held piece may hold another (`code` in the words of a link): let out until none is left
  for (let k = 0; k < 3 && out.includes(HOLD); k++) out = out.replace(back, (_, i) => held[Number(i)]);
  return out;
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/; // tested on a trimmed line
const QUOTE_DEPTH = 8; // deeper quotes are words: a quote reads itself by calling itself, and 5000 of them broke the chat
/** The words of a heading without its closing #s (a run of them after a space, or alone). */
function headWords(s) {
  const t = s.trimEnd();
  let k = t.length;
  while (k && t[k - 1] === '#') k--;
  return k === 0 ? '' : k < t.length && /\s/.test(t[k - 1]) ? t.slice(0, k).trimEnd() : t;
}
/** The cells of a table line — a `|` inside `code` or escaped as `\|` is a character of its cell, not a border. */
function cells(line) {
  const t = line.trim().replace(/^\|/, '');
  const out = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || !t.endsWith('|')) out.push(cur);
  return out.map((c) => c.trim());
}

function listHTML(items, tools = null) {
  // items: [{indent, ordered, text}] — a deeper indent opens a list inside the item above it
  let html = '';
  const open = []; // [{indent, tag}]
  for (const it of items) {
    while (open.length && it.indent < open.at(-1).indent) html += `</li></${open.pop().tag}>`;
    const tag = it.ordered ? 'ol' : 'ul';
    if (!open.length || it.indent > open.at(-1).indent) {
      html += `<${tag} class="md-list"${it.ordered && it.n !== 1 ? ` start="${it.n}"` : ''}>`;
      open.push({ indent: it.indent, tag });
    } else html += '</li>';
    const box = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
    html += box ? `<li class="md-task">${box[1] === ' ' ? '☐' : '☑'} ${inlineMd(box[2], tools)}` : `<li>${inlineMd(it.text, tools)}`;
  }
  while (open.length) html += `</li></${open.pop().tag}>`;
  return html;
}

function blocksHTML(text, depth = 0, tools = null) {
  const lines = text.split('\n');
  let html = '';
  let para = [];
  const flush = () => { if (para.length) html += `<p>${para.map((l) => inlineMd(l, tools)).join('<br>')}</p>`; para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = HEAD.exec(line))) { flush(); html += `<div class="md-h md-h${m[1].length}">${inlineMd(headWords(m[2]))}</div>`; continue; }
    if (RULE.test(line)) { flush(); html += '<hr class="md-hr">'; continue; }
    if (depth < QUOTE_DEPTH && QUOTE.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { q.push(m[1]); i++; }
      i--;
      html += `<blockquote class="md-quote">${blocksHTML(q.join('\n'), depth + 1, tools)}</blockquote>`;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())
      && cells(lines[i + 1]).length === cells(line).length) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inlineMd(c)}</${tag}>`;
      let t = `<div class="md-table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        t += `<tr>${cells(lines[i]).slice(0, head.length).map((c, k) => td('td', c, k)).join('')}</tr>`;
        i++;
      }
      i--;
      html += `${t}</tbody></table></div>`;
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        m = LIST.exec(lines[i]);
        if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), n: parseInt(m[2], 10), text: m[3] }); i++; continue; }
        // every item stood as a list of its own, each numbered 1. The list goes on to an item of its kind (or a deeper one)
        // or to a paragraph indented under an item; the blank lines are passed once here, at most once more if it ends
        if (items.length && !lines[i].trim()) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = j < lines.length ? LIST.exec(lines[j]) : null;
          if (next ? next[1].replace(/\t/g, '    ').length > items[0].indent || /\d/.test(next[2]) === items[0].ordered
            : j < lines.length && /^\s{2,}\S/.test(lines[j])) { i = j; continue; }
          break;
        }
        // a line under an item, indented: the item goes on
        if (items.length && /^\s+\S/.test(lines[i]) && !LIST.test(lines[i])) { items.at(-1).text += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      i--;
      html += listHTML(items, tools);
      continue;
    }
    para.push(line);
  }
  flush();
  return html;
}

export const SHELL_LANGS = ['', 'bash', 'sh', 'zsh', 'shell'];
const FENCE = /^[ \t]*```([^\n]*)$/gm;
/** The language of a fence's info string — its first word, lower case ('' for none). */
export const fenceLang = (info) => String(info ?? '').trim().split(/\s+/)[0].toLowerCase();

/** Claude's words as HTML: fenced code apart, the rest as Markdown blocks. `codeTools(lang, closed, code)` — the buttons a
    block of code gets beside it (markup the caller makes; none — the block alone); `closed` — a fence ends the block. */
export function chatText(s, codeTools = null) {
  const text = String(s ?? '');
  const parts = text.split(/^[ \t]*```[^\n]*$/m);
  const langs = [...text.matchAll(FENCE)].map((m) => fenceLang(m[1]));
  return parts.map((p, i) => {
    if (!(i % 2)) return blocksHTML(p, 0, codeTools);
    const code = p.replace(/^\n/, '').replace(/\n$/, '');
    const pre = `<pre class="chat-code">${esc(code)}</pre>`;
    return codeTools ? `<div class="chat-code-box">${pre}${codeTools(langs[i - 1] ?? '', i < parts.length - 1, code)}</div>` : pre;
  }).join('');
}

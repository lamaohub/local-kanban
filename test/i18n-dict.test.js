// duplicate, so the test reads the literal from the source: every key at the top level of I18N_RU, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const START = 'const I18N_RU = ';

/** The literal of the dictionary: from its `{` to the `}` that closes it. */
function dictLiteral(src) {
  const at = src.indexOf(START);
  assert.ok(at >= 0, 'I18N_RU is not where the test looks for it');
  const open = at + START.length;
  const end = src.indexOf('\n};', open);
  return { text: src.slice(open, end + 2), line: src.slice(0, open).split('\n').length };
}

/** The keys declared at the top level of an object literal, each with its line, in the order written. */
function declaredKeys(text, firstLine = 1) {
  const keys = [];
  let depth = 0;
  let i = 0;
  let last = null; // the last key-like token at depth 1: [value, line]
  const lineAt = (p) => firstLine + text.slice(0, p).split('\n').length - 1;
  while (i < text.length) {
    const c = text[i];
    if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const raw = text.slice(i, j + 1);
      last = depth === 1 ? [new Function(`return ${raw}`)(), lineAt(i)] : null;
      i = j + 1;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      last = depth === 1 ? [text.slice(i, j), lineAt(i)] : null;
      i = j;
      continue;
    }
    if (c === ':' && last) keys.push({ key: last[0], line: last[1] });
    if ('{[('.includes(c)) depth += 1;
    if ('}])'.includes(c)) depth -= 1;
    if (!/\s/.test(c)) last = null;
    i += 1;
  }
  return keys;
}

test('every key of the Russian dictionary is declared once', () => {
  const { text, line } = dictLiteral(core);
  const keys = declaredKeys(text, line);
  const seen = new Map();
  for (const k of keys) seen.set(k.key, [...(seen.get(k.key) || []), k.line]);
  const twice = [...seen].filter(([, lines]) => lines.length > 1).map(([key, lines]) => `${JSON.stringify(key)} on lines ${lines.join(', ')}`);
  assert.deepEqual(twice, [], 'a key declared again overwrites the earlier translation without a word');
});

test('the reading of the dictionary sees every key the object has', () => {
  // without this, a reader that stopped half-way would find no duplicates in the half it read
  const { text, line } = dictLiteral(core);
  const declared = new Set(declaredKeys(text, line).map((k) => k.key));
  const actual = Object.keys(new Function(`return (${text})`)());
  assert.ok(actual.length > 500, `the dictionary has ${actual.length} keys`);
  assert.deepEqual([...declared].sort(), [...actual].sort());
});

test('the reading tells a repeated key from a value, a comment and a nested object', () => {
  const sample = `{
  'Archive': 'one', // 'Archive': 'in a comment'
  Archive: 'two',
  /* 'Hidden': 'x', */
  'a: b': 'value: with a colon',
  'Nested': { 'Archive': 'inner' },
  "esc\\u0061ped": 'x', 'escaped': 'y',
}`;
  assert.deepEqual(declaredKeys(sample).map((k) => [k.key, k.line]),
    [['Archive', 2], ['Archive', 3], ['a: b', 5], ['Nested', 6], ['escaped', 7], ['escaped', 7]]);
});

test('the meanings that used to collide keep their own keys', () => {
  const dict = new Function(`return (${dictLiteral(core).text})`)();
  // the button and the confirmation that archive a project, and the section that lists the archived ones
  assert.notEqual(dict.Archive, dict.Archived);
  // a badge of a change waiting to be sent, and a save that failed without a reason of its own
  assert.notEqual(dict['not saved'], dict['did not save']);
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /\['archive', tr\('Archived'\)\]/, 'the settings section is named by the noun');
  assert.match(settings, /class="sm-h">\$\{tr\('Archived'\)\}/, 'the heading of the section is the noun too');
  const project = readFileSync(new URL('../public/js/project.js', import.meta.url), 'utf8');
  assert.match(project, /id="ps-archive"[^\n]*\$\{tr\('Archive'\)\}/, 'the button that archives a project is the verb');
  // the confirmations that archive a project: its settings and the window of a project whose folder is gone
  const sidebar = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
  for (const [file, src] of [['project.js', project], ['sidebar.js', sidebar]]) {
    const oks = [...src.matchAll(/Archive[^\n]*okLabel: tr\('(\w+)'\)/g)].map((m) => m[1]);
    assert.ok(oks.length, `${file}: the confirmation that archives a project is not where the test looks for it`);
    assert.deepEqual(oks, oks.map(() => 'Archive'), `${file}: the button that confirms archiving is the verb`);
  }
});

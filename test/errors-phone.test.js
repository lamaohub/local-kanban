import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel, from = css) => {
  const m = from.match(new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${sel} has no rule`);
  return m[1];
};

test('on a phone a row of the journal is two lines: time and source, then the message across the whole width', () => {
  const at = css.indexOf('@media (max-width: 640px) {\n  .err-row');
  assert.ok(at >= 0, 'no phone layout of the journal: the mark runs past the window at 390');
  const phone = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(rule('.err-row', phone), /grid-template-columns:\s*auto 1fr/);
  assert.match(rule('.err-row > .err-msg', phone), /grid-column:\s*1 \/ -1/, 'the message stays in a narrow column');
  assert.match(rule('.err-fixed-tag', phone), /display:\s*block/, 'the mark does not take a line of its own');
});

test('the mark «recovered on retry» never runs out of its column, at any width', () => {
  const tag = rule('.err-fixed-tag');
  assert.doesNotMatch(tag, /white-space:\s*nowrap/, 'a mark that never wraps runs past the window between 641 and 655 px');
  assert.match(tag, /display:\s*inline-block/, 'the mark breaks after any word of it instead of going whole to the next line');
  assert.match(rule('.err-row > span'), /min-width:\s*0;\s*overflow-wrap:\s*anywhere/, 'a message without spaces widens its column');
});

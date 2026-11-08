// run kept its words at calc(100% - 20px) whole, and «+62 −0 ✗ 2 ›» after them stood ~65px past the chat: the list of the
// column scrolled sideways, and the reader saw its lines cut at the left. Measured in Chromium and WebKit at 200–500px: the
// times give way first, then the words wrap; nothing of the line stands past it. The rules that hold that:
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at >= 0, `no rule ${sel}`);
  return css.slice(at, css.indexOf('}', at));
};

test('the words of a folded run shrink; the times give way first; the tail never shrinks', () => {
  assert.doesNotMatch(css, /\.chat-run:has\(> \.chat-run-times\) > \.chat-run-t \{[^}]*flex: none/, 'the words hold their width whole again');
  assert.match(rule('.chat-run-t'), /flex: 0 1 auto;[^}]*min-width: 0/);
  const shrink = Number(/flex: 0 (\d+) auto/.exec(rule('.chat-run-times'))?.[1]);
  assert.ok(shrink >= 1e6, `the times shrink ×${shrink} — a pixel off the words wraps them before the times are gone`);
  assert.match(rule('.chat-run .chat-x'), /flex: none/);
  assert.match(css, /\.chat-run \.chat-add, \.chat-run \.chat-del \{ flex: none; \}/);
});

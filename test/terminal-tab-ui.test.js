import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const init = readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8');

test('the send button of the Terminal tab is grey like the keys, not the accent', () => {
  const btn = /<button[^>]*id="term-send"[^>]*>/.exec(html)?.[0];
  assert.ok(btn, 'the send button of the Terminal tab is gone');
  assert.match(btn, /class="[^"]*\bbtn-ghost\b/, 'the send button lost the grey look of the keys');
  assert.doesNotMatch(btn, /\bbtn-primary\b/, 'the send button is the accent again');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /\.term-send\b/.test(sel));
  assert.ok(rules.length, 'no rule draws the send button');
  for (const [, sel, body] of rules) assert.doesNotMatch(body, /var\(--accent\)/, `${sel.trim()} paints the send button in the accent`);
  assert.ok(rules.some(([sel]) => /:hover/.test(sel)), 'the send button does not answer the mouse');
});

test('the comment form has no button that sends the comment to the terminal', () => {
  const form = html.slice(html.indexOf('<div class="comment-form">'), html.indexOf('</div>', html.indexOf('<div class="comment-form">')));
  assert.ok(form.includes('id="c-send"'), 'the comment form is gone');
  const buttons = (form.match(/<button\b[^>]*>/g) || []).filter((b) => !/\bid="c-attach"/.test(b));
  assert.equal(buttons.length, 1, 'the comment form has a second button again');
  assert.match(form, /id="c-attach"/, 'the comment form lost its clip — a phone cannot attach a picture then');
  for (const src of [drawer, init]) assert.doesNotMatch(src, /terminal\/message/, 'the page sends comments to the terminal again');
});

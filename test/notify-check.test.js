// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
function take(head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from settings.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}
const notifyPerm = src.slice(src.indexOf('const notifyPerm = '), src.indexOf('\n', src.indexOf('const notifyPerm = ')) + 1);

function page({ perm, asked = 'granted', on = false, shows = true, throws = false }) {
  const made = [];
  class Notification {
    static permission = perm;
    static async requestPermission() { Notification.permission = asked; return asked; }
    constructor(title, opts) {
      if (throws) throw new TypeError('Illegal constructor');
      made.push({ title, ...opts });
      this.fire = () => (shows ? this.onshow?.() : this.onerror?.());
    }
    close() {}
  }
  const box = { tr: (s) => s, LANG: 'en', getSetting: (k) => (k === 'notifyReview' ? on : undefined), window: { focus() {} }, made };
  if (perm !== 'unsupported') box.Notification = Notification;
  vm.runInNewContext(`${take('export function notifyTestState(')}\n${notifyPerm}\n${take('export async function sendTestNotification(')}\nthis.state = notifyTestState; this.send = sendTestNotification; this.perm = notifyPerm;`, box);
  return box;
}

test('the row says what the page knows: no notifications here, blocked, not asked, allowed and on or off', () => {
  const { state } = page({ perm: 'granted' });
  assert.match(state('unsupported', true), /cannot show/);
  assert.match(state('denied', true), /blocked by the browser/);
  assert.match(state('default', true), /not been asked/);
  assert.equal(state('granted', true), 'allowed by the browser and on');
  assert.match(state('granted', false), /off on the board/);
  assert.equal(page({ perm: 'unsupported' }).perm(), 'unsupported', 'a browser without Notification reads as allowed or blocked');
});

test('the test sends one notification and says the system showed it — and that the board switch is off', async () => {
  const p = page({ perm: 'granted', on: false });
  const el = { textContent: '' };
  assert.equal(await p.send(el), true);
  assert.equal(p.made.length, 1, 'no test notification was made');
  assert.equal(p.made[0].title, 'Test notification');
  assert.match(p.made[0].tag, /^kb-test-\d+$/, 'a repeat test shares its tag and is replaced with no banner');
  assert.match(el.textContent, /^sent at \d\d:\d\d:\d\d — did it show up/);
  assert.match(el.textContent, /off on the board/, 'the switch being off is not said');
});

test('the test asks the browser first when it was never asked, and stops at a refusal', async () => {
  const asked = page({ perm: 'default', asked: 'granted', on: true });
  const el = { textContent: '' };
  assert.equal(await asked.send(el), true);
  assert.equal(asked.made.length, 1, 'a granted request sent nothing');
  assert.doesNotMatch(el.textContent, /off on the board/, 'the switch is on, yet the line says it is off');
  const refused = page({ perm: 'default', asked: 'denied' });
  const el2 = { textContent: '' };
  assert.equal(await refused.send(el2), false);
  assert.equal(refused.made.length, 0, 'a notification was made after the browser refused');
  assert.match(el2.textContent, /blocked by the browser/);
  const none = page({ perm: 'unsupported' });
  const el3 = { textContent: '' };
  assert.equal(await none.send(el3), false);
  assert.match(el3.textContent, /cannot show/);
});

test('the line follows what the system does with it, and a browser that will not create one is said so', async () => {
  for (const [shows, re] of [[true, /the browser handed it to the system ✓/], [false, /would not show it/]]) {
    const el = { textContent: '' };
    let made;
    const p = page({ perm: 'granted', on: true, shows });
    const real = p.Notification;
    p.Notification = class extends real { constructor(t, o) { super(t, o); made = this; } };
    await p.send(el);
    made.fire();
    assert.match(el.textContent, re);
  }
  const el = { textContent: '' };
  assert.equal(await page({ perm: 'granted', throws: true }).send(el), false);
  assert.match(el.textContent, /would not create a notification/);
});

test('General has the row under the switch, and every word of it is in Russian', () => {
  assert.match(src, /data-set="notifyReview"><\/label>`\n(\s*\/\/[^\n]*\n)?\s*\+ `<div class="set-row"><span class="set-lab">\$\{tr\('Check notifications'\)\}<small id="notif-state"><\/small><\/span><button class="btn-ghost" id="notif-test">/);
  assert.match(src, /\$\('notif-test'\)\.onclick = \(\) => sendTestNotification\(\$\('notif-state'\)\);/);
  const words = [...take('export function notifyTestState(').matchAll(/tr\('([^']+)'\)/g), ...take('export async function sendTestNotification(').matchAll(/tr\('([^']+)'\)/g)].map((m) => m[1])
    .concat(['System notifications', 'when a task reaches Review, Claude waits for you or asks a question', 'Check notifications', 'Send a test']);
  for (const w of words) assert.ok(core.includes(`  '${w}': '`), `no Russian for «${w}»`);
});

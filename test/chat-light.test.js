// The light of a chat whose Claude works or waits for its helpers (public/js/chat.js, mountChat), run on a stand-in page
// with a little layout: the list of the chat is as tall as the box leaves it after the note and the field under it.
// - the light «Claude works in the background…» stands over the field while Claude waits for its helpers, the helpers
// - the chat is asked again while helpers run (their transcripts ring no event), and not while nothing runs;
// - read at its end, the chat ends at the bottom edge of its list once the note and the field are drawn — set before
//   them, the end (and the light with it) went under the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { intoField, leftoverWords } from '../public/js/ask-rules.js';

const BOX_H = 600;
const NOTE_H = 40;
const FORM_H = 50;
const LINE_H = 24;

function el(page, cls) {
  const n = {
    cls, page, hidden: false, dataset: {}, value: '', onclick: null, onkeydown: null, oninput: null, style: {},
    classes: new Set(), _html: '', _text: '', _top: 0, parts: new Map(),
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (this.cls === 'chat-log') this._top = 0; }, // WebKit: content put anew scrolls to its top
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); for (const f of this.heard || []) f(); },
    // a line per tag of the list: what the chat drew is as tall as it is long
    get scrollHeight() { return this.cls === 'chat-log' ? Math.max(this.clientHeight, (this._html.match(/<div /g) || []).length * LINE_H) : 0; },
    get clientHeight() {
      if (this.cls !== 'chat-log') return 0;
      const shown = (c) => !page.parts.get(c).classes.has('hidden');
      return BOX_H - (shown('chat-note') && page.parts.get('chat-note')._text ? NOTE_H : 0) - (shown('chat-form') ? FORM_H : 0);
    },
    getClientRects: () => [],
    addEventListener(type, f) { if (type === 'scroll') (this.heard ||= []).push(f); },
    removeEventListener(type, f) { this.heard = (this.heard || []).filter((x) => x !== f); },
    querySelector(sel) {
      const c = sel.replace(/^\./, '');
      if (this === page.root) {
        if (!page.parts.has(c)) page.parts.set(c, el(page, c));
        return page.parts.get(c);
      }
      if (c === 'textarea' || c === 'chat-send' || c === 'chat-attach' || c === 'chat-stop' || c === 'input[type=file]') {
        if (!this.parts.has(c)) this.parts.set(c, el(page, c));
        return this.parts.get(c);
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  n.classList = {
    toggle(c, on) { if (on === undefined ? !n.classes.has(c) : on) n.classes.add(c); else n.classes.delete(c); },
    add(c) { n.classes.add(c); },
    remove(c) { n.classes.delete(c); },
    contains(c) { return n.classes.has(c); },
  };
  return n;
}

function chatOn(answer) {
  const page = { parts: new Map(), timers: [], asked: 0 };
  page.root = el(page, 'root');
  const source = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const ctx = {
    api: async () => { page.asked++; return answer(page.asked); },
    esc: (s) => String(s).replace(/</g, '&lt;'), tr: (s) => s, ic: () => '', seg: (s) => s, plural: (n, a, b) => (n === 1 ? a : b),
    refusalLine: () => '', wireTermImages: () => {}, chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], matchKey: () => false, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x).replace(/\s*\(recommended\)\s*$/i, ''),
    document: { addEventListener() {}, hidden: false }, URLSearchParams, intoField, leftoverWords,
    setTimeout: (fn, ms) => { page.timers.push({ fn, ms }); return page.timers.length; }, clearTimeout: () => {},
  };
  vm.runInNewContext(`${source}\nthis.mountChat = mountChat;`, ctx);
  const chat = ctx.mountChat(page.root, { key: 'H-1' });
  return { page, chat, log: page.parts.get('chat-log'), live: page.parts.get('chat-live') };
}

const settle = () => new Promise((r) => setImmediate(r));
const step = (text, more = {}) => ({ kind: 'tool', tool: 'Bash', text, ms: 1000, error: false, ...more });
const turns = (n) => Array.from({ length: n }, (_, i) => ({ at: `t${i}`, user: `turn ${i}`, items: [{ kind: 'text', text: `done ${i}` }], ms: 3000, open: false }));
const helperTurn = { at: 'h', user: 'check the batch', items: [step('Check the site tasks', { tool: 'Agent', running: true, ms: undefined, helper: { steps: 4, now: { tool: 'Read', text: 'a.md' } } }), { kind: 'text', text: 'Waiting for the helper.' }], ms: 4000, open: false };
const answer = (over) => ({ session: 's', sessions: [{ session_id: 's', last_seen: 'x' }], turns: [...turns(40), helperTurn], earlier_n: 0, queue: [], send: false, state: null, working: true, v: 'v1', ...over });

test('a Claude waiting for its helpers: the light and the helpers stand over the field, and the chat is asked again', async () => {
  const { page, log, live } = chatOn(() => answer());
  await settle();
  assert.match(live.innerHTML, /Check the site tasks[^]*<div class="chat-working">[^]*Claude works in the background… · helpers at work: 1<\/span><\/div>$/, 'the chat of a Claude waiting for its helpers is not lit over its field');
  assert.doesNotMatch(log.innerHTML, /chat-working|chat-step/, 'the light or a running helper is left at the end of the chat');
  const again = page.timers.filter((t) => t.ms === 5000);
  assert.ok(again.length, 'nobody asks the chat again while helpers run — their steps never move on screen');
  const before = page.asked;
  again.at(-1).fn();
  await settle();
  assert.equal(page.asked, before + 1);
});

// is at rest a moment later, and the chat said «Claude works in the background…» under «Stopped» for good
test('a lit chat with no helpers is asked again too, and the light goes once Claude is at rest', async () => {
  const stopped = { at: 's', user: 'do it', items: [step('ls'), { kind: 'stop' }], ms: null, open: false };
  // the second look finds nothing changed (`same`) — the chat must go on asking all the same
  const { page, live } = chatOn((n) => (n === 2 ? { same: true, v: 'v1' }
    : answer({ turns: [...turns(3), stopped], working: n === 1, send: true, state: n === 1 ? 'busy' : 'idle', v: `v${n}` })));
  await settle();
  assert.match(live.innerHTML, /chat-working/, 'the stand-in Claude is not lit');
  for (const look of ['first', 'second']) {
    const again = page.timers.filter((t) => t.ms === 5000);
    assert.ok(again.length, `a lit chat is not asked again after its ${look} look: the light outlives the work`);
    page.timers.length = 0;
    again.at(-1).fn();
    await settle();
  }
  assert.equal(page.asked, 3);
  assert.doesNotMatch(live.innerHTML, /chat-working/, 'Claude at rest is still lit');
});

test('a lit chat whose look failed asks again all the same', async () => {
  const { page, live } = chatOn((n) => {
    if (n === 2) throw Object.assign(new Error('offline'), { offline: true });
    return answer({ turns: turns(3), working: n === 1, send: true, state: n === 1 ? 'busy' : 'idle', v: `v${n}` });
  });
  await settle();
  for (const look of ['first', 'failed']) {
    const again = page.timers.filter((t) => t.ms === 5000);
    assert.ok(again.length, `a lit chat is not asked again after its ${look} look`);
    page.timers.length = 0;
    again.at(-1).fn();
    await settle();
  }
  assert.equal(page.asked, 3);
  assert.doesNotMatch(live.innerHTML, /chat-working/, 'Claude at rest is still lit after one failed look');
});

test('a Claude at rest is not lit and its chat is not asked again on a timer', async () => {
  const { page, live } = chatOn(() => answer({ working: false, turns: turns(5) }));
  await settle();
  assert.doesNotMatch(live.innerHTML, /chat-working/);
  assert.equal(page.timers.filter((t) => t.ms === 5000).length, 0);
});

test('read at its end, the chat ends at the bottom edge of its list once the note and the field are drawn', async () => {
  for (const send of [false, true]) {
    const { log, page } = chatOn(() => answer({ send, state: send ? 'busy' : null }));
    await settle();
    assert.ok(log.scrollHeight > log.clientHeight, 'the stand-in chat is not long enough to scroll');
    const shown = !page.parts.get('chat-note').classes.has('hidden') || !page.parts.get('chat-form').classes.has('hidden');
    assert.ok(shown, 'neither the note nor the field is under the chat');
    assert.equal(log.scrollHeight - log.scrollTop - log.clientHeight, 0, `the end of the chat (send: ${send}) is under the note or the field`);
  }
});

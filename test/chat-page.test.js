// The chat on the page (public/js/chat.js), run against a small stand-in for the page — what the person sees, not a
// line of the source:
// - opening or closing "N steps" keeps the reader where they were. WebKit drops the scroll of a list whose content is
//   put anew, so the chat's own list (a column of Terminals) flew to its first words on every click: the chat must put
//   the scroll back from what it was BEFORE it redrew the list. The stand-in's list forgets its scroll on every redraw;
// - under the chat of a busy Claude there is no line saying so (the owner: "remove this line") — the light says it, and
//   words that wait say it under themselves; a question still has its line;
// - the chat of a Claude the board did not start is only read: no field to type into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { intoField, leftoverWords } from '../public/js/ask-rules.js';

const CLIENT_H = 300;
const ROW_H = 30;

class El {
  constructor(cls, { forgets = false } = {}) {
    this.cls = cls; this.forgets = forgets; this.html = ''; this.top = 0; this.textContent = ''; this.value = '';
    this.style = {}; this.dataset = {}; this.kids = {}; this.folds = [];
    const set = new Set();
    this.classList = {
      toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c); return on; },
      add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    };
  }
  set innerHTML(h) {
    this.html = h;
    this.folds = [...h.matchAll(/data-fold="([^"]+)"/g)].map((m) => Object.assign(new El('chat-fold'), { dataset: { fold: m[1] } }));
    this.bodies = [...h.matchAll(/class="[^"]*chat-unfold[^"]*" data-of="([^"]+)"/g)].map((m) => {
      const b = Object.assign(new El('chat-unfold'), { dataset: { of: m[1] } });
      if (El.animates) b.animate = (frames) => { const a = { frames, el: b }; a.finished = new Promise((r) => { a.end = r; }); El.animations.push(a); return a; };
      return b;
    });
    if (this.forgets) this.top = 0; // WebKit: a list whose content is put anew is back at its top
    this.top = Math.min(this.top, Math.max(0, this.scrollHeight - this.clientHeight));
  }
  get innerHTML() { return this.html; }
  get scrollHeight() { return Math.max(CLIENT_H, (this.html.match(/class="chat-/g) || []).length * ROW_H); }
  get clientHeight() { return this.ch ?? CLIENT_H; } // `ch`: the field grew over the list
  get scrollTop() { return this.top; }
  // the reader's scroll (and the chat's own) rings the list's listeners, as a browser does
  set scrollTop(v) { this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); for (const f of this.heard || []) f(); }
  querySelector(sel) { return this.kids[sel] || null; }
  querySelectorAll(sel) {
    if (sel === '.chat-thumb img') return [...this.html.matchAll(/<img src="([^"]*)"/g)].map((m) => Object.assign(new El('img'), { src: m[1] }));
    return sel === '[data-fold]' ? this.folds : sel === '.chat-unfold' ? this.bodies : [];
  }
  addEventListener(type, f) { if (type === 'scroll') (this.heard ||= []).push(f); }
  removeEventListener(type, f) { this.heard = (this.heard || []).filter((x) => x !== f); }
  getClientRects() { return []; }
}

function chatModule(api, extra = {}) {
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), seg: (x) => x,
    refusalLine: () => '', wireTermImages: () => {}, chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], api, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x).replace(/\s*\(recommended\)\s*$/i, ''),
    document: { hidden: false, addEventListener: () => {} }, setTimeout, clearTimeout, URLSearchParams, intoField, leftoverWords, ...extra,
  };
  vm.runInNewContext(`${src}\nthis.mountChat = mountChat;`, box);
  return box.mountChat;
}

function page(forgets = false) {
  const parts = {};
  for (const c of ['chat-ask', 'chat-top', 'chat-log', 'chat-queue', 'chat-live', 'chat-note', 'chat-form', 'chat-imgs']) {
    parts[`.${c}`] = new El(c, { forgets: forgets && c === 'chat-log' });
  }
  parts['.chat-form'].kids = { textarea: new El('textarea'), '.chat-send': new El('chat-send'), '.chat-attach': new El('chat-attach'), '.chat-stop': new El('chat-stop'), 'input[type=file]': new El('file') };
  parts['.chat-ask'].kids = { '.chat-ask-scr': new El('chat-ask-scr') };
  const box = new El('box');
  box.kids = parts;
  return { box, log: parts['.chat-log'], note: parts['.chat-note'], form: parts['.chat-form'], queue: parts['.chat-queue'], imgs: parts['.chat-imgs'] };
}

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const step = (i) => ({ kind: 'tool', tool: 'Bash', text: `step ${i}`, ms: 1000, error: false });
const turns = Array.from({ length: 10 }, (_, k) => ({
  at: `2026-10-22T10:${String(k).padStart(2, '0')}:00Z`, user: `turn ${k}`, open: false, ms: 60000,
  items: [{ kind: 'text', text: 'Starting.' }, ...Array.from({ length: 6 }, (_, i) => step(i)), { kind: 'text', text: 'Done.' }],
}));
const answer = { session: SID, sessions: [{ session_id: SID, last_seen: '2026-10-22 10:00:00' }], turns, earlier_n: 0, queue: [], send: false, state: null, working: false, v: 'v1' };

async function chatWith(data, forgets = false) {
  const mountChat = chatModule(async () => structuredClone(data));
  const p = page(forgets);
  const c = mountChat(p.box, { key: 'CH-1' });
  await c.flight;
  return { c, ...p };
}

for (const engine of ['a list that forgets its scroll on a redraw (WebKit)', 'a list that keeps it (Chromium)']) {
  test(`a fold opened and closed keeps the chat where it was — ${engine}`, async () => {
    const { c, log } = await chatWith(answer, engine.includes('WebKit'));
    assert.ok(log.folds.length >= 5, 'the chat drew no folds to click');
    log.scrollTop = 600;
    assert.equal(log.scrollTop, 600);
    const fold = log.folds[4].dataset.fold;
    for (const click of ['open', 'close']) {
      const before = log.scrollHeight;
      log.folds.find((b) => b.dataset.fold === fold).onclick();
      assert.notEqual(log.scrollHeight, before, `the click did not ${click} the fold`);
      assert.equal(log.scrollTop, 600, `a fold ${click === 'open' ? 'opened' : 'closed'} moved the chat (to ${log.scrollTop})`);
    }
    c.destroy();
  });
}

// not the small copy the thumbnail shows
test('a picture put into a message opens whole from its thumbnail', async () => {
  const opened = [];
  const p = page();
  const c = chatModule(async () => structuredClone({ ...answer, send: true, state: 'idle' }), {
    URL: { createObjectURL: (f) => `blob:${f.name}`, revokeObjectURL: () => {} },
    uploadAttachment: async () => ({ id: 7 }),
    openLightbox: (url) => opened.push(url),
  })(p.box, { key: 'CH-1' });
  await c.flight;
  const picker = p.form.kids['input[type=file]'];
  picker.files = [{ type: 'image/png', name: 'shot.png' }];
  picker.onchange();
  for (let i = 0; i < 5; i++) await null;
  const thumbs = p.imgs.querySelectorAll('.chat-thumb img');
  assert.equal(thumbs.length, 1, 'no thumbnail over the field');
  // the stand-in draws again from what the chat wrote: wire the clicks as the chat does, on its own elements
  p.imgs.querySelectorAll = (sel) => (sel === '.chat-thumb' ? thumbs.map((img) => ({ querySelector: () => img })) : []);
  p.imgs.dataset.sig = '';
  c.paintImages();
  assert.equal(typeof thumbs[0].onclick, 'function', 'a thumbnail opens nothing on a click');
  thumbs[0].onclick();
  assert.deepEqual(opened, ['blob:shot.png'], 'the click did not open the picture itself');
  c.destroy();
});

// chat is drawn without it; one who asked the system for less motion gets it shown at once
test('a fold opens and closes smoothly, and at once for less motion', async () => {
  let still = false; // prefers-reduced-motion: reduce
  const p = page();
  const c = chatModule(async () => structuredClone(answer), { matchMedia: () => ({ matches: still }) })(p.box, { key: 'CH-1' });
  await c.flight;
  const { log } = p;
  El.animates = true;
  El.animations = [];
  try {
    const fold = log.folds[2].dataset.fold;
    const click = () => log.folds.find((b) => b.dataset.fold === fold).onclick();
    const body = () => log.bodies.find((b) => b.dataset.of === fold);
    click();
    assert.ok(body(), 'the fold did not open');
    assert.equal(El.animations.length, 1, 'the fold opened without moving');
    assert.equal(El.animations[0].frames[0].height, '0px', 'the fold does not open from no height');
    click();
    assert.equal(El.animations.length, 2, 'the fold closed without moving');
    assert.equal(El.animations[1].frames.at(-1).height, '0px');
    assert.ok(body(), 'the fold was taken away before it closed');
    click(); // a second click while it closes changes nothing
    assert.equal(El.animations.length, 2);
    El.animations[1].end();
    await null; await null;
    assert.ok(!body(), 'the fold did not close once its closing was over');
    still = true;
    click();
    assert.ok(body(), 'the fold did not open for less motion');
    assert.equal(El.animations.length, 2, 'a fold moved for one who asked for less motion');
  } finally { El.animates = false; c.destroy(); }
});

// the end — whether the reader is at the end is measured at the repaint no more; it is kept from their own scrolling
test('a reader at the end stays at the end when the field grew over the chat; one who scrolled up is not pulled down', async () => {
  let data = { ...answer, send: true, state: 'idle' };
  const p = page();
  const c = chatModule(async () => structuredClone(data))(p.box, { key: 'CH-1' });
  await c.flight;
  const { log } = p;
  const end = () => log.scrollHeight - log.clientHeight;
  assert.equal(log.scrollTop, end(), 'the chat did not open at its end');
  log.ch = CLIENT_H - 150; // a long message in the field: 150px of the list under it, and the reader did not scroll
  const more = (k) => ({ ...turns[0], at: `2026-10-22T11:0${k}:00Z`, user: `new words ${k}` });
  data = { ...data, turns: [...data.turns, more(1)], v: 'v2' };
  c.v = null;
  await c.refresh();
  assert.equal(log.scrollTop, end(), `the next words landed under the edge: ${end() - log.scrollTop}px under it`);
  log.scrollTop = 100;
  data = { ...data, turns: [...data.turns, more(2)], v: 'v3' };
  c.v = null;
  await c.refresh();
  assert.notEqual(log.scrollTop, end(), 'new words pulled a reader who had scrolled up to the end');
  assert.equal(log.scrollTop, 100, 'words added below carried what the reader read up, off the screen');
  c.destroy();
});

test('a busy Claude has no line under its chat; words that wait say it themselves; a question keeps its line', async () => {
  const busy = { ...answer, send: true, state: 'busy', working: true, queue: [{ id: 'q1', text: 'next words', at: '2026-10-22T10:20:00.000Z' }] };
  let r = await chatWith(busy);
  assert.equal(r.note.textContent, '', `a line under the chat of a busy Claude: "${r.note.textContent}"`);
  assert.ok(r.note.classList.contains('hidden'));
  assert.match(r.queue.innerHTML, /waits until Claude is free: 1[\s\S]*class="chat-q-row" title="next words"/, 'waiting words do not say they wait');
  r.c.destroy();
  r = await chatWith({ ...busy, state: 'question', question: 'Do you want to proceed?\n❯ 1. Yes\nEsc to cancel', queue: [] });
  assert.notEqual(r.note.textContent, '', 'an open question lost its line under the chat');
  r.c.destroy();
});

test('the chat of a Claude the board did not start is only read: no field, and it says why', async () => {
  const r = await chatWith({ ...answer, send: false });
  assert.ok(r.form.classList.contains('hidden'), 'a read-only chat offers a field to type into');
  assert.match(r.note.textContent, /can only be read/);
  r.c.destroy();
  const own = await chatWith({ ...answer, send: true, state: 'idle' });
  assert.ok(!own.form.classList.contains('hidden'), 'the chat of the board\'s own Claude has no field');
  own.c.destroy();
});

test('a refusal of the board (the queue is full) stays under the chat after the repaint its 409 asks for', async () => {
  const busy = { ...answer, send: true, state: 'busy', working: true };
  const api = async (method) => {
    if (method === 'POST') throw Object.assign(new Error('too many messages wait for this Claude already'), { status: 409 });
    return structuredClone(busy);
  };
  const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-1' });
  await c.flight;
  const field = p.form.kids.textarea;
  field.value = 'the 21st';
  await p.form.kids['.chat-send'].onclick();
  await c.flight;
  assert.match(p.note.textContent, /Not sent: too many messages/, `the refusal went with the repaint: "${p.note.textContent}"`);
  assert.equal(field.value, 'the 21st', 'the refused words left the field');
  field.oninput();
  await c.refresh();
  assert.equal(p.note.textContent, '', 'the refusal outlived the person editing the words');
  c.destroy();
});

test('a chat whose first load failed says so and asks again, instead of «Loading…» for good', async () => {
  let fail = true;
  const api = async () => { if (fail) throw Object.assign(new Error('Failed to fetch'), { offline: true }); return structuredClone(answer); };
  const timers = [];
  const mountChat = chatModule(api, {
    refusalLine: (head) => `${head}: no connection`,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-1' });
  await c.flight;
  assert.match(p.log.innerHTML, /Could not load the chat: no connection/, `a failed chat says: ${p.log.innerHTML}`);
  const again = timers.find((t) => t.ms === 5000);
  assert.ok(again, 'a failed chat is never asked again');
  fail = false;
  again.fn();
  await c.flight;
  assert.match(p.log.innerHTML, /turn 9/, 'the chat asked again did not come');
  c.destroy();
});

// typed them, and the chat looked as if nothing went. They show at once, as a bubble that says they go, until the
// transcript has them; refused, they are back in the field
test('words sent show at once as going, and the bubble goes when the transcript has them', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  let reply;
  let data = structuredClone(own);
  const api = async (method) => {
    if (method === 'POST') return new Promise((r) => { reply = r; });
    return structuredClone(data);
  };
  const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-1' });
  await c.flight;
  const field = p.form.kids.textarea;
  field.value = 'look at the header';
  const going = p.form.kids['.chat-send'].onclick();
  assert.equal(field.value, '', 'the words stay in the field while the board types them');
  assert.match(p.log.innerHTML, /chat-sending[\s\S]*look at the header[\s\S]*sending…/, 'the words sent do not show until the transcript has them');
  await new Promise((r) => setImmediate(r));
  reply({ sent: true });
  await going;
  await c.flight;
  assert.match(p.log.innerHTML, /look at the header[\s\S]*sending…/, 'the bubble went before the transcript had the words');
  data = { ...own, v: 'v2', turns: [...own.turns, { at: '2026-10-22T11:00:00Z', user: '[Image #1]look at the header', open: true, items: [] }] };
  c.v = null;
  await c.refresh();
  assert.doesNotMatch(p.log.innerHTML, /sending…/, 'the bubble stayed beside the words in the transcript');
  assert.match(p.log.innerHTML, /\[Image #1\]look at the header/);
  c.destroy();
});

// bubble said «sending…» for a minute and went, and the owner sent the same words again. Claude Code holds them — the
// chat says Claude reads them after its step, for as long as it holds them, and in the transcript's place when it takes them
test('words Claude Code holds in its queue wait under their own words past a minute, and go when Claude takes them', async () => {
  const own = { ...answer, send: true, state: 'busy', working: true, waiting: [] };
  let data = structuredClone(own);
  const api = async (method) => (method === 'POST' ? { sent: true, now: true } : structuredClone(data));
  const mountChat = chatModule(api);
  const p = page();
  const c = mountChat(p.box, { key: 'CH-9' });
  await c.flight;
  p.form.kids.textarea.value = 'the shop id — this one?';
  await p.form.kids['.chat-send'].onclick();
  await c.flight;
  data = { ...own, v: 'v2', waiting: [{ text: 'the shop id — this one?', at: '2026-10-28T18:16:14.143Z' }] };
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5 * 60_000; // five minutes of a command running
    c.v = null;
    await c.refresh();
    assert.match(p.log.innerHTML, /chat-queued[\s\S]*the shop id — this one\?[\s\S]*Claude reads it when the step it is on ends/,
      'the words Claude Code holds went from the chat, as if never sent');
    assert.doesNotMatch(p.log.innerHTML, /sending…/, 'the same words twice: going and waiting');
    assert.equal((p.log.innerHTML.match(/the shop id/g) || []).length, 1);
    data = { ...own, v: 'v3', turns: [{ ...own.turns.at(-1), items: [...own.turns.at(-1).items, { at: '2026-10-28T18:16:14.110Z', kind: 'said', text: 'the shop id — this one?' }] }] };
    c.v = null;
    await c.refresh();
    assert.doesNotMatch(p.log.innerHTML, /Claude reads it|sending…/, 'taken by Claude, the words still wait');
  } finally { Date.now = realNow; }
  // put back into Claude Code's field (or Claude stopped): out of its queue untaken, nothing sends them — no «sending…»
  p.form.kids.textarea.value = 'one more thing';
  await p.form.kids['.chat-send'].onclick();
  await c.flight;
  data = { ...data, v: 'v4', waiting: [{ text: 'one more thing', at: '2026-10-28T18:20:00.000Z' }] };
  c.v = null;
  await c.refresh();
  assert.match(p.log.innerHTML, /one more thing[\s\S]*Claude reads it/);
  data = { ...data, v: 'v5', waiting: [] };
  c.v = null;
  await c.refresh();
  assert.doesNotMatch(p.log.innerHTML, /one more thing/, 'words gone back to the field still said they were going');
  c.destroy();
});

test('refused words come back to the field and their bubble goes', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  const api = async (method) => {
    if (method === 'POST') throw Object.assign(new Error('the words did not show'), { status: 409 });
    return structuredClone(own);
  };
  const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-2' });
  await c.flight;
  const field = p.form.kids.textarea;
  field.value = 'once more';
  await p.form.kids['.chat-send'].onclick();
  await c.flight;
  assert.equal(field.value, 'once more');
  assert.doesNotMatch(p.log.innerHTML, /sending…/, 'a refused message still says it goes');
  c.destroy();
});

// a dark square for seconds. It is drawn from the file at once, marked as going; a message sent meanwhile waits for it
test('a picture shows at once from its file, and a message sent while it uploads carries it', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  let uploaded;
  const posts = [];
  const api = async (method, url, body) => { if (method === 'POST') { posts.push(body); return { sent: true }; } return structuredClone(own); };
  const mountChat = chatModule(api, {
    uploadAttachment: () => new Promise((r) => { uploaded = r; }),
    URL: { createObjectURL: () => 'blob:local-1' },
  });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-3' });
  await c.flight;
  const picker = p.form.kids['input[type=file]'];
  picker.files = [{ type: 'image/png', name: 'a.png' }];
  picker.onchange();
  await new Promise((r) => setImmediate(r));
  const imgs = p.box.kids['.chat-imgs'];
  assert.match(imgs.innerHTML, /chat-thumb loading[^>]*><img src="blob:local-1"/, `no thumbnail before the upload is done: ${imgs.innerHTML}`);
  const field = p.form.kids.textarea;
  field.value = 'this one';
  const going = p.form.kids['.chat-send'].onclick();
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 0, 'the message went before its picture reached the board');
  uploaded({ id: 77, url: '/attachments/1/77.png' });
  await going;
  assert.deepEqual([...posts[0].images], [77]);
  c.destroy();
});

// were lost: they come back to the field of their own task, and the refusal is said there
test('words refused after the person went to another task come back to their own task, with the refusal', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  let refuse;
  const api = async (method) => {
    if (method === 'POST') return new Promise((_, no) => { refuse = no; });
    return structuredClone(own);
  };
  const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-4' });
  await c.flight;
  const field = p.form.kids.textarea;
  field.value = 'fix the header';
  const going = p.form.kids['.chat-send'].onclick();
  await new Promise((r) => setImmediate(r));
  c.setKey('CH-5');
  await c.flight;
  refuse(Object.assign(new Error('the words did not show'), { status: 409 }));
  await going;
  assert.equal(field.value, '', 'the words of CH-4 went into the field of CH-5');
  assert.doesNotMatch(p.note.textContent, /Not sent/, 'the refusal of CH-4 is said under CH-5');
  c.setKey('CH-4');
  await c.flight;
  assert.equal(field.value, 'fix the header', 'the refused words are lost');
  assert.match(p.note.textContent, /Not sent: the words did not show/, 'back on CH-4, nothing says the words were not sent');
  c.destroy();
});

// The same acceptance: words refused while the person typed the next ones were dropped for the new ones
test('words refused while the next ones were typed come back before them, not instead of them', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  let refuse;
  const api = async (method) => {
    if (method === 'POST') return new Promise((_, no) => { refuse = no; });
    return structuredClone(own);
  };
  const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-6' });
  await c.flight;
  const field = p.form.kids.textarea;
  field.value = 'first';
  const going = p.form.kids['.chat-send'].onclick();
  field.value = 'second';
  field.oninput();
  await new Promise((r) => setImmediate(r));
  refuse(Object.assign(new Error('busy'), { status: 409 }));
  await going;
  assert.equal(field.value, 'first\nsecond');
  c.destroy();
});

// The same acceptance: the picture joined the message only once its thumbnail was drawn — Enter pressed meanwhile sent the
// words without it (3 of 3 in Chromium), and the picture stayed for the next message
test('a picture put to the message and Enter at once: the message carries it', async () => {
  const own = { ...answer, send: true, state: 'idle' };
  let uploaded;
  const posts = [];
  const api = async (method, url, body) => { if (method === 'POST') { posts.push(body); return { sent: true }; } return structuredClone(own); };
  const mountChat = chatModule(api, {
    uploadAttachment: () => new Promise((r) => { uploaded = r; }),
    createImageBitmap: () => new Promise(() => {}), // a big picture: its thumbnail is still being drawn
  });
  const p = page();
  const c = mountChat(p.box, { key: 'CH-7' });
  await c.flight;
  const picker = p.form.kids['input[type=file]'];
  picker.files = [{ type: 'image/png', name: 'a.png' }];
  picker.onchange();
  const field = p.form.kids.textarea;
  field.value = 'this one';
  const going = p.form.kids['.chat-send'].onclick();
  uploaded({ id: 78, url: '/attachments/1/78.png' });
  await going;
  assert.deepEqual([...(posts[0]?.images || [])], [78], 'the message went without its picture');
  assert.doesNotMatch(p.box.kids['.chat-imgs'].innerHTML, /chat-thumb/, 'the picture stayed for the next message');
  c.destroy();
});

// does not build it anew — that would shut it under the person's pointer; it is built again only when the sessions change
test('the drop-down of sessions is built once, kept through repaints, built again for a new session, and picks one', async () => {
  const OLD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const two = [{ session_id: SID, last_seen: '2026-10-22 10:00:00' }, { session_id: OLD, last_seen: '2026-10-21 09:00:00' }];
  let data = { ...answer, sessions: two };
  const urls = [];
  const built = [];
  const mountChat = chatModule(async (method, url) => { urls.push(url); return structuredClone(data); }, {
    buildSelect: (host, opts) => built.push(opts), localStamp: (s) => s,
  });
  const p = page();
  p.box.kids['.chat-top'].kids = { '.chat-sess-sel': new El('chat-sess-sel') };
  const c = mountChat(p.box, { key: 'CH-8' });
  await c.flight;
  assert.equal(built.length, 1, 'two sessions and no drop-down');
  assert.deepEqual(built[0].options.map((o) => o.value), [SID, OLD]);
  data = { ...data, v: 'v2', turns: [...answer.turns, { at: '2026-10-22T11:00:00Z', user: 'more', open: true, items: [] }] };
  c.v = null;
  await c.refresh();
  assert.match(p.log.innerHTML, /more/, 'the stand-in did not repaint');
  assert.equal(built.length, 1, 'a live repaint built the drop-down anew — an open one would shut');
  built[0].onChange(OLD);
  await c.flight;
  assert.match(urls.at(-1), new RegExp(`session=${OLD}`), 'picking a session does not show it');
  data = { ...data, v: 'v3', sessions: [{ session_id: 'cccccccc-3333-4333-8333-cccccccccccc', last_seen: '2026-10-22 12:00:00' }, ...two] };
  c.v = null;
  await c.refresh();
  assert.equal(built.length, 2, 'a new session is not in the drop-down');
  c.destroy();
});

test('two refused messages come back to the field in the order they were sent, whichever is refused first', async () => {
  for (const first of ['A', 'B']) {
    const own = { ...answer, send: true, state: 'idle' };
    const refuse = {};
    const api = async (method, url, body) => {
      if (method === 'POST') return new Promise((_, no) => { refuse[body.text] = no; });
      return structuredClone(own);
    };
    const mountChat = chatModule(api, { refusalLine: (head, e) => `${head}: ${e.message}` });
    const p = page();
    const c = mountChat(p.box, { key: `CH-9${first}` });
    await c.flight;
    const field = p.form.kids.textarea;
    const going = [];
    for (const w of ['A', 'B']) {
      field.value = w;
      going.push(p.form.kids['.chat-send'].onclick());
      await new Promise((r) => setTimeout(r, 5)); // sent one after the other
    }
    for (const w of first === 'A' ? ['A', 'B'] : ['B', 'A']) { refuse[w](Object.assign(new Error('gone'), { status: 409 })); await new Promise((r) => setImmediate(r)); }
    await Promise.all(going);
    assert.equal(field.value, 'A\nB', `refused ${first} first`);
    c.destroy();
  }
});

// one's own presses the number of «Type something.» first, then types the words with Enter. Breaking either left the
// suite green (the source was only matched by its words).
test('a choice off the screen: a row presses its number, an answer of one\'s own its number and then the words', async () => {
  const sent = [];
  const choice = { tabs: [], text: 'Pick one?', multi: false, options: [{ n: 1, label: 'A', note: '', cursor: true }, { n: 2, label: 'B', note: 'about B', cursor: false }, { n: 3, label: 'Type something.', note: '', cursor: false, other: true }] };
  const data = { ...answer, send: true, state: 'question', question: 'Pick one?\n❯ 1. A\n  2. B\nEsc to cancel', choice };
  const p = page();
  const ask = p.box.kids['.chat-ask'];
  // the stand-in's rows: the buttons the chat wrote, kept so the test clicks what the chat wired
  const made = {};
  ask.querySelectorAll = (sel) => {
    if (sel === '.ask-pick') return (made[sel] ||= [...ask.html.matchAll(/class="ask-opt ask-pick[^"]*" data-n="(\d+)"/g)].map((m) => Object.assign(new El('ask-pick'), { dataset: { n: m[1] } })));
    if (sel === '[data-k]') return [];
    return [];
  };
  const other = Object.assign(new El('ask-other'), { value: '' });
  const go = Object.assign(new El('ask-other-go'), { dataset: { n: '3' } });
  ask.querySelector = (sel) => (sel === '.ask-other' ? other : sel === '.ask-other-go' ? go : null);
  const c = chatModule(async (method, url, body) => { if (method === 'POST') { sent.push([url, body]); return { ok: true }; } return structuredClone(data); }, { requestAnimationFrame: () => 0 })(p.box, { key: 'CH-1' });
  await c.flight;
  assert.match(ask.html, /data-n="2"/, 'the choice was not drawn as rows');
  const rows = ask.querySelectorAll('.ask-pick');
  assert.deepEqual([...rows].map((b) => b.dataset.n), ['1', '2']);
  await rows[1].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['/api/tasks/CH-1/terminal', { text: '2' }]], 'a row pressed another number');
  sent.length = 0;
  other.value = 'my own words';
  await go.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['/api/tasks/CH-1/terminal', { text: '3' }], ['/api/tasks/CH-1/terminal', { text: 'my own words', key: 'Enter' }]],
    'the words of one\'s own went without the number that opens their field, or without Enter');
  c.destroy();
});

// waiting) took the words along, silently — in a column of Terminals there was not even a note. They go back into the
// chat's field, and the chat says why the form went; words that were sent stay sent.
test('words typed into a question that goes come back to the field, with a note', async () => {
  const choice = { tabs: [], text: 'Pick one?', multi: false, options: [{ n: 1, label: 'A', note: '', cursor: true }, { n: 2, label: 'Type something.', note: '', cursor: false, other: true }] };
  let data = { ...answer, send: true, state: 'question', question: 'Pick one?\n❯ 1. A\nEsc to cancel', choice };
  const p = page();
  const ask = p.box.kids['.chat-ask'];
  let other = null;
  const fields = () => (ask.html.includes('ask-other') ? [other ||= Object.assign(new El('ask-other'), { value: '' })] : []);
  ask.querySelectorAll = (sel) => (sel === '.ask-other, .ask-qnote, .ask-reason' ? fields() : []);
  ask.querySelector = (sel) => (sel === '.ask-other' ? fields()[0] || null : null);
  const c = chatModule(async () => structuredClone(data), { requestAnimationFrame: () => 0 })(p.box, { key: 'CH-1' });
  await c.flight;
  const field = p.form.kids.textarea;
  assert.ok(fields().length, 'the choice was drawn without its field of one\'s own answer');
  fields()[0].value = 'my own words';
  field.value = 'half a message';
  data = { ...answer, send: true, state: 'idle', v: 'v2' };
  c.stale = true; c.show(true);
  await c.flight;
  assert.equal(ask.html, '', 'the question is still drawn');
  assert.equal(field.value, 'half a message', 'one look without the question (a flicker) moved the words already');
  data = { ...answer, send: true, state: 'idle', v: 'v3' };
  c.stale = true; c.show(true);
  await c.flight;
  assert.equal(field.value, 'half a message\nmy own words', 'the words typed into the question are lost');
  assert.match(p.note.textContent, /question is gone/, 'the chat does not say why the form went');
  c.destroy();
});

test('a question gone for one look only comes back with the words in its field', async () => {
  const choice = { tabs: [], text: 'Pick one?', multi: false, options: [{ n: 1, label: 'A', note: '', cursor: true }, { n: 2, label: 'Type something.', note: '', cursor: false, other: true }] };
  const asking = { ...answer, send: true, state: 'question', question: 'Pick one?\n❯ 1. A\nEsc to cancel', choice };
  let data = asking;
  const p = page();
  const ask = p.box.kids['.chat-ask'];
  const made = [];
  const fields = () => (ask.html.includes('ask-other') ? [made[made.length - 1]] : []);
  const orig = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ask), 'innerHTML');
  Object.defineProperty(ask, 'innerHTML', { get() { return orig.get.call(this); }, set(h) { orig.set.call(this, h); if (h.includes('ask-other')) made.push(Object.assign(new El('ask-other'), { value: '' })); } });
  ask.querySelectorAll = (sel) => (sel === '.ask-other, .ask-qnote, .ask-reason' ? fields() : []);
  ask.querySelector = (sel) => (sel === '.ask-other' ? fields()[0] || null : null);
  const c = chatModule(async () => structuredClone(data), { requestAnimationFrame: () => 0 })(p.box, { key: 'CH-1' });
  await c.flight;
  fields()[0].value = 'my own words';
  data = { ...answer, send: true, state: 'busy', v: 'v2' }; // a reprint: the screen did not read as a question once
  c.stale = true; c.show(true); await c.flight;
  data = { ...asking, v: 'v3' };
  c.stale = true; c.show(true); await c.flight;
  assert.equal(fields()[0]?.value, 'my own words', 'the question came back with an empty field');
  assert.equal(p.form.kids.textarea.value, '', 'the words went to the chat\'s field as well');
  c.destroy();
});

test('words typed into the question of a task left behind stay that task\'s, not the next one\'s', async () => {
  const choice = { tabs: [], text: 'Pick one?', multi: false, options: [{ n: 1, label: 'A', note: '', cursor: true }, { n: 2, label: 'Type something.', note: '', cursor: false, other: true }] };
  const data = { ...answer, send: true, state: 'question', question: 'Pick one?\n❯ 1. A\nEsc to cancel', choice };
  const p = page();
  const ask = p.box.kids['.chat-ask'];
  let other = null;
  const fields = () => (ask.html.includes('ask-other') ? [other ||= Object.assign(new El('ask-other'), { value: '' })] : []);
  ask.querySelectorAll = (sel) => (sel === '.ask-other, .ask-qnote, .ask-reason' ? fields() : []);
  ask.querySelector = (sel) => (sel === '.ask-other' ? fields()[0] || null : null);
  const c = chatModule(async (m, url) => (url.includes('/CH-1/') ? structuredClone(data) : structuredClone({ ...answer, send: true, state: 'idle' })), { requestAnimationFrame: () => 0 })(p.box, { key: 'CH-1' });
  await c.flight;
  fields()[0].value = 'for the Claude of CH-1';
  c.setKey('CH-2');
  await c.flight;
  assert.equal(p.form.kids.textarea.value, '', 'the words of CH-1\'s question are in the field of CH-2');
  c.setKey('CH-1');
  assert.equal(p.form.kids.textarea.value, 'for the Claude of CH-1', 'the words are lost');
  c.destroy();
});

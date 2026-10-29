import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');

test('a card in work is a calm outline: no turning cone under the text, an opaque middle, a breathing glow', () => {
  const card = rule('.card.working:not(.drag-ghost)');
  assert.match(card, /border-color:[^;]*var\(--accent\)/, 'the frame of a card in work is not the accent');
  assert.match(card, /background:[^;]*,\s*var\(--panel\)\s*(;|$)/, 'the middle is not laid on the opaque panel colour');
  assert.doesNotMatch(card, /overflow:\s*hidden|background:\s*transparent/, 'the card is a window onto a layer under it again');
  const glow = rule('.card.working:not(.drag-ghost)::before');
  assert.doesNotMatch(glow, /conic-gradient|kb-spin|z-index:\s*-/, 'a turning cone is back under the card');
  assert.match(glow, /animation:\s*card-breathe\b/, 'the glow of a card in work does not breathe');
  assert.match(css, /@keyframes card-breathe \{ 50% \{ opacity: 1; \} \}/, 'the glow moves something other than its opacity');
  assert.equal(rule('.card.working:not(.drag-ghost)::after'), '', 'a layer is laid over the card in work again');
});

test('the project being checked turns its outline, and the turning square covers a tall panel', () => {
  const sq = rule('.rv-group.rv-live::before');
  assert.match(sq, /animation:\s*kb-spin\b/, 'the outline of the project being checked does not turn');
  assert.match(sq, /width:\s*max\([^)]*var\(--rv-d/, 'the turning square is not sized by the panel');
  const review = readFileSync(new URL('../public/js/review.js', import.meta.url), 'utf8');
  assert.match(review, /setProperty\('--rv-d', `\$\{Math\.ceil\(Math\.hypot\(r\.width, r\.height\)\)\}px`\)/,
    'the square is not as large as the diagonal of the panel — a tall one loses its outline at the top and bottom');
  assert.match(review, /addEventListener\?\.\('resize', \(\) => \{[^}]*sizeLive\(/, 'a turned phone keeps the old size of the square');
});

test('the icon of a section title is the larger one, centred on the letters', () => {
  const sidebar = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
  assert.match(sidebar, /const TITLE_IC = 20;/, 'the icons of the section titles are small again');
  assert.match(rule('.topbar h1 .ic'), /vertical-align:\s*calc\(\.35em - 10px\)/, 'the icon of a section title sits below the letters again');
});

test('the buttons in a settings heading keep the interface font and size, grouped at the right', () => {
  const btn = rule('.sm-h > button');
  assert.match(btn, /font-family:\s*-apple-system/, 'a heading button takes the serif of the heading again');
  assert.match(btn, /font-size:\s*12\.5px/, 'a heading button is as large as the heading again');
  assert.match(rule('.sm-h > .muted'), /font-family:\s*-apple-system/, 'the counter of the heading takes the serif again');
  assert.match(rule('.sm-h > :first-child'), /margin-left:\s*auto/, 'two heading buttons drift apart again');
});

test('what waits is a small grey dot: the review dot of the sidebar, the queue of Claude now, Review in Claude done', () => {
  const rev = rule('.proj-review');
  assert.match(rev, /background:\s*var\(--muted\)/, 'the review dot of the sidebar is coloured again');
  assert.match(rev, /width:\s*5px/, 'the review dot of the sidebar is large again');
  assert.equal(rule('.proj-review::before'), '', 'the review dot of the sidebar pulses again');
  assert.match(rule('.now-queue'), /background:\s*var\(--muted\)/, 'a waiting task is coloured again');
  const now = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  assert.doesNotMatch(now, /now-queue|now-mark|live-dot"><\/span><\/span>'/, 'Claude now puts a dot in front of its tasks again');
  assert.match(now, /return wasHanded\(t\) \? `<span class="now-check"/, 'Claude now lost the ✓ of a task handed in');
  assert.equal(rule('.now-row.focus'), '', 'the task Claude is on is highlighted again');
  assert.doesNotMatch(now, /now-row\$\{t\.focus/, 'Claude now marks the task it is on with a class again');
  const done = readFileSync(new URL('../public/js/done.js', import.meta.url), 'utf8');
  assert.doesNotMatch(done, /dot s-review/, 'Claude done marks Review with the orange dot again');
});

// a square exactly as tall as a one-line field — the line, the field's top and bottom padding and its two borders —
// in the plain look and in design 3, and it takes the font of the form like the field, or their em differ.
test('the send button of a comment or terminal answer is a square as tall as a one-line field', () => {
  const pad = (body) => { const m = /padding:\s*(\d+)px/.exec(body); assert.ok(m, 'the field lost its padding'); return Number(m[1]); };
  const field = rule('.comment-form textarea');
  assert.match(field, /font:\s*inherit/, 'the field no longer takes the font of the form');
  assert.match(field, /line-height:\s*1\.4\b/, 'the line of the field changed — the button height counts 1.4em');
  const btn = rule('.comment-form > button');
  assert.match(btn, /font-size:\s*inherit/, 'the button has a font of its own — its em is not the field\'s');
  assert.match(btn, /aspect-ratio:\s*1\b/, 'the send button is not a square');
  assert.match(btn, /padding:\s*0\b/, 'the padding of the button grows it past the field');
  assert.match(btn, new RegExp(`height:\\s*calc\\(1\\.4em \\+ ${2 * pad(field) + 2}px\\)`), 'the button is not as tall as the field');
  const v3 = rule('html[data-design="v3"] .comment-form > button');
  assert.match(v3, new RegExp(`height:\\s*calc\\(1\\.4em \\+ ${2 * pad(rule('html[data-design="v3"] .comment-form textarea')) + 2}px\\)`),
    'in design 3 the button is not as tall as the field');
  assert.doesNotMatch(rule('.comment-form .btn-primary') + rule('.term-form .term-send'), /padding/, 'a padding of the button is back and outweighs the square');
});

// there were more skills below.
test('a list that scrolls inside a window shows a narrow grey scrollbar', () => {
  for (const sel of ['#sk-list', '.kbsel-list']) {
    assert.match(rule(sel), /scrollbar-width:\s*auto/, `${sel} keeps the board-wide scrollbar-width: none — Chromium draws no bar`);
    assert.match(rule(`${sel}::-webkit-scrollbar-thumb`), /background:\s*color-mix\(in srgb, var\(--muted\) 45%, transparent\)/, `the thumb of ${sel} is not grey`);
  }
  assert.match(rule('#sk-list'), /overflow-y:\s*auto/, 'the skills list no longer scrolls by itself');
});

test('the menu of Settings fits the window and shows its bar when it does not', () => {
  const h = Number(rule('.settings-modal').match(/(?:^|;)\s*height:\s*(\d+)px/)?.[1]);
  assert.ok(h >= 580, `the Settings window is ${h}px tall — the 13 sections do not fit`);
  assert.match(rule('.sm-nav'), /scrollbar-width:\s*auto/, 'the menu of Settings hides its scrollbar again');
  assert.match(rule('.sm-nav::-webkit-scrollbar-thumb'), /color-mix/, 'the menu of Settings has no grey thumb');
});

test('the ring of a selected card is the lighter one (CK-624)', () => {
  assert.match(rule('.col-body .card.selected'), /box-shadow:\s*0 0 0 1px var\(--accent\)/, 'the ring of a selected card is thick again');
  assert.match(rule('.col-body .card.selected.working'), /0 0 0 1px var\(--accent\), 0 0 6px 1px rgba\(232, 112, 78,\s*\.25\)/,
    'the glow of a selected card in work is the strong one again');
});

test('the light theme reads: dark text, a secondary text of AA contrast, borders and a sidebar of their own (CK-646)', () => {
  const block = rule('html[data-design="v3"][data-theme="light"]');
  const token = (name) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i').exec(block);
    assert.ok(m, `the light theme has no --${name}`);
    return m[1].match(/../g).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  };
  const lum = (n) => { const [r, g, b] = token(n); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.ok(contrast('text', 'bg') >= 16, 'the text of the light theme is grey again');
  assert.ok(contrast('muted', 'bg') >= 4.5, 'the secondary text of the light theme is below AA on the board');
  assert.ok(contrast('muted', 'side') >= 4.5, 'the secondary text of the light theme is below AA on the sidebar');
  assert.ok(contrast('border', 'bg') >= 1.3, 'the borders of the light theme melt into the cream');
  assert.ok(contrast('side', 'bg') >= 1.08, 'the sidebar of the light theme has no tone of its own');
});

test('the bottom of the Terminal tab sticks to the edge of the card, and its screen has the round corners (CK-625, CK-626)', () => {
  assert.match(rule('.term-dock'), /position:\s*sticky;\s*bottom:\s*-14px/, 'the links, keys and answer box scroll away with the card');
  assert.match(rule('.term-dock'), /background:\s*var\(--panel\)/, 'lines of the card show through the stuck bottom');
  assert.match(rule('#term-block:not(.hidden)'), /display:\s*contents/, 'the sticky bottom is held by a parent as tall as the terminal');
  assert.match(rule('.term-screen'), /border-radius:\s*16px/, 'the terminal screen has the small corners again');
});

test('Claude now: the empty panel slides away, the Terminals fit the screen, swipe with no bar, a column head is one line (CK-656, CK-659, CK-663, CK-658)', () => {
  const fold = rule('body:has(#now:not(.hidden)) .drawer.is-empty');
  assert.match(fold, /(^|[\s;])width:\s*0;/, 'the empty task panel stays open in Claude now');
  assert.match(fold, /transition:\s*width \.9s/, 'the empty task panel does not slide away slowly');
  assert.match(rule('.now-view.now-terms'), /display:\s*flex;\s*flex-direction:\s*column;\s*overflow:\s*hidden/, 'the Terminals view scrolls the page again');
  assert.doesNotMatch(rule('.now-cols'), /scrollbar/, 'the columns show a scrollbar under them again');
  assert.equal(rule('.now-cols::-webkit-scrollbar'), '', 'the columns show a scrollbar under them again');
  const who = rule('.now-col-who');
  assert.match(who, /white-space:\s*nowrap/, 'the head of a column breaks into lines again');
  assert.doesNotMatch(who, /flex-wrap:\s*wrap/, 'the head of a column breaks into lines again');
  assert.match(rule('.now-col-who .term-state'), /flex:\s*none/, 'the state word gives way before the project name');
});

test('the title of a screen stands alone: nothing fills a line beside it (CK-643)', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /project-meta/, 'the description right of the title is back in the page');
  for (const f of ['sidebar.js', 'now.js', 'review.js', 'done.js', 'chaos.js', 'board.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8'), /project-meta/, `${f} fills the description again`);
  }
});

// 470px inside a wider window. A section is as wide as the window; only its head keeps room for the ✕.
test('a section of Settings is as wide as the window, and its head leaves room for the close button', () => {
  assert.doesNotMatch(rule('.sm-body'), /max-width/, 'a section of Settings has a ceiling again');
  assert.match(rule('.sm-h'), /padding-right:\s*30px/, 'the buttons of a section head run under the close button');
});

// the list and the bottom buttons), the dots and the count stand on the edges of the picture, the picture starts on the
// line of the small heading, and the two bottom buttons are of one height.
test('the first-run wizard stands on one grid', () => {
  assert.match(rule('.onb-main'), /margin:\s*0 -2px;[^]*padding:\s*44px 2px 16px/, 'the words of the left half are off the edge of the logo');
  assert.match(rule('.onb-side'), /padding:\s*22px 32px 24px/);
  const stage = rule('.onb-stage');
  assert.match(stage, /align-items:\s*flex-start/, 'the picture hangs in the middle of the half again');
  assert.match(stage, /padding:\s*88px 36px 36px/, 'the picture does not start on the line of the heading (22 + 22 + 44)');
  assert.match(rule('.onb-top'), /left:\s*calc\(46% \+ 37px\);\s*right:\s*36px/, 'the dots and the count are off the edges of the picture');
  assert.match(rule('#onboarding .btn-primary'), /font-family:\s*inherit;\s*line-height:\s*1\.45;\s*border:\s*1px solid transparent/, 'Next is shorter than Back again');
  assert.match(rule('.onb-pair'), /align-items:\s*start/, 'the two windows of step GitHub stand on different lines');
});

// On a phone the columns of Terminals stack, and the page scrolls through them. A column's chat needs a height of its
// own there, as the screen has: without one the list grew to the whole conversation, opened at its first words, and the
// light and the field were screens below.
test('on a phone a chat column has a height of its own, as the terminal screen does', () => {
  const at = css.indexOf('.now-cols { flex-direction: column');
  const from = css.lastIndexOf('@media (max-width: 760px)', at);
  assert.ok(at > 0 && from > 0, 'the phone block of the Terminals columns moved; teach this test where it is');
  const block = css.slice(from, css.indexOf('\n}\n', at));
  const inBlock = (sel) => [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');
  assert.match(inBlock('.now-col .term-screen'), /height:\s*55vh/, 'the terminal screen of a stacked column lost its height');
  assert.match(inBlock('.now-col .now-col-chat .chat-log'), /flex:\s*none;\s*height:\s*55vh/,
    'the chat of a stacked column grows to the whole conversation');
});

// The Back of the wizard stands with its arrow on the left edge of the words above it. Its own rule must outweigh the
// rule of every button of the row (#onboarding .onb-actions button — an id, a class and an element), or the padding of
// that rule wins and the arrow sits 16px inside the edge.
test('the wizard\'s Back has no padding on the left: its rule outweighs the rule of the row\'s buttons', () => {
  assert.match(rule('#onboarding .onb-actions button'), /padding:\s*9px 16px/, 'the rule of the wizard\'s buttons moved; teach this test where it is');
  assert.match(rule('#onboarding .onb-actions .onb-back'), /padding-left:\s*0/, 'the arrow of Back sits inside the left edge again');
});

// A column of Terminals does not scroll: the words waiting for a busy Claude scroll on their own, or twenty of them push
// the field (and a refusal under it) off the column.
test('the waiting words of a column chat have a ceiling and their own scroll', () => {
  const q = rule('.now-col-chat .chat-queue');
  assert.match(q, /max-height:\s*\d+vh/, 'the queue of a column has no ceiling — the field goes off the column');
  assert.match(q, /overflow-y:\s*auto/, 'the queue of a column cannot be scrolled');
  assert.match(q, /flex:\s*0 0 auto/, 'a long chat squeezes the queue of a column to a bubble (WebKit)');
});

// on top — beside a section at 190px they left it 175px, and its rows went past the edge
test('the settings window is wide, fits the window, and on a phone lists its sections on top', () => {
  const m = rule('.settings-modal');
  assert.match(m, /width:\s*920px/, 'the settings window opens narrow again');
  assert.match(m, /max-width:\s*94vw/, 'the settings window can go past the window');
  const phone = /@media \(max-width: 600px\) \{([^]*?)\n\}/.exec(css.slice(css.indexOf('.sm-main {')))?.[1] || '';
  assert.match(phone, /\.settings-modal \{ flex-direction: column; \}/, 'on a phone the sections stand beside the section');
  assert.match(phone, /\.sm-nav \{ width: auto;[^}]*overflow-x: auto/);
  assert.match(phone, /\.set-row \{ flex-wrap: wrap; \}/);
});

test('the status dot of a recently added row has a size', () => {
  assert.match(rule('.chaos-nc-row .dot'), /width:\s*\d+px;\s*height:\s*\d+px/, 'the dot of a recently added row is 0×0 again');
});

// second accent against the one-accent rule; a section's link without a class of its own takes the board's accent.
test('a plain link in a section of Settings is the accent, not the system blue', () => {
  assert.match(rule('.sm-body a:not([class])'), /color:\s*var\(--accent\)/, 'a link in Settings draws the browser\'s blue again');
});

// field's colour, so a clear placeholder alone left a dash).
test('a done empty checklist item shows no struck-through placeholder', () => {
  assert.match(rule('.cl-item.done .cl-text::placeholder'), /color:\s*transparent/, 'the placeholder of a done item shows again');
  assert.match(rule('.cl-item.done .cl-text:placeholder-shown'), /text-decoration:\s*none/, 'an empty done item draws a lone strike line');
});

// now — 6, 3 + 3 or 2 + 2 + 2 — by the width of their own box.
test('the six dashboard tiles split evenly, never 5 + 1', () => {
  assert.match(rule('.dcards-box'), /container-type:\s*inline-size/, 'the tiles do not measure their own box');
  assert.doesNotMatch(css, /\.dcards \{[^}]*auto-fit/, 'the tiles fit as many as go in a row again (5 + 1)');
  assert.match(css, /@container \(min-width: 474px\) \{ \.dcards \{ grid-template-columns: repeat\(3,/, 'no 3 + 3 step');
  assert.match(css, /@container \(min-width: 960px\) \{ \.dcards \{ grid-template-columns: repeat\(6,/, 'no row of six');
  const dash = readFileSync(new URL('../public/js/dash.js', import.meta.url), 'utf8');
  assert.match(dash, /<div class="dcards-box"><div class="dcards">/, 'the tiles lost the box they measure');
});

test('CK-850/CK-831: the top bar is measured by its own width, and its badges and the column heads stay one line', () => {
  // a card open beside the board narrows the page: at 761–990 points the week's count ran over the title and ⋯
  assert.match(css, /\.topbar \{ container: topbar \/ inline-size; \}/, 'the top bar no longer measures its own width');
  const narrow = css.slice(css.indexOf('@container topbar (max-width: 620px) {'));
  assert.ok(narrow.length > 0, 'nothing narrows the top bar by its own width');
  const block = narrow.slice(0, narrow.indexOf('\n}\n'));
  assert.match(block, /#week-stats \{ display: none; \}/);
  assert.match(block, /\.topbar h1 \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(css, /\.topbar-right > \* \{ white-space: nowrap; \}/, '«sound off» breaks into two lines on a phone of 320 again');
  const head = css.slice(css.indexOf('.col-head {'), css.indexOf('}', css.indexOf('.col-head {')));
  assert.match(head, /white-space: nowrap;/, '«To do» breaks into «To / do» on a phone of 320 again');
});

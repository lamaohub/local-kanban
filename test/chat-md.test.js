// tables, quotes, rules, code, emphasis, links — and stay safe: escaped first, links only to http(s).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatText, inlineMd, isCommand } from '../public/js/chat-md.js';

test('blocks: headings, lists with nesting and boxes, a table, a quote, a rule, fenced code', () => {
  const html = chatText([
    '## Done', '', 'Two things:', '- first **one**', '  - nested', '- [x] checked', '- [ ] open', '',
    '1. step', '2. next', '', '| File | Lines |', '|---|--:|', '| a.js | 12 |', '', '> a quote', '', '---', '',
    '```js', 'const a = 1 < 2;', '```', 'After.',
  ].join('\n'));
  assert.match(html, /<div class="md-h md-h2">Done<\/div>/);
  assert.match(html, /<p>Two things:<\/p>/);
  assert.match(html, /<ul class="md-list"><li>first <strong>one<\/strong><ul class="md-list"><li>nested<\/li><\/ul><\/li><li class="md-task">☑ checked<\/li><li class="md-task">☐ open<\/li><\/ul>/);
  assert.match(html, /<ol class="md-list"><li>step<\/li><li>next<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>File<\/th><th style="text-align:right">Lines<\/th><\/tr><\/thead><tbody><tr><td>a\.js<\/td><td style="text-align:right">12<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote class="md-quote"><p>a quote<\/p><\/blockquote>/);
  assert.match(html, /<hr class="md-hr">/);
  assert.match(html, /<pre class="chat-code">const a = 1 &lt; 2;<\/pre><p>After\.<\/p>/);
});

test('blank lines between items keep one list, and a list numbered from N starts at N', () => {
  assert.equal(chatText('Three:\n\n1. **One.** a\n\n2. **Two.** b\n\n3. c\n\nSo.'),
    '<p>Three:</p><ol class="md-list"><li><strong>One.</strong> a</li><li><strong>Two.</strong> b</li><li>c</li></ol><p>So.</p>');
  assert.equal(chatText('1. a\n\n   more of a\n\n2. b'), '<ol class="md-list"><li>a more of a</li><li>b</li></ol>');
  assert.equal(chatText('- a\n\n  - deeper\n\n- b'), '<ul class="md-list"><li>a<ul class="md-list"><li>deeper</li></ul></li><li>b</li></ul>');
  // a list of another kind, or words after a blank line, end it
  assert.equal(chatText('- a\n\n1. b'), '<ul class="md-list"><li>a</li></ul><ol class="md-list"><li>b</li></ol>');
  assert.equal(chatText('- a\n\nafter'), '<ul class="md-list"><li>a</li></ul><p>after</p>');
  assert.equal(chatText('3. c\n4. d'), '<ol class="md-list" start="3"><li>c</li><li>d</li></ol>');
});

test('lines of one paragraph stay lines; a blank line starts a new one', () => {
  assert.equal(chatText('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});

test('inline: code holds its stars, emphasis does not eat snake_case or a lone star, links only http(s)', () => {
  assert.equal(inlineMd('`a*b*c` and *it* and _it_ and ~~no~~'), '<code>a*b*c</code> and <em>it</em> and <em>it</em> and <del>no</del>');
  assert.equal(inlineMd('see my_file_name.js and 2 * 3 * 4'), 'see my_file_name.js and 2 * 3 * 4');
  assert.match(inlineMd('[docs](https://e.x/a_b_c)'), /^<a href="https:\/\/e\.x\/a_b_c" target="_blank" rel="noopener noreferrer">docs<\/a>$/);
  assert.match(inlineMd('open https://e.x/p?a=1&b=2.'), /<a href="https:\/\/e\.x\/p\?a=1&amp;b=2"[^>]*>https:\/\/e\.x\/p\?a=1&amp;b=2<\/a>\.$/);
  assert.doesNotMatch(inlineMd('[x](javascript:alert(1))'), /href/);
});

test('nothing of the text becomes markup of its own', () => {
  const html = chatText('<img src=x onerror=alert(1)>\n# <script>\n| <b> | x |\n|---|---|\n| "q" | \'a\' |\n> <i>\n- <u>');
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<u>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// onmouseover), a bare URL of any scheme after a space, the words of a ☑ item put in raw. The rule they broke is one:
// the only tags in the output are the module's own, in their own shape. Every hostile line goes into every kind of block.
const OWN_TAG = new RegExp([
  '<a href="https?://[^"<>\\s]*" target="_blank" rel="noopener noreferrer">', '</a>',
  '</?(?:p|strong|em|del|code|table|thead|tbody|tr|ul|ol|li|blockquote|div|pre)>', '<br>', '<hr class="md-hr">',
  '<(?:ul|ol) class="md-list">', '<ol class="md-list" start="\\d{1,9}">', '<li class="md-task">', '<blockquote class="md-quote">', '<div class="md-table">',
  '<div class="md-h md-h[1-6]">', '<pre class="chat-code">', '<t[hd](?: style="text-align:(?:center|right)")?>', '</t[hd]>',
].join('|'), 'g');
const HOSTILE = [
  '<img src=x onerror=alert(1)>', '[x](https://a"onmouseover="alert(1))', '[x](https://a\' onmouseover=\'alert(1))',
  'click javascript:alert(document.cookie)', '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', 'data:text/html,<b>',
  '**<svg onload=alert(1)>**', '_<i>x</i>_', '`<script>`', 'https://e.x/"><img src=x>', '<https://e.x>', 'https://e.x/`p`',
  '[t](https://e.x/`p`)',
];
const CONTEXTS = [(h) => h, (h) => `# ${h}`, (h) => `- ${h}`, (h) => `- [x] ${h}`, (h) => `1. ${h}`, (h) => `> ${h}`,
  (h) => `| ${h} | b |\n|---|---|\n| ${h} | c |`, (h) => `- a\n  - ${h}`, (h) => `~~${h}~~`];

test('whatever Claude writes, the only tags in the chat are its own, and links go to http(s) only', () => {
  for (const h of HOSTILE) for (const put of CONTEXTS) {
    const html = chatText(put(h));
    const left = html.replace(OWN_TAG, '');
    assert.doesNotMatch(left, /[<>"]/, `${JSON.stringify(put(h))} → ${html}`);
  }
});

// The same acceptance: a heading with a long run of spaces took 4.7 s for 2000 characters (the tab hung), blank lines
// and a line of spaces under a `|` line grew as the square, and 5000 quote marks broke the chat with a RangeError.
// checks), so the work is measured as the time the process spent on the processor, which the load does not stretch.
const cpuMs = (fn) => { const c = process.cpuUsage(); fn(); const d = process.cpuUsage(c); return (d.user + d.system) / 1000; };
test('no words of Claude hang the tab or break the chat', () => {
  // the heading is short on purpose: the old pattern was cubic, and a longer one would hang the suite instead of failing it
  const inputs = ['# a' + ' '.repeat(1500) + 'x', '\n'.repeat(100000), 'a|b\n' + ' '.repeat(40000) + 'x',
    '>'.repeat(20000) + ' hi', '*a '.repeat(30000), '**a'.repeat(30000), '_a '.repeat(30000), '['.repeat(50000),
    '- '.repeat(20000) + 'x', '- a\n'.repeat(20000), '- a\n' + '\n'.repeat(100000) + 'x', '1. a\n\n'.repeat(30000), '#'.repeat(30000) + ' x ' + '#'.repeat(30000), 'https://e.x/' + '.'.repeat(50000)];
  for (const s of inputs) {
    let ms = 0;
    assert.doesNotThrow(() => { ms = cpuMs(() => chatText(s)); });
    assert.ok(ms < 300, `${JSON.stringify(s.slice(0, 20))}… took ${Math.round(ms)} ms of the processor`);
  }
  assert.match(chatText('> > deep'), /<blockquote class="md-quote"><blockquote class="md-quote"><p>deep<\/p>/);
});

test('a heading drops its closing #s, code in the words of a link stays code, a bare link stops before a quote', () => {
  assert.match(chatText('## Done ##'), /<div class="md-h md-h2">Done<\/div>/);
  assert.match(chatText('# C#'), /<div class="md-h md-h1">C#<\/div>/);
  assert.equal(inlineMd('[`kb`](https://e.x)'), '<a href="https://e.x" target="_blank" rel="noopener noreferrer"><code>kb</code></a>');
  assert.equal(inlineMd('see https://x.com"'), 'see <a href="https://x.com" target="_blank" rel="noopener noreferrer">https://x.com</a>&quot;');
  assert.equal(inlineMd('a0b'), 'a0b'); // the module's own hold mark in the words is dropped
});

test('a table needs a separator of as many cells as its head; one dash a cell is enough', () => {
  assert.match(chatText('| a | b |\n|:-:|-|\n| 1 | 2 |'), /<th style="text-align:center">a<\/th><th>b<\/th>/);
  assert.doesNotMatch(chatText('a | b\n---'), /<table>/);
  assert.match(chatText('| `ls | wc` | a \\| b |\n|---|---|\n| 1 | 2 |'), /<th><code>ls \| wc<\/code><\/th><th>a \| b<\/th>/);
});

test('cells of a wide table keep their words whole: the table is as wide as its words and scrolls in its box', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css.match(/\.chat-claude table \{[^}]*\}/)?.[0] || '', /width: max-content/);
  assert.match(css.match(/\.chat-claude th, \.chat-claude td \{[^}]*\}/)?.[0] || '', /max-width: 22em/);
  assert.match(css, /\.chat-claude \.md-table \{[^}]*overflow-x: auto/);
});

test('CK-887: a command inside a sentence stands as a line of its own with «Copy», never with «Run»', () => {
  const calls = [];
  const tools = (lang, closed, code) => { calls.push([lang, closed, code]); return '<span class="tools"></span>'; };
  const html = chatText('1. **Log in.** See it with `! ssh root@10.0.0.5 cat /root/review-login.txt`. Then open the page.\n\nShort: `git status`, a path `src/a.js`.', tools);
  assert.match(html, /<li><strong>Log in\.<\/strong> See it with <span class="chat-code-box chat-cmd"><span class="chat-code">! ssh root@10\.0\.0\.5 cat \/root\/review-login\.txt<\/span><span class="tools"><\/span><\/span> Then open the page\.<\/li>/,
    'the command is not a line of its own, or the dot after it stayed at the start of the next line');
  assert.deepEqual(calls, [['', false, '! ssh root@10.0.0.5 cat /root/review-login.txt']], 'an inline command was offered to run, or a short code was taken for one');
  assert.match(html, /<code>git status<\/code>, a path <code>src\/a\.js<\/code>\./, 'a short code span left the sentence');
  // escaped first: the copied text is the command as Claude wrote it, the markup has nothing of it raw
  calls.length = 0;
  const hostile = chatText('Run `! echo "<img src=x onerror=alert(1)>" && rm -rf /tmp/x`', tools);
  assert.ok(!hostile.includes('<img'), 'a command put raw markup into the chat');
  assert.equal(calls[0][2], '! echo "<img src=x onerror=alert(1)>" && rm -rf /tmp/x');
  // without tools (a table cell, a heading, any caller without buttons) a command stays a code span
  assert.match(chatText('| a | b |\n|---|---|\n| `ssh root@10.0.0.5 uptime -p` | x |', tools), /<td><code>ssh root@10\.0\.0\.5 uptime -p<\/code><\/td>/);
  assert.match(inlineMd('`! ssh host cat /x`'), /^<code>! ssh host cat \/x<\/code>$/);
});

test('CK-887: what reads as a command', () => {
  for (const c of ['! ssh root@host cat x', '$ npm install', 'ssh root@10.0.0.1 uptime', 'git -C ~/x log --oneline -5', 'kb review CK-1 "done"']) assert.ok(isCommand(c), c);
  for (const c of ['git status', 'src/js/chat.js', 'npm', 'Settings → Errors', 'deploy-tickets skill here', '!important']) assert.ok(!isCommand(c), c);
});

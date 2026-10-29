// from these terminals" — a command copied from the card came with the line breaks and the indents the screen laid it
// out with, and broke in the shell. The screens below are the shapes of real ones (45- and 44-column windows of the
// owner's terminals, 16.10.2026), with a host and paths of their own in place of the owner's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { screenCopy, wireTermCopy } from '../public/js/term-copy.js';
import { wrapsIn } from '../src/phantom.js';

const copyAll = (rows, info = { cols: 44 }) => screenCopy(rows.join('\n'), info, 0, rows.join('\n').length);
/** The copy of a selection from the start of `from` to the end of `to` — both texts on the screen. */
const copyBetween = (rows, from, to, info = { cols: 44 }) => {
  const s = rows.join('\n');
  const a = s.indexOf(from);
  const b = s.indexOf(to, a) + to.length;
  assert.ok(a >= 0 && b > a, `no "${from}" … "${to}" on the screen`);
  return screenCopy(s, info, a, b);
};

// the screen of the owner's report: Claude's text, a list, and a command in it that the width broke over three rows
const OWNER = [
  '⏺ FilmCraft открыт, и в нём загружен',
  '  тестовый проект: ролик без пауз, с',
  '  субтитрами и цветокоррекцией. Пробел',
  '  запускает воспроизведение.',
  '',
  '  Сейчас приложение работает прямо из',
  '  скачанного образа. В «Программы» оно так и',
  '  не скопировано, поэтому после',
  '  перезагрузки Mac образ отключится и',
  '  приложение пропадёт.',
  '',
  '  Как открывать дальше:',
  '  1. Один раз установи (у меня на это нет',
  '     разрешения):',
  '     ! cp -R',
  '     /Volumes/FilmCraft/FilmCraft.app',
  '     /Applications/ && hdiutil detach',
  '     /Volumes/FilmCraft',
  '  2. Потом запускай так, чтобы Claude мог',
  '     управлять открытым окном:',
  '     ! open -a FilmCraft --args --control',
  '     9876',
  '     Если открыть с иконки или через',
  '     Spotlight, приложение будет работать,',
  '     но Claude не сможет управлять окном.',
  '     Резать видео без окна, через консоль,',
  '     он сможет всё равно.',
  '',
  '✻ Cooked for 23s · done 5:29 PM',
];

test('the selection of the owner\'s report copies the list as Claude wrote it, each command on one line', () => {
  assert.equal(copyBetween(OWNER, 'Как открывать', 'открытым окном:'), [
    'Как открывать дальше:',
    '1. Один раз установи (у меня на это нет разрешения):',
    '   ! cp -R /Volumes/FilmCraft/FilmCraft.app /Applications/ && hdiutil detach /Volumes/FilmCraft',
    '2. Потом запускай так, чтобы Claude мог управлять открытым окном:',
  ].join('\n'));
  // the whole screen: paragraphs whole, the blank rows between them kept, a row Claude ended stays ended
  assert.equal(copyAll(OWNER), [
    '⏺ FilmCraft открыт, и в нём загружен тестовый проект: ролик без пауз, с субтитрами и цветокоррекцией. Пробел запускает воспроизведение.',
    '',
    '  Сейчас приложение работает прямо из скачанного образа. В «Программы» оно так и не скопировано, поэтому после перезагрузки Mac образ отключится и приложение пропадёт.',
    '',
    '  Как открывать дальше:',
    '  1. Один раз установи (у меня на это нет разрешения):',
    '     ! cp -R /Volumes/FilmCraft/FilmCraft.app /Applications/ && hdiutil detach /Volumes/FilmCraft',
    '  2. Потом запускай так, чтобы Claude мог управлять открытым окном:',
    '     ! open -a FilmCraft --args --control 9876',
    '     Если открыть с иконки или через Spotlight, приложение будет работать, но Claude не сможет управлять окном. Резать видео без окна, через консоль, он сможет всё равно.',
    '',
    '✻ Cooked for 23s · done 5:29 PM',
  ].join('\n'));
});

test('a command Claude ran copies whole: a word that fit on a row was not cut, a long one was', () => {
  const rows = [
    '⏺ Bash(open -a FilmCraft --args --control',
    '      9876; for i in $(seq 1 15); do lsof',
    '      -nP -iTCP:9876 -sTCP:LISTEN >/dev/null',
    '      2>&1 && { echo "control up"; break;',
    '      }; sleep 1; do…)',
    '  ⎿ \u00a0control up',
    '     60103 /Volumes/FilmCraft/FilmCraft',
    '     .app/Contents/MacOS/FilmCraft --co',
    '     ntrol 9876',
    '  ⎿ \u00a0Allowed by auto mode classifier',
    '',
    "⏺ Bash(ssh root@host.internal 'date; curl -s",
    '      http://127.0.0.1:9093/api/v2/alerts?a',
    '      ctive=true | python3 -c "',
    '      import json,sys;',
    '      a=json.load(sys.stdin)…)',
    '',
    "⏺ Bash(ssh root@host.internal 'curl -s http:",
    '      //127.0.0.1:3100/loki/api/v1/labels |',
    '      python3 -c "import json,sys;print(json',
    '      .load(sys.stdin)[\\"data\\"])"; for l in',
    '      job stre…)',
    '',
    '⏺ Bash(ls',
    '      tools/monitoring/grafana-dashboards/',
    '      && python3 -c "',
    '      import json,glob…)',
  ];
  assert.deepEqual(copyAll(rows).split('\n'), [
    // ">/dev/null" and "2>&1" are two words — the first just fit its row
    '⏺ Bash(open -a FilmCraft --args --control 9876; for i in $(seq 1 15); do lsof -nP -iTCP:9876 -sTCP:LISTEN >/dev/null 2>&1 && { echo "control up"; break; }; sleep 1; do…)',
    '  ⎿ \u00a0control up',
    // a tool's answer is cut letter by letter at its edge
    '     60103 /Volumes/FilmCraft/FilmCraft.app/Contents/MacOS/FilmCraft --control 9876',
    '  ⎿ \u00a0Allowed by auto mode classifier',
    '',
    // "-s" ended at the edge of its row; the address after it was cut in the middle
    "⏺ Bash(ssh root@host.internal 'date; curl -s http://127.0.0.1:9093/api/v2/alerts?active=true | python3 -c \"",
    '      import json,sys; a=json.load(sys.stdin)…)',
    '',
    "⏺ Bash(ssh root@host.internal 'curl -s http://127.0.0.1:3100/loki/api/v1/labels | python3 -c \"import json,sys;print(json.load(sys.stdin)[\\\"data\\\"])\"; for l in job stre…)",
    '',
    // a path that fit its own row was not cut: the "&&" after it is a word of its own
    '⏺ Bash(ls tools/monitoring/grafana-dashboards/ && python3 -c "',
    '      import json,glob…)',
  ]);
});

test('an answer keeps its own lines, a cut at a space gets its space back, and a diff stays as it is drawn', () => {
  const rows = [
    // Claude's text near it: a row of it reaches the edge of the window the answers were drawn in
    '⏺ Сервисы в целом чистые — в основном',
    '  таймауты к Телеграму и 17 отказов Метрики',
    '  у CRM за двое суток. Теперь разбираю 1238',
    '',
    '⏺ Bash(bin/filmcraft-cli --bridge',
    '      127.0.0.1:9876 --compact exec',
    '      file.open',
    '      path="$PWD/projects/test.fcproj")',
    '  ⎿ \u00a0{',
    '       "migrated": false,',
    '       "missingMedia": 0,',
    '     … +5 lines (ctrl+o to expand)',
    "  ⎿ \u00a0['top', 'journal', 'pg', 'nginx',",
    "     'cron', 'bots']",
    '     ok',
    '  ⎿ \u00a0 09:34:11 up 45 days, 10:31,  6 us',
    '     ers,  load average: 0.47, 0.54, 0.',
    '     58',
    // cut at a space that went to the start of the next row
    '  ⎿ \u00a0Заявка в «Фаранги»:',
    '     z (@someone12) не оплатил — письмо',
    '      об оплате не ушло: sendMessage',
    '',
    '⏺ Update(CLAUDE.md)',
    '  ⎿ \u00a0Added 4 lines, removed 2 lines',
    '      33 -**MCP `filmcraft-app`** — у',
    '         -правление ОТКРЫТЫМ приложен',
    '         -ием, человек видит монтаж в',
    '         - окне. Приложение',
  ];
  assert.deepEqual(copyAll(rows).split('\n'), [
    '⏺ Сервисы в целом чистые — в основном таймауты к Телеграму и 17 отказов Метрики у CRM за двое суток. Теперь разбираю 1238',
    '',
    '⏺ Bash(bin/filmcraft-cli --bridge 127.0.0.1:9876 --compact exec file.open path="$PWD/projects/test.fcproj")',
    '  ⎿ \u00a0{',
    '       "migrated": false,',
    '       "missingMedia": 0,',
    '     … +5 lines (ctrl+o to expand)',
    "  ⎿ \u00a0['top', 'journal', 'pg', 'nginx', 'cron', 'bots']",
    '     ok',
    '  ⎿ \u00a0 09:34:11 up 45 days, 10:31,  6 users,  load average: 0.47, 0.54, 0.58',
    '  ⎿ \u00a0Заявка в «Фаранги»:',
    '     z (@someone12) не оплатил — письмо об оплате не ушло: sendMessage',
    '',
    '⏺ Update(CLAUDE.md)',
    '  ⎿ \u00a0Added 4 lines, removed 2 lines',
    '      33 -**MCP `filmcraft-app`** — у',
    '         -правление ОТКРЫТЫМ приложен',
    '         -ием, человек видит монтаж в',
    '         - окне. Приложение',
  ]);
});

test('text drawn in a narrower window copies the same after the window got wider', () => {
  // the card lays the window out for 44 columns, the Terminals view for 88: the history keeps the rows of both
  assert.equal(copyBetween(OWNER, 'Как открывать', 'открытым окном:', { cols: 88 }), copyBetween(OWNER, 'Как открывать', 'открытым окном:'));
  // a line printed past Claude Code is wrapped by tmux again for every window: it says nothing of the width Claude drew in
  const link = `Printed raw: https://example.com/${'path/'.repeat(14)}end`;
  const widened = [...OWNER, '', link.slice(0, 88), link.slice(88)];
  assert.equal(copyBetween(widened, 'Как открывать', 'открытым окном:', { cols: 88, wraps: [OWNER.length + 2] }),
    copyBetween(OWNER, 'Как открывать', 'открытым окном:'));
  assert.equal(copyBetween(OWNER, 'Сейчас', 'пропадёт.', { cols: 88 }),
    'Сейчас приложение работает прямо из скачанного образа. В «Программы» оно так и не скопировано, поэтому после перезагрузки Mac образ отключится и приложение пропадёт.');
});

test('rows tmux wrapped go back together as they are, and the server names them', () => {
  // the window got narrower: tmux cut the old rows at its width, in the middle of words, a space at the end of one
  const rows = [
    'Permission allow rule (../../.claude/setting',
    's.json): Bash(rsync *root@host.internal:*)',
    'mixes * with the trailing :* prefix syntax,',
    '',
    '⏺ Done.',
  ];
  const joined = [
    'Permission allow rule (../../.claude/settings.json): Bash(rsync *root@host.internal:*) mixes * with the trailing :* prefix syntax,',
    '',
    '⏺ Done.',
  ];
  const wraps = wrapsIn(`${rows.join('\n')}\n`, `${joined.join('\n')}\n`);
  assert.deepEqual(wraps, [1, 2]);
  assert.equal(copyAll(rows, { wraps, cols: 44 }), `${joined[0]}\n\n⏺ Done.`);
  // a screen that does not match its joined copy: the rows found before the mismatch, nothing made up after it
  assert.deepEqual(wrapsIn('ab\ncd\nef\n', 'abcd\nXX\n'), [1]);
});

test('a selection within one row is the browser\'s, and part of a first row is copied from where it starts', () => {
  const s = OWNER.join('\n');
  const at = s.indexOf('скопировано');
  assert.equal(screenCopy(s, { cols: 44 }, at, at + 5), null);
  // backwards (the selection was made from the end) is the same selection
  const end = s.indexOf('пропадёт.') + 'пропадёт.'.length;
  assert.equal(screenCopy(s, { cols: 44 }, end, at), 'скопировано, поэтому после перезагрузки Mac образ отключится и приложение пропадёт.');
});

test('the copy event puts the joined text on the clipboard and leaves a one-row selection alone', () => {
  const text = OWNER.join('\n');
  const node = { kind: 'text' };
  const pre = { textContent: text, contains: (n) => n === node || n === pre };
  let sel;
  const prev = globalThis.document;
  globalThis.document = {
    getSelection: () => sel,
    createRange: () => {
      let end = 0;
      return { setStart() {}, setEnd(_n, off) { end = off; }, toString: () => text.slice(0, end) };
    },
  };
  try {
    wireTermCopy(pre, () => ({ wraps: [], cols: 44 }));
    const from = text.indexOf('! cp');
    const to = text.indexOf('/Volumes/FilmCraft\n') + '/Volumes/FilmCraft'.length;
    sel = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: from, endContainer: node, endOffset: to }) };
    const put = {};
    let prevented = false;
    pre.oncopy({ clipboardData: { setData: (t, v) => { put[t] = v; } }, preventDefault: () => { prevented = true; } });
    assert.equal(put['text/plain'], '! cp -R /Volumes/FilmCraft/FilmCraft.app /Applications/ && hdiutil detach /Volumes/FilmCraft');
    assert.ok(prevented, 'the browser copied the rows over the joined text');
    // the selection began above the screen: from the screen's start
    sel = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: { outside: true }, startOffset: 0, endContainer: node, endOffset: text.indexOf('субтитрами') }) };
    const put2 = {};
    pre.oncopy({ clipboardData: { setData: (t, v) => { put2[t] = v; } }, preventDefault() {} });
    assert.equal(put2['text/plain'], '⏺ FilmCraft открыт, и в нём загружен тестовый проект: ролик без пауз, с');
    const one = text.indexOf('9876');
    sel = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: one, endContainer: node, endOffset: one + 4 }) };
    prevented = false;
    pre.oncopy({ clipboardData: { setData() { throw new Error('a one-row copy was rewritten'); } }, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
  } finally {
    globalThis.document = prev;
  }
});

test('the card and the Terminals view copy their screens by the rows they drew', () => {
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  assert.match(drawer, /wireTermCopy\(pre, \(\) => termLayout\)/, 'the card\'s screen copies its rows as they are');
  // the layout is the drawn screen's: taken where the screen is drawn, not where an answer comes held under a selection
  const render = drawer.slice(drawer.indexOf('function renderTerminal('), drawer.indexOf('function markTermTab('));
  const draw = render.slice(render.indexOf("  const text = r.screen || '';"), render.indexOf('\n}\n'));
  const pre = { textContent: 'old', scrollTop: 0, scrollHeight: 100, contains: () => true };
  const sel = { isCollapsed: true };
  const box = { pre, r: { session: 's1', screen: 'new', wraps: [3], cols: 45 }, termScreen: 'old', termScreenOf: 's1', termFollow: true,
    termPressed: false, termLayout: null, rolledBy: () => 0, selectingIn: () => !sel.isCollapsed, document: { getSelection: () => sel } };
  box.globalThis = box;
  vm.runInNewContext(`this.draw = () => {\n${draw}\n};`, box);
  box.draw();
  assert.deepEqual({ ...box.termLayout, wraps: [...box.termLayout.wraps] }, { wraps: [3], cols: 45 });
  sel.isCollapsed = false;
  box.r = { session: 's1', screen: 'newer', wraps: [9], cols: 60 };
  box.draw();
  assert.equal(pre.textContent, 'new');
  assert.deepEqual({ ...box.termLayout, wraps: [...box.termLayout.wraps] }, { wraps: [3], cols: 45 }, 'the layout of a screen not drawn went with the drawn one');
  const terms = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  assert.match(terms, /wireTermCopy\(pre, \(\) => c\.layout \|\| \{\}\)/);
  assert.match(terms, /c\.screen = text;\n\s*c\.layout = \{ wraps: r\.wraps \|\| \[\], cols: r\.cols \|\| 0 \}/);
});

// width the text was drawn in — the commands Claude ended one by one went together into one broken line.
test('a short screen tells no narrower width: lines Claude ended stay apart', () => {
  const screen = (lines) => [
    '╭──────────────────────────────────────────╮',
    '│ ✻ Welcome to Claude Code!                │',
    '╰──────────────────────────────────────────╯',
    '',
    '❯ как собрать?',
    '',
    '⏺ Запусти по очереди:',
    '',
    ...lines.map((l) => `  ${l}`),
    '',
    '─'.repeat(70),
    '❯ ',
    '─'.repeat(70),
  ];
  for (const lines of [['git add -A', 'git commit -m "fix copy"', 'git push'], ['npm install', 'npm run build', 'pm2 restart app'],
    ['git add -A', 'git commit -m "copy the rows Claude wrote, not the screen"', 'git push']]) {
    assert.equal(copyBetween(screen(lines), lines[0], lines[2], { cols: 70 }), lines.join('\n'));
  }
  const answer = ['⏺ Bash(ls src)', '  ⎿  app.js', '     db.js', '     main.js', '     util.js', ''];
  assert.equal(copyBetween(answer, 'app.js', 'util.js', { cols: 70 }), 'app.js\ndb.js\nmain.js\nutil.js');
});

// longer than that (the usual case), and rows tmux wrapped copy broken again; the short screens of the tests did not see it.
test('the screen and its joined copy are captured from the same depth of history', () => {
  const src = readFileSync(new URL('../src/phantom.js', import.meta.url), 'utf8');
  const view = src.slice(src.indexOf('export async function phantomView'), src.indexOf('if (r.err) return null;', src.indexOf('export async function phantomView')));
  const depths = [...view.matchAll(/\['capture-pane', '-p', (?:'-J', )?'-S', ([^,]+),/g)].map((m) => m[1]);
  assert.equal(depths.length, 2, 'phantomView no longer captures the screen and its joined copy');
  assert.equal(depths[0], depths[1], 'the joined copy is captured from another depth than the screen');
});

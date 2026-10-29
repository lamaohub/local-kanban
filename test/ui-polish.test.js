import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');

function pluralIn(lang) {
  const src = read('settings.js');
  const tableAt = src.indexOf('const PLURAL_RU = {');
  const table = src.slice(tableAt, src.indexOf('\n};', tableAt) + 3);
  const fnAt = src.indexOf('export function plural(');
  const fn = src.slice(fnAt, src.indexOf('\n}\n', fnAt) + 2).replace('export ', '');
  const box = {};
  vm.runInNewContext(`const LANG = ${JSON.stringify(lang)};\n${table}\n${fn}\nout.plural = plural;`, { out: box });
  return box.plural;
}

test('the subfolder count is declined in Russian and plain in English', () => {
  const ru = pluralIn('ru');
  const form = (n) => ru(n, 'subfolder', 'subfolders');
  const [one, few, many] = [form(1), form(2), form(5)];
  assert.notEqual(one, 'subfolder', 'there is no Russian entry for subfolder — the English word shows on a Russian board');
  assert.equal(new Set([one, few, many]).size, 3, 'Russian needs three forms here: 1, 2 and 5 subfolders');
  for (const [n, want] of [[21, one], [22, few], [24, few], [11, many], [12, many], [14, many], [25, many], [0, many], [101, one]]) {
    assert.equal(form(n), want, `wrong form for ${n}`);
  }
  const en = pluralIn('en');
  assert.equal(en(1, 'subfolder', 'subfolders'), 'subfolder');
  assert.equal(en(2, 'subfolder', 'subfolders'), 'subfolders');
  assert.match(read('sidebar.js'), /\$\{r\.dirs\.length\} \$\{plural\(r\.dirs\.length, 'subfolder', 'subfolders'\)\}/,
    'checkPath prints the count with an undeclined word again');
});

test('the day header of the recent events declines its count', () => {
  const ru = pluralIn('ru');
  const form = (n) => ru(n, 'event', 'events');
  assert.notEqual(form(1), 'event', 'there is no Russian entry for event');
  assert.equal(new Set([form(1), form(2), form(5)]).size, 3);
  const en = pluralIn('en');
  assert.equal(en(1, 'event', 'events'), 'event');
  assert.equal(en(3, 'event', 'events'), 'events');
  assert.match(read('settings.js'), /\$\{evs\.length\} \$\{plural\(evs\.length, 'event', 'events'\)\}/,
    'feedHTML prints the count of events with an undeclined word again');
});

test('fractions on the Russian dashboard and in sizes use the locale, not a dot', () => {
  const dash = read('dash.js');
  assert.doesNotMatch(dash, /\.toFixed\(/, 'dash.js prints a fraction with toFixed — always a dot');
  assert.match(dash, /fmtNum\(s\.cycle_hours_period\)/);
  assert.match(read('core.js'), /export const fmtNum = \(n, digits = 1\) => Number\(n\)\.toLocaleString\(LANG === 'ru' \? 'ru-RU' : 'en-US'/);
  const settings = read('settings.js');
  assert.match(settings, /\$\{fmtNum\(file\.size \/ 1048576\)\} \$\{tr\('MB'\)\}/);
  assert.match(settings, /\$\{fmtNum\(a\.db_size \/ 1048576\)\} \$\{tr\('MB'\)\}/);
});

test('a built-in section name is translated on the project settings page', () => {
  const project = read('project.js');
  assert.match(project, /const label = \(v\) => \(v === '__new__' \? tr\('New section…'\) : tr\(v\)\);/,
    'the section dropdown shows the raw "Other"/"Local" again');
  assert.match(project, /: esc\(label\(v\)\)\}<\/div>/, 'the options bypass the translated label');
});

test('a right-click change and a comment sent while the server is down are queued and shown', () => {
  const drawer = read('drawer.js');
  const menu = drawer.slice(drawer.indexOf('export function openCardMenu('), drawer.indexOf('async function copyTaskLink('));
  assert.match(menu, /if \(e\?\.offline\) \{ queueTaskEdit\(t\.key, body\); return 'queued'; \}/,
    'a right-click change is lost without a badge when the server is down');
  assert.doesNotMatch(menu, /t\.labels = cur;/, 'the label is written on the card before the server took it again');
  assert.match(menu, /if \(res === 'saved'\) t\.labels = sent;/);
  const init = read('init.js');
  const send = init.slice(init.indexOf("$('c-send').onclick"), init.indexOf("$('c-input').addEventListener('keydown'"));
  assert.match(send, /queueComment\(key, body\);/, 'a comment sent while the server is down is lost without a badge');
  assert.match(send, /if \(!e\?\.offline\) \{ sayRefused\(e, key\); return; \}/, 'a refused comment says nothing again, or says it in the English of the server');
});

test('backup times and skill dates are local, and the snapshot size reads by the locale', () => {
  const settings = read('settings.js');
  const take = (head) => {
    const at = settings.indexOf(head);
    assert.ok(at >= 0, `${head} is gone from settings.js`);
    return settings.slice(at, settings.indexOf('\n}\n', at) + 2).replace('export ', '');
  };
  const box = {};
  vm.runInNewContext(`${take('export function ymdLocal(')}\n${take('function fmtLocalStamp(')}\nout.stamp = fmtLocalStamp;`, { out: box });
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Novosibirsk';
  try {
    assert.equal(box.stamp('2026-10-04T20:30:00.000Z'), '2026-10-05 03:30', 'a UTC evening must read as the next local morning');
    assert.equal(box.stamp('2026-10-05T08:40:02.493Z'), '2026-10-05 15:40');
    assert.equal(box.stamp('not a time'), 'not a time', 'a value that is not a time is shown as it came');
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.match(settings, /const stamp = \(iso\) => esc\(fmtLocalStamp\(iso\)\);/, 'the Backups section prints UTC times again');
  assert.match(settings, /\$\{stamp\(b\.mtime\)\}<\/span>/, 'a snapshot row prints its time past the local conversion');
  assert.match(settings, /\$\{fmtNum\(b\.size \/ 1048576\)\} \$\{tr\('MB'\)\}/, 'the snapshot size is printed with a dot on the Russian board again');
  assert.match(settings, /fmtLocalStamp\(s\.mtime\)\.slice\(0, 10\)/, 'the skill date is the UTC date again');
});

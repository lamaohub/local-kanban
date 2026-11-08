import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAYCAST = join(ROOT, 'scripts', 'raycast', 'open-kanban.sh');

test('the Raycast command keeps the directives Raycast needs to register it', () => {
  assert.ok(existsSync(RAYCAST), 'scripts/raycast/open-kanban.sh is part of the package');
  const text = readFileSync(RAYCAST, 'utf8');
  // schemaVersion and title are mandatory; without title the command does not appear at all
  for (const directive of ['@raycast.schemaVersion', '@raycast.title', '@raycast.mode']) {
    const line = text.split('\n').find((l) => l.trim().startsWith(`# ${directive}`));
    assert.ok(line, `${directive} is missing — Raycast would not register the command`);
    assert.ok(line.trim().length > `# ${directive}`.length + 1, `${directive} has no value`);
  }
  assert.match(text, /^#!/, 'the shebang survives');
  assert.doesNotMatch(text, /[\u0430-\u044f\u0451\u0410-\u042f\u0401]/,
    'a shipped shell script is English, so nothing gets stripped out of it');
});

test('every package.json script points at a path the package actually ships', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ships = (path) => pkg.files.some((f) => (f.endsWith('/') ? path.startsWith(f) : path === f));

  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const token of cmd.split(/\s+/)) {
      if (!/^[\w./-]+\.(js|cjs|mjs|sh)$/.test(token)) continue;
      assert.ok(existsSync(join(ROOT, token)), `${name}: ${token} does not exist`);
      assert.ok(ships(token), `${name}: ${token} is not in "files", so the script cannot run in the package`);
    }
  }
  assert.equal(pkg.scripts?.test, undefined,
    'there is no test script: test/ is not published, so it would pass without running anything');
});

test('the package can refresh the skills it copied', () => {
  const cli = readFileSync(new URL('../bin/local-kanban', import.meta.url), 'utf8');
  assert.match(cli, /local-kanban skills/, 'the skills subcommand disappeared from the help');
  assert.match(cli, /if \(cmd === 'skills'\)/, 'there is no way to refresh the skills after an update again');
  assert.match(cli, /function installSkills\(/, 'the wizard and the refresh no longer share one implementation');
});

test('the update hint matches how the board was installed', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /const updateHint = \(\) => \(about\?\.packaged/,
    'the About section tells an npm install to run npm run update, which it does not have');
  for (const name of ['README.md', 'README.ru.md']) {
    const readme = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(readme, /npm install -g local-kanban@latest/, `${name} only explains how to update a clone`);
  }
});

test('the contrib bootstrap points at an example that exists and matches what it reads', () => {
  const script = readFileSync(join(ROOT, 'contrib', 'bootstrap.js'), 'utf8');
  assert.match(script, /seed-projects\.example\.json/,
    'the missing-seed message stopped naming the example to copy');
  assert.doesNotMatch(script, /seed-from-panel/,
    'the message sends the reader to a file that is not in git again');

  const example = join(ROOT, 'contrib', 'seed-projects.example.json');
  assert.ok(existsSync(example), 'the example the message tells you to copy is missing');
  const seed = JSON.parse(readFileSync(example, 'utf8'));
  assert.ok(Array.isArray(seed) && seed.length, 'the example is a JSON array of projects');
  for (const p of seed) assert.ok(p.slug && p.name, 'every example project carries the required slug and name');

  const read = [...script.matchAll(/\w+: p\.(\w+)/g)].map((m) => m[1]);
  for (const key of Object.keys(seed[0])) {
    assert.ok(read.includes(key), `${key} is in the example but bootstrap.js never reads it`);
  }
});

test('the changelog is edited under Unreleased, not inside a version that already shipped', () => {
  const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const heads = [...log.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
  assert.equal(heads[0], 'Unreleased', 'the top section of the changelog must be [Unreleased] — that is where new notes go');
  assert.equal(heads.filter((h) => h === 'Unreleased').length, 1, 'there is exactly one [Unreleased] section');
  const versions = heads.slice(1);
  assert.ok(versions.length, 'the changelog has no version sections at all');
  const odd = versions.find((v) => !/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(v));
  assert.ok(!odd, `every section below Unreleased is a version, but there is [${odd}]`);
  // the number of a prerelease comes last, and a release (Infinity) stands above its own betas
  const num = (v) => { const [core, pre] = v.split('-'); return [...core.split('.').map(Number), pre ? Number(pre.split('.')[1]) : Infinity]; };
  const cmp = (a, b) => { const [x, y] = [num(a), num(b)]; for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; };
  assert.equal(versions[0], pkg.version,
    `the newest changelog section is ${versions[0]} but the package is ${pkg.version} — version sections are written by releasing, not by hand`);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(cmp(versions[i - 1], versions[i]) > 0, `changelog sections out of order: ${versions[i - 1]} above ${versions[i]}`);
  }
});

test('the request to support the project points at a page that exists', () => {
  assert.ok(existsSync(join(ROOT, 'docs', 'COMMERCIAL.md')), 'docs/COMMERCIAL.md is missing');
  for (const name of ['README.md', 'README.ru.md']) {
    assert.match(readFileSync(join(ROOT, name), 'utf8'), /\(docs\/COMMERCIAL\.md\)/,
      `${name} no longer links to the page that explains it`);
  }
  const settings = readFileSync(join(ROOT, 'public', 'js', 'settings.js'), 'utf8');
  assert.match(settings, /github\.com\/[\w.-]+\/[\w.-]+\/blob\/main\/docs\/COMMERCIAL\.md/,
    'the About section stopped linking to the page');
});

// grep -q leaves on the first match and curl dies writing the rest (code 23): under pipefail a good page failed the
// step whenever curl had not finished in time. A shell line goes on after a trailing backslash, and the workflows
// wrap long commands that way: the lines are joined before looking, or `curl … \` + `| grep -q …` slips past.
// (`| tee … |`), `egrep`/`fgrep`, `-q` after the pattern, `-m 1` and `-l` (they leave on the first match too) and a `|`
// inside the quoted URL all passed. The text is read as shell now: pipelines split on `|`/`|&` (quotes, comments and a
// newline after a pipe respected; `(…)`, `{ …; }` and `$(…)` read on their own), and any grep that leaves early anywhere
// downstream of a curl in the same pipeline is a finding — every stage between dies of the same SIGPIPE.
/** The pipelines of a shell text: [[{ words, groups }, …], …] — words unquoted, the text of each group kept to read. */
function pipelines(sh) {
  const text = sh.replace(/\\[ \t]*\r?\n/g, ' ');
  const out = []; let pipe = []; let stage = { words: [], groups: [] }; let word = null;
  const endWord = () => { if (word !== null) { stage.words.push(word); word = null; } };
  const endStage = () => { endWord(); if (stage.words.length || stage.groups.length) pipe.push(stage); stage = { words: [], groups: [] }; };
  const endPipe = () => { endStage(); if (pipe.length) out.push(pipe); pipe = []; };
  const add = (s) => { word = (word ?? '') + s; };
  const matching = (i, open, close) => {
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\\') j += 1;
      else if (ch === '\'' || ch === '"') { const e = text.indexOf(ch, j + 1); j = e < 0 ? text.length : e; } else if (ch === open) depth += 1;
      else if (ch === close) { depth -= 1; if (!depth) return j; }
    }
    return text.length;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') { add(text[i + 1] ?? ''); i += 1; } else if (c === '\'') {
      const e = text.indexOf('\'', i + 1); const to = e < 0 ? text.length : e;
      add(text.slice(i + 1, to)); i = to;
    } else if (c === '"') {
      let j = i + 1; let s = '';
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === '\\') { s += text[j + 1] ?? ''; j += 1; } else if (text[j] === '$' && text[j + 1] === '(') { const e = matching(j + 1, '(', ')'); stage.groups.push(text.slice(j + 2, e)); s += '$'; j = e; } else s += text[j];
      }
      add(s); i = j;
    } else if (c === '$' && text[i + 1] === '(') { const e = matching(i + 1, '(', ')'); stage.groups.push(text.slice(i + 2, e)); add('$'); i = e; } else if (c === '`') {
      const e = text.indexOf('`', i + 1); const to = e < 0 ? text.length : e;
      stage.groups.push(text.slice(i + 1, to)); add('$'); i = to;
    } else if (c === '#' && word === null) { const e = text.indexOf('\n', i); i = (e < 0 ? text.length : e) - 1; } else if (c === '(' && word === null) { const e = matching(i, '(', ')'); stage.groups.push(text.slice(i + 1, e)); i = e; } else if (c === '{' && word === null && /\s/.test(text[i + 1] ?? '')) { const e = matching(i, '{', '}'); stage.groups.push(text.slice(i + 1, e)); i = e; } else if (c === '|' && text[i + 1] === '|') { endPipe(); i += 1; } else if (c === '|' && !/[<>]$/.test(word ?? '')) {
      endStage();
      if (text[i + 1] === '&') i += 1; // |& — stderr too, the same pipe
      while (/\s/.test(text[i + 1] ?? '')) i += 1; // a pipe at the end of a line goes on below
    } else if (c === '&' && text[i + 1] === '&') { endPipe(); i += 1; } else if (c === '&' && !/[<>]$/.test(word ?? '') && text[i + 1] !== '>') endPipe();
    else if (c === ';' || c === '\n') endPipe();
    else if (/\s/.test(c)) endWord();
    else if ((c === ')' || c === '}') && word === null) { /* the end of a group read elsewhere */ } else add(c);
  }
  endPipe();
  return out;
}
// the program of a stage: past VAR=value, `!`, `if`/`then`/…, and wrappers with their options
const SKIP = new Set(['!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'command', 'exec', 'time', 'env', 'nice', 'nohup', 'stdbuf', 'sudo', 'xargs']);
const programOf = (words) => {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || SKIP.has(words[i]) || (i && /^-/.test(words[i])))) i += 1;
  return { name: (words[i] || '').replace(/^.*\//, ''), args: words.slice(i + 1) };
};
// grep leaves on the first match with -q/--quiet/--silent, -m N/--max-count, -l/-L — wherever they stand among its arguments
const GREP_WITH_VALUE = /^--(?:regexp|file|max-count|after-context|before-context|context|devices|directories|binary-files|label|include|exclude|exclude-from|exclude-dir)$/;
function leavesEarly(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') return false;
    if (/^--(?:quiet|silent|max-count(?:=.*)?|files-with-matches|files-without-match)$/.test(a)) return true;
    if (GREP_WITH_VALUE.test(a)) { i += 1; continue; }
    if (!/^-[^-]/.test(a)) continue;
    for (let k = 1; k < a.length; k += 1) {
      if ('qlLm'.includes(a[k])) return true;
      if ('efABCdD'.includes(a[k])) { if (k === a.length - 1) i += 1; break; } // its value: the rest of the word or the next one
    }
  }
  return false;
}
const groupsOnly = (stage) => !stage.words.length;
const startsCurl = (stage) => programOf(stage.words).name === 'curl' || (groupsOnly(stage) && stage.groups.some((g) => pipelines(g).some((p) => p.some(startsCurl))));
const quietGrep = (stage) => {
  const { name, args } = programOf(stage.words);
  if (/^[ef]?grep$/.test(name)) return leavesEarly(args);
  return groupsOnly(stage) && stage.groups.some((g) => pipelines(g).some((p) => p.some(quietGrep)));
};
const pipesCurlIntoQuietGrep = (sh) => pipelines(sh).some((p) => {
  const from = p.findIndex(startsCurl);
  return (from >= 0 && p.slice(from + 1).some(quietGrep)) || p.some((s) => s.groups.some((g) => pipesCurlIntoQuietGrep(g)));
});

test('the install check asks for the page, not only for the API', () => {
  for (const wf of ['test.yml', 'publish.yml']) {
    const yml = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.match(yml, /<div id="board"/, `${wf} would stay green on a package built without public/`);
  }
  // every workflow there is (release-check.yml is private and not in the published slice)
  const dir = join(ROOT, '.github', 'workflows');
  for (const wf of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const yml = readFileSync(join(dir, wf), 'utf8');
    assert.equal(pipesCurlIntoQuietGrep(yml), false, `${wf} pipes curl into an early-leaving grep, which fails at random under pipefail`);
    // and the reading did not lose the file: a stray quote that swallows the text would also read as "no finding"
    if (/\bcurl\s/.test(yml)) assert.ok(pipelines(yml).some((p) => p.some(startsCurl)), `${wf}: the curl in it is not read as a program`);
  }
  const URL_ = 'http://127.0.0.1:3199/';
  const caught = [
    `curl -fsS ${URL_} | grep -q board`,
    `curl -fsS ${URL_} \\\n            | grep -q board \\\n            || exit 1`,
    `curl -fsS ${URL_} | \\\n  grep -q board`,
    `curl -fsS ${URL_} |grep -Fq board`,
    `curl -fsS ${URL_} | grep -F --quiet board`,
    `curl -fsS ${URL_} |& grep -q board`,
    `curl -fsS ${URL_} | grep -e board -q`, `curl -fsS ${URL_} | grep board -q`, // -q after the pattern
    `curl -fsS ${URL_} | tee /dev/null | grep -q board`, `curl -fsS ${URL_} | cat | sed s/a/b/ | grep -q board`, // stages between
    `curl -fsS ${URL_} | egrep -q board`, `curl -fsS ${URL_} | fgrep -q board`, `curl -fsS ${URL_} | /usr/bin/grep -q board`,
    `curl -fsS ${URL_} | grep -m1 board >/dev/null`, `curl -fsS ${URL_} | grep -m 1 board >/dev/null`, // -m N
    `curl -fsS ${URL_} | grep --max-count=1 board`, `curl -fsS ${URL_} | grep -c -m1 board`, `curl -fsS ${URL_} | grep -l board`,
    `curl -fsS "${URL_}?a|b" | grep -q board`, // a | in the quoted URL
    `curl -fsS ${URL_} \\   \n  | grep -q board`, // spaces after the backslash
    `curl -fsS ${URL_} |\n  grep -q board`, // a pipe at the end of the line
    `( curl -fsS ${URL_} ) | grep -q board`, `{ curl -fsS ${URL_}; } | grep -q board`, `curl -fsS ${URL_} | { grep -q board; }`,
    `test "$(curl -fsS ${URL_} | grep -q board && echo y)" = y`, `if curl -fsS ${URL_} | grep -q board; then echo ok; fi`,
  ];
  for (const sh of caught) assert.equal(pipesCurlIntoQuietGrep(sh), true, `not seen: ${JSON.stringify(sh)}`);
  const fine = [
    `curl -fsS -o "$RUNNER_TEMP/page.html" ${URL_} \\\n  || { echo no; exit 1; }\ngrep -q board "$RUNNER_TEMP/page.html"`,
    `curl -fsS ${URL_} >/dev/null\necho ok | grep -q ok`,
    `curl -fsS ${URL_} | grep board`, `curl -fsS ${URL_} | grep -c board`, `curl -fsS ${URL_} | grep -e -q board`,
    `curl -fsS ${URL_} | grep -- -q`, `curl -fsS ${URL_} && echo ok | grep -q ok`, `curl -fsS ${URL_} || echo no | grep -q no`,
    `grep -q board page.html | curl -fsS -T - ${URL_}`, `echo "curl x | grep -q y"`, `# curl ${URL_} | grep -q board`,
    `x=$(curl -fsS ${URL_}) && echo "$x" | grep -q board`,
  ];
  for (const sh of fine) assert.equal(pipesCurlIntoQuietGrep(sh), false, `seen where there is none: ${JSON.stringify(sh)}`);
});

test('the release script leaves npm to CI and says how to check it', (t) => {
  const path = new URL('../scripts/release.js', import.meta.url);
  if (!existsSync(path)) return t.skip('scripts/release.js is a private tool and is not part of the published slice');
  const src = readFileSync(path, 'utf8');
  const todo = src.slice(src.lastIndexOf('Left to do by hand'));
  assert.doesNotMatch(todo, /npm publish/, 'the release still tells you to publish to npm by hand');
  assert.match(todo, /CI publishes it from the tag/);
  assert.match(todo, /npm view \$\{pkg\.name\} version/, 'there is no way named to check that the package went out');
  assert.match(todo, /git pull && npm install && pm2 restart kanban/, 'the personal board is updated without npm install');
  // and the promise is true: the publish workflow runs on a version tag and publishes
  const yml = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(yml, /tags: \['v\*'\]/);
  assert.match(yml, /npm publish/);
});

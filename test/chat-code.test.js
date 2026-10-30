// command, and the block cut it at the chat's edge. Every block of code in the chat copies; a block of a shell also runs
// in a new Terminal window — only a block Claude wrote in the task's session, byte for byte, and only from the board's
// page. The page draws the blocks (public/js/chat-md.js), the server checks them (src/chat-feed.js): the same split.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SID = 'cccccccc-1111-4111-8111-cccccccccccc';
const OTHER = 'dddddddd-2222-4222-8222-dddddddddddd';
const SSH = 'ssh -t root@10.0.0.5 "nano /root/site/.env"';
const WORDS = `**What I need from you:** change the PIN:\n\`\`\`\n${SSH}\n\`\`\`\nThen run \`pm2 restart site\`.\n\n\`\`\`bash title=x\nnpm test\nnpm run lint\n\`\`\`\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n\n\`\`\`sh\n\ncd web\n\`\`\`\n\nAnd at the end, cut off:\n\`\`\`bash\nrm -rf build`;
let app, root, folder, md, feed, launch;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'kb-chat-code-'));
  process.env.KB_DATA_DIR = join(root, 'data');
  process.env.KB_CLAUDE_DIR = join(root, 'claude');
  process.env.KB_LAUNCH_DRYRUN = '1';
  folder = join(root, 'site');
  mkdirSync(folder);
  mkdirSync(join(root, 'claude', 'projects', '-site'), { recursive: true });
  const line = (o) => `${JSON.stringify(o)}\n`;
  writeFileSync(join(root, 'claude', 'projects', '-site', `${SID}.jsonl`),
    line({ type: 'user', timestamp: '2026-10-23T05:00:00.000Z', message: { role: 'user', content: 'check TPF-7' } })
    + line({ type: 'assistant', timestamp: '2026-10-23T05:00:05.000Z', message: { content: [{ type: 'text', text: WORDS }] } })
    // acceptance: blocks in the person's words, in what a command returned, in a helper's line — none is Claude's command
    + line({ type: 'user', timestamp: '2026-10-23T05:00:06.000Z', message: { role: 'user', content: 'and this one?\n```bash\necho PERSON\n```' } })
    + line({ type: 'assistant', timestamp: '2026-10-23T05:00:07.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_C', name: 'Bash', input: { command: 'cat notes.md' } }] } })
    + line({ type: 'user', timestamp: '2026-10-23T05:00:08.000Z', toolUseResult: { stdout: '```bash\necho RESULT\n```' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_C', content: '```bash\necho RESULT\n```' }] } })
    + line({ type: 'assistant', isSidechain: true, timestamp: '2026-10-23T05:00:09.000Z', message: { content: [{ type: 'text', text: '```bash\necho HELPER\n```' }] } }));
  const { db } = await import('../src/db.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('site','ST','Site',?,2)").run(folder);
  // review: a project without a folder — the command would run in the home folder
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('loose','LO','Loose',2)").run();
  const lid = db.prepare("SELECT id FROM projects WHERE slug='loose'").get().id;
  const lt = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'No folder','review')").run(lid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-23 05:00:00', '2026-10-23 05:00:05')").run(lt, SID);
  const pid = db.prepare("SELECT id FROM projects WHERE slug='site'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'PIN','review')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-23 05:00:00', '2026-10-23 05:00:05')").run(task, SID);
  md = await import('../public/js/chat-md.js');
  feed = await import('../src/chat-feed.js');
  launch = await import('../src/launch.js');
  app = Fastify();
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

test('the page and the server cut Claude\'s words into the same blocks, and agree on what a command is', () => {
  assert.deepEqual(md.SHELL_LANGS, feed.SHELL_LANGS, 'the page and the server disagree on the languages of a command');
  const texts = [WORDS, '```\nunclosed\nblock', 'no code', '  ```sh\nls -la\n  ```', '```ZSH extra words\necho "a\'b"\n```', '```\n\n```'];
  for (const t of texts) {
    const html = md.chatText(t, (lang, closed) => `<i data-lang="${lang}" data-closed="${closed}"></i>`);
    const drawn = [...html.matchAll(/<pre class="chat-code">([^]*?)<\/pre><i data-lang="([^"]*)" data-closed="(true|false)"><\/i>/g)]
      .map((m) => ({ lang: m[2], code: m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), closed: m[3] === 'true' }));
    assert.deepEqual(drawn, feed.codeBlocks(t), `the blocks of ${JSON.stringify(t)} differ`);
  }
  const blocks = feed.codeBlocks(WORDS);
  assert.deepEqual(blocks.map((b) => b.lang), ['', 'bash', 'js', 'sh', 'bash']);
  assert.deepEqual(blocks.map((b) => b.closed), [true, true, true, true, false], 'a block left open is taken for a whole one');
  assert.equal(blocks[0].code, SSH);
  // the buttons: copy on every block, run on a block of a shell only; with no tools — the block alone, as before
  assert.doesNotMatch(md.chatText(WORDS), /chat-code-box/);
  assert.match(md.chatText('x', null), /^<p/);
});

test('the chat draws a copy button on every block and a run button on a command', async () => {
  const vm = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: (n) => `[${n}]`, plural: (k, a, b) => (k === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    chatText: md.chatText, SHELL_LANGS: md.SHELL_LANGS, questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [],
    document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false,
    setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false,
    copyText: async () => true, plainLabel: (x) => String(x),
  };
  vm.runInNewContext(`${src}\nthis.itemHTML = itemHTML;`, box);
  const html = box.itemHTML({ kind: 'text', text: WORDS });
  assert.equal((html.match(/data-code="copy"/g) || []).length, 6, 'a block of code has no copy button');
  assert.match(html, /<span class="chat-code-box chat-cmd"><span class="chat-code">pm2 restart site<\/span><span class="chat-code-tools">[^]*?<\/span><\/span>/);
  assert.equal((html.match(/data-code="run"/g) || []).length, 3, 'a command has no run button — or code of a language, or a block cut off, has one');
  assert.match(html, /<div class="chat-code-box"><pre class="chat-code">ssh -t root@10\.0\.0\.5 &quot;nano/);
  // a command longer than the board runs gets no run button — it would only be refused (the page's number is the route's)
  const { RUN_MAX } = await import('../src/routes/chat.js');
  const tools = (n) => box.itemHTML({ kind: 'text', text: '```bash\n' + 'x'.repeat(n) + '\n```' });
  assert.match(tools(RUN_MAX), /data-code="run"/);
  assert.doesNotMatch(tools(RUN_MAX + 1), /data-code="run"/, 'a command longer than RUN_MAX has a run button');
});

const run = (body, origin = 'http://127.0.0.1:3101') => app.inject({
  method: 'POST', url: '/api/tasks/ST-1/chat/run', payload: body, headers: origin ? { origin, 'sec-fetch-site': 'same-origin' } : {},
});

test('a command Claude wrote runs in a Terminal window, in the project folder', async () => {
  const r = await run({ session: SID, code: SSH });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.dry, true);
  assert.equal(b.folder, folder);
  // the block goes whole to the shell it names, one quoted word: the person's shell reads nothing of it
  const line = `cd ${launch.shellQuote(folder)} && bash -c ${launch.shellQuote(SSH)}`;
  if (process.platform === 'darwin') {
    assert.equal(b.cmd, 'osascript');
    // the AppleScript string carries the line exactly, quotes and all
    const literal = /do script (".*")$/.exec(b.args[1])[1];
    assert.equal(execFileSync('osascript', ['-e', `return ${literal}`], { encoding: 'utf8' }).replace(/\n$/, ''), line);
  } else {
    assert.deepEqual(b.args.slice(0, 3), ['-e', 'bash', '-lc']);
    // the shell the window keeps on a line of its own: after `cmd &` or a `# comment` line it was a syntax error or swallowed
    assert.equal(b.args[3], `${line}\nexec bash`);
  }
  // the shell of the Linux window parses what the board builds, a trailing `&` and a comment line too
  for (const code of ['sleep 0 &', 'true\n# done']) {
    const spec = launch.commandSpec({ code, folder }, 'linux');
    assert.doesNotThrow(() => execFileSync('/bin/sh', ['-n', '-c', spec.args[3]]), `the window's line of ${JSON.stringify(code)} is not shell`);
    assert.match(spec.args[3], /\nexec bash$/);
  }
  // the Mac's Terminal types the line into the person's interactive zsh (no options of theirs): the block does what it
  // says there — a `# comment` is a comment (first line or after a command: `rm -f x # old log` removed «old» and
  // «log»; `$(…)` in a comment ran), a `!` is a `!`, a ```bash block splits words as bash, a ```zsh one as zsh
  if (existsSync('/bin/zsh')) {
    const at = mkdtempSync(join(root, 'zsh-'));
    for (const f of ['old', 'log']) writeFileSync(join(at, f), '');
    const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, (m, c) => ({ n: '\n', r: '\r' }[c] ?? c)); // appleString backwards
    const typed = (code, lang) => {
      const spec = launch.commandSpec({ code, folder: at, lang }, 'darwin');
      const line = unquote(/do script (".*")$/s.exec(spec.args[1])[1]);
      // alone never ended it and a release started from a terminal stood here for good. Its own session has no terminal
      return spawnSync('/bin/zsh', ['-f', '-i'], { input: `${line}\n`, encoding: 'utf8', cwd: at, env: { PATH: '/usr/bin:/bin', HOME: at }, timeout: 10000, killSignal: 'SIGKILL', detached: true });
    };
    for (const code of ['rm -f nothing # old log', '# the first line, a comment\nprintf ok > made', '# needs $(touch ran)\ntrue']) {
      const r = typed(code, 'bash');
      assert.doesNotMatch(r.stderr, /command not found|parse error|unmatched/, `zsh read the block ${JSON.stringify(code)}: ${r.stderr}`);
    }
    assert.ok(existsSync(join(at, 'old')) && existsSync(join(at, 'log')), 'the words of a comment were the command\'s arguments: rm removed them');
    assert.equal(readFileSync(join(at, 'made'), 'utf8'), 'ok');
    assert.ok(!existsSync(join(at, 'ran')), 'a $(…) in a comment of the block ran');
    assert.match(typed('printf "%s\\n" "deployed!ok"', '').stdout, /^deployed!ok$/m, 'a ! of the block went to the history of zsh');
    assert.match(typed("printf ' don'\\''t '; echo", 'sh').stdout, / don't /, 'a quote of the block');
    const words = 'x="a b"; for w in $x; do echo "w=$w"; done';
    assert.match(typed(words, 'bash').stdout, /^w=a\r?\nw=b$/m, 'a ```bash block split its words the zsh way');
    assert.match(typed(words, 'zsh').stdout, /^w=a b$/m, 'a ```zsh block is not zsh\'s');
  }
  assert.equal((await run({ session: SID, code: 'npm test\nnpm run lint' })).statusCode, 200, 'a command of two lines is refused');
  // the page sends the block as the browser read it: the newline after <pre> dropped, \r made \n
  assert.equal((await run({ session: SID, code: 'cd web' })).statusCode, 200, 'a block starting with a blank line never runs');
  assert.equal((await run({ session: SID, code: 'npm test\r\nnpm run lint' })).statusCode, 200);
});

test('nothing runs that Claude did not write as a command, nor from anywhere but the board\'s page', async () => {
  const refused = async (body, code, reason, origin) => {
    const r = await run(body, origin);
    assert.equal(r.statusCode, code, `${JSON.stringify(body)}: ${r.body}`);
    if (reason) assert.equal(r.json().reason, reason);
  };
  await refused({ session: SID, code: 'rm -rf ~' }, 409, 'not-said');
  await refused({ session: SID, code: `${SSH} ` }, 409, 'not-said'); // byte for byte
  await refused({ session: SID, code: 'console.log(1)' }, 409, 'not-said'); // a block of code, not a command
  await refused({ session: SID, code: 'pm2 restart site' }, 409, 'not-said'); // `code` in the words, not a block
  await refused({ session: SID, code: 'rm -rf build' }, 409, 'not-said'); // a block left open: its end is not known
  // acceptance: a part of a command Claude wrote is not that command (`ssh … "nano …"` → `nano …`; one line of two)
  await refused({ session: SID, code: 'nano /root/site/.env' }, 409, 'not-said');
  await refused({ session: SID, code: 'npm run lint' }, 409, 'not-said');
  for (const code of ['echo PERSON', 'echo RESULT', 'echo HELPER']) await refused({ session: SID, code }, 409, 'not-said');
  await refused({ session: OTHER, code: SSH }, 404);
  await refused({ session: 'x', code: SSH }, 400);
  await refused({ session: SID, code: '' }, 400);
  await refused({ session: SID, code: 'a'.repeat(9000) }, 400);
  await refused({ session: SID, code: SSH }, 403, null, null); // kb, curl, a program — not the page
  const other = await app.inject({ method: 'POST', url: '/api/tasks/ST-1/chat/run', payload: { session: SID, code: SSH }, headers: { origin: 'http://127.0.0.1:3101', 'sec-fetch-site': 'cross-site' } });
  assert.equal(other.statusCode, 403, 'a page of another site ran a command');
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/ST-9/chat/run', payload: { session: SID, code: SSH }, headers: { origin: 'http://127.0.0.1:3101' } })).statusCode, 404);
  // a project with no folder: the command is not run in the home folder
  const loose = await app.inject({ method: 'POST', url: '/api/tasks/LO-1/chat/run', payload: { session: SID, code: SSH }, headers: { origin: 'http://127.0.0.1:3101' } });
  assert.equal(loose.statusCode, 409);
  assert.equal(loose.json().reason, 'no-folder');
});

// the page says each refusal in its own words — read from the real answers of the route (a reworded server text would
// turn back into «the board did not accept it»)
test('the page says why a command did not run, in the board\'s words', async () => {
  const { refusalText } = await import('../public/js/unsaved.js');
  const said = async (url, body) => {
    const r = await app.inject({ method: 'POST', url, payload: body, headers: { origin: 'http://127.0.0.1:3101' } });
    return refusalText({ status: r.statusCode, message: r.json().error }).reason;
  };
  assert.equal(await said('/api/tasks/ST-1/chat/run', { session: SID, code: 'rm -rf ~' }), 'Claude did not write this command in this chat — nothing was run');
  assert.equal(await said('/api/tasks/LO-1/chat/run', { session: SID, code: SSH }), 'the project has no folder on this computer — set it in the project, or copy the command');
});

// command in the window and said yes, and send exactly that
test('copy takes the whole block, and a command runs only after the window showed it whole and the person said yes', async () => {
  const vm = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const CODE = `${SSH}\nprintf '%s' "$(date)" # two lines, a comment`;
  const seen = { copied: [], asked: [], sent: [] };
  let answer = false;
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: (n) => `[${n}]`, plural: (k, a, b) => (k === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    chatText: md.chatText, SHELL_LANGS: md.SHELL_LANGS, questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [],
    document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false,
    setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {},
    styledConfirm: async (msg, o) => { seen.asked.push(o?.detail); return answer; },
    copyText: async (t) => { seen.copied.push(t); return true; }, plainLabel: (x) => String(x),
    api: async (method, url, body) => { seen.sent.push({ method, url, body }); return { ok: true }; },
  };
  vm.runInNewContext(`${src}\nthis.codeAction = codeAction;`, box);
  const button = (what) => ({ dataset: { code: what }, classList: { add() {}, remove() {} }, isConnected: false, innerHTML: '',
    closest: () => ({ querySelector: () => ({ textContent: CODE }) }) });
  const c = { key: 'ST-1', session: SID };
  await box.codeAction(c, button('copy'));
  assert.deepEqual(seen.copied, [CODE], 'the copy button copies less than the whole block');
  assert.deepEqual(seen.sent, [], 'a copy ran something');
  await box.codeAction(c, button('run'));
  assert.deepEqual(seen.asked, [CODE], 'the command runs without the window showing it whole');
  assert.deepEqual(seen.sent, [], 'a command ran though the person said no');
  answer = true;
  await box.codeAction(c, button('run'));
  assert.deepEqual(JSON.parse(JSON.stringify(seen.sent)), [{ method: 'POST', url: '/api/tasks/ST-1/chat/run', body: { session: SID, code: CODE } }]);
});

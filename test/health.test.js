// CLAUDE.md of the folder and of the folders above it, what they import with @ (not in code), rules without paths:,
// the part of the auto memory that loads; the person's own files apart, CLAUDE.md of subfolders apart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importsOf, ruleIsScoped, everywhere, projectHealth, healthView, NORMS, WALK_AT_ONCE } from '../src/health.js';
import { fileState, healthGroups, healthCounts, startTotal, walkBarHTML, walkPct } from '../public/js/health-rules.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-health-')));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (rel, text) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
const claude = join(root, 'claude');
process.env.KB_CLAUDE_DIR = claude;

test('imports are the @paths outside code spans and fenced blocks, with \\ for a space', () => {
  const text = 'See @docs/a.md and @~/b.md.\n`@not/this` either\n```\n@nor/this\n```\nand @Design\\ Docs/c.md\nmail a@b.c';
  assert.deepEqual(importsOf(text), ['docs/a.md', '~/b.md.', 'Design Docs/c.md']);
  assert.equal(ruleIsScoped('---\npaths:\n  - "src/**"\n---\nrule'), true);
  assert.equal(ruleIsScoped('---\ndescription: x\n---\nrule'), false);
  assert.equal(ruleIsScoped('no front matter'), false);
});

test('a project is measured as a session started in its folder reads it', async () => {
  put('claude/CLAUDE.md', 'mine\n@extra.md\n');
  put('claude/extra.md', 'x'.repeat(10));
  put('work/CLAUDE.md', 'parent\n');
  put('work/proj/CLAUDE.md', `${'line\n'.repeat(250)}@docs/more.md\n@missing.md\n`);
  put('work/proj/docs/more.md', 'm\n@../CLAUDE.md\n'); // a loop: CLAUDE.md is counted once
  put('work/proj/CLAUDE.local.md', 'local\n');
  put('work/proj/.claude/rules/always.md', 'always\n');
  put('work/proj/.claude/rules/scoped.md', '---\npaths:\n  - "src/**"\n---\nscoped\n');
  put('work/proj/src/CLAUDE.md', 'deep\n');
  put('work/proj/node_modules/x/CLAUDE.md', 'not a part of the project\n');
  put(`claude/projects/${join(root, 'work/proj').replace(/[^A-Za-z0-9-]/g, '-')}/memory/MEMORY.md`, `${'- note\n'.repeat(300)}`);

  const user = await everywhere();
  assert.deepEqual(user.files.map((f) => [f.kind, f.chars]), [['user', 15], ['import', 10]], 'the person\'s CLAUDE.md and what it imports');
  const p = await projectHealth(join(root, 'work/proj'), user.seen);
  assert.deepEqual(p.files.map((f) => f.kind), ['parent', 'main', 'import', 'local', 'rule', 'memory']);
  assert.deepEqual(p.main, { path: 'CLAUDE.md', chars: 1276, lines: 252 });
  assert.equal(p.files.find((f) => f.kind === 'memory').lines, 200, 'only the first 200 lines of the auto memory load');
  assert.deepEqual(p.nested.map((f) => [f.kind, f.path]), [['scoped', '.claude/rules/scoped.md'], ['nested', 'src/CLAUDE.md']],
    'a subfolder\'s CLAUDE.md and a rule with paths: are apart, the bigger first; node_modules is not walked');
  assert.equal(p.chars, p.files.reduce((n, f) => n + f.chars, 0));
});

test('the answer: a project without a folder, with a missing folder, and the groups of the page', async () => {
  const v = await healthView([
    { slug: 'a', name: 'A', path: join(root, 'work/proj') },
    { slug: 'b', name: 'B', path: null },
    { slug: 'c', name: 'C', path: join(root, 'gone') },
    { slug: 'd', name: 'D', path: join(root, 'work') },
  ]);
  assert.deepEqual(v.norms, NORMS);
  const [a, b, c, d] = v.projects;
  assert.equal(b.folder, null);
  assert.equal(c.missing, true);
  assert.equal(a.main.lines, 252);
  assert.equal(d.main.chars, 7);
  const g = healthGroups(v.projects, v.norms);
  assert.deepEqual(Array.from(g.own, (x) => x.slug), ['a', 'd'], 'the long one first');
  assert.deepEqual(Array.from(g.away, (x) => x.slug), ['b', 'c']);
  assert.equal(fileState({ chars: 40001, lines: 10 }, NORMS), 'heavy');
  assert.equal(fileState({ chars: 100, lines: 201 }, NORMS), 'long');
  assert.equal(fileState({ chars: 40000, lines: 200 }, NORMS), 'ok');
  assert.deepEqual(healthCounts(g.own, NORMS), { long: 1, heavy: 0 });
  assert.deepEqual(startTotal({ chars: 100000 }, { chars: 20001 }, NORMS), { chars: 120001, over: true });
});

test('CK-984: projects are measured several at a time, the answer keeps the order of the board, every step is told', async () => {
  const n = WALK_AT_ONCE * 2 + 1;
  const list = Array.from({ length: n }, (_, i) => {
    const dir = join(root, 'many', `p${i}`);
    // the first ones are the heaviest, so they finish last when measured at once
    put(`many/p${i}/CLAUDE.md`, 'x\n'.repeat((n - i) * 400));
    return { slug: `p${i}`, name: `P${i}`, path: dir };
  });
  list.splice(3, 0, { slug: 'none', name: 'None', path: null });
  const steps = [];
  const v = await healthView(list, (done, total) => steps.push([done, total]));
  assert.deepEqual(v.projects.map((p) => p.slug), list.map((p) => p.slug), 'the answer is in the order of the board');
  assert.equal(v.projects[0].main.lines, n * 400);
  assert.deepEqual(steps, Array.from({ length: list.length + 1 }, (_, i) => [i, list.length]), 'from 0 to all, one step per project');
  assert.equal((await healthView([], (d, t) => steps.push(['empty', d, t]))).projects.length, 0);
  assert.deepEqual(steps.at(-1), ['empty', 0, 0]);
});

test('CK-984: the bar of a walk — empty before the count is known, never past the end, numbers only', () => {
  assert.equal(walkPct(0, 0), 0);
  assert.equal(walkPct(5, 0), 0);
  assert.equal(walkPct(1, 3), 33);
  assert.equal(walkPct(9, 3), 100);
  assert.equal(walkPct('x', 3), 0);
  const empty = walkBarHTML('Measuring…', 0, 0, 'files');
  assert.match(empty, /data-walk="files"/);
  assert.match(empty, /class="hl-walk-n"><\/span>/, 'no «0 / 0» before the server knows the number');
  assert.match(empty, /width:0%/);
  const half = walkBarHTML('Measuring…', 31, 62);
  assert.match(half, /31 \/ 62/);
  assert.match(half, /width:50%/);
  assert.match(half, /aria-valuenow="31"/);
  assert.doesNotMatch(half, /data-walk/);
  assert.match(walkBarHTML('L', 70, 62), /62 \/ 62.*width:100%/s, 'more done than all reads as all');
  assert.doesNotMatch(walkBarHTML('L', '<b>', '<i>'), /<b>|<i>/, 'what the server sends goes in as a number');
});

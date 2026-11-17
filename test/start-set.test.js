// the request after the kanban skill is loaded, the parts in characters; a median per project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const tmp = mkdtempSync(join(tmpdir(), 'kb-start-'));
const claude = join(tmp, 'claude');
const dir = join(claude, 'projects', '-start');
let db, S, app;
before(async () => {
  mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: claude });
  ({ db } = await import('../src/db.js'));
  S = await import('../src/start-set.js');
  app = Fastify();
  await app.register((await import('../src/routes/health.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const L = (o) => JSON.stringify(o);
const at = (n) => new Date(Date.now() - 3600_000 + n * 1000).toISOString();
const usage = (read, write = 0, input = 3) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 });
function transcript({ first, skill, instructions = 'I'.repeat(1000) }) {
  return [
    L({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Run the kanban skill\nDo the task ST-1' } }),
    L({ type: 'attachment', timestamp: at(0), attachment: { type: 'skill_listing', content: 'S'.repeat(300) } }),
    L({ type: 'attachment', timestamp: at(0), attachment: { type: 'instructions', files: [{ path: '/x/CLAUDE.md', content: instructions }] } }),
    L({ type: 'api-request-shape', shape: { system: 'Y'.repeat(50), tools: ['T'.repeat(200)] } }),
    // one answer written as two lines with one id: counted once
    L({ type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(first - 3) } }),
    L({ type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(first - 3) } }),
    L({ type: 'user', timestamp: at(2), isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /h/.claude/skills/kanban\n\n${'K'.repeat(500)}` }] } }),
    L({ type: 'attachment', timestamp: at(2), attachment: { type: 'mcp_instructions_delta', addedNames: ['pw'] }, rendered: 'M'.repeat(80) }),
    L({ type: 'assistant', timestamp: at(3), isSidechain: true, message: { id: 'h1', model: 'claude-opus-5-5', usage: usage(1) } }),
    L({ type: 'assistant', timestamp: at(4), message: { id: 'm2', model: 'claude-opus-5-5', usage: usage(skill - 1003, 1000) } }),
    L({ type: 'assistant', timestamp: at(5), message: { id: 'm3', model: 'claude-opus-5-5', usage: usage(999_999) } }),
    // a server added mid-work — not the start set (review)
    L({ type: 'attachment', timestamp: at(6), attachment: { type: 'deferred_tools_delta', addedNames: ['late'] }, rendered: 'Z'.repeat(5000) }),
  ];
}

test('the start of a transcript: the first request, the one with the kanban skill, the parts', () => {
  const r = S.startOf(transcript({ first: 85_000, skill: 104_000 }));
  assert.equal(r.first, 85_000);
  assert.equal(r.with_skill, 104_000, 'a helper\'s answer or a later one taken for the request with the skill');
  assert.equal(r.parts.instructions, 1000);
  assert.equal(r.parts.skills, 300);
  assert.equal(r.parts.mcp, 80, 'a server connected after the first request is part of the start set');
  assert.equal(r.parts.kanban, 'Base directory for this skill: /h/.claude/skills/kanban\n\n'.length + 500);
  assert.ok(r.parts.tools > 200 && r.parts.system > 50);
  assert.equal(S.startOf([L({ type: 'user', message: { content: 'hi' } })]), null, 'no request — no start');
  assert.equal(S.startOf(transcript({ first: 85_000, skill: 104_000 }).filter((l) => !l.includes('Base directory'))).with_skill, null);
});

test('a project gets the median of its sessions of the last days; over the norm is said; a guest of Wi-Fi gets nothing', async () => {
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('st', 'ST', 'Start', 2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'st'").get().id;
  const tid = Number(db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'one', 'doing')").run(pid).lastInsertRowid);
  const sids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const firsts = [60_000, 90_000, 80_000];
  sids.forEach((sid, i) => {
    writeFileSync(join(dir, `${sid}.jsonl`), `${transcript({ first: firsts[i], skill: firsts[i] + 19_000 }).join('\n')}\n`);
    db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now', '-1 day'), datetime('now'))").run(tid, sid);
  });
  // a session older than the window does not count
  const old = '44444444-4444-4444-8444-444444444444';
  writeFileSync(join(dir, `${old}.jsonl`), `${transcript({ first: 500_000, skill: 600_000 }).join('\n')}\n`);
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now', '-30 day'), datetime('now', '-30 day'))").run(tid, old);
  const r = await app.inject('/api/health/start');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.norm, S.START_NORM_TOKENS);
  const p = d.projects.find((x) => x.slug === 'st');
  assert.deepEqual([p.sessions, p.first, p.with_skill, p.over], [3, 80_000, 99_000, true]);
  assert.equal(p.parts.skills, 300);
  // a guest of Wi-Fi gets none — test/share.test.js asks the route as a guest
});

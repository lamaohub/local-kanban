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

// edge of a 256 KiB read, a <synthetic> answer, only the kanban skill, an archived project, the median of an even count
test('servers after the second request, <synthetic> answers and other skills are not the start set', () => {
  const noSkill = [
    L({ type: 'attachment', attachment: { type: 'mcp_instructions_delta' }, rendered: 'M'.repeat(80) }),
    L({ type: 'assistant', message: { id: 's0', model: '<synthetic>', usage: usage(5) } }),
    L({ type: 'assistant', message: { id: 'a1', model: 'claude-opus-5-5', usage: usage(10_000) } }),
    L({ type: 'attachment', attachment: { type: 'deferred_tools_delta' }, rendered: 'D'.repeat(20) }),
    L({ type: 'assistant', message: { id: 'a2', model: 'claude-opus-5-5', usage: usage(11_000) } }),
    L({ type: 'attachment', attachment: { type: 'deferred_tools_delta' }, rendered: 'Z'.repeat(5000) }),
    L({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /h/.claude/skills/kanban-old\n\nX' }] } }),
    L({ type: 'assistant', message: { id: 'a3', model: 'claude-opus-5-5', usage: usage(12_000) } }),
  ];
  const r = S.startOf(noSkill);
  assert.equal(r.first, 10_003, 'a <synthetic> line taken for the first request');
  assert.equal(r.parts.mcp, 100, 'a server added mid-work counted in the start set');
  assert.equal(r.with_skill, null, 'another skill taken for the kanban skill');
  assert.equal(r.parts.kanban, 0);
});

test('a letter cut by the edge of a read is whole; an archived project is left out; an even count has the middle of two', async () => {
  const pid = Number(db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('edge', 'EDG', 'Edge', 2)").run().lastInsertRowid);
  const tid = Number(db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'one', 'doing')").run(pid).lastInsertRowid);
  const lines = transcript({ first: 60_000, skill: 80_000 });
  const k = lines.findIndex((l) => l.includes('Base directory'));
  const before = `${lines.slice(0, k).join('\n')}\n`;
  const opening = L({ type: 'user', timestamp: at(2), isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /h/.claude/skills/kanban\n\n' }] } }).slice(0, -5);
  const fill = 256 * 1024 - 1 - Buffer.byteLength(before + opening); // U+0436 (two bytes in UTF-8) starts one byte before the edge
  const text = `Base directory for this skill: /h/.claude/skills/kanban\n\n${'K'.repeat(fill)}\u0436${'K'.repeat(99)}`;
  lines[k] = L({ type: 'user', timestamp: at(2), isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  const body = `${lines.join('\n')}\n`;
  assert.equal(Buffer.from(body).indexOf(Buffer.from('\u0436')), 256 * 1024 - 1, 'the fixture lost its edge');
  const one = '55555555-5555-4555-8555-555555555555';
  const two = '66666666-6666-4666-8666-666666666666';
  writeFileSync(join(dir, `${one}.jsonl`), body);
  writeFileSync(join(dir, `${two}.jsonl`), `${transcript({ first: 70_001, skill: 90_000 }).join('\n')}\n`);
  for (const sid of [one, two]) db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now', '-1 day'), datetime('now'))").run(tid, sid);
  let p = (await app.inject('/api/health/start')).json().projects.find((x) => x.slug === 'edge');
  assert.equal(p.sessions, 2);
  assert.equal(p.parts.kanban, Math.round((text.length + 'Base directory for this skill: /h/.claude/skills/kanban\n\n'.length + 500) / 2), 'a letter on the edge of a chunk was broken');
  assert.deepEqual([p.first, p.with_skill], [65_001, 85_000], 'the median of two is the middle of them');
  db.prepare("UPDATE projects SET archived = 1 WHERE id = ?").run(pid);
  p = (await app.inject('/api/health/start')).json().projects.find((x) => x.slug === 'edge');
  assert.equal(p, undefined, 'an archived project is in the start set');
});

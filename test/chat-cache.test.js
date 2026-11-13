// The audit of 14.11.2026: the chat kept the last 12 transcripts it read whatever their size — twelve of 20 MB held
// 254–614 MB (pm2 restarts the board at its limit), and a thirteenth small one was read from its start on every ask. The
// cache is bounded by what it holds now: many small chats stay, large ones push the oldest out, the one just read stays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir, chat;
const line = (o) => `${JSON.stringify(o)}\n`;
const at = (s) => new Date(Date.now() - 3600_000 + s * 1000).toISOString();
const talk = (words) => line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'hello' } })
  + line({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: words }] } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-chat-cache-'));
  process.env.KB_DATA_DIR = join(dir, 'data');
  chat = await import('../src/chat-feed.js');
});
after(() => { chat?.setParsedBytes(null); rmSync(dir, { recursive: true, force: true }); });

test('sixteen small chats asked in turn all stay read', async () => {
  const paths = Array.from({ length: 16 }, (_, i) => join(dir, `small-${i}.jsonl`));
  for (const p of paths) { writeFileSync(p, talk(`words of ${p}`)); await chat.transcriptChat(p); }
  const kept = chat.parsedChats();
  assert.ok(paths.every((p) => kept.paths.includes(p)), `only ${kept.n} of 16 small chats kept`);
});

test('large chats are kept by their size: the oldest go, the one just read stays, and the count follows what is held', async () => {
  const big = Array.from({ length: 10 }, (_, i) => talk(`${i}`.repeat(20_000))).join(''); // ≈ 400 KB of strings in the cache
  const probe = join(dir, 'probe.jsonl');
  writeFileSync(probe, big);
  const before = chat.parsedChats().bytes;
  await chat.transcriptChat(probe);
  const one = chat.parsedChats().bytes - before;
  assert.ok(one > 300_000, `a large chat weighs ${one} bytes`);
  chat.setParsedBytes(3 * one);
  const paths = Array.from({ length: 5 }, (_, i) => join(dir, `big-${i}.jsonl`));
  for (const p of paths) { writeFileSync(p, big); await chat.transcriptChat(p); }
  let kept = chat.parsedChats();
  assert.ok(kept.bytes <= 3 * one + 64 * 1024, `${kept.bytes} bytes kept over a bound of ${3 * one}`);
  assert.ok(kept.paths.includes(paths[4]), 'the chat just read went');
  assert.ok(!kept.paths.includes(paths[0]), 'the oldest large chat stayed over the bound');
  // a chat read further counts its new lines once, not again with the old ones
  appendFileSync(paths[4], talk('more'));
  await chat.transcriptChat(paths[4]);
  const again = chat.parsedChats();
  assert.ok(again.bytes - kept.bytes < one / 10, `${again.bytes - kept.bytes} bytes added for two short lines`);
  // one chat larger than the bound alone is still kept: it is the one asked now
  chat.setParsedBytes(one / 2);
  await chat.transcriptChat(paths[3]);
  kept = chat.parsedChats();
  assert.deepEqual(kept.paths, [paths[3]]);
  assert.ok(kept.bytes >= one && kept.bytes < 2 * one, `${kept.bytes} bytes counted for one chat of ${one}`);
  chat.setParsedBytes(null);
});

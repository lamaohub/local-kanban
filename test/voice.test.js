// src/voice-worker.py). The real model is not run here — it is checked by hand on the owner's Mac.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let tmp, app, voice;
const inject = (method, url, payload) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:3100' } });
// the stand-in: «ready», then a WAV for a text with no Latin and no digit — anything else is an error, so the test sees
// that the board made the text sayable before it sent it
const FAKE = `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true, speakers: ['aidar', 'xenia'] }));
rl.on('line', (l) => {
  const r = JSON.parse(l);
  if (/[A-Za-z0-9]/.test(r.text)) { console.log(JSON.stringify({ id: r.id, ok: false, error: 'unsayable: ' + r.text })); return; }
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.from(r.speaker + ':' + r.text)]);
  console.log(JSON.stringify({ id: r.id, ok: true, wav: wav.toString('base64') }));
});
`;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-voice-'));
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_VOICE_DIR = join(tmp, 'voice');
  voice = await import('../src/voice.js');
  const routes = (await import('../src/routes/voice.js')).default;
  app = Fastify();
  app.register(routes);
  await app.ready();
});
after(async () => { voice.stopVoice(); await app.close(); rmSync(tmp, { recursive: true, force: true }); });

test('not installed: the state says why, a phrase is refused as not-installed', async () => {
  const st = (await inject('GET', '/api/voice')).json();
  assert.equal(st.installed, false);
  assert.equal(st.reason, 'no-python');
  const r = await inject('POST', '/api/voice', { text: 'привет', speaker: 'xenia' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().reason, 'not-installed');
});

test('installed: a phrase comes back as WAV, made sayable first; the speakers are the model\'s', async () => {
  mkdirSync(join(tmp, 'voice', 'venv', 'bin'), { recursive: true });
  mkdirSync(join(tmp, 'voice', 'models'), { recursive: true });
  writeFileSync(join(tmp, 'voice', 'venv', 'bin', 'python'), FAKE);
  chmodSync(join(tmp, 'voice', 'venv', 'bin', 'python'), 0o755);
  assert.equal((await inject('GET', '/api/voice')).json().reason, 'no-model');
  writeFileSync(join(tmp, 'voice', 'models', 'v5_6_ru.pt'), 'model');
  assert.equal((await inject('GET', '/api/voice')).json().installed, true);
  const warm = await inject('POST', '/api/voice/warm');
  assert.equal(warm.statusCode, 200, warm.body);
  assert.deepEqual(warm.json().speakers, ['aidar', 'xenia']);
  const r = await inject('POST', '/api/voice', { text: 'Claude: 25 задач', speaker: 'xenia' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'audio/wav');
  assert.equal(r.rawPayload.subarray(0, 4).toString(), 'RIFF');
  assert.equal(r.rawPayload.subarray(12).toString(), 'xenia:клод: двадцать пять задач');
});

test('the door: a bad text or a speaker the model has not — 400 with the field', async () => {
  for (const [body, field] of [[{ text: '', speaker: 'xenia' }, 'text'], [{ text: 'а'.repeat(1201), speaker: 'xenia' }, 'text'], [{ text: 5, speaker: 'xenia' }, 'text'], [{ text: 'привет', speaker: 'kseniya' }, 'speaker'], [{ text: 'привет' }, 'speaker']]) {
    const r = await inject('POST', '/api/voice', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().field, field);
  }
});

test('a voice that cannot start says so and does not hang', async () => {
  voice.stopVoice();
  writeFileSync(join(tmp, 'voice', 'venv', 'bin', 'python'), `#!${process.execPath}\nconsole.log(JSON.stringify({ ready: false, error: 'ModuleNotFoundError: No module named torch' }));\n`);
  const r = await inject('POST', '/api/voice', { text: 'привет', speaker: 'xenia' });
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /No module named torch/);
  assert.match((await inject('GET', '/api/voice')).json().error, /No module named torch/);
});

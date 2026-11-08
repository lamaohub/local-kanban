// it over the system's voice («can the voice be of better quality»). Optional: its Python environment and model live
// outside the board (voiceDir() of config.js; the model's licence is CC BY-NC, so the board never ships it), and with
// nothing there the call speaks with the system's voice. One process keeps the model loaded (2 s to load, then a
// phrase in ~0.05 s — measured on the owner's Mac) and goes after VOICE_IDLE_MS without a phrase.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, voiceDir } from './config.js';
import { speechText } from './voice-text.js';

export const VOICE_TEXT_MAX = 1200; // a call says a few sentences at a time
export const VOICE_SPEAKERS = ['aidar', 'eugene', 'baya', 'kseniya', 'xenia']; // the Russian voices of Silero v5
const READY_WAIT_MS = 30000; // loading the model
const SAY_WAIT_MS = 20000; // one phrase
const VOICE_IDLE_MS = 10 * 60000;
const PENDING_MAX = 4; // a guest of the Wi-Fi door can ask too: a line, not a heap of work
const ERR_KEEP = 600;

let worker = null; // {proc, ready: Promise, pending: Map id → {done, fail, timer}, out: ''}
let lastError = null;
let seq = 0;
let idleTimer = null;

/** The Python of the voice's own environment — a full path, never a name looked up on PATH (bin-path rule). */
function voicePython(dir) {
  return join(dir, 'venv', 'bin', 'python');
}

/** Where the voice lives: its Python and its model (the newest .pt in models/), null for what is not there. */
export function voicePaths() {
  const dir = voiceDir();
  const python = voicePython(dir);
  let model = null;
  try {
    const pts = readdirSync(join(dir, 'models')).filter((f) => f.endsWith('.pt')).sort();
    if (pts.length) model = join(dir, 'models', pts.at(-1));
  } catch { /* no models folder */ }
  return { dir, python: existsSync(python) ? python : null, model };
}

/** What the page needs to know: is the voice installed, is it running, its voices, why not. */
export function voiceState() {
  const p = voicePaths();
  const installed = Boolean(p.python && p.model);
  return {
    installed,
    running: Boolean(worker?.up),
    speakers: worker?.speakers || VOICE_SPEAKERS,
    ...(installed ? {} : { reason: p.python ? 'no-model' : 'no-python' }),
    ...(lastError ? { error: lastError } : {}),
  };
}

function stop() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) return;
  const w = worker;
  worker = null;
  for (const job of w.pending.values()) { clearTimeout(job.timer); job.fail(Object.assign(new Error('the voice stopped'), { reason: 'failed' })); }
  w.pending.clear();
  try { w.proc.kill('SIGKILL'); } catch { /* gone */ }
}

function idle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, VOICE_IDLE_MS);
  idleTimer.unref?.();
}

/** Start the process (once) and wait until its model is loaded. */
export function warmVoice() {
  if (worker) return worker.ready;
  const p = voicePaths();
  if (!p.python || !p.model) return Promise.reject(Object.assign(new Error('the voice is not installed'), { reason: 'not-installed' }));
  // the program by its full path (bin-path rule): the Python of the voice's own environment, -I — nothing from cwd
  const proc = spawn(voicePython(p.dir), ['-I', join(ROOT, 'src', 'voice-worker.py'), p.model], { stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { proc, pending: new Map(), out: '', err: '', up: false, speakers: null };
  worker = w;
  w.ready = new Promise((ok, no) => {
    const t = setTimeout(() => no(Object.assign(new Error('the voice did not load in time'), { reason: 'failed' })), READY_WAIT_MS);
    w.readyDone = (x) => { clearTimeout(t); ok(x); };
    w.readyFail = (e) => { clearTimeout(t); no(e); };
  });
  w.ready.catch(() => {}); // a failed start is said to whoever waits for it
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    w.out += chunk;
    let i;
    while ((i = w.out.indexOf('\n')) >= 0) {
      const line = w.out.slice(0, i);
      w.out = w.out.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if ('ready' in m) {
        if (m.ready) { w.up = true; w.speakers = Array.isArray(m.speakers) && m.speakers.length ? m.speakers : VOICE_SPEAKERS; lastError = null; w.readyDone(w); } else {
          lastError = String(m.error || 'the voice did not start').slice(0, ERR_KEEP);
          w.readyFail(Object.assign(new Error(lastError), { reason: 'failed' }));
        }
        continue;
      }
      const job = w.pending.get(m.id);
      if (!job) continue;
      w.pending.delete(m.id);
      clearTimeout(job.timer);
      if (m.ok && typeof m.wav === 'string') job.done(Buffer.from(m.wav, 'base64'));
      else job.fail(Object.assign(new Error(String(m.error || 'the voice failed').slice(0, ERR_KEEP)), { reason: 'failed' }));
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { w.err = (w.err + chunk).slice(-ERR_KEEP); });
  const gone = (why) => {
    if (worker !== w) return;
    if (!w.up) {
      lastError = (w.err.trim() || why).slice(-ERR_KEEP);
      w.readyFail(Object.assign(new Error(lastError), { reason: 'failed' }));
    }
    stop();
  };
  proc.on('error', (e) => gone(e.message));
  proc.on('exit', (code, signal) => gone(`the voice exited (${signal || code})`));
  idle();
  return w.ready;
}

/** The WAV of a text said by `speaker` — the text made sayable first (speechText). Throws with `reason`:
    'not-installed', 'busy', 'failed'. */
export async function sayVoice(text, speaker) {
  const w = await warmVoice();
  if (w.pending.size >= PENDING_MAX) throw Object.assign(new Error('the voice has too much to say already'), { reason: 'busy' });
  idle();
  const id = ++seq;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { w.pending.delete(id); fail(Object.assign(new Error('the voice did not answer in time'), { reason: 'failed' })); }, SAY_WAIT_MS);
    w.pending.set(id, { done, fail, timer });
    w.proc.stdin.write(`${JSON.stringify({ id, text: speechText(text), speaker })}\n`);
  });
}

/** For the tests: forget the process. */
export function stopVoice() { stop(); lastError = null; }

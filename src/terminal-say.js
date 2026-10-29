import { moveTyped } from './routes/tasks.js';
import { deliverChat, phantomScreen, phantomSend, questionOpen } from './phantom.js';
import { isManual } from './task-shape.js';
import { resolveSkillPath } from './skills.js';

const MODE_START = /^\s*[!/#]/;
export const chatWords = (key, text) => (MODE_START.test(text) && !chatCommand(text) ? `${key}: ${text.trim()}` : text.trim());

const MODEL_CMD = /^\/model claude-[a-z]+-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?(?:\[1m\])?$/;
const COMPACT_CMD = /^\/compact(?:\s|$)/;
const NOT_SKILLS = new Set(['clear', 'reset', 'new', 'exit', 'quit', 'login', 'logout', 'rewind', 'resume', 'model', 'compact',
  'config', 'permissions', 'hooks', 'init', 'doctor', 'upgrade', 'bug', 'memory', 'mcp', 'agents', 'ide', 'vim']);
/** The skill a chat's words call (`/name …`), or null. */
export function chatSkill(text) {
  const m = /^\/([A-Za-z0-9_-]{1,64})(?:\s|$)/.exec(String(text).trim());
  return m && !NOT_SKILLS.has(m[1].toLowerCase()) && resolveSkillPath(m[1]) ? m[1] : null;
}
/** Whether a chat's words are a command of its own that goes to Claude Code as it is. */
export function chatCommand(text) {
  const t = String(text).trim();
  return MODEL_CMD.test(t) || COMPACT_CMD.test(t) || chatSkill(t) !== null;
}

export async function sayToTerminal(t, session, { text, key, chat = false, images = [] }) {
  if (chat && typeof text === 'string') text = chatWords(t.key, text);
  // "no" to "Teach auto mode…?" after the hand-in sent the task from Review back to Doing). Read before typing: the
  // sign-in button types /login, and /exit typed in Review sent the task to Doing while its Claude left
  const said = typeof text === 'string' ? text.trim() : '';
  const words = (said || images.length) && !/^\d{1,2}$/.test(said) && (!said.startsWith('/') || (chat && chatSkill(said) !== null)) && !isManual(t.labels)
    && ['backlog', 'todo', 'review'].includes(t.status) && !questionOpen((await phantomScreen(session, 0)) ?? '');
  const r = chat ? await deliverChat(session, { text, images }) : await phantomSend(session, { text, key, paste: chat, images });
  if (r.refused) return { refused: r.refused };
  if (r.err) return { err: r.err, text: r.text };
  // the task goes to Preparation, by a move of this very session (as ▶ moves it, but not marked as a start), so its
  // Claude keeps it when it says `kb mv <key> prep` itself. Keys alone (Esc, arrows, a bare Enter) are not work, nor is
  const moved = words ? moveTyped(t, session) : { prep: [], doing: [] };
  return { ok: true, ...moved };
}

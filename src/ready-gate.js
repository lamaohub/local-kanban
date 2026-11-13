import { db, kvGet, kvSet } from './db.js';

const GATE_KEY = 'flow.ready_gate';

export const gateOfBoard = () => kvGet(GATE_KEY) === '1';
export function setGateOfBoard(on) { kvSet(GATE_KEY, on ? '1' : '0'); }
/** The switch that holds for a project: its own word when it has one. `board` — the board's switch read once already (a
    list of projects reads it once, not once a project). */
export const gateOf = (own, board = null) => (own === null || own === undefined ? board ?? gateOfBoard() : Boolean(own));
export const gateOfProject = (id) => gateOf(db.prepare('SELECT ready_gate FROM projects WHERE id = ?').get(id)?.ready_gate);
/** Statuses a task with code can reach out of Doing without the column, and so must not lead on to Review: Prep, and the
    two closed ones. Doing → Done itself stays open — Done is the person's word on the task, and a closed task ships nothing. */
export const SIDE_DOORS = ['prep', 'cancelled', 'done'];
/** Whether a move from `from` to `to` goes past the column; `worked` — see `workedSince`. Pure. */
export const skipsReady = (from, to, worked = false) => (to === 'deploy' && from !== 'ready' && from !== 'deploy')
  || (to === 'review' && (from === 'doing' || (SIDE_DOORS.includes(from) && worked)));
/** Whether the task has been in Doing since it last stood in the column, Deploying or Review. */
export const workedSince = (id) => Boolean(db.prepare(`SELECT 1 FROM task_events e WHERE e.task_id = ? AND e.status = 'doing'
  AND e.id > COALESCE((SELECT MAX(s.id) FROM task_events s WHERE s.task_id = e.task_id AND s.status IN ('ready', 'deploy', 'review')), 0) LIMIT 1`).get(id));
const FREES = ['noclaude', 'check'];
/** Whether labels `after` free a task in `status` from the column while `before` did not. Taking such a label off is no way
    past it, and a person does that on a card done by hand. Pure. */
export const labelDodges = (status, before, after) => ['prep', 'doing', 'ready'].includes(status)
  && !FREES.some((l) => before.includes(l)) && FREES.some((l) => after.includes(l));

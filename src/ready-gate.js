import { db, kvGet, kvSet } from './db.js';

const GATE_KEY = 'flow.ready_gate';

export const gateOfBoard = () => kvGet(GATE_KEY) === '1';
export function setGateOfBoard(on) { kvSet(GATE_KEY, on ? '1' : '0'); }
/** The switch that holds for a project: its own word when it has one. */
export const gateOf = (own) => (own === null || own === undefined ? gateOfBoard() : Boolean(own));
export const gateOfProject = (id) => gateOf(db.prepare('SELECT ready_gate FROM projects WHERE id = ?').get(id)?.ready_gate);
/** Whether a move from `from` to `to` goes past the column. Pure. */
export const skipsReady = (from, to) => (to === 'deploy' && from !== 'ready' && from !== 'deploy') || (to === 'review' && from === 'doing');

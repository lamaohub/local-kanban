import { db, WORK_SEGMENT_MAX_S } from './db.js';
import { emit } from './bus.js';
import { taskEvent } from './task-shape.js';

const WORKING = "('doing','deploy')";
const ELAPSED = "COALESCE(CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', work_started_at) AS INTEGER), 0)";

/** Close the running segment of a task in work — the same sum the status change makes (capped, never below zero).
    True if there was a segment to close. */
export function stopClock(id) {
  return db.prepare(`UPDATE tasks SET work_seconds = work_seconds + MIN(?, MAX(0, ${ELAPSED})),
      work_truncated = work_truncated + (${ELAPSED} > ?), work_started_at = NULL
    WHERE id = ? AND status IN ${WORKING} AND work_started_at IS NOT NULL`).run(WORK_SEGMENT_MAX_S, WORK_SEGMENT_MAX_S, id).changes > 0;
}

/** Start the clock of a task in work that has none running. True if it was started. */
export function startClock(id) {
  return db.prepare(`UPDATE tasks SET work_started_at = datetime('now')
    WHERE id = ? AND status IN ${WORKING} AND work_started_at IS NULL`).run(id).changes > 0;
}

/** Bring the clocks in line with the live states (liveTasks): `gone` stops, any state of a living Claude starts.
    Returns the ids whose clock changed; each goes out as `task.updated`, so the card shows the time stopped or running. */
export function syncClocks(states) {
  const changed = [];
  for (const s of states) {
    if (s.status !== 'doing' && s.status !== 'deploy') continue;
    if (s.claude === 'gone' ? stopClock(s.id) : startClock(s.id)) changed.push(s.id);
  }
  for (const id of changed) {
    const ev = taskEvent(id);
    if (ev) emit('task.updated', ev);
  }
  return changed;
}

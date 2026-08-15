import { db } from '../db.js';
import { scalarParam } from '../query-params.js';

const SCALES = ['life', 'years', 'months', 'weeks', 'days'];

function badParent(value, selfId) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return 'parent_id: expected the id of an existing goal';
  if (selfId && id === selfId) return 'parent_id: a goal cannot be its own parent';
  if (!db.prepare('SELECT 1 FROM horizon_goals WHERE id = ?').get(id)) return 'parent_id: no goal with this id';
  return null;
}

function shape(g) {
  return { id: g.id, scale: g.scale, period: g.period, text: g.text, done: !!g.done, position: g.position, parent_id: g.parent_id };
}

export default async function horizonRoutes(app) {
  app.get('/api/horizons', (req, reply) => {
    const parsed = scalarParam(req.query?.scale, 'scale');
    if (parsed.error) return reply.code(400).send({ error: parsed.error });
    const scale = parsed.value;
    const rows = scale
      ? db.prepare('SELECT * FROM horizon_goals WHERE scale = ? ORDER BY position, id').all(scale)
      : db.prepare('SELECT * FROM horizon_goals ORDER BY position, id').all();
    return rows.map(shape);
  });

  app.post('/api/horizons', (req, reply) => {
    const { scale, period, text = '', parent_id = null } = req.body || {};
    if (!SCALES.includes(scale)) return reply.code(400).send({ error: 'bad scale' });
    if (!period || typeof period !== 'string') return reply.code(400).send({ error: 'period required' });
    const parentErr = badParent(parent_id, null);
    if (parentErr) return reply.code(400).send({ error: parentErr });
    const mx = db.prepare('SELECT COALESCE(MAX(position),0) AS m FROM horizon_goals WHERE scale=? AND period=?').get(scale, period).m;
    const r = db.prepare('INSERT INTO horizon_goals (scale, period, text, position, parent_id) VALUES (?,?,?,?,?)')
      .run(scale, period, String(text), mx + 1, parent_id || null);
    return reply.code(201).send(shape(db.prepare('SELECT * FROM horizon_goals WHERE id=?').get(r.lastInsertRowid)));
  });

  app.patch('/api/horizons/:id', (req, reply) => {
    const g = db.prepare('SELECT * FROM horizon_goals WHERE id=?').get(req.params.id);
    if (!g) return reply.code(404).send({ error: 'goal not found' });
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.text !== undefined) { sets.push('text = ?'); vals.push(String(b.text)); }
    if (b.done !== undefined) { sets.push('done = ?'); vals.push(b.done ? 1 : 0); }
    if (b.position !== undefined) { const p = Number(b.position); if (Number.isFinite(p)) { sets.push('position = ?'); vals.push(p); } }
    if (b.period !== undefined && typeof b.period === 'string') { sets.push('period = ?'); vals.push(b.period); }
    if (b.parent_id !== undefined) {
      const parentErr = badParent(b.parent_id, g.id);
      if (parentErr) return reply.code(400).send({ error: parentErr });
      sets.push('parent_id = ?'); vals.push(b.parent_id || null);
    }
    if (sets.length) db.prepare(`UPDATE horizon_goals SET ${sets.join(', ')} WHERE id=?`).run(...vals, g.id);
    return shape(db.prepare('SELECT * FROM horizon_goals WHERE id=?').get(g.id));
  });

  app.delete('/api/horizons/:id', (req, reply) => {
    const g = db.prepare('SELECT * FROM horizon_goals WHERE id=?').get(req.params.id);
    if (!g) return reply.code(404).send({ error: 'goal not found' });
    db.prepare('DELETE FROM horizon_goals WHERE id=?').run(g.id);
    return reply.code(204).send();
  });
}

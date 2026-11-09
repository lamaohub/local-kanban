import { db } from '../db.js';
import { emit } from '../bus.js';
import { resolveTask } from './tasks.js';
import { PROFILES_MAX, dropProfileFiles, listProfiles, profileById, profileInput, refreshProfileFiles, shown } from '../profiles.js';

export default async function profileRoutes(app) {
  const changed = () => emit('profiles.updated', { profiles: listProfiles() });
  app.get('/api/profiles', () => ({ profiles: listProfiles() }));
  app.post('/api/profiles', (req, reply) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM launch_profiles').get().n >= PROFILES_MAX) return reply.code(409).send({ error: `at most ${PROFILES_MAX} profiles` });
    const r = profileInput(req.body);
    if (r.error) return reply.code(400).send(r);
    const id = db.prepare('INSERT INTO launch_profiles (name, model, effort, env) VALUES (@name, @model, @effort, @env)').run(r.row).lastInsertRowid;
    changed();
    return reply.code(201).send(shown(profileById(Number(id))));
  });
  app.patch('/api/profiles/:pid', (req, reply) => {
    const was = profileById(Number(req.params.pid));
    if (!was) return reply.code(404).send({ error: 'profile not found' });
    const r = profileInput(req.body, was);
    if (r.error) return reply.code(400).send(r);
    db.prepare('UPDATE launch_profiles SET name = @name, model = @model, effort = @effort, env = @env WHERE id = @id').run({ ...r.row, id: was.id });
    refreshProfileFiles(profileById(was.id));
    changed();
    return shown(profileById(was.id));
  });
  app.delete('/api/profiles/:pid', (req, reply) => {
    const id = Number(req.params.pid);
    if (!profileById(id)) return reply.code(404).send({ error: 'profile not found' });
    db.transaction(() => {
      db.prepare('UPDATE projects SET profile_id = NULL WHERE profile_id = ?').run(id);
      db.prepare('DELETE FROM launch_profiles WHERE id = ?').run(id); // a task's own goes with it (ON DELETE CASCADE)
    })();
    dropProfileFiles(id);
    changed();
    return { ok: true };
  });
  // a task's own profile; null — the project's
  app.put('/api/tasks/:id/profile', (req, reply) => {
    const t = resolveTask(req.params.id);
    if (!t) return reply.code(404).send({ error: 'task not found' });
    const pid = req.body?.profile;
    if (pid !== null && !(Number.isInteger(pid) && profileById(pid))) return reply.code(400).send({ error: 'profile: the id of a profile, or null', field: 'profile' });
    if (pid === null) db.prepare('DELETE FROM task_profiles WHERE task_id = ?').run(t.id);
    else db.prepare('INSERT INTO task_profiles (task_id, profile_id) VALUES (?, ?) ON CONFLICT (task_id) DO UPDATE SET profile_id = excluded.profile_id').run(t.id, pid);
    return { profile: pid };
  });
}

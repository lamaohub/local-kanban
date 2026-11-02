
/** Whether the status is in use on a board: the switch is on for it, or tasks still stand in the column. Off and empty, the
    status is in no menu and no column. `all` — the slug of the board of all projects. */
export function readyShown(projects, slug, all) {
  const on = (p) => Boolean(p.ship_gate || p.c_ready);
  return slug === all ? projects.some(on) : on(projects.find((p) => p.slug === slug) || {});
}
/** The statuses a menu offers: `current` stays, whatever the switch says. */
export const statusesShown = (statuses, current, shown) => statuses.filter(([v]) => v !== 'ready' || v === current || shown);
/** The columns of a board: Cancelled and Ready to ship only when there is a reason for them. */
export const boardColumns = (keys, tasks, shown) => keys.filter((k) => (k !== 'cancelled' || tasks.some((t) => t.status === 'cancelled'))
  && (k !== 'ready' || shown || tasks.some((t) => t.status === 'ready')));
/** The number of «All projects» in the sidebar. */
export const activeTotal = (projects) => projects.reduce((s, p) => s + (p.c_todo || 0) + (p.c_prep || 0) + (p.c_doing || 0) + (p.c_ready || 0) + (p.c_deploy || 0) + (p.c_review || 0), 0);
/** The number of the Dashboard in the sidebar: its «Waiting for you» lists them, «Claude review» does not (it counts what it shows). */
export const waitingForWord = (projects) => projects.reduce((s, p) => s + (p.c_ready || 0), 0);
/** A task its Claude has handed in: the ✓ of «Claude now». */
export const handedIn = (status) => status === 'ready' || status === 'review' || status === 'done';
/** The line under the switch in Settings → Statuses, from GET /api/flow. */
export function flowNote(v, tr) {
  const left = v.ready_n ? `${tr('Waits in the column:')} ${v.ready_n}` : '';
  const gone = !v.ready_gate && v.left_n ? tr('The switch is off, and the tasks stay: the column goes once it is empty.') : '';
  const own = v.ready_gate && v.own_off?.length ? `${tr('These projects say otherwise and do not wait:')} ${v.own_off.join(', ')}` : '';
  return [gone, left, own].filter(Boolean).join(' · ');
}

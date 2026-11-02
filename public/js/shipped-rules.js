
export const SHIP_WORDS = { main: 'on main', branch: 'only in a branch', none: 'no commits found' };
export const SHIP_TITLES = {
  main: 'The commits of this task are on main',
  branch: 'Some commits of this task are not on main yet',
  none: 'The board found no commit of this task',
};
/** The columns where it matters: past them the task is either not done or long accepted. */
export const showsShip = (status) => status === 'ready' || status === 'review';
/** What stays in Review under the filter: everything not known to be on main. */
export const notOnMain = (t, shipped) => shipped[t.key] !== 'main';

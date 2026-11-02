
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
/** `askShipped`: one question at a time, at most once in `every` ms and at once on a new board. An answer about a board left
    is dropped, and that board's successor is asked about as it lands: its own render found the question flying. */
export function shipAsker({ every, board, wanted, ask, apply, now = Date.now }) {
  let last = { slug: null, at: 0, flying: false };
  const askShipped = () => {
    const at = now();
    if (last.flying || !wanted()) return;
    const slug = board();
    if (last.slug === slug && at - last.at < every) return;
    const asked = { slug, at, flying: true };
    last = asked;
    ask(slug)
      .then((r) => { if (slug === board()) apply(r); })
      .catch(() => { /* the card says nothing: it is a hint, not a state of the task */ })
      .finally(() => { asked.flying = false; if (slug !== board()) askShipped(); });
  };
  return askShipped;
}

export const AWAY_MS = 8 * 3600_000; // the owner's word: eight hours of silence
/** Whether a page seen last at `last` owes a summary at `now`. A first visit has nothing to tell. */
export const awayDue = (last, now) => Number.isFinite(last) && last > 0 && now - last >= AWAY_MS;
/** Whether a summary has anything to tell. */
export const hasNews = (s) => ['handed', 'accepted', 'returned', 'stuck'].some((k) => s?.[k]?.n > 0);

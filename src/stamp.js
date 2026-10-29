
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD', or with the time 'YYYY-MM-DD-HH-MM-SS', on the local clock. */
export function localStamp(d, withTime) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}` : day;
}

/** 'YYYY-MM-DD_HH-MM-SS+HHMM' — the local time and its offset from UTC; with `ms`, the milliseconds go
    before the offset: 'YYYY-MM-DD_HH-MM-SS-mmm+HHMM'. */
export function zonedStamp(d, ms = false) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${localStamp(d, false)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    + `${ms ? `-${pad(d.getMilliseconds(), 3)}` : ''}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** What `zonedStamp` makes, as a piece of a regular expression for the names that carry it. */
export const ZONED = String.raw`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3})?[+-]\d{4}`;

const ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?([+-])(\d{2})(\d{2})$/;
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})[T-](\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/;

/** The moment a stamp stands for, in ms since the epoch: a `zonedStamp`, or the UTC one the names carried
    before it ('YYYY-MM-DD-HH-MM-SS', 'YYYY-MM-DDTHH-MM-SS[-mmm]'). NaN for anything else. */
export function stampTime(s) {
  const z = ZONED_RE.exec(s);
  const m = z || UTC_RE.exec(s);
  if (!m) return NaN;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] || 0));
  if (!z) return utc;
  return utc - (z[8] === '-' ? -1 : 1) * (Number(z[9]) * 60 + Number(z[10])) * 60_000;
}

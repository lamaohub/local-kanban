const NBSP = ' ';
const DASH = /[ \t\n]+([–—])(?=[ \t\n])/g;
// no lookbehind: a Safari older than 16.4 would not parse the module, and the whole page imports it
const SHORT = /(^|[\s («"„])([Ѐ-ӿ]{1,2})[ \t\n]+(?=\S)/g;

export function typeset(text) {
  let out = String(text ?? '').replace(DASH, `${NBSP}$1`);
  // a match takes the space after its word, so of short words in a row every other one is left: the next pass takes it
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(SHORT, `$1$2${NBSP}`); }
  return out;
}

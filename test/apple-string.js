// An AppleScript string literal read back to its text — by the real osascript where it runs, else by the rules of the
// literal itself. A sandbox (an audit's, a CI's) can leave osascript answering nothing at all, and three checks of the
// quoting failed there with the code right; the reader below keeps them a check of the quoting everywhere, and
// test/launch.test.js holds it to the real osascript wherever that one answers.
import { execFileSync } from 'node:child_process';
import { bin } from '../src/bin-path.js';

let works;
/** Whether a real osascript answers here: macOS, and nothing that silences it. Asked once. */
export function osascriptWorks() {
  if (works !== undefined) return works;
  works = false;
  if (process.platform !== 'darwin') return works;
  try {
    works = execFileSync(bin('osascript'), ['-e', 'return "kb \\"probe\\""'], { encoding: 'utf8', timeout: 15000 }) === 'kb "probe"\n';
  } catch { /* no osascript to run */ }
  return works;
}

/** The text of one AppleScript string literal by its own rules: \" \\ \n \r \t, everything else as it stands. */
export function parseAppleString(literal) {
  const m = /^"((?:[^"\\]|\\.)*)"$/s.exec(literal);
  if (!m) throw new Error(`not one AppleScript string literal: ${literal}`);
  const ESC = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' };
  return m[1].replace(/\\(.)/gs, (_, c) => {
    if (!(c in ESC)) throw new Error(`\\${c} is not an escape AppleScript knows`);
    return ESC[c];
  });
}

/** The real osascript's reading of a literal (its own newline at the end taken off). */
export const osascriptReads = (literal) => execFileSync(bin('osascript'), ['-e', `return ${literal}`], { encoding: 'utf8' }).replace(/\n$/, '');

/** What `literal` reads as: the real osascript where it answers, else the rules of the literal. */
export const readAppleString = (literal) => (osascriptWorks() ? osascriptReads(literal) : parseAppleString(literal));

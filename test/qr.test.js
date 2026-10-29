// The golden matrices were read back by a real decoder (jsQR) when they were made; the decoder is not a dependency of
// the board, so here the codes are held byte for byte, plus the structure every reader looks for first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qrMatrix, qrSvg, QR_MAX_VERSION } from '../src/qr.js';

const hash = (m) => createHash('sha256').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex');

test('golden codes: a link of the board (version 4) and a long text (version 8)', () => {
  const link = qrMatrix('http://192.168.100.200:3110/?k=AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(link.length, 33);
  assert.equal(hash(link), '6d435e962664b52a7f8e496eea827bf6f97accf0e781a7661332c71ee8505b76');
  const long = qrMatrix('x'.repeat(150));
  assert.equal(long.length, 49);
  assert.equal(hash(long), '9782fa7f0642d3e6b22295c01fc9e2fe9a0f19d22af2cf7b3964dcb6a932e44e');
});

test('finder patterns in three corners, timing lines, the dark module', () => {
  for (const text of ['a', 'http://10.0.0.5:3110/?k=0123456789abcdefghijkl', 'y'.repeat(200)]) {
    const m = qrMatrix(text);
    const n = m.length;
    assert.equal((n - 17) % 4, 0);
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          assert.equal(m[y0 + dy][x0 + dx], d !== 2, `finder at ${x0},${y0}`);
        }
      }
    }
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
    assert.equal(m[n - 8][8], true);
  }
});

test('too long for version 10 — refused, not a broken code', () => {
  assert.equal(QR_MAX_VERSION, 10);
  assert.throws(() => qrMatrix('z'.repeat(214)), /too long/);
  assert.doesNotThrow(() => qrMatrix('z'.repeat(213)));
});

test('the SVG: dark on white with a quiet zone of 4, whatever the theme', () => {
  const svg = qrSvg('http://192.168.1.2:3110/?k=x');
  const n = qrMatrix('http://192.168.1.2:3110/?k=x').length + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${n} ${n}"`));
  assert.match(svg, /<rect [^>]*fill="#fff"/);
  assert.match(svg, /<path d="M4 4h1v1h-1z/); // the finder's corner sits right after the quiet zone
});

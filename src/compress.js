import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

export const COMPRESS_MIN = 1024; // a smaller answer gains less than the bytes the encoding costs
const TEXT = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|manifest\+json|xml)\b|image\/svg\+xml)/i;
const BR = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }; // the default 11 takes seconds on a big list
const GZIP = { level: 6 };
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** The encoding to answer with for an Accept-Encoding header: 'br', 'gzip' or null. A coding the browser turns away
    with `q=0` is not taken. */
export function pickEncoding(accept) {
  const took = new Set();
  for (const part of String(accept || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map((x) => x.trim());
    const q = params.find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) took.add(name);
  }
  if (took.has('br')) return 'br';
  if (took.has('gzip') || took.has('*')) return 'gzip';
  return null;
}

/** The Fastify `onSend` hook that compresses the answer. */
export async function compressAnswer(req, reply, payload) {
  if (payload == null || req.method === 'HEAD') return payload;
  const code = reply.statusCode;
  if (code < 200 || code === 204 || code === 206 || code === 304) return payload;
  if (!TEXT.test(String(reply.getHeader('content-type') || '')) || reply.getHeader('content-encoding')) return payload;
  if (req.headers.range) return payload;
  // an answer that could be compressed differs by the browser's Accept-Encoding, compressed or not this time
  const vary = String(reply.getHeader('vary') || '');
  if (!/\baccept-encoding\b/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  const enc = pickEncoding(req.headers['accept-encoding']);
  if (!enc) return payload;
  if (typeof payload.pipe === 'function') { // a file from the static plugin
    const size = Number(reply.getHeader('content-length'));
    if (Number.isFinite(size) && size < COMPRESS_MIN) return payload;
    reply.removeHeader('content-length');
    reply.header('content-encoding', enc);
    const z = enc === 'br' ? zlib.createBrotliCompress(BR) : zlib.createGzip(GZIP);
    pipeline(payload, z, () => {}); // a file that fails midway ends the answer short; the error is the plugin's to tell
    return z;
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  if (body.length < COMPRESS_MIN) return payload;
  const out = enc === 'br' ? await brotli(body, BR) : await gzip(body, GZIP);
  reply.removeHeader('content-length');
  reply.header('content-encoding', enc);
  return out;
}

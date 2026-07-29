import { allowedHosts } from './config.js';

const envHosts = () => allowedHosts().map((h) => h.toLowerCase());

export function selfHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...envHosts()]);
}

export function selfOrigins(port) {
  const out = new Set();
  for (const h of selfHosts(port)) { out.add(`http://${h}`); out.add(`https://${h}`); }
  return out;
}

export function makeOriginGuard(port) {
  const hosts = selfHosts(port);
  const origins = selfOrigins(port);
  return function originGuard(req, reply, done) {
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) {
      return reply.code(421).send({ error: 'request addressed to an unexpected host' });
    }
    const origin = req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) {
      return reply.code(403).send({ error: 'cross-origin request rejected' });
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: 'cross-site request rejected' });
    }
    done();
  };
}

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, logError } from './db.js';
import { PORT, ROOT, localRoot } from './config.js';
import { makeOriginGuard } from './origin-guard.js';
import { errorHandler } from './error-handler.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import dashboardRoutes from './routes/dashboard.js';
import systemRoutes from './routes/system.js';
import eventRoutes from './routes/events.js';
import horizonRoutes from './routes/horizons.js';
import { startWorker } from './sync/worker.js';
import { startBackups } from './backup.js';
import { sweepStalePreviews } from './restore.js';

const ATTACH_DIR = join(DATA_DIR, 'attachments');
mkdirSync(ATTACH_DIR, { recursive: true });

const app = Fastify({ logger: { level: 'warn' } });

app.addHook('onRequest', makeOriginGuard(PORT));

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.register(fastifyStatic, {
  root: join(ROOT, 'public'),
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  },
});
app.register(fastifyStatic, {
  root: ATTACH_DIR,
  prefix: '/attachments/',
  decorateReply: false,
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); },
});
app.setErrorHandler(errorHandler);

app.register(projectRoutes);
app.register(taskRoutes);
app.register(dashboardRoutes);
app.register(systemRoutes);
app.register(eventRoutes);
app.register(horizonRoutes);

for (const ev of ['unhandledRejection', 'uncaughtException']) {
  process.on(ev, (err) => {
    logError('server', ev, err?.message || String(err), err?.stack);
    console.error(err);
    process.exit(1);
  });
}

if (process.env.KB_PREVIEW_TTL_MS) {
  const ttl = Number(process.env.KB_PREVIEW_TTL_MS);
  if (Number.isFinite(ttl) && ttl > 0) setTimeout(() => process.exit(0), ttl).unref();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}

app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`kanban: http://127.0.0.1:${PORT}`);
  console.log(`kanban: data ${DATA_DIR} · project folders ${localRoot()}`);
  startWorker();
  startBackups();
  if (!process.env.KB_PREVIEW_TTL_MS) {
    const swept = sweepStalePreviews();
    if (swept) console.log(`restore: swept ${swept} stale preview director${swept === 1 ? 'y' : 'ies'}`);
  }
}).catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already taken — the board did not start.\n`);
    console.error('  What to do:');
    console.error(`    · free the port (see who holds it:  lsof -i :${PORT} )`);
    console.error(`    · or run on another one:  PORT=${PORT + 1} local-kanban start`);
    console.error('    · or change the port in ecosystem.config.cjs when running under pm2\n');
    process.exit(1);
  }
  app.log.error(err);
  process.exit(1);
});

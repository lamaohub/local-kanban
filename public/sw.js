const OFFLINE_CACHE = 'kb-offline-v2';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate') return;
  e.respondWith((async () => {
    try {
      // A restored window and back/forward navigation arrive here in force-cache mode, and a plain
      // fetch(req) answered them with whatever page the browser had kept. The page always comes from
      // the board, so it is never older than the code it loads.
      return await fetch(req, { cache: 'no-store' });
    } catch {
      return (await caches.match(OFFLINE_URL))
        || new Response('<h1>No connection to the board</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
  })());
});

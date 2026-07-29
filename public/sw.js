const OFFLINE_CACHE = 'kb-offline-v1';
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
      return await fetch(req);
    } catch {
      return (await caches.match(OFFLINE_URL))
        || new Response('<h1>No connection to the board</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
  })());
});

/**
 * sw.js: Pet Studio's service worker (offline start for the installed app).
 *
 * Network first: while online every request goes to the network (so a new
 * build is always picked up) and a copy of each same-origin response is kept
 * in the cache. Offline, the cached copy is served, and navigations fall back
 * to the cached app shell. The app never needs the network after its first
 * visit: no fonts, models, textures or sounds are downloaded.
 */
const CACHE = 'petstudio-shell-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))); // best effort: one miss never blocks install
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await caches.match('index.html')) ?? (await caches.match('./'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

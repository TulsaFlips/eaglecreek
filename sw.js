// Eagle Creek service worker: keeps the app itself on the device so it opens instantly,
// even with one bar of signal or none. Your data never passes through here: calls to
// Supabase and other sites go straight to them.
const VERSION = 'ec-1.3.0';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './plans.js',
  './contacts.js',
  './manifest.webmanifest',
  './icon-32.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png'
];

self.addEventListener('install', (event) => {
  // Straight from the site (not the browser's own cache), so an update installs whole.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app's own files: the saved copy at once (no waiting on a weak signal), refreshed in
// the background so an update shows the next time the app opens.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const saved = await cache.match(request, { ignoreSearch: true });
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      if (saved) {
        event.waitUntil(fresh);
        return saved;
      }
      const response = await fresh;
      if (response) return response;
      if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    })
  );
});

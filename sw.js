// Service worker: app shell en caché (offline), datos de la API siempre de red.
const VERSION = 'vcl-v7';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Marcadores: nunca de caché
  if (url.hostname === 'api.leverade.com') return;

  // Escudos de equipos: cache-first
  if (url.hostname === 'cdn.leverade.com') {
    e.respondWith(
      caches.open(VERSION + '-img').then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // App shell: stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(e.request, { ignoreSearch: true });
        const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

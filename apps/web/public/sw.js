/* JETPOOL minimal service worker: offline shell for navigations only.
   API responses and payment pages are never cached (transaction state must come from the server). */
const CACHE = 'jetpool-shell-v1';
const SHELL = ['/offline.html', '/icons/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/checkout') || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});

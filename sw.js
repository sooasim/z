/* Static demo: no offline cache. Removes any previously installed JETPOOL service worker. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then((cs) => cs.forEach((c) => c.navigate && c.navigate(c.url)))));

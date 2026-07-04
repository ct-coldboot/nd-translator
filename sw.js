const VERSION = 'v1';
const CACHE = 'subtext-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/storage.js',
  './js/prompt.js',
  './data/phrasebook.js',
  './manifest.webmanifest',
  './fonts/ClashDisplay-500.woff2',
  './fonts/ClashDisplay-600.woff2',
  './fonts/ClashDisplay-700.woff2',
  './fonts/Switzer-400.woff2',
  './fonts/Switzer-500.woff2',
  './fonts/Switzer-600.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(PRECACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName.startsWith('subtext-') && cacheName !== CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests on same origin, excluding /v1/ API calls
  if (event.request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.pathname.includes('/v1/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }

      return fetch(event.request).then(response => {
        // Only cache successful responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }

        const responseClone = response.clone();
        caches.open(CACHE).then(cache => {
          cache.put(event.request, responseClone);
        });

        return response;
      }).catch(() => {
        // Network failure: fall back to cached index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

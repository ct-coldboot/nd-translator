const VERSION = 'v3';
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

function cachePut(request, response) {
  if (response && response.status === 200 && response.type !== 'error') {
    const clone = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, clone));
  }
  return response;
}

// Code assets (the app shell, JS, CSS) are served network-first so a redeploy shows up
// on the next reload while online — no VERSION bump or cache-clearing dance needed. When
// offline, they fall back to cache (and navigations fall back to the cached index.html).
function isCodeAsset(url, request) {
  return request.mode === 'navigate' ||
    /\.(?:js|css|html|webmanifest)$/.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests on same origin, excluding /v1/ API calls
  if (event.request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.pathname.includes('/v1/')) {
    return;
  }

  if (isCodeAsset(url, event.request)) {
    event.respondWith(
      fetch(event.request)
        .then(response => cachePut(event.request, response))
        .catch(() => caches.match(event.request).then(hit =>
          hit || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
    return;
  }

  // Everything else (fonts, icons, static data) is cache-first: instant and fully
  // offline-capable, and these rarely change.
  event.respondWith(
    caches.match(event.request).then(hit =>
      hit || fetch(event.request).then(response => cachePut(event.request, response)))
  );
});

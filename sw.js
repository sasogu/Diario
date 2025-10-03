const CACHE_NAME = 'diario-v10';
const CORE_ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'crypto.js',
  'dropbox.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

function toAbsoluteUrl(path) {
  return new URL(path, self.location).toString();
}

self.addEventListener('install', (event) => {
  const assets = CORE_ASSETS.map(toAbsoluteUrl);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(assets))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(toAbsoluteUrl('index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

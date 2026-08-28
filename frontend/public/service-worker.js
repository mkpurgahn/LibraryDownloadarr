const CACHE_NAME = 'librarydownloadarr-v4';
const urlsToCache = [
  '/',
  '/index.html',
];

// Install service worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate service worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch with network-first strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiRequest = url.origin === self.location.origin && url.pathname.startsWith('/api/');
  if (event.request.method !== 'GET' || isApiRequest || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Don't cache if not a successful response
        if (response.status !== 200) {
          return response;
        }

        // Don't cache large files or certain content types
        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');
        const isLargeFile = contentLength && parseInt(contentLength) > 5 * 1024 * 1024; // 5MB
        const isZip = contentType.includes('application/zip');
        const isOctetStream = contentType.includes('application/octet-stream');

        // Skip caching for large files, zips, and binary downloads
        if (isLargeFile || isZip || isOctetStream) {
          return response;
        }

        // Clone the response for caching
        const responseToCache = response.clone();

        // Cache the response (don't await, fire and forget)
        caches.open(CACHE_NAME)
          .then((cache) => {
            cache.put(event.request, responseToCache);
          })
          .catch(() => {
            // Silently fail cache writes (e.g., if quota exceeded)
          });

        return response;
      })
      .catch(async () => (await caches.match(event.request)) || Response.error())
  );
});

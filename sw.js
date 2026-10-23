const CACHE_PREFIX = 'interest-calculator-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const APP_BASE_URL = new URL('./', self.registration.scope);
const APP_SHELL_URLS = [
  APP_BASE_URL.href,
  new URL('index.html', APP_BASE_URL).href,
  new URL('manifest.webmanifest', APP_BASE_URL).href,
  new URL('apple-touch-icon.png', APP_BASE_URL).href
];
const APP_SHELL_PATHS = new Set(APP_SHELL_URLS.map(url => new URL(url).pathname));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(APP_SHELL_URLS);
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  if (requestUrl.origin !== scopeUrl.origin || !requestUrl.pathname.startsWith(scopeUrl.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedPage = await cache.match(new URL('index.html', APP_BASE_URL).href)
        || await cache.match(APP_BASE_URL.href);
      if (cachedPage) return cachedPage;
      try {
        return await fetch(request);
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  if (!APP_SHELL_PATHS.has(requestUrl.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(requestUrl.pathname === APP_BASE_URL.pathname
      ? APP_BASE_URL.href
      : requestUrl.pathname);
    if (cachedResponse) return cachedResponse;
    return fetch(request);
  })());
});

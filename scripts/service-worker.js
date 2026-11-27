// REVISION and ASSETS are generated from the production build.
const scope = self.registration.scope;
const cachePrefix = `fluxity:${encodeURIComponent(scope)}:`;
const cacheName = cachePrefix + REVISION;
const entries = new Map(ASSETS.map(([path, integrity]) => [new URL(path, scope).href, integrity]));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    // addAll commits atomically. Integrity also protects stable filenames during a deployment.
    const requests = Array.from(entries, ([url, integrity]) => new Request(url, { integrity, cache: 'no-cache' }));
    await cache.addAll(requests);
  })());
});

// A tab can opt into a reload once the entire new build is saved. Keep other
// running simulations on their matching code and map data until they close.
self.addEventListener('message', event => {
  const client = event.source;
  if (event.data?.type !== 'apply-update' || client?.type !== 'window' || !client.url.startsWith(scope)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(other => other.id !== client.id && other.url.startsWith(scope))) {
      client.postMessage({ type: 'other-windows-open' });
      return;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Media players (including Safari) seek using byte ranges, even when the entire movie is cached.
async function rangedResponse(response, range) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || (!match[1] && !match[2])) return response;
  const blob = await response.blob();
  const start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
  if (start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': blob.type,
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  const key = url.href === scope ? new URL('index.html', scope).href : url.href;
  if (!entries.has(key)) return;
  event.respondWith((async () => {
    const response = await caches.match(key, { cacheName });
    if (!response) return fetch(request);
    const range = request.headers.get('Range');
    return range ? rangedResponse(response, range) : response;
  })());
});

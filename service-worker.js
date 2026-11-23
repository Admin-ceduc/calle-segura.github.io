const CACHE_NAME = 'calle-segura-v23';
const APP_BASE = self.registration.scope;
const appAsset = path => new URL(path, APP_BASE).href;
const APP_SHELL = [
  appAsset(''),
  appAsset('index.html'),
  appAsset('codigo.css?v=13'),
  appAsset('app.js?v=23'),
  appAsset('logo-calle-segura.png'),
  appAsset('logo-mark.svg'),
  appAsset('manifest.webmanifest')
];
const API_PATH = new URL('api/', APP_BASE).pathname;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(API_PATH)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(appAsset('index.html'))));
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});

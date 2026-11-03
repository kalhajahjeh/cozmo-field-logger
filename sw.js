// App-shell service worker (APP_SPEC §1): the app opens with no network.
// Bump CACHE on every deploy that changes a shell file.
var CACHE = 'cfl-shell-v0.2.0';
var SHELL = [
  './',
  'index.html',
  'style.css',
  'config.js',
  'db.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache first for the shell: never wait on the network to open the app.
// Non-GET requests (Session 2's POSTs to Apps Script) are not touched.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('index.html').then(function (shell) { return shell || fetch(req); });
      }
      return fetch(req);
    })
  );
});

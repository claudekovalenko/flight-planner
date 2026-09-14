/* Turnaround Ledger service worker.
 * VERSION is stamped with the commit SHA by scripts/build-pwa.mjs, so every deploy
 * gets a fresh cache and the old one is dropped on activate.
 */
const VERSION = 'febdf8c';
const CACHE = 'turnaround-ledger-' + VERSION;
const SHELL = ['./', 'index.html', 'plan.js', 'airports.js', 'world.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg'];
const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('turnaround-ledger-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page asks for this once the user accepts an update.
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

const putIfOk = (req, res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page itself: prefer the network so a deploy shows up, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => putIfOk(req, res))
        .catch(() => caches.match('index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Our own assets: serve from cache at once, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => putIfOk(req, res)).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Google Fonts: cache-first, and the CSS falls back to the local stack if it never arrives.
  if (FONT_HOSTS.indexOf(url.origin) !== -1) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => putIfOk(req, res)).catch(() => hit)));
  }
});

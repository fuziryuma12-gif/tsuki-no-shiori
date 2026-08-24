/* ============================================================
   月のしおり — Service Worker

   方針:
   - アプリの見た目（HTML/CSS/JS/アイコン）は先に取っておき、
     オフラインでも起動だけはできるようにする。
   - 記録そのもの（GASへの通信）はキャッシュしない。
     古い一覧を見せてしまうより、つながらないと分かる方がよい。
   ========================================================== */

const CACHE = 'shiori-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // GASへの通信は素通し
  if (url.hostname.endsWith('script.google.com') ||
      url.hostname.endsWith('googleusercontent.com')) {
    return;
  }

  // Google Fonts は取れたら貯める
  if (url.hostname.endsWith('fonts.googleapis.com') ||
      url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // 自分のファイルは、まずネットワーク、失敗したらキャッシュ
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
  }
});

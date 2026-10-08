/* ==========================================================================
   Service Worker · 离线外壳缓存
   --------------------------------------------------------------------------
   策略：
   - 应用外壳（html/css/js/图标）：cache-first，保证断网也能打开界面
   - Supabase 等跨域请求：完全不拦截，永远走网络（数据不缓存）
   ========================================================================== */
var VERSION = 'dsh-mobile-v6';
var SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './modules/scan.js',
  './modules/xhy.js',
  './modules/pr.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // 单个文件失败不影响整体安装
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域（Supabase / CDN）一律直连，不缓存
  if (url.origin !== self.location.origin) return;

  // 只在同源外壳范围内接管
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        // 后台静默更新
        fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') {
            caches.open(VERSION).then(function (c) { c.put(req, res.clone()); });
          }
        }).catch(function () { });
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

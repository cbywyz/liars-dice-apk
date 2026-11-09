/* 离线缓存：装到桌面后断网也能玩
 *
 * 策略要点（2026-11-09 改）：代码类请求一律「网络优先 + 强制校验」。
 * 以前这里是纯缓存优先，只要装过一次，index.html 更新了、f350.js 却还在吃旧缓存 ——
 * 于是出现「底栏版本号是新的、玩法行为还是旧的」，用户清浏览器缓存也治不好（清的
 * 是 HTTP 缓存，Cache Storage 里那份还在）。现在只要联网，就一定拿到最新代码；
 * 断网才回退到缓存。
 *
 * v37：发布时会给 css/js 的 URL 挂上提交号（f350.js?v=abc1234），每次部署 URL
 * 都不一样，旧缓存永远匹配不上。代价是断网时这些带参数的 URL 在缓存里找不到，
 * 所以回退那一步必须 ignoreSearch —— 否则断网会拿到一份 HTML 当 JS 用，整个包挂掉。
 */
var CACHE = 'liars-dice-clean-v39';
var FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './f350.css',
  './f350.js',
  './manifest.webmanifest',
  './assets/audio/shake.mp3',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(FILES.map(function (f) {
        /* 装的时候也别信 HTTP 缓存，直接要最新的 */
        return c.add(new Request(f, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* 会变的东西：页面本体、脚本、样式 */
function isCode(req, url) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  return /\.(?:html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.slice(-1) === '/';
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (isCode(req, url)) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        /* 断网 / 服务器挂了：退到缓存，页面还有得看。
           ignoreSearch 是给 ?v=提交号用的 —— 带参数的 URL 在缓存里只存了不带参数那份。 */
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match('./index.html') || caches.match('./');
        });
      })
    );
    return;
  }

  /* 图片、音频这些带指纹的静态资源照旧缓存优先，省流量 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () { return hit; });
    })
  );
});

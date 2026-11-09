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
 *
 * v42：新版本接管后，把还开着的老页签整页换新（activate 里 navigate 一次）。
 * 起因是「手机上那个页签开了好几天，摇出豹子还能继续摇、分数还照加」——
 * 页面里跑的是几天前的 JS，而它没有任何办法知道自己是旧的。
 * 页面内自检（index.html 末尾那段）只能救「已经带自检代码的版本」，救不了它之前的；
 * Service Worker 是唯一从外面能碰到这些窗口的东西，所以这一棒交给它。
 * 只在「升级」时刷，首次安装不刷（不然第一次打开会白重载一次）。
 */
var CACHE = 'liars-dice-clean-v42';
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
      /* 除了当前这份缓存，剩下的都是上一版的 —— 有剩就说明这是「升级」，不是首次安装 */
      var upgraded = keys.some(function (k) { return k !== CACHE; });
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      })).then(function () { return upgraded; });
    }).then(function (upgraded) {
      return self.clients.claim().then(function () {
        if (!upgraded) return;
        /* 把还停在旧脚本上的窗口导航一次。老页面里没有监听、没有自检，
           这是唯一能让它自己变成新版的途径；正在打牌的局确实会被打断，
           但 activate 基本只在「刚打开页面」时触发，那时还没开局。 */
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      }).then(function (list) {
        (list || []).forEach(function (c) {
          if (!c.navigate || !c.url) return;
          if (c.url.indexOf(self.registration.scope) !== 0) return;
          c.navigate(c.url).catch(function () {});
        });
      });
    })
  );
});

/* 会变的东西：页面本体、脚本、样式 */
function isCode(req, url) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  /* build.json 也走网络优先：页面靠它判断「我这个页签是不是几版以前的」，
     拿一份缓存的旧构建号就等于没查 */
  return /\.(?:html|js|css|webmanifest|json)$/.test(url.pathname) || url.pathname.slice(-1) === '/';
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

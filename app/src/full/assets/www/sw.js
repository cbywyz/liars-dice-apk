/* 离线缓存：装到桌面后断网也能摇 —— 网页版和 APK 之间最后一项差距
 *
 * 2026-11-21 起这个文件**真的被注册了**（index.html 底部那段）。之前一直躺在目录里
 * 没人调用，等于没有：飞行模式、酒桌上没信号、地铁里，打开就是白屏。
 *
 * 策略：代码类（页面 / js / css / build.json）一律「网络优先」，网络 1.5 秒没回来
 * 就先拿缓存顶上，后台继续把新的写进去。
 *   · 网络好 → 每次打开都是最新部署，不需要重装、不需要清缓存（这是网页版的优点，别弄丢）
 *   · 网络差 / 断网 → 1.5 秒内出画面，绝不白屏
 *   · 为什么不干脆缓存优先：那样「更新了刷新还是旧的」，跟装 APK 不升级没区别
 *
 * 缓存键统一用不带 query 的 URL。发布时脚本是 app.js?v=<commit>，每版都换；
 * 若按原样存，Cache Storage 里会一版一份、越积越多。归一化后每个文件永远只有一份，
 * 断网时带参数的请求用 ignoreSearch 也能命中。
 *
 * CACHE 名里的 __BUILD__ 由 CI 替换成提交号（.github/workflows/build.yml）。名字一变
 * 就是一次全新 install，activate 里顺手删掉上一版的缓存，不会残留。
 *
 * 名字里的 full / clean 是**版本分组**，不是装饰：
 * 两版网页在同一个 origin 下（/ 和 /clean/），Cache Storage 是整个 origin 共用的。
 * 若 activate 无脑删「不是我的就删」，完整版和纯净版会互相清缓存 —— 两个都装了的
 * 人来回点，每次都得重新下 200KB。所以只清自己这一组的旧版（FAMILY 前缀）。
 */

var CACHE = 'liars-dice:full:__BUILD__';
/* 'liars-dice:full:' —— 同一个「组」的所有历史版本都长这样 */
var FAMILY = CACHE.slice(0, CACHE.lastIndexOf(':') + 1);

/* 该不该删：自己组的旧版，以及 2026-11 之前的旧命名（liars-dice-v42 那种）。
   别人的组（clean / full）一律不碰。 */
function stale(k) {
  if (k === CACHE) return false;
  if (k.indexOf(FAMILY) === 0) return true;
  return k.indexOf('liars-dice-') === 0 && k.indexOf(':') < 0;
}

/* install 时要预热的文件。拿不到的（比如以后删了某个图）直接跳过，不能因为一个 404
   让整个 SW 装不上。 */
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

/* 一个文件在缓存里的键：去掉 ?v=xxx 这种发布号，只留路径 */
function keyOf(url) {
  return url.origin + url.pathname;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(FILES.map(function (f) {
        /* 装的时候别信 HTTP 缓存，直接要最新的 */
        return c.add(new Request(f, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () {
      /* 不等用户关页面，新 SW 立刻进入等待 → 下次 navigation 就用它 */
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (stale(k)) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* 会变的：页面本体、脚本、样式、构建号 */
function isCode(req, url) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  /* build.json 也走网络优先：页面靠它判断「我这个页签是不是几版以前的」，
     拿一份缓存的旧构建号等于没查 */
  return /\.(?:html|js|css|webmanifest|json)$/.test(url.pathname) ||
    url.pathname.slice(-1) === '/';
}

/* 断网 / 超时时的退路：先按原样的 URL 找（ignoreSearch 让 ?v= 也能对上），
   再退到 index.html，最后退到根路径。 */
function fallback(req) {
  return caches.match(req, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return caches.match('./index.html').then(function (h2) {
      return h2 || caches.match('./');
    });
  });
}

/* 慢网兜底：超过这个时间还没响应就先给缓存，别让用户对着白屏等 */
var SLOW = 1500;

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  /* 只要同源的 http(s)：别去碰 data: / blob: / chrome-extension: */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (isCode(req, url)) {
    e.respondWith(new Promise(function (resolve) {
      var settled = false;
      function use(res) {
        if (settled || !res) return;
        settled = true;
        resolve(res);
      }

      /* 1) 网络优先。cache:'no-cache' 逼浏览器回去问一次，不吃 HTTP 缓存 */
      var net = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(keyOf(url), copy);
          }).catch(function () {});
        }
        return res;
      });

      /* 2) 慢网：到点先拿缓存顶上，页面不至于白着。网络那份还在跑，回来照样写进缓存 */
      var timer = setTimeout(function () {
        fallback(req).then(use).catch(function () {});
      }, SLOW);

      net.then(function (res) {
        clearTimeout(timer);
        use(res);
      }).catch(function () {
        clearTimeout(timer);
        fallback(req).then(function (hit) {
          use(hit || Response.error());
        }).catch(function () {
          use(Response.error());
        });
      });
    }));
    return;
  }

  /* 图片、音频这些带指纹的静态资源照旧缓存优先，省流量、秒开 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(keyOf(url), copy);
          }).catch(function () {});
        }
        return res;
      }).catch(function () { return hit; });
    })
  );
});

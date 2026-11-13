/* 找朋友 · 联机版客户端（每人一台手机）。

   跟单机那份（find.js）最大的不同：
     · 点数不由手机决定，全部来自服务器广播的 state —— 谁都改不了「摇到好牌为止」
     · 自己的骰子只能自己点（房主可以替掉线的人点），次数由服务端数
     · 公骰只有「这一家」能摇，各家没摇完不给开（服务端也会拦，这里只是提前说清）

   原型都在 find.css 里（圆环、座位、九宫格骰子、公骰圆盘），这里只补
   「开房 / 大厅 / 顶部状态条」这一层，视觉不另起一套。 */

(function () {
  'use strict';

  var DEFAULT_API = 'https://dice.2582580.xyz';
  var HOME_HOST = 'dice.2582580.xyz';
  var NAME_KEY = 'ld_net_name';        // 跟 350 共用一个昵称，别让人一回一个名字
  var SEAT_KEY = 'ld_fn_seat_';

  /* 人数跟服务端 FIND_MIN / FIND_MAX 一个口径（2~12）。
     别在这三处再各写一个字面量 4 —— 上次放开人数就是被写死的 4 卡住的。 */
  var MIN_P = 2;
  var MAX_P = 12;

  var NAMES = [
    '橙子', '阿七', '小满', '豆豆', '老王', '阿珍', '大熊', '小北',
    '冬瓜', '阿飞', '团子', '花生', '阿May', '芒果', '小雨', '阿宝',
    '毛豆', '小鱼', '二两', '阿伟', '桃子', '小鹿', '阿泰', '年糕'
  ];

  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var RED = { 1: true, 4: true };

  var S = {
    api: DEFAULT_API, code: '', ws: null, you: null, token: null,
    st: null, alive: false, retry: 0, retryTimer: 0, pingTimer: 0, tt: 0,
    /* 投票倒计时用：服务端每次广播给的是「还剩几毫秒」，
       本地换算成一个截止时刻，按钮上的秒数才走得动 */
    voteUntil: 0, kickUntil: 0, tickTimer: 0,
    /* 左边那张投票浮卡：vcSpan = 这次投票的总时长（进度条用），
       vcKey = 这一次投票的身份（谁被请 + 谁发起的），换了人就要重新滑进来 */
    vcSpan: 0, vcKey: ''
  };

  var el = {};
  var seatEls = [];

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 环境 / 小工具 ---------------- */

  function apiBase() {
    if (window.LDNet && window.LDNet.api) {
      var a = window.LDNet.api();
      if (a) return String(a).replace(/\/+$/, '');
    }
    if (window.LD_NET_BASE) return String(window.LD_NET_BASE).replace(/\/+$/, '');
    if (location.hostname === HOME_HOST) return location.origin;
    return DEFAULT_API;
  }

  /* 名字统一由「联机」首页那一层给（window.LDName，见 f350.js）：
     这里只是取一下，取不到才自己兜底。别再各自维护一个名字池。 */
  function myName() {
    if (window.LDName) return window.LDName.get();
    try {
      var n = (localStorage.getItem(NAME_KEY) || '').trim();
      if (n) return n;
      n = NAMES[Math.floor(Math.random() * NAMES.length)] || '玩家';
      localStorage.setItem(NAME_KEY, n);
      return n;
    } catch (e) { return '玩家'; }
  }

  function loadSeat(code) {
    try {
      var raw = localStorage.getItem(SEAT_KEY + code);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveSeat() {
    if (!S.code || !S.you) return;
    try {
      localStorage.setItem(SEAT_KEY + S.code, JSON.stringify({ pid: S.you, token: S.token }));
    } catch (e) {}
  }

  /* ---------- 上一桌：退出之后还能回来 ----------
     350 那边一直有这张「上一桌还没打完」的卡，找朋友这边以前没有：
     退出来就只能干看着，房号忘了就更回不去（2026-11-10 用户提的）。
     存的只是房号和时间 —— 座位认不认得回来由服务器凭 SEAT_KEY 里的 token 决定，
     所以这张卡只负责「把人送到那张桌前」，不承诺一定还有位置。 */
  var LAST_KEY = 'ld_find_last';

  function saveLast() {
    if (!S.code) return;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ code: S.code, at: Date.now() }));
    } catch (e) {}
  }

  function lastRoom() {
    try {
      var o = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (!o || !/^(\d{4}|\d{6})$/.test(o.code || '')) return null;
      /* 一天以前的就算了：空房早被清掉，摆着只会点进去扑空 */
      if (Date.now() - (o.at || 0) > 86400000) return null;
      return o;
    } catch (e) { return null; }
  }

  function clearLast() {
    try { localStorage.removeItem(LAST_KEY); } catch (e) {}
  }

  function buzz(pat) {
    try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {}
  }

  function tip(msg) {
    if (!el.tip) return;
    /* 牌桌那一屏没有 tip 那一行（它在「拿房号」那一屏），
       所以人在桌上时借用提示行的明细位置显示 —— 服务端拒绝的理由必须看得见 */
    if (el.table && !el.table.hidden && S.st) { flash(msg || ''); return; }
    el.tip.textContent = msg || '';
    el.tip.classList.toggle('show', !!msg);
  }

  function nameOf(i) {
    var st = S.st;
    var s = st && st.seats[i];
    return s ? s.name : (i + 1) + ' 号';
  }

  function settled(s) { return !!(s.dice && (s.dice[0] || s.dice[1])); }
  /* 这一把算不算他：跟服务端 findOut 一个口径 —— 中途进来的（sitOut）和掉线的都算「不在圈里」。
     掉线也要排除：他不在，却卡在「还有 1 家没摇」上，公骰永远摇不了。 */
  function outOf(s) { return !!(s && (s.sitOut || s.online === false)); }
  function dsum(v) { return v[0] + v[1]; }
  function mySeat() {
    var st = S.st;
    if (!st) return null;
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].id === st.you) return st.seats[i];
    return null;
  }
  function myIdx() {
    var st = S.st;
    if (!st) return -1;
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].id === st.you) return i;
    return -1;
  }
  function isHost() { return !!(S.st && S.st.host && S.st.host === S.st.you); }
  function iAmShaker() { return S.st && myIdx() === S.st.shaker; }
  /* 庄家手机没电了，谁能替他摇公骰 / 点人：房主；房主自己也不在，桌上随便谁。
     跟服务端 findCanActFor 同一套规矩 —— 不然按下去只会收到一句「还没轮到你」。 */
  function canStandIn() {
    var st = S.st;
    if (!st || !st.seats.length) return false;
    var host = null;
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].seat === 0) host = st.seats[i];
    if (!host) return true;
    return host.id === st.you || host.online === false;
  }
  function shakerOff() {
    var st = S.st;
    var s = st && st.seats[st.shaker];
    return !!(s && s.online === false);
  }

  /* ================= 音效 =================
     全站一颗 shake.mp3（吹牛 / 350 / 联机 350 都是这一颗）。
     找朋友这块一直没接音频，2026-11-10 用户报「摇骰子没有声音」。

     联机这里跟单机不一样：**骰子是服务端摇的**，没有「我按下去就滚」这个动作可挂。
     声音只能跟着 state 变 —— 自己那两颗换了、或者公骰刚摇出来，才出声。
     全桌重摇（换人）时大家同时清空，那一下不响，否则一桌 12 台一起炸。 */
  var shk = null;

  function ensureShk() {
    if (shk) return shk;
    try {
      shk = new Audio('assets/audio/shake.mp3');
      shk.preload = 'auto';
      shk.addEventListener('error', function () { shk = null; });
    } catch (e) { shk = null; }
    return shk;
  }

  function unlockShk() {
    var a = ensureShk();
    if (!a) return;
    try {
      a.muted = true;              // 解锁这一下不能真出声
      var p = a.play();
      var quiet = function () { a.pause(); a.currentTime = 0; a.muted = false; };
      if (p && p.then) p.then(quiet).catch(function () { a.muted = false; });
      else quiet();
    } catch (e) { if (shk) shk.muted = false; }
  }

  function playShake() {
    if (window.LDSnd && !window.LDSnd.isOn()) return;
    var a = ensureShk();
    if (!a) return;
    try {
      a.muted = false;
      a.currentTime = 0;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  /* 换人 / 11 正豹 / 有人喝：全站共用的合成音（snd.js）。
     联机这边只能等服务端的 state 回来才知道出了什么，所以这类提示音全部
     「跟着 state 变」—— 挂不到点击上，谁是庄家谁点的都可能不是同一台手机。 */
  function cue(name) {
    if (window.LDSnd) window.LDSnd.cue(name);
  }

  function diceKey(s) { return (s && s.dice && (s.dice[0] || s.dice[1])) ? s.dice.join('') : ''; }
  function coreKey(c) { return c ? c.join('') : ''; }

  /* 两份 state 之间该不该出声：我点了摇 / 公骰刚出来 */
  function shakeSound(prev, now) {
    var i = myIdx();
    if (prev && now && i >= 0) {
      var p0 = prev.seats && prev.seats[i], p1 = now.seats && now.seats[i];
      /* 次数往上走 = 我刚摇了（点数撞成一样也照样响） */
      if (p0 && p1 && (p1.used | 0) > (p0.used | 0)) return true;
      if (diceKey(p1) && diceKey(p1) !== diceKey(p0)) return true;
      if (coreKey(now.center) && coreKey(now.center) !== coreKey(prev.center)) return true;
    }
    return false;
  }
  function unrolled() {
    var st = S.st, k = 0;
    if (!st) return 0;
    /* 跟服务端 findUnrolled 一个口径：这一把不在圈里（sitOut / 掉线）的不算「没摇」，
       否则新进来的人一坐下，或者谁手机断一下，整桌就永远显示「还有 1 家没摇」 */
    for (var i = 0; i < st.seats.length; i++) {
      if (!outOf(st.seats[i]) && !settled(st.seats[i])) k++;
    }
    return k;
  }

  /* 本地留一份玩家自己的偏好标记，换手机不同步 */

  var DBG_KEY = 'ld_find_dbg';
  /* 几项都在本地存着，换手机不同步 */
  var dbg = { hot: false, mid: false, self: false, lion: false, nd: false, must: false };

  /* 五个「只这一把」的开关，用一个键名列表数一数开了几个 —— 对账两边一致时要用 */
  var DBG_ONCE = ['mid', 'self', 'lion', 'nd', 'must'];

  function dbgAny(d) {
    for (var i = 0; i < DBG_ONCE.length; i++) if (d[DBG_ONCE[i]]) return true;
    return false;
  }

  function loadDbg() {
    try {
      var o = JSON.parse(localStorage.getItem(DBG_KEY) || 'null');
      if (o) {
        dbg.hot = !!o.hot;
        for (var i = 0; i < DBG_ONCE.length; i++) dbg[DBG_ONCE[i]] = !!o[DBG_ONCE[i]];
      }
    } catch (e) {}
  }

  function saveDbg() {
    try { localStorage.setItem(DBG_KEY, JSON.stringify(dbg)); } catch (e) {}
  }

  /* 把自己的开关告诉房间。只发自己那几项 —— 服务端照着它改牌桌 */
  function sendDbg() {
    if (!S.ws || S.ws.readyState !== 1) return;
    try {
      S.ws.send(JSON.stringify({
        t: 'dbg', mid: !!dbg.mid, self: !!dbg.self, lion: !!dbg.lion,
        nd: !!dbg.nd, must: !!dbg.must
      }));
    } catch (e) {}
  }

  function dbgArm() { return false; }

  /* 四格能不能接手指：总开关 + 四格总闸都开着才算。
     关着时整条是 pointer-events:none，它不挡座位上的点击。 */
  function dbgHotOn() { return dbgArm() && dbg.hot; }

  function paintDbg() {
    var on = dbgArm();
    if (el.dbg) {
      var rows = el.dbg.querySelectorAll('.dbg-row[data-k]');
      for (var i = 0; i < rows.length; i++) {
        var k = rows[i].getAttribute('data-k');
        rows[i].classList.toggle('is-on', !!dbg[k]);
      }
    }
    if (el.hot) el.hot.classList.toggle('on', on && dbg.hot);
  }

  function setDbg(k, v) {
    dbg[k] = !!v;
    /* 关总闸 = 全关。用户点「总闸」想的是「把这一套停掉」；
       只让五格失灵、功能还在暗处生效，是上一版最容易误会的地方
       （2026-11-10 反馈：明明关了还老出正豹）。 */
    if (k === 'hot' && !v) {
      for (var i = 0; i < DBG_ONCE.length; i++) dbg[DBG_ONCE[i]] = false;
    }
    saveDbg();
    paintDbg();
    /* 完全没有视觉反馈，只能靠手感：开 = 两下短的，关 = 一下长的（跟吹牛一致） */
    buzz(v ? [14, 75, 14] : 45);
    if (window.LDDev) window.LDDev.keep();
    /* 关总闸也要发：上面刚把那五项一起灭了，不告诉服务器等于白灭 */
    if (k !== 'hot' || !v) sendDbg();
  }

  function openDbg() {
    if (!el.dbg) return;
    if (window.LDDev) window.LDDev.keep();
    buzz(16);
    paintDbg();
    el.dbg.hidden = false;
    /* 手指还按在标题上：松手那一下会被当成面板里的一次点击，
       先把面板挡 400ms（吹牛那边也是这么处理的） */
    var sheet = el.dbg.querySelector('.dbg-sheet');
    if (sheet) {
      sheet.style.pointerEvents = 'none';
      setTimeout(function () { sheet.style.pointerEvents = ''; }, 400);
    }
  }

  function closeDbg() {
    if (el.dbg) el.dbg.hidden = true;
  }

  /* 长按标题 1.2 秒。总开关关着的时候连计时都不起 ——
     跟一块普通文字没有区别，不震、不弹。 */
  function bindTitle() {
    var t = el.title;
    if (!t) return;
    var timer = 0;
    function start() {
      if (!dbgArm()) return;
      clearTimeout(timer);
      timer = setTimeout(function () { timer = 0; openDbg(); }, 1200);
    }
    function stop() {
      if (timer) { clearTimeout(timer); timer = 0; }
    }
    t.addEventListener('touchstart', start, { passive: true });
    t.addEventListener('touchend', stop);
    t.addEventListener('touchcancel', stop);
    t.addEventListener('mousedown', start);
    t.addEventListener('mouseup', stop);
    t.addEventListener('mouseleave', stop);
    /* 手机上长按会弹「选择文字 / 复制」，弹出来就把长按这件事全暴露了 */
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* 点一格 = 开，再点 = 关。五格对应五项，随时能停（用户 2026-11-10 的要求） */
  var HOT_MAP = { '1': 'mid', '2': 'self', '3': 'lion', '4': 'nd', '5': 'must' };

  /* 这条带是**看不见**的：手指稍微偏一点就落在空白上，什么都不会发生，
     用起来像「按不到」（2026-11-10 反馈）。所以不认「点在哪个元素上」，
     改认「点在哪一片坐标」—— 而且比那条带大得多：

       ┌───────┬───────┬───────┐  ← 圆环下方那一整片，横向切三格
       │   1   │   2   │   3   │     1 避雷区 / 2 公骰避开自己 / 3 出 11
       └───────┴───────┴───────┘
       ...（轮到你／等 3 家／摇我的 2 颗）...
       ┌─────┐      ▲      ┌─────┐  ← 只落在最底下那条页脚的左右两角
       │  4  │   重开一桌   │  5  │     4 整桌不重复 / 5 必中避己
       └─────┘           └─────┘

     上排往上一直铺到圆环下半部分（那块是纯展示，没绑定任何点击）。
     下排**必须躲开「接手 / 等 N 家摇完」那颗大按钮**：量过坐标，那颗按钮
     贴着底栏，占 y 705~755；原来下排按「带子下方 +69px」算，两格正好搭在
     按钮的两个下角上 —— 总闸开着的时候点按钮，会顺手把 4 / 5 翻掉
     （2026-11-10 自查发现）。

     所以下排**不能跟着带子算**：带子会随内容上下移动，底栏那几颗按钮却一直
     钉在屏幕底边。改成按整个屏幕的高度算 —— 屏幕下方 52~94px 那一条，
     它上面是按钮（底边 755），下面是「玩法说明」（顶边 805），
     中间这条正好是空的，而且换谁来摇、按钮叫什么，这条空当都不动。 */
  function hotCellAt(x, y) {
    if (!el.hot) return 0;
    var r = el.hot.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    /* 上排：圆环下半 120px + 这条带本身，三格 */
    if (y >= r.top - 120 && y <= r.bottom) {
      var i = Math.floor((x - r.left) / (r.width / 3)) + 1;
      return i < 1 ? 1 : (i > 3 ? 3 : i);
    }
    /* 下排：离屏幕底边 52~94px 那一条，左边归 4、右边归 5，中间留给「重开一桌」 */
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vh && y > vh - 94 && y <= vh - 52) {
      var k = (x - r.left) / r.width;
      if (k < 0.38) return 4;
      if (k > 0.71) return 5;
    }
    return 0;
  }

  function onHotTap(e) {
    if (!dbgHotOn()) return;
    /* 面板开着的时候，它自己就压在带上：那几下点的是面板，别顺手翻两个开关 */
    if (el.dbg && !el.dbg.hidden) return;
    /* 手指落在真按钮 / 输入框上，那一下就是按钮的 —— 隐形格再大也不抢。
       五格自己是 pointer-events:none，所以这一按原本就落到按钮上，
       这里只是再兜一道：坐标算出来的格子，不许吃掉一个带字的控件。 */
    var t = e.target;
    if (t && t.closest && t.closest('button, a, input, select, textarea')) return;
    var z = hotCellAt(e.clientX, e.clientY);
    if (!z) return;
    var k = HOT_MAP[String(z)];
    if (k) { setDbg(k, !dbg[k]); e.preventDefault(); }
  }

  /* ---------------- 连接 ---------------- */

  function wsUrl() {
    return S.api.replace(/^http/, 'ws') + '/r/' + S.code + '/ws';
  }

  function connect() {
    if (!S.code) return;
    closeSocket();
    S.alive = true;

    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { retryLater(); return; }
    S.ws = ws;

    ws.onopen = function () {
      if (S.ws !== ws) return;
      S.retry = 0;
      showOff(false);
      var seat = loadSeat(S.code);
      ws.send(JSON.stringify({
        t: 'hello', name: myName(),
        pid: seat && seat.pid, token: seat && seat.token
      }));
      startPing();
    };

    ws.onmessage = function (ev) {
      if (S.ws !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMsg(m);
    };

    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.ws = null;
      stopPing();
      if (S.alive) { showOff(true); retryLater(); }
    };

    ws.onerror = function () {};
  }

  function retryLater() {
    if (!S.alive) return;
    clearTimeout(S.retryTimer);
    /* 退避到 8 秒封顶：酒桌上手机时好时坏，一直猛连只会更费电 */
    S.retry = Math.min(S.retry + 1, 4);
    S.retryTimer = setTimeout(connect, 500 * Math.pow(2, S.retry));
  }

  function closeSocket() {
    var ws = S.ws;
    S.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    stopPing();
  }

  function startPing() {
    stopPing();
    S.pingTimer = setInterval(function () {
      if (S.ws && S.ws.readyState === 1) {
        try { S.ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {}
      }
    }, 20000);
  }

  function stopPing() {
    if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = 0; }
  }

  function send(o) {
    if (S.ws && S.ws.readyState === 1) {
      try { S.ws.send(JSON.stringify(o)); return true; } catch (e) {}
    }
    tip('还没连上，等一下再点');
    return false;
  }

  function onMsg(m) {
    if (m.t === 'you') {      S.you = m.pid;
      S.token = m.token;
      if (m.code) S.code = m.code;
      saveSeat();
      /* 真的坐上桌了才记「上一桌」：连都没连上就记，等于给人摆一个点进去扑空的入口 */
      saveLast();
      /* 自己的那几项标记跟着这条连接报上去（断线重连不用重新点） */
      sendDbg();
      return;
    }
    /* 被请出去：以前找朋友根本踢不了人，这条消息从来没到过。
       现在要认它 —— 不然座位上的人凭空消失，他还以为手机网络抽了，
       会一直点重连。说清楚，然后把座位记录清掉，别让「上一桌」卡在首页。 */
    /* 自己点「退出」：服务端已经把座位摘掉了，这儿收尾 */
    if (m.t === 'quitok') { finishQuit(); return; }
    if (m.t === 'kicked') {
      var msg = m.msg || '你被请出了这一桌';
      try { localStorage.removeItem(SEAT_KEY + S.code); } catch (e) {}
      clearLast();
      leaveAll();
      /* 回到「进房」那一屏，把那句话留在房号下面：
         这一屏没有吐司，直接切到选玩法页的话，人被踢了却什么都没看见 */
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('findnet');
      tip(msg);
      return;
    }

    if (m.t === 'err') {
      /* 服务端的拒绝就是最终答案（次数用完 / 没轮到你 / 已经锁了），
         直接照它说的显示，不在本地猜一套 */
      tip(m.msg || '这一步不行');
      return;
    }
    if (m.t === 'state') {
      var prev = S.st;
      S.st = m.s;
      /* 倒计时按「服务器说还剩多久」重新起算：手机时间准不准都不影响 */
      S.voteUntil = S.st && S.st.vote ? Date.now() + S.st.vote.left : 0;
      S.kickUntil = S.st && S.st.kick ? Date.now() + S.st.kick.left : 0;
      if (S.st && S.st.game && S.st.game !== 'find') {
        tip('这个房号是「潮汕 350」的房间，不是找朋友');
        return;
      }
      /* 换人 = 新的一把：上一把那些一次性标记在这里归零 */
      var turnKey = (S.st.round | 0) + ':' + (S.st.shaker | 0);
      var keyShift = !!(S.dbgKey && S.dbgKey !== turnKey);
      if (keyShift && dbgAny(dbg)) {
        for (var i = 0; i < DBG_ONCE.length; i++) dbg[DBG_ONCE[i]] = false;
        saveDbg();
      }
      S.dbgKey = turnKey;
      /* 换人以外的广播（别人摇骰、有人进出）不该动这几个开关，但服务端那份才是准的：
         重开一局它清过，我这边要是还亮着，就跟着灭掉；反过来我这边亮着它那边没有
         （刚开局、刚重连），再报一次上去。两边始终是同一份。 */
      if (!keyShift) {
        var sb = S.st.dbg;
        if (sb) {
          var diff = false;
          for (var j = 0; j < DBG_ONCE.length; j++) {
            var k2 = DBG_ONCE[j];
            if (!!dbg[k2] !== !!sb[k2]) { dbg[k2] = !!sb[k2]; diff = true; }
          }
          if (diff) saveDbg();
        } else if (dbgAny(dbg)) {
          sendDbg();
        }
      }
      var prevPhase = prev ? prev.phase : '';
      render();

      /* 投票浮卡：跟阶段、弹层都无关，只要有人被投票请走就画出来 */
      syncVoteCard();

      /* 有人发起重开 / 有人想请谁出去：不说一句，桌上只会看见按钮突然变了样 */
      if (S.st.vote && !(prev && prev.vote)) {
        flash(nameOf(idxIn(S.st, S.st.vote.by)) + ' 发起重开 · 要 ' +
              S.st.vote.need + ' 人同意');
        buzz(12);
      }
      if (S.st.kick && !(prev && prev.kick)) {
        flash('有人想请 ' + nameOf(idxIn(S.st, S.st.kick.target)) + ' 出去 · 要 ' +
              S.st.kick.need + ' 人同意');
      }
      /* 弹层开着就跟着刷：别人投了一票，你手上那份不该停在打开那一刻 */
      if (el.logMask && !el.logMask.hidden) {
        if (sheetTab === 'log') renderLog(); else paintPeople();
      }
      if (S.st.vote || S.st.kick) startTick(); else stopTick();
      if (prev && prev.started && S.st.started && shakeSound(prev, S.st)) playShake();
      if (prev && prev.started && S.st.started) {
        if (prev.phase !== S.st.phase) {
          if (S.st.phase === 'pick') { buzz([16, 60, 16]); cue('lion'); }
          else if (S.st.phase === 'hit') { buzz([22, 70, 22]); cue('drink'); }
          /* 换人：整桌都响一下，接手的那位额外有个金圈在跳（.fd-seat.next）。
             声音负责把低头看手机的人叫回来，圈负责告诉他「是你」。 */
          else if (S.st.phase === 'pass') cue('pass');
        }
        var myTurnBefore = prev.seats && prev.shaker === idxIn(prev, prev.you);
        var myTurnNow = S.st.shaker === myIdx();
        if (!myTurnBefore && myTurnNow && prevPhase !== S.st.phase) buzz([16, 60, 16]);
      }
      return;
    }
  }

  function idxIn(st, id) {
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].id === id) return i;
    return -1;
  }

  /* ---------------- 进入 / 离开 ---------------- */

  function enterRoom(code) {
    S.code = String(code || '').replace(/\D/g, '').slice(0, 6);
    S.st = null;
    S.you = null;
    render();
    connect();
  }

  function leaveAll() {
    S.alive = false;
    clearTimeout(S.retryTimer);
    closeSocket();
    S.code = '';
    S.st = null;
    S.you = null;
    /* 弹层和倒计时跟着这一桌一起收：换一桌还挂着上一桌的战报最容易被误读 */
    closeSheet();
    stopTick();
    S.voteUntil = 0;
    S.kickUntil = 0;
    showOff(false);
    render();
  }

  /* ---------------- 主动退出这一桌 ----------------

     跟「← 暂时离开」是两件事：这里要真把座位让出来。服务端收到 {t:'quit'}
     会走摘人流程（座位重排、公骰轮次修正），回一句 quitok；本地还得把
     房号和座位 token 一起清掉，不然回首页又弹出「上一桌还没打完」。 */
  function finishQuit() {
    if (!S.quitting) return;
    S.quitting = false;
    clearTimeout(S.quitTimer);
    var code = S.code;
    if (code) { try { localStorage.removeItem(SEAT_KEY + code); } catch (e) {} }
    clearLast();
    leaveAll();
    if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
  }

  function quitRoom() {
    if (S.quitting) return;
    if (!S.code) {
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
      return;
    }
    S.quitting = true;
    if (!send({ t: 'quit' })) { finishQuit(); return; }
    S.quitTimer = setTimeout(finishQuit, 900);
  }

  function createRoom() {
    if (!S.api) return;
    tip('正在开一桌…');
    fetch(S.api + '/api/new?game=find', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { tip((j && j.msg) || '开房失败，再试一次'); return; }
        tip('');
        enterRoom(j.code);
      })
      .catch(function () { tip('连不上服务器 · 检查一下网络'); });
  }

  function joinRoom() {
    var code = (el.code.value || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 4 && code.length !== 6) { tip('房号是 4 位数字'); return; }
    tip('正在找这个房间…');
    fetch(S.api + '/api/has?code=' + code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { tip((j && j.why) || '房号不对'); return; }
        if (!j.room) { tip('没有这个房间 · 房号念对了吗'); return; }
        if (j.room.game && j.room.game !== 'find') {
          tip('这个房号是「潮汕 350」的房间'); return;
        }
        tip('');
        enterRoom(code);
      })
      .catch(function () { tip('连不上服务器 · 检查一下网络'); });
  }

  /* ---------------- 渲染 ---------------- */

  function showOff(on) {
    if (el.off) el.off.hidden = !on;
  }

  function render() {
    var st = S.st;
    var screen = !S.code ? 'gate' : (!st || !st.started ? 'lobby' : 'table');
    if (el.gate) el.gate.hidden = screen !== 'gate';
    if (el.lobby) el.lobby.hidden = screen !== 'lobby';
    if (el.table) el.table.hidden = screen !== 'table';

    if (screen === 'lobby') paintLobby();
    if (screen === 'table') paintTable();
    /* 三格能不能接手指，取决于首页那个总开关 —— 每次重画都问一句，
       免得「在首页开了、回来还是按不动」 */
    paintDbg();
  }

  function paintLobby() {
    var st = S.st;
    el.lobbyCode.textContent = S.code;
    el.lobbyTip.textContent = st
      ? (st.seats.length < MIN_P
          ? '现在 ' + st.seats.length + ' 人 · 满 ' + MIN_P + ' 人就能开'
          : st.seats.length + ' 人 · 可以开局了')
      : '正在进房…';

    var h = '';
    var seats = st ? st.seats : [];
    for (var i = 0; i < seats.length; i++) {
      var me = seats[i].id === (st && st.you);
      h += '<div class="fn-pl' + (me ? ' me' : '') + (seats[i].online === false ? ' off' : '') + '">' +
           '<span class="fn-pl-n">' + (i + 1) + '</span>' +
           '<span class="fn-pl-name">' + seats[i].name + (me ? ' · 我' : '') + '</span>' +
           (st && st.host === seats[i].id ? '<span class="fn-pl-host">房主</span>' : '') +
           '</div>';
    }
    el.lobbyList.innerHTML = h;

    var can = st && seats.length >= MIN_P;
    el.lobbyStart.disabled = !can;
    el.lobbyStart.classList.toggle('is-off', !can);
    el.lobbyStart.textContent = can ? '开局 · ' + seats.length + ' 人' : '还差 ' + (MIN_P - seats.length) + ' 人';
  }

  /* 骰子：九宫格点，尺寸由 --s 派生 */
  function dieHtml(v, size) {
    var on = PIPS[v] || [];
    var h = '<span class="fd-d' + (v ? '' : ' empty') + '"' +
      (size ? ' style="--s:' + size + '"' : '') + '>';
    for (var i = 0; i < 9; i++) {
      h += on.indexOf(i) >= 0
        ? '<i class="' + (RED[v] ? 'r' : '') + '"></i>'
        : '<i class="blank"></i>';
    }
    return h + '</span>';
  }

  function paintDice(box, vals, size, pop) {
    var key = vals.join('') + '|' + size;
    if (box.getAttribute('data-k') === key) return;
    box.setAttribute('data-k', key);
    var h = '';
    for (var i = 0; i < vals.length; i++) h += dieHtml(vals[i], size);
    box.innerHTML = h;
    if (pop) {
      var ds = box.children;
      for (var j = 0; j < ds.length; j++) ds[j].classList.add('pop');
    }
  }

  function buildSeats(n) {
    el.seats.innerHTML = '';
    seatEls = [];
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'fd-seat';
      s.setAttribute('data-i', String(i));

      /* 1 号左上起、顺时针 —— 跟单机那份同一个摆法 */
      var th = 270 - 360 / n + i * (360 / n);
      var rad = th * Math.PI / 180;
      var R = 0.78;
      s.style.left = (50 + 50 * R * Math.cos(rad)).toFixed(2) + '%';
      s.style.top = (50 + 50 * R * Math.sin(rad)).toFixed(2) + '%';
      if (n >= 10) s.style.width = '16.2vw';

      s.innerHTML =
        '<span class="fd-n"><i class="me-tag" hidden>我</i><span class="fd-nx"></span></span>' +
        '<span class="fd-dice" data-k=""></span>' +
        '<span class="fd-cups"></span>' +
        '<span class="fd-tag">指名</span>';

      el.seats.appendChild(s);
      seatEls.push({ root: s, n: s.querySelector('.fd-n'), box: s.querySelector('.fd-dice'),
                     cups: s.querySelector('.fd-cups'), tag: s.querySelector('.fd-tag'),
                     nx: s.querySelector('.fd-nx'), mt: s.querySelector('.me-tag') });
    }
  }

  function paintTable() {
    var st = S.st;
    if (seatEls.length !== st.seats.length) buildSeats(st.seats.length);

    var size = st.seats.length >= 10 ? '5.1vw' : '6vw';
    el.round.textContent = '第 ' + st.round + ' 轮';
    var nxWho = (st.shaker + 1) % st.seats.length;
    if (st.phase === 'pass') {
      el.who.textContent = st.you === st.seats[nxWho].id ? '该你接手了' : nameOf(nxWho) + ' 准备';
    } else {
      el.who.textContent = st.shaker === st.you ? '轮到你摇' : nameOf(st.shaker) + '摇';
    }
    el.codeTag.textContent = S.code;

    for (var i = 0; i < st.seats.length; i++) {
      var s = st.seats[i], se = seatEls[i];
      var hit = false;
      for (var k = 0; k < st.hits.length; k++) if (st.hits[k].i === i) hit = true;

      /* 快换人的时候把下一位圈出来：桌上最需要知道的就是「接下来是谁」，
         光写在提示行里，隔着半张桌子看不见（2026-11-10 用户提的） */
      var isNext = st.phase === 'pass' && i === nxWho;
      se.root.classList.toggle('now', i === st.shaker);
      se.root.classList.toggle('next', isNext);
      /* 中途进来、这一把已经赶不上的人：标「下把」。
         不标的话他桌上摆着两颗空格子，别人点了名他也没反应 ——
         一看就知道「他还没入圈」，不用谁再解释一遍。 */
      se.root.classList.toggle('out', outOf(s));
      /* 「准备」优先：站在下一位的人就算这一把没赶上，也随时能接手入圈 */
      se.tag.textContent = s.online === false ? '掉线'
        : isNext ? '准备' : (s.sitOut ? '下把' : '指名');
      se.root.classList.toggle('hit', hit);
      se.root.classList.toggle('sel', st.picked === i);
      se.root.classList.toggle('me', s.id === st.you);
      se.root.classList.toggle('off', s.online === false);
      se.root.classList.toggle('todo', st.phase === 'ready' && !settled(s) && !outOf(s));
      /* 名字前面那颗「我」牌：常驻节点只切 hidden，别每次重画都重建 */
      se.mt.hidden = s.id !== st.you;
      se.nx.textContent = s.name;
      se.cups.textContent = s.cups ? s.cups + ' 杯' : '';
      se.cups.classList.toggle('has', s.cups > 0);
      paintDice(se.box, s.dice, size, true);
    }

    el.coreDice.innerHTML = dieHtml(st.center ? st.center[0] : 0, '9.8667vw') +
                            dieHtml(st.center ? st.center[1] : 0, '9.8667vw');
    el.core.classList.toggle('idle', !st.center);
    el.coreTag.textContent = st.center ? (dsum(st.center) + ' 点') : '公骰';

    paintHint();
    paintBtns();
  }

  function whyOf(h) {
    var s = S.st.seats[h.i];
    var why = h.why === 'exact' ? '一模一样 · 双倍'
            : h.why === 'lion' ? '豹子' : dsum(s.dice) + ' 点';
    if (h.i === S.st.shaker) why += ' · 自己';
    return why;
  }

  function pickNote() {
    var st = S.st;
    if (st.picked === -2) return '11 正豹 · 这一杯没指人';
    if (st.picked >= 0) return '11 正豹 · 另指 ' + nameOf(st.picked) + ' 1 杯';
    return '';
  }

  function paintHint() {
    var st = S.st;
    var line = '', sub = '';
    var is11 = st.center && st.center[0] === 1 && st.center[1] === 1;

    if (st.phase === 'ready') {
      var left = unrolled();
      var me = mySeat();
      line = '轮到 <b>' + nameOf(st.shaker) + '</b> · 摇公骰';
      if (left) sub = '还有 ' + left + ' 家没摇';
      else if (me && (me.used | 0) < st.shakes) sub = '你还能摇 ' + (st.shakes - (me.used | 0)) + ' 次（点自己的座位 · 长按改名）';
      else sub = '公骰一摇就锁 · 这一把不能再改点数';
      /* 庄家自己掉线：整桌会停在「等他摇」上。说清楚现在该谁顶上 ——
         服务端认这条规矩（findCanActFor），别让人对着一颗按不动的按钮猜。 */
      if (shakerOff() && !iAmShaker()) {
        line = '<b>' + nameOf(st.shaker) + '</b> 掉线了 · 公骰还没摇';
        sub = canStandIn() ? '点下面的「替他摇公骰」，这一把接着打'
                           : '等房主来替他摇';
      }
    } else if (st.phase === 'pick') {
      line = '<b>11 正豹</b> · ' + (iAmShaker() ? '点一位，罚 1 杯' : '等 ' + nameOf(st.shaker) + ' 点名');
      if (st.hits.length) sub = '对上的 ' + st.hits.length + ' 人已记杯';
    } else if (st.phase === 'hit') {
      var names = [], detail = [];
      for (var i = 0; i < st.hits.length; i++) {
        names.push(nameOf(st.hits[i].i));
        detail.push(nameOf(st.hits[i].i) + ' ' + whyOf(st.hits[i]));
      }
      var brief = names.length > 3
        ? names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人' : names.join('、');
      line = '<b>' + (is11 ? '11 正豹' : dsum(st.center) + ' 点') + '</b> → ' +
             '<span class="gold">' + brief + '</span> 喝';
      sub = detail.join(' ｜ ');
      var pn = is11 ? pickNote() : '';
      if (pn) sub = sub ? sub + ' · ' + pn : pn;
    } else {
      var ni = (st.shaker + 1) % st.seats.length;
      line = '<b>' + (is11 ? '11 正豹' : dsum(st.center) + ' 点') + '</b> → ' +
             '没人对上 · 轮到 <b>' + nameOf(ni) + '</b>';
      if (st.you === st.seats[ni].id) sub = '轮到你接手了 · 点下面的「我来接手」';
      else if (iAmShaker()) sub = '点「' + nameOf(ni) + ' 接手」把桌子交出去';
      else sub = '等 ' + nameOf(st.shaker) + ' 交给 ' + nameOf(ni);
      var pn2 = is11 ? pickNote() : '';
      if (pn2) sub = pn2 + (sub ? ' · ' + sub : '');
    }

    /* 我这一把没赶上（对局进行中才进来的）：别催我摇、别催我点，
       直接说清楚什么时候轮到我 —— 屏幕上摆一堆按不动的按钮最难受。 */
    var mine = mySeat();
    if (mine && mine.sitOut) {
      line = '你在旁边看着 · 这一把不算你';
      sub = '下一位接手后你就入圈 · 那两颗骰子到那时才摇';
    }

    /* 临时提示（「再点一次就退出」这类）挂在明细行尾巴上：
       牌桌页只有这一行能写字，单开一个 toast 又得压住座位 */
    if (S.flash) sub = sub ? sub + ' · ' + S.flash : S.flash;
    el.hint.innerHTML = line + (sub ? '<span class="fd-sub">' + sub + '</span>' : '');
  }

  /* 牌桌上的一次性提示：两秒后自己消失，期间来了新状态也还在 */
  function flash(msg) {
    S.flash = msg;
    if (S.st) paintHint();
    clearTimeout(S.flashTimer);
    S.flashTimer = setTimeout(function () {
      S.flash = '';
      if (S.st) paintHint();
    }, 2200);
  }

  /* ================= 本局记录 / 桌上的人 =================

     找朋友这边以前一条记录都不显示 —— 服务端 findLog 一直在记，
     前端一次都没画过。于是「公骰撞到谁」「这杯为什么算两杯」全靠当场看见，
     低头回个消息就全错过了。现在页脚有「记录」，摊开来慢慢翻。

     踢人同理：动作白名单里原本没有，12 人的局里有人走了、有人乱点，
     房主只有「重开一桌」这一把大锤。现在「桌上的人」里能点他出去。 */
  var sheetTab = 'log';

  function secLeft(until) {
    if (!until) return 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  function renderLog() {
    var box = el.logList;
    if (!box) return;
    var list = (S.st && S.st.log) || [];
    box.textContent = '';
    if (!list.length) {
      var em = document.createElement('div');
      em.className = 'lg-empty';
      em.textContent = '还没有记录 · 打一手就有了';
      box.appendChild(em);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var row = document.createElement('div');
      row.className = 'lg-row';
      row.setAttribute('data-k', it.k || '');
      var dot = document.createElement('i');
      dot.className = 'lg-dot';
      row.appendChild(dot);
      var tx = document.createElement('span');
      /* textContent：名字是别人起的，不能当 HTML 拼 */
      tx.textContent = it.text || '';
      row.appendChild(tx);
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  }

  function paintPeople() {
    var box = el.whoList;
    if (!box || !S.st) return;
    var st = S.st;
    box.textContent = '';
    for (var i = 0; i < st.seats.length; i++) {
      var s = st.seats[i];
      var mine = s.id === st.you;
      var off = s.online === false;
      var k = st.kick && st.kick.target === s.id ? st.kick : null;

      var row = document.createElement('div');
      row.className = 'who-row' + (mine ? ' me' : '') + (off ? ' is-off' : '');

      var nm = document.createElement('span');
      nm.className = 'who-n';
      /* 自己那一行：名字前面挂同一颗「我」牌（以前是名字后面跟一句「（我）」） */
      if (mine) {
        var mt = document.createElement('i');
        mt.className = 'me-tag';
        mt.textContent = '我';
        nm.appendChild(mt);
      }
      nm.appendChild(document.createTextNode(s.name));
      row.appendChild(nm);

      var cu = document.createElement('span');
      cu.className = 'who-c';
      cu.textContent = (s.cups | 0) + ' 杯 · ' + (off ? '离线' : '在线');
      row.appendChild(cu);

      /* 自己那一行不给按钮：踢自己请点左上角的返回 */
      if (!mine) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'who-x' + (k ? ' is-on' : '');
        b.setAttribute('data-pid', s.id);
        if (k) {
          b.textContent = '同意 ' + k.yes.length + '/' + k.need +
            (secLeft(S.kickUntil) ? ' · ' + secLeft(S.kickUntil) + 's' : '');
        } else {
          /* 房主点了直接走，别人点了只是发起投票 —— 按钮上就写明，免得按下去没反应 */
          b.textContent = isHost() ? '请出去' : '发起投票';
        }
        row.appendChild(b);
      }
      box.appendChild(row);
    }

    var tip = document.createElement('div');
    tip.className = 'who-tip';
    tip.textContent = isHost()
      ? '你是房主：点「请出去」当场生效，不用别人同意。'
      : '点「发起投票」：在线的三分之二同意才请得出去，45 秒没人接着点就作废。';
    box.appendChild(tip);
  }

  function setTab(tab) {
    sheetTab = tab === 'who' ? 'who' : 'log';
    if (el.tabLog) el.tabLog.classList.toggle('is-on', sheetTab === 'log');
    if (el.tabWho) el.tabWho.classList.toggle('is-on', sheetTab === 'who');
    if (el.logList) el.logList.hidden = sheetTab !== 'log';
    if (el.whoList) el.whoList.hidden = sheetTab !== 'who';
    if (sheetTab === 'log') renderLog();
    else paintPeople();
  }

  function openSheet(tab) {
    if (!el.logMask) return;
    el.logMask.hidden = false;
    setTab(tab || 'log');
  }

  function closeSheet() {
    if (el.logMask) el.logMask.hidden = true;
  }

  /* 票数上的秒数得自己走：服务端只在状态变化时推一次 left，
     没人动的话那条 45 秒的倒计时会僵在那儿。 */
  function startTick() {
    if (S.tickTimer) return;
    S.tickTimer = setInterval(function () {
      var live = S.st && (S.st.vote || S.st.kick);
      if (!live) { stopTick(); return; }
      paintBtns();
      paintVoteCard();
      if (sheetTab === 'who' && el.whoList && !el.whoList.hidden) paintPeople();
    }, 1000);
  }

  function stopTick() {
    if (S.tickTimer) { clearInterval(S.tickTimer); S.tickTimer = 0; }
  }

  /* ================= 踢人投票浮卡 =================

     以前只在「桌上的人」弹层里才看得见有人在投票（那行按钮变成「同意 1/2」）。
     不打开它，别人发起投票你根本不知道，45 秒作废了才发觉。
     左边空白处浮一张小卡：谁要被请走、几票、还剩几秒。

     卡片只是通知，pointer-events:none（见 app.css 的 .vcard）——
     它绝不能挡桌面上任何一个能点的地方。投票入口还是「桌上的人」那一层。

     重画挂在 startTick 的 1 秒心跳上（本来就在跑投票倒计时），
     不另起一个 interval：两个定时器迟早会有一处忘记清。 */
  function voteCardOff() {
    S.vcSpan = 0;
    S.vcKey = '';
    if (el.vc) el.vc.hidden = true;
  }

  function paintVoteCard() {
    if (!el.vc || el.vc.hidden) return;
    var k = S.st && S.st.kick;
    var left = S.kickUntil ? S.kickUntil - Date.now() : 0;
    if (!k || left <= 0) { voteCardOff(); return; }
    if (!S.vcSpan) S.vcSpan = left;
    var mine = false;
    for (var i = 0; i < k.yes.length; i++) if (k.yes[i] === S.st.you) mine = true;
    el.vcS.textContent = (mine ? '你已同意 · ' : '')
      + k.yes.length + '/' + k.need + ' 人同意 · ' + secLeft(S.kickUntil) + ' 秒';
    el.vcBar.style.width =
      Math.max(0, Math.min(100, (left / S.vcSpan) * 100)) + '%';
    /* 「同意」那颗：房主点谁谁直接走（服务端对房主是立刻生效），
       被投的那个人也投不了票 —— 这两种不给按钮；投过了留原位变灰。 */
    if (el.vcOk) {
      var hide = isHost() || k.target === S.st.you;
      el.vcOk.hidden = hide;
      if (!hide) {
        el.vcOk.disabled = mine;
        el.vcOk.textContent = mine ? '已同意' : '同意';
      }
    }
  }

  function syncVoteCard() {
    var k = S.st && S.st.kick;
    var left = S.kickUntil ? S.kickUntil - Date.now() : 0;
    if (!k || left <= 0) { voteCardOff(); return; }
    if (!el.vc) return;
    var key = k.target + '|' + k.by;
    var fresh = key !== S.vcKey;
    S.vcKey = key;
    if (fresh) S.vcSpan = Math.max(1000, left);
    var idx = idxIn(S.st, k.target);
    el.vcWho.textContent = idx >= 0 ? nameOf(idx) : '—';
    if (fresh) {
      el.vc.hidden = false;
      buzz(12);
    }
    paintVoteCard();
  }

  function btn(act, text, cls, dis) {
    return '<button class="' + cls + '" type="button" data-act="' + act + '"' +
      (dis ? ' disabled' : '') + '>' + text + '</button>';
  }

  function paintBtns() {
    var st = S.st, me = mySeat(), h = '';

    if (st.phase === 'ready') {
      var left = unrolled();
      if (me && (me.used | 0) < st.shakes) {
        h += btn('fshake', me.used ? '再摇一次' : '摇我的 2 颗', 'btn primary');
      }
      if (iAmShaker()) {
        if (left) h += btn('froll', '等 ' + left + ' 家摇完', 'btn is-off', true);
        else h += btn('froll', '摇公骰', me && !me.used ? 'btn is-off' : 'btn primary');
      } else if (shakerOff() && canStandIn()) {
        /* 庄家掉线，房主顶上（服务端 findCanActFor 认这条）；
           还有人没摇就先按不动，说清楚在等谁 */
        h += btn('froll', left ? '等 ' + left + ' 家摇完' : '替他摇公骰',
                 left ? 'btn is-off' : 'btn primary', !!left);
      } else if (!h) {
        h += '<div class="fn-wait">等 ' + nameOf(st.shaker) + ' 摇公骰</div>';
      }
    } else if (st.phase === 'pick') {
      if (iAmShaker()) h += btn('fskip', '这杯算了', 'btn ghost');
      else h += '<div class="fn-wait">等 ' + nameOf(st.shaker) + ' 点名</div>';
    } else if (st.phase === 'hit') {
      if (iAmShaker()) h += btn('froll', '继续摇', 'btn primary');
      else h += '<div class="fn-wait">' + nameOf(st.shaker) + ' 接着摇</div>';
    } else {
      /* 没人对上了：庄家点一下交给下一位，**下一位自己也能点**
         （2026-11-10 用户反馈：原来非等庄家不可，他一走神整桌就卡住） */
      var nx = (st.shaker + 1) % st.seats.length;
      if (iAmShaker()) h += btn('fnext', nameOf(nx) + ' 接手', 'btn primary');
      else if (myIdx() === nx) h += btn('fnext', '我来接手', 'btn primary');
      else h += '<div class="fn-wait">等 ' + nameOf(nx) + ' 接手</div>';
    }

    /* 重开一桌：跟 350 一样改成投票（在线的三分之二，45 秒不投就散）。
       以前只有房主能按，按下去就把一桌人的杯子全清了 —— 手滑一下很难看。
       已经投过的人再点一下就是撤回，比「再点一次确认」清楚。 */
    var v = st.vote;
    var myVote = !!(v && v.yes && v.yes.indexOf(st.you) >= 0);
    var vt = '重开一桌';
    if (v) {
      vt = '重开 ' + v.yes.length + '/' + v.need + (myVote ? ' · 撤回' : '');
      var sv = secLeft(S.voteUntil);
      if (sv) vt += ' · ' + sv + 's';
    }
    h += btn('freset', vt, v ? 'fn-mini on' : 'fn-mini');
    el.btns.innerHTML = h;
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    /* 第一次碰屏幕哑播一下解锁音频：iOS / 微信要求第一次 play() 落在手势里，
       否则后面「服务端推来的摇骰」会被静默拦掉 */
    var unlocked = false;
    var once = function () {
      if (unlocked) return;
      unlocked = true;
      unlockShk();
    };
    document.addEventListener('touchstart', once, true);
    document.addEventListener('mousedown', once, true);

    /* 卡片上那颗「同意」：发的消息跟「桌上的人」里点同一行一模一样
       （服务端同一个人再点一次就是补一票）。pointerdown 要拦住冒泡 ——
       页面在 document 上按坐标判调试五格，卡片正好压在那条带子上。 */
    if (el.vcOk) {
      el.vcOk.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      el.vcOk.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        var k = S.st && S.st.kick;
        if (!k || !S.kickUntil || S.kickUntil <= Date.now()) return;
        for (var i = 0; i < k.yes.length; i++) if (k.yes[i] === S.st.you) return;
        send({ t: 'kick', pid: k.target });
      });
    }

    el.back.addEventListener('click', function () {
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
    });

    /* 牌桌的「←」：这一桌已经开局，没有「回大厅」这回事，
       退出去就等于放弃座位 —— 所以要两下确认，别让口袋里蹭一下就没了 */
    if (el.back2) el.back2.addEventListener('click', function () {
      if (new Date().getTime() - (S.exitAt || 0) > 2500) {
        S.exitAt = new Date().getTime();
        flash('再点一次 ← 就暂时离开（座位留着，回来能续上）');
        return;
      }
      S.exitAt = 0;
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
    });

    el.newBtn.addEventListener('click', createRoom);
    el.joinBtn.addEventListener('click', joinRoom);

    /* 「上一桌还没打完」：点一下就回原位（服务器凭 token 认人） */
    if (el.resume) el.resume.addEventListener('click', function () {
      var last = lastRoom();
      if (!last) { el.resume.hidden = true; clearLast(); return; }
      enterRoom(last.code);
    });

    /* 玩法说明：规则页只有一份（f350.js 的 RULES），这里只要把联机版那个 key 递过去。
       联机这一屏以前连入口都没有，等于新来的人只能看着房号框猜怎么玩。 */
    if (el.rule) el.rule.addEventListener('click', function () {
      if (window.F350 && window.F350.rules) window.F350.rules('findnet');
    });

    /* 页脚两个入口：记录 / 桌上的人，同一个弹层两页 */
    if (el.logBtn) el.logBtn.addEventListener('click', function () { openSheet('log'); });
    if (el.whoBtn) el.whoBtn.addEventListener('click', function () { openSheet('who'); });
    if (el.tabLog) el.tabLog.addEventListener('click', function () { setTab('log'); });
    if (el.tabWho) el.tabWho.addEventListener('click', function () { setTab('who'); });
    if (el.logX) el.logX.addEventListener('click', closeSheet);
    if (el.logMask) el.logMask.addEventListener('click', function (e) {
      if (e.target === el.logMask) closeSheet();      // 点背板 = 收起
    });

    /* 桌上的人：点那一行右边的按钮 = 请出去（房主）或发起投票（其他人）。
       已经投过同一个人就变成撤回 —— 按错了不用求人帮忙撤销。 */
    if (el.whoList) el.whoList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-pid]') : null;
      if (!b || !S.st) return;
      var pid = b.getAttribute('data-pid');
      var k = S.st.kick;
      if (k && k.target === pid && k.yes && k.yes.indexOf(S.st.you) >= 0) {
        send({ t: 'unvotekick' });
      } else {
        send({ t: 'kick', pid: pid });
      }
    });

    el.code.addEventListener('input', function () {
      el.code.value = el.code.value.replace(/\D/g, '').slice(0, 6);
    });

    el.lobbyStart.addEventListener('click', function () {
      if (!S.st || S.st.seats.length < MIN_P) return;
      send({ t: 'start' });
    });

    el.lobbyQuit.addEventListener('click', function () {
      leaveAll();
    });

    el.copyBtn.addEventListener('click', function () {
      var txt = '房号 ' + S.code + ' · 找朋友 ' + MIN_P + '~' + MAX_P + ' 人';
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
      } catch (e) {}
      tip('房号已复制：' + S.code);
    });

    /* 改名字（2026-11-13 用户：「点自己的座位或者头像就可以直接更改名字」）。
     这一页点自己的座位是「摇我的 2 颗」，是主要动作，所以改名借**长按** ——
     两件事挤在同一个点上没别的办法，牌桌那一屏再塞一颗按钮就没地方了。 */
  function openRename() {
    var st = S.st;
    if (!st || !window.LDRename) return;
    if (window.LDRename.isOpen()) return;
    var me = mySeat();
    var cur = (me && me.name) || myName();
    window.LDRename.open({
      name: cur,
      check: function (nm) {
        var k = function (v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); };
        var list = st.seats || [];
        for (var i = 0; i < list.length; i++) {
          if (!list[i] || list[i].id === st.you) continue;
          if (k(list[i].name) === k(nm)) return '「' + nm + '」已经有人用了，换一个';
        }
        return '';
      },
      ok: function (nm) { if (nm !== cur) send({ t: 'rename', name: nm }); }
    });
  }

  /* 座位点击：准备阶段 = 摇自己的（房主可代摇）；点人阶段 = 庄家点名 */
    /* 长按自己的座位 = 改名字。按住 550ms 才认，手指一动就作废
       （圆环上本来就容易滑）；抬起来浏览器补的那一下 click 必须吃掉，
       不然改完名字顺手把骰子也摇了。 */
    var lpTimer = 0, lpSx = 0, lpSy = 0, lpFired = 0;
    function lpStop() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } }
    el.seats.addEventListener('pointerdown', function (e) {
      var s = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s || !S.st) return;
      var seat = S.st.seats[Number(s.getAttribute('data-i'))];
      if (!seat || seat.id !== S.st.you) return;
      lpSx = e.clientX; lpSy = e.clientY;
      lpStop();
      lpTimer = setTimeout(function () {
        lpTimer = 0;
        lpFired = Date.now();
        buzz(14);
        openRename();
      }, 550);
    });
    el.seats.addEventListener('pointermove', function (e) {
      if (!lpTimer) return;
      if (Math.abs(e.clientX - lpSx) > 12 || Math.abs(e.clientY - lpSy) > 12) lpStop();
    });
    el.seats.addEventListener('pointerup', lpStop);
    el.seats.addEventListener('pointercancel', lpStop);

    el.seats.addEventListener('click', function (e) {
      /* 刚长按过：这一次 click 是手指抬起来带的，别再摇一次骰 */
      if (lpFired && Date.now() - lpFired < 900) { lpFired = 0; return; }
      var s = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s || !S.st) return;
      var i = Number(s.getAttribute('data-i'));
      var seat = S.st.seats[i];
      if (!seat) return;

      if (S.st.phase === 'pick') {
        if (!iAmShaker()) { tip('只有摇公骰的人能点'); return; }
        send({ t: 'fpick', i: i });
        return;
      }
      if (S.st.phase !== 'ready') { tip('公骰已经开摇了，这一把不能再改点数'); return; }
      /* 中途进来的：这一把还没算他，先说清楚，别让他以为是手机坏了 */
      if (seat.sitOut) { tip('这一把还没算你 · 下一位接手后就能摇'); return; }
      if (seat.id === S.st.you) { send({ t: 'fshake' }); return; }
      if (isHost()) { send({ t: 'fshake', pid: seat.id }); return; }
      tip('只能摇自己的 · 房主可以替人摇');
    });

    el.btns.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      if (act === 'fshake') send({ t: 'fshake' });
      else if (act === 'froll') send({ t: 'froll' });
      else if (act === 'fskip') send({ t: 'fskip' });
      else if (act === 'fnext') send({ t: 'fnext' });
      else if (act === 'freset') {
        /* 已经投过就撤回，没投过就投一票。
           不再要「再点一次确认」——投票本身就是那个确认。 */
        var vv = S.st && S.st.vote;
        if (vv && vv.yes && vv.yes.indexOf(S.st.you) >= 0) send({ t: 'unvote' });
        else send({ t: 'restart' });
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !S.alive) return;
      if (!S.ws) connect();
    });

    /* 暗门：标题长按 1.2s 开面板；牌桌那条隐形五格；面板里的六行 */
    bindTitle();
    /* 挂在 document 上而不是那五格上：它按坐标认位置，手指落偏一点也算。
       总闸关着（或面板开着）时 onHotTap 第一句就 return，不抢任何点击。 */
    document.addEventListener('click', onHotTap);
    if (el.dbg) {
      el.dbg.addEventListener('click', function (e) {
        var row = e.target.closest ? e.target.closest('.dbg-row[data-k]') : null;
        if (row) { setDbg(row.getAttribute('data-k'), !dbg[row.getAttribute('data-k')]); return; }
        /* 点背板 = 收起（面板本身不是一扇门，不用二次确认） */
        if (e.target === el.dbg || (e.target.closest && e.target.closest('#dbgClose'))) closeDbg();
      });
    }
  }

  /* ---------------- 入口 ---------------- */

  function enter() {
    S.api = apiBase();
    /* 开房页那句「以谁的身份进房」：名字在「联机」首页起，这里只回显 */
    if (el.whoName) el.whoName.textContent = myName();
    paintResume();
    var room = (location.search.match(/[?&]room=(\d{4}|\d{6})/) || [])[1];
    if (room) {
      try {
        if (history.replaceState) history.replaceState(null, '', location.pathname + (location.hash || ''));
      } catch (e) {}
      enterRoom(room);
      return;
    }
    /* 上一轮退到别的页面时把连接挂起了，回来接着用同一个房号重连：
       服务端凭 token 认人，座位还在，不用重新输房号 */
    if (S.code && !S.ws) {
      S.alive = true;
      connect();
    }
    render();
  }

  /* 「上一桌还没打完」那张卡：本地只记房号，房间是死是活现场问一句 ——
     大家散场之后房间会被回收，摆一个点进去是空桌的入口，比不摆更让人恼火。
     问不到 / 房间没了就把记录一起删掉，下次不再惦记。 */
  function paintResume() {
    var box = el.resume;
    if (!box) return;
    var last = lastRoom();
    if (!last) { box.hidden = true; return; }
    box.hidden = true;                    // 先收着，确认房间还在再露出来，免得闪一下
    if (el.resumeCode) el.resumeCode.textContent = last.code;
    if (!S.api) return;
    fetch(S.api + '/api/has?code=' + last.code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.room) { clearLast(); box.hidden = true; return; }
        /* 那个房号其实是 350 的房间：这张卡对找朋友没用，收掉 */
        if (j.room.game && j.room.game !== 'find') { clearLast(); return; }
        var n = j.room.n | 0;
        if (el.resumeSub) {
          if (j.room.phase === 'over') el.resumeSub.textContent = '上一把打完了 · 回去再来一桌';
          else if (j.room.started) el.resumeSub.textContent = '局还在打 · 点一下回原位';
          else el.resumeSub.textContent = n > 1 ? n + ' 人在等开局' : '房间还在 · 点一下进去';
        }
        box.hidden = false;
      })
      .catch(function () { box.hidden = true; });
  }

  function leave() {    /* 离开这一页就把 socket 关掉：挂在别的页面上占着一条长连接，
       手机装兜里切两次应用电就没了。房号和状态留着，回来自动重连。
       真正退出这一桌走「返回」按钮（那里才 leaveAll，连座位一起丢）。 */
    if (!S.code) return;
    S.alive = false;
    clearTimeout(S.retryTimer);
    closeSocket();
    showOff(false);
  }

  function boot() {
    el = {
      back: $('fnBack'), back2: $('fnBack2'),
      gate: $('fnGate'), lobby: $('fnLobby'), table: $('fnTable'),
      code: $('fnCode'), joinBtn: $('fnJoin'), newBtn: $('fnNew'), tip: $('fnTip'),
      resume: $('fnResume'), resumeSub: $('fnResumeSub'), resumeCode: $('fnResumeCode'),
      rule: $('fnRule'),
      lobbyCode: $('fnLobbyCode'), lobbyList: $('fnLobbyList'), lobbyTip: $('fnLobbyTip'),
      lobbyStart: $('fnStart'), lobbyQuit: $('fnQuit'), copyBtn: $('fnCopy'),
      round: $('fnRound'), who: $('fnWho'), codeTag: $('fnCodeTag'),
      seats: $('fnSeats'), core: $('fnCore'), coreDice: $('fnCoreDice'),
      coreTag: $('fnCoreTag'), hint: $('fnHint'), btns: $('fnBtns'), off: $('fnOff'),
      whoName: $('fnWhoName'),
      /* 本局记录 / 桌上的人：页脚两个入口，一个弹层两页 */
      logMask: $('fnLog'), logList: $('fnLogList'), whoList: $('fnWhoList'),
      logBtn: $('fnLogBtn'), whoBtn: $('fnWhoBtn'), logX: $('fnLogX'),
      tabLog: $('fnTabLog'), tabWho: $('fnTabWho'),
      /* 暗门：长按标题开面板，牌桌中段那三格是「快捷键」 */
      title: $('fnTitle'), hot: $('fnHot'), dbg: $('fnDbg'),
      vc: $('fnVote'), vcWho: $('fnVoteWho'), vcS: $('fnVoteS'), vcBar: $('fnVoteBar'),
      vcOk: $('fnVoteOk')
    };
    if (!el.gate) return;          // 页面上没有这一页（被裁剪过 / 旧版缓存）
    loadDbg();
    bind();
    S.api = apiBase();

    var me = myName();
    var nm = $('fnName');
    if (nm) nm.value = me;

    var room = (location.search.match(/[?&]room=(\d{4}|\d{6})/) || [])[1];
    if (room) {
      var rc = $('fnCode');
      if (rc) rc.value = room;
      enterRoom(room);
    }
    render();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.LDFindNet = {
    enter: enter,
    leave: leave,
    quit: quitRoom,
    /* 给自动化测试：读当前状态 / 直接发一条协议 */
    state: function () { return S.st; },
    send: function (o) { return send(o); },
    code: function () { return S.code; }
  };
})();

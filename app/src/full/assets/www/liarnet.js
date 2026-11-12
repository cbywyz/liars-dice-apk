/* 吹牛 · 联机版客户端（每人一台手机，暗骰）。

   2026-11-11 用户连着几条，把这个玩法一路砍到只剩一件事：

     「线上只负责给骰子。」

   于是整条线只剩三个动作，后两个都是「够 2/3 就往下走」：

     摇 5 颗（摇完就锁，一人只摇一次，不用再点一次「开始」）
       → 面对面张嘴叫，线上一个字都不记
       → 谁想开谁点「开牌」（2/3 点了就摊，全桌的点数一次亮出来）
       → 对完牌点「下一把」（2/3 点了才洗）

   所以在这一页里找不到的东西（都是**故意**没有的，别再加回来）：
   起叫门槛、谁先叫、轮到谁、转向、点人、抢开翻倍、认半杯、劈、对赌倒计时，
   **以及整个叫点面板** —— 线上不叫点，叫点发生在桌上。

   跟找朋友那份（findnet.js）是同一个骨架：三屏（拿房号 / 大厅 / 牌桌）、
   同一条 WebSocket、同样「点数只从服务器来」。差别只在看什么：
   自己的 5 颗盖在盅里（点开盖看），别人的座位上是盖着的 5 颗，盖到摊牌那一刻。

   本地不做任何判定：按钮写什么、点了会发生什么，全看服务端下发的 state。
   这里只把 state 翻译成人话。 */

(function () {
  'use strict';

  var DEFAULT_API = 'https://dice.2582580.xyz';
  var HOME_HOST = 'dice.2582580.xyz';
  var NAME_KEY = 'ld_net_name';        // 跟 350 / 找朋友共用一个昵称
  var SEAT_KEY = 'ld_lr_seat_';
  var LAST_KEY = 'ld_liar_last';

  /* 人数跟服务端 LIAR_MIN / LIAR_MAX 一个口径（2~12） */
  var MIN_P = 2;
  var MAX_P = 12;
  /* 一家 5 颗（服务端 LIAR_DICE）。座位上的骰子、摊牌表都按这个数画 */
  var DICE_N = 5;

  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var CELL = [20, 50, 80];
  var RED_FACE = { 1: true, 4: true };

  var S = {
    api: DEFAULT_API, code: '', ws: null, you: null, token: null,
    st: null, alive: false, retry: 0, retryTimer: 0, pingTimer: 0,
    /* 自己那只盅的盖子：0 = 盖着，1 = 掀到底。lidRound 记着「上一把是哪一局」，
       换局的时候自动合上 —— 新的一把，牌还是空的。 */
    lidP: 0, lidRound: 0
  };

  var el = {};
  var seatEls = [];
  var sheetTab = 'log';        // 记录 / 桌上的人，弹层当前那一页

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

  function myName() {
    if (window.LDName) return window.LDName.get();
    try {
      var n = (localStorage.getItem(NAME_KEY) || '').trim();
      if (n) return n;
      n = '玩家' + (1 + Math.floor(Math.random() * 90));
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

  function cue(name) {
    try { if (window.LDSnd) window.LDSnd.cue(name); } catch (e) {}
  }

  /* ---------------- 摇骰那一下的声音 ----------------
     全站只有一颗 shake.mp3（单机吹牛 / 350 / 联机 350 / 找朋友共用）。
     这里原来写的是 cue('shake') —— 可 snd.js 里根本没有 shake 这一档，
     它那几个（换人 / 豹子 / 爆点 / 开盖 / 喝）都是现场合成的短音。
     于是在联机吹牛里按「摇」只有震动、没有声音，2026-11-11 用户报了上来。
     真音频跟 findnet.js 一样，各玩法自己拿一个 <audio> 放。

     解锁：iOS / 微信的通道必须在手势里打开一次。这里等第一次按到屏幕，
     静音播一下立刻停 —— 那一下听不见，但通道开了，之后点「摇」就响。 */
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

  function unlockShake() {
    var a = ensureShk();
    if (!a) return;
    try {
      a.muted = true;
      var p = a.play();
      var quiet = function () {
        try { a.pause(); a.currentTime = 0; } catch (e) {}
        a.muted = false;
      };
      if (p && p.then) p.then(quiet).catch(function () { a.muted = false; });
      else quiet();
    } catch (e) { if (shk) shk.muted = false; }
  }

  function flash(msg) {
    if (el.hint) el.hint.textContent = msg || '';
  }

  function tip(msg) {
    if (!el.tip) return;
    if (el.table && !el.table.hidden && S.st) { flash(msg || ''); return; }
    el.tip.textContent = msg || '';
    el.tip.classList.toggle('show', !!msg);
  }

  function nameOf(i) {
    var st = S.st;
    if (i === null || i === undefined || i < 0) return '—';
    var s = st && st.seats && st.seats[i];
    return s ? s.name : (i + 1) + ' 号';
  }

  function myIdx() {
    var st = S.st;
    if (!st || !st.you) return -1;
    for (var i = 0; i < st.seats.length; i++) if (st.seats[i].id === st.you) return i;
    return -1;
  }

  function isHost() {
    return !!(S.st && S.st.host && S.st.host === S.st.you);
  }

  /* 摇了几家。分母只算在线的人 —— 谁手机掉线了不该卡住整桌。
     都摇完（done === all）牌就锁了，服务端直接进「面对面叫」。 */
  function rollNow() {
    var st = S.st;
    if (st && st.roll) return st.roll;
    return { done: 0, all: st ? st.seats.length : 0 };
  }

  /* 开牌那张票。没到「锁牌之后」这一步，服务端不下发（null），这里给个空壳兜住 */
  function openNow() {
    var st = S.st;
    if (st && st.open) return st.open;
    return { done: 0, need: 0, mine: false };
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
    if (m.t === 'you') {
      S.you = m.pid;
      S.token = m.token;
      if (m.code) S.code = m.code;
      saveSeat();
      saveLast();
      /* 服务端只把「开着调试功能」记在这个玩家身上，重连是新的一轮，得再报一次 */
      tellDbg();
      return;
    }
    /* 自己点「退出」：服务端已经把座位摘掉了，这儿收尾 */
    if (m.t === 'quitok') { finishQuit(); return; }
    if (m.t === 'kicked') {
      var msg = m.msg || '你被请出了这一桌';
      try { localStorage.removeItem(SEAT_KEY + S.code); } catch (e) {}
      clearLast();
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('liarnet');
      tip(msg);
      return;
    }
    if (m.t === 'err') {
      /* 服务端说不行，就是不行：原话摆出来，不在本地猜一套更「合理」的说法 */
      tip(m.msg || '这一步不行');
      return;
    }
    if (m.t === 'state') {
      var prev = S.st;
      if (m.s && m.s.game && m.s.game !== 'liar') {
        tip('这个房号不是吹牛的房间');
        return;
      }
      S.st = m.s;
      render();
      react(prev);
      return;
    }
  }

  /* 该响的响一下、该震的震一下。放在 render 之后，界面上该变的已经变完了 */
  function react(prev) {
    var st = S.st;
    if (!st) return;
    /* 摊牌：低头看手机的人抬头看桌上的牌 */
    if (prev && st.phase === 'reveal' && prev.phase !== 'reveal') {
      cue('drink');
      buzz([22, 70, 22]);
    }
    /* 都摇完了、牌锁住了：现在是真的该张嘴了 */
    if (prev && st.phase === 'call' && prev.phase !== 'call') {
      cue('pass');
      buzz([16, 60, 16]);
    }
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
    closeKick();
    closeSheet();
    showOff(false);
    render();
  }

  /* ---------------- 主动退出这一桌 ----------------

     跟「← 暂时离开」是两件事：这里要真把座位让出来。服务端收到 {t:'quit'}
     会走摘人流程（座位重排、票数重数），回一句 quitok；本地还得把房号和
     座位 token 一起清掉，不然回首页又弹出「上一桌还没打完」，等于没退。 */
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
    /* 回包万一丢了，也不能把人一直卡在牌桌上 */
    S.quitTimer = setTimeout(finishQuit, 900);
  }

  function createRoom() {
    if (!S.api) return;
    tip('正在开一桌…');
    fetch(S.api + '/api/new?game=liar', { cache: 'no-store' })
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
        if (j.room.game && j.room.game !== 'liar') { tip('这个房号不是吹牛的房间'); return; }
        tip('');
        enterRoom(code);
      })
      .catch(function () { tip('连不上服务器 · 检查一下网络'); });
  }

  /* ---------------- 画 ---------------- */

  function showOff(on) {
    if (el.off) el.off.hidden = !on;
  }

  /* ---------------- 本局记录 / 桌上的人 ----------------

     350 和找朋友一直有这两个入口，吹牛的服务端也一直下发 log，只是前端没画。
     跟找朋友用同一套 .lg-* 类名，一个弹层两页。人员页顺便把「在线 / 离线」
     写成字 —— 圆环上的座位卡只有一颗小点，想逐个确认谁还在，还是得能读。 */
  function renderLog() {
    var box = el.logList;
    if (!box) return;
    var list = (S.st && S.st.log) || [];
    box.textContent = '';
    if (!list.length) {
      var em = document.createElement('div');
      em.className = 'lg-empty';
      em.textContent = '还没有记录 · 摇一把就有了';
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
      tx.textContent = it.text || '';        // 名字是别人起的，不能当 HTML 拼
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
      var row = document.createElement('div');
      row.className = 'who-row' + (mine ? ' me' : '') + (off ? ' is-off' : '');

      var nm = document.createElement('span');
      nm.className = 'who-n';
      nm.textContent = s.name + (mine ? '（我）' : '') +
                       (s.id === st.host ? ' · 房主' : '');
      row.appendChild(nm);

      var cu = document.createElement('span');
      cu.className = 'who-c';
      var what = st.phase === 'reveal' ? '已摊牌' : (s.rolled ? '摇了' : '没摇');
      cu.textContent = what + ' · ' + (off ? '离线' : '在线');
      row.appendChild(cu);

      /* 自己那一行不给按钮：想退出请点右上角「退出」。
         跟 350 / 找朋友一样，在线的人非房主也能点 —— 按钮上直接写清是「发起投票」，
         不然按下去只是挂一张票，人会以为没反应。 */
      if (!mine && canKick(i)) {
        var k = kickVote(s);
        var voted = votedByMe(k);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'who-x' + (k ? ' is-on' : '');
        /* 房主和掉线的人永远直接请，不显示票数 —— 他们点下去本来就绕过投票 */
        b.textContent = (s.online === false || isHost())
          ? '请出去'
          : k ? (voted ? '已投 ' : '同意 ') + k.yes.length + '/' + k.need
              : '发起投票';
        b.setAttribute('data-i', String(i));
        row.appendChild(b);
      }
      box.appendChild(row);
    }

    /* 跟找朋友那张一模一样的一句：说明按钮点下去到底会发生什么 */
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
    if (sheetTab === 'log') renderLog(); else paintPeople();
  }

  function openSheet(tab) {
    if (!el.logMask) return;
    el.logMask.hidden = false;
    setTab(tab || 'log');
  }

  function closeSheet() {
    if (el.logMask) el.logMask.hidden = true;
  }

  function render() {
    var st = S.st;
    var screen = !S.code ? 'gate' : (!st || !st.started ? 'lobby' : 'table');
    if (el.gate) el.gate.hidden = screen !== 'gate';
    if (el.lobby) el.lobby.hidden = screen !== 'lobby';
    if (el.table) el.table.hidden = screen !== 'table';
    if (screen !== 'table') closeKick();

    if (screen === 'lobby') paintLobby();
    if (screen === 'table') paintTable();
    paintDbg();
  }

  function paintLobby() {
    var st = S.st;
    if (!st) return;
    if (el.lobbyCode) el.lobbyCode.textContent = S.code;
    var n = st.seats.length;
    if (el.lobbyTip) {
      el.lobbyTip.textContent = (n < MIN_P
        ? '还差 ' + (MIN_P - n) + ' 个人 · 把房号念给旁边的人'
        : n + ' 人 · 房主可以开局了（' + MIN_P + '~' + MAX_P + ' 人）');
    }
    var h = '';
    for (var i = 0; i < n; i++) {
      var s = st.seats[i];
      var mine = s.id === st.you;
      h += '<div class="lr-pl' + (mine ? ' me' : '') + (s.online === false ? ' off' : '') + '">' +
        '<span class="lr-pl-n">' + (i + 1) + '</span>' +
        '<span class="lr-pl-name">' + esc(s.name) + '</span>' +
        (s.id === st.host ? '<span class="lr-pl-host">房主</span>' : '') +
        (mine ? '<span class="lr-pl-go">我</span>' : '') +
        '</div>';
    }
    if (el.lobbyList) el.lobbyList.innerHTML = h;
    if (el.lobbyStart) {
      /* 只有房主能开局；人不够时按钮灰着，并写清「还差几个」——
         一个一直能点但永远失败的按钮，是最让人上头的东西 */
      el.lobbyStart.disabled = !isHost() || n < MIN_P;
      el.lobbyStart.textContent = isHost()
        ? (n < MIN_P ? '还差 ' + (MIN_P - n) + ' 人' : '开局 · ' + n + ' 人')
        : '等房主开局';
    }
    paintResume();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* 一颗骰子的点数：三段式九宫（CELL）里点亮几个位置。1 和 4 是红的。
     摊牌那张大表要一次性拼一大段 HTML，所以抽成字符串版本，别再 createElement 五遍。 */
  function pipHtml(v) {
    var cells = PIPS[v] || [];
    var red = !!RED_FACE[v];
    var s = '';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      s += '<i class="pip' + (red ? ' red' : '') + (cells.length === 1 ? ' big' : '') +
        '" style="left:' + CELL[c % 3] + '%;top:' + CELL[Math.floor(c / 3)] + '%"></i>';
    }
    return s;
  }

  function dieEl(v, down, anim, none) {
    var d = document.createElement('div');
    d.className = 'die lr-die in' + (down ? ' down' : '') + (none ? ' none' : '');
    if (down) return d;
    d.innerHTML = pipHtml(v);
    if (anim) d.style.animationDelay = (Math.random() * 60).toFixed(0) + 'ms';
    return d;
  }

  /* 一排骰子。key 一样就不重画 —— 每次广播都重建的话，.die 的入场动画会
     一遍一遍重播，整桌的骰子跟着闪。
     faint = 他还没摇（连盖子都还没有）。骰子本身不动、只压淡一点：
     空着一排会让人以为「他没骰子」，画成实心的又跟「已摇」分不清。 */
  /* 盅里 5 颗的摆法 —— 跟单机版 app.js 的 slotsOf() 用同一套数：
     3 + 2 两层、110rpx 一颗、每颗歪一点。盅口那个椭圆是 80vw × 41.33vw，
     一排 5 颗根本放不下（两头会露在盅外面），单机版这么摆才是对的。
     单机的坐标系是 rpx（750 = 整屏宽），这里换成 vw：乘 100/750。 */
  var CUP_LAYOUT = { cols: 3, size: 110, gx: 20, gy: 14 };
  var CUP_TILT = [-9, 6, -4, 8, -7, 5, -6, 9, -3, 7];
  var CUP_CX = 300, CUP_CY = 158;      /* 盅口椭圆的圆心，rpx */

  function cupSlots(n) {
    var cfg = CUP_LAYOUT;
    var rows = Math.ceil(n / cfg.cols);
    var totalH = rows * cfg.size + (rows - 1) * cfg.gy;
    var y0 = CUP_CY - totalH / 2;
    var out = [];
    for (var r = 0; r < rows; r++) {
      var cnt = Math.min(cfg.cols, n - r * cfg.cols);
      var totalW = cnt * cfg.size + (cnt - 1) * cfg.gx;
      var x0 = CUP_CX - totalW / 2;
      for (var c = 0; c < cnt; c++) {
        out.push({
          l: x0 + c * (cfg.size + cfg.gx),
          t: y0 + r * (cfg.size + cfg.gy),
          r: CUP_TILT[(r * cfg.cols + c) % CUP_TILT.length],
          s: cfg.size
        });
      }
    }
    return out;
  }

  function rpxVw(n) { return (n * 100 / 750).toFixed(3) + 'vw'; }

  function paintDice(box, values, down, key, anim, faint, cup) {
    if (!box) return;
    if (box.getAttribute('data-k') === key) return;
    box.setAttribute('data-k', key);
    box.innerHTML = '';
    /* 服务端每家的颗数固定是 5（LIAR_DICE）；盖着的也照 5 颗摆，
       位置跟摊开时一模一样，摊牌那一刻只有点数变，卡片不会跳。 */
    var slots = cup ? cupSlots(5) : null;
    for (var i = 0; i < 5; i++) {
      var d = values ? dieEl(values[i], false, anim) : dieEl(0, true);
      d.setAttribute('data-i', String(i));
      if (faint) d.className += ' faint';
      if (!slots) { box.appendChild(d); continue; }
      /* 盅里那颗：套一层定位槽，位置/大小/角度照单机版写死 */
      var sl = document.createElement('div');
      sl.className = 'lr-dslot';
      sl.style.left = rpxVw(slots[i].l);
      sl.style.top = rpxVw(slots[i].t);
      sl.style.setProperty('--ds', rpxVw(slots[i].s));
      /* .lr-die 自己写着 --ds: 3vw（座位卡上那排小骰子），会盖掉槽上这个值 ——
         不一起改，盅里就变成 5 颗 11px 的小白点。 */
      d.style.setProperty('--ds', rpxVw(slots[i].s));
      sl.style.transform = 'rotate(' + slots[i].r + 'deg) scaleY(0.84)';
      sl.appendChild(d);
      box.appendChild(sl);
    }
  }

  function buildSeats(n) {
    if (!el.seats) return;
    el.seats.innerHTML = '';
    seatEls = [];
    /* 9 个人以上换一套密度：卡片窄一圈、骰子小一号。
       12 个人挤在 92vw 的圆环上，周长只够 18.7vw 一格，不缩就撞。 */
    el.seats.className = n >= 9 ? 'lr-seats dense' : 'lr-seats';
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'lr-seat';
      s.setAttribute('data-i', String(i));

      /* 1 号左上起、顺时针 —— 跟找朋友同一个摆法，人一眼就知道自己在哪。

         两个人例外：按圆环均分正好落在 12 点和 6 点，顶上那张卡有一半在圆环外面，
         矮屏（640 / 667 那一档）就会压住「第 N 局 · 面对面叫」那一行。
         两个人本来就是面对面坐着，摆到左右两侧更对，也不撞标题。 */
      var step = 360 / n;
      var th = n === 2 ? 180 + i * 180 : 270 - step + i * step;
      var rad = th * Math.PI / 180;
      var R = 0.78;
      s.style.left = (50 + 50 * R * Math.cos(rad)).toFixed(2) + '%';
      s.style.top = (50 + 50 * R * Math.sin(rad)).toFixed(2) + '%';

      s.innerHTML =
        '<span class="lr-n"></span>' +
        '<span class="lr-dice" data-k=""></span>' +
        '<span class="lr-say"></span>';

      el.seats.appendChild(s);
      seatEls.push({
        root: s,
        n: s.querySelector('.lr-n'),
        box: s.querySelector('.lr-dice'),
        say: s.querySelector('.lr-say')
      });
    }
  }

  function paintTable() {
    var st = S.st;
    if (!st) return;
    if (seatEls.length !== st.seats.length) buildSeats(st.seats.length);
    if (el.codeTag) el.codeTag.textContent = S.code;
    if (el.round) el.round.textContent = '第 ' + st.round + ' 局';

    /* 顶上那一行只说一句「现在到哪儿了」。桌上最常问的就是这句话，
       写在中间那张桌子上太挤（那块要摆「摇了几家 / 开牌几张票」）。 */
    var rd = rollNow();
    var op = openNow();
    if (el.who) {
      if (st.phase === 'roll') el.who.textContent = '各自摇 · ' + rd.done + '/' + rd.all + ' 家摇完';
      else if (st.phase === 'call') el.who.textContent = '面对面叫 · 开牌 ' + op.done + '/' + op.need;
      else if (st.phase === 'reveal') el.who.textContent = '摊牌 · 自己数';
      else el.who.textContent = '—';
    }

    var opened = st.phase === 'reveal';

    for (var i = 0; i < st.seats.length; i++) {
      var s = st.seats[i], se = seatEls[i];
      if (!se) continue;

      /* 名字后面挂一个状态小尾巴。摇完就锁，所以只有两种状态：
         摇了的压淡一档（他已经没事了），没摇的标出来（眼睛要找的正是他）。 */
      var mark = '';
      if (st.phase === 'roll') {
        mark = s.rolled ? '<i class="lr-rd w">摇了</i>' : '<i class="lr-rd n">没摇</i>';
      }
      var nm = esc(s.name) + (s.id === st.you ? '（我）' : '') + mark;
      if (se.n.innerHTML !== nm) se.n.innerHTML = nm;

      /* 骰子：**只有摊牌那一刻**座位上才报点数。
         自己那 5 颗盖在下面的盅里（点开盖看），不摆在座位上 ——
         座位上一直明着摆自己的牌，那只盅就白盖了。 */
      if (opened && s.dice) paintDice(se.box, s.dice, false, 'v' + s.dice.join('-') + st.round, opened);
      else if (s.rolled) paintDice(se.box, null, true, 'd' + (s.n || 5), false);
      else paintDice(se.box, null, true, 'e' + (s.n || 5), false, true);

      /* 座位卡最下面那行以前一直空着（叫点拆掉之后没话可说了），正好放连顺：
         上一把摊开时全桌都看见谁连着几把顺子，这一把还没摇就能对上。
         从 2 连起才显示 —— 1 把谈不上「连续」；到 3 连变成红字「罚」，
         这就是桌上那条「连续 3 次顺子罚、间断不算」的提醒。
         2026-11-12 用户：「顺子 4 连 · 罚酒 改为 顺子 4 连 · 罚」—— 两个字够了，罚什么桌上自己说。 */
      var sk = s.streak | 0;
      if (sk >= 2) {
        se.say.textContent = '顺子 ' + sk + ' 连' + (sk >= 3 ? ' · 罚' : '');
        se.say.className = 'lr-say st' + (sk >= 3 ? ' hot' : '');
      } else {
        se.say.textContent = '';
        se.say.className = 'lr-say';
      }

      var cls = 'lr-seat';
      if (s.online === false) cls += ' off';
      /* 自己那张卡描一圈淡金：一桌十几个人时，先认出「我在哪儿」 */
      if (s.id === st.you) cls += ' me';
      /* 装填别人之后：被挑中那张卡的**在线绿点改成深金**（用户 2026-11-12 二轮：
         「直接在原来那个绿色圆点那里标记即可」—— 第一版另点一颗小金点，
         位置会跳、又扎眼，已经被否掉）。
         dbg.hit 是**只回给塞牌那个人**的，所以这颗变色全桌只有他看得见；
         被挑中的人自己摇出这一手时服务端把回执收掉，颜色当场复原。 */
      var hit = st.dbg && st.dbg.hit;
      if (hit && hit.pid && hit.pid === s.id) cls += ' arm';
      if (se.root.className !== cls) se.root.className = cls;
    }

    /* 摊牌就把圆桌和盅收起来，换那张大表（.lr-table.rev 在 CSS 里切） */
    if (el.table) el.table.classList.toggle('rev', opened);
    paintReveal();

    paintCore();
    paintMe();
    paintBtns();
    paintKickTip();
    /* 弹层开着就跟着刷：别人摇了、掉线了，手上那份不该停在打开那一刻 */
    if (el.logMask && !el.logMask.hidden) setTab(sheetTab);
  }

  /* ---------------- 那一行小字：点名字可以请人出去 ----------------

     踢人这个动作藏在座位名字上，光看屏幕是发现不了的 —— 之前还画过虚线下划线，
     结果一圈名字都被画了线，看着更像排版出错，索性整条去掉了。
     用户 2026-11-11：「刚刚说的可以踢人的功能还没加上」—— 功能在，但他没找到。

     所以改成在底栏上方留一句常驻小字，只有「现在真的点得动」的时候才出现。
     什么时候点得动，跟 canKick 一条线：除了自己，谁都能点开 ——
     掉线的人直接请走，在线的人是发起投票（房主则是直接请）。

     摊牌那一屏也算：那一屏整块换成了大表，座位卡根本不在屏幕上，
     以前这里把 reveal 排除掉，结果「有人走了卡在摊牌页」时一个能点的名字都没有
     （用户 2026-11-11 的截图：1/2 停在那儿，退不出也进不去）。 */
  function paintKickTip() {
    if (!el.hint) return;
    var st = S.st;
    var msg = '';
    if (st && st.started && st.seats && st.seats.length > 1) {
      for (var i = 0; i < st.seats.length; i++) {
        if (canKick(i)) {
          msg = st.phase === 'reveal'
            ? '点牌桌上那个名字 · 可以请人出去'
            : (isHost() ? '点座位上那个名字 · 可以请人出去'
                        : '点座位上那个名字 · 可以投票请人出去');
          break;
        }
      }
    }
    /* 只在空着的时候写，是不够的：摇 → 叫 → 摊是同一张页面，那句「点座位上那个名字」
       会一直留在底栏，到了摊牌那一屏还是那句 —— 座位卡早收起来了，人照着去找什么也找不到。
       所以整句比对，措辞变了就换掉。 */
    if (msg) { if (el.hint.textContent !== msg) el.hint.textContent = msg; }
    else if (el.hint.textContent.indexOf('请人出去') >= 0) el.hint.textContent = '';
  }

  /* ---------------- 摊牌大表 ----------------

     用户 2026-11-11：「开牌之后我们只做展示，把玩家的点数放大展示出来，
     太小人家可能看不见」。所以这时候座位卡上那 2.2vw 的小方块不算数了，
     整屏换成一列大行：一行一家，5 颗 10vw 的骰子，谁的牌一眼扫完。
     这里只画、不判 —— 够不够数写在最上面，喝多少桌上自己说。 */
  /* 顺子：5 颗点数互不重复。1 是万能牌，正好顶掉中间断掉的那一截：
     12345 / 23456 是连顺，13456 / 12456 / 12356 / 12346 只断了一截，
     照样算顺子。用户 2026-11-11 明确：「只要没重复点数就是顺子，13456 也是顺子」。

     界面上不再分两种叫法：用户 2026-11-11 又说「标记顺子只标记顺子就好，
     万能顺也叫顺子」—— 所以摊牌页和状态条一律只写「顺子」两个字。

     只做标注，不做判定：App 本来就不判牌，这里也不改任何数。
     单独拿出来是因为摊牌那一眼，一桌人看的是「谁手里有牌」，
     五个点挨个认太慢；贴上两个字，眼睛直接跳过他。

     为什么只标顺子不标豹子：豹子（5 颗一样）在吹牛里没人会计错，
     数一眼就知道；顺子相反 —— 五颗全不一样，看着最像「什么都没有」，
     偏偏是最强的一手，不点出来桌上一定会漏。 */
  function isStraight(dice) {
    if (!dice || dice.length !== 5) return false;
    var seen = {}, i;
    for (i = 0; i < 5; i++) {
      if (dice[i] < 1 || dice[i] > 6 || seen[dice[i]]) return false;
      seen[dice[i]] = 1;
    }
    return true;
  }

  function paintReveal() {
    var st = S.st;
    if (!el.rev || !el.revList) return;
    var open = st && st.phase === 'reveal';
    el.rev.hidden = !open;
    if (!open) return;

    /* 线上一个字都不判。这里只报一个数：全桌一共几颗骰子。
       够不够数、谁喝，抬眼看桌上那副牌 —— 人自己数。

       原来下面还有一行「1×4 2×2 3×3 …」，2026-11-12 按用户要求整行拿掉：
       那一行没剔除顺子（顺子不计点数），也没法表达豹子（算 6 个 / 带 1 算 10 个），
       数着就是个错数 —— 用户原话：「直接不显示，让别人自己看下方即可」。
       每家的牌就在下面摊着，还标了「顺子」，人自己扫一眼比看错数快。 */
    if (el.revV) {
      el.revV.innerHTML = (st.total || 0) + ' <b>颗</b>';
    }
    el.rev.className = 'lr-rev' + (st.seats.length >= 9 ? ' dense' : '');

    var h = '';
    for (var i = 0; i < st.seats.length; i++) {
      var s = st.seats[i];
      /* 名字右边、骰子左边那块空白，正好放一句「顺子」—— 那里本来就是空的，
         不用挤别人的位置，眼睛从名字扫到骰子一定会经过它。 */
      var tag = '';
      if (isStraight(s.dice)) {
        /* 一个词就够：连顺、带 1 断一截，都是顺子。 */
        tag = '<span class="lr-rv-t">顺子</span>';
      }
      /* 掉线的人名字后面说一句：这一屏座位卡收起来了，没有别的办法看出谁不在了，
         而「谁不在了」恰恰是这一屏最常要处理的事（人走了，票凑不够，得请他出去）。 */
      var off = s.online === false ? '<i class="lr-rv-off">掉线</i>' : '';
      /* 连顺：名字下面一行，跟「掉线」同一列 —— 不占骰子那一行的宽度。
         3 连起红字「罚」，桌上这条规矩就写在牌面上，不用谁记。 */
      var sk = s.streak | 0;
      var stk = sk >= 2
        ? '<i class="lr-rv-st' + (sk >= 3 ? ' hot' : '') + '">顺子 ' + sk + ' 连' +
          (sk >= 3 ? ' · 罚' : '') + '</i>'
        : '';
      /* 自己那一行跟着描金：这一屏一列五六行，光靠「（我）」两个字找不到自己。 */
      h += '<div class="lr-rv' + (s.id === st.you ? ' me' : '') + '" data-i="' + i + '">' +
        '<div class="lr-rv-m">' +
          '<span class="lr-rv-n">' + esc(s.name) + (s.id === st.you ? '（我）' : '') + '</span>' +
          off + stk +
        '</div>' + tag +
        '<div class="lr-rv-d" data-k="' + (s.dice ? s.dice.join('-') : '') + '">';
      for (var j = 0; j < DICE_N; j++) {
        var v = s.dice && s.dice[j] ? s.dice[j] : 0;
        h += '<div class="die lr-die in">' + pipHtml(v) + '</div>';
      }
      h += '</div></div>';
    }
    if (el.revList.getAttribute('data-h') !== h) {
      el.revList.setAttribute('data-h', h);
      el.revList.innerHTML = h;
    }
  }

  /* 中间那张桌子：三种局面共用一块圆盘，只换里面的字。
     摇的阶段摆「摇了几家、开始了几家」，叫点阶段摆「现在叫到几」，
     摊牌摆实际个数。没有倒计时了 —— 这一局什么时候结束由桌上说了算。 */
  /* 中间那张圆盘：三种局面共用一块，只换里面的字。
     摇 = 几家人摇完了；叫 = 开牌票几张；摊 = 全桌几颗。
     没有倒计时 —— 这一局什么时候往下走，由桌上说了算。 */
  function paintCore() {
    var st = S.st;
    if (!st || !el.coreK) return;

    var rd = rollNow(), op = openNow();

    if (st.phase === 'roll') {
      el.coreK.textContent = '各自摇';
      el.coreV.className = 'lr-core-v';
      el.coreV.textContent = '暗骰';
      el.coreS.textContent = rd.done + '/' + rd.all + ' 家摇完 · 都摇完就锁牌';
      return;
    }

    if (st.phase === 'call') {
      el.coreK.textContent = '开牌';
      el.coreV.className = 'lr-core-v';
      el.coreV.textContent = op.done + '/' + op.need;
      el.coreS.textContent = '面对面叫 · 够 2/3 就摊';
      return;
    }

    if (st.phase === 'reveal') {
      el.coreK.textContent = '摊牌';
      el.coreV.className = 'lr-core-v';
      el.coreV.textContent = (st.total || 0) + ' 颗';
      el.coreS.textContent = '1~6 各几个 · 自己数';
      return;
    }

    /* 不认识这个 phase：只可能是升级前开的旧桌（见下面 paintBtns 同一处）。
       别把「吹牛 / 暗骰」摆在这，那看着像还没开局。 */
    if (st.started) {
      el.coreK.textContent = '旧桌';
      el.coreV.className = 'lr-core-v';
      el.coreV.textContent = '重开';
      el.coreS.textContent = '升级前开的这一桌 · 退出去再建';
      return;
    }

    el.coreK.textContent = '吹牛';
    el.coreV.className = 'lr-core-v';
    el.coreV.textContent = '暗骰';
    el.coreS.textContent = '';
  }

  /* ---------------- 骰盅的盖子 ----------------

     曲线照单机版（app.js 的 lidStyle）搬：抬升用 0.72p + 0.28p²，前段慢、后段快，
     抬过 94% 才开始淡出 —— 早了会出现「盖子还在半空就透明了」那种穿帮。
     单位是 rig 坐标系里的 vw（整只盅按 80vw 画的），屏上那个 40vw 是外层 scale(0.5) 缩出来的。
     45.3333vw 就是单机版那 340rpx。 */
  var LID_LIFT = 45.3333;

  function lidApply(p, dragging) {
    if (!el.lid) return;
    p = Math.max(0, Math.min(1, p));
    S.lidP = p;
    var lift = LID_LIFT * (0.72 * p + 0.28 * p * p);
    var fade = p <= 0.94 ? 1 : Math.max(0, 1 - (p - 0.94) / 0.06);
    el.lid.style.transform = 'translate3d(0,-' + lift.toFixed(2) + 'vw,0)';
    el.lid.style.opacity = fade.toFixed(3);
    el.lid.style.transition = dragging ? 'none'
      : 'transform 0.36s cubic-bezier(0.26, 0.9, 0.24, 1), opacity 0.2s ease';
    /* 掀开 / 合上会改变「此刻能不能改点」—— 纯净版把调试段剪了，
       这里用 typeof 兜一下，点盅不会 ReferenceError。 */
    if (typeof syncTapEdit === 'function') syncTapEdit();
  }

  /* 摇一把的时候整只盅跟着晃 —— 动画在 app.css 的 .cup-rig.shaking 里，
     单机版摇骰就是这一下，直接借过来。 */
  function shakeCup() {
    if (!el.cupRig) return;
    el.cupRig.classList.remove('shaking');
    void el.cupRig.offsetWidth;
    el.cupRig.classList.add('shaking');
    setTimeout(function () {
      if (el.cupRig) el.cupRig.classList.remove('shaking');
    }, 1700);
  }

  /* 点一下开盖、再点一下合上；也可以按着往上拖，拖到哪儿掀到哪儿。
     摊牌之后盖子由程序掀着，不再接受手势 —— 那时候牌本来就全亮了。 */
  function bindCup() {
    if (!el.cup) return;
    var y0 = 0, dragging = false, moved = false;

    function down(e) {
      if (S.st && S.st.phase === 'reveal') return;
      /* 只有「盖子已经掀开、这一把锁了牌、调试功能真的开着」时，落在骰子上的
         手指才是改这一颗；其余任何时候（尤其摇骰阶段、盖子还盖着）都是点盅，
         照常掀盖。以前只判开关，开关持久化后退出重进，点盅正中间整下没反应。
         下面 setPointerCapture 一抓，pointerup 也归盅，click 派给盅 —— 骰子
         那颗永远收不到，所以真要改点时必须在这里让开。 */
      if (tapEditLive() && e.target && e.target.closest &&
          e.target.closest('[data-i]')) return;
      dragging = true;
      moved = false;
      y0 = e.clientY;
      try { el.cup.setPointerCapture(e.pointerId); } catch (err) {}
    }

    function move(e) {
      if (!dragging) return;
      var dy = y0 - e.clientY;
      if (!moved && Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      var h = el.cup.getBoundingClientRect().height || 1;
      lidApply(dy / (h * 0.62), true);
    }

    function up() {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        /* 只是点了一下：开 / 关整个翻过去，不用拖 */
        var to = S.lidP > 0.5 ? 0 : 1;
        lidApply(to, false);
        if (to) cue('pass');
      } else {
        lidApply(S.lidP > 0.45 ? 1 : 0, false);
      }
    }

    el.cup.addEventListener('pointerdown', down);
    el.cup.addEventListener('pointermove', move);
    el.cup.addEventListener('pointerup', up);
    el.cup.addEventListener('pointercancel', up);
  }

  function paintMe() {
    var st = S.st;
    var me = myIdx();
    if (!el.meDice) return;
    if (me < 0) return;
    var s = st.seats[me];

    if (s.dice) paintDice(el.meDice, s.dice, false, 'me' + s.dice.join('-') + st.round, true, false, true);
    else paintDice(el.meDice, null, true, 'me-' + (s.rolled ? 'r' : 'e'), false, false, true);
    if (el.meName) el.meName.textContent = s.name;
    if (el.meTag) {
      var rd = rollNow();
      var t = '';
      /* 「还没摇」只在还能摇的时候说。牌锁了之后（call）再说这句，人就该去找摇骰
         按钮了 —— 而那个按钮根本不会出现，只会让他以为这一桌坏了。 */
      if (st.phase === 'roll') t = s.rolled
        ? '摇了 · 等别人（' + rd.done + '/' + rd.all + '）'
        : '还没摇 · 点下面摇骰';
      else if (st.phase === 'call') t = '牌锁了 · 桌上叫，想开就点「开牌」';
      else if (st.phase === 'reveal') t = '摊牌 · 对完牌点「下一把」';
      el.meTag.textContent = t;
    }
    /* 自己连了几把顺子：圆环上那张自己的座位卡离得远，这一块才是「我的牌」，
       所以同一个数在自己的位置上也写一遍。2 连起才出现，3 连转红 ——
       跟座位卡、摊牌页同一套口径（用户 2026-11-11 反馈自己那份看不到）。 */
    if (el.meSt) {
      var msk = s.streak | 0;
      if (msk >= 2) {
        el.meSt.hidden = false;
        el.meSt.textContent = '顺子 ' + msk + ' 连' + (msk >= 3 ? ' · 罚' : '');
        el.meSt.className = 'lr-me-st' + (msk >= 3 ? ' hot' : '');
      } else {
        el.meSt.hidden = true;
        el.meSt.textContent = '';
        el.meSt.className = 'lr-me-st';
      }
    }
    if (el.me) el.me.className = 'lr-me' + (s.rolled ? '' : ' lr-me-wait');

    /* 换局自动合盖：新的一把，盅里不该还敞着上一把的牌 */
    if (st.round !== S.lidRound) {
      S.lidRound = st.round;
      lidApply(0, false);
    }
  }

  /* ---------------- 按钮 ----------------

     整页就三个动作：摇 / 开牌 / 下一把（踢人藏在座位名字上）。
     按钮上永远写着「现在这一步的后果」，不写「玩法的第几步」。 */

  function btn(act, text, cls) {
    return '<button class="btn ' + (cls || '') + '" data-act="' + act + '">' + text + '</button>';
  }

  function paintBtns() {
    var st = S.st;
    if (!el.btns) return;
    var me = myIdx();
    var meS = me >= 0 ? st.seats[me] : null;
    var rd = rollNow(), op = openNow();
    var h = '';

    if (st.phase === 'roll') {
      if (!meS) {
        h = '<div class="lr-wait">看牌 · ' + rd.done + '/' + rd.all + ' 家已经摇了</div>';
      } else if (!meS.rolled) {
        h = '<button class="lr-roll" data-act="roll">摇一摇</button>';
      } else {
        h = '<div class="lr-wait">你摇完了 · 等别人 ' + rd.done + '/' + rd.all + '</div>';
      }
    } else if (st.phase === 'call') {
      /* 牌锁住了，线上一个字都不记。谁想开谁点，够 2/3 就摊 */
      if (op.mine) {
        h = '<div class="lr-wait">你点了开牌 · 等其他人（' + op.done + '/' + op.need + '）</div>';
      } else {
        h = btn('open', '开牌 · ' + op.done + '/' + op.need, 'primary');
      }
      /* 票数是 2/3 在线人数，但座位 ≥ 2 时最少 2 票。所以两个人里有一个掉线，
         剩下的人点满了也摊不开 —— 得说清楚为什么，不然就是「我点了它不动」。 */
      var off = 0;
      for (var k = 0; k < st.seats.length; k++) if (st.seats[k].online === false) off++;
      h += '<div class="lr-wait">' + (off
        ? '有 ' + off + ' 家掉线了 · 那一票也算 · 点他名字请出去'
        : '线上不叫点 · 桌上说 · 够 ' + op.need + ' 人点就摊') + '</div>';
    } else if (st.phase === 'reveal') {
      /* 摊完不自动洗：有人要对着牌算账。够 2/3 的人点了才开下一局 */
      var nv = st.next || { need: 1, yes: [] };
      var voted = me >= 0 && (nv.yes || []).indexOf(me) >= 0;
      h = voted
        ? '<div class="lr-wait">你已经点了 · 等其他人（' + nv.yes.length + '/' + nv.need + '）</div>'
        : btn('next', '下一把 · ' + nv.yes.length + '/' + nv.need, 'primary');
      h += '<div class="lr-wait">摊着牌慢慢对 · 够 ' + nv.need + ' 人才洗</div>';
    } else if (st.started) {
      /* 旧版本开的一桌：服务端还留着上一套协议的局面（ready / bid / …），
         上面三个分支一个都进不去，底栏就空着 —— 用户 2026-11-11 就是这么
         被卡住的，原话「摇一摇丢了？那怎么摇，这样好像无法开始」。
         空着最坏：没有摇、没有开牌，也没有任何一句话解释。 */
      h = '<div class="lr-wait">这一桌是旧版本开的 · 点右上角离开，重新开一桌</div>';
    }

    if (el.btns.innerHTML !== h) el.btns.innerHTML = h;
  }

  /* ---------------- 请人出去 ----------------

     用户 2026-11-11：「有些人离开了，还一直占位卡死，建议点桌子上那个名字」。

     能请谁跟服务端 kickPlayerLiar 一条线，不在本地另立一套：
       · 已经掉线的，谁点都能请出去（人都不在了，不用等房主）
       · 还在线的，房主直接请；其他人点一下是**发起投票**，
         在线的三分之二同意才请得出去（2026-11-11 用户要求跟 350 / 找朋友一致）

     点座位 → 弹一句确认 → 发一条 kick；自己已经投过的那张再点一次是撤回。 */
  var KICK_AT = -1;

  /* 除了自己，谁都能点开 —— 能不能真的请走，由服务端 kickPlayerLiar 判。
     以前这里写着「在线的人只有房主能点」，普通玩家打开「桌上的人」一个按钮都没有，
     用户 2026-11-11 直接报了这条。 */
  function canKick(i) {
    var st = S.st;
    if (!st || !st.started) return false;
    var me = myIdx();
    if (me < 0 || i === me) return false;
    return !!(st.seats && st.seats[i]);
  }

  /* 这张票现在挂在哪、我投过没有 */
  function kickVote(s) {
    var st = S.st;
    if (!st || !st.kick || !s || st.kick.target !== s.id) return null;
    return st.kick;
  }

  function votedByMe(k) {
    var st = S.st;
    return !!(k && k.yes && st && k.yes.indexOf(st.you) >= 0);
  }

  function openKick(i) {
    var st = S.st;
    if (!st || !canKick(i)) return;
    var s = st.seats[i];
    var k = kickVote(s);
    var mine = votedByMe(k);
    var host = st.host === st.you;
    KICK_AT = i;

    if (el.kickName) {
      el.kickName.textContent = s.name + (s.online === false ? ' · 掉线' : '');
    }
    if (el.kickSub) {
      if (s.online === false) {
        el.kickSub.textContent = '已经掉线了 · 请出去，座位就空出来';
      } else if (host) {
        el.kickSub.textContent = '你是房主：点一下直接请出去，不用别人同意';
      } else if (mine) {
        el.kickSub.textContent = '已经有 ' + k.yes.length + '/' + k.need +
          ' 人同意 · 点一下撤回你那一票';
      } else if (k) {
        el.kickSub.textContent = '已经有 ' + k.yes.length + '/' + k.need +
          ' 人同意 · 点一下算你同意（45 秒没人接着点就作废）';
      } else {
        el.kickSub.textContent = '发起投票：在线的三分之二同意才请得出去，45 秒没人接着点就作废';
      }
    }
    if (el.kickGo) {
      el.kickGo.textContent = (mine && !host && s.online !== false) ? '撤回我这一票'
        : (s.online === false || host) ? '请出去'
        : (k ? '同意请出去' : '发起投票');
    }
    if (el.kick) el.kick.hidden = false;
  }

  function closeKick() {
    KICK_AT = -1;
    if (el.kick) el.kick.hidden = true;
  }

  function doKick() {
    var st = S.st;
    var i = KICK_AT;
    var s = st && st.seats && i >= 0 ? st.seats[i] : null;
    var k = kickVote(s);
    var mine = votedByMe(k);
    var host = st && st.host === st.you;
    closeKick();
    if (!s) return;
    buzz(14);
    /* 自己投过、又不是房主（房主本来就不投票）：再点一次是撤回 */
    if (mine && !host && s.online !== false) { send({ t: 'unvotekick' }); return; }
    send({ t: 'kick', pid: s.id });
  }

  /* ================= 调试功能（暗门） =================

     跟单机吹牛、找朋友联机是**同一套规矩**，一条都不能少（用户 2026-11-11：
     「所有调试功能的激活方式必须统一由首页那个连点 7 次那里激活后才有效」）：
       · 总开关：首页页脚那行版本号连点 7 下（window.LDDev，全站只有这一个）
       · 长按牌桌顶上那两行字 1.2 秒 → 弹出「调试功能」面板
       · 面板里的东西跟单机一模一样：装填状态条 / 一键豹子 1~6 + 随机豹子（万能豹） /
         随机顺子（打散）+ 两条固定顺子 / 开盖后点骰改点 / 三格 / 音效
       用户 2026-11-11 第二轮：「怎么调试功能没把单机的整个拿过来」——
       所以这一版是把单机那张 .sheet 原样搬过来，只把「装填」改成走服务端。

     联机的点数是**服务端摇的**，所以装填和改点都得报上去，落在「我这个玩家」名下：
       · 装填（豹子 / 顺子 / 三格的上和下）：{t:'larm'} —— 下一次摇骰按它出点，只用一次
       · 改点（面板第一项、也是三格中间那格）：{t:'lset'} —— 自己第 i 颗 +1
     别人的骰子、别人的画面一个像素都不动；摊牌那一刻全桌才看见。
     服务端还多一道门：先报一条 {t:'ldbg', on:true}，不然这两个动作一律不认 ——
     防的是有人不装面板、手搓一条消息就把点数按上来。

     三格的位置是用户在截图里圈出来的（盅左边那条竖空当），不是单机那三格的横排：
     联机版盅下面就是「摇一摇」那颗大按钮，横着切一定会压在按钮上。

     2026-11-11 第二轮，三格从「按 clientY 算落在哪一格」改成**三块各自绑**：
     用户实测「1 有震动也有效，2 和 3 没震动」，说明那两下根本没进到 handler。
     现在每个 <i data-k> 自己接 pointerdown，落哪块就是哪块，不再算坐标。 */
  var DBG_KEY = 'ld_liar_dbg';
  /* 能排进三格的功能清单 —— **这个数组的顺序就是面板里的顺序**。
     用户 2026-11-11：「开关 1 2 3 可在面板中自定义，可给已有功能增加排序」：
     想调顺序、或者在中间插一项，只改这里；三格的默认值和面板都会跟着走。
     short 是给面板 chip 和「上/中/下」那一行用的，name 是完整叫法。 */
  var DBG_ACTS = [
    { id: 'st', short: '顺子', name: '随机顺子' },
    { id: 'lion', short: '豹子', name: '随机豹子' },
    { id: 'tap', short: '改点', name: '点骰改点' },
    { id: 'ost', short: '他顺', name: '他人随机顺子' },
    { id: 'olion', short: '他豹', name: '他人随机豹子' },
    { id: 'ogood', short: '他好', name: '他人随机好牌' }
  ];
  var DBG_Z_DEF = ['st', 'tap', 'lion'];
  var dbg = { tap: false, zone: false, z: DBG_Z_DEF.slice() };
  var TAP_GAP = 420;          // 点骰改点：两下之间的最大间隔
  var tapAt = 0, tapI = -1;
  var DBG_STRAIGHTS = [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]];

  function actOf(id) {
    for (var i = 0; i < DBG_ACTS.length; i++) if (DBG_ACTS[i].id === id) return DBG_ACTS[i];
    return null;
  }
  function actOfShort(id) {
    var a = actOf(id);
    return a ? a.short : '—';
  }

  function dbgArm() { return !!(window.LDDev && window.LDDev.on()); }

  /* 「此刻真的在改点」而不是「开关开着」—— 盅让位、骰子接手指、CSS 放开指针，
     三处必须共用这一个判断，别再各写一套条件。

     开关存在 localStorage 里，退出重进会自动带回来。以前只判「开关开着」：
     roll 阶段点盅正中间（正好是骰子那一层）掀盖手势被整句吞掉，而改点那边
     又要求盖子先掀开 —— 两边都不接，那一块成了死区。用户 2026-11-11 报的
     「摇了之后退出再进，盖子打不开」就是这么来的。 */
  function tapEditLive() {
    return !!(dbgArm() && dbg.tap && S.st && S.st.phase === 'call' && S.lidP >= 0.3);
  }

  function syncTapEdit() {
    document.body.classList.toggle('lr-tap-live', tapEditLive());
  }

  function loadDbg() {
    try {
      var o = JSON.parse(localStorage.getItem(DBG_KEY) || 'null');
      if (o) {
        dbg.tap = !!o.tap;
        dbg.zone = !!o.zone;
        /* 三格配置：老版本存的是「开关」没有 z，读不到就用默认值。
           只收认识的 id，坏值当没配过 —— 不然一格点下去什么也不做，还查不出来。 */
        if (Object.prototype.toString.call(o.z) === '[object Array]') {
          for (var i = 0; i < 3; i++) if (actOf(o.z[i])) dbg.z[i] = o.z[i];
        }
      }
    } catch (e) {}
  }

  function saveDbg() {
    try { localStorage.setItem(DBG_KEY, JSON.stringify(dbg)); } catch (e) {}
  }

  /* 告诉服务端「我这台开着调试功能」。断线重连后要再报一次 ——
     服务端只记在内存里的那个玩家身上，重连是新的一轮。

     2026-11-11 起只要总闸开着就报 on：面板里「随机顺子 / 装填别人」这些
     点一下就走，不必先把两个开关拨开 —— 以前只认 tap / zone，
     只点面板上那颗「随机顺子」会被服务端拒掉（"调试功能没开"）。 */
  function tellDbg() {
    if (!S.ws || S.ws.readyState !== 1) return;
    try {
      S.ws.send(JSON.stringify({ t: 'ldbg', on: dbgArm() }));
    } catch (e) {}
  }

  /* 固定档专用：升序排好的 12345 = 1、23456 = 2，其余 0。
     随机档不在这里判 —— 5 颗互不重复就算顺子（含带 1 的万能顺），见 isStraight()。 */
  function straightKey(v) {
    if (!v || v.length !== 5) return 0;
    var s = v.slice().sort(function (a, b) { return a - b; }).join(',');
    if (s === DBG_STRAIGHTS[0].join(',')) return 1;
    if (s === DBG_STRAIGHTS[1].join(',')) return 2;
    return 0;
  }

  /* 万能豹：只出现一个非 1 的点数、并且至少带一个 1。
     1 在吹牛里是万能牌（非斋局），所以「1 1 6 6 6」跟「6 6 6 6 6」
     是同一手满点的豹子，只是摊出来不扎眼。返回那个点数，不是则返回 0。 */
  function wildLion(v) {
    if (!v || v.length !== 5) return 0;
    var p = 0, ones = 0, i;
    for (i = 0; i < v.length; i++) {
      if (v[i] === 1) { ones++; continue; }
      if (v[i] < 2 || v[i] > 6) return 0;
      if (p && v[i] !== p) return 0;
      p = v[i];
    }
    return (p && ones) ? p : 0;
  }

  /* 一手牌叫什么：正豹 / 万能豹 = 豹子，5 颗互不重复 = 顺子，
     其余照念点数。只用在面板那条状态条上，不是判定。
     顺子不分连顺 / 断一截，一律写「顺子」（用户 2026-11-11 的要求）。 */
  function armName(v) {
    if (!v || v.length !== 5) return '';
    var same = true, i;
    for (i = 1; i < v.length; i++) if (v[i] !== v[0]) same = false;
    if (same) return '豹子 · ' + v.join('');
    if (wildLion(v)) return '豹子 · ' + v.join('');
    if (isStraight(v)) {
      var s = v.slice().sort(function (a, b) { return a - b; });
      return '顺子 · ' + s.join(' ');
    }
    return v.join(' ');
  }

  function buildDbg() {
    if (el.lionRow) {
      var h = '<div class="quick-row"><div class="qchip wide" data-lion="0">随机豹子</div></div>' +
              '<div class="quick-row">';
      for (var i = 1; i <= 6; i++) h += '<div class="qchip" data-lion="' + i + '">' + i + '</div>';
      el.lionRow.innerHTML = h + '</div>';
    }
    if (el.straightRow) {
      el.straightRow.innerHTML =
        '<div class="qchip wide hot" data-straight="0">随机顺子</div>' +
        '<div class="qchip wide" data-straight="1">1 2 3 4 5</div>' +
        '<div class="qchip wide" data-straight="2">2 3 4 5 6</div>';
    }
  }

  /* 面板里那几颗 chip 跟着「服务端手上那手装填」亮 —— 点过没点过，一眼看得见 */
  function paintChips(v) {
    var rows = [el.lionRow, el.straightRow];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!row) continue;
      var chips = row.querySelectorAll('.qchip');
      for (var i = 0; i < chips.length; i++) {
        var on = false;
        var lk = chips[i].getAttribute('data-lion');
        var sk = chips[i].getAttribute('data-straight');
        if (v && lk !== null) {
          var lv = Number(lk);
          if (lv === 0) {
            /* 随机豹子装的是带 1 的万能豹，亮它自己，别去亮某个点数 chip */
            on = !!wildLion(v);
          } else {
            var hit = true;
            for (var k = 0; k < v.length; k++) if (v[k] !== lv) hit = false;
            on = hit;
          }
        } else if (v && sk !== null) {
          var sv = Number(sk);
          var skey = straightKey(v);
          var sortedStr = v.slice().sort(function (a, b) { return a - b; }).join(',');
          var shuffled = v.join(',') !== sortedStr;
          /* 随机档 = 打散过的任意一条顺子（连顺、带 1 的万能顺都算）；
             固定两颗只认升序排好的那两条 —— 别两颗一起亮 */
          if (sv === 0) on = isStraight(v) && shuffled;
          else on = skey === sv && !shuffled;
        }
        chips[i].classList.toggle('on', on);
      }
    }
  }

  function paintDbg() {
    var arm = dbgArm();
    if (el.swTap) el.swTap.checked = !!dbg.tap;
    if (el.swZone) el.swZone.checked = !!dbg.zone;
    if (el.swSnd) el.swSnd.checked = window.LDSnd ? window.LDSnd.isOn() : true;
    /* 三格只有「总闸 + 这一项」都开着才接手指，平时它连碰都不碰手指 */
    if (el.zone) el.zone.classList.toggle('on', arm && dbg.zone);
    document.body.classList.toggle('lr-tap-edit', arm && dbg.tap);
    syncTapEdit();

    /* 装填状态以服务端那手为准（liarPub 里的 dbg.arm），本地不猜 ——
       「点了到底有没有效」这件事必须有个地方能看见，不然只能靠猜。
       hit 是「刚给别人塞了一手」的回执：8 秒后自己收掉，别一直挂在那儿。 */
    var v = (S.st && S.st.dbg && S.st.dbg.arm) || null;
    var hit = (S.st && S.st.dbg && S.st.dbg.hit) || null;
    if (hit && Date.now() - (hit.at || 0) > 8000) hit = null;
    if (el.force) el.force.classList.toggle('armed', !!v || !!hit);
    if (el.fsText) {
      var line = v
        ? '已装填 · ' + armName(v) + ' · 摇一摇生效，仅一次'
        : '未装填 · 点下面任一项，摇一摇才生效';
      el.fsText.innerHTML = esc(line) +
        (hit ? '<i class="fs-hit">已装填给 ' + esc(hit.name) + ' · ' + esc(hit.act) +
               (hit.next ? ' · 下一把生效' : ' · 这一把生效') + '</i>' : '');
    }
    paintChips(v);
    paintZoneCfg();
  }

  function setDbg(k, v) {
    dbg[k] = !!v;
    saveDbg();
    paintDbg();
    /* 一个字都不弹：开 = 两下短的，关 = 一下长的（跟单机、找朋友一致） */
    buzz(v ? [14, 75, 14] : 45);
    if (window.LDDev) window.LDDev.keep();
    tellDbg();
  }

  function openDbg() {
    if (!el.dbg) return;
    if (window.LDDev) window.LDDev.keep();
    buzz(16);
    paintDbg();
    el.dbg.hidden = false;
    /* 手指还按在标题上：松手那一下会被当成面板里的一次点击，
       先把面板挡 400ms（单机和找朋友都是这么处理的） */
    var sheet = el.dbg.querySelector('.lr-dbg-sheet');
    if (sheet) {
      sheet.style.pointerEvents = 'none';
      setTimeout(function () { sheet.style.pointerEvents = ''; }, 400);
    }
  }

  function closeDbg() {
    if (el.dbg) el.dbg.hidden = true;
  }

  /* 随机顺子：从 1~6 里删掉一个点数 = 5 颗互不重复，按吹牛规则就是顺子。

     **只在 2~5 里删**，也就是每一次都留下 1：1 是万能牌，正好顶掉断掉的那一截。
     得到的是 13456 / 12456 / 12356 / 12346 四种形态，随机一种再打散顺序。

     为什么不掺连顺：用户 2026-11-11 连着两次反馈「调试出来的顺子怎么都是
     12345 / 23456，没有别的」。之前为了「偶尔自然一点」留了 22% 概率出连顺，
     结果连着点几下就撞上好几次，看着像随机档根本没用。
     连顺本来就有下面两颗固定 chip 专门发，随机档就专心出带 1 的那种。

     最后洗牌、并保证不是升序：升序留给下面两颗固定档，
     面板才分得出「随机档 / 固定档」哪颗 chip 亮。 */
  function randomStraight() {
    var drop = 2 + Math.floor(Math.random() * 4);   // 2~5：一定带 1
    var i, j, tmp;
    var pool = [];
    for (i = 1; i <= 6; i++) if (i !== drop) pool.push(i);
    for (i = pool.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    for (i = 1; i < pool.length; i++) if (pool[i] < pool[i - 1]) return pool;
    tmp = pool[0]; pool[0] = pool[1]; pool[1] = tmp;   // 恰好还是升序，就换一下头两颗
    return pool;
  }

  /* 随机豹子 = 单机那套「万能豹子」：点数随机 × 形态随机。
     1 在吹牛里是万能牌（非斋局），「1 1 6 6 6」跟「6 6 6 6 6」是同一手
     满点豹子，但摊出来看着就是一手普通牌。五个一模一样（尤其 11111）
     一眼就看出被装过 —— 用户 2026-11-11 明确不要正豹。

     真点数取 2~6（取 1 会凑成 11111），颗数 2~4：至少留 2 颗真点数，
     免得「6 1 1 1 1」四个 1 又扎眼；至少留 1 个 1，不然就退回正豹了。
     最后打散顺序，别让 1 全堆在后面。 */
  function randomLion() {
    var n = 5;
    var v = 2 + Math.floor(Math.random() * 5);   // 2~6
    var k = 2 + Math.floor(Math.random() * 3);   // 2~4 颗真点数
    var out = [], i;
    for (i = 0; i < k; i++) out.push(v);
    while (out.length < n) out.push(1);
    for (i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /* 随机「好牌」：三张同点 + 一张 1（万能）+ 一张别的点数，比如 3 3 3 1 5。
     用户 2026-11-11 定的形态，简称「他好」。第四张不给同点 —— 3 3 3 3 1 就是豹子了，
     一眼看出被安排；3 3 3 1 5 够硬又像随手摇的。杂牌取 2~6 里除掉 v 的那四个。 */
  function randomGood() {
    var v = 2 + Math.floor(Math.random() * 5);   // 2~6
    var others = [], i, j, tmp;
    for (i = 2; i <= 6; i++) if (i !== v) others.push(i);
    var x = others[Math.floor(Math.random() * others.length)];
    var out = [v, v, v, 1, x];
    for (i = out.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /* 装填：只在自己这张桌子上、还没摇的时候装。服务端会再判一遍。
     摇不了的场合也给一下短震 —— 不然「点了没反应」和「点了没生效」分不清。 */
  function armDice(v, pat) {
    var st = S.st;
    var me = myIdx();
    if (!st || st.phase !== 'roll' || me < 0) { buzz(12); return; }
    var s = st.seats && st.seats[me];
    if (!s || s.rolled) { buzz(12); return; }
    buzz(pat || 22);
    send({ t: 'larm', dice: v });
  }

  /* 装填别人：随机挑一位还没摇的，只改他那一手。
     挑人放在服务端（客户端只看得见「谁摇了」，看不见别人点数），
     回执也只回给发起者 —— 被挑中的人只会觉得「这一把运气好」。
     2026-11-11 补：对方已经摇过的时候也能点，服务端会排到下一把
     （原来这里只认 phase === 'roll'，而正常打牌你点面板的时候早过了这一段）。 */
  function otherArm(kind) {
    var st = S.st;
    if (!st || st.phase === 'lobby' || st.phase === 'over') { buzz(12); return; }
    /* 三种手感分开：顺子一下短、好牌一下中、豹子一下长 */
    buzz(kind === 'lion' ? 45 : (kind === 'good' ? 32 : 22));
    send({ t: 'larmOther', kind: kind });
    setTimeout(paintDbg, 8300);      // 回执那一行 8 秒后自己收掉
  }

  /* 三格里每一格真正做的事。加新功能 = DBG_ACTS 加一项 + 这里补一条，
     面板的 chip、三格说明、「上/中/下」文案都会自动跟着变。 */
  function runAct(id) {
    if (id === 'st') armDice(randomStraight(), 22);
    else if (id === 'lion') armDice(randomLion(), 45);
    else if (id === 'tap') setDbg('tap', !dbg.tap);
    else if (id === 'ost') otherArm('st');
    else if (id === 'olion') otherArm('lion');
    else if (id === 'ogood') otherArm('good');
  }

  /* 面板里那三行 chip：一行一个格子，每行五颗功能，点哪颗就把这一格换成它 */
  function paintZoneCfg() {
    for (var i = 0; i < 3; i++) {
      var box = el['zCfg' + i];
      if (!box) continue;
      if (!box.getAttribute('data-built')) {
        var h = '';
        for (var k = 0; k < DBG_ACTS.length; k++) {
          h += '<div class="qchip zchip" data-a="' + DBG_ACTS[k].id + '">' +
               DBG_ACTS[k].short + '</div>';
        }
        box.innerHTML = h;
        box.setAttribute('data-built', '1');
      }
      var chips = box.querySelectorAll('.zchip');
      for (var j = 0; j < chips.length; j++) {
        chips[j].classList.toggle('on', chips[j].getAttribute('data-a') === dbg.z[i]);
      }
    }
    if (el.zoneSub) {
      el.zoneSub.textContent = '上 ' + actOfShort(dbg.z[0]) +
        ' · 中 ' + actOfShort(dbg.z[1]) + ' · 下 ' + actOfShort(dbg.z[2]);
    }
  }

  function bindDbg() {
    var click = function (node, fn) { if (node) node.addEventListener('click', fn); };

    /* 长按顶上那两行字（「第 N 局」「各自摇 · 0/2 家摇完」）1.2 秒。
       总闸关着的时候连计时都不起：不震、不弹，跟一块普通文字没有区别。 */
    var t = el.top;
    if (t) {
      var timer = 0;
      var start = function () {
        if (!dbgArm()) return;
        clearTimeout(timer);
        timer = setTimeout(function () { timer = 0; openDbg(); }, 1200);
      };
      var stop = function () {
        if (timer) { clearTimeout(timer); timer = 0; }
      };
      t.addEventListener('touchstart', start, { passive: true });
      t.addEventListener('touchend', stop);
      t.addEventListener('touchcancel', stop);
      t.addEventListener('mousedown', start);
      t.addEventListener('mouseup', stop);
      t.addEventListener('mouseleave', stop);
      /* 手机上长按会弹「选择文字 / 复制」，一弹出来长按这件事就全暴露了 */
      t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    click(el.swTap, function () { setDbg('tap', el.swTap.checked); });
    click(el.swZone, function () { setDbg('zone', el.swZone.checked); });
    click(el.swSnd, function () {
      var on = window.LDSnd ? window.LDSnd.toggle() : true;
      if (el.soundIc) el.soundIc.textContent = on ? '🔊' : '🔇';
      paintDbg();
      if (window.LDDev) window.LDDev.keep();
    });
    click(el.dbgX, closeDbg);
    click(el.dbg, function (e) { if (e.target === el.dbg) closeDbg(); });

    /* 一键豹子：0 = 随机豹子（万能豹，形态随机），1~6 = 指定点数的正豹 */
    click(el.lionRow, function (e) {
      var c = e.target.closest ? e.target.closest('[data-lion]') : null;
      if (!c || !dbgArm()) return;
      if (window.LDDev) window.LDDev.keep();
      var v = Number(c.getAttribute('data-lion'));
      if (!v) { armDice(randomLion(), 45); return; }
      var out = [];
      for (var i = 0; i < 5; i++) out.push(v);
      armDice(out, 45);
    });

    /* 顺子：0 = 随机，1 = 1 2 3 4 5，2 = 2 3 4 5 6 */
    click(el.straightRow, function (e) {
      var c = e.target.closest ? e.target.closest('[data-straight]') : null;
      if (!c || !dbgArm()) return;
      if (window.LDDev) window.LDDev.keep();
      var k = Number(c.getAttribute('data-straight'));
      armDice(k === 0 ? randomStraight() : DBG_STRAIGHTS[k - 1].slice(), 22);
    });

    /* 装填别人：随机挑一位还没摇的。挑人、出牌都在服务端，这里只发两个字。 */
    click(el.otherSt, function () {
      if (!dbgArm()) return;
      if (window.LDDev) window.LDDev.keep();
      otherArm('st');
    });
    click(el.otherLion, function () {
      if (!dbgArm()) return;
      if (window.LDDev) window.LDDev.keep();
      otherArm('lion');
    });
    click(el.otherGood, function () {
      if (!dbgArm()) return;
      if (window.LDDev) window.LDDev.keep();
      otherArm('good');
    });

    /* 三格配置：点哪颗 chip，这一格就换成哪个功能（存本地，下次打开还在） */
    for (var zi = 0; zi < 3; zi++) {
      (function (i) {
        var box = el['zCfg' + i];
        if (!box) return;
        box.addEventListener('click', function (e) {
          var c = e.target.closest ? e.target.closest('[data-a]') : null;
          if (!c || !dbgArm()) return;
          var id = c.getAttribute('data-a');
          if (!actOf(id)) return;
          dbg.z[i] = id;
          saveDbg();
          paintDbg();
          buzz(18);
          if (window.LDDev) window.LDDev.keep();
        });
      })(zi);
    }

    /* 三格：每块自己接手指。以前是在容器上按 clientY 算落在哪一格 ——
       手机上点下面两格根本没进 handler（用户 2026-11-11 实测），
       所以改成 pointerdown 直接落在哪块算哪块，再不依赖坐标。

       2026-11-11 第三轮：格子里的功能**不再写死**，落在第几格（data-z 0/1/2）
       就去 dbg.z 里取那一格绑的功能，交给 runAct 执行。 */
    if (el.zone) {
      var zAt = 0;
      var zFire = function (idx) {
        if (!dbgArm() || !dbg.zone) return;
        if (!(idx >= 0 && idx < 3)) return;
        var now = Date.now();
        if (now - zAt < 260) return;      // pointerdown 之后紧跟的那次 click 不重复算
        zAt = now;
        if (window.LDDev) window.LDDev.keep();
        runAct(dbg.z[idx]);
      };
      var zKey = function (e) {
        var n = e.target;
        while (n && n !== el.zone && n.getAttribute('data-z') === null) n = n.parentNode;
        if (!n || n === el.zone) return -1;
        return parseInt(n.getAttribute('data-z'), 10);
      };
      el.zone.addEventListener('pointerdown', function (e) {
        var k = zKey(e);
        if (k >= 0) { e.preventDefault(); zFire(k); }
      });
      el.zone.addEventListener('click', function (e) {
        var k = zKey(e);
        if (k >= 0) zFire(k);
      });
    }

    /* 开盖后连点两下同一颗骰子 → 那一颗 +1（1~6 转圈）。
       用 pointerdown 而不是 click：骰子套在盅里，盅那套掀盖手势会 setPointerCapture，
       一抓之下 pointerup 也归盅，click 就被派给盅了 —— 骰子永远等不到。
       （bindCup 那边同时让开：落在 [data-i] 上就不掀盖。） */
    if (el.meDice) {
      el.meDice.addEventListener('pointerdown', function (e) {
        if (!tapEditLive()) return;
        var n = e.target;
        while (n && n !== el.meDice && n.getAttribute('data-i') === null) n = n.parentNode;
        if (!n || n === el.meDice) return;
        var i = parseInt(n.getAttribute('data-i'), 10);
        var now = Date.now();
        if (i === tapI && now - tapAt < TAP_GAP) {
          tapI = -1;
          tapAt = 0;
          e.preventDefault();
          buzz(35);                 // 改成了：一下够长，握在手里能分出来
          send({ t: 'lset', i: i });
        } else {
          tapI = i;
          tapAt = now;
          buzz(18);                 // 第一下：轻一点，确认手指落在骰子上
        }
      });
    }
  }

  /* ================= 调试功能（暗门）结束 ================= */

  /* ---------------- 绑定 ---------------- */

  function bind() {
    var click = function (node, fn) {
      if (node) node.addEventListener('click', fn);
    };

    bindCup();

    click(el.back, function () {
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
    });
    click(el.lobbyQuit, function () {
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
    });
    /* 牌桌上的返回跟大厅那一个是同一件事：离开这一桌。
       （不打「退回大厅」—— 局已经开了，大厅没有意义） */
    click(el.back2, function () {
      leaveAll();
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
    });
    click(el.joinBtn, function () { joinRoom(); });
    click(el.newBtn, function () { createRoom(); });
    click(el.lobbyStart, function () {
      if (el.lobbyStart && el.lobbyStart.disabled) return;
      send({ t: 'start' });
    });
    click(el.copyBtn, function () {
      var t = S.code;
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(t);
        else {
          var ta = document.createElement('textarea');
          ta.value = t;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        if (el.copyBtn) {
          el.copyBtn.textContent = '已复制';
          setTimeout(function () { if (el.copyBtn) el.copyBtn.textContent = '复制房号'; }, 1200);
        }
      } catch (e) {}
    });
    if (el.code) {
      el.code.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') joinRoom();
      });
    }

    /* 上一桌：点一下回原位（房间还活着才有这张卡） */
    click(el.resume, function () {
      var last = lastRoom();
      if (last) enterRoom(last.code);
    });

    /* 牌桌上的动作：一张总代理，按钮由 paintBtns 生成 */
    if (el.btns) {
      el.btns.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== el.btns && !t.getAttribute('data-act')) t = t.parentNode;
        if (!t || t === el.btns) return;
        var act = t.getAttribute('data-act');
        if (act === 'roll') { playShake(); shakeCup(); send({ t: 'lroll' }); }
        /* 「开牌」是一张票：2/3 的人点了，服务端当场摊牌 */
        else if (act === 'open') { buzz(18); cue('pass'); send({ t: 'lopen' }); }
        else if (act === 'next') { cue('pass'); send({ t: 'lnext' }); }
      });
    }

    /* 点座位名字 = 请人出去（能不能请由 canKick 说了算，服务端再判一遍） */
    if (el.seats) {
      el.seats.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== el.seats && !t.getAttribute('data-i')) t = t.parentNode;
        if (!t || t === el.seats) return;
        openKick(parseInt(t.getAttribute('data-i'), 10));
      });
    }
    /* 摊牌那一屏座位卡是收起来的，能点的名字在那张大表上（.lr-rv[data-i]）。
       两处走同一个 openKick —— 能请谁只由 canKick 判，不在第二个地方另写一套。

       只认点在**名字**上：整行都能点的话，房主想看清谁有顺子、随手一按就弹「请出房间」，
       那一屏就没法看了。座位卡那边整张卡都能点，是因为卡片本来就小、也只有名字占地方。 */
    if (el.revList) {
      el.revList.addEventListener('click', function (e) {
        var n = e.target;
        while (n && n !== el.revList &&
               !(n.classList && n.classList.contains('lr-rv-n'))) n = n.parentNode;
        if (!n || n === el.revList) return;
        var row = n;
        while (row && row !== el.revList && !row.getAttribute('data-i')) row = row.parentNode;
        if (!row || row === el.revList) return;
        openKick(parseInt(row.getAttribute('data-i'), 10));
      });
    }
    /* 点背板（不是卡片本身）也算「算了」 */
    click(el.kick, function (e) {
      if (e.target === el.kick) closeKick();
    });
    click(el.kickNo, function () { closeKick(); });
    click(el.kickGo, function () { doKick(); });

    /* 本局记录 / 桌上的人 */
    click(el.logBtn, function () { openSheet('log'); });
    click(el.whoBtn, function () { openSheet('who'); });
    click(el.tabLog, function () { setTab('log'); });
    click(el.tabWho, function () { setTab('who'); });
    click(el.logX, closeSheet);
    if (el.logMask) el.logMask.addEventListener('click', function (e) {
      if (e.target === el.logMask) closeSheet();       // 点背板 = 收起
    });
    if (el.whoList) el.whoList.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== el.whoList &&
             !(n.getAttribute && n.getAttribute('data-i'))) n = n.parentNode;
      if (!n || n === el.whoList || !n.getAttribute('data-i')) return;
      closeSheet();
      openKick(parseInt(n.getAttribute('data-i'), 10));
    });

    /* 音效开关：跟 350 / 找朋友同一颗组件、同一份状态 */
    if (el.sound) {
      el.sound.addEventListener('click', function () {
        if (window.LDSnd) {
          var on = window.LDSnd.toggle();
          if (el.soundIc) el.soundIc.textContent = on ? '🔊' : '🔇';
        }
      });
      if (el.soundIc && window.LDSnd) {
        el.soundIc.textContent = window.LDSnd.isOn() ? '🔊' : '🔇';
      }
      window.addEventListener('ldsound', function (ev) {
        if (el.soundIc && ev.detail) el.soundIc.textContent = ev.detail.on ? '🔊' : '🔇';
      });
    }

    /* 玩法说明：跟别的玩法同一张弹层（f350.js 的 openRules） */
    click(el.rule, function () {
      if (window.F350 && window.F350.rules) window.F350.rules('liarnet');
    });
    click(el.rule2, function () {
      if (window.F350 && window.F350.rules) window.F350.rules('liarnet');
    });
  }

  /* ---------------- 进 / 出这一页 ---------------- */

  function enter() {
    S.api = apiBase();
    if (el.whoName) el.whoName.textContent = myName();

    var room = (location.search.match(/[?&]room=(\d{4}|\d{6})/) || [])[1];
    if (room) {
      try {
        if (history.replaceState) history.replaceState(null, '', location.pathname + (location.hash || ''));
      } catch (e) {}
      enterRoom(room);
      return;
    }
    if (S.code && !S.ws) {
      S.alive = true;
      connect();     // 从别的页面回来：房号和座位都还在，直接重连
    }
    render();
    paintResume();
  }

  /* 「上一桌还没打完」：本地只记房号，房间死没死现场问一句。
     摆一个点进去是空桌的入口，比不摆更让人恼火。 */
  function paintResume() {
    var box = el.resume;
    if (!box) return;
    var last = lastRoom();
    if (!last || !S.api) { box.hidden = true; return; }
    box.hidden = true;
    if (el.resumeCode) el.resumeCode.textContent = last.code;
    fetch(S.api + '/api/has?code=' + last.code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.room) { clearLast(); return; }
        if (j.room.game && j.room.game !== 'liar') { clearLast(); return; }
        var n = j.room.n | 0;
        if (el.resumeSub) {
          if (j.room.started) el.resumeSub.textContent = '这一局还在打 · 点一下回原位';
          else el.resumeSub.textContent = n > 1 ? n + ' 人在等开局' : '房间还在 · 点一下进去';
        }
        box.hidden = false;
      })
      .catch(function () { box.hidden = true; });
  }

  function leave() {
    if (!S.code) return;
    S.alive = false;
    clearTimeout(S.retryTimer);
    closeSocket();
    closeKick();
    showOff(false);
  }

  function boot() {
    el = {
      back: $('lrBack'), back2: $('lrBack2'), gate: $('lrGate'), lobby: $('lrLobby'), table: $('lrTable'),
      code: $('lrCode'), joinBtn: $('lrJoin'), newBtn: $('lrNew'), tip: $('lrTip'),
      whoName: $('lrWhoName'),
      resume: $('lrResume'), resumeSub: $('lrResumeSub'), resumeCode: $('lrResumeCode'),
      lobbyCode: $('lrLobbyCode'), lobbyList: $('lrLobbyList'), lobbyTip: $('lrLobbyTip'),
      lobbyStart: $('lrStart'), lobbyQuit: $('lrQuit'), copyBtn: $('lrCopy'),
      round: $('lrRound'), who: $('lrWho'), codeTag: $('lrCodeTag'),
      seats: $('lrSeats'), coreK: $('lrCoreK'), coreV: $('lrCoreV'), coreS: $('lrCoreS'),
      me: $('lrMe'), meDice: $('lrMeDice'), meName: $('lrMeName'), meTag: $('lrMeTag'),
      meSt: $('lrMeSt'),
      cup: $('lrCup'), cupRig: $('lrCupRig'), lid: $('lrLid'), stage: $('lrRing'),
      rev: $('lrRev'), revV: $('lrRevV'), revList: $('lrRevList'),
      hint: $('lrHint'), btns: $('lrBtns'), off: $('lrOff'),
      rule: $('lrRule'), rule2: $('lrRule2'),
      /* 本局记录 / 桌上的人：页脚两个入口，一个弹层两页 */
      logMask: $('lrLog'), logList: $('lrLogList'), whoList: $('lrWhoList'),
      logBtn: $('lrLogBtn'), whoBtn: $('lrWhoBtn'), logX: $('lrLogX'),
      tabLog: $('lrTabLog'), tabWho: $('lrTabWho'),
      sound: $('lrSound'), soundIc: $('lrSoundIc'),
      kick: $('lrKick'), kickName: $('lrKickName'),
      kickSub: $('lrKickSub'), kickGo: $('lrKickGo'), kickNo: $('lrKickNo'),
      top: $('lrRound') ? $('lrRound').parentNode : null,
      dbg: $('lrDbg'), dbgX: $('lrDbgX'), zone: $('lrZone'),
      force: $('lrForce'), fsText: $('lrFsText'),
      lionRow: $('lrLionRow'), straightRow: $('lrStraightRow'),
      otherSt: $('lrOtherSt'), otherLion: $('lrOtherLion'), otherGood: $('lrOtherGood'),
      zCfg0: $('lrZCfg0'), zCfg1: $('lrZCfg1'), zCfg2: $('lrZCfg2'),
      zoneSub: $('lrZoneSub'),
      swTap: $('lrSwTap'), swZone: $('lrSwZone'), swSnd: $('lrSwSnd')
    };
    if (!el.gate) return;       // 页面上没有这一页（被裁剪过 / 旧版缓存）
    loadDbg();
    buildDbg();
    bind();
    bindDbg();
    paintDbg();
    S.api = apiBase();
    render();

    /* 第一次按到屏幕就把摇骰声的音频通道打开（见上面 unlockShake 的注释）。
       捕获阶段挂，哪个元素都算数；开一次就摘掉。 */
    document.addEventListener('pointerdown', function once() {
      document.removeEventListener('pointerdown', once, true);
      unlockShake();
    }, true);

    var room = (location.search.match(/[?&]room=(\d{4}|\d{6})/) || [])[1];
    if (room) {
      if (el.code) el.code.value = room;
      enterRoom(room);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.LDLiarNet = {
    enter: enter,
    leave: leave,
    quit: quitRoom,
    /* 给自动化测试：读状态 / 直接发一条协议 */
    state: function () { return S.st; },
    send: function (o) { return send(o); },
    code: function () { return S.code; }
  };
})();

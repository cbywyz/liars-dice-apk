/* 七八九 · 联机版客户端（每人一台手机）。
   点数、公杯、杯数全在服务器算 —— 客户端只发动作、只渲染广播回来的 state。
   判定口径跟 789.js 单机版一致；圆环 / 骰子 / 座位复用 789.css + find.css。
   UI 跟另外三家联机对齐：进门用 home/solo-body/fn-box，牌桌顶栏常驻房号，
   没有独立「菜单」层 —— 改名双击座位、退出走全站 quitMask、重开和上限在顶栏。 */

(function () {
  'use strict';

  var DEFAULT_API = 'https://dice.2582580.xyz';
  var NAME_KEY = 'ld_net_name';        // 跟另外三家共用昵称
  var SEAT_KEY = 'ld_g9_seat_';
  var LAST_KEY = 'ld_g9_last';
  var SHAKE_SRC = 'assets/audio/shake.mp3';

  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var RED = { 1: true, 4: true };

  var S = {
    api: DEFAULT_API, code: '', ws: null, you: null, token: null, st: null,
    alive: false, retry: 0, retryTimer: 0, pingTimer: 0, lastTap: 0, lastTapPid: '',
    kickPid: ''                  // 请人出去面板里正在说的那个人
  };
  var el = {};
  var seatEls = [];
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 环境 / 小工具 ---------------- */

  function apiBase() {
    var h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || /^192\.168\./.test(h)) {
      return location.protocol + '//' + h + (location.port ? ':' + location.port : '');
    }
    return DEFAULT_API;
  }
  function myName() {
    try { return localStorage.getItem(NAME_KEY) || '无名'; } catch (e) { return '无名'; }
  }
  function loadSeat(code) {
    try { return JSON.parse(localStorage.getItem(SEAT_KEY + code) || 'null'); } catch (e) { return null; }
  }
  function saveSeat() {
    if (!S.code || !S.you) return;
    try { localStorage.setItem(SEAT_KEY + S.code, JSON.stringify({ pid: S.you, token: S.token })); } catch (e) {}
  }
  function saveLast() {
    try { localStorage.setItem(LAST_KEY, S.code); } catch (e) {}
  }
  function lastCode() {
    try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; }
  }
  function clearLast() {
    try { localStorage.removeItem(LAST_KEY); } catch (e) {}
  }
  function nameOf(i) { return (i >= 0 && S.st && S.st.players[i]) ? S.st.players[i].name : (i + 1) + ' 号'; }
  function cupText(u) { return u ? (u / 2) + ' 杯' : ''; }
  /* 休息四态：跟找朋友 / 350 同一套服务端字段（roundAway / away / awayBack） */
  function restTagText(s) {
    if (!s) return '';
    if (s.rest) return s.away === 'rest' ? '休息中' : '下把回来';
    if (s.away === 'rest') return '下把休息';
    if (s.awayBack && (s.awayLast | 0) > 0) return '刚回来';
    return '';
  }
  function restClock(s) { return window.LDAwayClock ? window.LDAwayClock.stamp(s) : ''; }
  function idxOf(st, id) {
    if (!st || !id) return -1;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === id) return i;
    return -1;
  }
  function myIdx() { return idxOf(S.st, S.you); }

  function buzz(pat) { try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {} }
  function cue(n) { try { if (window.LDSnd) window.LDSnd.cue(n); } catch (e) {} }

  /* 摇骰真音频：全站同一颗 shake.mp3，跟单机 789 / 另外三家联机一致。
     iOS / 微信的第一次 play 必须在手势里解锁，否则安卓有声、iPhone 没声。 */
  var shk = null, shkUnlocked = false;
  function ensureShk() {
    if (shk) return shk;
    try {
      shk = new Audio(SHAKE_SRC);
      shk.preload = 'auto';
      shk.addEventListener('error', function () { shk = null; });
    } catch (e) { shk = null; }
    return shk;
  }
  function unlockShk() {
    if (shkUnlocked) return;
    var a = ensureShk();
    if (!a) return;
    shkUnlocked = true;
    try {
      a.muted = true;
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
      if (p && p.catch) p.catch(function () { unlockShk(); });
    } catch (e) {}
  }

  var tipTimer = 0;
  function tip(msg) {
    if (!el.tip) return;
    el.tip.textContent = msg || '';
    if (el.tip.classList && el.tip.classList.toggle) el.tip.classList.toggle('show', !!msg);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      el.tip.textContent = '';
      if (el.tip.classList) el.tip.classList.remove('show');
    }, 3200);
  }

  function dieHtml(v, size) {
    var on = PIPS[v] || [];
    var h = '<span class="fd-d' + (v ? '' : ' empty') + '"' + (size ? ' style="--s:' + size + '"' : '') + '>';
    for (var i = 0; i < 9; i++) h += on.indexOf(i) >= 0 ? '<i class="' + (RED[v] ? 'r' : '') + '"></i>' : '<i class="blank"></i>';
    return h + '</span>';
  }

  /* ---------------- 轮转（跟 g789Active / g789NextIdx 同口径） ---------------- */

  function activeSeats(st) {
    return st.players.filter(function (p) { return p.online && !p.rest; });
  }
  function nextIdx(st) {
    var a = activeSeats(st);
    if (!a.length) return -1;
    var pos = -1;
    for (var i = 0; i < a.length; i++) if (a[i].seat === st.turn) { pos = i; break; }
    var at = pos < 0 ? 0 : (pos + st.dir + a.length) % a.length;
    return a[at].seat;
  }

  /* ---------------- 连接 ---------------- */

  function wsUrl() { return S.api.replace(/^http/, 'ws') + '/r/' + S.code + '/ws'; }

  function connect() {
    if (!S.code) return;
    if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = 0; }
    closeSocket();
    S.alive = true;
    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { retryLater(); return; }
    S.ws = ws;
    ws.onopen = function () {
      if (S.ws !== ws) return;
      S.retry = 0;
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
      if (S.alive) retryLater();
    };
    ws.onerror = function () {};
  }

  function retryLater() {
    if (!S.alive) return;
    clearTimeout(S.retryTimer);
    S.retry = Math.min(S.retry + 1, 4);
    S.retryTimer = setTimeout(function () { S.retryTimer = 0; connect(); }, 500 * Math.pow(2, S.retry));
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
      if (S.ws && S.ws.readyState === 1) { try { S.ws.send('{"t":"ping"}'); } catch (e) {} }
    }, 20000);
  }
  function stopPing() { if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = 0; } }
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
      /* 重连 / 换机进房：把本机这份档位重新报到服务端，两边始终同一份 */
      sendG9Dbg();
      return;
    }
    if (m.t === 'quitok') {
      clearLast();
      S.st = null;
      S.code = '';
      closeSocket();
      setScreen('gate');
      paintGate();
      return;
    }
    if (m.t === 'kicked') {
      closeKick();
      try { localStorage.removeItem(SEAT_KEY + S.code); } catch (e) {}
      clearLast();
      S.st = null;
      S.code = '';
      closeSocket();
      setScreen('gate');
      paintGate();
      tip(m.msg || '你被请出了这一桌');
      return;
    }
    if (m.t === 'err') { tip(m.msg || '这一步不行'); return; }
    if (m.t === 'state') {
      if (m.s.game && m.s.game !== '789') { tip('这个房号不是七八九'); return; }
      var prev = S.st;
      S.st = m.s;
      syncG9FromState(m.s.g9);
      render();
      if (m.s.phase === 'pick' && (!prev || prev.phase !== 'pick')) { buzz([16, 60, 16]); cue('lion'); }
      if (m.s.phase === 'handoff' && (!prev || prev.phase !== 'handoff')) cue('pass');
      renderKick();
      /* 结果卡跟着「新的一把」走：shakes 变了才算真摇了一把（keepalive 不动它）。
         7/8/9 弹出来一直摆着，玩家点继续摇就收；换成别的点数（续摇结束）也收掉，
         这样没在摇的人那头也不会留着一张过期的卡。 */
      if (!prev || prev.shakes !== m.s.shakes) {
        if (m.s.lastKind === 'half' || m.s.lastKind === 'all') cue('drink');
        if (m.s.lastKind === 'add' || m.s.lastKind === 'half' || m.s.lastKind === 'all' || m.s.lastKind === 'reverse') showFlash(m.s);
        else hideFlash();
      }
      return;
    }
  }

  /* ---------------- 屏幕 ---------------- */

  function setScreen(which) {
    el.gate.hidden = (which !== 'gate');
    el.table.hidden = (which !== 'table');
  }

  function paintGate() {
    if (!el.resume) return;
    if (el.whoName) el.whoName.textContent = myName();
    var last = lastCode();
    el.resume.hidden = !(last && last !== S.code);
    if (el.resumeCode) el.resumeCode.textContent = last || '----';
  }

  function buildSeats(n) {
    el.seats.innerHTML = '';
    seatEls = [];
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'fd-seat';
      s.setAttribute('data-i', String(i));
      var th = 270 - 360 / n + i * (360 / n);
      var rad = th * Math.PI / 180;
      var R = 0.78;
      s.style.left = (50 + 50 * R * Math.cos(rad)).toFixed(2) + '%';
      s.style.top = (50 + 50 * R * Math.sin(rad)).toFixed(2) + '%';
      if (n >= 10) s.style.width = '16.2vw';
      s.innerHTML = '<i class="fd-ord"></i><span class="fd-n"></span><span class="fd-cups"></span><span class="fd-tag"></span>';
      el.seats.appendChild(s);
      seatEls.push({ root: s, ord: s.querySelector('.fd-ord'), n: s.querySelector('.fd-n'),
                     cups: s.querySelector('.fd-cups'), tag: s.querySelector('.fd-tag') });
    }
  }

  function render() {
    var st = S.st;
    if (!st) return;
    var inRoom = idxOf(st, st.you) >= 0;
    setScreen(inRoom ? 'table' : 'gate');
    if (!inRoom) { paintGate(); return; }
    if (seatEls.length !== st.players.length) buildSeats(st.players.length);
    paint();
  }

  function paint() {
    layoutG9Hot();
    var st = S.st;
    var my = myIdx();
    /* 顶栏房号常驻：进房那一刻就有，不用点开任何东西 */
    if (el.codeTop) el.codeTop.textContent = S.code || '----';

    el.who.textContent = nameOf(st.turn) + '摇';
    el.round.textContent = '第 ' + (st.shakes + 1) + ' 把';
    el.dir.textContent = st.dir > 0 ? '↻ 顺时针' : '↺ 逆时针';
    el.dir.classList.toggle('back', st.dir < 0);
    el.ring.classList.toggle('pick', st.phase === 'pick');

    el.pot.textContent = cupText(st.pot) || '空杯';
    el.core.classList.toggle('full', st.pot >= st.cap);
    el.core.classList.toggle('low', st.pot > 0 && st.pot <= 2);
    var capN = st.cap / 2;
    var capPend = st.pendingCap;
    el.capTop.textContent = capN + ' 杯' + (capPend && capPend !== capN ? '*' : '');
    if (el.capTop.classList) {
      el.capTop.classList.toggle('is-custom', capN !== 6 || !!capPend);
      el.capTop.classList.toggle('is-voting', !!st.capVote);
    }
    /* 桌子上也常驻一份「封顶几杯」：顶栏那颗点开才能改，这里给出当前口径。
       改了还没重开时挂个 *，跟顶栏同一口径，别让人以为已经生效。 */
    if (el.capDesk) {
      el.capDesk.textContent = '封顶 ' + capN + ' 杯' + (capPend && capPend !== capN ? '*' : '');
      el.capDesk.classList.toggle('is-pend', !!(capPend && capPend !== capN));
    }

    /* 没开局：上方紧凑房号卡念给朋友，开局按钮在底部 fd-btns 里 */
    if (el.lobby) {
      el.lobby.hidden = !!st.started;
      if (!st.started && el.lobbyCode) el.lobbyCode.textContent = S.code || '----';
    }

    /* 重开投票进度直接写在顶栏按钮上，一眼看得到几票 */
    if (el.redo) {
      var v = st.vote;
      el.redo.textContent = v ? ('重开 ' + v.yes.length + '/' + v.need + (v.mine ? ' ✓' : ''))
        : '重开';
    }

    var nx = nextIdx(st);
    var order = st.startOrder || [];
    for (var i = 0; i < st.players.length; i++) {
      var p = st.players[i], se = seatEls[i];
      if (!se) continue;
      se.root.classList.toggle('now', i === st.turn);
      se.root.classList.toggle('next', i === nx);
      se.root.classList.toggle('me', p.id === S.you);
      se.root.classList.toggle('rest', !!p.rest);
      se.root.classList.toggle('rest-wait', !p.rest && p.away === 'rest');
      se.root.classList.toggle('off', !p.online);
      /* 右上角「本局第几个开摇」：开局顺序快照，跟 350 的 startOrder 一个口径。
         没开局就没有顺序，角标留空。 */
      var ord = order.indexOf(p.id) + 1;
      if (se.ord) {
        se.ord.textContent = (st.started && ord > 0) ? String(ord) : '';
        se.ord.hidden = !(st.started && ord > 0);
      }
      se.n.textContent = p.name;
      se.cups.textContent = cupText(p.cups);
      se.cups.classList.toggle('has', p.cups > 0);
      /* 状态行：优先说「该你了 / 下一个」。下一位在接手阶段写「接手」，
         平时写「下一个」—— 350 用户提过「桌面没提示下一轮轮到谁」，
         七八九也照这套，别让人数着头认。 */
      var rt = restTagText(p);
      se.tag.textContent = p.online === false ? '掉线'
        : (rt || (i === st.turn ? '摇'
        : (i === nx ? (st.phase === 'handoff' ? '接手' : '下一个') : '喝')));
    }

    var size = st.players.length >= 10 ? '6.6vw' : '9.8667vw';
    var key = (st.last || [0, 0]).join('');
    if (el.dice.getAttribute('data-k') !== key) {
      el.dice.setAttribute('data-k', key);
      el.dice.innerHTML = dieHtml(st.last ? st.last[0] : 0, size) + dieHtml(st.last ? st.last[1] : 0, size);
    }
    el.tag.textContent = st.last
      ? ((st.last[0] + st.last[1]) + ' 点' + (st.last[0] === st.last[1] ? ' · 对子' : ''))
      : '摇骰';

    paintHint(my, nx);
    paintBtns(my, nx);
  }

  function paintHint(my, nx) {
    var st = S.st, line = '', sub = '';
    if (!st.started) {
      line = '人齐了就点下面的「开局」';
      sub = '2~12 人 · 谁都能开';
    } else if (st.phase === 'ready' || st.phase === 'again') {
      line = '轮到 <b>' + nameOf(st.turn) + '</b> · 摇 2 颗';
      sub = '公杯 ' + (cupText(st.pot) || '空') + ' · 封顶 ' + (st.cap / 2) + ' 杯';
    } else if (st.phase === 'pick') {
      line = '<b>两个 1</b> · 点一位，罚 1 杯';
      sub = '这一杯单独记，不动公杯';
    } else {
      line = '<b>' + (st.last ? (st.last[0] + st.last[1]) + ' 点' : '') + '</b> → ' + (st.note || '换人');
      sub = '轮到 <b>' + nameOf(nx) + '</b>';
    }
    /* 续摇（again）那几把的 note 最要紧 —— 刚加了几杯、喝了多少、往哪掉头
       都写在里面，漏掉这一步玩家只看得到「轮到谁」，不知道刚才发生了什么。 */
    if (st.note && (st.phase === 'ready' || st.phase === 'again' || st.phase === 'pick')) {
      sub = st.note + (sub ? ' · ' + sub : '');
    }
    el.hint.innerHTML = line + (sub ? '<span class="fd-sub">' + sub + '</span>' : '');
  }

  function paintBtns(my, nx) {
    var st = S.st, h = '';
    if (!st.started) {
      /* 开局按钮挪到底部「摇」那个位置，跟其他玩法一致（2026-11-19） */
      h = '<button class="btn primary" type="button" data-act="start">开局</button>';
    } else if (st.phase === 'ready' || st.phase === 'again') {
      h = my === st.turn
        ? '<button class="btn primary" type="button" data-act="roll">' + (st.phase === 'again' ? '继续摇' : '摇骰') + '</button>'
        : '<div class="fd-hint">等 ' + nameOf(st.turn) + ' 摇</div>';
    } else if (st.phase === 'pick') {
      h = my === st.turn
        ? '<button class="btn ghost" type="button" data-act="skip">不指了</button>'
        : '<div class="fd-hint">等 ' + nameOf(st.turn) + ' 指人</div>';
    } else if (st.phase === 'handoff') {
      h = my === nx
        ? '<button class="btn primary" type="button" data-act="go">我来接手</button>'
        : '<div class="fd-hint">等 ' + nameOf(nx) + ' 接手</div>';
    }
    /* 临时休息：下一把生效、服务端走秒，跟 350 / 找朋友四态同一套。
       休息的人桌位留着、杯数留着，换人（g789Handoff）那一刻才退出轮转。 */
    if (st.started && window.LDRest && my >= 0) {
      var me = st.players[my];
      if (me) {
        var on = me.away === 'rest', live = !!me.rest;
        var showBack = !live && !on && !!me.awayBack && (me.awayLast | 0) > 0;
        var rh;
        if (!on && !live && !showBack) {
          rh = '<button class="rest-link" data-act="restopen">临时休息 · 下一把生效</button>';
        } else if (showBack || (live && !on)) {
          rh = '<span class="rest-state is-back">' +
            (showBack && !live ? '刚回来' : '已点继续 · 下一把回来') + '</span>';
        } else if (live) {
          rh = '<span class="rest-state is-live">休息中 · 本把不参与</span>' +
            '<button class="rest-go is-live" data-act="resume">点击继续</button>';
        } else {
          rh = '<span class="rest-state is-wait">已预约休息 · 下一把生效</span>' +
            '<button class="rest-go is-wait" data-act="resume">取消休息</button>';
        }
        var restN = 0, actN = 0;
        for (var ri = 0; ri < st.players.length; ri++) {
          var rp = st.players[ri];
          if (rp.rest) restN++;
          if (rp.online && !rp.rest) actN++;
        }
        var info = (restN || on) ? '桌上 ' + actN + ' 人在玩 · ' + restN + ' 人休息不算分母' : '';
        var ck = restClock(me);
        if (ck) info += (info ? '<br>' : '') + ck;
        if (info) rh += '<div class="rest-info">' + info + '</div>';
        h += '<div class="rest-row">' + rh + '</div>';
      }
    }
    el.btns.innerHTML = h;
  }

  /* ---------------- 7/8/9 结果卡 ---------------- */

  function showFlash(st) {
    if (!el.flash) return;
    var n = st.last[0] + st.last[1];
    var k = '', s = '';
    if (st.lastKind === 'add') { k = '公杯 +1 杯'; s = '接着摇'; }
    else if (st.lastKind === 'half') { k = '喝公杯一半'; s = st.note; }
    else if (st.lastKind === 'all') { k = '喝光 · 重倒 1 杯'; s = '接着摇'; }
    else if (st.lastKind === 'reverse') { k = '对子 · 掉头'; s = (st.dir > 0 ? '顺时针' : '逆时针') + ' · 换人接手'; }
    else { k = st.note || (n + ' 点'); s = ''; }
    if (el.flashN) el.flashN.textContent = String(n);
    if (el.flashK) el.flashK.textContent = k;
    if (el.flashS) el.flashS.textContent = s;
    el.flash.hidden = false;
    /* 不再自动收：玩家没点「继续摇」就一直摆着（用户 2026-11-19），
       点继续摇 / 接手 / 跳过时由按钮处理收掉。 */
  }
  function hideFlash() { if (el.flash) el.flash.hidden = true; }

  /* ================= 隐藏调试（七八九） =================
     两道门：本机总闸 = 首页页脚版本号连点 7 下（LDDev，只决定这台手机看不看得见按钮）；
     面板 = 长按牌桌标题 1.2 秒。面板「总」行是全场总闸，下面六行只配「这一格绑什么」。
     作用范围（用户 2026-11-19 拍板）：点桌面六格 = 整房下一次真摇按该格功能出点，
     不管轮到谁摇；一次性，用掉即清，不能一直生效。没激活的人看不到也点不了按钮。
     面板里点 chip 只改本机绑定（存 localStorage），不 arm、不发服务端。
     桌面六格是**隐形热区**（2026-11-19 实机纠正）：不画边框背景、不写字、不占布局；
     开总闸只切「能不能接手指」，绝不切 hidden/display —— 那样既把按钮画出来，
     又把桌子往上挤。热区用 layoutG9Hot() 贴到提示行上方，开总闸前后桌子纹丝不动。 */
  var G9DBG_KEY = 'ld_g9_dbg';
  /* 六格能绑的功能清单；short 显示在桌面格子和面板 chip 上。空串 = 这格不绑、点了没反应 */
  var G9_ACTS = [
    { id: '7', short: '7' },
    { id: '8', short: '8' },
    { id: '9', short: '9' },
    { id: 'avoid', short: '避' },
    { id: 'pair', short: '对' },
    { id: '', short: '—' }
  ];
  var G9_Z_DEF = ['7', '8', '9', 'avoid', 'pair', ''];
  var g9 = { hot: false, z: G9_Z_DEF.slice(), once: null };

  function g9Arm() { return !!(window.LDDev && window.LDDev.on()); }
  function g9HotOn() { return g9Arm() && g9.hot; }
  function g9Act(id) {
    for (var i = 0; i < G9_ACTS.length; i++) if (G9_ACTS[i].id === id) return G9_ACTS[i];
    return null;
  }
  function g9Short(id) { var a = g9Act(id); return a ? a.short : '—'; }

  function loadG9Dbg() {
    try {
      var o = JSON.parse(localStorage.getItem(G9DBG_KEY) || 'null');
      if (o) {
        g9.hot = !!o.hot;
        if (Object.prototype.toString.call(o.z) === '[object Array]') {
          for (var i = 0; i < 6; i++) if (g9Act(o.z[i])) g9.z[i] = o.z[i];
        }
      }
    } catch (e) {}
  }
  function saveG9Dbg() {
    try { localStorage.setItem(G9DBG_KEY, JSON.stringify({ hot: g9.hot, z: g9.z })); } catch (e) {}
  }

  /* 总闸单独发：绑定只存本机，不上报。断线重连后把总闸重新报一次。
     关总闸也要发 on:false —— 服务端收到会把房间上挂着的一次性档位一起清掉。 */
  function sendG9Dbg() {
    if (!S.ws || S.ws.readyState !== 1) return;
    try { S.ws.send(JSON.stringify({ t: 'g9dbg', on: g9Arm() && g9.hot })); } catch (e) {}
  }

  /* 房间广播回来：整房同一份。once 有值 = 那一档正 arm 着，桌面对应格子高亮；
     下一次真摇服务端自己清掉，state 回来这里就跟着灭。 */
  function syncG9FromState(g) {
    if (!g) return;
    var on = !!g.on, once = g.once || null;
    var diff = (g9.hot !== on) || (g9.once !== once);
    g9.hot = on;
    g9.once = once;
    if (diff) { saveG9Dbg(); paintG9Dbg(); }
  }

  /* 六格热区贴到提示行上方：它 absolute 脱离文档流，自己不占布局，
     所以开总闸前后桌子、提示行、按钮的坐标一模一样（用户 2026-11-19 实机要求）。
     贴着 hint 算，提示文字换行 / 按钮几态变化都不会压到真按钮上。 */
  function layoutG9Hot() {
    if (!el.hot || !el.hint || !el.table || el.table.hidden) return;
    var h = el.hot.offsetHeight;
    if (!h) return;
    var top = el.hint.offsetTop - h - 8;
    el.hot.style.top = (top < 0 ? 0 : top) + 'px';
  }

  function paintG9Dbg() {
    if (el.dbg) {
      var hotRow = el.dbg.querySelector('.dbg-row[data-k="hot"]');
      if (hotRow) hotRow.classList.toggle('is-on', g9Arm() && g9.hot);
      /* 六行绑定：每行六颗 chip，点哪颗就把这一格改成哪个功能 */
      for (var i = 0; i < 6; i++) {
        var box = el.dbg.querySelector('[data-cfg="' + i + '"]');
        if (!box) continue;
        if (!box.getAttribute('data-built')) {
          var h = '';
          for (var k = 0; k < G9_ACTS.length; k++) {
            h += '<div class="g9chip" data-a="' + G9_ACTS[k].id + '">' + G9_ACTS[k].short + '</div>';
          }
          box.innerHTML = h;
          box.setAttribute('data-built', '1');
        }
        var chips = box.querySelectorAll('.g9chip');
        for (var j = 0; j < chips.length; j++) {
          chips[j].classList.toggle('on', chips[j].getAttribute('data-a') === g9.z[i]);
        }
      }
      if (el.dbgSub) {
        el.dbgSub.textContent = '1 ' + g9Short(g9.z[0]) + ' · 2 ' + g9Short(g9.z[1]) +
          ' · 3 ' + g9Short(g9.z[2]) + ' · 4 ' + g9Short(g9.z[3]) +
          ' · 5 ' + g9Short(g9.z[4]) + ' · 6 ' + g9Short(g9.z[5]);
      }
    }
    /* 六格是**看不见**的热区：开关只切能不能接手指（.on），绝不再切 hidden /
       display —— 那样会把桌面挤动（用户 2026-11-19 实机反馈）。绑定文字只留在面板
       chip 同 dbgSub 上，桌面格子不写任何字、不画边框背景、也不做点亮反馈。 */
    if (el.hot) el.hot.classList.toggle('on', g9HotOn());
  }

  /* 点面板总闸：关掉连房间上的一次性档位一起清 */
  function setG9Hot() {
    g9.hot = !g9.hot;
    if (!g9.hot) g9.once = null;
    saveG9Dbg();
    paintG9Dbg();
    buzz(g9.hot ? [14, 75, 14] : 45);
    if (window.LDDev) window.LDDev.keep();
    sendG9Dbg();
  }

  /* 点面板 chip：只改本机这一格的绑定，不 arm、不发服务端 */
  function setG9Bind(slot, id) {
    if (!g9Act(id)) return;
    g9.z[slot] = id;
    saveG9Dbg();
    paintG9Dbg();
    buzz(18);
    if (window.LDDev) window.LDDev.keep();
  }

  /* 点桌面六格：把这一格绑的功能 arm 到房间上，只影响下一次真摇。
     总闸没开就先开（省得设了却不生效），再发 g9arm —— 整房、一次性。 */
  function armG9(slot) {
    if (!g9Arm()) return;
    var id = g9.z[slot];
    if (!id) { tip('这一格没绑功能 · 长按标题在面板里设'); return; }
    if (!g9.hot) {
      g9.hot = true;
      saveG9Dbg();
      sendG9Dbg();
    }
    g9.once = id;
    paintG9Dbg();
    buzz([14, 75, 14]);
    if (window.LDDev) window.LDDev.keep();
    try { S.ws.send(JSON.stringify({ t: 'g9arm', k: id })); } catch (e) {}
  }
  function openG9Dbg() {
    if (!el.dbg) return;
    if (window.LDDev) window.LDDev.keep();
    buzz(16);
    paintG9Dbg();
    el.dbg.hidden = false;
    var sheet = el.dbg.querySelector('.dbg-sheet');
    if (sheet) {
      sheet.style.pointerEvents = 'none';
      setTimeout(function () { sheet.style.pointerEvents = ''; }, 400);
    }
  }
  function closeG9Dbg() { if (el.dbg) el.dbg.hidden = true; }

  function bindG9Title() {
    var t = el.title;
    if (!t) return;
    var timer = 0;
    function start() {
      if (!g9Arm()) return;
      clearTimeout(timer);
      timer = setTimeout(function () { timer = 0; openG9Dbg(); }, 1200);
    }
    function stop() { if (timer) { clearTimeout(timer); timer = 0; } }
    t.addEventListener('touchstart', start, { passive: true });
    t.addEventListener('touchend', stop);
    t.addEventListener('touchcancel', stop);
    t.addEventListener('mousedown', start);
    t.addEventListener('mouseup', stop);
    t.addEventListener('mouseleave', stop);
    /* 手机上长按会弹「选择文字 / 复制」，弹出来就把长按这件事全暴露了 */
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ---------------- 请人出去：页内确认面板（不弹系统 confirm） ----------------
     跟 350 的 ngKick 一个口径：房主一点就走，其他人发起后要三分之二同意。
     面板只在点别人座位时开；服务器广播回来就刷新票数，目标不在房里了就自己收。 */

  function hostOf(st) {
    if (!st) return null;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].seat === 0) return st.players[i];
    return null;
  }
  function playerById(st, pid) {
    if (!st || !pid) return null;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === pid) return st.players[i];
    return null;
  }
  function kickNow(st) {
    var k = st && st.kick;
    return (k && k.target === S.kickPid) ? k : null;
  }
  function renderKick() {
    if (!el.kick || el.kick.hidden) return;
    var st = S.st;
    var p = playerById(st, S.kickPid);
    if (!p) { closeKick(); return; }
    var host = hostOf(st);
    var isHost = !!host && host.id === S.you;
    var k = kickNow(st);
    var mine = !!(k && k.yes.indexOf(S.you) >= 0);

    el.kickName.textContent = p.name + (p.online === false ? ' · 离线' : '');
    if (isHost) {
      el.kickSub.textContent = p.online === false
        ? '离线有一会儿了 · 请出去，座位让给下一位'
        : '他还在线 · 确定要请出去？';
      el.kickOk.textContent = '踢出房间';
    } else if (k) {
      el.kickSub.textContent = '已有 ' + k.yes.length + '/' + k.need + ' 人同意 · 三分之二通过';
      el.kickOk.textContent = mine ? '撤回申请' : '同意踢出';
    } else {
      el.kickSub.textContent = '申请后要三分之二的人同意才会踢出';
      el.kickOk.textContent = '申请踢出';
    }
    /* 红＝这一下就把人送走；发起申请 / 撤回都还是普通主按钮 */
    var danger = isHost || (k && !mine && k.yes.length + 1 >= k.need);
    if (el.kickOk.classList) el.kickOk.classList.toggle('danger', !!danger);
  }
  function openKick(pid) {
    var st = S.st;
    if (!st || !pid) return;
    if (pid === S.you) { tip('这是你自己'); return; }
    if (!playerById(st, pid)) return;
    S.kickPid = pid;
    if (el.kick) el.kick.hidden = false;
    renderKick();
  }
  function closeKick() {
    S.kickPid = '';
    if (el.kick) el.kick.hidden = true;
  }
  function kickOk() {
    if (!S.kickPid) return;
    var st = S.st;
    var host = hostOf(st);
    var isHost = !!host && host.id === S.you;
    var k = kickNow(st);
    var mine = !!(k && k.yes.indexOf(S.you) >= 0);
    var pid = S.kickPid;
    closeKick();
    if (!isHost && mine) { send({ t: 'unvotekick' }); return; }
    buzz(16);
    send({ t: 'kick', pid: pid });
  }

  /* ---------------- 顶栏：上限 / 重开 ---------------- */

  function openCapDrop() {
    if (!S.st) return;
    var st = S.st, h = '', cur = st.cap / 2;
    var host = null;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].seat === 0) host = st.players[i];
    var isHost = !!host && host.id === S.you;
    if (st.pendingCap && st.pendingCap !== cur) {
      h += '<div class="drop-tip">下次开局生效：' + st.pendingCap + ' 杯（当前 ' + cur + ' 杯）</div>';
    }
    if (st.capVote) {
      var wi = idxOf(st, st.capVote.by);
      var wn = wi >= 0 ? st.players[wi].name : '有人';
      h += '<div class="drop-tip">' + wn + ' 提议 ' + st.capVote.val + ' 杯 · ' +
        st.capVote.yes.length + '/' + st.capVote.need + ' 同意</div>';
      h += st.capVote.mine
        ? '<button class="drop-item drop-wide" type="button" data-act="capno">撤回我的票</button>'
        : '<button class="drop-item drop-wide" type="button" data-act="capyes">同意 ' + st.capVote.val + ' 杯</button>';
    } else {
      h += '<div class="drop-tip">' + (isHost
        ? '房主直接改 · 下次开局生效'
        : '改封顶要 2/3 同意 · 下次开局生效') + '</div>';
    }
    for (var n = 1; n <= 12; n++) {
      h += '<button class="drop-item' + (n === cur ? ' on' : '') + '" type="button" data-n="' + n + '">' + n + '</button>';
    }
    el.drop.innerHTML = h;
    el.drop.hidden = false;
    el.shade.hidden = false;
  }
  function closeCapDrop() {
    el.drop.hidden = true;
    el.shade.hidden = true;
  }
  function doRestart() {
    if (!S.st || !S.st.started) { tip('还没开局'); return; }
    var v = S.st.vote;
    buzz(10);
    send(v && v.mine ? { t: 'unvote' } : { t: 'restart' });
  }
  /* 改名：页内面板，跟踢人一个壳子，不弹浏览器 prompt（用户 2026-11-19） */
  function openRename() {
    if (!el.rename) return;
    if (el.renameInput) {
      el.renameInput.value = myName();
      setTimeout(function () {
        try { el.renameInput.focus(); el.renameInput.select(); } catch (e) {}
      }, 60);
    }
    el.rename.hidden = false;
  }
  function closeRename() { if (el.rename) el.rename.hidden = true; }
  function renameOk() {
    if (!el.renameInput) return;
    var v = (el.renameInput.value || '').trim().slice(0, 8);
    if (!v) { tip('名字不能空'); return; }
    if (v === myName()) { closeRename(); return; }
    try { localStorage.setItem(NAME_KEY, v); } catch (e) {}
    closeRename();
    buzz(12);
    send({ t: 'rename', name: v });
  }

  /* ---------------- 建房 / 进房 ---------------- */

  function setCode(code) {
    S.code = String(code || '').replace(/\D/g, '').slice(0, 6);
    saveLast();
    paintGate();
  }
  function createRoom() {
    tip('开桌中…');
    fetch(apiBase() + '/api/new?game=789', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { tip(j.msg || '开桌失败'); return; }
        setCode(j.code);
        connect();
      })
      .catch(function () { tip('开桌失败 · 检查网络'); });
  }
  function joinRoom() {
    var code = (el.joinCode.value || '').replace(/\D/g, '').slice(0, 6);
    if (code.length < 4) { tip('房号是 4 位数字'); return; }
    tip('找房间里…');
    fetch(apiBase() + '/api/has?code=' + code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.room) { tip('没找到这个房间'); return; }
        if (j.room.game !== '789') { tip('这个房号不是七八九'); return; }
        setCode(code);
        connect();
      })
      .catch(function () { tip('进房失败 · 检查网络'); });
  }
  function copyCode() {
    if (!S.code) { tip('先开一桌或进房才有房号'); return; }
    var done = function () { tip('房号已复制：' + S.code); };
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(S.code).then(done).catch(done);
      else {
        var ta = document.createElement('textarea');
        ta.value = S.code;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
    } catch (e) { tip('房号 ' + S.code); }
  }

  /* ---------------- 入口 ---------------- */

  function enter() {
    S.alive = true;
    var last = lastCode();
    if (last) { setCode(last); connect(); }
    else { setScreen('gate'); paintGate(); }
  }
  function leave() {
    S.alive = false;
    closeSocket();
    closeCapDrop();
    closeKick();
    closeRename();
    closeG9Dbg();
    hideFlash();
  }
  function quit() {
    if (!S.code) return;
    send({ t: 'quit' });
  }

  function bind() {
    /* 第一次落到屏幕上的手势就解锁摇骰音频（iOS / 微信） */
    var once = function () { unlockShk(); };
    document.addEventListener('touchstart', once, true);
    document.addEventListener('mousedown', once, true);
    document.addEventListener('keydown', once, true);
    /* 横竖屏切换后把隐形热区重贴到提示行上方（它不占布局，只跟着 hint 走） */
    window.addEventListener('resize', layoutG9Hot);

    el.btns.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var a = b.getAttribute('data-act');
      /* 点了「继续摇 / 接手 / 不指了」就等于看过了，结果卡立刻收掉 */
      hideFlash();
      if (a === 'start') send({ t: 'start' });
      else if (a === 'roll') { playShake(); send({ t: 'groll' }); }
      else if (a === 'skip') send({ t: 'gskip' });
      else if (a === 'go') send({ t: 'ggo' });
      else if (a === 'restopen') {
        if (window.LDRest) window.LDRest.open({
          ok: function (k) { send({ t: k === 'rest' ? 'rest' : 'resume' }); }
        });
      }
      else if (a === 'resume') send({ t: 'resume' });
    });

    el.seats.addEventListener('click', function (e) {
      var s = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s) return;
      var i = Number(s.getAttribute('data-i'));
      var st = S.st;
      if (!st || !st.players[i]) return;
      /* 两个 1 指人优先：摇的人点谁就是罚谁。单击即生效，不能被双击逻辑吞掉 */
      if (st.phase === 'pick' && myIdx() === st.turn) { send({ t: 'gpick', i: i }); return; }
      var pid = st.players[i].id;
      var now = Date.now();
      var dbl = (now - S.lastTap <= 600) && (S.lastTapPid === pid);
      S.lastTap = now;
      S.lastTapPid = pid;
      if (!dbl) {
        tip(pid === S.you ? '再点一次改名' : '再点一次请人出去');
        return;
      }
      S.lastTap = 0;
      S.lastTapPid = '';
      if (pid === S.you) openRename();
      else openKick(pid);
    });

    if (el.kickOk) el.kickOk.addEventListener('click', kickOk);
    if (el.kickNo) el.kickNo.addEventListener('click', closeKick);
    if (el.kick) el.kick.addEventListener('click', function (e) {
      if (e.target === el.kick) closeKick();
    });

    if (el.dbg) el.dbg.addEventListener('click', function (e) {
      /* chip 优先：点在绑定行里就改那一格的绑定，不改总闸、不 arm */
      var chip = e.target.closest ? e.target.closest('.g9chip[data-a]') : null;
      if (chip && g9Arm()) {
        var box = chip.parentNode;
        setG9Bind(Number(box.getAttribute('data-cfg')), chip.getAttribute('data-a'));
        return;
      }
      var row = e.target.closest ? e.target.closest('.dbg-row[data-k]') : null;
      if (row && g9Arm()) {
        if (row.getAttribute('data-k') === 'hot') setG9Hot();
        return;
      }
      if (e.target === el.dbg) closeG9Dbg();
    });
    if (el.dbgX) el.dbgX.addEventListener('click', closeG9Dbg);
    if (el.hot) el.hot.addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('i[data-k]') : null;
      if (cell) armG9(Number(cell.getAttribute('data-k')) - 1);
    });
    if (el.renameOk) el.renameOk.addEventListener('click', renameOk);
    if (el.renameNo) el.renameNo.addEventListener('click', closeRename);
    if (el.rename) el.rename.addEventListener('click', function (e) {
      if (e.target === el.rename) closeRename();
    });
    if (el.renameInput) el.renameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) renameOk();
      else if (e.key === 'Escape' || e.keyCode === 27) closeRename();
    });
    bindG9Title();

    if (el.capTop) el.capTop.addEventListener('click', function () {
      if (el.drop.hidden) openCapDrop(); else closeCapDrop();
    });
    if (el.redo) el.redo.addEventListener('click', doRestart);
    el.shade.addEventListener('click', closeCapDrop);
    el.drop.addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (act) {
        var a = act.getAttribute('data-act');
        closeCapDrop();
        buzz(10);
        if (a === 'capyes') {
          var v = S.st && S.st.capVote ? S.st.capVote.val : 6;
          send({ t: 'gcap', n: v });
        } else if (a === 'capno') send({ t: 'uncap' });
        return;
      }
      var b = e.target.closest ? e.target.closest('[data-n]') : null;
      if (!b) return;
      var n = Number(b.getAttribute('data-n'));
      closeCapDrop();
      buzz(10);
      send({ t: 'gcap', n: n });
    });

    if (el.codeTop) el.codeTop.addEventListener('click', copyCode);
    el.create.addEventListener('click', createRoom);
    el.join.addEventListener('click', joinRoom);
    el.resume.addEventListener('click', function () {
      var last = lastCode();
      if (last) { setCode(last); connect(); }
    });
    el.joinCode.addEventListener('input', function () {
      var v = el.joinCode.value.replace(/\D/g, '').slice(0, 6);
      if (v !== el.joinCode.value) el.joinCode.value = v;
      tip('');
    });
    el.joinCode.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) joinRoom(); });

    var back = function () {
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
      else if (window.location) window.location.hash = '#netmodes';
    };
    el.back.addEventListener('click', back);
    if (el.back2) el.back2.addEventListener('click', back);
  }

  function boot() {
    el = {
      gate: $('gnGate'), table: $('gnTable'),
      tip: $('gnTip'), whoName: $('gnWhoName'),
      resume: $('gnResume'), resumeCode: $('gnResumeCode'),
      create: $('gnCreate'), join: $('gnJoin'), joinCode: $('gnJoinCode'),
      codeTop: $('gnCode'), redo: $('gnRedo'), capTop: $('gnCapTop'),
      drop: $('gnDrop'), shade: $('gnShade'),
      title: $('gnTitle'), dbg: $('gnDbg'), dbgX: $('gnDbgX'), dbgSub: $('gnDbgSub'), hot: $('gnHot'),
      rename: $('gnRename'), renameInput: $('gnRenameInput'),
      renameOk: $('gnRenameOk'), renameNo: $('gnRenameNo'),
      who: $('gnWho'), round: $('gnRound'), dir: $('gnDir'),
      ring: $('gnRing'), core: $('gnCore'), pot: $('gnPot'), capDesk: $('gnCapDesk'),
      dice: $('gnDice'), tag: $('gnTag'), seats: $('gnSeats'),
      lobby: $('gnLobby'), lobbyCode: $('gnLobbyCode'),
      hint: $('gnHint'), btns: $('gnBtns'),
      flash: $('gnFlash'), flashN: $('gnFlashN'), flashK: $('gnFlashK'), flashS: $('gnFlashS'),
      kick: $('gnKick'), kickName: $('gnKickName'), kickSub: $('gnKickSub'),
      kickOk: $('gnKickOk'), kickNo: $('gnKickNo'),
      back: $('gnBack'), back2: $('gnBack2')
    };
    if (!el.gate) return;      // 页面上没有这一页，不启动
    S.api = apiBase();
    loadG9Dbg();
    bind();
    setScreen('gate');
    paintGate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.LD789Net = { enter: enter, leave: leave, quit: quit };
})();

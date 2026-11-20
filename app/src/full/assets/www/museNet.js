/* 木塞 · 联机版客户端（每人一台手机）。
   发牌、补牌、判定、罚杯全在服务器算 —— 客户端只发动作、只渲染广播回来的 state。
   手牌私密：服务器只把「自己那两张/三张」下发给本人，别人的只给张数（背面）。
   UI 跟另外四家联机对齐：进门 home/solo-body/fn-box，顶栏常驻房号，
   没有独立菜单层 —— 改名/踢人双击座位，重开与摊牌后下一局共用一张 2/3 票，
   退出走全站 quitMask。 */
(function () {
  'use strict';

  var DEFAULT_API = 'https://dice.2582580.xyz';
  var NAME_KEY = 'ld_net_name';          // 跟另外四家共用昵称
  var SEAT_KEY = 'ld_muse_seat_';        // 木塞自己的席位凭据（按房号存）
  var LAST_KEY = 'ld_muse_last';
  var MODE_KEY = 'ld_muse_mode';          // 上次挑的玩法，下次开桌记住

  var S = {
    api: DEFAULT_API, code: '', ws: null, you: null, token: null, st: null,
    mode: 'bank',                         // bank=轮流坐庄（默认）/ fish=木塞鱼大吃小
    alive: false, retry: 0, retryTimer: 0, pingTimer: 0,
    lastTap: 0, lastTapPid: '', kickPid: '',
    /* 发牌先盖牌背，玩家自己逐张翻开（纯前端表现，服务端仍权威下发真牌）。
       按 round 重置：换一把就重新盖上，摊牌时摊牌桌照常全公开。 */
    flipRound: -1, flipProg: [], flipDir: []
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
  function saveLast() { try { localStorage.setItem(LAST_KEY, S.code); } catch (e) {} }
  function lastCode() { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } }
  function clearLast() { try { localStorage.removeItem(LAST_KEY); } catch (e) {} }

  function idxOf(st, id) {
    if (!st || !id) return -1;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === id) return i;
    return -1;
  }
  function myIdx() { return idxOf(S.st, S.you); }
  function playerById(st, id) { return st ? st.players[idxOf(st, id)] : null; }
  function hostOf(st) {
    if (!st) return null;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].seat === 0) return st.players[i];
    return null;
  }
  function kickNow(st) { return st && st.kick ? st.kick : null; }

  function buzz(pat) { try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {} }
  function cue(n) { try { if (window.LDSnd) window.LDSnd.cue(n); } catch (e) {} }

  var tipTimer = 0;
  function tip(msg) {
    if (!el.tip) return;
    el.tip.textContent = msg || '';
    if (el.tip.classList && el.tip.classList.toggle) el.tip.classList.toggle('show', !!msg);
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      if (el.tip) { el.tip.textContent = ''; if (el.tip.classList) el.tip.classList.remove('show'); }
    }, 2600);
  }

  /* ---------------- 牌面 ---------------- */

  var RANK_TXT = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  function rankTxt(r) { return RANK_TXT[r] || String(r); }
  /* s=0/1 红桃方块=红，s=2/3 梅花黑桃=黑；BJ 红、SJ 黑、W 无色 */
  function cardFace(c) {
    if (!c) return null;
    if (c.r === 0) {
      if (c.s === 'BJ') return { rank: '大', suit: 'JOKER', cls: 'joker red', kind: '大王' };
      if (c.s === 'SJ') return { rank: '小', suit: 'JOKER', cls: 'joker black', kind: '小王' };
      return { rank: '白', suit: 'JOKER', cls: 'joker black', kind: '白牌' };
    }
    var red = (c.s === 0 || c.s === 1);
    var suits = ['♥', '♦', '♣', '♠'];   /* s:0红桃 1方块 2梅花 3黑桃，跟 muse.js / 服务端同口径 */
    return {
      rank: rankTxt(c.r),
      suit: suits[c.s] || '',
      cls: red ? 'red' : 'black',
      kind: (red ? '红' : '黑') + rankTxt(c.r)
    };
  }
  var KIND_TXT = {
    tripleJoker: '三鬼', doubleJoker: '双鬼', joker5: '鬼鬼X', tiangong: '天公',
    straightFlush: '同花顺', threeKind: '三条', straight: '顺子',
    muse: '木塞', normal: '普通牌'
  };
  /* 鬼鬼X 要显示成具体点数（鬼鬼9 / 鬼鬼5）：从手牌里找那张非鬼牌取面值。
     注意不能用 res.unit——含鬼时 unit 一律算 9，显示不出真实牌面。 */
  function kindTxt(k, hand) {
    if (k === 'joker5') {
      var x = '';
      if (hand) for (var i = 0; i < hand.length; i++) {
        if (hand[i].r !== 0) { x = rankTxt(hand[i].r); break; }
      }
      return '鬼鬼' + (x || 'X');
    }
    return KIND_TXT[k] || '普通牌';
  }
  /* 摊牌显示用的「同花」标签：三张普通牌同花色。只是标注，不改牌型判定与倍率 */
  function flushLabel(hand) {
    if (!hand || hand.length !== 3 || typeof hand[0].s !== 'number') return '';
    var s = hand[0].s;
    for (var i = 1; i < hand.length; i++) if (hand[i].s !== s) return '';
    return '同花';
  }
  /* ---------------- 毫升结算 / 已喝抵扣（v1.24.72）----------------
     服务端 cups 和 row.net 都是「倍」，1 倍 = baseMl 毫升，累计够 cupMl 折 1 杯。
     每人记自己的已喝 drunkMl：只有自己净欠（cups<0）才拿来抵，净赢方的应收不动
     —— 对方把酒喝掉就等于还了。换底注只影响换算口径，不改服务端账。 */
  function baseMl(st) { return (st && st.baseMl > 0) ? st.baseMl : 15; }
  function cupMl(st) { return (st && st.cupMl > 0) ? st.cupMl : 50; }
  function num1(n) { return Math.round(n * 10) / 10; }
  function mlCup(ml, st) { return Math.round(ml) + 'ml ≈ ' + num1(ml / cupMl(st)) + '杯'; }
  /* 净欠毫升 = |cups| × 底注；已喝只抵这块，抵完为 0（已结清） */
  function debtMl(p, st) {
    var owed = -(p.cups | 0) * baseMl(st);
    return owed > 0 ? Math.max(0, owed - (p.drunkMl | 0)) : 0;
  }
  /* 牌背「跟手指方向掀开」：裁切线垂直于本次滑动方向，从手指起点那一侧推进，
     滑到哪停到哪。dir=(dx,dy) 是本次滑动的单位向量（屏幕坐标 y 向下）；
     没记方向时（比如刚发牌）给默认左下→右上。prog 0~1，摊牌桌不传 prog → 全公开。 */
  var CARD_W = 19, CARD_H = 27;   // 跟 .mu-flip 的 19vw×27vw 同比例，保证裁切线真垂直手指
  var DEF_DIR = { x: 1 / Math.SQRT2, y: -1 / Math.SQRT2 };
  function backClip(t, dir) {
    if (!(t > 0)) return 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
    if (t >= 1) return 'polygon(0% 0%, 0% 0%, 0% 0%, 0% 0%)';
    var d = dir || DEF_DIR;
    var dl = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
    var ux = d.x / dl, uy = d.y / dl;
    /* 矩形四角在滑动方向上的投影，取 max/min 得到推进区间 */
    var corners = [[0, 0], [CARD_W, 0], [CARD_W, CARD_H], [0, CARD_H]];
    var lo = Infinity, hi = -Infinity, proj = [];
    for (var i = 0; i < 4; i++) {
      var s = corners[i][0] * ux + corners[i][1] * uy;
      proj.push(s);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    /* 保留「投影较大」的那一端：t=0 保留全部（cut=lo），t=1 全掀掉（cut=hi）。
       手指从投影小的一端滑向大的一端，所以先掀掉的正是手指起点那一侧。 */
    var cut = lo + (hi - lo) * t;
    var pts = [];
    for (var k = 0; k < 4; k++) {
      var a = corners[k], b = corners[(k + 1) % 4];
      var sa = proj[k], sb = proj[(k + 1) % 4];
      if (sa >= cut) pts.push(a);
      if ((sa >= cut) !== (sb >= cut)) {
        var u = (cut - sa) / (sb - sa);
        pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      }
    }
    if (!pts.length) return 'polygon(0% 0%, 0% 0%, 0% 0%, 0% 0%)';
    return 'polygon(' + pts.map(function (p) {
      return (p[0] / CARD_W * 100).toFixed(2) + '% ' + (p[1] / CARD_H * 100).toFixed(2) + '%';
    }).join(',') + ')';
  }
  function handHtml(hand, prog, dirs) {
    var h = '';
    for (var i = 0; i < hand.length; i++) {
      var f = cardFace(hand[i]);
      if (!f) continue;
      var t = prog ? (typeof prog[i] === 'number' ? prog[i] : 0) : 1;
      /* 两角都写点数（右下角 CSS 旋转 180°），中间一个放大的花色 */
      var corner = '<span class="corner tl"><b>' + f.rank + '</b><i>' + f.suit + '</i></span>' +
                   '<span class="corner br"><b>' + f.rank + '</b><i>' + f.suit + '</i></span>';
      var mid = (f.suit === 'JOKER') ? '★' : f.suit;
      var face = '<div class="mu-card ' + f.cls + '">' + corner +
                 '<span class="mid-suit">' + mid + '</span></div>';
      if (t >= 1) { h += face; continue; }
      var dir = dirs && dirs[i];
      var back = '<div class="mu-card is-back" style="clip-path:' + backClip(t, dir) + '">' +
                 '<span class="back-mark">?</span><span class="back-tip">滑开看牌</span></div>';
      h += '<div class="mu-flip" data-i="' + i + '">' + face + back + '</div>';
    }
    return h;
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
      return;
    }
    if (m.t === 'quitok') {
      clearLast();
      S.st = null; S.code = '';
      closeSocket();
      setScreen('gate'); paintGate();
      return;
    }
    if (m.t === 'kicked') {
      closeKick();
      try { localStorage.removeItem(SEAT_KEY + S.code); } catch (e) {}
      clearLast();
      S.st = null; S.code = '';
      closeSocket();
      setScreen('gate'); paintGate();
      tip(m.msg || '你被请出了这一桌');
      return;
    }
    if (m.t === 'err') { tip(m.msg || '这一步不行'); return; }
    if (m.t === 'state') {
      if (m.s.game && m.s.game !== 'muse') { tip('这个房号不是木塞'); return; }
      var prevPhase = S.st ? S.st.phase : '';
      S.st = m.s;
      setScreen('table');
      render();
      /* 摊牌那一下震一下 + 提示音 */
      if (m.s.phase === 'reveal' && prevPhase !== 'reveal') { buzz([20, 60, 20]); cue('drink'); }
      renderKick();
      return;
    }
  }

  /* ---------------- 屏幕 ---------------- */

  function setScreen(which) {
    el.gate.hidden = (which !== 'gate');
    el.table.hidden = (which !== 'table');
  }
  function paintGate() {
    if (el.whoName) el.whoName.textContent = myName();
    if (el.modes) {
      var bs = el.modes.querySelectorAll('.mu-mode');
      for (var i = 0; i < bs.length; i++) {
        bs[i].classList.toggle('is-on', bs[i].getAttribute('data-mode') === S.mode);
      }
    }
    if (el.modeTip) {
      el.modeTip.textContent = S.mode === 'fish'
        ? '木塞鱼：所有玩家两两比大小、大吃小，点数最小的会被每个人吃一遍。'
        : '庄家吃所有玩家，玩家只对庄家；庄家净赢就继续坐庄，没赢换下一位。';
    }
    if (!el.resume) return;
    var last = lastCode();
    el.resume.hidden = !(last && last !== S.code);
    if (el.resumeCode) el.resumeCode.textContent = last || '----';
  }

  /* ---------------- 渲染牌桌 ---------------- */

  function buildSeats(n) {
    el.seats.innerHTML = '';
    seatEls = [];
    for (var i = 0; i < n; i++) {
      var s = document.createElement('div');
      s.className = 'mu-seat';
      s.setAttribute('data-i', String(i));
      s.innerHTML = '<span class="seq"></span><span class="nm"></span><span class="st"></span><span class="cup"></span><span class="banker"></span>';
      el.seats.appendChild(s);
      seatEls.push({
        root: s,
        seq: s.querySelector('.seq'),
        nm: s.querySelector('.nm'),
        st: s.querySelector('.st'),
        cup: s.querySelector('.cup'),
        banker: s.querySelector('.banker')
      });
    }
  }

  function render() {
    var st = S.st;
    if (!st) return;
    /* 换一把（round 变了）就重新盖上牌背；同一把里只按玩家自己翻开的进度显示 */
    if (st.round !== S.flipRound) {
      S.flipRound = st.round; S.flipProg = []; S.flipDir = [];
    }
    if (seatEls.length !== st.players.length) buildSeats(st.players.length);

    if (el.codeTop) el.codeTop.textContent = S.code || '----';
    if (el.modeTag) {
      el.modeTag.textContent = st.mode === 'fish' ? '木塞鱼 · 大吃小' : '木塞 · 轮流坐庄';
      el.modeTag.classList.toggle('is-fish', st.mode === 'fish');
    }
    if (el.round) el.round.textContent = '第 ' + (st.round || 1) + ' 局';
    if (el.left) el.left.textContent = (st.left != null ? st.left : '—') + ' 张';

    /* 座位 */
    for (var i = 0; i < st.players.length; i++) {
      var p = st.players[i], e = seatEls[i];
      if (!e) continue;
      /* 座位角标 = 本局补牌顺序（服务端 st.order 下发）：从上一把赢最多者起循环；
         坐庄模式庄家挪到最后补牌，所以庄家角标总是最大号 */
      var ord = st.order ? (st.order.indexOf(p.seat) + 1) : (i + 1);
      if (e.seq) e.seq.textContent = ord ? String(ord) : '';
      e.nm.textContent = p.name || (i + 1) + ' 号';
      var isMe = p.id === st.you;
      e.root.classList.toggle('is-me', isMe);
      e.root.classList.toggle('is-turn', st.phase === 'play' && p.seat === st.turn);
      var tag = '';
      if (!p.online) tag = '离线';
      else if (st.phase === 'play') tag = p.done ? '定了' : (p.seat === st.turn ? '补牌中' : '看牌中');
      else if (st.phase === 'reveal') tag = p.res ? kindTxt(p.res.kind) : '';
      e.st.textContent = tag;
      /* cups 是累计净额（单位「倍」，摊牌后才落账）。1 倍 = baseMl 毫升；
         净欠方按已喝抵扣后显示「待喝」，净赢方照实显示净赢不扣。 */
      var cups = p.cups | 0;
      e.cup.classList.remove('is-gain', 'is-loss');
      if (cups > 0) {
        var gm = cups * baseMl(st);
        e.cup.innerHTML = '<b>净赢 ' + gm + 'ml</b><small>×' + cups + ' · ≈' +
          num1(gm / cupMl(st)) + '杯</small>';
        e.cup.classList.add('is-gain');
      } else if (cups < 0) {
        var d = p.drunkMl | 0, wait = debtMl(p, st);
        e.cup.innerHTML = '<b>待喝 ' + wait + 'ml</b><small>×' + (-cups) + ' · ≈' +
          num1(wait / cupMl(st)) + '杯' + (d > 0 ? ' · 已抵' + d + 'ml' : '') + '</small>';
        e.cup.classList.add('is-loss');
      } else if (p.drunkMl > 0) {
        e.cup.innerHTML = '<b>已喝 ' + p.drunkMl + 'ml</b>';
      } else {
        e.cup.textContent = '';
      }
      if (e.banker) {
        var isBank = st.mode !== 'fish' && st.banker === i;
        e.banker.textContent = isBank ? '庄' : '';
        e.root.classList.toggle('is-banker', isBank);
      }
    }

    /* 摊牌时把中间手牌区换成「摊牌桌」：每个人的牌摊开、按净赢排序 */
    var opened = st.phase === 'reveal';
    if (el.stage) el.stage.hidden = opened;
    if (el.board) { el.board.hidden = !opened; if (opened) renderBoard(st); }

    /* 我的手牌：play 阶段只显式给本人；reveal 阶段所有人都公开在摊牌桌上 */
    var me = st.players[myIdx()];
    var myHand = me ? me.hand : null;
    if (el.hand) el.hand.innerHTML = myHand && myHand.length ? handHtml(myHand, S.flipProg, S.flipDir) : '';
    if (el.veil) {
      var showVeil = st.phase === 'play' && (!myHand || !myHand.length);
      el.veil.hidden = !showVeil;
      if (el.veilT) el.veilT.textContent = !st.started ? '等开局' : '发牌中…';
    }

    /* 牌型提示 */
    if (el.kind) {
      if (opened && me && me.res) {
        el.kind.innerHTML = '点数 ' + (me.res.unit === undefined ? '-' : me.res.unit) +
          ' · ' + kindTxt(me.res.kind, me.hand) +
          (me.res.mult > 1 ? ' · <span class="mult">×' + me.res.mult + '</span>' : '');
      } else {
        el.kind.textContent = '';
      }
    }

    /* 顶栏「轮到谁」 */
    if (el.turn) {
      if (!st.started) el.turn.textContent = '等开局';
      else if (st.phase === 'play') {
        var t = st.players[st.turn];
        el.turn.textContent = '轮到 ' + (t ? (t.name || (st.turn + 1) + ' 号') : '?');
      } else if (st.phase === 'reveal') el.turn.textContent = '已摊牌';
      else el.turn.textContent = '';
    }

    /* 提示行 + 按钮 */
    renderHint(st);
    renderButtons(st);
    renderMlPanel(st);
  }

  /* ---------------- 毫升设置 / 已喝抵扣面板（v1.24.72）----------------
     房主改底注+转杯全桌同步；已喝是每人自己的账，只显示不替别人记。 */
  var BASE_OPTS = [5, 10, 15, 20, 25, 30];
  var CUP_OPTS = [50, 60, 80, 100];
  function optHtml(list, on) {
    var h = '';
    for (var i = 0; i < list.length; i++) {
      h += '<button type="button" class="mn-set-opt' + (list[i] === on ? ' is-on' : '') +
           '" data-ml="' + list[i] + '">' + list[i] + '</button>';
    }
    return h;
  }
  function renderMlPanel(st) {
    if (!el.setPanel || el.setPanel.hidden) return;
    var isHost = !!(hostOf(st) && hostOf(st).id === S.you);
    if (el.setHostRow) el.setHostRow.hidden = !isHost;
    if (el.setHostRow2) el.setHostRow2.hidden = !isHost;
    if (el.baseOpts) el.baseOpts.innerHTML = optHtml(BASE_OPTS, baseMl(st));
    if (el.cupOpts) el.cupOpts.innerHTML = optHtml(CUP_OPTS, cupMl(st));
    if (el.drinkList) {
      var rows = '';
      for (var i = 0; i < st.players.length; i++) {
        var p = st.players[i], d = p.drunkMl | 0;
        var c = p.cups | 0;
        var owed = c < 0 ? (-c * baseMl(st)) : 0;
        var wait = owed > 0 ? Math.max(0, owed - d) : 0;
        rows += '<div class="mn-set-p' + (p.id === S.you ? ' is-me' : '') + '">' +
          '<span class="mn-set-pn">' + (p.name || (i + 1) + ' 号') + '</span>' +
          '<span class="mn-set-pd">已喝 ' + d + 'ml</span>' +
          '<span class="mn-set-pw">' + (c > 0 ? ('净赢 ×' + c) :
            (owed > 0 ? ('待喝 ' + wait + 'ml · ×' + (-c)) : '打平')) + '</span>' +
          '</div>';
      }
      el.drinkList.innerHTML = rows || '<div class="mn-set-empty">坐下后这里列出每人已喝 / 待喝</div>';
    }
  }
  function openMl() {
    if (!S.st) { tip('先开一桌或进房'); return; }
    if (!el.setPanel) return;
    el.setPanel.hidden = false;
    if (el.drinkMl) el.drinkMl.value = '';
    renderMlPanel(S.st);
  }
  function closeMl() { if (el.setPanel) el.setPanel.hidden = true; }
  function setBase(ml) {
    if (!S.st) return;
    if (!(hostOf(S.st) && hostOf(S.st).id === S.you)) { tip('只有房主能改底注'); return; }
    buzz(10);
    send({ t: 'msetml', baseMl: Number(ml), cupMl: cupMl(S.st) });
  }
  function setCup(ml) {
    if (!S.st) return;
    if (!(hostOf(S.st) && hostOf(S.st).id === S.you)) { tip('只有房主能改转杯'); return; }
    buzz(10);
    send({ t: 'msetml', baseMl: baseMl(S.st), cupMl: Number(ml) });
  }
  function drinkOk() {
    if (!el.drinkMl) return;
    var v = parseInt(el.drinkMl.value, 10);
    if (!v || v < 1 || v > 10000) { tip('填 1~10000 毫升'); return; }
    buzz(10);
    if (send({ t: 'mdrink', ml: v })) el.drinkMl.value = '';
  }

  function renderHint(st) {
    var h = '';
    if (!st.started) {
      h = st.players.length < 2 ? '再多来一位就能开局' : '人齐了 · 点「开局」';
    } else if (st.phase === 'play') {
      var me = st.players[myIdx()];
      if (me && me.seat === st.turn && !me.done) h = '轮到你 · 补一张搏大的，或不补保牌型';
      else if (me && me.done) h = '你定了 · 等其他人';
      else h = '等 ' + ((st.players[st.turn] || {}).name || '别人') + ' 定牌';
    } else if (st.phase === 'reveal') {
      var v = st.vote;
      if (v && st.result) {
        h = '下一局 ' + v.yes.length + '/' + v.need + ' 票' + (v.mine ? ' · 已同意（再点撤回）' : ' · 点头就洗牌');
      } else if (st.result) {
        h = '点「下一局」开新的一把';
      }
    }
    if (el.hint) {
      el.hint.textContent = h;
      if (el.hint.classList) el.hint.classList.toggle('is-vote', !!(st.phase === 'reveal' && st.vote));
    }
  }

  function renderButtons(st) {
    var h = '';
    if (!st.started) {
      if (st.players.length >= 2) {
        h = '<button class="btn primary" type="button" data-act="start">开局</button>';
      }
    } else if (st.phase === 'play') {
      var me = st.players[myIdx()];
      if (me && me.seat === st.turn && !me.done && me.n < 3) {
        h = '<button class="btn primary" type="button" data-act="take">补一张</button>' +
            '<button class="btn ghost" type="button" data-act="stay">不补</button>';
      } else {
        h = '<button class="btn ghost" type="button" disabled>等别人定牌</button>';
      }
    } else if (st.phase === 'reveal') {
      var v = st.vote;
      h = '<button class="btn ' + (v && v.mine ? 'ghost' : 'primary') + '" type="button" data-act="next">' +
          (v && v.mine ? '撤回下一局票' : '下一局') + '</button>';
    }
    if (el.btns) el.btns.innerHTML = h;
  }

  /* 摊牌桌：两种玩法共用一张桌，但口径不同——
     bank=木塞坐庄：庄家吃所有玩家、玩家只对庄家；净赢续庄，没赢换下一位。
     fish=木塞鱼：所有玩家大吃小、净额抵消、无庄。
     每个人的牌全部摊开，按本局净额从大到小排，净赢金标、净输红标，收/付写清楚。 */
  function renderBoard(st) {
    if (!el.board) return;
    if (!st.result) { el.board.innerHTML = ''; return; }
    var res = st.result;
    var isBank = (res.mode || st.mode) === 'bank';
    var rows = res.rows || st.players.map(function (p) {
      return { seat: p.seat, id: p.id, name: p.name, kind: p.res && p.res.kind,
        unit: p.res && p.res.unit, mult: p.res && p.res.mult,
        gain: 0, lose: 0, net: p.res && p.res.pay,
        isBanker: st.mode === 'bank' && st.banker === p.seat };
    });
    rows = rows.slice().sort(function (a, b) { return (b.net || 0) - (a.net || 0); });
    var h = '<div class="bd-grid">' +
      '<div class="bd-title">摊牌结果 · ' +
      (isBank ? '木塞（轮流坐庄）' : '木塞鱼（大吃小）') + '</div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], player = st.players[r.seat] || {};
      var net = r.net || 0, isMe = r.id === st.you;
      /* 本局净额本身就是「倍」，先把未换算的 ×N 写出来，再给毫升+杯，免得只对毫升搞混 */
      var netX = Math.abs(net);
      var netMl = netX * baseMl(st);
      var badge = net > 0 ? ('净赢 ×' + netX + ' · ' + mlCup(netMl, st))
                    : (net < 0 ? ('净输 ×' + netX + ' · ' + mlCup(netMl, st)) : '打平');
      var cls = net > 0 ? 'is-gain' : (net < 0 ? 'is-loss' : 'is-even');
      var mark = isBank && r.isBanker ? '<span class="bd-banker">庄</span>' : '';
      /* 点数 / 牌型 / 倍率紧跟在牌后面做高亮标签，一桌人一眼扫到（用户 2026-11-20 要求） */
      var kindHtml = '<span class="bd-kind">' +
        '<b class="bd-pt">' + (r.unit === undefined ? '-' : ('点数 ' + r.unit)) + '</b>' +
        '<em class="bd-kd">' + (r.kind ? kindTxt(r.kind, player.hand) : '普通牌') +
          (r.mult > 1 ? ' ×' + r.mult : '') + '</em>' +
        (flushLabel(player.hand) ? '<i class="bd-flush">同花</i>' : '') +
        '</span>';
      h += '<div class="bd-row ' + cls + (isMe ? ' is-me' : '') +
             (isBank && r.isBanker ? ' is-banker' : '') + '">' +
             '<div class="bd-head">' +
               '<span class="bd-name">' + (r.name || (r.seat + 1) + ' 号') + mark + '</span>' +
               '<span class="bd-badge">' + badge + '</span>' +
             '</div>' +
             '<div class="bd-cards">' + (player.hand && player.hand.length ? handHtml(player.hand) : '') +
               kindHtml + '</div>' +
             '<div class="bd-foot">' +
               '<span class="bd-flow">收 ×' + (r.gain || 0) + ' ' +
                 Math.round((r.gain || 0) * baseMl(st)) + 'ml · 付 ×' + (r.lose || 0) + ' ' +
                 Math.round((r.lose || 0) * baseMl(st)) + 'ml</span>' +
             '</div>' +
           '</div>';
    }
    h += '<div class="bd-sum">本局流水 ' + mlCup((res.turnover || 0) * baseMl(st), st) +
      '<br>底注 ' + baseMl(st) + 'ml/倍 · 满 ' + cupMl(st) + 'ml 自动转一杯<br>' +
      (isBank ? '庄家吃全桌，玩家只对庄家 · ' +
        (res.keepBanker ? '净赢续庄' : '没赢换庄')
        : '大吃小，大家都是庄') + '</div></div>';
    el.board.innerHTML = h;
  }

  /* ---------------- 踢人 / 改名 ---------------- */

  function renderKick() {
    if (!el.kick || el.kick.hidden) return;
    var st = S.st;
    var p = playerById(st, S.kickPid);
    if (!p) { closeKick(); return; }
    var isHost = !!(hostOf(st) && hostOf(st).id === S.you);
    var k = kickNow(st);
    var mine = !!(k && k.yes.indexOf(S.you) >= 0);
    if (el.kickName) el.kickName.textContent = p.name + (p.online === false ? ' · 离线' : '');
    if (el.kickSub) {
      if (isHost) el.kickSub.textContent = p.online === false
        ? '离线有一会儿了 · 请出去，座位让给下一位' : '他还在线 · 确定要请出去？';
      else if (k) el.kickSub.textContent = '已有 ' + k.yes.length + '/' + k.need + ' 人同意 · 三分之二通过';
      else el.kickSub.textContent = '申请后要三分之二的人同意才会踢出';
    }
    if (el.kickOk) {
      el.kickOk.textContent = isHost ? '踢出房间' : (mine ? '撤回申请' : (k ? '同意踢出' : '申请踢出'));
      var danger = isHost || (k && !mine && k.yes.length + 1 >= k.need);
      if (el.kickOk.classList) el.kickOk.classList.toggle('danger', !!danger);
    }
  }
  function openKick(pid) {
    if (!S.st || !pid || pid === S.you) return;
    if (!playerById(S.st, pid)) return;
    S.kickPid = pid;
    if (el.kick) el.kick.hidden = false;
    renderKick();
  }
  function closeKick() { S.kickPid = ''; if (el.kick) el.kick.hidden = true; }
  function kickOk() {
    if (!S.kickPid) return;
    var st = S.st;
    var isHost = !!(hostOf(st) && hostOf(st).id === S.you);
    var k = kickNow(st);
    var mine = !!(k && k.yes.indexOf(S.you) >= 0);
    var pid = S.kickPid;
    closeKick();
    if (!isHost && mine) { send({ t: 'unvotekick' }); return; }
    buzz(16);
    send({ t: 'kick', pid: pid });
  }

  function openRename() {
    if (!el.rename) return;
    if (el.renameInput) {
      el.renameInput.value = myName();
      setTimeout(function () { try { el.renameInput.focus(); el.renameInput.select(); } catch (e) {} }, 60);
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
    fetch(apiBase() + '/api/new?game=muse&mode=' + S.mode, { cache: 'no-store' })
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
        if (j.room.game !== 'muse') { tip('这个房号不是木塞'); return; }
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
        ta.value = S.code; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    } catch (e) { tip('房号 ' + S.code); }
  }

  /* ---------------- 事件 ---------------- */

  function doNext() {
    var st = S.st;
    if (!st || !st.started) { tip('还没开局'); return; }
    var v = st.vote;
    buzz(10);
    send(v && v.mine ? { t: 'munvote' } : { t: 'mnext' });
  }

  function bind() {
    if (el.modes) el.modes.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-mode]') : null;
      if (!b) return;
      S.mode = b.getAttribute('data-mode') === 'fish' ? 'fish' : 'bank';
      try { localStorage.setItem(MODE_KEY, S.mode); } catch (err) {}
      paintGate();
    });
    if (el.create) el.create.addEventListener('click', createRoom);
    if (el.join) el.join.addEventListener('click', joinRoom);
    if (el.resume) el.resume.addEventListener('click', function () {
      var last = lastCode();
      if (last) { setCode(last); connect(); }
    });
    if (el.back) el.back.addEventListener('click', function () { window.history.back(); });
    if (el.back2) el.back2.addEventListener('click', function () { window.history.back(); });
    /* 手牌：从左下往右上滑动揭牌（沿对角线裁切牌背），轻点则直接翻开。
       纯本地表现，服务端仍按已下发的真牌结算。 */
    if (el.hand) el.hand.addEventListener('pointerdown', function (e) {
      var box = e.target && e.target.closest ? e.target.closest('.mu-flip') : null;
      if (!box) return;
      var back = box.querySelector('.mu-card.is-back');
      if (!back) return;
      e.preventDefault();
      var i = parseInt(box.getAttribute('data-i'), 10);
      if (isNaN(i)) return;
      var startProg = typeof S.flipProg[i] === 'number' ? S.flipProg[i] : 0;
      var x0 = e.clientX, y0 = e.clientY, moved = 0;
      var rect = box.getBoundingClientRect();
      var diag = Math.sqrt(rect.width * rect.width + rect.height * rect.height) || 1;
      var dir = S.flipDir[i] || DEF_DIR;
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
      function move(ev) {
        var dx = ev.clientX - x0, dy = ev.clientY - y0;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        var dist = Math.sqrt(dx * dx + dy * dy);
        /* 方向跟着本次实际滑动走：滑够一点才锁定，避免起点抖动让裁切线乱跳 */
        if (dist > 10) {
          dir = { x: dx / dist, y: dy / dist };
          S.flipDir[i] = dir;
        }
        var t = Math.max(0, Math.min(1, startProg + dist / diag));
        back.style.clipPath = backClip(t, dir);
        S.flipProg[i] = t;
      }
      function end() {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', end);
        box.removeEventListener('pointercancel', end);
        var t = typeof S.flipProg[i] === 'number' ? S.flipProg[i] : 0;
        if (moved < 12) t = 1;            // 轻点 = 直接翻开
        else if (t > 0.82) t = 1;         // 快滑到底就吸开
        else if (t < 0.06) t = 0;         // 几乎没动就盖回去
        S.flipProg[i] = t;
        render();
      }
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
    });
    if (el.codeTop) el.codeTop.addEventListener('click', copyCode);
    if (el.redo) el.redo.addEventListener('click', doNext);
    /* 毫升设置 / 已喝抵扣 */
    if (el.set) el.set.addEventListener('click', openMl);
    if (el.setClose) el.setClose.addEventListener('click', closeMl);
    if (el.setPanel) el.setPanel.addEventListener('click', function (e) {
      if (e.target === el.setPanel) closeMl();
    });
    if (el.baseOpts) el.baseOpts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ml]') : null;
      if (b) setBase(b.getAttribute('data-ml'));
    });
    if (el.cupOpts) el.cupOpts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-ml]') : null;
      if (b) setCup(b.getAttribute('data-ml'));
    });
    if (el.drinkOk) el.drinkOk.addEventListener('click', drinkOk);
    if (el.drinkMl) el.drinkMl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) drinkOk();
    });
    /* 音效按钮由 snd.js 给所有 .sound-btn 统一绑定，这里不再重复绑（否则点一下切两次） */

    if (el.btns) el.btns.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b || b.disabled) return;
      var a = b.getAttribute('data-act');
      buzz(10);
      if (a === 'start') send({ t: 'start' });
      else if (a === 'take') send({ t: 'mtake' });
      else if (a === 'stay') send({ t: 'mstay' });
      else if (a === 'next') doNext();
    });

    if (el.seats) el.seats.addEventListener('click', function (e) {
      var s = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s) return;
      var i = Number(s.getAttribute('data-i'));
      var st = S.st;
      if (!st || !st.players[i]) return;
      var pid = st.players[i].id;
      var now = Date.now();
      var dbl = (now - S.lastTap <= 600) && (S.lastTapPid === pid);
      S.lastTap = now; S.lastTapPid = pid;
      if (!dbl) { tip(pid === S.you ? '再点一次改名' : '再点一次请人出去'); return; }
      S.lastTap = 0; S.lastTapPid = '';
      if (pid === S.you) openRename(); else openKick(pid);
    });

    if (el.kickOk) el.kickOk.addEventListener('click', kickOk);
    if (el.kickNo) el.kickNo.addEventListener('click', closeKick);
    if (el.kick) el.kick.addEventListener('click', function (e) { if (e.target === el.kick) closeKick(); });
    if (el.renameOk) el.renameOk.addEventListener('click', renameOk);
    if (el.renameNo) el.renameNo.addEventListener('click', closeRename);
    if (el.rename) el.rename.addEventListener('click', function (e) { if (e.target === el.rename) closeRename(); });
    if (el.renameInput) el.renameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) renameOk();
      else if (e.key === 'Escape' || e.keyCode === 27) closeRename();
    });
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
    closeKick();
    closeRename();
    closeMl();
  }
  function quit() { if (S.code) send({ t: 'quit' }); }

  function boot() {
    el = {
      gate: $('mnGate'), table: $('mnTable'),
      tip: $('mnTip'), whoName: $('mnWhoName'),
      modes: $('mnModes'), modeTip: $('mnModeTip'), modeTag: $('mnModeTag'),
      resume: $('mnResume'), resumeCode: $('mnResumeCode'),
      create: $('mnCreate'), join: $('mnJoin'), joinCode: $('mnJoinCode'),
      back: $('mnBack'), back2: $('mnBack2'),
      sound: $('mnSound'), soundIc: $('mnSoundIc'),
      codeTop: $('mnCode'), redo: $('mnRedo'),
      set: $('mnSet'), setPanel: $('mnSetPanel'), setClose: $('mnSetClose'),
      setHostRow: $('mnSetHostRow'), setHostRow2: $('mnSetHostRow2'),
      baseOpts: $('mnBaseOpts'), cupOpts: $('mnCupOpts'),
      drinkMl: $('mnDrinkMl'), drinkOk: $('mnDrinkOk'), drinkList: $('mnDrinkList'),
      round: $('mnRound'), turn: $('mnTurn'), left: $('mnLeft'),
      seats: $('mnSeats'), hand: $('mnHand'),
      stage: $('mnStage'), board: $('mnBoard'),
      veil: $('mnVeil'), veilT: $('mnVeilT'),
      kind: $('mnKind'), hint: $('mnHint'), btns: $('mnBtns'), result: $('mnResult'),
      kick: $('mnKick'), kickName: $('mnKickName'), kickSub: $('mnKickSub'),
      kickOk: $('mnKickOk'), kickNo: $('mnKickNo'),
      rename: $('mnRename'), renameInput: $('mnRenameInput'),
      renameOk: $('mnRenameOk'), renameNo: $('mnRenameNo')
    };
    if (!el.gate) return;              // 页面上没有这一页，不启动
    try {
      var saved = localStorage.getItem(MODE_KEY);
      if (saved === 'fish' || saved === 'bank') S.mode = saved;
    } catch (err) {}
    S.api = apiBase();
    bind();
    setScreen('gate');
    paintGate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.LDMuseNet = { enter: enter, leave: leave, quit: quit,
    mode: function () { return S.mode; } };
})();

/* 摆桌上 · 公共屏（只读观众）

   一桌人各看各的手机，桌上没有共同焦点。这台设备摆桌子中间，把「几点」「该谁」
   「几杯」「谁临时走开了」「刚才发生了什么」摆出来，谁都抬眼就能看见；
   摇骰、看自己的牌这些私密动作还在各自手机上。

  跟 net.js / findnet.js 走同一条 WebSocket，唯一的区别是握手只发 {t:'watch'}：
    · 不发 hello → 服务端不会调 addPlayer，不占座位
    · 没有 pid → 服务端把它当观众，不进「在线人数」，也不算进重开 / 踢人投票的分母
    （这条是重点：看板要是混进分母，桌上 4 个人重开要 3 票就会变成要 4 票，
      而看板这一票根本点不出来，那桌人就永远重开不了。服务端那边有注释。）

  所以这个文件里**没有任何「发动作」的代码**：它只负责把 state 画大。 */
(function () {
  'use strict';

  var HOME_HOST = 'dice.2582580.xyz';
  var DEFAULT_API = 'https://dice.2582580.xyz';
  var PING_MS = 25000;

  var S = {
    code: '', api: '', ws: null, alive: false,
    retry: 0, tRetry: null, ping: null,
    st: null, game: '', lastName: '', lastPhase: '', lastTurnSig: '',
    wake: null, dropAt: 0, tWake: null,
    tick: null, tHelloA: null, tHelloB: null
  };

  var el = {};
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 环境 ---------------- */

  function apiBase() {
    if (window.LDNet && window.LDNet.api) {
      var a = window.LDNet.api();
      if (a) return String(a).replace(/\/+$/, '');
    }
    if (window.LD_NET_BASE) return String(window.LD_NET_BASE).replace(/\/+$/, '');
    if (location.hostname === HOME_HOST) return location.origin;
    return DEFAULT_API;
  }

  function tip(msg, ok) {
    if (!el.tip) return;
    el.tip.textContent = msg || '';
    el.tip.className = 'bd-tip' + (ok ? ' ok' : '');
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
    try { ws = new WebSocket(wsUrl()); }
    catch (e) { retryLater(); return; }
    S.ws = ws;

    ws.onopen = function () {
      if (S.ws !== ws) return;
      S.retry = 0;
      offMark(false);
      /* 只这一句。没有 name、没有 pid —— 服务端据此知道「这台是看板，不是来打牌的」 */
      try { ws.send(JSON.stringify({ t: 'watch' })); } catch (e) {}
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
      if (S.alive) { offMark(true); retryLater(); }
    };

    ws.onerror = function () {};
  }

  function closeSocket() {
    var ws = S.ws;
    S.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    stopPing();
  }

  function retryLater() {
    clearTimeout(S.tRetry);
    var wait = Math.min(8000, 700 * Math.pow(1.7, S.retry++));
    S.tRetry = setTimeout(connect, wait);
  }

  function startPing() {
    stopPing();
    S.ping = setInterval(function () {
      if (!S.ws) return;
      try { S.ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {}
    }, PING_MS);
  }

  function stopPing() {
    clearInterval(S.ping);
    S.ping = null;
  }

  function offMark(on) {
    if (el.off) el.off.hidden = !on;
  }

  function onMsg(m) {
    if (m.t === 'you') {
      if (m.code) S.code = m.code;
      /* 握手回话里就带着玩法：先把角标写对，别等第一份 state 回来才从 350 改成找朋友 */
      if (m.game) {
        S.game = m.game;
        if (el.game) el.game.textContent = gameName(m.game);
      }
      return;
    }
    /* 房间不存在 / 已经过期：说清楚，退回拿房号那一屏，别让人对着一块黑屏等 */
    if (m.t === 'err') {
      S.alive = false;
      closeSocket();
      offMark(false);
      hideStage();
      tip(m.msg || '连不上这一桌', false);
      return;
    }
    if (m.t === 'state' && m.s) {
      S.st = m.s;
      render();
    }
  }

  /* ---------------- 小工具 ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmtMs(ms) {
    var s = Math.max(0, Math.floor((ms | 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(ss) : pad2(m) + ':' + pad2(ss);
  }

  function hhmm(now) {
    var d = new Date(now);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* 骰子不另做一套：外壳是 `app.css` 里牌桌上那个 `.die`，点是 `.pip`
     （白胚、蓝点、一点和四点是红的、底下有一层侧面厚度）。
     大屏这边只负责两件事：多大（`--ds`）、摆在哪儿。
     一开始我图省事自己画了个「3×3 格子里点亮几格」的骰子 —— 颜色是米白配深灰，
     跟牌桌上的白胚蓝点完全不是一样东西，摆一桌看着像两个 App。 */
  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var CELL = [20, 50, 80];
  var RED = { 1: true, 4: true };       // 传统骰子：一点、四点是红点

  function dieEl(v, taken) {
    var slot = document.createElement('div');
    slot.className = 'bd-die' + (taken ? ' taken' : '');
    /* 留着 data-v：整页没有别的办法看出「这颗是几点」，测试和排查都要用 */
    slot.setAttribute('data-v', String(v));

    var box = document.createElement('div');
    /* `.die` 默认 opacity:0，靠 `.in` 的落地动画显出来（和牌桌同一个动画）。
       没摇的骰位用 `.blank` —— 那是 app 里「这儿待会儿有颗骰子」的样子。 */
    box.className = 'die in' + (v ? '' : ' blank');
    if (v) {
      var cells = PIPS[v] || [];
      for (var c = 0; c < cells.length; c++) {
        var p = document.createElement('div');
        p.className = 'pip' + (RED[v] ? ' red' : '');
        p.style.left = CELL[cells[c] % 3] + '%';
        p.style.top = CELL[Math.floor(cells[c] / 3)] + '%';
        box.appendChild(p);
      }
    }
    slot.appendChild(box);
    return slot;
  }

  function isFind(st) { return st && st.game === 'find'; }
  function isLiar(st) { return st && st.game === 'liar'; }
  function listOf(st) { return (isFind(st) || isLiar(st)) ? (st.seats || []) : (st.players || []); }

  /* 角标上那个玩法名。服务端给的标识是 find / liar，350 的 pub() 不带 game 字段 */
  function gameName(g) {
    return g === 'find' ? '找朋友' : (g === 'liar' ? '吹牛' : '350');
  }

  /* 名字是玩家自己敲的，要塞进 innerHTML 的那几处一律过一遍 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function nameById(st, id) {
    var L = listOf(st);
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i].name;
    return '那位';
  }

  /* 这个人最近一次干了什么：从最后十几条记录里倒着找他的名字。
     只在高卡上摆一行，字太长就截掉，不换行去挤名字和数字。 */
  function lastAct(log, name) {
    if (!name) return '';
    var a = (log || []).slice(-12);
    for (var i = a.length - 1; i >= 0; i--) {
      var t = a[i] && a[i].text ? String(a[i].text) : '';
      if (t.indexOf(name) >= 0) return t.length > 15 ? t.slice(0, 14) + '…' : t;
    }
    return '';
  }

  /* ---------------- 临时离开：三家同一个形状 ----------------

     mode  = 这一把已经生效的快照（rest / bomb / null）
     away  = 下一次洗牌才生效的意愿
     awayMs  = 服务端算到广播那一刻的离开时长，前端自己接着往下走秒
     awayLast = 点过「继续」之后结出来的总时长，摆成静态的「本次离开 mm:ss」

     三家里 350 / 找朋友只有 rest，吹牛多一个 bomb。大屏一律读同一组字段，
     不猜「他是不是还没轮到」—— 那个误会就是这块屏最该替桌上澄清的。 */
  function awayInfo(p, st) {
    var mode = p.mode || null;
    var wish = p.away || null;
    var rest = isLiar(st) ? (mode === 'rest') : !!p.rest;
    var bomb = isLiar(st) && mode === 'bomb';
    var tag = '', cls = '', active = false;

    if (rest) { tag = '休息中'; cls = 'rest'; active = true; }
    else if (bomb) { tag = '炸弹中'; cls = 'bomb'; active = true; }
    else if (wish === 'rest') { tag = '下把休息'; cls = 'wait'; active = true; }
    else if (wish === 'bomb') { tag = '下把炸弹'; cls = 'wait'; active = true; }
    else if (mode) { tag = '下把回来'; cls = 'wait'; active = true; }

    var clock = null, base = p.awayMs | 0, last = p.awayLast | 0;
    if (active) {
      /* 已经点了「继续」但这一把还没打完：mode 还在、wish 没了 ——
         这时候该报的是「这次一共离开多久」，不是重新从 0 秒走起。 */
      if (mode && !wish) clock = last ? { last: last } : null;
      else if (wish || base) clock = { base: base };
      else if (last) clock = { last: last };
    }
    return {
      tag: tag, cls: cls, active: active, rest: rest, bomb: bomb,
      wait: cls === 'wait', clock: clock, back: !!(mode && !wish)
    };
  }

  /* ---------------- 画 ---------------- */

  function render() {
    var st = S.st;
    if (!st) return;

    paintTop(st);
    if (isFind(st)) renderFind(st);
    else if (isLiar(st)) renderLiar(st);
    else render350(st);
    paintVote(st);
    paintTally(st);
    paintLog(st.log);
    measureGrid();
  }

  /* 顶栏：房号收成角标，整行改成状态条（第几局 / 进度 / 在玩与休息人数）。
     时钟和所有倒计时由 tick() 每秒走，不靠服务端一直推 state。 */
  function paintTop(st) {
    if (el.codeBig) el.codeBig.textContent = st.code || S.code || '----';
    if (el.game) el.game.textContent = gameName(st.game);
    if (el.stat) el.stat.innerHTML = statHtml(st);
  }

  function statHtml(st) {
    var L = listOf(st), a = st.away || {};
    var act = typeof a.active === 'number' ? a.active
      : L.filter(function (p) { return p.online !== false && !p.rest; }).length;
    var rest = a.rest | 0, bomb = a.bomb | 0, bits = [];

    /* 一行放不下所有信息：把「几人在玩 / 几人休息」排在前面，
       进度数压短放最后。真被 ellipsis 截掉时也先丢次要的那一截。
       大字区那句仍写完整版（「本手 200 分，还差 150 分锁分」）。 */
    if (isFind(st)) bits.push('第 <b>' + (st.round | 0) + '</b> 圈');
    else if (isLiar(st)) bits.push('第 <b>' + (st.round | 0) + '</b> 局');
    /* 350 的 round 是「这一手已经收下的分」，收够 350 之后还能接着摇，
       会涨到 600、700。写成 600/350 像是进度条爆了，只报分数就好。 */
    else bits.push('本手 <b>' + (st.round | 0) + '</b> 分');

    bits.push('<b>' + act + '</b> 人在玩');
    if (rest) bits.push(rest + ' 人休息');
    if (bomb) bits.push(bomb + ' 人炸弹');

    if (isFind(st)) {
      var shakes = st.shakes || 2, left = 0;
      for (var i = 0; i < L.length; i++) {
        if (!L[i].rest && L[i].online !== false && (L[i].used | 0) < shakes) left++;
      }
      if (st.started) bits.push('待摇 <b>' + left + '</b> 家');
    } else if (isLiar(st)) {
      var rd = st.roll || {};
      if (st.started && st.phase !== 'reveal') {
        bits.push('已摇 <b>' + (rd.done | 0) + '/' + (rd.all | 0) + '</b>');
      }
    }
    if (!st.started) bits.push('等人齐');
    return bits.join(' · ');
  }

  /* 重开 / 踢人投票：手机上浮卡在飘，桌上这块屏也得看得见。
     left 是服务端算的剩余毫秒，落地那一刻记一个本地时间戳，剩下自己走秒。 */
  function paintVote(st) {
    if (!el.vote) return;
    var items = [], v = st.vote, k = st.kick;
    if (v) items.push({
      cls: '', text: '重开一桌', yes: (v.yes || []).length,
      need: v.need | 0, left: v.left | 0
    });
    if (k) items.push({
      cls: ' kick', text: '请 ' + esc(nameById(st, k.target)) + ' 出去',
      yes: (k.yes || []).length, need: k.need | 0, left: k.left | 0
    });
    if (!items.length) { el.vote.hidden = true; el.vote.__sig = ''; return; }
    el.vote.hidden = false;
    var sig = items.map(function (x) { return x.cls + x.text + x.yes + '/' + x.need; }).join('|');
    if (el.vote.__sig === sig) return;
    el.vote.__sig = sig;
    el.vote.innerHTML = items.map(function (x) {
      return '<div class="bd-vote-i' + x.cls + '"><span>' + x.text + '</span>' +
        '<strong>' + x.yes + '/' + x.need + '</strong>' +
        '<em class="bd-vote-time" data-left="' + x.left + '" data-at="' + Date.now() + '">' +
        '还剩 ' + Math.ceil(x.left / 1000) + ' 秒</em></div>';
    }).join('');
  }

  /* 吹牛摊牌：服务端 `tally` 是「逐颗骰面 1~6 各几个」的客观计数。
     它不替桌上判够不够数，也不折算顺子 / 豹子 —— 标题那行把这话说清楚，
     免得有人把它当成叫牌结果。暗骰阶段这个字段是 null，整条收起。 */
  function paintTally(st) {
    if (!el.tally) return;
    var t = (isLiar(st) && st.phase === 'reveal' && st.tally) ? st.tally : null;
    if (!t || t.length !== 6) { el.tally.hidden = true; el.tally.__sig = ''; return; }
    el.tally.hidden = false;
    var sig = t.join(',');
    if (el.tally.__sig === sig) return;
    el.tally.__sig = sig;
    var mx = 1;
    for (var q = 0; q < 6; q++) mx = Math.max(mx, t[q] | 0);
    var row = '';
    for (var v = 1; v <= 6; v++) {
      var c = t[v - 1] | 0;
      row += '<div class="bd-tally-i"><b>' + v + '</b>' +
        '<i class="bar" style="height:' + (0.8 + 4.2 * c / mx).toFixed(2) + 'vmin"></i>' +
        '<u>' + c + '</u></div>';
    }
    el.tally.innerHTML =
      '<div class="bd-tally-h">骰面分布 · 逐颗点数，顺子 / 豹子按桌上规矩另算</div>' +
      '<div class="bd-tally-row">' + row + '</div>';
  }

  /* 日志带 k：按类型给色点，最新一条加金竖条。
     以前三行一样灰，得逐行读完才知道刚才谁出了豹子、谁走开了。 */
  var LOG_CLS = {
    lion: 'warm', bust: 'hot', streak: 'warm', pick: 'warm',
    kick: 'hot', away: 'cool', restart: 'cool', skip: 'cool',
    next: 'good', start: 'good', reveal: 'good', open: 'good'
  };

  function paintLog(log) {
    if (!el.log) return;
    var last = (log || []).slice(-3);
    var sig = last.map(function (x) { return (x && x.k ? x.k : '') + ':' + (x ? x.text : ''); }).join('|');
    if (el.log.__sig === sig) return;
    el.log.__sig = sig;
    el.log.textContent = '';
    for (var i = 0; i < last.length; i++) {
      var x = last[i] || {};
      var d = document.createElement('div');
      d.className = 'bd-log-i ' + (LOG_CLS[x.k] || '');
      var dot = document.createElement('i');
      dot.className = 'dot';
      var txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = x.text || '';
      d.appendChild(dot);
      d.appendChild(txt);
      el.log.appendChild(d);
    }
    if (el.logN) el.logN.textContent = last.length ? '最近 ' + last.length + ' 条' : '';
  }

  /* ---------- 350：明骰，桌上那一手大家都能看 ---------- */
  function render350(st) {
    var P = st.players || [];
    var cur = P[st.turn] || null;

    /* 骰子：先摆这一手已经收下的（压暗），再摆桌上还没收的 */
    var hand = st.hand || [], taken = st.taken || [];
    var sig = 'd|' + taken.join(',') + '|' + hand.map(function (d) { return d.v; }).join(',');
    if (el.dice && el.dice.__sig !== sig) {
      el.dice.__sig = sig;
      el.dice.textContent = '';
      el.dice.className = 'bd-dice';
      for (var t = 0; t < taken.length; t++) el.dice.appendChild(dieEl(taken[t], true));
      for (var i = 0; i < hand.length; i++) {
        if (hand[i].v) el.dice.appendChild(dieEl(hand[i].v, false));
      }
    }

    var k = '轮到', n = cur ? cur.name : '—', s = '';
    if (!st.started) {
      k = '等人齐';
      n = P.length + ' 人';
      s = '满 2 人就能开 · 房号念一声';
    } else if (st.phase === 'bust') {
      s = '<b>爆了</b> · 喝 1 杯 · 分数清零';
    } else if (st.phase === 'lion') {
      s = '<b>豹子</b> · 其他每人 2 杯';
    } else if (st.phase === 'over') {
      k = '本局最高';
      n = winName(P);
      s = '一局打完了 · 桌上谁点「重开」都行';
    } else if (st.phase === 'handoff') {
      s = '这一手收下了 · 等下一位接手';
    } else if (st.phase === 'rolled') {
      s = '摇完了 · 收 1 和 5，或者接着摇';
    } else {
      s = '摇骰';
    }
    /* 这一手离锁分还差多少：顶上那句本来只说「该做什么」，
       不说「做到哪了」。桌上要判断该不该接着摇，看的是这个数。
       但爆了 / 豹子 / 交接 / 打完这几种状态里这一手已经结束了，
       再挂一句「还差 350 分锁分」就成了废话，只在真摇真挑时补。 */
    if (st.started && (st.phase === 'ready' || st.phase === 'rolled')) {
      var r = st.round | 0;
      /* 350 是「够 350 就能锁」，不是上限：收过头了就别再报负数差 */
      s += r >= 350
        ? ' · 已经收了 <b>' + r + '</b> 分，够锁分了'
        : ' · 本手 <b>' + r + '</b> 分，还差 ' + (350 - r) + ' 分锁分';
    }
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var maxScore = 1;
    for (var q = 0; q < P.length; q++) maxScore = Math.max(maxScore, P[q].score | 0);
    var rows = [];
    for (var j = 0; j < P.length; j++) {
      var p = P[j], ai = awayInfo(p, st);
      /* 卡片底下那行小字得跟顶上那句话说的是同一件事。
         原来一律写成「正在摇」—— 可轮到他、骰子早落地了（phase 已经 rolled），
         顶上写着「摇完了 · 收 1 和 5」，卡片上还写「正在摇」，
         同一屏两句话打架。现在按 phase 说。 */
      var sub;
      /* 角标已经把「休息中 / 下把休息 / 下把回来」说清了，这行只讲本把怎样。
         写长了会把后面的 mm:ss 一起挤进 ellipsis，计时反而看不见。 */
      if (ai.rest) sub = '本把不参与';
      else if (ai.active) sub = '本把照常';
      else if (p.locked) sub = '已锁';
      else if (j !== st.turn || !st.started) sub = '还没锁';
      else if (st.phase === 'ready') sub = '该他摇';
      else if (st.phase === 'bust') sub = '爆了';
      else if (st.phase === 'lion') sub = '豹子';
      else if (st.phase === 'handoff') sub = '收下了';
      else sub = '在挑骰';
      rows.push({
        name: p.name,
        /* 只有锁下来的分数才算数：没锁的人这轮还没有分数，摆破折号比摆上一轮的数字诚实 */
        num: p.locked ? String(p.score) : '—',
        unit: p.locked ? '分' : '',
        dash: !p.locked,
        sub: sub,
        turn: j === st.turn && st.started && st.phase !== 'over',
        off: p.online === false,
        tag: ai.tag, tagCls: ai.cls, rest: ai.rest, bomb: false, wait: ai.wait,
        clock: ai.clock,
        bar: ai.rest ? 0 : Math.min(1, (p.score | 0) / maxScore),
        last: lastAct(st.log, p.name)
      });
    }
    paintGrid(rows, colsFor(P.length), sum350(st, P));
  }

  function winName(P) {
    if (!P.length) return '—';
    var best = P[0];
    for (var i = 1; i < P.length; i++) if ((P[i].score | 0) > (best.score | 0)) best = P[i];
    return best.name;
  }

  function sum350(st, P) {
    var locked = 0, best = 0;
    for (var i = 0; i < P.length; i++) {
      if (P[i].locked) locked++;
      best = Math.max(best, P[i].score | 0);
    }
    return {
      t: '本局小结',
      rows: ['已锁 <b>' + locked + '</b>/' + P.length + ' 人',
             '最高 <b>' + best + '</b> 分']
    };
  }

  /* ---------- 找朋友：中间是公骰，各家那两颗也照摆 ---------- */

  /* 下一庄要跳过休息的人：服务端 findNextShaker 就是这么挑的，
     大屏不能还按 (shaker+1) % n 指一个已经点了休息的人。 */
  function nextShaker(st, seats, from) {
    var n = seats.length;
    if (!n) return -1;
    for (var k = 1; k <= n; k++) {
      var i = (from + k) % n, p = seats[i];
      if (p.rest || p.away === 'rest' || p.online === false) continue;
      return i;
    }
    return (from + 1) % n;
  }

  function renderFind(st) {
    var seats = st.seats || [];
    var sh = seats[st.shaker] || null;
    var shakes = st.shakes || 2;

    var c = st.center || null;
    var sig = 'd|' + (c ? c.join(',') : '');
    if (el.dice && el.dice.__sig !== sig) {
      el.dice.__sig = sig;
      el.dice.textContent = '';
      /* 只有两颗，可以放大一号 —— 7 颗得挤一排，2 颗不用 */
      el.dice.className = 'bd-dice' + (c && c.length <= 3 ? ' two' : '');
      if (c) for (var i = 0; i < c.length; i++) el.dice.appendChild(dieEl(c[i], false));
    }

    var k = '轮到', n = sh ? sh.name : '—', s = '';
    if (!st.started) {
      k = '等人齐';
      n = seats.length + ' 人';
      s = '满 2 人就能开 · 房号念一声';
    } else if (st.phase === 'pick') {
      k = '11 正豹';
      n = '点名';
      s = '<b>' + (sh ? sh.name : '—') + '</b> 指一位 · 罚 1 杯';
    } else if (st.phase === 'hit') {
      /* 点数摆大字，喝的人放下面一行。
         原来反过来（名字当主角），三个字的名字一长就顶到屏幕外，
         「喝」被挤到自己一行 —— 一桌人抬头只看见「花生、年糕」。 */
      k = '公骰';
      n = dsum(c) + ' 点';
      s = '<b>' + hitNames(st) + '</b> 喝';
    } else if (st.phase === 'ready') {
      var left = 0;
      for (var q = 0; q < seats.length; q++) if ((seats[q].used | 0) < shakes) left++;
      s = '摇公骰' + (left ? ' · 还有 ' + left + ' 家没摇' : ' · 都摇完了');
    } else {
      var nx = seats[nextShaker(st, seats, st.shaker)];
      n = nx ? nx.name : '—';
      s = c ? '<b>' + dsum(c) + ' 点</b> · 没人对上，交给他' : '接手';
    }
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var rows = [];
    for (var j = 0; j < seats.length; j++) {
      var p = seats[j], used = p.used | 0, ai = awayInfo(p, st);
      var sub;
      if (ai.rest) sub = '本把不摇';
      else if (ai.active) sub = '本把照常';
      else if (p.sitOut) sub = '场外';
      else sub = used >= shakes ? '摇完了' : '待摇 ' + (shakes - used) + ' 次';
      rows.push({
        name: p.name,
        num: String(p.cups | 0),
        /* 光一个「6」没人猜得出是什么：这个数字是「喝了几杯」，
           得带个单位。放在数字里而不是另一行，抬头一眼就是「6 杯」。 */
        unit: '杯',
        cups: true,
        /* 找朋友本来就是把骰子摊在桌上打的，各家的两颗大屏也照摆 ——
           一桌人抬头就看见全桌的点子，不用凑到别人手机前。
           没摇的人手里是 [0,0]，画成两个空位，比干脆不画更能说明「他还欠一手」。 */
        dice: ai.rest ? null : (p.dice || [0, 0]),
        sub: sub,
        turn: j === st.shaker && st.started,
        off: p.online === false,
        tag: ai.tag, tagCls: ai.cls, rest: ai.rest, bomb: false, wait: ai.wait,
        clock: ai.clock,
        bar: ai.rest ? 0 : Math.min(1, used / (shakes || 2)),
        last: lastAct(st.log, p.name)
      });
    }
    paintGrid(rows, colsFor(seats.length), sumFind(st, seats, shakes));
  }

  function sumFind(st, seats, shakes) {
    var cups = 0, left = 0;
    for (var i = 0; i < seats.length; i++) {
      cups += seats[i].cups | 0;
      if (!seats[i].rest && (seats[i].used | 0) < shakes) left++;
    }
    return {
      t: '本局小结',
      rows: ['共 <b>' + cups + '</b> 杯', '待摇 <b>' + left + '</b> 家']
    };
  }

  function nameOf(seats, i) {
    var p = seats[i];
    return p ? p.name : '—';
  }

  function dsum(c) { return c ? (c[0] | 0) + (c[1] | 0) : 0; }

  function hitNames(st) {
    var seats = st.seats || [], hits = st.hits || [], out = [];
    for (var i = 0; i < hits.length; i++) {
      var p = seats[hits[i].i];
      if (p) out.push(p.name);
    }
    if (!out.length) return '没人';
    if (out.length <= 2) return out.join('、');
    return out.slice(0, 2).join('、') + ' 等 ' + out.length + ' 人';
  }

  /* ---------- 吹牛：暗骰，所以摊牌之前大屏上不该出现任何点数 ----------

     三个玩法里只有这块屏的中间骰子区是空的：骰子是暗的，大屏摆什么都等于替人开牌。
     摊牌之后那只摆客观计数：一共几颗、1~6 逐颗各几个，以及牌型标签。
     大屏不判输赢（2026-11-11 之后线上彻底不判），够不够数桌上自己看。

     顺子 = 5 颗点数互不重复（1 是万能牌，13456 / 12456 也算）—— 跟单机
     faceOf、联机 liarIsStraight、手机摊牌标签同一条定义。以前这里写的是
     「1-2-3-4-5 或 2-3-4-5-6」，会漏掉带 1 断一截的万能顺，跟手机对不上。 */
  function isStraight(dice) {
    if (!dice || dice.length !== 5) return false;
    var seen = {}, i;
    for (i = 0; i < 5; i++) {
      var v = dice[i];
      if (v < 1 || v > 6 || seen[v]) return false;
      seen[v] = 1;
    }
    return true;
  }

  /* 正豹、全 1、带 1 的万能豹都算。跟手机端 isLionDice 同一套。 */
  function isLionDice(dice) {
    if (!dice || dice.length !== 5) return false;
    var p = 0, ones = 0, i;
    for (i = 0; i < 5; i++) {
      var v = dice[i];
      if (v < 1 || v > 6) return false;
      if (v === 1) { ones++; continue; }
      if (p && v !== p) return false;
      p = v;
    }
    return p ? true : ones === 5;
  }

  function renderLiar(st) {
    var seats = st.seats || [];
    var rd = st.roll || { done: 0, all: seats.length };
    var op = st.open || null;

    if (el.dice && el.dice.__sig !== 'none') {
      el.dice.__sig = 'none';
      el.dice.textContent = '';
      el.dice.className = 'bd-dice';      /* 空了之后 `.bd-dice:empty` 自己藏起来 */
    }

    var k = '吹牛', n = '', s = '';
    if (!st.started) {
      k = '等人齐';
      n = seats.length + ' 人';
      s = '满 2 人就能开 · 房号念一声';
    } else if (st.phase === 'roll') {
      /* 这一阶段大屏唯一有用的事：还差谁没摇 */
      k = '各自摇';
      n = rd.done + '/' + rd.all;
      s = '都摇完牌自己就锁 · 不用再按一下';
    } else if (st.phase === 'call') {
      k = '开牌票';
      n = (op ? op.done : 0) + '/' + (op ? op.need : 1);
      s = '面对面叫 · 够 <b>2/3</b> 的人点了就摊';
    } else if (st.phase === 'reveal') {
      k = '摊牌';
      n = (st.total | 0) + ' 颗';
      var sn = 0, ln = 0;
      for (var m = 0; m < seats.length; m++) {
        if (isLionDice(seats[m].dice)) ln++;
        else if (isStraight(seats[m].dice)) sn++;
      }
      s = (ln ? ln + ' 家豹子 · ' : '') +
          (sn ? sn + ' 家顺子 · ' : (ln ? '' : '没有豹子也没有顺子 · ')) +
          '点数自己数';
    }
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var rows = [];
    for (var j = 0; j < seats.length; j++) {
      var p = seats[j], ai = awayInfo(p, st);
      var sub;
      if (ai.rest) sub = '本把没摇';
      else if (ai.bomb) sub = '自动摇';
      else if (ai.active) sub = '本把照常';
      else if (st.phase === 'reveal') {
        sub = isLionDice(p.dice) ? '豹子' :
              (isStraight(p.dice) ? '顺子' : (p.rolled ? '摊开' : '没摇'));
      } else if (p.rolled) sub = '摇了';
      else sub = '还没摇';

      var tag = ai.tag, tagCls = ai.cls;
      /* 连顺是公开信息（上一把摊开时全桌都看见了），摊牌前后都可以标 */
      if (!ai.active && (p.streak | 0) >= 2) {
        tag = '连顺 ' + (p.streak | 0);
        tagCls = 'streak';
      }
      rows.push({
        name: p.name,
        /* 吹牛没有「分数」这个数：卡片中间平时是空的，摊牌之后摆他的 5 颗骰子 */
        noNum: true,
        dice: (st.phase === 'reveal' && !ai.rest && p.dice && p.dice.length) ? p.dice : null,
        five: true,
        sub: sub,
        off: p.online === false,
        tag: tag, tagCls: tagCls, rest: ai.rest, bomb: ai.bomb, wait: ai.wait,
        clock: ai.clock,
        bar: ai.rest ? 0 : (st.phase === 'reveal'
          ? Math.min(1, (p.streak | 0) / 3) : (p.rolled ? 1 : 0)),
        last: lastAct(st.log, p.name)
      });
    }
    paintGrid(rows, colsFor(seats.length), sumLiar(st, seats, rd));
  }

  function sumLiar(st, seats, rd) {
    var best = 0;
    for (var i = 0; i < seats.length; i++) best = Math.max(best, seats[i].streak | 0);
    return {
      t: '本局小结',
      rows: ['已摇 <b>' + (rd.done | 0) + '/' + (rd.all | 0) + '</b>',
             '最多连顺 <b>' + best + '</b> 把']
    };
  }

  /* 换人 / 换阶段时闪一下金：隔一张桌子也看得见桌子动了。
     整段加缓存：state 一秒能来好几份，值没变就不重写 DOM，
     否则那颗金字每帧都被重新挂 class，动画根本走不完。 */
  function paintTurn(k, n, s, phase) {
    if (!el.turnK) return;
    var sig = k + '\u0001' + n + '\u0001' + s + '\u0001' + phase;
    if (S.lastTurnSig === sig) return;
    var changed = (S.lastName !== n || S.lastPhase !== phase);
    S.lastTurnSig = sig;
    el.turnK.textContent = k;
    el.turnN.textContent = n;
    el.turnS.innerHTML = s || '';
    if (changed && S.lastName) {
      el.turnN.classList.remove('hot');
      void el.turnN.offsetWidth;
      el.turnN.classList.add('hot');
    }
    S.lastName = n;
    S.lastPhase = phase;
  }

  /* 几个人排几列：竖着摆（手机）最多 4 列，横过来（平板）可以铺 6 列。
     卡片大小由 grid 均分，字号再按卡片高度算（cqh），所以人数变了不用另调样式。 */
  function colsFor(n) {
    if (!n) return 1;
    var land = window.innerWidth > window.innerHeight;
    var want = land ? (n <= 3 ? 3 : n <= 8 ? 4 : 6)
                    : (n <= 2 ? 2 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
    return Math.min(n, want);
  }

  function paintGrid(rows, cols, sum) {
    if (!el.grid) return;
    var sig = cols + '|' + rows.map(function (r) {
      return [r.name, r.num, r.unit || '', r.sub, r.turn ? 1 : 0, r.off ? 1 : 0,
        r.dash ? 1 : 0, r.cups ? 1 : 0, r.dice ? r.dice.join('') : '', r.noNum ? 1 : 0,
        r.tag || '', r.tagCls || '', r.rest ? 1 : 0, r.bomb ? 1 : 0, r.wait ? 1 : 0,
        r.clock ? (r.clock.last ? 'L' + r.clock.last : 'B' + r.clock.base) : '',
        (typeof r.bar === 'number' ? Math.round(r.bar * 100) : ''), r.last || ''
      ].join('~');
    }).join('|') + '|' + (sum ? sum.t + sum.rows.join('/') : '');
    if (el.grid.__sig === sig) return;
    el.grid.__sig = sig;

    el.grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    el.grid.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var card = document.createElement('div');
      card.className = 'bd-card' + (r.turn ? ' turn' : '') + (r.off ? ' off' : '') +
        (r.rest ? ' rest' : '') + (r.bomb ? ' bomb' : '') + (r.wait ? ' wait' : '');

      if (r.tag) {
        var tg = document.createElement('i');
        tg.className = 'bd-tag' + (r.tagCls === 'streak' ? ' streak' : '');
        tg.textContent = r.tag;
        card.appendChild(tg);
      }
      var nm = document.createElement('div');
      nm.className = 'bd-name';
      nm.textContent = r.name;
      card.appendChild(nm);
      /* 吹牛的卡片没有那个大数字（它没有「分数」可摆），名字下面直接是骰子 */
      if (!r.noNum) {
        var nu = document.createElement('div');
        nu.className = 'bd-num' + (r.dash ? ' dash' : '') + (r.cups ? ' cups' : '');
        nu.textContent = r.num;
        /* 单位挂在数字里、用 em 缩到四成多 —— 这样卡片缩放的那三个上限
           （cqh / cqw / vmin）管的是「6杯」整个宽度，不会数字缩了单位却不缩 */
        if (r.unit) {
          var un = document.createElement('i');
          un.className = 'bd-unit';
          un.textContent = r.unit;
          nu.appendChild(un);
        }
        card.appendChild(nu);
      }
      /* 各家自己的骰子：找朋友那两颗一直摊着；吹牛只有摊牌之后才有。
         休息的人这把根本没摇，别给他摆两颗空白骰位。 */
      if (r.dice) {
        var dr = document.createElement('div');
        dr.className = 'bd-cd' + (r.five ? ' five' : '');
        for (var d = 0; d < r.dice.length; d++) {
          var v = r.dice[d] | 0;
          var de = dieEl(v, false);
          if (!v) de.className = 'bd-die ghost';
          dr.appendChild(de);
        }
        card.appendChild(dr);
      }
      /* 状态文字和计时分两块：文字那块才允许 ellipsis，计时固定不缩。
         以前整行一起截断，「休息 · 本把不摇 …」把 02:05 吃掉了。 */
      var sb = document.createElement('div');
      sb.className = 'bd-sub';
      var stx = document.createElement('span');
      stx.className = 'bd-sub-t';
      stx.textContent = r.sub || '';
      sb.appendChild(stx);
      if (r.clock) {
        var ck = document.createElement('i');
        ck.className = 'bd-away-time';
        if (r.clock.last) {
          ck.textContent = '本次离开 ' + fmtMs(r.clock.last);
        } else {
          ck.setAttribute('data-base', String(r.clock.base));
          ck.setAttribute('data-at', String(Date.now()));
          ck.textContent = fmtMs(r.clock.base);
        }
        sb.appendChild(ck);
      }
      card.appendChild(sb);
      if (typeof r.bar === 'number') {
        var bar = document.createElement('div');
        bar.className = 'bd-bar';
        var fill = document.createElement('i');
        fill.style.width = Math.round(Math.max(0, Math.min(1, r.bar)) * 100) + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
      }
      if (r.last) {
        var la = document.createElement('div');
        la.className = 'bd-last';
        la.textContent = r.last;
        card.appendChild(la);
      }
      el.grid.appendChild(card);
    }

    /* 奇数人时右下角补一张「本局小结」，不铺满整行、也不算一个人头。
       故意不叫 `.bd-card`：验收脚本数 `#bdGrid .bd-card` 就是人数。 */
    if (sum && rows.length) {
      var rem = cols - (rows.length % cols);
      if (rem > 0 && rem < cols) {
        var sd = document.createElement('div');
        sd.className = 'bd-sum';
        sd.style.gridColumn = 'span ' + rem;
        var st = document.createElement('div');
        st.className = 'bd-sum-t';
        st.textContent = sum.t;
        sd.appendChild(st);
        for (var q = 0; q < sum.rows.length; q++) {
          var sr = document.createElement('div');
          sr.className = 'bd-sum-r';
          sr.innerHTML = sum.rows[q];
          sd.appendChild(sr);
        }
        el.grid.appendChild(sd);
      }
    }
  }

  /* 卡片摆完才知道有多大。393×852 上量过：4 人两列是 180×218，
     12 人四列是 88×186 —— 高度几乎没变，真正挤的是**宽度**。
     所以主要看 width，height 只用来挡住「横屏时又宽又矮」误判成高卡。 */
  function measureGrid() {
    if (!el.grid || !el.grid.firstChild) return;
    var r = el.grid.firstChild.getBoundingClientRect();
    var cls = (r.width >= 150 && r.height >= 140) ? 'is-tall'
            : (r.width >= 105 && r.height >= 90) ? 'is-mid' : 'is-short';
    if (el.grid.__hcls === cls) return;
    el.grid.classList.remove('is-tall', 'is-mid', 'is-short');
    el.grid.classList.add(cls);
    el.grid.__hcls = cls;
  }

  /* ---------------- 每秒只改几个字，不整页重画 ----------------

     服务端只在广播那一刻给权威基准（awayMs / vote.left），中间不推。
     这块屏自己往下走秒：离开时长、投票倒计时、顶栏时钟，全都只改文本。 */
  function tick() {
    var now = Date.now();
    if (el.clock) el.clock.textContent = hhmm(now);
    if (!el.stage) return;
    var a = el.stage.querySelectorAll('.bd-away-time[data-base]');
    for (var i = 0; i < a.length; i++) {
      var base = Number(a[i].getAttribute('data-base')) || 0;
      var at = Number(a[i].getAttribute('data-at')) || now;
      a[i].textContent = fmtMs(base + Math.max(0, now - at));
    }
    var v = el.stage.querySelectorAll('.bd-vote-time[data-left]');
    for (var j = 0; j < v.length; j++) {
      var left = Number(v[j].getAttribute('data-left')) || 0;
      var vat = Number(v[j].getAttribute('data-at')) || now;
      var sec = Math.max(0, Math.ceil((left - (now - vat)) / 1000));
      v[j].textContent = sec ? '还剩 ' + sec + ' 秒' : '到点了';
    }
  }

  function startTicker() {
    if (S.tick) return;
    tick();
    S.tick = setInterval(tick, 1000);
  }

  function stopTicker() {
    clearInterval(S.tick);
    S.tick = null;
  }

  /* ---------------- 屏别睡 ----------------

     摆在桌上那块屏没人碰它：一分钟就黑下去，等于白摆。
     有 Wake Lock 就申请（安卓 Chrome / 新 Safari 都支持），没有就算了 ——
     这不是关键路径，失败了也照样能看，只是会自己熄屏。
     系统会因为切后台 / 省电把锁收走，release 事件到了就该再要一次；
     只有自己主动退出（dropAt）才别再要，否则退出之后还一直抢锁。 */
  function keepAwake() {
    if (!('wakeLock' in navigator) || S.wake) return;
    try {
      navigator.wakeLock.request('screen').then(function (l) {
        S.wake = l;
        l.addEventListener('release', function () {
          S.wake = null;
          if (Date.now() - S.dropAt < 1500) return;
          if (!S.alive || !el.stage || el.stage.hidden ||
              document.visibilityState !== 'visible') return;
          clearTimeout(S.tWake);
          S.tWake = setTimeout(keepAwake, 600);
        });
      }).catch(function () {});
    } catch (e) {}
  }

  function dropAwake() {
    S.dropAt = Date.now();
    clearTimeout(S.tWake);
    if (S.wake) { try { S.wake.release(); } catch (e) {} }
    S.wake = null;
  }

  /* ---------------- 进出 ---------------- */

  function hello(code) {
    clearTimeout(S.tHelloA);
    clearTimeout(S.tHelloB);
    if (!el.hello) return;
    if (el.helloCode) el.helloCode.textContent = code;
    el.hello.classList.remove('out');
    el.hello.hidden = false;
    /* 进场先把房号放大念一遍，之后收成角标、把整行让给状态条。
       盖一层而不改顶栏字号：收起时下面那块屏一像素都不跳。 */
    S.tHelloA = setTimeout(function () { el.hello.classList.add('out'); }, 4200);
    S.tHelloB = setTimeout(function () { el.hello.hidden = true; }, 5000);
  }

  function showStage() {
    if (el.gate) el.gate.hidden = true;
    if (el.stage) el.stage.hidden = false;
    keepAwake();
    startTicker();
  }

  function hideStage() {
    if (el.stage) el.stage.hidden = true;
    if (el.gate) el.gate.hidden = false;
    clearTimeout(S.tHelloA);
    clearTimeout(S.tHelloB);
    if (el.hello) {
      el.hello.hidden = true;
      el.hello.classList.remove('out');
    }
    stopTicker();
    dropAwake();
  }

  function go() {
    var raw = (el.code ? el.code.value : '').replace(/\D/g, '');
    if (raw.length !== 4 && raw.length !== 6) { tip('房号是 4 位数字（撞满了才 6 位）'); return; }
    S.code = raw;
    S.st = null;
    el.grid && (el.grid.__sig = '');
    el.grid && (el.grid.__hcls = '');
    el.dice && (el.dice.__sig = '');
    el.log && (el.log.__sig = '');
    el.vote && (el.vote.__sig = '');
    el.tally && (el.tally.__sig = '');
    S.lastName = '';
    S.lastPhase = '';
    S.lastTurnSig = '';
    try { localStorage.setItem('ld_board_code', raw); } catch (e) {}
    if (el.codeBig) el.codeBig.textContent = raw;
    if (el.stat) el.stat.textContent = '';
    if (el.turnK) el.turnK.textContent = '连接中';
    if (el.turnN) el.turnN.textContent = '…';
    if (el.turnS) el.turnS.textContent = '';
    if (el.grid) el.grid.textContent = '';
    if (el.dice) el.dice.textContent = '';
    if (el.log) el.log.textContent = '';
    if (el.logN) el.logN.textContent = '';
    if (el.vote) { el.vote.textContent = ''; el.vote.hidden = true; }
    if (el.tally) { el.tally.textContent = ''; el.tally.hidden = true; }
    hello(raw);
    showStage();
    S.api = apiBase();
    connect();
  }

  function quit() {
    S.alive = false;
    closeSocket();
    clearTimeout(S.tRetry);
    S.st = null;
    offMark(false);
    hideStage();
    tip('已经离开这一桌', true);
  }

  /* 一次把要用的节点抓齐：后面每帧要动十来个，别每次 getElementById */
  var IDS = {
    gate: 'bdGate', stage: 'bdStage', code: 'bdCode', tip: 'bdTip',
    codeBig: 'bdCodeBig', game: 'bdGame', off: 'bdOff',
    stat: 'bdStat', clock: 'bdClock', hello: 'bdHello', helloCode: 'bdHelloCode',
    turnK: 'bdTurnK', turnN: 'bdTurnN', turnS: 'bdTurnS',
    dice: 'bdDice', grid: 'bdGrid', log: 'bdLog', logN: 'bdLogN',
    vote: 'bdVote', tally: 'bdTally',
    go: 'bdGo', exit: 'bdExit', back: 'bdBack'
  };

  function cache() {
    for (var k in IDS) el[k] = $(IDS[k]);
  }

  function boot() {
    cache();

    if (el.code) {
      el.code.addEventListener('input', function () {
        var v = el.code.value.replace(/\D/g, '').slice(0, 6);
        if (v !== el.code.value) el.code.value = v;
        tip('');
      });
      el.code.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') go();
      });
    }
    if (el.go) el.go.addEventListener('click', go);
    if (el.exit) el.exit.addEventListener('click', quit);
    if (el.back) el.back.addEventListener('click', function () {
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
      else location.hash = 'netmodes';
    });

    /* 摆过一次就记住房号：同一桌中途退出再摆回来，不用再念一遍 */
    try {
      var last = localStorage.getItem('ld_board_code');
      if (last && el.code && !el.code.value) el.code.value = last;
    } catch (e) {}

    /* 切到后台再回来：socket 可能已经被系统掐了，顺手把屏锁要回来 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (el.stage && !el.stage.hidden) {
        keepAwake();
        startTicker();
        if (!S.ws) connect();
      }
    });

    /* 转屏之后列数要重排 */
    window.addEventListener('resize', function () {
      if (el.grid) { el.grid.__sig = ''; el.grid.__hcls = ''; }
      if (S.st) render();
    });
  }

  window.LDBoard = {
    /* 进这一页：上次摆的那桌还在（socket 没断）就接着看，不重新连 */
    enter: function () {
      if (S.code && el.stage && !el.stage.hidden && !S.ws) connect();
    },
    /* 离开这一页：连着的先松开，别在后台占一条长连接 */
    leave: function () {
      if (!S.code) return;
      S.alive = false;
      closeSocket();
      clearTimeout(S.tRetry);
      hideStage();
    },
    code: function () { return S.code; },
    /* 文档配图 / 验收探针用：灌一份桌面直接画，不连 socket、不发任何消息。
       顺手把秒针起起来，假桌面上的离开时长和投票倒计时也能自己走。 */
    paint: function (st) { S.st = st; render(); startTicker(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

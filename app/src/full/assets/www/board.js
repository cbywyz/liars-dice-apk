/* 摆桌上 · 公共屏（只读观众）

   一桌人各看各的手机，桌上没有共同焦点。这台设备摆桌子中间，把「几点」「该谁」
   「几杯」摆出来，谁都抬眼就能看见；摇骰、看自己的牌这些私密动作还在各自手机上。

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
    st: null, game: '', lastName: '', lastPhase: '',
    wake: null
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

  /* ---------------- 画 ---------------- */

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

  /* 角标上那个玩法名。服务端给的标识是 l350 / find / liar 三个，别再多造一张映射表 */
  function gameName(g) {
    return g === 'find' ? '找朋友' : (g === 'liar' ? '吹牛' : '350');
  }

  /* 名字是玩家自己敲的，要塞进 innerHTML 的那几处一律过一遍 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    var st = S.st;
    if (!st) return;

    if (el.codeBig) el.codeBig.textContent = st.code || S.code || '----';
    if (el.game) el.game.textContent = gameName(st.game);

    if (isFind(st)) renderFind(st);
    else if (isLiar(st)) renderLiar(st);
    else render350(st);
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
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var cols = colsFor(P.length);
    var rows = [];
    for (var j = 0; j < P.length; j++) {
      var p = P[j];
      /* 卡片底下那行小字得跟顶上那句话说的是同一件事。
         原来一律写成「正在摇」—— 可轮到他、骰子早落地了（phase 已经 rolled），
         顶上写着「摇完了 · 收 1 和 5」，卡片上还写「正在摇」，
         同一屏两句话打架，看的人会以为自己看漏了一步。
         现在按 phase 说：还没摇 / 摇完了在挑骰 / 出豹子 / 爆了 / 收下换人。 */
      var sub;
      if (p.locked) sub = '已锁';
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
        /* 打完了就不再指谁是「当前」：桌上该看的是分数，不是那个已经收工的人 */
        turn: j === st.turn && st.started && st.phase !== 'over',
        off: p.online === false
      });
    }
    paintGrid(rows, cols);
    paintLog(st.log);
  }

  function winName(P) {
    if (!P.length) return '—';
    var best = P[0];
    for (var i = 1; i < P.length; i++) if ((P[i].score | 0) > (best.score | 0)) best = P[i];
    return best.name;
  }

  /* ---------- 找朋友：中间是公骰，各家那两颗也照摆 ---------- */
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
      var nx = seats[(st.shaker + 1) % seats.length];
      n = nx ? nx.name : '—';
      s = c ? '<b>' + dsum(c) + ' 点</b> · 没人对上，交给他' : '接手';
    }
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var rows = [];
    for (var j = 0; j < seats.length; j++) {
      var p = seats[j], used = p.used | 0;
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
        dice: p.dice || [0, 0],
        sub: p.sitOut ? '场外' : (used >= shakes ? '摇完了' : '待摇 ' + (shakes - used) + ' 次'),
        turn: j === st.shaker && st.started,
        off: p.online === false
      });
    }
    paintGrid(rows, colsFor(seats.length));
    paintLog(st.log);
  }

  /* ---------- 吹牛：暗骰，所以摊牌之前大屏上不该出现任何点数 ----------

     三个玩法里只有这块屏的中间骰子区是空的：骰子是暗的，大屏摆什么都等于替人开牌。
     所以它只做三件事 —— 几家摇完了、开牌票几张、摊开之后全桌一共有几个几点。

     大屏不判输赢（2026-11-11 之后线上彻底不判）：摊牌这一段只报「一共几颗」和
     「1~6 各几个」两个客观数，够不够数、谁喝，桌上自己看。 */
  /* 顺子：5 颗连成一条（1-2-3-4-5 / 2-3-4-5-6）。跟手机端 paintReveal 同一个判法，
     只标不判 —— 大屏上五颗点挨个认更慢，贴上两个字全桌都省事。 */
  function isStraight(dice) {
    if (!dice || dice.length !== 5) return false;
    var v = dice.slice().sort(function (a, b) { return a - b; });
    for (var i = 1; i < v.length; i++) if (v[i] !== v[0] + i) return false;
    return v[0] === 1 || v[0] === 2;
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
      /* 原来这里逐点列「1 × 4 · 2 × 2 …」，2026-11-12 撤掉（手机上同一处也撤了）：
         那行没剔除顺子（顺子不计点数），也表达不了豹子（算 6 个、带 1 算 10 个），
         数出来就是个错数。大屏改成报「几家有顺子」—— 摊开那一刻桌上最该数的就是这个。 */
      var sn = 0;
      for (var m = 0; m < seats.length; m++) if (isStraight(seats[m].dice)) sn++;
      s = sn ? sn + ' 家有顺子 · 顺子不计点数' : '没有顺子 · 点数自己数';
    }
    paintTurn(k, n, s, st.started ? st.phase : 'lobby');

    var rows = [];
    for (var j = 0; j < seats.length; j++) {
      var p = seats[j];
      var sub;
      if (st.phase === 'reveal') sub = isStraight(p.dice) ? '顺子' : (p.rolled ? '摊开' : '没摇');
      else if (p.rolled) sub = '摇了';
      else sub = '还没摇';
      rows.push({
        name: p.name,
        /* 吹牛没有「分数」这个数：卡片中间平时是空的，摊牌之后摆他的 5 颗骰子 */
        noNum: true,
        dice: (st.phase === 'reveal' && p.dice && p.dice.length) ? p.dice : null,
        five: true,
        sub: sub,
        off: p.online === false
      });
    }
    paintGrid(rows, colsFor(seats.length));
    paintLog(st.log);
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

  function paintTurn(k, n, s, phase) {
    if (!el.turnK) return;
    var changed = (S.lastName !== n || S.lastPhase !== phase);
    el.turnK.textContent = k;
    el.turnN.textContent = n;
    el.turnS.innerHTML = s || '';
    /* 换人 / 换阶段时闪一下金：隔一张桌子也看得见桌子动了 */
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

  function paintGrid(rows, cols) {
    if (!el.grid) return;
    var sig = cols + '|' + rows.map(function (r) {
      return [r.name, r.num, r.unit || '', r.sub, r.turn ? 1 : 0, r.off ? 1 : 0, r.dash ? 1 : 0,
        r.cups ? 1 : 0, r.dice ? r.dice.join('') : '', r.noNum ? 1 : 0, r.lose ? 1 : 0].join('~');
    }).join('|');
    if (el.grid.__sig === sig) return;
    el.grid.__sig = sig;

    el.grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    el.grid.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var card = document.createElement('div');
      card.className = 'bd-card' + (r.turn ? ' turn' : '') + (r.off ? ' off' : '') + (r.lose ? ' lose' : '');
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
      /* 各家自己的骰子：找朋友那两颗一直摊着；吹牛只有摊牌之后才有 */
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
      var sb = document.createElement('div');
      sb.className = 'bd-sub';
      sb.textContent = r.sub;
      card.appendChild(sb);
      el.grid.appendChild(card);
    }
  }

  function paintLog(log) {
    if (!el.log) return;
    var last = (log || []).slice(-3);
    var sig = last.map(function (x) { return x.text; }).join('|');
    if (el.log.__sig === sig) return;
    el.log.__sig = sig;
    el.log.textContent = '';
    for (var i = 0; i < last.length; i++) {
      var d = document.createElement('div');
      d.className = 'bd-log-i';
      d.textContent = last[i].text;
      el.log.appendChild(d);
    }
  }

  /* ---------------- 屏别睡 ---------------- */

  /* 摆在桌上那块屏没人碰它：一分钟就黑下去，等于白摆。
     有 Wake Lock 就申请（安卓 Chrome / 新 Safari 都支持），没有就算了 ——
     这不是关键路径，失败了也照样能看，只是会自己熄屏。 */
  function keepAwake() {
    if (!('wakeLock' in navigator) || S.wake) return;
    try {
      navigator.wakeLock.request('screen').then(function (l) {
        S.wake = l;
        l.addEventListener('release', function () { S.wake = null; });
      }).catch(function () {});
    } catch (e) {}
  }

  function dropAwake() {
    if (!S.wake) return;
    try { S.wake.release(); } catch (e) {}
    S.wake = null;
  }

  /* ---------------- 进出 ---------------- */

  function showStage() {
    if (el.gate) el.gate.hidden = true;
    if (el.stage) el.stage.hidden = false;
    keepAwake();
  }

  function hideStage() {
    if (el.stage) el.stage.hidden = true;
    if (el.gate) el.gate.hidden = false;
    dropAwake();
  }

  function go() {
    var raw = (el.code ? el.code.value : '').replace(/\D/g, '');
    if (raw.length !== 4 && raw.length !== 6) { tip('房号是 4 位数字（撞满了才 6 位）'); return; }
    S.code = raw;
    S.st = null;
    el.grid && (el.grid.__sig = '');
    el.dice && (el.dice.__sig = '');
    el.log && (el.log.__sig = '');
    S.lastName = '';
    S.lastPhase = '';
    try { localStorage.setItem('ld_board_code', raw); } catch (e) {}
    showStage();
    if (el.codeBig) el.codeBig.textContent = raw;
    if (el.turnK) el.turnK.textContent = '连接中';
    if (el.turnN) el.turnN.textContent = '…';
    if (el.turnS) el.turnS.textContent = '';
    if (el.grid) el.grid.textContent = '';
    if (el.dice) el.dice.textContent = '';
    if (el.log) el.log.textContent = '';
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
    turnK: 'bdTurnK', turnN: 'bdTurnN', turnS: 'bdTurnS',
    dice: 'bdDice', grid: 'bdGrid', log: 'bdLog',
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
        if (!S.ws) connect();
      }
    });

    /* 转屏之后列数要重排 */
    window.addEventListener('resize', function () {
      if (el.grid) el.grid.__sig = '';
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
    code: function () { return S.code; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

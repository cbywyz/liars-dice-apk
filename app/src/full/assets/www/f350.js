/* 350 玩法 —— 第二种玩法，和吹牛骰子完全独立的一页。
   规则：
     · 7 颗骰子，1 = 100 分，5 = 50 分，2/3/4/6 不计分
     · 摇完把 1 和 5 拿出来计分，没拿的骰子留在桌上继续摇
     · 任意一把一个 1 也没有、一个 5 也没有 → 本回合分清零，拿回 7 颗重摇（不换人、不限次数）
     · 7 颗全是 1 和 5 = 豹子 → 记 1 次（只做记录），分数清零，他继续摇
     · 满 350 才能锁分收手，轮到下一位；封顶 700
     · 比锁定的分数，高者胜，同分先锁者胜

   这个文件不依赖 app.js，两版（完整版 / 纯净版）都带。 */

(function () {
  'use strict';

  /* ================= 常量 ================= */

  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var CELL = [20, 50, 80];
  var RED = { 1: true, 4: true };
  var TILT = [-9, 6, -4, 8, -7, 5, -6];

  var DICE = 7;          // 每回合的骰子数
  var BASE = 350;        // 最低锁分线
  var CAP = 700;         // 封顶
  /* 人数：4 人起，最多 12 人。少了两三个人不成局，
     13 以上一桌也挤不下，4~12 共 9 档正好排成 3×3 的下拉网格 */
  var MIN_P = 4;
  var MAX_P = 12;
  var STORE = 'f350_state';
  var STORE_P = 'f350_players';

  /* 桌面尺寸（rpx），必须和 f350.css 的 .f3-table 对齐：81.3333vw × 50vw */
  var TABLE_W = 610;
  var TABLE_H = 375;

  var VW = 100 / 750;
  function rpx(n) {
    var s = (n * VW).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return (s || '0') + 'vw';
  }

  /* ================= 纯函数 ================= */

  function pointsOf(v) {
    if (v === 1) return 100;
    if (v === 5) return 50;
    return 0;
  }

  function rollOne() {
    return 1 + Math.floor(Math.random() * 6);
  }

  /* 按手牌数排布：≤4 颗一行，多了分两行，行内居中，尺寸自动算 */
  var SLOT_CACHE = {};
  function layout(n) {
    if (SLOT_CACHE[n]) return SLOT_CACHE[n];
    var cols = n <= 4 ? n : Math.ceil(n / 2);
    var rows = Math.ceil(n / cols);
    var GX = 16, GY = 24;
    /* 骰子带 9° 倾斜，方形转一下对角就比边长长 15%，
       所以可用面积要按包围盒扣，不然角会戳出桌面 */
    var maxW = TABLE_W - 72;
    var maxH = TABLE_H - 110;
    var size = Math.min(
      (maxW - (cols - 1) * GX) / cols,
      (maxH - (rows - 1) * GY) / rows,
      128
    );
    var totalH = rows * size + (rows - 1) * GY;
    var y0 = (TABLE_H - totalH) / 2;
    var out = [];
    for (var r = 0; r < rows; r++) {
      var cnt = Math.min(cols, n - r * cols);
      var totalW = cnt * size + (cnt - 1) * GX;
      var x0 = (TABLE_W - totalW) / 2;
      for (var c = 0; c < cnt; c++) {
        var i = r * cols + c;
        out.push({
          l: x0 + c * (size + GX),
          t: y0 + r * (size + GY),
          r: TILT[i % TILT.length],
          s: size
        });
      }
    }
    SLOT_CACHE[n] = out;
    return out;
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  /* ================= 状态 ================= */

  var G = {
    players: [],        // { name, score, lion, locked }
    order: [],          // 锁分先后，用于同分比较
    turn: 0,
    hand: [],           // [{ v: 0..6, sel: bool }]  v=0 是还没摇，sel 是被点中要拿走的
    round: 0,
    taken: [],          // 本回合已经收下的点数，按收的先后排（分数下面那排小骰子）
    took: false,        // 这一把是否已经收过骰子：收过之后剩下的还能接着收，不用重摇
    phase: 'ready',     // ready | rolled | bust | over
    shakeAt: 0
  };

  var S = { timer: null, toastTimer: null, lastTapIdx: -1, lastTapAt: 0,
            shake: null };

  var el = {};

  /* ================= 音效 =================
     350 之前一直没有任何音效：摇完只有震动，手机上就是"摇骰子没声音"。
     这里直接复用吹牛模式那颗 shake.mp3，不另外存一份，
     免得两个玩法以后各改各的、声音不一致。 */
  function playShake() {
    try {
      if (!S.shake) {
        S.shake = new Audio('assets/audio/shake.mp3');
        S.shake.preload = 'auto';
        S.shake.addEventListener('error', function () { S.shake = null; });
      }
      S.shake.currentTime = 0;
      var p = S.shake.play();
      /* 安卓 WebView 首次播放可能被拦，这里必须吞掉 rejection，
         否则控制台一片红、看起来像代码报错 */
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 没有音频文件也不能影响摇骰 */ }
  }
  function $(id) { return document.getElementById(id); }

  /* ================= 存档 ================= */

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(G)); } catch (e) {}
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (!o || !o.players || !o.players.length) return false;
      if (o.players.length < MIN_P) return false;
      G.players = o.players;
      G.order = o.order || [];
      G.turn = o.turn | 0;
      G.round = o.round | 0;

      /* 手牌和「已收下的骰子」一起恢复 —— 退出再进来应该接着刚才那一把玩。
         以前这里一律把手牌清成空位，于是出现「本回合 300 分 + 桌上 7 个空位」：
         看着像新开的一局，分数却还是上一把的，玩家不知道这 300 分算不算数，
         也没有「重开一局」可按。 */
      G.taken = [];
      G.took = false;
      G.hand = blankHand();
      var hand = o.hand;
      if (hand && hand.length && hand.length <= DICE) {
        var h = [];
        for (var i = 0; i < hand.length; i++) {
          var v = (hand[i] && hand[i].v) | 0;
          if (v < 1 || v > 6) v = 0;
          h.push({ v: v, sel: !!(hand[i] && hand[i].sel && v) });
        }
        G.hand = h;
      }

      /* 分数和骰子必须对得上。老版本的存档只有 round、没有 taken，
         这种「没有骰子支撑的分数」直接丢掉，别让它变成一个孤零零的数字 */
      var taken = o.taken || [];
      var sum = 0;
      for (var j = 0; j < taken.length; j++) {
        if (taken[j] === 1) sum += 100;
        else if (taken[j] === 5) sum += 50;
      }
      /* 封顶之后 round 会截在 700，而 taken 还在接着累，所以到顶时按 >= 认 */
      var match = (sum === G.round) || (G.round >= CAP && sum >= CAP);
      if (match && taken.length) {
        G.taken = taken;
        G.took = !!o.took;
      } else if (G.round) {
        G.round = 0;
        G.hand = blankHand();
      }

      if (o.phase === 'over') {
        G.phase = 'over';
      } else if (liveHand().length) {
        /* 桌上有牌就回「可以点」的状态：刚才没来得及收的那几颗还点得动 */
        G.phase = 'rolled';
      } else {
        G.phase = 'ready';
      }
      if (G.phase === 'rolled') {
        if (G.took) hint('还剩 ' + liveHand().length + ' 颗 · 还能接着收，或者摇一摇');
        else hint('点要拿走的 1 和 5 · 不点的留在桌上继续摇');
      }
      return true;
    } catch (e) { return false; }
  }

  function savePlayerCount(n) {
    try { localStorage.setItem(STORE_P, String(n)); } catch (e) {}
  }
  function loadPlayerCount() {
    var n = parseInt(localStorage.getItem(STORE_P) || '', 10);
    return (n >= MIN_P && n <= MAX_P) ? n : 4;
  }

  /* ================= 局面 ================= */

  function blankHand() {
    var h = [];
    for (var i = 0; i < DICE; i++) h.push({ v: 0, sel: false });
    return h;
  }

  function newGame(n) {
    clearTimeout(S.timer);
    G.players = [];
    for (var i = 0; i < n; i++) {
      G.players.push({ name: (i + 1) + ' 号', score: 0, lion: 0, locked: false });
    }
    G.order = [];
    G.turn = 0;
    G.round = 0;
    G.taken = [];
    G.took = false;
    G.phase = 'ready';
    G.hand = blankHand();
    savePlayerCount(n);
    save();
    render();
  }

  function newTurn() {
    clearTimeout(S.timer);
    G.round = 0;
    G.taken = [];
    G.took = false;
    G.hand = blankHand();
    G.phase = 'ready';
    save();
    render();
  }

  function current() {
    return G.players[G.turn] || { name: '', score: 0, lion: 0, locked: false };
  }

  function liveHand() {
    var out = [];
    for (var i = 0; i < G.hand.length; i++) {
      if (G.hand[i].v) out.push(G.hand[i]);
    }
    return out;
  }

  function isLion(list) {
    if (list.length !== DICE) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].v !== 1 && list[i].v !== 5) return false;
    }
    return true;
  }

  /* ================= 动作 ================= */

  function onRoll() {
    if (G.phase === 'bust' || G.phase === 'over') return;
    if (!G.hand.length) G.hand = blankHand();

    // 摇就是摇桌上全部骰子，不区分「上一把留下的」和「新拿回来的」
    for (var i = 0; i < G.hand.length; i++) {
      G.hand[i].v = rollOne();
      G.hand[i].sel = false;
    }

    vibrate(18);
    playShake();
    G.took = false;
    G.phase = 'rolled';
    save();
    render();

    evaluate();
  }

  function evaluate() {
    var list = liveHand();
    if (!list.length) return;

    /* 豹子：7 颗全是 1 和 5 —— 记一次，分数清零，重新拿 7 颗继续摇 */
    if (isLion(list)) {
      current().lion = (current().lion || 0) + 1;
      G.round = 0;
      G.taken = [];
      G.took = false;
      G.hand = blankHand();
      G.phase = 'ready';
      save();
      render();
      hint('豹子 · 记 1 次，分数清零，重新摇', 'gold');
      vibrate([16, 60, 16, 60, 26]);
      return;
    }

    /* 爆掉：一个 1 也没有，一个 5 也没有 */
    var has = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].v === 1 || list[i].v === 5) { has = true; break; }
    }
    if (!has) {
      /* 爆掉不自动收：1.6 秒就清零的话，桌上好几个人还没看清点数就没了。
         现在结果留在桌上，等玩家自己按「清零重摇」—— 看够再走。 */
      G.round = 0;
      G.taken = [];
      G.took = false;
      G.phase = 'bust';
      save();
      render();
      hint('一个 1 和 5 都没有 · 分数清零 · 点「清零重摇」继续', 'warn');
      vibrate([40, 70, 40]);
      return;
    }

    hint('点要拿走的 1 和 5 · 不点的留在桌上继续摇');
  }

  function pickedSum() {
    var s = 0;
    for (var i = 0; i < G.hand.length; i++) {
      if (G.hand[i].v && G.hand[i].sel) s += pointsOf(G.hand[i].v);
    }
    return s;
  }

  function pickedCount() {
    var c = 0;
    for (var i = 0; i < G.hand.length; i++) {
      if (G.hand[i].v && G.hand[i].sel) c++;
    }
    return c;
  }

  function onPick() {
    if (G.phase !== 'rolled') return;
    var gain = pickedSum();
    if (!gain) { hint('先点一颗 1 或 5 再收', 'warn'); return; }

    var rest = [];
    for (var i = 0; i < G.hand.length; i++) {
      if (G.hand[i].v && G.hand[i].sel) G.taken.push(G.hand[i].v);  /* 被收走，摆到分数下面 */
      else rest.push({ v: G.hand[i].v, sel: false });
    }

    G.round = Math.min(CAP, G.round + gain);

    if (!rest.length) {
      // 一颗不剩：下一把重新从 7 颗开始
      G.hand = blankHand();
      G.phase = 'ready';
      G.took = false;
      hint('收完了 · 拿回 7 颗继续摇', 'good');
    } else {
      /* 留在「待选」相位而不是 ready：这一把桌上往往还有别的 1 和 5，
         收走一颗就把剩下的路堵死太别扭 —— 双击一颗、再点另一颗，照样能收。
         不想收了就按主按钮，它会变成「摇剩下 N 颗」。 */
      G.hand = rest;
      G.phase = 'rolled';
      G.took = true;
      hint('还剩 ' + rest.length + ' 颗 · 还能接着收，或者摇一摇');
    }
    vibrate(22);
    save();
    render();

    if (G.round >= CAP) {
      hint('到顶了 · 直接锁分', 'gold');
      S.timer = setTimeout(lockTurn, 640);
    }
  }

  function lockTurn() {
    if (G.phase === 'over') return;
    if (G.round < BASE) { hint('满 ' + BASE + ' 分才能收手', 'warn'); return; }
    var p = current();
    p.score = G.round;
    p.locked = true;
    G.order.push(G.turn);
    vibrate([14, 50, 14]);

    var next = -1;
    for (var i = 1; i <= G.players.length; i++) {
      var idx = (G.turn + i) % G.players.length;
      if (!G.players[idx].locked) { next = idx; break; }
    }

    if (next < 0) { finish(); return; }
    G.turn = next;
    newTurn();
  }

  function finish() {
    G.phase = 'over';
    clearTimeout(S.timer);
    save();
    render();
    showRank();
  }

  function rankList() {
    var arr = G.players.map(function (p, i) {
      var k = G.order.indexOf(i);
      return { name: p.name, score: p.score, lion: p.lion || 0, i: i, k: k < 0 ? 99 : k };
    });
    arr.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.k - b.k;      // 同分，先锁的排前面
    });
    return arr;
  }

  /* ================= 渲染 ================= */

  /* 350 自己的 toast：app.js 里那个在它自己的闭包里，跨文件拿不到 */
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1500);
  }

  function hint(text, cls) {
    if (!el.hint) return;
    el.hint.textContent = text;
    el.hint.className = 'f3-hint' + (cls ? ' ' + cls : '');
  }

  function renderDice() {
    var layer = el.dice;
    if (!layer) return;
    layer.innerHTML = '';
    var n = G.hand.length;
    var slots = layout(n);
    for (var i = 0; i < n; i++) {
      var it = slots[i], d = G.hand[i];
      var s = document.createElement('div');
      s.className = 'die-slot';
      s.setAttribute('data-i', String(i));
      s.style.left = rpx(it.l);
      s.style.top = rpx(it.t);
      s.style.setProperty('--ds', rpx(it.s));
      s.style.transform = 'rotate(' + it.r + 'deg) scaleY(0.86)';

      var box = document.createElement('div');
      box.className = 'die' + (d.v ? '' : ' blank');
      box.style.animationDelay = i * 26 + 'ms';

      if (d.v) {
        var cells = PIPS[d.v] || [];
        for (var c = 0; c < cells.length; c++) {
          var p = document.createElement('div');
          p.className = 'pip' + (RED[d.v] ? ' red' : '');
          p.style.left = CELL[cells[c] % 3] + '%';
          p.style.top = CELL[Math.floor(cells[c] / 3)] + '%';
          box.appendChild(p);
        }
        if (G.phase === 'rolled' && pointsOf(d.v)) {
          s.classList.add('countable');
          if (d.sel) s.classList.add('sel');
          var tag = document.createElement('i');
          tag.className = 'f3-val';
          tag.textContent = String(pointsOf(d.v));
          s.appendChild(tag);
        }
      }
      s.appendChild(box);
      layer.appendChild(s);
    }
  }

  function renderPlayers() {
    if (!el.strip) return;
    el.strip.innerHTML = '';
    for (var i = 0; i < G.players.length; i++) {
      var p = G.players[i];
      var div = document.createElement('div');
      div.className = 'p-card'
        + (i === G.turn && G.phase !== 'over' ? ' on' : '')
        + (p.locked ? ' done' : '');

      var nm = document.createElement('div');
      nm.className = 'p-name';
      nm.textContent = p.name;

      var sc = document.createElement('div');
      sc.className = 'p-score';
      sc.textContent = p.locked ? String(p.score) : '—';

      div.appendChild(nm);
      div.appendChild(sc);

      if (p.lion) {
        var l = document.createElement('div');
        l.className = 'p-lion';
        l.textContent = '豹子 ×' + p.lion;
        div.appendChild(l);
      }
      el.strip.appendChild(div);
    }
  }

  function renderScore() {
    if (!el.scoreNum) return;
    var v = G.round;
    if (el.scoreNum.textContent !== String(v)) {
      el.scoreNum.textContent = String(v);
      el.scoreNum.classList.remove('bump');
      void el.scoreNum.offsetWidth;
      el.scoreNum.classList.add('bump');
    }
    el.score.className = 'f3-score'
      + (v >= CAP ? ' max' : v >= BASE ? ' ok' : '');
  }

  /* 分数下面那排小骰子：本回合已经被收走的 1 和 5。
     分数只是个数字，「350」和「2 个 1 + 3 个 5」是两回事，
     把骰子摆出来才知道分是怎么攒起来的。
     封顶 700、每颗最少 50，所以一回合最多 14 颗，一行排得下。 */
  function renderTaken() {
    var box = el.taken;
    if (!box) return;
    var list = G.taken || [];
    /* 分数和颗数就能唯一确定这串骰子（100×1 的数 + 50×5 的数），
       没变就别重建 —— 否则每次 render 都会把动画重放一遍 */
    var key = list.length + '/' + G.round;
    if (box.getAttribute('data-key') === key) return;

    /* 目标：和桌面上那副一样大（layout() 算出来 16vw 上下）。
       但一排 14 颗、两排各 7 颗都要地方，小屏（375×667）+ 12 人时会把桌面挤没，
       所以先量「这一排不占地方时舞台有多高」，再挑一个放得下的方案：

         方案 A：全塞一排 —— 颗数多时每颗会变窄
         方案 B：均分两排 —— 每颗更大，但要多占一行高度

       两个都算出来，取骰子更大的那个；高度实在不够就按高度让步（最小 6vw），
       宁可小一点，也不让桌面被压到分数区上。
       88vw 是面板可用宽度（左右各 6vw 内边距），0.7 是下面 CSS 里的 gap。 */
    var n = list.length;
    var vw = window.innerWidth / 100;
    var room = 0;
    if (n && el.stage) {
      var wasHidden = box.hidden;
      box.hidden = true;                       // 这排不占地方，量个基线
      var stageH = el.stage.clientHeight;
      box.hidden = wasHidden;
      /* 桌子固定 50vw 高，上下再各留 4vw 余量 */
      room = Math.max(0, stageH - window.innerWidth * 0.5 - window.innerWidth * 0.08) / vw;
    }
    var fit = null;
    for (var ri = 1; ri <= 2; ri++) {
      var perRow = Math.ceil(n / ri);
      var byW = (88 - (perRow - 1) * 0.7) / perRow;
      var byH = room > 0 ? (room - (ri - 1) * 0.7) / ri : 16;
      var cand = Math.min(16, byW, byH);
      if (!fit || cand > fit.ds) fit = { ds: cand, rows: ri, perRow: perRow };
    }
    var ds = n ? Math.max(6, fit.ds) : 16;
    var rows = fit ? fit.rows : 1;
    var perRow = fit ? fit.perRow : n;
    box.style.setProperty('--ds', ds.toFixed(3) + 'vw');

    var prev = parseInt(box.getAttribute('data-n') || '0', 10);
    box.innerHTML = '';
    box.setAttribute('data-rows', String(rows));
    /* gap 和每行几颗都由 JS 排好，不能靠 flex-wrap 自己折 ——
       折出来每行颗数不均，第二行容易只剩一颗孤零零的 */
    var row = null;
    for (var i = 0; i < list.length; i++) {
      if (i % perRow === 0) {
        row = document.createElement('div');
        row.className = 'tk-row';
        box.appendChild(row);
      }
      var v = list[i];
      var w = document.createElement('div');
      /* 只有新收的那颗弹一下，前面几颗保持不动 */
      w.className = 'tk-die' + (i >= prev ? ' new' : '');
      var d = document.createElement('div');
      d.className = 'die';
      var cells = PIPS[v] || [];
      for (var c = 0; c < cells.length; c++) {
        var p = document.createElement('div');
        p.className = 'pip' + (RED[v] ? ' red' : '');
        p.style.left = CELL[cells[c] % 3] + '%';
        p.style.top = CELL[Math.floor(cells[c] / 3)] + '%';
        d.appendChild(p);
      }
      w.appendChild(d);
      row.appendChild(w);
    }
    box.hidden = !list.length;
    box.setAttribute('data-key', key);
    box.setAttribute('data-n', String(list.length));
  }

  function renderBtns() {
    if (!el.btns) return;
    el.btns.innerHTML = '';
    var list = [];

    if (G.phase === 'over') {
      list.push({ t: '再来一局', cls: 'primary', act: 'restart' });
    } else if (G.phase === 'rolled') {
      var gain = pickedSum();
      var left = liveHand().length;
      if (gain) {
        list.push({ t: '收下 ' + gain + ' 分', cls: 'primary', act: 'pick' });
      } else if (G.took) {
        /* 这一把已经收过了、现在一颗没选：主按钮直接给「继续摇」，
           否则玩家盯着一个灰的「点骰子收分」不知道下一步该干嘛 */
        list.push({
          t: left && left < DICE ? '摇剩下 ' + left + ' 颗' : '摇一摇',
          cls: 'primary',
          act: 'roll'
        });
      } else {
        list.push({ t: '点骰子收分', cls: 'primary is-off', act: 'pick' });
      }
    } else if (G.phase === 'bust') {
      list.push({ t: '清零重摇', cls: 'primary', act: 'bust' });
    } else {
      var left = liveHand().length;
      list.push({
        t: left && left < DICE ? '摇剩下 ' + left + ' 颗' : '摇一摇',
        cls: 'primary',
        act: 'roll'
      });
    }

    /* 爆掉时不给锁分：本局分数已经清 0，锁无可锁，
       留一个灰按钮在旁边只会让人以为还能点 */
    if (G.phase !== 'over' && G.phase !== 'bust') {
      var ok = G.round >= BASE;
      list.push({
        t: ok ? '锁 ' + G.round + ' 分' : '满 ' + BASE + ' 锁分',
        cls: 'ghost' + (ok ? '' : ' is-off'),
        act: ok ? 'lock' : 'none'
      });
    }

    for (var i = 0; i < list.length; i++) {
      var b = document.createElement('button');
      b.className = 'btn ' + list[i].cls;
      b.setAttribute('data-act', list[i].act);
      b.textContent = list[i].t;
      el.btns.appendChild(b);
    }
  }

  function render() {
    renderPlayers();
    renderDice();
    renderScore();
    renderTaken();
    renderBtns();
    /* 顶栏那个「N 人」：还没开局时显示上次选的人数 */
    if (el.pCount) el.pCount.textContent = (G.players.length || loadPlayerCount()) + ' 人';
    if (G.phase === 'ready' && !liveHand().length) {
      hint('满 ' + BASE + ' 才能收手 · 封顶 ' + CAP);
    }
  }

  /* ================= 弹层 ================= */

  function closeMask() {
    if (el.pop) { el.pop.style.display = 'none'; el.pop.innerHTML = ''; }
  }

  function openMask(html) {
    if (!el.pop) return;
    el.pop.innerHTML = '<div class="f3-sheet">' + html + '</div>';
    el.pop.style.display = 'flex';
  }

  /* 人数下拉：原地展开，选一个就生效，不用再按「开始」 */
  function buildPDrop() {
    var box = $('pDrop');
    if (!box) return;
    var cur = G.players.length;
    var h = '';
    for (var n = MIN_P; n <= MAX_P; n++) {
      h += '<button class="drop-item' + (n === cur ? ' on' : '') + '" type="button"'
        + ' data-n="' + n + '">' + n + '</button>';
    }
    /* 打到一半想重来（或者中途退出、回来想重新开局），总得有个入口。
       点同一档人数是不重开的，光靠它等于没有「新开一把」。 */
    if (cur) {
      h += '<button class="drop-redo" type="button" data-redo="1">'
        + '重开一局 · 分数清零</button>';
    }
    box.innerHTML = h;
  }

  function pDropOpen() {
    var box = $('pDrop');
    return !!box && !box.hidden;
  }

  /* 吹牛页那个数量下拉归 app.js 管，这边只问一句开没开 */
  function countOpen() {
    return !!(window.LDCount && window.LDCount.isOpen());
  }

  function openPDrop() {
    buildPDrop();
    var box = $('pDrop');
    var shade = $('pShade');
    if (box) box.hidden = false;
    if (shade) shade.hidden = false;
    var btn = $('pCountBtn');
    if (btn) btn.classList.add('on');      // 箭头翻个面，表示「再点一下收起」
  }

  function closePDrop() {
    var box = $('pDrop');
    var shade = $('pShade');
    if (box) box.hidden = true;
    if (shade) shade.hidden = true;
    var btn = $('pCountBtn');
    if (btn) btn.classList.remove('on');
    /* 一次都没选过就想关掉：给个默认人数，别留一张 0 人的空桌 */
    if (!G.players.length) newGame(loadPlayerCount());
  }

  function setPlayers(n) {
    var had = G.players.length;
    closePDrop();
    if (had === n) { toast('还是 ' + n + ' 人，没动'); return; }
    newGame(n);
    if (had) toast('已改成 ' + n + ' 人 · 重新开局');
    else toast(n + ' 人 · 开始');
  }

  function showRank() {
    var arr = rankList();
    var rows = '';
    for (var i = 0; i < arr.length; i++) {
      rows += '<div class="f3-row' + (i === 0 ? ' win' : '') + '">'
        + '<span class="f3-row-no">' + (i + 1) + '</span>'
        + '<span class="f3-row-name">' + arr[i].name + (arr[i].lion ? ' · 豹子×' + arr[i].lion : '') + '</span>'
        + '<span class="f3-row-score">' + arr[i].score + '</span>'
        + '</div>';
    }
    openMask(
      '<span class="f3-sheet-title">' + arr[0].name + ' 赢</span>' +
      '<span class="f3-sheet-sub">同分先收手的排前面</span>' +
      '<div class="f3-rank">' + rows + '</div>' +
      '<button class="btn primary" data-act="restart">再来一局</button>'
    );
  }

  /* ================= 事件 ================= */

  function onDieTap(e) {
    if (G.phase !== 'rolled') return;
    var t = e.target;
    while (t && t !== el.dice && !t.classList.contains('die-slot')) t = t.parentNode;
    if (!t || t === el.dice) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    var d = G.hand[i];
    if (!d || !pointsOf(d.v)) return;      // 只有 1 和 5 能点

    /* 连点两下同一颗 = 选中它并立刻收下，省掉「先点骰子再按收下」两步。
       320ms 是双指的常见阈值：比系统双击判定稍宽，手指粗一点也能触发，
       但慢到能看出是两次独立点击时又不会误收。 */
    var now = Date.now();
    var dbl = (S.lastTapIdx === i && now - S.lastTapAt < 320);
    S.lastTapIdx = i;
    S.lastTapAt = now;

    if (dbl) {
      d.sel = true;                        // 双击一定把点到的这颗算进去
      renderDice();
      renderBtns();
      vibrate(10);
      onPick();
      return;
    }

    d.sel = !d.sel;
    vibrate(10);
    renderDice();
    renderBtns();
    var s = pickedSum();
    hint(s ? '已选 ' + s + ' 分 · 点「收下」才算（连点两下可直接收）' : '还没选 · 点要拿走的骰子');
  }

  function onBtn(e) {
    var t = e.target;
    while (t && t !== el.btns && !t.getAttribute('data-act')) t = t.parentNode;
    if (!t || t === el.btns) return;
    var act = t.getAttribute('data-act');
    if (act === 'roll') onRoll();
    else if (act === 'pick') onPick();
    else if (act === 'lock') lockTurn();
    else if (act === 'bust') {
      /* 玩家自己按的：拿回 7 颗、清掉桌上结果，还是他摇 */
      G.hand = blankHand();
      G.phase = 'ready';
      G.took = false;
      save();
      render();
      hint('拿回 ' + DICE + ' 颗 · 摇一摇继续');
    }
    else if (act === 'restart') restart();
  }

  function restart() {
    closeMask();
    S.timer && clearTimeout(S.timer);
    G.round = 0;
    G.taken = [];
    G.took = false;
    G.phase = 'ready';
    G.turn = 0;
    G.hand = blankHand();
    for (var i = 0; i < G.players.length; i++) {
      G.players[i].score = 0;
      G.players[i].locked = false;
      G.players[i].lion = 0;
    }
    G.order = [];
    save();
    render();
  }

  /* 弹层里现在只剩结算榜的「再来一局」；人数早就改到顶栏的原地下拉了 */
  function onMaskTap(e) {
    var t = e.target;
    if (t.getAttribute('data-act') === 'restart') { restart(); return; }
    if (t === el.pop) closeMask();
  }

  /* ================= 启动 ================= */

  function boot() {
    el.strip = $('pStrip');
    el.dice = $('f3Dice');
    el.stage = document.querySelector('.f3-stage');
    el.score = $('f3ScoreBox');
    el.scoreNum = $('f3ScoreNum');
    el.taken = $('f3Taken');
    el.hint = $('f3Hint');
    el.btns = $('f3Btns');
    el.pop = $('f3Mask');
    el.pCount = $('pCountTxt');
    if (!el.dice) return;

    var pc = $('pCountBtn');
    if (pc) pc.addEventListener('click', function () {
      if (pDropOpen()) closePDrop(); else openPDrop();
    });
    var shade = $('pShade');
    if (shade) shade.addEventListener('click', closePDrop);
    var drop = $('pDrop');
    if (drop) drop.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== drop && !t.getAttribute('data-n') && !t.getAttribute('data-redo')) {
        t = t.parentNode;
      }
      if (!t || t === drop) return;
      if (t.getAttribute('data-redo')) {
        closePDrop();
        var n = G.players.length || loadPlayerCount();
        newGame(n);
        toast('已重开 · ' + n + ' 人');
        return;
      }
      setPlayers(parseInt(t.getAttribute('data-n'), 10));
    });

    el.dice.addEventListener('click', onDieTap);
    el.btns.addEventListener('click', onBtn);
    el.pop.addEventListener('click', onMaskTap);

    /* 三层导航，各管各的：首页选模式、单人页选玩法、玩法页只负责玩。
       以前把「350 玩法」塞在玩法页底栏，等于让玩家在玩法之间横跳，
       现在统一退回上一层去挑，结构才立得住。 */
    var solo = $('modeSolo');
    if (solo) solo.addEventListener('click', function () { switchTo('solo'); });
    var net = $('modeNet');
    if (net) net.addEventListener('click', function () {
      showHomeTip('联机还在做 · 一台手机当主机，其他人连同一个网');
    });

    var backHome = $('soloBack');
    if (backHome) backHome.addEventListener('click', function () { switchTo('home'); });

    var pLiar = $('playLiar');
    if (pLiar) pLiar.addEventListener('click', function () { switchTo('liar'); });
    var pF350 = $('playF350');
    if (pF350) pF350.addEventListener('click', function () { switchTo('f350'); });

    /* 底栏「← 返回」= 退到上一层，跟系统返回键同一个效果 */
    var b1 = $('toSolo');
    if (b1) b1.addEventListener('click', function () { switchTo('solo'); });
    var b2 = $('toSolo2');
    if (b2) b2.addEventListener('click', function () { switchTo('solo'); });

    /* 玩法说明：底栏进去，点空白 / 关闭出来 */
    var r1 = $('ruleBtn');
    if (r1) r1.addEventListener('click', function () { openRules('liar'); });
    var r2 = $('ruleBtn2');
    if (r2) r2.addEventListener('click', function () { openRules('f350'); });
    var rc = $('ruleClose');
    if (rc) rc.addEventListener('click', function () { closeRules(); });
    var rm = $('ruleMask');
    if (rm) rm.addEventListener('click', function (e) {
      /* 只有点在遮罩本身（卡片外面）才关，点卡片内部不关 */
      if (e.target === rm) closeRules();
    });

    if (load()) {
      render();
    } else {
      // 还没开过局：先把 350 这一页摆成空盘，等真的切过去再问人数，
      // 否则在吹牛模式下也会被遮罩挡住
      el.strip.innerHTML = '';
      el.dice.innerHTML = '';
      renderBtns();
    }

    // 启动一律停在首页：先选单机 / 联机，再进玩法。
    // 上次玩哪个玩法只在「单人模式」里生效（ld_last_play），别在这里直接跳过去。
    applyPage('home');
    /* 刷新时可能还带着 #f350 之类的旧 hash，直接改成 #home，
       否则第一下返回会先跳回那个旧页面，看着像乱跳 */
    if ((location.hash || '') !== '#home') {
      try { location.replace('#home'); } catch (e) {}
    }
  }

  /* 每一层往上退到哪：玩法页 -> 选玩法，选玩法 -> 首页，首页没有上一级 */
  var PARENT = { home: null, solo: 'home', liar: 'solo', f350: 'solo' };
  var DEPTH = { home: 0, solo: 1, liar: 2, f350: 2 };

  function curMode() {
    return document.body.getAttribute('data-mode') || 'home';
  }

  /* 只切界面，不碰地址栏 */
  function applyPage(mode) {
    document.body.setAttribute('data-mode', mode);

    var pages = {
      home: document.querySelector('.page-home'),
      solo: document.querySelector('.page-solo'),
      liar: document.querySelector('.page-liar'),
      f350: document.querySelector('.page-f350')
    };
    for (var k in pages) {
      if (pages[k]) pages[k].hidden = (k !== mode);
    }

    /* 离开 350 就把人数弹层收掉：它挂在 body 上，页面藏了它还会浮着 */
    if (mode !== 'f350' && el.pop && el.pop.style.display === 'flex') closeMask();

    /* ld_mode 记"当前在哪一页"，ld_last_play 只记"上次玩哪个玩法"。
       两个混用就会出现「从首页进来被跳过首页」那种 bug，别合。 */
    try { localStorage.setItem('ld_mode', mode); } catch (e) {}
    if (mode === 'liar' || mode === 'f350') {
      try { localStorage.setItem('ld_last_play', mode); } catch (e) {}
    }

    /* 选玩法那一页给上次玩的挂个角标：只是提示，不自动跳。
       一自动跳，中间这一层就又成了摆设，等于回到改之前。 */
    if (mode === 'solo') markLastPlay();

    /* 第一次进来还没有人：直接把人数下拉摊开，别弹一个挡屏的框 */
    if (mode === 'f350' && !G.players.length && !pDropOpen()) {
      openPDrop();
      hint('先选几个人 · 4~12 人，每人一把');
    }

    /* 吹牛那边的数量下拉是 app.js 自己管的，切走时让它收起来 */
    if (mode !== 'liar' && window.LDCount && window.LDCount.isOpen()) {
      window.LDCount.close();
    }
  }

  var navTimer = null;

  /* 切页 + 同步 hash。
     为什么非要改 hash：安卓壳的返回键只看 webView.canGoBack()，
     单页应用不产生历史条目，于是侧滑一下直接退出 App。
     压一条 #solo / #f350 之后，系统返回就能一格一格退。

     往下走压一条新历史；往上退则直接调 history.back()，
     让「页内返回」和「系统返回」消费同一条记录 —— 早先用 replace 改写当前条目，
     会让下一层压在同一条地址上，按返回时 hash 没变、看着像没反应。 */
  function switchTo(mode) {
    var cur = curMode();
    if (mode === cur) return;

    if ((DEPTH[mode] || 0) > (DEPTH[cur] || 0)) {
      applyPage(mode);
      try { location.hash = mode; } catch (e) {}
      return;
    }

    var before = location.hash || '';
    try { history.back(); } catch (e) {}
    clearTimeout(navTimer);
    navTimer = setTimeout(function () {
      /* 退不动（比如直接带着 #f350 打开）：自己补一次，别让按钮点了没反应 */
      if ((location.hash || '') === before) {
        applyPage(mode);
        try { location.replace('#' + mode); } catch (e) {}
      }
    }, 150);
  }

  /* 弹层被返回键关掉后，把地址补回当前层。
     用 forward() 而不是 replace()，这样那条历史还在，再按返回才不会跳层。 */
  function restoreHash(mode) {
    var want = '#' + mode;
    if ((location.hash || '') === want) return;
    try { history.forward(); } catch (e) {}
    clearTimeout(navTimer);
    navTimer = setTimeout(function () {
      if ((location.hash || '') !== want) {
        try { location.replace(want); } catch (e) {}
      }
    }, 150);
  }

  /* 系统返回键 / 手势退回来时走这里：地址已经变了，只需要把界面切过去 */
  window.addEventListener('hashchange', function () {
    var m = (location.hash || '').replace('#', '') || 'home';
    if (!DEPTH.hasOwnProperty(m)) m = 'home';

    /* 只有"真的往回退"才关弹层：往里进的时候 hash 也会变一次，
       那时候弹层刚开（比如 350 的人数），不能被自己顺手关掉 */
    var goingBack = (m !== curMode());
    if (goingBack && (ruleOpen() || pDropOpen() || countOpen() ||
                      (el.pop && el.pop.style.display === 'flex'))) {
      if (ruleOpen()) closeRules();
      else if (pDropOpen()) closePDrop();
      else if (countOpen()) window.LDCount.close();
      else closeMask();
      /* 把地址补回当前页，页面留在原层不动 */
      restoreHash(curMode());
      return;
    }

    applyPage(m);
  });

  function markLastPlay() {
    var last = null;
    try { last = localStorage.getItem('ld_last_play'); } catch (e) {}
    var badges = { liar: $('badgeLiar'), f350: $('badgeF350') };
    for (var k in badges) {
      /* 一次都没玩过时一个都不显示：默认给吹牛挂「上次玩的」是撒谎 */
      if (badges[k]) badges[k].hidden = (k !== last);
    }
  }

  /* 联机先占位：真做的时候主机必须是安卓端（它能监听端口），
     手机浏览器和 iPhone 只能当客户端。这里只给一句实话，别画饼。 */
  var tipTimer = null;
  function showHomeTip(msg) {
    var t = document.getElementById('homeTip');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  /* ================= 玩法说明 =================
     规则写在 App 里，省得每次开局都要口头讲一遍。
     措辞跟代码对齐：350 的爆掉/豹子/封顶都按 f350.js 里的实际判定写，
     吹牛这边 App 只负责摇和盖，胜负在桌上算，所以只写通用打法。 */
  var RULES = {
    liar: {
      title: '吹牛骰子 · 怎么玩',
      lead: '一台手机当骰盅，摇完盖着，谁也没看见点数 —— 接下来全靠嘴。',
      steps: [
        ['摇一摇', '骰盅抖一下，点数这时候就定好了，盖子仍然合着。'],
        ['掀盖', '捏住盖子往上滑，跟手停，可以只开一条缝当挡板偷偷看一眼。合回去点数不丢，能反复开合。'],
        ['锁定', '本局定板，盅口亮金边、出现「已锁定」，这一把不能再摇。']
      ],
      rules: [
        '每人一副骰子（本机默认 5 颗，可调 2~10 颗），各看各的，别让旁边人瞄到。',
        '1 点是万能点，可以当任何点数用。除非这局喊了「斋」，斋了 1 就只是 1。',
        '从「2 个 3」这类叫法开始，轮流往上叫，一次比一次大：个数更多，或者个数相同、点数更大。',
        '轮到你时信不过上家，就喊「开」。全场亮盅一起数：够数，开的人喝；不够，喊的人喝。',
        '一局结束重新摇，接着来。'
      ],
      note: 'App 只管摇和盖，输赢在桌上算。斋、豹子、顺子这些讲究各地不一样，开打前先说好规矩。'
    },
    f350: {
      title: '潮汕 350 · 怎么玩',
      lead: '不要盖子，7 颗明骰摊在桌上，谁都看得见 —— 比的是敢不敢继续摇。',
      steps: [
        ['摇', '7 颗一起摇出来，明着摊开。'],
        ['点要拿的', '1 点算 100 分、5 点算 50 分，其余不计分。点哪颗才拿走哪颗，不点就留在桌上继续摇。'],
        ['收下 / 锁分', '分数实时累加，满 350 才能锁，锁了就轮到下一位。连点两下同一颗可以直接收。']
      ],
      rules: [
        '拿一颗就少一颗。所以经常会放着 50 分不拿，把 5 留在桌上凑数量，继续搏 1 点。',
        '一把里一个 1、一个 5 都没有 = 爆掉：本回合分数清零，拿回 7 颗重摇，还是你摇，不换人。',
        '7 颗全是 1 和 5 = 豹子：记一次豹子（只做记录，不影响输赢），分数清零，继续摇。',
        '封顶 700 分，到顶自动锁，不用手动点。',
        '比锁定的最终分数，高者赢；同分时先收手的排前面。'
      ],
      note: '人数 2~6 人，开局时选；想改点右上角的「N 人」，换了人数会重开一局。点错了再点一次取消要隔开一下 —— 连点两下会被当成「直接收」。'
    }
  };

  function openRules(key) {
    var r = RULES[key];
    var mask = $('ruleMask');
    if (!r || !mask) return;
    $('ruleTitle').textContent = r.title;

    var h = '<div class="rule-lead">' + r.lead + '</div>';
    h += '<div class="rule-sec"><div class="rule-sec-t">操作</div>';
    for (var i = 0; i < r.steps.length; i++) {
      h += '<div class="rule-li"><i>' + (i + 1) + '</i><span><b>' + r.steps[i][0] +
           '</b>' + r.steps[i][1] + '</span></div>';
    }
    h += '</div><div class="rule-sec"><div class="rule-sec-t">规则</div>';
    for (var j = 0; j < r.rules.length; j++) {
      h += '<div class="rule-li"><em></em><span>' + r.rules[j] + '</span></div>';
    }
    h += '</div><div class="rule-note">' + r.note + '</div>';

    $('ruleBody').innerHTML = h;
    mask.style.display = 'flex';
    /* 每次重开都从头滚：上一次翻到最底，下次进来还停在最底很怪 */
    var sheet = mask.querySelector('.rule-sheet');
    if (sheet) sheet.scrollTop = 0;
  }

  function closeRules() {
    var mask = $('ruleMask');
    if (mask) mask.style.display = 'none';
  }

  function ruleOpen() {
    var mask = $('ruleMask');
    return !!mask && mask.style.display === 'flex';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 给外部（index.html 的首次进入）用
  window.F350 = { switchTo: switchTo, openPDrop: openPDrop };

  /* 只在 ?test=1 时挂出来：自动化测试要能指定点数，
     否则「摇到豹子」「摇到爆」这种分支根本没法稳定复现。 */
  if (location.search.indexOf('test=1') >= 0) {
    window.F350.__t = {
      G: G,
      setHand: function (vals) {
        G.hand = vals.map(function (v) { return { v: v, sel: false }; });
        G.took = false;
        G.phase = 'rolled';
        // 提示文字必须跟着改：只换手牌不改提示的话，
        // 截图/截图检查会看到「剩 5 颗」配 6 颗骰子，看起来像 bug，其实是钩子自己的错。
        hint('点要拿走的 1 和 5 · 不点的留在桌上继续摇');
        render();
        return G.hand.length;
      },
      setRound: function (v) { G.round = v; render(); },
      evalNow: evaluate,
      state: function () {
        return {
          phase: G.phase, round: G.round, turn: G.turn,
          taken: (G.taken || []).slice(),
          hand: G.hand.map(function (x) { return x.v; }),
          sel: G.hand.map(function (x) { return !!x.sel; }),
          players: G.players.map(function (p) {
            return { name: p.name, score: p.score, lion: p.lion || 0, locked: p.locked };
          })
        };
      },
      roll: onRoll, pick: onPick, lock: lockTurn, restart: restart,
      newGame: newGame
    };
  }
})();

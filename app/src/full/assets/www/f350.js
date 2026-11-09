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

      /* 豹子 / 爆掉都是「结果留在桌上等人按清零重摇」的状态，
         这两步不能当成「可以接着收」恢复 —— 骰子还摆着，但一颗都不该点得动。 */
      if (o.phase === 'over') {
        G.phase = 'over';
      } else if (o.phase === 'lion' && (liveHand().length || G.taken.length === DICE)) {
        /* 整轮收齐的豹子桌面是空的（7 颗都在「已收下」那一排），
           只认 liveHand 会把它当成 ready，白丢一次选择 */
        G.phase = 'lion';
      } else if (o.phase === 'bust' && liveHand().length) {
        G.phase = 'bust';
      } else if (liveHand().length) {
        /* 桌上有牌就回「可以点」的状态：刚才没来得及收的那几颗还点得动 */
        G.phase = 'rolled';
      } else {
        G.phase = 'ready';
      }
      if (G.phase === 'lion') {
        hint(o.lionPure ? '正豹！其他每人喝 2 杯 · 收下换人，或清零重摇'
                        : '15 豹！其他每人喝 1 杯 · 收下换人，或清零重摇', 'gold');
      } else if (G.phase === 'bust') {
        hint(bustText(liveHand().length), 'warn');
      } else if (G.phase === 'rolled') {
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
    /* 重开完了，顶栏那颗按钮要从「确定重开？」退回「重开」 */
    redoIdle();
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

  /* 正豹 = 清一色 1 或者清一色 5；混着 1 和 5 叫 15 豹。
     两种豹子判断口径必须一致，所以抽出来，别一处一处抄。 */
  function lionPureOf(values) {
    if (!values.length) return false;
    var one = true, five = true;
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== 1) one = false;
      if (values[i] !== 5) five = false;
    }
    return one || five;
  }

  /* ================= 动作 ================= */

  function onRoll() {
    if (G.phase === 'bust' || G.phase === 'lion' || G.phase === 'over') return;
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

    /* 留一份最近 12 把的底：豹子这条反复有人说「明明全是 1 和 5，就是不弹」，
       光看代码猜不出当时桌上到底几颗、收过几颗。这一行把现场留下来，
       下次直接从手机存档里读，不用再靠猜。每项 = [点数串, 已收颗数, 桌上颗数]。 */
    var vs = '';
    for (var r = 0; r < list.length; r++) vs += list[r].v;
    G.rolls = (G.rolls || []).concat([[vs, G.taken.length, list.length]]).slice(-12);

    /* 豹子：7 颗全是 1 和 5 —— 记一次，分数清零，重新拿 7 颗继续摇。
       正豹（清一色 1 或 5）比 15 豹更狠：桌上其他人喝 2 杯，15 豹喝 1 杯，
       摇的人自己不喝 —— 所以有人会专门去拼。 */
    if (isLion(list)) {
      var vals = [];
      for (var q = 0; q < list.length; q++) vals.push(list[q].v);
      var pure = lionPureOf(vals);
      G.lionPure = pure;
      current().lion = (current().lion || 0) + 1;
      G.took = false;
      /* 豹子停在桌上，给人两个选择：
           ① 认账 -> 「收下 X 分 · 换人」，这一把的 1 和 5 全算分（7 颗最少 350、最多 700），收完直接锁
           ② 不认 -> 「清零重摇」，分数归零、拿回 7 颗，还是他摇
         以前这里一律清零，等于替玩家做了决定：明明摇出全桌最大的牌，分数却没了。 */
      G.phase = 'lion';
      save();
      render();
      hint(pure ? '正豹！其他每人喝 2 杯 · 收下换人，或清零重摇'
                : '15 豹！其他每人喝 1 杯 · 收下换人，或清零重摇', 'gold');
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
      hint(bustText(list.length), 'warn');
      vibrate([40, 70, 40]);
      return;
    }

    hint('点要拿走的 1 和 5 · 不点的留在桌上继续摇');
  }

  /* 豹子这一手收下能落多少分：已经收下的（G.round）加上桌上还摆着的。
     一把摇出的豹子 round 是 0，分全在那 7 颗上；整轮收齐的豹子桌面已空，
     分全在 round 里 —— 两种豹子用同一个数，不长两张皮。 */
  function lionGain() {
    var list = liveHand(), g = 0;
    for (var i = 0; i < list.length; i++) g += pointsOf(list[i].v);
    return Math.min(CAP, G.round + g);
  }

  /* 爆掉的文案：一把里一个 1 一个 5 都没有就喝 1 杯；
     但如果这一把是「7 颗全摇」（本回合还没收过骰子、桌上满 7 颗），规矩是喝双倍。
     默认杯数写在玩法说明里，这里只是把它念出来，不改任何判定。 */
  function bustText(n) {
    return n >= DICE
      ? '爆了 · 7 颗全摇 · 喝双倍 2 杯 · 分数清零，点「清零重摇」继续'
      : '爆了 · 喝 1 杯 · 分数清零，点「清零重摇」继续';
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
      /* 整轮 7 颗全收下 —— 这就是「第二种豹子」。
         7 颗能全收下来，说明颗颗都是 1 或 5（别的点数根本收不走），跟一把摇出豹子
         是同一手牌，只是一次摇完还是分两三次摇完的区别。
         以前这里直接翻篇：分数留在 G.round、骰子变回 7 个空位，玩家还没反应过来
         这一把就结束了，更没有「收下换人 / 清零重摇」可点 —— 手机上一路玩下来，
         最常见的「我明明收齐了一手 1 和 5，怎么没弹豹子」就是卡在这一行。 */
      if (G.taken.length === DICE) {
        G.hand = blankHand();
        G.phase = 'lion';
        G.took = false;
        G.lionPure = lionPureOf(G.taken);
        current().lion = (current().lion || 0) + 1;
        save();
        render();
        hint(G.lionPure ? '正豹！其他每人喝 2 杯 · 收下换人，或清零重摇'
                        : '15 豹！其他每人喝 1 杯 · 收下换人，或清零重摇', 'gold');
        vibrate([16, 60, 16, 60, 26]);
        return;
      }
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
    } else if (G.phase === 'lion') {
      list.push({ t: '收下 ' + lionGain() + ' 分', cls: 'primary', act: 'liontake' });
      list.push({ t: '清零重摇', cls: 'ghost', act: 'bust' });
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
    if (G.phase !== 'over' && G.phase !== 'bust' && G.phase !== 'lion') {
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

    /* 底栏照旧摆着，但豹子还要另外压一层弹窗：见 syncLion 上面的说明 */
    syncLion();
  }

  /* ================= 豹子：弹窗二选一 =================

     豹子是这局最值钱、也最容易被看漏的一手。以前只在底栏换两个按钮，
     摇完盯着桌上骰子数点的人根本不会往下看，回过神来以为「摇出豹子没得选」。
     现在摇出豹子直接压一层：只给两条路，二选一才继续，谁也漏不掉。

     底栏那两个同名按钮保留（自动化测试和老习惯都还指着它们），和弹窗走同一份实现，
     不会出现「底栏收下 550、弹窗收下别的数」这种两张皮。
     点空白处不关 —— 这不是提示，是要拿主意。 */
  var lionEl = null;

  /* 弹窗里也要再摆一遍这 7 颗：整张卡片压下去，桌上那排被遮得七七八八，
     玩家这时候只看得见一个分数，看不见自己摸的到底是什么牌 ——
     想确认「这真是豹子吗」「到底是正豹还是 15 豹」，还得把手机歪着从缝里看。
     点数用同一套 PIPS / CELL / RED 画（跟桌面、跟「已收下」那排一模一样），
     不会出现弹窗画 5 点、桌上是 4 点这种对不上的事。 */
  function lionDiceHtml(values) {
    var h = '';
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      h += '<div class="lion-die"><div class="die">';
      var cells = PIPS[v] || [];
      for (var c = 0; c < cells.length; c++) {
        h += '<div class="pip' + (RED[v] ? ' red' : '') + '" style="left:' +
          CELL[cells[c] % 3] + '%;top:' + CELL[Math.floor(cells[c] / 3)] + '%"></div>';
      }
      h += '</div></div>';
    }
    return h;
  }

  function lionNode() {
    if (lionEl) return lionEl;
    var m = document.createElement('div');
    m.className = 'lion-mask';
    m.id = 'lionMask';
    m.style.display = 'none';
    m.innerHTML =
      '<div class="lion-card">' +
        '<div class="lion-t">豹子！</div>' +
        '<div class="lion-s" id="lionSub"></div>' +
        '<div class="lion-v"><b id="lionGain">0</b><span>分</span></div>' +
        /* 这一手到底是哪 7 颗：画在分数下面，省得回头看桌子 */
        '<div class="lion-dice" id="lionDice"></div>' +
        /* 两个按钮各写一句「按下去会发生什么」：分数怎么走、要不要换人。
           喝酒那条不写在按钮上 —— 豹子的酒跟选哪个无关，写在这容易被读成
           「清零才有人喝」，所以单独一句话放在按钮上面。 */
        '<div class="lion-n">喝酒跟选哪个无关：豹子的酒照喝，选完继续</div>' +
        '<div class="lion-btns">' +
          '<button class="lion-b primary" data-lion="take" id="lionTake">' +
            '<b class="lb-main">收下 0 分</b>' +
            '<span class="lb-sub">分数进账 · 锁分换下一位</span>' +
          '</button>' +
          '<button class="lion-b ghost" data-lion="bust" id="lionBust">' +
            '<b class="lb-main">清零重摇</b>' +
            '<span class="lb-sub">这一手的分不要了 · 还是你摇</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== m && !t.getAttribute('data-lion')) t = t.parentNode;
      if (!t || t === m) return;
      if (t.getAttribute('data-lion') === 'take') lionTake();
      else doBust();
    });
    lionEl = m;
    return m;
  }

  function closeLion() {
    if (!lionEl) return;
    lionEl.style.display = 'none';
    /* 关掉就把骰子的缓存标记清掉：下一把豹子哪怕是同样 7 颗，
       也要重新建一次，进场动画才跟着卡片一起出来 */
    var dz = lionEl.querySelector('#lionDice');
    if (dz) dz.removeAttribute('data-k');
  }

  function syncLion() {
    if (G.phase !== 'lion') { closeLion(); return; }
    var m = lionNode();
    var g = lionGain();
    /* 正豹 / 15 豹 从这一手现算：一把摇出来的看桌上那 7 颗，
       整轮收齐的看 already 收下的 7 颗（那会儿桌面已经空了） */
    var list = liveHand(), vals = [];
    for (var i = 0; i < list.length; i++) vals.push(list[i].v);
    var fromTable = vals.length > 0;
    var pure = fromTable ? lionPureOf(vals) : lionPureOf(G.taken);
    var who = pure ? '正豹 · 桌上其他人每人 2 杯' : '15 豹 · 桌上其他人每人 1 杯';
    if (!fromTable) who += ' · 整轮 7 颗收齐';
    var sub = m.querySelector('#lionSub');
    var gain = m.querySelector('#lionGain');
    var take = m.querySelector('#lionTake');
    if (sub) sub.textContent = who;
    if (gain) gain.textContent = g;
    if (take) {
      var t = take.querySelector('.lb-main');
      if (t) t.textContent = '收下 ' + g + ' 分';
    }
    /* 骰子按点数串缓存：没换牌就别重建，否则每次 render 都把进场动画重放一遍 */
    var dz = m.querySelector('#lionDice');
    if (dz) {
      var shown = fromTable ? vals : (G.taken || []);
      var dk = shown.join('-');
      if (dz.getAttribute('data-k') !== dk) {
        dz.innerHTML = lionDiceHtml(shown);
        dz.setAttribute('data-k', dk);
      }
    }
    m.style.display = 'flex';
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

  /* 人数下拉：原地展开，选一个就生效，不用再按「开始」。
     「重开一局」以前挂在这块最下面，现在搬到顶栏了（见 nav-right 那段注释）——
     两处都能重开只会让人以为「重开」分两种，而且这边当年是一点就清分，没有二次确认。 */
  function buildPDrop() {
    var box = $('pDrop');
    if (!box) return;
    var cur = G.players.length;
    var h = '';
    for (var n = MIN_P; n <= MAX_P; n++) {
      h += '<button class="drop-item' + (n === cur ? ' on' : '') + '" type="button"'
        + ' data-n="' + n + '">' + n + '</button>';
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
    /* 没有玩家就没什么好排的。理论上走不到这儿（进 350 时已经建好桌），
       但真到了这一步也不能让它抛异常 —— 一抛，界面就停在旧按钮上。 */
    if (!arr.length) { if (G.players.length < 1) newGame(loadPlayerCount()); return; }
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
      '<span class="f3-sheet-sub">同分先收手的排前面 · 最低的喝 2 杯</span>' +
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
    else if (act === 'liontake') lionTake();
    else if (act === 'bust') doBust();
    else if (act === 'restart') restart();
  }

  /* 豹子的两条路，弹窗和底栏按钮共用同一份实现，免得两边行为悄悄跑偏 */
  function lionTake() {
    /* 认这一把豹子：1 和 5 全算分，收完直接锁，换下一位。
       lionGain() 已经含了 G.round，这里别再叠加一次。 */
    G.round = lionGain();
    G.took = true;
    closeLion();
    render();
    lockTurn();
  }

  function doBust() {
    /* 玩家自己按的：拿回 7 颗、清掉桌上结果，还是他摇。
       豹子走这条时分数也要一起清 —— 按钮上写的就是「清零重摇」。 */
    G.hand = blankHand();
    G.round = 0;
    G.taken = [];
    G.phase = 'ready';
    G.took = false;
    closeLion();
    save();
    render();
    hint('拿回 ' + DICE + ' 颗 · 摇一摇继续');
  }

  /* 顶栏「重开」的二次确认状态：3 秒没人点就自己退回 */
  var redoAsk = 0;
  function redoIdle() {
    clearTimeout(redoAsk);
    var rb = $('redoBtn');
    if (!rb) return;
    rb.classList.remove('ask');
    rb.textContent = '重开';
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

    /* 顶栏那颗「重开」：点第一下只把按钮换成「确定重开？」，
       3 秒内再点一下才真清分 —— 清分不可逆，手指在顶栏滑一下不该把一桌人的分抹了。
       超时没点、或者离开 350 页，都自动恢复成「重开」。 */
    var rb = $('redoBtn');
    if (rb) rb.addEventListener('click', function () {
      if (rb.classList.contains('ask')) {
        var n = G.players.length || loadPlayerCount();
        newGame(n);
        toast('已重开 · ' + n + ' 人');
        return;
      }
      rb.classList.add('ask');
      rb.textContent = '确定重开？';
      redoAsk = setTimeout(redoIdle, 3000);
    });
    var shade = $('pShade');
    if (shade) shade.addEventListener('click', closePDrop);
    var drop = $('pDrop');
    if (drop) drop.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== drop && !t.getAttribute('data-n')) {
        t = t.parentNode;
      }
      if (!t || t === drop) return;
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
    /* 豹子弹窗同理，它也是挂在 body 上的 */
    if (mode !== 'f350') closeLion();
    /* 离开 350 就把「确定重开？」的状态收掉：下次进来别一进来就是待确认 */
    if (mode !== 'f350') redoIdle();

    /* 第一次进 350（或存档被清掉）：先把桌子摆上，再把人数下拉摊开让人确认。
       以前这里等人去点右上角的人数按钮才建玩家，新装的人进来是一张 0 人的空桌：
       摇出豹子点「收下」→ 找不到玩家 → showRank 抛异常 → 界面卡在旧按钮上，
       看起来就跟「摇出豹子没得选」一样。摆好默认人数、下拉照旧问一遍。 */
    if (mode === 'f350' && !G.players.length) {
      newGame(loadPlayerCount());
      openPDrop();
    }

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
      note: 'App 只管摇和盖，输赢在桌上算。斋、豹子、顺子这些讲究各地不一样，开打前先说好规矩。',
      /* 概率写在玩法里：骰子公不公平是桌上最容易吵的一句。
         这里只列能算出来的数（六面等概率 + 每把独立推出来的），
         不写「大概/通常」这种没法核对的措辞。 */
      odds: {
        hint: '六面各 16.7% · 豹子 1/2187 · 爆掉 5.85%',
        face: '每颗骰子都是 6 面等概率：1~6 点各 <strong>1/6 ≈ 16.7%</strong>，' +
          '不存在「容易出的点」和「难出的点」。摇的每一把都互相独立 —— ' +
          '刚摇过的点数不会因此变少或变多。',
        items: [
          '5 颗骰子里，某一面正好出现 0 / 1 / 2 / 3 / 4 / 5 颗的概率分别是 ' +
            '<strong>40.2% / 40.2% / 16.1% / 3.2% / 0.3% / 0.01%</strong>（二项分布）—— ' +
            '所以喊到「4 个」以上，多半是在诈。',
          '连开三把没见 1，下一把出 1 的概率还是 16.7%。没有「该出了」，也没有任何补偿机制。',
          '1 是万能点，但概率上它并不比别的点多：5 颗里出现 1 的期望只有 5/6 颗。'
        ],
        note: '骰子数量可以调（2~10 颗），概率按同样的方法变：n 颗时某一面正好出现 k 颗 = ' +
          'C(n,k) × (1/6)<sup>k</sup> × (5/6)<sup>n-k</sup>。'
      }
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
        '一把里一个 1、一个 5 都没有 = 爆掉：本回合分数清零，结果留在桌上，点「清零重摇」才拿回 7 颗，还是你摇，不换人。',
        '7 颗全是 1 和 5 = 豹子：记一次豹子。两种都算 —— 一把摇出 7 颗全是 1 和 5，' +
        '或者这一回合一颗颗把 7 颗全收下来。这一刻给两个选择：认账就「收下换人」，' +
        '这一手的 1 和 5 全算分、封顶 700，收完直接锁；不认就「清零重摇」，分数归零、拿回 7 颗还是你摇。',
        '封顶 700 分，到顶自动锁，不用手动点。',
        '比锁定的最终分数，高者赢；同分时先收手的排前面。'
      ],
      /* 这几条是桌上真正分酒的地方。App 只算分、只记豹子，
         喝多少由桌上自己定，所以单独一段，跟「规则」分开写。 */
      drinks: [
        '<strong>爆掉</strong>（一把里没有 1 也没有 5）：这个躲不掉，<strong>自己喝 1 杯</strong>；' +
        '如果这一把是 <strong>7 颗全摇</strong>（还没收过骰子、桌上满 7 颗），要<strong>喝双倍 · 2 杯</strong>。然后清零重摇。',
        '<strong>摇出豹子</strong>：摇的人不喝，台上其他人一起喝 —— ' +
        '<strong>15 豹</strong>（1 和 5 混着）每人 <strong>1 杯</strong>；' +
        '<strong>正豹</strong>（清一色 1111111 或 5555555）每人 <strong>2 杯</strong>。',
        '所以有人会专门去拼豹子：自己一分不涨、还不用喝，一桌人都得端杯。',
        '<strong>整局打完</strong>：分数最低的喝 <strong>2 杯</strong>。'
      ],
      /* 概率这一段是专门为「你这骰子是不是偏」写的：
         先把「六面等概率 + 每把独立」这两句立住，剩下的数字都能自己推出来。
         数字都是按代码里的实际判定算的（7 颗、记分只认 1 和 5），
         换规则的话这里要跟着改，别留一句对不上的旧概率。 */
      odds: {
        hint: '六面各 16.7% · 豹子 1/2187 · 爆掉 5.85%',
        face: '每颗骰子都是 6 面等概率：1~6 点各 <strong>1/6 ≈ 16.7%</strong>，' +
          '没有「好点数」「差点数」之分，也不存在被调高调低的某一面。',
        items: [
          '每一把都<strong>独立重摇</strong>：上一把摇出什么，不影响下一把。连开三把没见 1，' +
            '下一把出 1 还是 16.7% —— 没有「该出了」，也没有任何补偿机制。',
          '一颗骰子能收走（1 点或 5 点）的概率：<strong>2/6 = 33.3%</strong>，' +
            '所以 7 颗里平均能收 2.3 颗。',
          '一把 7 颗全是 1 和 5（豹子）：<strong>1/3 连乘 7 次 = 1/2187 ≈ 0.046%</strong>，约两千把一次。',
          '其中<strong>正豹</strong>（清一色 1111111 或 5555555）：<strong>2/6<sup>7</sup> = 1/139968 ≈ 0.0007%</strong>，' +
            '十三四万把才碰上一回 —— 所以平时摇到的几乎都是 15 豹，不是你看错了。',
          '一把 7 颗里一个 1、一个 5 都没有（爆掉）：<strong>(2/3)<sup>7</sup> = 128/2187 ≈ 5.85%</strong>，约十七把一次。',
          '骰子就是这台手机的随机数（<strong>Math.random</strong>），每次摇重新取一遍：' +
            '不看分数、不看人、不记仇，落后的人不会因此手气变好。'
        ],
        note: '上面的数按本作的判定算：7 颗明骰、只认 1 和 5。封顶 700 只影响分数怎么攒，' +
          '不影响怎么摇 —— 到顶那一把该出什么还是什么。'
      },
      note: '上面这些杯数是默认值，开局前按自己的量定，能加能减。App 只管算分和记豹子，喝不喝、喝多少在桌上说好。' +
        '想改人数点右上角「N 人」（2~12），重开一局点它左边的「重开」（点两下才真清分，防手滑）。'
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
    h += '</div>';
    /* 概率不铺在这一页：整段数字塞进玩法，想查规则的人得先翻过一屏百分比。
       这里只留一行入口（一句结论 + 箭头），点进去单独看一页 —— 见 openOdds。 */
    if (r.odds) {
      h += '<div class="rule-sec">' +
        '<div class="rule-sec-t">点数概率</div>' +
        '<button class="rule-link" type="button" data-odds="' + key + '">' +
          '<span class="rl-main">' + r.odds.hint + '</span>' +
          '<i class="rl-arw">›</i>' +
        '</button></div>';
    }
    /* 「喝多少」单独一段：这是桌上真正分酒的地方，混在规则里容易被当成可选事项划过去 */
    if (r.drinks) {
      h += '<div class="rule-sec"><div class="rule-sec-t">输赢 · 喝多少</div>';
      for (var k = 0; k < r.drinks.length; k++) {
        h += '<div class="rule-li"><em></em><span>' + r.drinks[k] + '</span></div>';
      }
      h += '</div>';
    }
    h += '<div class="rule-note">' + r.note + '</div>';

    $('ruleBody').innerHTML = h;
    bindRuleBody();
    mask.style.display = 'flex';
    /* 每次重开都从头滚：上一次翻到最底，下次进来还停在最底很怪 */
    var sheet = mask.querySelector('.rule-sheet');
    if (sheet) sheet.scrollTop = 0;
  }

  /* 玩法 / 概率两页共用一个弹层，正文会被整块换掉，所以点击得挂在外层（事件委托），
     不能挂在里面的按钮上 —— 换一次内容，那些按钮就都是新的了。 */
  var ruleBodyBound = false;
  function bindRuleBody() {
    var rb = $('ruleBody');
    if (!rb || ruleBodyBound) return;
    ruleBodyBound = true;
    rb.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== rb && !t.getAttribute('data-odds') && !t.getAttribute('data-back')) {
        t = t.parentNode;
      }
      if (!t || t === rb) return;
      if (t.getAttribute('data-back')) openRules(oddsFrom);
      else openOdds(t.getAttribute('data-odds'));
    });
  }

  /* 「点数概率」单独一页：从玩法点进来，标题换成「点数概率」，顶部给一条返回到玩法。
     不另开一层弹层 —— 同一个 sheet 换掉标题和正文，视觉上就是翻了一页，
     也不会出现「两层叠着、返回到底关哪层」的麻烦。 */
  var oddsFrom = 'f350';

  function openOdds(key) {
    var r = RULES[key];
    var mask = $('ruleMask');
    if (!r || !r.odds || !mask) return;
    oddsFrom = key;
    var o = r.odds;
    $('ruleTitle').textContent = '点数概率';

    var h = '<button class="rule-back" type="button" data-back="1">‹ 返回玩法</button>';
    h += '<div class="rule-lead">' + o.face + '</div>';
    /* 六个面各 16.7% 摆成六格：光写一句「六面等概率」容易被当成敷衍，
       六格一样高摆出来，谁也不好再说「你这点数偏」 */
    h += '<div class="rule-odds">';
    for (var f = 1; f <= 6; f++) {
      h += '<div class="ro-face' + (f === 1 || f === 5 ? ' ro-score' : '') + '">' +
        '<b>' + f + '</b><span>16.7%</span></div>';
    }
    h += '</div>';
    for (var m = 0; m < o.items.length; m++) {
      h += '<div class="rule-li"><em></em><span>' + o.items[m] + '</span></div>';
    }
    if (o.note) h += '<div class="rule-note">' + o.note + '</div>';

    $('ruleBody').innerHTML = h;
    bindRuleBody();
    mask.style.display = 'flex';
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

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
  var MIN_P = 2;
  var MAX_P = 6;
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
    phase: 'ready',     // ready | rolled | bust | over
    shakeAt: 0
  };

  var S = { timer: null, toastTimer: null };

  var el = {};
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
      G.phase = o.phase === 'over' ? 'over' : 'ready';
      // 手牌不恢复：刷新回来就在「等他摇」的状态，避免摇到一半的尴尬
      G.hand = blankHand();
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
    G.phase = 'ready';
    G.hand = blankHand();
    savePlayerCount(n);
    save();
    render();
  }

  function newTurn() {
    clearTimeout(S.timer);
    G.round = 0;
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
      G.round = 0;
      G.phase = 'bust';
      save();
      render();
      hint('一个 1 和 5 都没有 · 分数清零，拿回 7 颗重摇', 'warn');
      vibrate([40, 70, 40]);
      S.timer = setTimeout(function () {
        G.hand = blankHand();
        G.phase = 'ready';
        save();
        render();
      }, 1600);
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
      if (G.hand[i].v && G.hand[i].sel) { /* 被收走 */ }
      else rest.push({ v: G.hand[i].v, sel: false });
    }

    G.round = Math.min(CAP, G.round + gain);

    if (!rest.length) {
      // 一颗不剩：下一把重新从 7 颗开始
      G.hand = blankHand();
      hint('收完了 · 拿回 7 颗继续摇', 'good');
    } else {
      G.hand = rest;
      hint('还剩 ' + rest.length + ' 颗 · 继续摇');
    }
    G.phase = 'ready';
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

  function renderBtns() {
    if (!el.btns) return;
    el.btns.innerHTML = '';
    var list = [];

    if (G.phase === 'over') {
      list.push({ t: '再来一局', cls: 'primary', act: 'restart' });
    } else if (G.phase === 'rolled') {
      var gain = pickedSum();
      list.push({
        t: gain ? '收下 ' + gain + ' 分' : '点骰子收分',
        cls: 'primary' + (gain ? '' : ' is-off'),
        act: 'pick'
      });
    } else if (G.phase === 'bust') {
      list.push({ t: '重摇中…', cls: 'primary is-off', act: 'none' });
    } else {
      var left = liveHand().length;
      list.push({
        t: left && left < DICE ? '摇剩下 ' + left + ' 颗' : '摇一摇',
        cls: 'primary',
        act: 'roll'
      });
    }

    if (G.phase !== 'over') {
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
    renderBtns();
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

  function showSetup() {
    var cur = G.players.length || loadPlayerCount();
    var nums = '';
    for (var n = MIN_P; n <= MAX_P; n++) {
      nums += '<div class="f3-num' + (n === cur ? ' on' : '') + '" data-n="' + n + '">' + n + ' 人</div>';
    }
    openMask(
      '<span class="f3-sheet-title">几个人玩</span>' +
      '<span class="f3-sheet-sub">轮流摇，每人一把 · 满 ' + BASE + ' 才能收手</span>' +
      '<div class="f3-nums">' + nums + '</div>' +
      '<button class="btn primary" data-act="start">开始</button>'
    );
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
    d.sel = !d.sel;
    vibrate(10);
    renderDice();
    renderBtns();
    var s = pickedSum();
    hint(s ? '已选 ' + s + ' 分 · 点「收下」才算' : '还没选 · 点要拿走的骰子');
  }

  function onBtn(e) {
    var t = e.target;
    while (t && t !== el.btns && !t.getAttribute('data-act')) t = t.parentNode;
    if (!t || t === el.btns) return;
    var act = t.getAttribute('data-act');
    if (act === 'roll') onRoll();
    else if (act === 'pick') onPick();
    else if (act === 'lock') lockTurn();
    else if (act === 'restart') restart();
  }

  function restart() {
    closeMask();
    S.timer && clearTimeout(S.timer);
    G.round = 0;
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

  function onMaskTap(e) {
    var t = e.target;
    if (t.getAttribute('data-act') === 'start' || t.getAttribute('data-act') === 'restart') {
      if (t.getAttribute('data-act') === 'restart') { restart(); return; }
      var pick = el.pop.querySelector('.f3-num.on');
      var n = pick ? parseInt(pick.getAttribute('data-n'), 10) : loadPlayerCount();
      closeMask();
      newGame(n);
      return;
    }
    if (t.classList && t.classList.contains('f3-num')) {
      var all = el.pop.querySelectorAll('.f3-num');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
      t.classList.add('on');
      return;
    }
    if (t === el.pop) closeMask();
  }

  /* ================= 启动 ================= */

  function boot() {
    el.strip = $('pStrip');
    el.dice = $('f3Dice');
    el.score = $('f3ScoreBox');
    el.scoreNum = $('f3ScoreNum');
    el.hint = $('f3Hint');
    el.btns = $('f3Btns');
    el.pop = $('f3Mask');
    if (!el.dice) return;

    el.dice.addEventListener('click', onDieTap);
    el.btns.addEventListener('click', onBtn);
    el.pop.addEventListener('click', onMaskTap);

    var btn = $('toF350');
    if (btn) btn.addEventListener('click', function () { switchTo('f350'); });
    var back = $('toLiar');
    if (back) back.addEventListener('click', function () { switchTo('liar'); });

    if (load()) {
      render();
    } else {
      // 还没开过局：先把 350 这一页摆成空盘，等真的切过去再问人数，
      // 否则在吹牛模式下也会被遮罩挡住
      el.strip.innerHTML = '';
      el.dice.innerHTML = '';
      renderBtns();
    }

    // 上次停在哪个玩法，这次就还进哪个；默认是吹牛
    var last = 'liar';
    try { last = localStorage.getItem('ld_mode') || 'liar'; } catch (e) {}
    if (last === 'f350') switchTo('f350');
    else document.body.setAttribute('data-mode', 'liar');
  }

  function switchTo(mode) {
    document.body.setAttribute('data-mode', mode);
    var liar = document.querySelector('.page-liar');
    var f3 = document.querySelector('.page-f350');
    if (liar) liar.hidden = mode === 'f350';
    if (f3) f3.hidden = mode !== 'f350';
    try { localStorage.setItem('ld_mode', mode); } catch (e) {}
    if (mode === 'f350' && !G.players.length && el.pop.style.display !== 'flex') {
      showSetup();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 给外部（index.html 的首次进入）用
  window.F350 = { switchTo: switchTo, showSetup: showSetup };

  /* 只在 ?test=1 时挂出来：自动化测试要能指定点数，
     否则「摇到豹子」「摇到爆」这种分支根本没法稳定复现。 */
  if (location.search.indexOf('test=1') >= 0) {
    window.F350.__t = {
      G: G,
      setHand: function (vals) {
        G.hand = vals.map(function (v) { return { v: v, sel: false }; });
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

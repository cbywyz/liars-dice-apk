/* 七八九 —— 两人以上围一圈，2 颗骰 + 1 个公杯，纯运气的快节奏酒桌玩法，第四个玩法。

   规则（用户 2026-11-19 拍板，已逐条确认 + 补查传统规则）：
     · 2 颗明骰，全场共用，轮流摇，摇完立刻开（没有盖子）
     · 公共杯底酒初始 1 杯、封顶默认 6 杯（随时可调，可往上加）
     · 两颗点数之和：
         7 → 往公杯加 1 杯（到封顶就不再加）
         8 → 当前玩家喝掉「公杯当前存量的一半」，杯里留另一半
         9 → 当前玩家喝光公杯，然后重倒 1 杯
         其余 → 什么都不做，换下一位
     · 摇到两个 1 → 当前玩家指一个人喝 1 杯（单独记，不动公杯）
     · 摇到其他对子（22 33 55 66）→ 摇骰顺序掉头，从当前座位按新方向继续；44=8 归 8，不算掉头对子
     · 摇到 7 / 8 / 9 的人接着摇，直到摇出不是 7/8/9 为止才换人（续摇）
     · 没有封顶局数 → 没有胜负、没有结算榜、不排名；谁喝了几杯实时标在座位上
     · 想重来：走「重开」两下确认，把杯数标记清掉

   优先级（同一把只认一档，不叠加）：
     ① 两个 1（point）→ ② 和值 7/8/9（add/half/all）→ ③ 其他对子（reverse）→ ④ 过（pass）
   注意 4+4=8 属于 8（和值优先于对子），5+5=10 属于对子。

   判定放最上面、只碰纯数据：_real/unit-789.mjs 会把这一段切出来单独跑。
   这个文件不依赖 app.js，两版（完整版 / 纯净版）都带。

   杯数一律用「半杯」为最小粒度存整数（1 杯 = 2 单位），显示时除以 2。
   这样 8「喝公杯一半」产生 0.5 杯时不丢精度。 */

(function () {
  'use strict';

  /* ================= 判定（纯函数） ================= */

  var MIN_P = 2;
  var MAX_P = 12;

  /* 公杯容量单位：1 杯 = 2 单位。封顶默认 6 杯 = 12 单位。 */
  var HALF = 2;

  function dsum(v) { return v[0] + v[1]; }
  function isDouble(v) { return !!v && v[0] === v[1]; }
  function isEleven(v) { return !!v && v[0] === 1 && v[1] === 1; }

  /* 一把骰子归到哪一档。返回：
       'point'   两个 1 → 指人喝
       'add'     和=7 → 公杯加 1 杯
       'half'    和=8 → 喝公杯一半
       'all'     和=9 → 喝光公杯
       'reverse' 其他对子 → 掉头
       'pass'    其余 → 换人
     顺序即优先级，先判先返回，不叠加。 */
  function kindOf(v) {
    if (!v || v.length !== 2) return 'pass';
    if (isEleven(v)) return 'point';
    var n = dsum(v);
    if (n === 7) return 'add';
    if (n === 8) return 'half';
    if (n === 9) return 'all';
    if (isDouble(v)) return 'reverse';
    return 'pass';
  }

  /* 摇到 7/8/9 要接着摇，直到不是这三档才换人。两个 1 指完人也是换人（不续摇）。 */
  function shouldContinue(kind) {
    return kind === 'add' || kind === 'half' || kind === 'all';
  }

  /* 8「喝公杯一半」该喝几单位：公杯 pot 的一半，向下取到 0.5 杯。
     pot 是单位数（1 杯 = 2），结果也是单位数。pot=1（0.5 杯）时喝 0.5 杯？
     传统上公杯不足半杯就全喝了，所以 pot<=1 直接喝光。 */
  function halfUnits(pot) {
    if (pot <= 1) return pot;
    return Math.floor(pot / 2);
  }

  /* 结算一把对公杯和杯数的影响，返回 { pot, potBefore, drink, add, reverse, needPick }。
     drink 是当前摇骰者自己要喝的单位；add 是往公杯加的单位；
     potBefore 是摇之前公杯存量，提示里写「公杯 N 杯 → 喝 M 杯」用；
     needPick 表示摇到两个 1、要进入指人阶段。纯函数，不改入参。 */
  function settle(kind, pot, cap) {
    var r = { pot: pot, potBefore: pot, drink: 0, add: 0, reverse: false, needPick: false };
    if (kind === 'add') {
      r.add = (pot + HALF <= cap) ? HALF : 0;
      r.pot = Math.min(pot + r.add, cap);
    } else if (kind === 'half') {
      r.drink = halfUnits(pot);
      r.pot = pot - r.drink;
    } else if (kind === 'all') {
      r.drink = pot;
      r.pot = HALF;              // 喝光后重倒 1 杯
    } else if (kind === 'reverse') {
      r.reverse = true;
    } else if (kind === 'point') {
      r.needPick = true;          // 指人那 1 杯在 pickSeat 里单独记
    }
    return r;
  }

  /* 杯数单位 → 显示文案。3 → '1.5 杯'，4 → '2 杯'，0 → '' */
  function cupText(units) {
    if (!units) return '';
    return (units / 2) + ' 杯';
  }

  /* ================= 判定结束 ================= */

  var KEY = 'ld_789';
  var COUNT_KEY = 'ld_789_count';
  var CAP_KEY = 'ld_789_cap';

  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var RED = { 1: true, 4: true };

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  var seatEls = [];
  var redoAt = 0;

  /* G.pot / G.cap 都是单位（1 杯 = 2）。seats[i].cups 也是单位。 */
  var G = {
    n: 0,
    seats: [],        // [{ cups:0 }]  每人喝了几杯（单位）
    pot: HALF,        // 公杯当前存量（单位）
    cap: 6 * HALF,    // 公杯封顶（单位），随时可调
    shaker: 0,        // 当前摇骰的人（0 起）
    dir: 1,           // +1 顺时针 / -1 逆时针
    phase: 'ready',   // ready 等摇 | again 7/8/9 续摇 | pick 两个1指人 | pass 换人
    last: null,       // 最近一把 [a,b]
    lastKind: '',
    picked: -1,       // 两个1 指的那位：-1 还没点，-2 放弃
    note: '',         // 上一把的一句结果说明
    flash: '',        // 临时提示，1.6 秒消失
    shakes: 0         // 同一位连摇了几把（7/8/9 续摇计数）
  };

  /* ---------------- 小工具 ---------------- */

  function rollOne() { return 1 + Math.floor(Math.random() * 6); }

  function buzz(pat) {
    try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {}
  }

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
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  function cue(name) { if (window.LDSnd) window.LDSnd.cue(name); }

  function dense() { return G.n >= 10; }

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

  function paintDice(box, vals, size) {
    var key = vals.join('');
    if (box.getAttribute('data-k') === key) return;
    box.setAttribute('data-k', key);
    var h = '';
    for (var i = 0; i < vals.length; i++) h += dieHtml(vals[i], size);
    box.innerHTML = h;
    var ds = box.children;
    for (var j = 0; j < ds.length; j++) ds[j].classList.add('pop');
  }

  function nameOf(i) { return (i + 1) + ' 号'; }

  var flashTimer = 0;
  function flash(msg) {
    G.flash = msg;
    paint();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { G.flash = ''; paint(); }, 1600);
  }

  /* ---------------- 建桌 ---------------- */

  function buildSeats() {
    el.seats.innerHTML = '';
    seatEls = [];
    for (var i = 0; i < G.n; i++) {
      var s = document.createElement('div');
      s.className = 'fd-seat';
      s.setAttribute('data-i', String(i));
      /* 1 号左上、顺时针排，跟桌上真人围一圈一致（复用找朋友的排法） */
      var th = 270 - 360 / G.n + i * (360 / G.n);
      var rad = th * Math.PI / 180;
      var R = 0.78;
      s.style.left = (50 + 50 * R * Math.cos(rad)).toFixed(2) + '%';
      s.style.top = (50 + 50 * R * Math.sin(rad)).toFixed(2) + '%';
      if (dense()) s.style.width = '16.2vw';
      s.innerHTML =
        '<span class="fd-n">' + nameOf(i) + '</span>' +
        '<span class="fd-cups"></span>' +
        '<span class="fd-tag">喝</span>';
      el.seats.appendChild(s);
      seatEls.push({ root: s, cups: s.querySelector('.fd-cups'), tag: s.querySelector('.fd-tag') });
    }
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    var size = dense() ? '6.6vw' : '9.8667vw';

    el.who.textContent = nameOf(G.shaker) + '摇';
    el.round.textContent = '第 ' + (G.shakes + 1) + ' 把';

    /* 方向箭头：顺 / 逆时针一眼看清，对子掉头之后尤其要看得出 */
    el.dir.textContent = G.dir > 0 ? '↻ 顺时针' : '↺ 逆时针';
    el.dir.classList.toggle('back', G.dir < 0);

    /* 指人阶段整圈呼吸，跟找朋友 11 正豹一个提示法 */
    el.ring.classList.toggle('pick', G.phase === 'pick');

    /* 公杯：存量 / 封顶都按杯显示（单位除以 2） */
    el.pot.textContent = cupText(G.pot) || '空杯';
    el.cup.classList.toggle('full', G.pot >= G.cap);
    el.cup.classList.toggle('low', G.pot > 0 && G.pot <= HALF);

    for (var i = 0; i < G.n; i++) {
      var se = seatEls[i];
      var st = G.seats[i];
      var isNow = i === G.shaker;
      var isNext = (G.phase === 'pass' && i === nextShaker());
      se.root.classList.toggle('now', isNow);
      se.root.classList.toggle('next', isNext);
      se.root.classList.toggle('sel', i === G.picked);
      se.root.classList.toggle('drink', G.lastKind === 'point' && i === G.picked);
      if (se.tag) se.tag.textContent = isNext ? '接手' : (isNow ? '摇' : '喝');
      se.cups.textContent = cupText(st.cups);
      se.cups.classList.toggle('has', st.cups > 0);
    }

    paintDice(el.dice, G.last || [0, 0], size);
    el.tag.textContent = G.last
      ? (dsum(G.last) + ' 点' + (isDouble(G.last) ? ' · 对子' : ''))
      : '摇骰';

    paintHint();
    paintBtns();
  }

  function nextShaker() {
    var n = (G.shaker + G.dir) % G.n;
    return n < 0 ? n + G.n : n;
  }

  function kindNote(kind, r) {
    if (kind === 'point') return '两个 1 · 指一位喝 1 杯';
    if (kind === 'add') return r.add ? '公杯 +1 杯' : '公杯满了 · 不加了';
    if (kind === 'half') return '公杯 ' + (cupText(r.potBefore) || '空') + ' → 喝一半 ' + (cupText(r.drink) || '0 杯');
    if (kind === 'all') return '公杯 ' + (cupText(r.potBefore) || '空') + ' → 喝光 · 重倒 1 杯';
    if (kind === 'reverse') return '对子 · 掉头，' + (G.dir > 0 ? '顺时针' : '逆时针');
    return '没中 · 换人';
  }

  function paintHint() {
    var line = '', sub = '';
    if (G.phase === 'ready') {
      line = '轮到 <b>' + nameOf(G.shaker) + '</b> · 摇 2 颗';
      sub = '公杯 ' + (cupText(G.pot) || '空') + ' · 封顶 ' + (G.cap / 2) + ' 杯';
    } else if (G.phase === 'pick') {
      line = '<b>两个 1</b> · 点一位，罚 1 杯';
      sub = '这一杯单独记，不动公杯';
    } else if (G.phase === 'again') {
      line = '<b>' + dsum(G.last) + ' 点</b> → ' + G.note;
      sub = '接着摇 · 摇到不是 7/8/9 才换人';
    } else {
      line = '<b>' + dsum(G.last) + ' 点</b> → ' + G.note;
      sub = '轮到 <b>' + nameOf(nextShaker()) + '</b>';
    }
    if (G.note && (G.phase === 'ready' || G.phase === 'pick')) {
      sub = G.note + (sub ? ' · ' + sub : '');
    }
    if (G.flash) sub = sub ? sub + ' · ' + G.flash : G.flash;
    el.hint.innerHTML = line + (sub ? '<span class="fd-sub">' + sub + '</span>' : '');
  }

  function paintBtns() {
    var items = [];
    if (G.phase === 'ready') {
      items.push({ act: 'roll', text: '摇骰', cls: 'btn primary' });
    } else if (G.phase === 'pick') {
      items.push({ act: 'skipPick', text: '不指了', cls: 'btn ghost' });
    } else if (G.phase === 'again') {
      items.push({ act: 'roll', text: '继续摇', cls: 'btn primary' });
    } else {
      items.push({ act: 'next', text: nameOf(nextShaker()) + ' 接手', cls: 'btn primary' });
    }
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<button class="' + items[i].cls + '" type="button" data-act="' +
        items[i].act + '">' + items[i].text + '</button>';
    }
    el.btns.innerHTML = h;
  }

  /* ---------------- 流程 ---------------- */

  function startTurn(i, keepShakes) {
    G.shaker = i;
    G.last = null;
    G.lastKind = '';
    G.picked = -1;
    G.note = '';
    G.phase = 'ready';
    G.shakes = keepShakes || 0;
    paint();
    save();
  }

  /* 摇一把。可能进入 again（续摇）/ pick（指人）/ pass（换人）。 */
  function doRoll() {
    if (G.phase !== 'ready' && G.phase !== 'again') return;
    var v = [rollOne(), rollOne()];
    G.last = v;
    playShake();
    var kind = kindOf(v);
    G.lastKind = kind;
    var r = settle(kind, G.pot, G.cap);
    G.pot = r.pot;
    G.shakes++;

    if (r.drink) G.seats[G.shaker].cups += r.drink;
    G.note = kindNote(kind, r);

    if (r.needPick) {
      G.phase = 'pick';
      buzz([16, 60, 16, 60, 16]);
      cue('lion');
    } else if (shouldContinue(kind)) {
      G.phase = 'again';
      buzz(18);
      if (kind === 'half' || kind === 'all') cue('drink');
    } else if (r.reverse) {
      G.dir = -G.dir;
      /* 方向已经翻过来了，提示要跟着说新方向 —— 早先在这里算 note 会写成旧方向，
         跟顶上的箭头对不上（截图里一眼就能看出「掉头，顺时针」配 ↺ 逆时针）。 */
      G.note = kindNote(kind, r);
      G.phase = 'pass';
      buzz([26, 60, 26]);
      cue('pass');
    } else {
      G.phase = 'pass';
      buzz(14);
      cue('pass');
    }
    paint();
    save();
  }

  /* 两个 1 指人：被指的喝 1 杯（2 单位），单独记、不动公杯 */
  function pickSeat(i) {
    if (G.phase !== 'pick') return;
    if (!(i >= 0 && i < G.n)) return;
    /* 指自己也可以（规则没禁止，摇骰人自己也照判） */
    G.seats[i].cups += HALF;
    G.picked = i;
    G.phase = 'pass';
    G.note = '两个 1 · 指 ' + nameOf(i) + ' 喝 1 杯';
    buzz([30, 50, 30]);
    cue('drink');
    paint();
    save();
  }

  function skipPick() {
    if (G.phase !== 'pick') return;
    G.picked = -2;
    G.phase = 'pass';
    G.note = '两个 1 · 没指人';
    paint();
    save();
  }

  function advance() {
    startTurn(nextShaker());
  }

  function newGame(n, capCups) {
    G.n = n;
    G.cap = (capCups || 6) * HALF;
    G.pot = HALF;
    G.dir = 1;
    G.seats = [];
    for (var i = 0; i < n; i++) G.seats.push({ cups: 0 });
    buildSeats();
    startTurn(0);
    if (el.countTxt) el.countTxt.textContent = n + ' 人';
    if (el.capBtn) el.capBtn.textContent = '上限 ' + (G.cap / 2) + ' 杯';
  }

  /* ---------------- 存档 ---------------- */

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        n: G.n, cap: G.cap, pot: G.pot, dir: G.dir,
        shaker: G.shaker, phase: G.phase, last: G.last, lastKind: G.lastKind,
        picked: G.picked, note: G.note, shakes: G.shakes, seats: G.seats
      }));
    } catch (e) {}
  }

  function loadCount() {
    try {
      var n = parseInt(localStorage.getItem(COUNT_KEY) || '', 10);
      return (n >= MIN_P && n <= MAX_P) ? n : 6;
    } catch (e) { return 6; }
  }

  function loadCap() {
    try {
      var c = parseInt(localStorage.getItem(CAP_KEY) || '', 10);
      return (c >= 1 && c <= 20) ? c : 6;
    } catch (e) { return 6; }
  }

  function restore() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (!raw) return false;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return false; }
    if (!o || !(o.n >= MIN_P && o.n <= MAX_P)) return false;
    if (!o.seats || o.seats.length !== o.n) return false;

    G.n = o.n;
    G.cap = (o.cap >= HALF && o.cap <= 40) ? (o.cap | 0) : 6 * HALF;
    G.pot = (o.pot >= 0 && o.pot <= G.cap) ? (o.pot | 0) : HALF;
    G.dir = o.dir < 0 ? -1 : 1;
    G.shaker = (o.shaker >= 0 && o.shaker < o.n) ? o.shaker : 0;
    G.phase = (o.phase === 'again' || o.phase === 'pick' || o.phase === 'pass') ? o.phase : 'ready';
    G.last = (o.last && o.last.length === 2) ? o.last : null;
    G.lastKind = kindOf(G.last);
    G.picked = (o.picked === -2 || (o.picked >= -1 && o.picked < o.n)) ? (o.picked | 0) : -1;
    G.note = typeof o.note === 'string' ? o.note : '';
    G.shakes = (o.shakes | 0) >= 0 ? (o.shakes | 0) : 0;
    if (G.phase === 'pick') G.picked = -1;
    G.seats = [];
    for (var i = 0; i < o.n; i++) {
      var s = o.seats[i] || {};
      G.seats.push({ cups: Math.max(0, s.cups | 0) });
    }
    buildSeats();
    paint();
    return true;
  }

  /* ---------------- 人数 / 公杯封顶下拉 ---------------- */

  function buildDrop(sel, list, cur) {
    var h = '';
    for (var i = 0; i < list.length; i++) {
      h += '<button class="drop-item' + (list[i] === cur ? ' on' : '') +
        '" type="button" data-n="' + list[i] + '">' + list[i] + '</button>';
    }
    el.drop.innerHTML = h;
    el.drop.setAttribute('data-kind', sel);
  }

  function closeDrop() {
    el.drop.hidden = true;
    el.shade.hidden = true;
    el.countBtn.classList.remove('on');
    if (el.capBtn) el.capBtn.classList.remove('on');
  }

  function openDrop(kind) {
    if (kind === 'cap') {
      var caps = [];
      for (var c = 1; c <= 12; c++) caps.push(c);
      buildDrop('cap', caps, G.cap / HALF);
      el.capBtn.classList.add('on');
    } else {
      var nums = [];
      for (var n = MIN_P; n <= MAX_P; n++) nums.push(n);
      buildDrop('count', nums, G.n);
      el.countBtn.classList.add('on');
    }
    el.drop.hidden = false;
    el.shade.hidden = false;
  }

  function dropOpen() { return el.drop && !el.drop.hidden; }

  function applyDrop(n) {
    var kind = el.drop.getAttribute('data-kind');
    closeDrop();
    if (kind === 'cap') {
      if (n === G.cap / HALF) return;
      G.cap = n * HALF;
      if (G.pot > G.cap) G.pot = G.cap;
      try { localStorage.setItem(CAP_KEY, String(n)); } catch (e) {}
      if (el.capBtn) el.capBtn.textContent = '上限 ' + n + ' 杯';
      buzz(10);
      paint();
      save();
    } else {
      if (n === G.n) return;
      try { localStorage.setItem(COUNT_KEY, String(n)); } catch (e) {}
      newGame(n, G.cap / HALF);
      buzz(10);
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    el.btns.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'roll') doRoll();
      else if (act === 'next') advance();
      else if (act === 'skipPick') skipPick();
    });

    el.seats.addEventListener('click', function (e) {
      var s = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s) return;
      if (G.phase === 'pick') pickSeat(Number(s.getAttribute('data-i')));
    });

    el.countBtn.addEventListener('click', function () {
      if (dropOpen()) closeDrop(); else openDrop('count');
    });
    if (el.capBtn) {
      el.capBtn.addEventListener('click', function () {
        if (dropOpen()) closeDrop(); else openDrop('cap');
      });
    }

    el.drop.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-n]') : null;
      if (!b) return;
      applyDrop(Number(b.getAttribute('data-n')));
    });

    el.shade.addEventListener('click', closeDrop);

    /* 重开两下确认：满桌的杯数是这一晚的战绩，手滑一下不该没了 */
    el.redo.addEventListener('click', function () {
      var now = Date.now();
      if (now - redoAt > 2500) {
        redoAt = now;
        el.redo.textContent = '再点一次';
        el.redo.classList.add('arm');
        setTimeout(function () {
          if (Date.now() - redoAt >= 2500) {
            el.redo.textContent = '重开';
            el.redo.classList.remove('arm');
          }
        }, 2500);
        return;
      }
      redoAt = 0;
      el.redo.textContent = '重开';
      el.redo.classList.remove('arm');
      newGame(G.n, G.cap / HALF);
      buzz(18);
    });
  }

  /* ---------------- 入口 ---------------- */

  function enter() {
    if (!el.seats) return;         // boot 还没跑，别碰下拉和按钮
    if (!G.n) {
      if (!restore()) newGame(loadCount(), loadCap());
      return;
    }
    paint();
  }

  function leave() {
    if (!el.seats) return;
    closeDrop();
    redoAt = 0;
    if (el.redo) {
      el.redo.textContent = '重开';
      el.redo.classList.remove('arm');
    }
  }

  function boot() {
    el = {
      seats: $('gSeats'),
      ring: $('gRing'),
      who: $('gWho'),
      round: $('gRound'),
      dir: $('gDir'),
      cup: $('gCore'),
      pot: $('gPot'),
      capBtn: $('gCapBtn'),
      dice: $('gDice'),
      tag: $('gTag'),
      hint: $('gHint'),
      btns: $('gBtns'),
      countBtn: $('gCountBtn'),
      countTxt: $('gCountTxt'),
      drop: $('gDrop'),
      shade: $('gShade'),
      redo: $('redo789')
    };
    if (!el.seats) return;         // 页面上没有这一页，不启动

    bind();
    var unlocked = false;
    var once = function () {
      if (unlocked) return;
      unlocked = true;
      unlockShk();
    };
    document.addEventListener('touchstart', once, true);
    document.addEventListener('mousedown', once, true);

    if (!restore()) newGame(loadCount(), loadCap());
    if (el.countTxt) el.countTxt.textContent = G.n + ' 人';
    if (el.capBtn) el.capBtn.textContent = '上限 ' + (G.cap / 2) + ' 杯';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.LD789 = { enter: enter, leave: leave };
})();

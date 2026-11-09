/* 吹牛骰子 · 网页版
   纯本地运行：无后端、无网络请求、无登录。
   只有摇骰、掀盖、锁定这些基本玩法。 */

(function () {
  'use strict';

  /* ================= 常量 ================= */

  var OPEN_DIST = 190;      // 上滑多少 rpx 算完全掀开（越小越跟手）
  var LIFT = 340;            // 完全揭开时盖子向上抬起的距离(rpx)
  var SHAKE_MS = 1600;       // 摇骰动画时长（与 shake.mp3 对齐）

  var PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };
  var CELL = [20, 50, 80];

  /* 骰子散落布局：按数量排成 1~2 行，行内居中，每颗给一点倾斜，看着像随手撒的。
     坐标全部是 750 基准的 rpx，和骰盅盅口那块椭圆（600 × 310，圆心 300,155）对得上。
     数量不是 5 的时候，骰子按档缩小，保证 10 颗也塞得进盅口。 */
  var LAYOUT = {
    2:  { cols: 2, size: 132, gx: 26, gy: 0 },
    3:  { cols: 3, size: 126, gx: 22, gy: 0 },
    4:  { cols: 2, size: 116, gx: 30, gy: 24 },
    5:  { cols: 3, size: 110, gx: 20, gy: 14 },
    6:  { cols: 3, size: 104, gx: 19, gy: 19 },
    7:  { cols: 4, size: 92,  gx: 16, gy: 21 },
    8:  { cols: 4, size: 92,  gx: 16, gy: 21 },
    9:  { cols: 5, size: 82,  gx: 14, gy: 20 },
    10: { cols: 5, size: 82,  gx: 14, gy: 20 }
  };
  var TILT = [-9, 6, -4, 8, -7, 5, -6, 9, -3, 7];
  var MIN_DICE = 2;
  var MAX_DICE = 10;
  var DICE_KEY = 'ld_dice_count';

  var SLOT_CACHE = {};
  function slotsOf(n) {
    if (SLOT_CACHE[n]) return SLOT_CACHE[n];
    var cfg = LAYOUT[n] || LAYOUT[5];
    var cols = cfg.cols;
    var size = cfg.size;
    var gapX = cfg.gx;
    var gapY = cfg.gy;
    var rows = Math.ceil(n / cols);
    var CX = 300;              // 盅口椭圆圆心
    var CY = 158;

    var totalH = rows * size + (rows - 1) * gapY;
    var y0 = CY - totalH / 2;
    var out = [];
    for (var r = 0; r < rows; r++) {
      var cnt = Math.min(cols, n - r * cols);
      var totalW = cnt * size + (cnt - 1) * gapX;
      var x0 = CX - totalW / 2;
      for (var c = 0; c < cnt; c++) {
        var i = r * cols + c;
        out.push({
          l: x0 + c * (size + gapX),
          t: y0 + r * (size + gapY),
          r: TILT[i % TILT.length],
          s: size
        });
      }
    }
    SLOT_CACHE[n] = out;
    return out;
  }

  var RED_FACES = { 1: true, 4: true };

  var SOUND_SRC = 'assets/audio/shake.mp3';

  /* 1rpx = 100/750 vw，和微信小程序的响应式完全等价 */
  var VW = 100 / 750;
  function rpx(n) {
    var s = (n * VW).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return (s || '0') + 'vw';
  }

  /* ================= 纯函数 ================= */

  function pipsOf(value) {
    var cells = PIPS[value] || [];
    var red = !!RED_FACES[value];
    var list = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      list.push({
        k: i,
        x: CELL[c % 3],
        y: CELL[Math.floor(c / 3)],
        red: red,
        big: cells.length === 1
      });
    }
    return list;
  }

  /* 摇完自动认牌：豹子（1 是万能牌）和顺子（全不同）。
     纯识别，不改任何点数，两版都有。
     顺子只在 5~6 颗时成立 —— 超过 6 颗不可能全不同，硬判就是假的。 */
  function faceOf(values) {
    var n = values.length;
    if (!n) return { kind: '' };

    var rest = [];
    for (var i = 0; i < n; i++) {
      if (values[i] !== 1) rest.push(values[i]);
    }
    var lion = 0;
    if (!rest.length) {
      lion = 1;                       // 全是 1
    } else {
      var same = true;
      for (var j = 1; j < rest.length; j++) {
        if (rest[j] !== rest[0]) { same = false; break; }
      }
      if (same) lion = rest[0];
    }
    if (lion) return { kind: 'lion', lion: lion, n: n };

    var uniq = [];
    for (var k = 0; k < n; k++) {
      if (uniq.indexOf(values[k]) < 0) uniq.push(values[k]);
    }
    if (n >= 5 && n <= 6 && uniq.length === n) return { kind: 'straight', n: n };

    return { kind: '' };
  }

  function jitter(base, range) {
    return Math.round(base + (Math.random() * 2 - 1) * range);
  }

  function rollOne() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /* ================= 本地存储 / 音效 / 震动 / 提示 ================= */

  /* 骰子数量是公开功能（两版都有），存本地，下次打开还是上次那个数。
     注意别把这段挪到 STORE_KEY 后面 —— 纯净版是从这里往后剪的。 */
  function loadDiceCount() {
    try {
      var n = parseInt(localStorage.getItem(DICE_KEY) || '', 10);
      return (n >= MIN_DICE && n <= MAX_DICE) ? n : 5;
    } catch (e) {
      return 5;
    }
  }
  function saveDiceCount(n) {
    try { localStorage.setItem(DICE_KEY, String(n)); } catch (e) {}
  }

  var audio = null;
  function initAudio() {
    try {
      audio = new Audio(SOUND_SRC);
      audio.preload = 'auto';
      audio.addEventListener('error', function () {});
    } catch (e) {
      audio = null;
    }
  }
  function playSound() {
    if (!d.soundOn || !audio) return;
    try {
      audio.currentTime = 0;
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  function stopSound() {
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch (e) {}
  }

  function vibrate(kind) {
    if (!navigator.vibrate) return;
    try {
      navigator.vibrate(kind === 'heavy' ? 24 : kind === 'medium' ? 16 : 8);
    } catch (e) {}
  }

  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(title) {
    if (!toastEl) return;
    toastEl.textContent = title;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
      toastTimer = null;
    }, 1500);
  }

  /* ================= 状态 ================= */

  var S = {
    data: {
      state: 'idle',          // idle | shaking | closed | ajar | open
      isLocked: false,
      shaking: false,
      revealed: false,
      lidStyle: '',
      dice: [],
      diceCount: 5,
      diceFace: '',            // 'lion' | 'straight' | ''，摇完自动识别用
      hint: '点「摇一摇」开始这一局',
      soundOn: true,
      hasLast: false
    },
    shoundOnGuard: function () { return S.data.soundOn; },

    /* 实例属性 */
    progress: 0,
    lastValues: null,
    ratio: 2,
    baseP: 0,
    startY: 0,
    moved: 0,
    grabbing: false,
    shakeTimer: null,
    hotY: null,
    hotX: null,
    hotDragging: false
  };

  var d = S.data;

  /* ================= DOM ================= */

  var el = {
    stage: document.getElementById('stage'),
    cupRig: document.getElementById('cupRig'),
    diceLayer: document.getElementById('diceLayer'),
    lidHolder: document.getElementById('lidHolder'),
    lockTag: document.getElementById('lockTag'),
    hint: document.getElementById('hint'),
    btnRow: document.getElementById('btnRow'),
    soundBtn: document.getElementById('soundBtn'),
    soundIc: document.getElementById('soundIc'),
    countBtn: document.getElementById('countBtn'),
    countTxt: document.getElementById('countTxt'),
    countDrop: document.getElementById('countDrop'),
    countShade: document.getElementById('countShade'),
    hotZone: document.getElementById('hotZone')
  };

  /* ================= 渲染 ================= */

  function setData(patch) {
    var keys = [];
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        d[k] = patch[k];
        keys.push(k);
      }
    }
    render(keys);
  }

  function has(keys, name) {
    return keys.indexOf(name) >= 0;
  }

  function render(keys) {
    var stageDirty = false;

    if (has(keys, 'dice')) {
      // 只有骰子数量变了才整层重建；改点数、重新排布只更新变化的那一颗
      renderDice(el.diceLayer.children.length !== (d.dice || []).length);
    }
    if (has(keys, 'revealed')) {
      /* 开盖／合盖只切一下入场动画的 class，绝不重建节点。
         这是「滑一点就卡住」的真凶：拖动到 28% 时会 setData(revealed)
         让骰子层重建，手指底下的节点被换成新的，浏览器直接把整串
         触摸静默丢弃 —— 连 touchcancel 都不发，盖子就冻在半路。 */
      revealDice();
    }
    if (has(keys, 'lidStyle')) {
      el.lidHolder.style.cssText = d.lidStyle;
    }
    if (has(keys, 'hint')) {
      el.hint.textContent = d.hint;
      /* 只有开盖认牌那一下才带 diceFace；别处换提示语就自动把高亮撤掉 */
      if (!has(keys, 'diceFace')) d.diceFace = '';
      el.hint.className = 'hint' + (d.diceFace ? ' face-' + d.diceFace : '');
    }
    if (has(keys, 'soundOn')) {
      el.soundIc.textContent = d.soundOn ? '🔊' : '🔇';
      el.soundBtn.classList.toggle('off', !d.soundOn);
    }
    if (has(keys, 'diceCount')) {
      el.countTxt.textContent = d.diceCount + ' 颗';
    }
    if (has(keys, 'state')) stageDirty = true;
    if (has(keys, 'shaking')) stageDirty = true;
    if (has(keys, 'isLocked')) stageDirty = true;
    if (has(keys, 'hasLast')) stageDirty = true;
    if (stageDirty) {
      el.stage.className = 'stage' + (d.shaking ? ' shaking' : '') + (d.isLocked ? ' locked' : '');
      el.cupRig.className = 'cup-rig' + (d.shaking ? ' shaking' : '');
      el.lockTag.style.display = d.isLocked ? 'block' : 'none';
      renderButtons();
    }

  }

  function revealDice() {
    var kids = el.diceLayer.children;
    for (var i = 0; i < kids.length; i++) {
      var die = kids[i].firstChild;
      if (!die) continue;
      if (d.revealed) {
        die.style.animationDelay = i * 45 + 'ms';
        die.classList.remove('in');
        void die.offsetWidth; // 强制一次回流，动画才会重播
        die.classList.add('in');
      } else {
        die.classList.remove('in');
      }
    }
  }

  function renderDice(rebuild) {
    var list = d.dice || [];
    var existing = el.diceLayer.children;

    if (!rebuild && existing.length === list.length && list.length > 0) {
      // 只更新变化的那颗，不打断其他骰子的动画
      for (var i = 0; i < list.length; i++) {
        var slot = existing[i];
        var die = slot.firstChild;
        if (!die) continue;
        var cur = parseInt(die.getAttribute('data-v') || '0', 10);
        if (cur === list[i].value) continue;
        die.setAttribute('data-v', String(list[i].value));
        die.innerHTML = '';
        var pips = list[i].pips || [];
        for (var j = 0; j < pips.length; j++) die.appendChild(makePip(pips[j]));
      }
      return;
    }

    el.diceLayer.innerHTML = '';
    for (var n = 0; n < list.length; n++) {
      var it = list[n];
      var s = document.createElement('div');
      s.className = 'die-slot';
      s.setAttribute('data-i', String(n));
      s.style.left = rpx(it.l);
      s.style.top = rpx(it.t);
      // 骰子边长随数量变（5 颗 100rpx，10 颗 84rpx），其余尺寸都靠这个变量派生
      s.style.setProperty('--ds', rpx(it.s || 100));
      s.style.transform = 'rotate(' + it.r + 'deg) scaleY(0.84)';

      var box = document.createElement('div');
      box.className = 'die' + (d.revealed ? ' in' : '');
      box.style.animationDelay = n * 45 + 'ms';
      box.setAttribute('data-v', String(it.value));
      var ps = it.pips || [];
      for (var m = 0; m < ps.length; m++) box.appendChild(makePip(ps[m]));

      s.appendChild(box);
      el.diceLayer.appendChild(s);
    }
  }

  function makePip(p) {
    var e = document.createElement('div');
    e.className = 'pip' + (p.red ? ' red' : '') + (p.big ? ' big' : '');
    e.style.left = p.x + '%';
    e.style.top = p.y + '%';
    return e;
  }

  function renderButtons() {
    var items = [];

    if (!d.isLocked && (d.state === 'shaking' || (d.state === 'idle' && !d.hasLast))) {
      items.push({
        cls: 'btn primary' + (d.shaking ? ' is-off' : ''),
        text: d.shaking ? '摇骰中…' : '摇一摇',
        act: 'onShake',
        disabled: d.shaking
      });
    }
    if (!d.isLocked && (d.state === 'closed' || (d.state === 'idle' && d.hasLast))) {
      items.push({ cls: 'btn ghost', text: '摇一摇', act: 'onShake' });
      items.push({ cls: 'btn primary', text: '开盖', act: 'openCup' });
    }
    /* 掀开中 / 半开：锁定挪到左边，「合上」钉在最右 —— 就是刚才「开盖」
       的位置，手指不用挪。以前是「合上」在左、「锁定」在右，
       点完开盖再去找合上，位置全变了，很别扭。 */
    if (!d.isLocked && (d.state === 'ajar' || d.state === 'open')) {
      items.push({ cls: 'btn ghost', text: '锁定', act: 'onLock' });
      items.push({ cls: 'btn primary', text: '合上', act: 'closeCup' });
    }
    /* 已锁定：解锁 → 再来一局 → 合上/开盖。
       最右一格永远是盅盖开关，解锁和重开排在它前面。
       锁定态一行三个按钮，右边这位宽度是钉死的，所以左边两个按字数分：
       「解锁」两个字拿窄的，「再来一局」四个字拿宽的。 */
    if (d.isLocked) {
      items.push({ cls: 'btn ghost slim', text: '解锁', act: 'onUnlock' });
      items.push({ cls: 'btn primary wide', text: '再来一局', act: 'onReset' });
      items.push({
        cls: 'btn ghost',
        text: d.state === 'closed' ? '开盖' : '合上',
        act: d.state === 'closed' ? 'openCup' : 'closeCup'
      });
    }

    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += '<button class="' + items[i].cls + '" data-act="' + items[i].act + '"' +
        (items[i].disabled ? ' disabled' : '') + '>' + items[i].text + '</button>';
    }
    el.btnRow.innerHTML = html;
  }

  /* ================= 盖子位移 ================= */

  function lidStyle(p, dragging) {
    var lift = LIFT * (0.72 * p + 0.28 * p * p);
    var fade = p <= 0.94 ? 1 : Math.max(0, 1 - (p - 0.94) / 0.06);
    var transition = dragging
      ? 'none'
      : 'transform 0.36s cubic-bezier(0.26, 0.9, 0.24, 1), opacity 0.2s ease';
    return 'transform: translate3d(0, -' + rpx(lift) + ', 0); opacity: ' +
      fade.toFixed(3) + '; transition: ' + transition + ';';
  }

  function applyProgress(p, dragging) {
    S.progress = p;
    setData({ lidStyle: lidStyle(p, dragging) });
  }

  /* ================= 骰子数据 ================= */

  function emptyDice() {
    return slotsOf(d.diceCount).map(function (s, i) {
      return { id: i, value: 0, pips: [], l: s.l, t: s.t, r: s.r, s: s.s };
    });
  }

  function makeDice(values) {
    return slotsOf(d.diceCount).map(function (s, i) {
      var value = values[i];
      return {
        id: i,
        value: value,
        pips: pipsOf(value),
        l: jitter(s.l, 6),
        t: jitter(s.t, 6),
        r: jitter(s.r, 3),
        s: s.s
      };
    });
  }

  /* ================= 骰子数量（公开功能，两版都有） ================= */

  /* 2~10 一共 9 档，正好铺成 3×3 —— 和 350 的人数下拉同一个 .drop-grid */
  function buildCountList() {
    el.countDrop.innerHTML = '';
    for (var n = MIN_DICE; n <= MAX_DICE; n++) {
      var b = document.createElement('button');
      b.className = 'drop-item' + (n === d.diceCount ? ' on' : '');
      b.setAttribute('data-n', String(n));
      b.type = 'button';
      b.textContent = String(n);
      el.countDrop.appendChild(b);
    }
  }

  /* 原地展开：面板挂在 .nav 里、绝对定位到按钮下方。
     改个数量不该整屏弹个模态把人挡住，视线也不用上下跑。 */
  function openCount() {
    if (d.shaking) return;
    buildCountList();
    el.countDrop.hidden = false;
    el.countShade.hidden = false;
    el.countBtn.classList.add('on');
  }

  function closeCount() {
    el.countDrop.hidden = true;
    el.countShade.hidden = true;
    el.countBtn.classList.remove('on');
  }

  /* 换数量就当开新的一局：骰子清空、锁定解除、上一把作废。
     不清的话，盅里还躺着上一把的 5 颗，改成 7 颗后按「开盖」
     会翻出一排对不上的牌 —— 数量对不上，点数就没意义了。 */
  function setDiceCount(n) {
    n = clamp(Math.round(n), MIN_DICE, MAX_DICE);
    if (n === d.diceCount) { closeCount(); return; }

    clearTimers();
    S.lastValues = null;
    S.progress = 0;
    saveDiceCount(n);
    d.diceCount = n;

    setData({
      diceCount: n,
      dice: emptyDice(),
      diceFace: '',
      state: 'idle',
      shaking: false,
      revealed: false,
      isLocked: false,
      hasLast: false,
      lidStyle: lidStyle(0, false),
      hint: '已改成 ' + n + ' 颗 · 点「摇一摇」开始'
    });
    closeCount();
    vibrate('light');
  }

  /* ================= 摇骰 ================= */

  function onShake() {
    if (d.shaking) return;
    if (d.isLocked) {
      toast('本局已锁定，点「解锁」');
      return;
    }

    S.progress = 0;
    setData({
      state: 'shaking',
      shaking: true,
      revealed: false,
      lidStyle: lidStyle(0, false),
      hint: '摇骰中…'
    });
    playSound();
    vibrate('medium');

    clearTimers();
    S.shakeTimer = setTimeout(function () {
      S.shakeTimer = null;
      var values = slotsOf(d.diceCount).map(function () { return rollOne(); });
      S.lastValues = values.slice();

      var patch = {
        dice: makeDice(values),
        shaking: false,
        state: 'closed',
        hasLast: true,
        hint: '盖着 · 点「开盖」或上滑掀开'
      };
      setData(patch);
      vibrate('light');
    }, SHAKE_MS);
  }

  /* 把上一把的点数摆回盅里 */
  function restoreLast() {
    if (!S.lastValues || !S.lastValues.length) return false;
    var has = d.dice.some(function (x) { return x.value > 0; });
    if (!has) setData({ dice: makeDice(S.lastValues) });
    return true;
  }

  /* ================= 手势 ================= */

  function onStageStart(e) {
    var st = d.state;
    if (st === 'shaking') return;

    if (st === 'idle' && restoreLast()) {
      setData({ state: 'closed', hint: '上把的点数 · 点「开盖」或上滑掀开' });
    }

    S.startY = e.touches[0].clientY;
    S.baseP = S.progress;
    S.moved = 0;
    S.grabbing = true;
  }

  function onStageMove(e) {
    if (!S.grabbing) return;
    if (d.state === 'idle') return;

    var dy = S.startY - e.touches[0].clientY; // 上滑为正
    if (Math.abs(dy) > S.moved) S.moved = Math.abs(dy);

    var p = clamp(S.baseP + (dy * S.ratio) / OPEN_DIST, 0, 1);
    if (p !== S.progress) {
      if (!d.revealed && p > 0.28) setData({ revealed: true });
      applyProgress(p, true);
    }
  }

  function onStageEnd(e) {
    if (!S.grabbing) return;
    S.grabbing = false;

    var cancelled = !!(e && e.type === 'touchcancel');
    var tapped = S.moved < 8;

    if (d.state === 'idle') {
      if (tapped) toast('先摇一摇');
      return;
    }

    if (tapped) {
      if (d.state === 'ajar') openCup();
      else if (S.progress > 0.5) closeCup();
      else openCup();
      return;
    }

    /* 被系统打断（浏览器抢手势、来电、通知栏……）：
       这时手指其实还在往上划，只是事件被掐了。别把盖子丢在半空，
       按当前方向直接走完 —— 看到的就是「一划就开」。 */
    if (cancelled) {
      if (S.progress >= S.baseP) openCup();
      else closeCup();
      return;
    }

    settleLid();
  }

  /* 开盖时给一句话：是豹子还是顺子。两者都不是就照常提示。
     用盅里此刻摆着的点数算 —— 点骰改过点再开盖，判的也是改过的牌。 */
  function faceInfo() {
    var list = d.dice || [];
    var values = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].value) return { kind: '', text: '看清点数 · 锁定即结束本局' };
      values.push(list[i].value);
    }
    var f = faceOf(values);
    if (f.kind === 'lion') {
      return {
        kind: 'lion',
        text: f.lion === 1
          ? '豹子 · ' + f.n + ' 颗全是 1'
          : '豹子 · ' + f.n + ' 颗都是 ' + f.lion
      };
    }
    if (f.kind === 'straight') {
      return { kind: 'straight', text: '顺子 · ' + f.n + ' 颗全不同' };
    }
    return { kind: '', text: '看清点数 · 锁定即结束本局' };
  }

  function settleLid() {
    var p = S.progress;
    /* 保留的改进：过了半程就吸附到全开。
       原版要拖到 98.5% 才算「开」，松手稍差一点就停在半开，
       感觉就是「第一次只能开一点，得再滑一次」。 */
    if (p >= 0.5) {
      S.progress = 1;
      var fi = faceInfo();
      setData({
        state: 'open',
        revealed: true,
        lidStyle: lidStyle(1, false),
        hint: fi.text,
        diceFace: fi.kind
      });
      if (fi.kind) vibrate('medium');
    } else if (p <= 0.015) {
      closeCup();
    } else {
      setData({
        state: 'ajar',
        revealed: true,
        lidStyle: lidStyle(p, false),
        hint: '半开着 · 可当挡板，再上滑继续掀'
      });
    }
  }

  function openCup() {
    if (d.shaking) return;
    if (d.state === 'open' && S.progress > 0.999) return;
    if (d.state === 'idle' && !restoreLast()) {
      toast('先摇一摇');
      return;
    }
    S.progress = 1;
    var fi = faceInfo();
    setData({
      lidStyle: lidStyle(1, false),
      state: 'open',
      revealed: true,
      hint: fi.text,
      diceFace: fi.kind
    });
    if (fi.kind) vibrate('medium'); else vibrate('light');
  }

  function closeCup() {
    if (d.shaking) return;
    S.progress = 0;
    setData({
      lidStyle: lidStyle(0, false),
      state: 'closed',
      revealed: false,
      hint: '盖着 · 点「开盖」或上滑掀开'
    });
  }

  /* ================= 锁定 / 重开 ================= */

  function onLock() {
    var st = d.state;
    if ((st !== 'open' && st !== 'ajar') || d.isLocked) return;
    setData({ isLocked: true, hint: '已锁定 · 可开合查看，不能再摇' });
    vibrate('heavy');
  }

  function onUnlock() {
    if (!d.isLocked) return;
    var st = d.state;
    var hint = st === 'open'
      ? '看清点数 · 锁定即结束本局'
      : st === 'ajar'
        ? '半开着 · 可当挡板，再上滑继续掀'
        : '盖着 · 点「开盖」或上滑掀开';
    setData({ isLocked: false, hint: hint });
    vibrate('light');
  }

  function onReset() {
    clearTimers();
    S.progress = 0;
    setData({
      state: 'idle',
      isLocked: false,
      shaking: false,
      revealed: false,
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      hasLast: !!S.lastValues,
      hint: S.lastValues ? '点「开盖」看上把，或摇一摇重开' : '点「摇一摇」开始这一局'
    });
  }

  /* 骰盅下方那块空白桌面：从这儿起手往上滑，一样能把盖子掀开。
     位移超过 HOT_MOVE 才算拖动，否则轻微抖动都当点击。 */
  var HOT_MOVE = 16;          // 超过这么多才算在拖盖子（手指抖一下不算）

  function onHoldStart(e) {
    var t = e && e.touches && e.touches[0];
    S.hotX = t ? t.clientX : null;
    S.hotY = t ? t.clientY : null;
    S.hotDragging = false;
  }

  function onHoldMove(e) {
    var t = e && e.touches && e.touches[0];
    if (!t || S.hotY === null) return;

    var far = Math.abs(t.clientY - S.hotY) > HOT_MOVE || Math.abs(t.clientX - S.hotX) > HOT_MOVE;
    if (far && !S.hotDragging) {
      S.hotDragging = true;
      if (d.state === 'idle' && restoreLast()) {
        setData({ state: 'closed', hint: '上把的点数 · 点「开盖」或上滑掀开' });
      }
      S.startY = t.clientY;
      S.baseP = S.progress;
      S.moved = 0;
      S.grabbing = true;
    }

    if (S.hotDragging && S.grabbing) onStageMove(e);
  }

  function onHoldEnd() {
    var dragged = S.hotDragging && S.moved >= HOT_MOVE;
    S.hotDragging = false;
    S.grabbing = false;
    S.hotY = null;
    S.hotX = null;
    if (dragged) settleLid();
  }

  /* ================= 音效开关 ================= */  /* ================= 音效开关 ================= */

  function setSound(on) {
    setData({ soundOn: on });
    vibrate('light');
  }

  /* ================= 计时器 ================= */

  function clearTimers() {
    if (S.shakeTimer) {
      clearTimeout(S.shakeTimer);
      S.shakeTimer = null;
    }
  }

  /* ================= 事件绑定 ================= */

  function on(target, type, fn, opts) {
    if (target) target.addEventListener(type, fn, opts || false);
  }

  function bindEvents() {
    // 音效
    on(el.soundBtn, 'click', function () { setSound(!d.soundOn); });

    // 骰子数量：点标题右边那个「N 颗」拉开选择条
    on(el.countBtn, 'click', function () {
      if (el.countDrop.hidden) openCount();
      else closeCount();
    });
    on(el.countShade, 'click', closeCount);
    on(el.countDrop, 'click', function (e) {
      var t = e.target;
      while (t && t !== el.countDrop && !t.getAttribute('data-n')) t = t.parentNode;
      if (!t || t === el.countDrop) return;
      setDiceCount(parseInt(t.getAttribute('data-n'), 10));
    });

    // 骰盅下方空白桌面：从这里起手也能上滑掀盖
    on(el.hotZone, 'touchstart', onHoldStart, { passive: true });
    on(el.hotZone, 'touchmove', function (e) {
      if (S.hotDragging) e.preventDefault();
      onHoldMove(e);
    }, { passive: false });
    on(el.hotZone, 'touchend', onHoldEnd);
    on(el.hotZone, 'touchcancel', onHoldEnd);
    on(el.hotZone, 'mousedown', onHoldStart);
    on(document, 'mouseup', onHoldEnd);

    // 舞台手势
    // passive 必须是 false：否则浏览器要先判断这是不是滚动，
    // 前几帧 touchmove 会被吞掉 —— 表现就是「滑一点停住，再滑才顺」
    on(el.stage, 'touchstart', onStageStart, { passive: false });
    on(el.stage, 'touchmove', function (e) {
      if (S.grabbing) e.preventDefault();
      onStageMove(e);
    }, { passive: false });
    on(el.stage, 'touchend', onStageEnd);
    on(el.stage, 'touchcancel', onStageEnd);
    // 兜底：万一 touchend/touchcancel 没冒泡到 stage（手指抬起时
    // 触摸目标已被移除等），document 上一定收得到 —— 否则手势会
    // 卡在半路，状态还停在「盖着」，只能再滑一次。
    on(document, 'touchend', function () { if (S.grabbing) onStageEnd({ type: 'touchend' }); });
    on(document, 'touchcancel', function () { if (S.grabbing) onStageEnd({ type: 'touchcancel' }); });

    // 底部按钮
    on(el.btnRow, 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'onShake') onShake();
      else if (act === 'openCup') openCup();
      else if (act === 'closeCup') closeCup();
      else if (act === 'onLock') onLock();
      else if (act === 'onUnlock') onUnlock();
      else if (act === 'onReset') onReset();
    });

    // 页面切走时停音效
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimers();
        stopSound();
      }
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    S.ratio = 750 / (window.innerWidth || 375);
    S.progress = 0;
    S.lastValues = null;
    d.diceCount = loadDiceCount();

    initAudio();
    bindEvents();

    setData({
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      soundOn: true,
      isLocked: false,
      diceCount: d.diceCount
    });

    // 首帧把按钮和音效图标补上
    el.soundIc.textContent = d.soundOn ? '🔊' : '🔇';
    el.soundBtn.classList.toggle('off', !d.soundOn);
    renderButtons();

    window.addEventListener('resize', function () {
      S.ratio = 750 / (window.innerWidth || 375);
    });

  }

  /* 给 f350.js 的路由用：切走了要顺手把数量下拉收掉；
     系统返回时也得先收起这一层，不然会带着一个悬空的面板退到上一页。 */
  window.LDCount = {
    isOpen: function () { return !!el.countDrop && !el.countDrop.hidden; },
    close: function () { if (el.countDrop) closeCount(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ================= 添加到桌面 =================

   网页版没有安装包，但可以「添加到主屏幕」：加完从桌面点开是全屏、没有地址栏，
   图标也是同一个，用起来跟 APK 差别很小。装机率一直是网页版最难的一步，所以首页
   直接给一条入口，点开按机型给步骤（iOS 和安卓的路径完全不一样，混着讲没人看得懂）。

   什么时候不出现：
     · 已经是从桌面图标打开的（standalone / fullscreen）—— 已经在桌面上了，别啰嗦
     · 用户点过「不用了，以后别再提醒」—— 存在 localStorage，下次不再问
   安卓 Chrome 会把系统安装框交给我们（beforeinstallprompt），能弹就直接弹，
   比讲三步清楚；iOS 没有这个事件，只能手把手教。 */

(function () {
  'use strict';

  var KEY = 'ld.a2hs.off';
  var bar = document.getElementById('addHome');
  if (!bar) return;

  var UA = navigator.userAgent || '';
  var mq = window.matchMedia ? window.matchMedia.bind(window) : null;

  function matches(q) { return !!(mq && mq(q).matches); }

  var standalone = window.navigator.standalone === true ||
    matches('(display-mode: standalone)') || matches('(display-mode: fullscreen)');

  function seen() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function mark() {
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  /* APK 里读的是 file:///android_asset/www/index.html —— 它本身就是装好的 App，
     再劝人「添加到桌面」纯属添乱。网页版走 http(s)，这条自然不会命中。 */
  var hostApp = location.protocol === 'file:';

  if (standalone || hostApp || seen()) return;

  var isIOS = /iPad|iPhone|iPod/.test(UA) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  var isAndroid = /Android/i.test(UA);
  /* 微信 / QQ / 微博这些内置浏览器加不了桌面图标，得先跳出去 */
  var inApp = /MicroMessenger|QQ\/|Weibo|AlipayClient|DingTalk|Lark|aweme|baiduboxapp/i.test(UA);

  var mask = document.getElementById('a2hsMask');
  var body = document.getElementById('a2hsBody');
  var defer = null;

  function steps(title, arr, note) {
    var h = '<div class="rule-sec"><div class="rule-sec-t">' + title + '</div>';
    for (var i = 0; i < arr.length; i++) {
      h += '<div class="rule-li"><i>' + (i + 1) + '</i><span>' + arr[i] + '</span></div>';
    }
    h += '</div>';
    if (note) h += '<div class="rule-note">' + note + '</div>';
    return h;
  }

  function build() {
    var h = '<div class="a2hs-prev">' +
      '<img src="apple-touch-icon.png" alt="">' +
      '<div class="a2hs-prev-tx"><strong>骰子</strong><span>加完桌面就多这个图标</span></div>' +
      '</div>' +
      '<div class="rule-lead">从桌面点开是全屏的，没有地址栏，跟装的 App 一样。</div>';

    if (inApp) {
      h += steps('先跳出微信 / QQ 的内置浏览器', [
        '点右上角「<strong>…</strong>」',
        '选「<strong>在浏览器打开</strong>」（有的写「用 Safari 打开」）',
        '跳到浏览器后，再按下面的步骤加'
      ], '内置浏览器里没有「添加到主屏幕」这一项，不跳出去加不了。');
    }

    if (isIOS) {
      h += steps('iPhone / iPad', [
        '用 <strong>Safari</strong> 打开本页（iOS 只允许 Safari 把网页加到主屏幕）',
        '点屏幕<strong>底部中间</strong>的「分享」—— 一个方框加一支向上的箭头',
        '在弹出来的列表里往下滑，找到「<strong>添加到主屏幕</strong>」',
        '右上角点「<strong>添加</strong>」'
      ], '这一步是系统限制：别的浏览器打开时，分享列表里没有「添加到主屏幕」这一项。');
    } else if (isAndroid) {
      /* 网页没有权限去拨系统的「应用权限」页面（Android 不允许网页拉 settings intent），
         所以「替用户把权限开了」这件事做不到。但有一条绕过去的路：
         走浏览器的「安装应用」—— Chromium 系装的是 WebAPK，图标由系统自己放到桌面，
         **压根不需要「桌面快捷方式」权限**。能拿到 beforeinstallprompt 就在这一页直接给按钮，
         用户点一下、系统弹安装框、点「安装」，比去设置里翻权限快得多。 */
      if (defer) {
        h += '<button class="a2hs-install" id="a2hsInstall" type="button">' +
          '<b>让浏览器直接装</b>' +
          '<span>系统会弹一个安装框，点「安装」就好 —— 这条路不用「桌面快捷方式」权限，图标自己上桌面</span>' +
          '</button>';
      }
      h += steps('安卓', [
        '用任意浏览器打开本页（自带浏览器、Chrome、Edge 都行）',
        '点右上角「<strong>⋮</strong>」，或底部「<strong>≡</strong>」菜单',
        '优先选「<strong>安装应用</strong>」（有的写「安装」）—— 走这条不用额外权限；' +
          '没有这一项再选「<strong>添加到主屏幕 / 添加到桌面</strong>」',
        '确认「安装」/「添加」'
      ]);
      /* 加完桌面没图标，八成不是浏览器的事，是它没有「创建桌面快捷方式」这个权限 ——
         用户 11-09 用华为 + Edge 实测过：同一个 Edge，授权之后就能加。
         所以这里教怎么开权限，而不是劝人换浏览器（那属于误诊）。 */
      h += '<div class="a2hs-warn">' +
        '<b>加了「添加到桌面」却没出现图标？去给浏览器开个权限</b>' +
        '<span>这种情况是那个浏览器<strong>没有被允许「创建桌面快捷方式」</strong>，跟用哪个浏览器无关。' +
        '<strong>华为 / 荣耀</strong>：设置 → 应用和服务 → 应用管理 → 找到这个浏览器 → 权限 → ' +
        '<strong>桌面快捷方式</strong> → 允许。<strong>小米 / OPPO / vivo</strong> 同样在「应用管理 → 权限」里，' +
        '名字可能叫「桌面快捷方式」「创建桌面快捷方式」。开完回浏览器再添加一次就出来了。' +
        '（网页没法替你跳过去开，这一页只能把路径写清楚。）</span>' +
        '</div>' +
        '<button class="a2hs-copy" id="a2hsCopy" type="button">复制网址</button>';
    } else {
      h += steps('电脑 / 其它设备', [
        'Chrome 地址栏右边点「安装」小图标（一个屏幕加箭头）',
        '或者右上角菜单里选「安装」/「添加到主屏幕」'
      ]);
    }

    h += '<div class="a2hs-off" id="a2hsOff">不用了，以后别再提醒</div>';
    body.innerHTML = h;

    var off = document.getElementById('a2hsOff');
    if (off) {
      off.addEventListener('click', function () {
        mark();
        bar.hidden = true;
        close();
      });
    }

    /* 换浏览器这一步最容易卡在「网址怎么带过去」：手打一长串不现实，
       所以给一颗复制按钮。剪贴板 API 在非 https 或老 WebView 里可能没有，
       退回到 textarea + execCommand 那一套老办法。 */
    var cp = document.getElementById('a2hsCopy');
    if (cp) {
      cp.addEventListener('click', function () {
        function done() {
          cp.textContent = '已复制 ✓ 去自带浏览器粘贴打开';
          cp.classList.add('done');
        }
        var url = location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, function () { legacyCopy(url, done); });
        } else {
          legacyCopy(url, done);
        }
      });
    }

    /* 「让浏览器直接装」：这是这一页里唯一能真正「调起系统」的动作 ——
       网页拿不到「创建桌面快捷方式」这种系统权限，但能请浏览器走它自己的安装流程。
       接受就收摊；取消就把按钮改成「刚才取消了」，别让用户以为没点到。 */
    var ib = document.getElementById('a2hsInstall');
    if (ib) {
      ib.addEventListener('click', function () {
        if (!defer) return;
        var d = defer;
        defer = null;
        d.prompt();
        if (d.userChoice && d.userChoice.then) {
          d.userChoice.then(function (r) {
            if (r && r.outcome === 'accepted') {
              mark();
              bar.hidden = true;
              close();
              return;
            }
            ib.classList.add('done');
            var t = ib.querySelector('b');
            var s = ib.querySelector('span');
            if (t) t.textContent = '刚才取消了';
            if (s) s.textContent = '也可以照下面第 2 步手动加，效果一样';
          });
        }
      });
    }
  }

  function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  function open() {
    if (!mask) return;
    build();
    mask.style.display = 'flex';
    var sheet = mask.querySelector('.rule-sheet');
    if (sheet) sheet.scrollTop = 0;
  }

  function close() {
    if (mask) mask.style.display = 'none';
  }

  /* 一律先开这一页：以前浏览器能装就直接弹系统框，用户看到的是一个没有上下文的
     「安装应用？」—— 不知道装了会怎样、也不知道还有别的路。现在先给一页说明，
     能装的话最上面就是那颗「让浏览器直接装」，点一下照样是系统框。 */
  bar.addEventListener('click', open);

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    defer = e;
    bar.hidden = false;
  });

  window.addEventListener('appinstalled', function () {
    mark();
    bar.hidden = true;
  });

  var x = document.getElementById('a2hsClose');
  if (x) x.addEventListener('click', close);
  if (mask) {
    mask.addEventListener('click', function (e) {
      if (e.target === mask) close();
    });
  }

  bar.hidden = false;
})();

/* ================= 免责声明与使用条款 =================

   第一次打开自动弹一次，点过「我知道了」就不再弹，之后从首页底部那颗「免责声明」看。

   这是一份**给别人看的条款**，不是玩法介绍，所以按条款的结构写：
   一句定性（谁能用、干什么用）+ 禁止用途 + 责任免除 + 其他。
   改文案时守三条：
     · 不喝酒 —— 骰子就是骰子，不替酒桌规矩背书；
     · 不点名任何额外功能 —— 声明是公开的，写出来等于替人指路；
     · 不放仓库/下载链接 —— 这里只说明立场，不做分发入口。

   篇幅比玩法说明长得多，所以弹层做成「标题不动 + 正文内部滚动 + 按钮不动」：
   整块最高 64vh，上面永远留出首页的一角（一眼看出是压在首页上的一层，不是整屏），
   按钮永远露在下面，不会出现「滚到底才找得到同意」。
   正文底部有一条渐隐，滚到底自己淡掉 —— 提示这里还有下文，但不挡字。 */

(function () {
  'use strict';

  var KEY = 'ld.terms.ok';
  var mask = document.getElementById('termsMask');
  var body = document.getElementById('termsBody');
  var btn = document.getElementById('termsBtn');
  if (!mask || !body) return;

  var LEAD = '本项目（含 App（APK）、网页版、全部源码与素材）仅供<strong>个人在朋友聚会' +
    '等非营利场合娱乐</strong>使用，<strong>不得用于任何非法用途</strong>。';

  var SECS = [
    {
      t: '一、禁止用途',
      p: '严禁将本项目或其衍生版本用于以下任何用途：',
      li: [
        '任何形式的<strong>赌博、变相赌博</strong>，包括但不限于以金钱、财物、' +
          '虚拟货币、积分兑奖等作为赌注的场合；',
        '<strong>抽头渔利</strong>、开设赌场、组织赌博，或为上述活动提供工具、场地、技术支持；',
        '<strong>诈骗、欺瞒取财</strong>：本项目仅可用于朋友之间的玩笑，不得用于骗取他人财物，' +
          '或在任何涉及真实利益的场合使用；',
        '冒充官方应用、诱导他人安装、捆绑分发、植入广告或恶意代码；',
        '任何违反使用者所在地法律法规的用途。'
      ],
      note: '若您所在地区对相关玩法的使用有额外限制，请以当地法律为准，并立即停止使用。'
    },
    {
      t: '二、责任免除',
      li: [
        '本项目的代码、安装包与说明文档均按 <strong>AS IS（「现状」）</strong>提供，' +
          '不附带任何明示或默示的担保，包括但不限于对适用性、无缺陷、不侵权的担保。',
        '作者不保证本项目在任何设备、任何系统版本上均能正常运行，也不承诺修复缺陷或持续更新。',
        '使用本项目所产生的<strong>全部风险与后果，由使用者自行承担</strong>。' +
          '在法律允许的最大范围内，作者不对因下载、安装、使用或无法使用本项目而导致的' +
          '任何直接、间接、偶然、特殊或后果性损失负责，包括但不限于：财物损失、人身损害、' +
          '名誉损失、数据丢失、设备损坏、法律纠纷、行政处罚。',
        '使用者因违反本条款或当地法律而产生的任何法律责任，与作者无关，由使用者独立承担；' +
          '如因此给作者造成损失（包括合理的律师费），使用者应予赔偿。',
        '本项目未上架任何应用商店，签名证书随源码公开，仅供个人侧载。' +
          '任何第三方分发、修改、重新打包的版本均不代表作者，作者不对其内容与安全性负责。'
      ]
    },
    {
      t: '三、其他',
      li: [
        '分数与设置只存在<strong>本机</strong>，不上传服务器，也不收集任何个人信息。',
        '除上述骰子玩法之外，其他任何用法与本工具无关。'
      ]
    }
  ];

  function read() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function mark() {
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  function build() {
    var i, j;
    var h = '<div class="terms-scrollwrap">';
    h += '<div class="terms-scroll" id="termsScroll">';
    h += '<div class="rule-lead">' + LEAD + '</div>';
    for (i = 0; i < SECS.length; i++) {
      var s = SECS[i];
      h += '<div class="terms-sec"><div class="terms-sec-t">' + s.t + '</div>';
      if (s.p) h += '<div class="terms-p">' + s.p + '</div>';
      for (j = 0; j < s.li.length; j++) {
        h += '<div class="rule-li"><em></em><span>' + s.li[j] + '</span></div>';
      }
      if (s.note) h += '<div class="terms-note">' + s.note + '</div>';
      h += '</div>';
    }
    h += '</div><div class="terms-topfade is-off" id="termsTopfade"></div>' +
      '<div class="terms-fade" id="termsFade"></div></div>';
    h += '<div class="terms-foot">' +
      '<button class="terms-ok" id="termsOk">我知道了</button></div>';
    body.innerHTML = h;

    var sc = document.getElementById('termsScroll');
    var fade = document.getElementById('termsFade');
    var topfade = document.getElementById('termsTopfade');
    /* 上下两条渐隐：只在「那个方向还有内容」时出现。
       一屏装得下就都别留，否则最后一句会被盖层灰。 */
    function syncFade() {
      if (!sc) return;
      if (fade) {
        fade.className = (sc.scrollHeight - sc.clientHeight - sc.scrollTop > 6)
          ? 'terms-fade' : 'terms-fade is-off';
      }
      if (topfade) {
        topfade.className = (sc.scrollTop > 4)
          ? 'terms-topfade' : 'terms-topfade is-off';
      }
    }
    if (sc) {
      sc.addEventListener('scroll', syncFade, { passive: true });
      syncFade();
    }

    var okBtn = document.getElementById('termsOk');
    if (okBtn) {
      okBtn.addEventListener('click', function () {
        mark();
        close();
      });
    }
  }

  function open() {
    build();
    mask.style.display = 'flex';
    var sc = document.getElementById('termsScroll');
    if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); }
  }
  function close() { mask.style.display = 'none'; }

  if (btn) btn.addEventListener('click', open);

  var x = document.getElementById('termsClose');
  if (x) x.addEventListener('click', close);

  /* 点空白处只收起来，不算「看过」—— 手滑点掉的那次不该把说明吞掉 */
  mask.addEventListener('click', function (e) {
    if (e.target === mask) close();
  });

  if (!read()) {
    /* 等首页画完再压上去，别让人看见一层没内容的灰 */
    setTimeout(open, 420);
  }
})();

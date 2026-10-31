/* 吹牛骰子 · 网页版（由小程序版 1:1 移植）
   纯本地运行：无后端、无网络请求、无登录。
   所有状态与手势逻辑与原小程序 pages/index/index.js 保持一致。 */

(function () {
  'use strict';

  /* ================= 常量 ================= */

  var OPEN_DIST = 190;      // 上滑多少 rpx 算完全掀开（越小越跟手）
  var LIFT = 340;            // 完全揭开时盖子向上抬起的距离(rpx)
  var SHAKE_MS = 1600;       // 摇骰动画时长（与 shake.mp3 对齐）
  var DOUBLE_TAP_MS = 420;   // 点骰改点：两下之间的最大间隔

  var PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };
  var CELL = [20, 50, 80];

  var SLOTS = [
    { l: 134, t: 52, r: -9 },
    { l: 250, t: 44, r: 6 },
    { l: 366, t: 54, r: -4 },
    { l: 188, t: 158, r: 8 },
    { l: 312, t: 164, r: -7 }
  ];

  var RED_FACES = { 1: true, 4: true };
  var LION_CHIPS = [1, 2, 3, 4, 5, 6];
  var STRAIGHTS = { 1: [1, 2, 3, 4, 5], 2: [2, 3, 4, 5, 6] };

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

  function jitter(base, range) {
    return Math.round(base + (Math.random() * 2 - 1) * range);
  }

  function rollOne() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /* 豹子：1 是万能牌 —— 去掉所有 1 之后，剩下的必须全部相同。
     所以 11111 / 11333 / 14444 / 11114 / 11122 都算豹子。
     顺子：5 个数互不重复（12345 / 13456 都算）。 */
  function quickState(values) {
    var rest = [];
    for (var i = 0; i < values.length; i++) {
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

    var uniq = [];
    for (var k = 0; k < values.length; k++) {
      if (uniq.indexOf(values[k]) < 0) uniq.push(values[k]);
    }
    var key = values.join('');
    return {
      quickLion: lion,
      quickStraight: uniq.length === values.length ? 1 : 0,
      quickFixed: key === '12345' ? 1 : key === '23456' ? 2 : 0
    };
  }

  function randomStraight() {
    var pool = [1, 2, 3, 4, 5, 6];
    pool.splice(Math.floor(Math.random() * 6), 1);
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool;
  }

  /* ================= 本地存储 / 音效 / 震动 / 提示 ================= */

  var STORE_KEY = 'ld_tap_edit';
  var memTapEdit = false;

  function loadTapEdit() {
    try {
      return localStorage.getItem(STORE_KEY) === '1';
    } catch (e) {
      return memTapEdit;
    }
  }
  function saveTapEdit(on) {
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0');
    } catch (e) {
      memTapEdit = !!on;
    }
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
      hint: '点「摇一摇」开始这一局',
      soundOn: true,
      hasLast: false,
      panel: false,
      forceOn: false,
      forceValues: [1, 1, 1, 1, 1],
      quickLion: 1,
      quickStraight: 0,
      quickFixed: 0,
      tapEdit: false,
    },
    shoundOnGuard: function () { return S.data.soundOn; },

    /* 实例属性 */
    progress: 0,
    lastValues: null,
    tapDieIdx: -1,
    tapDieAt: 0,
    ratio: 2,
    baseP: 0,
    startY: 0,
    moved: 0,
    grabbing: false,
    swallowDieTap: false,
    shakeTimer: null,
    titleTimer: null,
    hotY: null,
    hotX: null,
    hotDragging: false,
    hotSwallowTap: false,
    hotSwallowAt: 0
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
    titleBtn: document.getElementById('titleBtn'),
    mask: document.getElementById('mask'),
    sheet: document.getElementById('sheet'),
    lionRow: document.getElementById('lionRow'),
    straightRow: document.getElementById('straightRow'),
    forceState: document.getElementById('forceState'),
    fsText: document.getElementById('fsText'),
    swTapEdit: document.getElementById('swTapEdit'),
    swSound: document.getElementById('swSound'),
    panelDone: document.getElementById('panelDone'),
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
    }
    if (has(keys, 'soundOn')) {
      el.soundIc.textContent = d.soundOn ? '🔊' : '🔇';
      el.soundBtn.classList.toggle('off', !d.soundOn);
    }
    if (has(keys, 'tapEdit')) {
      document.body.classList.toggle('tap-edit', !!d.tapEdit);
    }
    if (has(keys, 'panel')) {
      el.mask.style.display = d.panel ? 'flex' : 'none';
      if (d.panel) buildPanel();
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

    if (has(keys, 'forceOn') || has(keys, 'forceValues') ||
        has(keys, 'quickLion') || has(keys, 'quickStraight') || has(keys, 'quickFixed')) {
      if (d.panel) syncPanel();
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
    if (!d.isLocked && d.state === 'ajar') {
      items.push({ cls: 'btn ghost', text: '合上', act: 'closeCup' });
      items.push({ cls: 'btn primary', text: '锁定', act: 'onLock' });
    }
    if (!d.isLocked && d.state === 'open') {
      items.push({ cls: 'btn ghost', text: '合上', act: 'closeCup' });
      items.push({ cls: 'btn primary', text: '锁定', act: 'onLock' });
    }
    if (d.isLocked && d.state !== 'closed') {
      items.push({ cls: 'btn ghost', text: '合上', act: 'closeCup' });
    }
    if (d.isLocked && d.state === 'closed') {
      items.push({ cls: 'btn ghost', text: '开盖', act: 'openCup' });
    }
    if (d.isLocked) {
      items.push({ cls: 'btn ghost', text: '解锁', act: 'onUnlock' });
      items.push({ cls: 'btn primary', text: '再来一局', act: 'onReset' });
    }

    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += '<button class="' + items[i].cls + '" data-act="' + items[i].act + '"' +
        (items[i].disabled ? ' disabled' : '') + '>' + items[i].text + '</button>';
    }
    el.btnRow.innerHTML = html;
  }

  /* ---------------- 面板 ---------------- */

  function buildPanel() {
    /* 一键豹子：
       · 「万能豹子」—— 点数、形态都随机，里面会带 1（1 是万能牌，组合太多）
       · 下面 1~6 —— 全豹子，干净利落的五个一样的数字，不带 1 */
    var lh = '<div class="quick-row"><div class="qchip wide" data-lion="0">万能豹子</div></div>';
    lh += '<div class="quick-row">';
    for (var i = 0; i < LION_CHIPS.length; i++) {
      lh += '<div class="qchip" data-lion="' + LION_CHIPS[i] + '">' + LION_CHIPS[i] + '</div>';
    }
    lh += '</div>';
    el.lionRow.innerHTML = lh;

    // 顺子
    el.straightRow.innerHTML =
      '<div class="qchip wide hot" data-straight="0">随机顺子</div>' +
      '<div class="qchip wide" data-straight="1">1 2 3 4 5</div>' +
      '<div class="qchip wide" data-straight="2">2 3 4 5 6</div>';

    el.swTapEdit.checked = !!d.tapEdit;
    el.swSound.checked = !!d.soundOn;

    syncPanel();
  }

  function syncPanel() {
    // 豹子 chip：随机那个只要当前是豹子就亮；点数那个按点数亮
    var lions = el.lionRow.querySelectorAll('.qchip');
    for (var i = 0; i < lions.length; i++) {
      var lv = Number(lions[i].getAttribute('data-lion'));
      var onLion = lv === 0
        ? !!(d.forceOn && d.quickLion > 0)
        : !!(d.forceOn && d.quickLion === lv);
      lions[i].classList.toggle('on', onLion);
    }
    // 顺子 chips
    var sts = el.straightRow.children;
    for (var j = 0; j < sts.length; j++) {
      var key = Number(sts[j].getAttribute('data-straight'));
      var on = key === 0 ? !!(d.forceOn && d.quickStraight)
        : !!(d.forceOn && d.quickFixed === key);
      sts[j].classList.toggle('on', on);
    }
    // 装填状态条
    el.forceState.classList.toggle('armed', !!d.forceOn);
    el.fsText.textContent = d.forceOn
      ? '已装填 · 摇一摇生效 · 仅一次'
      : '未装填 · 点了之后再摇一摇才生效';
    // 开关同步
    el.swTapEdit.checked = !!d.tapEdit;
    el.swSound.checked = !!d.soundOn;
  }

  /* ---------------- 点骰改点 ---------------- */

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
    return SLOTS.map(function (s, i) {
      return { id: i, value: 0, pips: [], l: s.l, t: s.t, r: s.r };
    });
  }

  function makeDice(values) {
    return SLOTS.map(function (s, i) {
      var value = values[i];
      return {
        id: i,
        value: value,
        pips: pipsOf(value),
        l: jitter(s.l, 6),
        t: jitter(s.t, 6),
        r: jitter(s.r, 3)
      };
    });
  }

  /* ================= 摇骰 ================= */

  function onShake() {
    if (d.shaking) return;
    if (d.isLocked) {
      toast('本局已锁定，点「解锁」');
      return;
    }
    if (d.panel) return;

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
      var forced = d.forceOn;
      var values = forced ? d.forceValues.slice()
        : SLOTS.map(function () { return rollOne(); });
      S.lastValues = values.slice();

      var patch = {
        dice: makeDice(values),
        shaking: false,
        state: 'closed',
        hasLast: true,
        hint: '盖着 · 点「开盖」或上滑掀开'
      };
      // 装填不清：只要还没开盖，摇多少次都是这个点数（用户要的就是这个）
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
    if (d.panel) return;
    var st = d.state;
    if (st === 'shaking') return;

    if (st === 'idle' && restoreLast()) {
      setData({ state: 'closed', hint: '上把的点数 · 点「开盖」或上滑掀开' });
    }

    S.swallowDieTap = false;
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
      if (d.tapEdit && (d.state === 'open' || d.state === 'ajar')) return;
      S.swallowDieTap = true;
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

  function settleLid() {
    var p = S.progress;
    /* 保留的改进：过了半程就吸附到全开。
       原版要拖到 98.5% 才算「开」，松手稍差一点就停在半开，
       感觉就是「第一次只能开一点，得再滑一次」。 */
    if (p >= 0.5) {
      S.progress = 1;
      setData({
        state: 'open',
        revealed: true,
        forceOn: false,   // 开盖了：本局作弊到此为止，下次摇骰恢复真随机
        lidStyle: lidStyle(1, false),
        hint: '看清点数 · 锁定即结束本局'
      });
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
    setData({
      lidStyle: lidStyle(1, false),
      state: 'open',
      revealed: true,
      forceOn: false,   // 揭开了：装填解除
      hint: '看清点数 · 锁定即结束本局'
    });
    vibrate('light');
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

  /* ================= 隐藏入口：长按标题 1.2s ================= */

  function onTitleStart() {
    clearTimers();
    S.titleTimer = setTimeout(function () {
      S.titleTimer = null;
      openPanel();
    }, 1200);
  }

  function onTitleEnd() {
    if (S.titleTimer) {
      clearTimeout(S.titleTimer);
      S.titleTimer = null;
    }
  }

  /* 骰盅下方那块空白桌面：三格隐形点击区
       左 1/3 → 随机顺子    中 1/3 → 点骰改点开关    右 1/3 → 随机万能豹子
     单击就生效，没有任何长按、也没有任何文字。
     手指往上拖才算「掀盖」：位移要超过 HOT_MOVE，否则轻微抖动都当点击。 */
  var HOT_MOVE = 16;          // 超过这么多才算在拖盖子（手指抖一下不算）
  var HOT_TAP_BACK = 500;     // 拖过之后这 500ms 内的 click 不再算「点了三格」

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
    if (far && !S.hotDragging && !d.panel) {
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
    if (dragged) {
      settleLid();
      /* 掀完盖手指抬起，浏览器有时还会补一次 click。
         那一瞬间手指已经离开桌面了，不该再算「点了三格」，
         否则上滑开盖会顺手装填一次。 */
      S.hotSwallowTap = true;
      S.hotSwallowAt = Date.now();
    }
  }

  function canArm() {
    return !d.shaking && !d.isLocked && (d.state === 'idle' || d.state === 'closed');
  }

  /* 点骰改点开关：不弹字，用震动次数区分 —— 开是两下，关是一下 */
  function toggleTapEdit() {
    var on = !d.tapEdit;
    saveTapEdit(on);
    setData({ tapEdit: on });
    /* 完全没有视觉反馈，只能靠手感区分：
       开 = 两下短促的「咔咔」，关 = 一下长的「嗡」 */
    try {
      if (navigator.vibrate) navigator.vibrate(on ? [14, 75, 14] : 45);
    } catch (err) {}
  }

  function onHotTap(e) {
    if (d.panel) return;
    if (S.hotSwallowTap && Date.now() - S.hotSwallowAt < HOT_TAP_BACK) {
      S.hotSwallowTap = false;   // 这是刚才掀盖手势的尾巴，不是点击
      return;
    }
    S.hotSwallowTap = false;
    var r = el.hotZone.getBoundingClientRect();
    if (!r.width) return;
    var k = (e.clientX - r.left) / r.width;

    if (k < 1 / 3) {
      if (canArm()) applyCheat(randomStraight());
    } else if (k < 2 / 3) {
      toggleTapEdit();
    } else if (canArm()) {
      applyCheat(randomLion());
    }
  }

  function openPanel() {
    vibrate('light');
    setData({ panel: true });
    /* 面板是贴着底部弹出来的，长按时手指正好在它上面 ——
       松手（touchend）会把面板上的按钮当成一次点击，
       于是「刚打开面板就自动点了一个作弊项」。
       这里挡掉这次触摸剩下的点击，手指抬起后自动恢复。 */
    if (el.sheet) {
      el.sheet.style.pointerEvents = 'none';
      setTimeout(function () {
        if (el.sheet) el.sheet.style.pointerEvents = '';
      }, 400);
    }
  }

  function closePanel() {
    setData({ panel: false });
  }

  /* ================= 作弊 ================= */

  /* 只「装填」，绝不碰当前这一把。
     点了立刻改结果的话，旁边人一眼就能看出「还没摇，点数自己变了」；
     而且摇多少遍都是这个结果。所以一律等摇骰时才按装填的点数出，
     并且只用一次 —— 下一次摇骰就是真随机。 */
  function commitValues(values) {
    var q = quickState(values);
    setData({
      forceValues: values,
      forceOn: true,
      quickLion: q.quickLion,
      quickStraight: q.quickStraight,
      quickFixed: q.quickFixed
    });
  }

  /* 静默：不弹任何文字。确认感靠一下震动 —— 只有握着手机的人知道。
     8ms 那种轻震在口袋里都感觉不到，这里用 22ms，和「中格开关」的节奏错开：
       装填 = 一下（左右两格）
       开   = 两下（中格）
       关   = 一下长的（中格） */
  function applyCheat(values) {
    commitValues(values);
    try {
      if (navigator.vibrate) navigator.vibrate(22);
    } catch (err) {}
  }


  /* 随机一个豹子：点数随机 × 形态随机。
     1 是万能牌，所以点「随机豹子」会得到各种样子：
       44444 / 14444 / 11444 / 11144 / 11114 / 14144 / 41144 …
     组合数 = 5 个点数 × 31 种排列 = 155 种，不会老是那几个。
     至少保留一个真正的点数，否则就成了「全 1」而不是这个点数的豹子。 */
  function randomLion() {
    // 点数取 2~6：1 只能组成「11111」，那是全豹，不是万能
    var v = 2 + Math.floor(Math.random() * 5);
    // 真点数个数取 1~4 —— 至少留一个 1 才算「万能」。
    // 取 5 就成了纯豹（44444），那是下面 1~6 那排的事。
    var r = Math.random();
    var k = r < 0.15 ? 1 : r < 0.45 ? 2 : r < 0.75 ? 3 : 4;
    var out = [];
    var i;
    for (i = 0; i < k; i++) out.push(v);
    while (out.length < 5) out.push(1);
    // 打散顺序，别让 1 全堆在后面
    for (i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* v = 0 → 随机豹子；1~6 → 固定豹子（五个一样的数字，不带万能 1） */
  function onSetLion(v) {
    if (!v) {
      applyCheat(randomLion());
      return;
    }
    applyCheat([v, v, v, v, v]);
  }

  function onSetStraight(key) {
    if (key === 0) {
      applyCheat(randomStraight());
      return;
    }
    var vals = STRAIGHTS[key];
    if (vals) applyCheat(vals.slice());
  }

  /* ================= 点骰改点 ================= */

  function onDieTap(i) {
    if (!d.tapEdit) return;
    if (S.swallowDieTap) return;
    var st = d.state;
    if (st !== 'open' && st !== 'ajar') return;
    var cur = d.dice[i];
    if (!cur || !cur.value) return;

    var now = Date.now();
    var same = S.tapDieIdx === i && now - S.tapDieAt < DOUBLE_TAP_MS;
    if (!same) {
      S.tapDieIdx = i;
      S.tapDieAt = now;
      vibrate('light');
      return;
    }

    S.tapDieIdx = -1;
    S.tapDieAt = 0;
    vibrate('light');

    // 连点两下 = 这颗点数 +1（6 之后回到 1）。
    // 全程不弹任何界面，旁边人看不出在做操作。
    var next = cur.value >= 6 ? 1 : cur.value + 1;
    var dice = d.dice.slice();
    dice[i] = { id: cur.id, value: next, pips: pipsOf(next), l: cur.l, t: cur.t, r: cur.r };
    if (S.lastValues) S.lastValues[i] = next;
    setData({ dice: dice });
  }

  function applyPanel() {
    setData({ panel: false });
  }

  /* ================= 音效开关 ================= */

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
    if (S.titleTimer) {
      clearTimeout(S.titleTimer);
      S.titleTimer = null;
    }
  }

  /* ================= 事件绑定 ================= */

  function on(target, type, fn, opts) {
    if (target) target.addEventListener(type, fn, opts || false);
  }

  function bindEvents() {
    // 标题：长按 1.2s 打开面板
    on(el.titleBtn, 'touchstart', function (e) { e.preventDefault(); onTitleStart(); }, { passive: false });
    on(el.titleBtn, 'touchend', onTitleEnd);
    on(el.titleBtn, 'touchcancel', onTitleEnd);
    on(el.titleBtn, 'mousedown', onTitleStart);
    on(document, 'mouseup', onTitleEnd);

    // 音效
    on(el.soundBtn, 'click', function () { setSound(!d.soundOn); });

    // 隐藏入口：按住骰盅下方的空白桌面 1.2s → 打开设置面板
    // 和标题长按一致，随手碰一下不会弹出来
    on(el.hotZone, 'touchstart', onHoldStart, { passive: true });
    on(el.hotZone, 'touchmove', function (e) {
      if (S.hotDragging) e.preventDefault();
      onHoldMove(e);
    }, { passive: false });
    on(el.hotZone, 'touchend', onHoldEnd);
    on(el.hotZone, 'touchcancel', onHoldEnd);
    on(el.hotZone, 'mousedown', onHoldStart);
    on(document, 'mouseup', onHoldEnd);
    // 三格隐形区：点一下就行（拖动过的不算点）
    on(el.hotZone, 'click', onHotTap);

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

    // 骰子点击（事件委托）
    on(el.diceLayer, 'click', function (e) {
      var slot = e.target.closest ? e.target.closest('.die-slot') : null;
      if (!slot) return;
      onDieTap(Number(slot.getAttribute('data-i')));
    });

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

    // 面板遮罩
    on(el.mask, 'click', function (e) {
      if (e.target === el.mask) closePanel();
    });

    // 一键豹子 / 顺子 / 逐颗点数
    on(el.lionRow, 'click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-lion]') : null;
      if (c) onSetLion(Number(c.getAttribute('data-lion')));
    });
    on(el.straightRow, 'click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-straight]') : null;
      if (c) onSetStraight(Number(c.getAttribute('data-straight')));
    });
    // 开关
    on(el.swSound, 'change', function (e) {
      if (e.target.checked === d.soundOn) return;
      setSound(e.target.checked);
    });
    on(el.swTapEdit, 'change', function (e) {
      var v = !!e.target.checked;
      saveTapEdit(v);
      setData({ tapEdit: v });
      if (v) toast('开盖后连点两下同一颗骰子，点数 +1');
    });

    on(el.panelDone, 'click', applyPanel);

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
    S.tapDieIdx = -1;
    S.tapDieAt = 0;

    initAudio();
    bindEvents();

    setData({
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      soundOn: true,
      forceOn: false,
      isLocked: false,
      tapEdit: loadTapEdit()
    });

    // 首帧把按钮和音效图标补上
    d.tapEdit = loadTapEdit();
    document.body.classList.toggle('tap-edit', !!d.tapEdit);
    el.soundIc.textContent = d.soundOn ? '🔊' : '🔇';
    el.soundBtn.classList.toggle('off', !d.soundOn);
    renderButtons();

    window.addEventListener('resize', function () {
      S.ratio = 750 / (window.innerWidth || 375);
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

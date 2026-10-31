/* 吹牛骰子 · 网页版（由小程序版 1:1 移植）
   纯本地运行：无后端、无网络请求、无登录。
   所有状态与手势逻辑与原小程序 pages/index/index.js 保持一致。 */

(function () {
  'use strict';

  /* ================= 常量 ================= */

  var OPEN_DIST = 240;       // 拖动多少 rpx 视为完全揭开
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

  function buildPanelRows(values) {
    var rows = [];
    for (var i = 0; i < values.length; i++) {
      var chips = [];
      for (var v = 1; v <= 6; v++) chips.push({ v: v, on: values[i] === v });
      rows.push({ idx: i, value: values[i], chips: chips });
    }
    return rows;
  }

  function quickState(values) {
    var same = true;
    var uniq = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== values[0]) same = false;
      if (uniq.indexOf(values[i]) < 0) uniq.push(values[i]);
    }
    var key = values.join('');
    return {
      quickLion: same ? values[0] : 0,
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
      panelRows: [],
      quickLion: 1,
      quickStraight: 0,
      quickFixed: 0,
      tapEdit: false,
      pickIdx: -1,
      pickCur: 0
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
    titleTimer: null
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
    panelRows: document.getElementById('panelRows'),
    lionRow: document.getElementById('lionRow'),
    straightRow: document.getElementById('straightRow'),
    forceState: document.getElementById('forceState'),
    fsText: document.getElementById('fsText'),
    swTapEdit: document.getElementById('swTapEdit'),
    swForce: document.getElementById('swForce'),
    swSound: document.getElementById('swSound'),
    panelDone: document.getElementById('panelDone'),
    pickCard: document.getElementById('pickCard'),
    pickTitle: document.getElementById('pickTitle'),
    pickRow: document.getElementById('pickRow'),
    pickCancel: document.getElementById('pickCancel'),
    pickCatcher: document.getElementById('pickCatcher')
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

    if (has(keys, 'dice') || has(keys, 'revealed')) {
      renderDice(has(keys, 'dice') || has(keys, 'revealed'));
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
    if (has(keys, 'pickIdx') || has(keys, 'pickCur')) {
      renderPick();
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
    // 一键豹子
    var lh = '';
    for (var i = 0; i < LION_CHIPS.length; i++) {
      lh += '<div class="qchip" data-lion="' + LION_CHIPS[i] + '">' + LION_CHIPS[i] + '</div>';
    }
    el.lionRow.innerHTML = lh;

    // 顺子
    el.straightRow.innerHTML =
      '<div class="qchip wide hot" data-straight="0">随机顺子</div>' +
      '<div class="qchip wide" data-straight="1">1 2 3 4 5</div>' +
      '<div class="qchip wide" data-straight="2">2 3 4 5 6</div>';

    // 每颗骰子的点数行
    var rows = '';
    for (var n = 0; n < d.forceValues.length; n++) {
      rows += '<div class="row"><span class="row-label">第 ' + (n + 1) + ' 颗</span><div class="chips">';
      for (var v = 1; v <= 6; v++) {
        rows += '<div class="chip" data-di="' + n + '" data-v="' + v + '">' + v + '</div>';
      }
      rows += '</div></div>';
    }
    el.panelRows.innerHTML = rows;

    el.swTapEdit.checked = !!d.tapEdit;
    el.swForce.checked = !!d.forceOn;
    el.swSound.checked = !!d.soundOn;

    syncPanel();
  }

  function syncPanel() {
    // 豹子 chips
    var lions = el.lionRow.children;
    for (var i = 0; i < lions.length; i++) {
      var lv = Number(lions[i].getAttribute('data-lion'));
      lions[i].classList.toggle('on', !!(d.forceOn && d.quickLion === lv));
    }
    // 顺子 chips
    var sts = el.straightRow.children;
    for (var j = 0; j < sts.length; j++) {
      var key = Number(sts[j].getAttribute('data-straight'));
      var on = key === 0 ? !!(d.forceOn && d.quickStraight)
        : !!(d.forceOn && d.quickFixed === key);
      sts[j].classList.toggle('on', on);
    }
    // 逐颗点数
    var chips = el.panelRows.querySelectorAll('.chip');
    for (var m = 0; m < chips.length; m++) {
      var di = Number(chips[m].getAttribute('data-di'));
      var v = Number(chips[m].getAttribute('data-v'));
      chips[m].classList.toggle('on', d.forceValues[di] === v);
    }
    // 装填状态条
    el.forceState.classList.toggle('armed', !!d.forceOn);
    el.fsText.textContent = d.forceOn
      ? '已装填 · 这次生效一次，用完自动解除'
      : '未装填 · 点下面的点数才会生效一次';
    // 开关同步
    el.swTapEdit.checked = !!d.tapEdit;
    el.swForce.checked = !!d.forceOn;
    el.swSound.checked = !!d.soundOn;
  }

  /* ---------------- 点骰改点 ---------------- */

  function renderPick() {
    var show = d.pickIdx >= 0;
    el.pickCard.style.display = show ? 'block' : 'none';
    el.pickCatcher.style.display = show ? 'block' : 'none';
    if (!show) return;
    el.pickTitle.textContent = '第 ' + (d.pickIdx + 1) + ' 颗 · 改成';
    var html = '';
    for (var v = 1; v <= 6; v++) {
      html += '<div class="dchip' + (d.pickCur === v ? ' on' : '') + '" data-v="' + v + '">' + v + '</div>';
    }
    el.pickRow.innerHTML = html;
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
      pickIdx: -1,
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
      if (forced) patch.forceOn = false; // 作弊只生效一次
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

  function onStageEnd() {
    if (!S.grabbing) return;
    S.grabbing = false;

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

    settleLid();
  }

  function settleLid() {
    var p = S.progress;
    if (p >= 0.985) {
      S.progress = 1;
      setData({
        state: 'open',
        revealed: true,
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
      pickIdx: -1,
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
      pickIdx: -1,
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

  function openPanel() {
    vibrate('light');
    setData({ panel: true, pickIdx: -1, panelRows: buildPanelRows(d.forceValues) });
  }

  function closePanel() {
    setData({ panel: false });
  }

  /* ================= 作弊 ================= */

  function commitValues(values, applyNow) {
    var q = quickState(values);
    var inRound = d.state === 'closed' || d.state === 'open' || d.state === 'ajar';
    var consumed = applyNow && inRound;

    var patch = {
      forceValues: values,
      forceOn: !consumed,
      panelRows: buildPanelRows(values),
      quickLion: q.quickLion,
      quickStraight: q.quickStraight,
      quickFixed: q.quickFixed
    };
    if (consumed) patch.dice = makeDice(values);
    setData(patch);
  }

  function applyCheat(values) {
    commitValues(values, true);
    var shown = d.state === 'closed' || d.state === 'open' || d.state === 'ajar';
    toast(shown ? '本局点数已改' : '下一局按此点数开');
  }

  function onSetLion(v) {
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
    setData({ pickIdx: i, pickCur: cur.value });
  }

  function closeDiePick() {
    setData({ pickIdx: -1 });
  }

  function pickDieValue(v) {
    var i = d.pickIdx;
    var cur = d.dice[i];
    if (i < 0 || !cur) {
      setData({ pickIdx: -1 });
      return;
    }
    var dice = d.dice.slice();
    dice[i] = { id: cur.id, value: v, pips: pipsOf(v), l: cur.l, t: cur.t, r: cur.r };
    if (S.lastValues) S.lastValues[i] = v;
    setData({ dice: dice, pickIdx: -1 });
    vibrate('light');
  }

  function applyPanel() {
    var inRound = d.state === 'closed' || d.state === 'open' || d.state === 'ajar';
    if (d.forceOn && inRound) commitValues(d.forceValues, true);
    setData({ panel: false });
    if (d.forceOn) toast('下次摇骰生效 · 仅一次');
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

    // 舞台手势
    on(el.stage, 'touchstart', onStageStart, { passive: true });
    on(el.stage, 'touchmove', onStageMove, { passive: true });
    on(el.stage, 'touchend', onStageEnd);
    on(el.stage, 'touchcancel', onStageEnd);

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
    on(el.panelRows, 'click', function (e) {
      var c = e.target.closest ? e.target.closest('.chip') : null;
      if (!c) return;
      var idx = Number(c.getAttribute('data-di'));
      var v = Number(c.getAttribute('data-v'));
      var values = d.forceValues.slice();
      values[idx] = v;
      commitValues(values, false);
    });

    // 开关
    on(el.swForce, 'change', function (e) { setData({ forceOn: e.target.checked }); });
    on(el.swSound, 'change', function (e) {
      if (e.target.checked === d.soundOn) return;
      setSound(e.target.checked);
    });
    on(el.swTapEdit, 'change', function (e) {
      var v = !!e.target.checked;
      saveTapEdit(v);
      setData({ tapEdit: v });
      if (v) toast('开盖后连点两下同一颗骰子即可改点');
    });

    on(el.panelDone, 'click', applyPanel);

    // 点骰改点浮层
    on(el.pickRow, 'click', function (e) {
      var c = e.target.closest ? e.target.closest('.dchip') : null;
      if (c) pickDieValue(Number(c.getAttribute('data-v')));
    });
    on(el.pickCancel, 'click', closeDiePick);
    on(el.pickCatcher, 'click', closeDiePick);

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
      panelRows: buildPanelRows(d.forceValues),
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

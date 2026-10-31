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
      // 开盖／合盖只切一下入场动画的 class，绝不重建节点 ——
      // 重建会打断正在进行的手势（表现为划到一半卡住）
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

  /* 只切入场动画，不动 DOM 结构 */
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

    el.swTapEdit.checked = !!d.tapEdit;
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
    // 装填状态条
    el.forceState.classList.toggle('armed', !!d.forceOn);
    el.fsText.textContent = d.forceOn
      ? '已装填 · 这次生效一次，用完自动解除'
      : '未装填 · 点下面的点数才会生效一次';
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

  /* ================= 手势（一次触摸只走一条管线） ================= */

  /* 这块反复出过问题：
       · 手指从骰盅下方那片空白起手，会被那层透明热区吃掉；
       · 浏览器把手势判成滚动后直接 touchcancel。
     两个毛病表现一样：滑一点点就卡住，松手再滑一次才顺。
     现在所有触摸统一从 document 收，走同一个状态机，
     并且从第一帧就 preventDefault —— 浏览器没机会把触摸抢走。 */

  var HOLD_MS = 1200; // 隐藏入口要按住多久才弹面板

  var G = {
    on: false,
    zone: '', // 'stage' 拖拽+轻点开合 / 'hot' 长按+拖拽 / 'free' 只拖拽
    startY: 0,
    startX: 0,
    baseP: 0,
    moved: 0,
    dragging: false,
    fingerId: null, // 只跟这第一根手指，别的手指碰上来不打断
    holdTimer: null,
    holdFired: false
  };

  // 这些地方不归我们管：按钮自己点、骰子自己双击、面板和标题各自处理
  var G_SKIP = 'button, .panel, .panel-mask, .sound-btn, .nav, .toast, .die-slot';

  function gZone(t) {
    if (!t || !t.closest) return '';
    if (t.closest(G_SKIP)) return '';
    if (t.closest('.hot-zone')) return 'hot';
    if (t.closest('.stage')) return 'stage';
    return 'free'; // 页面其余空白：也能拖，从哪儿划都能掀盖
  }

  function gClearHold() {
    if (G.holdTimer) {
      clearTimeout(G.holdTimer);
      G.holdTimer = null;
    }
  }

  /* 触摸事件里挑出「我们正在跟的那根手指」；鼠标事件自带坐标 */
  function gPoint(e) {
    if (!e.touches) return { clientX: e.clientX, clientY: e.clientY };
    var list = e.touches;
    for (var i = 0; i < list.length; i++) {
      if (list[i].identifier === G.fingerId) return list[i];
    }
    return list.length ? list[0] : null;
  }

  function gStart(e) {
    /* 一个触点 = 新手势，无条件接管。
       不能写成「已经有手势就不接管」——万一上一串触摸因为
       来电、切后台、系统手势没收到结束事件，标志位会一直挂着，
       之后所有滑动都被丢掉，表现就是「怎么滑都没反应，只有按钮能点」。
       真正的多指（第二根手指蹭上来）是 2 个以上触点，直接忽略。 */
    if (e.touches && e.touches.length > 1) return;

    if (d.panel || d.state === 'shaking') return;

    var zone = gZone(e.target);
    if (!zone) return;

    var t = gPoint(e);
    if (!t) return;

    // 这一把还没摇、但手里有上一把 → 当成「盖着」，能直接拖开看
    if (d.state === 'idle' && restoreLast()) {
      setData({ state: 'closed', hint: '上把的点数 · 点「开盖」或上滑掀开' });
    }

    G.on = true;
    G.zone = zone;
    // 诊断：logcat 里搜 [g] 就能看到每次手势的走向
    console.log('[g] start zone=' + zone + ' state=' + d.state + ' p=' + Number(S.progress).toFixed(2));
    G.fingerId = e.touches ? e.touches[0].identifier : null;
    G.startY = t.clientY;
    G.startX = t.clientX;
    G.baseP = S.progress;
    G.moved = 0;
    S.swallowDieTap = false;

    // 抢在浏览器判定「这是滚动」之前把这一串触摸锁死，
    // 否则它一旦认定是滚动就会发 touchcancel，盖子就冻在第一帧
    if (e.cancelable) e.preventDefault();

    if (zone === 'hot') {
      G.holdTimer = setTimeout(function () {
        G.holdTimer = null;
        G.holdFired = true;
        openPanel();
      }, HOLD_MS);
    }
  }

  function gMove(e) {
    if (!G.on || G.holdFired) return;
    // 每一帧都要锁：中间漏一帧，浏览器就可能接管并把触摸取消掉
    if (e.cancelable) e.preventDefault();

    var t = gPoint(e);
    if (!t) return;
    if (d.state === 'idle') { G.moved = 0; return; } // 没摇过也没上把：不响应

    var dy = G.startY - t.clientY; // 上滑为正
    var dist = Math.max(Math.abs(dy), Math.abs(t.clientX - G.startX));
    if (dist > G.moved) G.moved = dist;

    if (!G.dragging) {
      if (dist < 8) return; // 还没动开：继续当长按候选
      G.dragging = true;
      console.log('[g] drag begin dist=' + dist.toFixed(0));
      gClearHold();         // 动了就不算长按
      G.startY = t.clientY; // 从这里重新算零点，盖子不跳
      G.baseP = S.progress;
      dy = 0;
    }

    var p = clamp(G.baseP + (dy * S.ratio) / OPEN_DIST, 0, 1);
    if (p !== S.progress) {
      if (!d.revealed && p > 0.28) setData({ revealed: true });
      applyProgress(p, true);
    }
  }

  function gEnd(e) {
    if (!G.on) return;

    // 松手的不是我们跟的那根手指（比如另一根手指先抬起来）：继续等
    // 但屏幕上已经没有手指了，就必须收尾，否则标志位会挂住
    if (e && e.type === 'touchend' && e.changedTouches && G.fingerId !== null &&
        e.touches && e.touches.length > 0) {
      var mine = false;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === G.fingerId) { mine = true; break; }
      }
      if (!mine) return;
    }

    var cancelled = !!(e && e.type === 'touchcancel');
    var dragged = G.dragging && G.moved >= 8;
    console.log('[g] end type=' + ((e && e.type) || '?') + ' dragged=' + dragged +
      ' moved=' + Number(G.moved).toFixed(0) + ' p=' + Number(S.progress).toFixed(2));
    var zone = G.zone;
    var fired = G.holdFired;
    var baseP = G.baseP;

    G.on = false;
    G.dragging = false;
    G.holdFired = false;
    G.fingerId = null;
    gClearHold();

    if (fired) return; // 刚按住开了面板，收尾什么都不做

    /* 被系统打断（浏览器抢手势、来电、通知栏……）：
       这时手指其实还在往上划，只是事件被掐了。别把盖子丢在半空，
       按当前方向直接走完 —— 用户看到的就是「一划就开」，
       而不是「滑一点卡住、要再滑第二次」。 */
    if (cancelled && dragged) {
      if (S.progress >= baseP) openCup();
      else closeCup();
      return;
    }

    // 拖过松手：停在当前高度，不吸附 —— 半开着正好当挡板
    if (dragged) { settleLid(); return; }

    if (cancelled) return; // 没拖动就被取消：当成没发生，别顺手开合

    // 轻点：只有骰盅本体／桌面空白切换开合，热区轻点保持静默
    if (zone !== 'stage') return;
    if (d.state === 'idle') { toast('先摇一摇'); return; }
    if (d.tapEdit && (d.state === 'open' || d.state === 'ajar')) return;
    S.swallowDieTap = true;
    if (d.state === 'ajar') openCup();
    else if (S.progress > 0.5) closeCup();
    else openCup();
  }

  function settleLid() {
    var p = S.progress;
    /* 过了半程就直接吸附到全开。
       以前要拖到 98.5% 才算开，松手稍微差一点就停在「半开」，
       用户的感觉就是「第一次只能开一点，得再滑一次」。
       半开（当挡板）留给主动拖到一小半就松手的情况。 */
    if (p >= 0.5) {
      S.progress = 1;
      setData({
        state: 'open',
        revealed: true,
        lidStyle: lidStyle(1, false),
        hint: '看清点数 · 锁定即结束本局'
      });
    } else if (p <= 0.05) {
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

  function openPanel() {
    vibrate('light');
    setData({ panel: true });
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

    // 连点两下 = 这颗点数 +1（6 之后回到 1）。
    // 全程不弹任何界面，旁边人看不出在做操作。
    var next = cur.value >= 6 ? 1 : cur.value + 1;
    var dice = d.dice.slice();
    dice[i] = { id: cur.id, value: next, pips: pipsOf(next), l: cur.l, t: cur.t, r: cur.r };
    if (S.lastValues) S.lastValues[i] = next;
    setData({ dice: dice });
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

    // 手势：全部从 document 收（骰盅本体、骰盅下方空白、页面其余空白都算）
    // passive 必须是 false —— passive 的监听里 preventDefault 会被忽略，
    // 浏览器就会先把触摸判成滚动再 touchcancel，表现是「滑一点就卡住」
    on(document, 'touchstart', gStart, { passive: false });
    on(document, 'touchmove', gMove, { passive: false });
    on(document, 'touchend', gEnd);
    on(document, 'touchcancel', gEnd);
    // 桌面浏览器：鼠标也能拖（手机不会走到这里，触摸已在 touchstart 里 preventDefault）
    on(document, 'mousedown', function (e) { if (e.button === 0) gStart(e); });
    on(document, 'mousemove', function (e) { if (e.buttons === 1) gMove(e); });
    on(document, 'mouseup', gEnd);
    // 长按弹系统菜单也会把触摸掐掉（contextmenu → touchcancel），一律禁掉
    on(document, 'contextmenu', function (e) { e.preventDefault(); });
    // 切后台、来电、系统手势抢走焦点：收尾一次，别让手势标志位挂着
    on(document, 'visibilitychange', function () { if (document.hidden) gEnd(); });
    on(window, 'blur', function () { gEnd(); });

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

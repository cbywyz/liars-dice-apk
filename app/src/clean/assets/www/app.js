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

  var SLOTS = [
    { l: 134, t: 52, r: -9 },
    { l: 250, t: 44, r: 6 },
    { l: 366, t: 54, r: -4 },
    { l: 188, t: 158, r: 8 },
    { l: 312, t: 164, r: -7 }
  ];

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
      var values = SLOTS.map(function () { return rollOne(); });
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

    initAudio();
    bindEvents();

    setData({
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      soundOn: true,
      isLocked: false
    });

    // 首帧把按钮和音效图标补上
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

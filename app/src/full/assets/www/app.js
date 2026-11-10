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
    /* 顺子跟着骰子数量走：
       5 颗只有 12345 / 23456 两种；6 颗只有 123456 一种；
       其他数量根本不存在顺子 —— 退回「从 1 开始连续排」，别生成半截假顺子。 */
    var n = d.diceCount;
    var pool;
    if (n === 6) {
      pool = [1, 2, 3, 4, 5, 6];
    } else if (n === 5) {
      /* 以前是从 1~6 里随机删一个数 —— 删到 2/3/4/5 得到的是
         13456、12456 这种「断一截」的牌，根本不是顺子。
         这里先选好是哪一种，再打乱顺序。 */
      pool = Math.random() < 0.5 ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 6];
    } else {
      pool = [];
      for (var m = 0; m < n; m++) pool.push((m % 6) + 1);
    }
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool;
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

  var STORE_KEY = 'ld_tap_edit';
  var memTapEdit = false;

  /* 骰盅下方那三格的总闸，默认关。
     平时它就是一块普通桌面（怎么点都不会误触发），
     要用时在点数设置里打开，直到再关掉为止。 */
  var HOTZONE_KEY = 'ld_hotzone_on';
  var memHotZone = false;

  function loadHotZone() {
    try {
      return localStorage.getItem(HOTZONE_KEY) === '1';
    } catch (e) {
      return memHotZone;
    }
  }
  function saveHotZone(on) {
    try {
      localStorage.setItem(HOTZONE_KEY, on ? '1' : '0');
    } catch (e) {
      memHotZone = !!on;
    }
  }

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
      diceCount: 5,
      diceFace: '',            // 'lion' | 'straight' | ''，摇完自动识别用
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
      hotZoneOn: false,
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
    countBtn: document.getElementById('countBtn'),
    countTxt: document.getElementById('countTxt'),
    countDrop: document.getElementById('countDrop'),
    countShade: document.getElementById('countShade'),
    titleBtn: document.getElementById('titleBtn'),
    mask: document.getElementById('mask'),
    sheet: document.getElementById('sheet'),
    lionRow: document.getElementById('lionRow'),
    straightRow: document.getElementById('straightRow'),
    forceState: document.getElementById('forceState'),
    fsText: document.getElementById('fsText'),
    swHotZone: document.getElementById('swHotZone'),
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
        has(keys, 'quickLion') || has(keys, 'quickStraight') || has(keys, 'quickFixed') ||
        has(keys, 'hotZoneOn') || has(keys, 'tapEdit')) {
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

    // 顺子：5 颗是 12345 / 23456 两种，6 颗只有 123456，其他数量不存在顺子
    var sn = d.diceCount;
    var noStraight = sn !== 5 && sn !== 6;
    el.straightRow.innerHTML =
      '<div class="qchip wide hot' + (noStraight ? ' off' : '') + '" data-straight="0">随机顺子</div>' +
      '<div class="qchip wide' + (sn !== 5 ? ' off' : '') + '" data-straight="1">1 2 3 4 5</div>' +
      '<div class="qchip wide' + (sn !== 5 ? ' off' : '') + '" data-straight="2">2 3 4 5 6</div>';

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
    if (el.swHotZone) el.swHotZone.checked = !!d.hotZoneOn;
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
    if (d.panel || d.shaking) return;
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
      forceOn: false,
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
        : slotsOf(d.diceCount).map(function () { return rollOne(); });
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
        forceOn: false,   // 开盖了：本局作弊到此为止，下次摇骰恢复真随机
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
        /* 半开也能看清点数了 —— 和全开一样算「已经开过盖」，
           装填必须在这里解除。否则「半开看一眼 → 合上 → 再摇」
           会还是同一副牌，看起来像卡住了。 */
        forceOn: false,
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
      forceOn: false,   // 揭开了：装填解除
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
      /* 开新一局：上一局装填的东西一律作废。
         不然「装填 → 摇 → 一轮结束 → 再来一局 → 摇」会还是同一副牌。 */
      forceOn: false,
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      hasLast: !!S.lastValues,
      hint: S.lastValues ? '点「开盖」看上把，或摇一摇重开' : '点「摇一摇」开始这一局'
    });
  }

  /* ================= 隐藏入口：长按标题 1.2s =================

     两道门：先在「免责声明」里连点标题 7 下把总开关打开（见文件前面的 LDDEV 那段），
     这里的长按才会起作用。开关关着的时候，按多久都什么都不发生 ——
     不震、不弹，连计时器都不起，跟一块普通标题没有区别。 */

  function onTitleStart() {
    if (!window.LDDev || !window.LDDev.on()) return;
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

  /* 三格总闸：开/关只在点数设置里做，同样不弹文字 */
  function setHotZone(on) {
    saveHotZone(on);
    setData({ hotZoneOn: !!on });
    try {
      if (navigator.vibrate) navigator.vibrate(on ? [14, 75, 14] : 45);
    } catch (err) {}
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
    if (!d.hotZoneOn) return;      // 总闸关着 —— 这块就是普通桌面
    /* 隐藏开关关了，三格也跟着哑。hotZoneOn 是单独存的，
       只判它的话「关掉总开关」会留下一条还在生效的暗路。 */
    if (!window.LDDev || !window.LDDev.on()) return;
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
    /* 用到了就续一次期：开关是按「最后一次用」算 30 天的 */
    if (window.LDDev) window.LDDev.keep();
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
     至少保留一个真正的点数，否则就成了「全 1」而不是这个点数的豹子。
     骰子数量改了就以当前数量为准，凑出来的仍是合法的 N 颗豹子。 */
  function randomLion() {
    var n = d.diceCount;
    // 点数取 2~6：1 只能组成「1111…」，那是全豹，不是万能
    var v = 2 + Math.floor(Math.random() * 5);
    // 真点数个数取 1~4 —— 至少留一个 1 才算「万能」。数量少时不能超过 n
    var r = Math.random();
    var k = Math.min(r < 0.15 ? 1 : r < 0.45 ? 2 : r < 0.75 ? 3 : 4, Math.max(1, n - 1));
    var out = [];
    var i;
    for (i = 0; i < k; i++) out.push(v);
    while (out.length < n) out.push(1);
    // 打散顺序，别让 1 全堆在后面
    for (i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /* v = 0 → 随机豹子；1~6 → 固定豹子（N 个一样的数字，不带万能 1） */
  function onSetLion(v) {
    if (!v) {
      applyCheat(randomLion());
      return;
    }
    var out = [];
    for (var i = 0; i < d.diceCount; i++) out.push(v);
    applyCheat(out);
  }

  function onSetStraight(key) {
    if (key === 0) {
      applyCheat(randomStraight());
      return;
    }
    var vals = STRAIGHTS[key];
    // 固定顺子只有 5 颗时成立，数量不对就别装填，免得摇出对不上的牌
    if (vals && vals.length === d.diceCount) applyCheat(vals.slice());
  }

  /* ================= 点骰改点 ================= */

  function onDieTap(i) {
    if (!d.tapEdit) return;
    /* 同上：总开关关着，点骰改点也一起失效 */
    if (!window.LDDev || !window.LDDev.on()) return;
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
      if (!c) return;
      // 灰掉的那几个（数量对不上）点了没用
      if (c.classList.contains('off')) {
        toast('当前 ' + d.diceCount + ' 颗，凑不出这个顺子');
        return;
      }
      onSetStraight(Number(c.getAttribute('data-straight')));
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

    if (el.swHotZone) {
      on(el.swHotZone, 'change', function (e) {
        setHotZone(!!e.target.checked);
      });
    }

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
    d.diceCount = loadDiceCount();

    initAudio();
    bindEvents();

    setData({
      dice: emptyDice(),
      lidStyle: lidStyle(0, false),
      soundOn: true,
      forceOn: false,
      isLocked: false,
      tapEdit: loadTapEdit(),
      hotZoneOn: loadHotZone(),
      diceCount: d.diceCount
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
   直接给一条入口。

   点这一条会发生什么：
     · 浏览器已经把系统安装框交过来了（安卓 Chrome / Edge 的 beforeinstallprompt）——
       **直接弹系统框**，点「安装」图标就上桌面，中间不加任何一页。
     · 没有这个事件（iOS、微信内置浏览器、Firefox、或 Chrome 还没触发）——
       才打开说明页，按机型给步骤。iOS 和安卓的路径完全不一样，混着讲没人看得懂。
     · 弹了但用户点「取消」—— 再把说明页打开，告诉人还能手动加，别让人以为没点上。

   什么时候整条都不出现：
     · 已经是从桌面图标打开的（standalone / fullscreen）—— 已经在桌面上了，别啰嗦
     · 用户点过「不用了，以后别再提醒」—— 存在 localStorage，下次不再问 */

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
  /* 手机自带的国产浏览器（华为 / 小米 / OPPO / vivo / 夸克 / UC / QQ）：
     「添加到桌面」一直在菜单里，但它**没有实现 beforeinstallprompt**，装不出 WebAPK ——
     加出来的是**书签快捷方式**：图标一样、点开还是浏览器里的一页，带着地址栏。
     所以对这一类不能写「点一下直接装」，得把菜单名字说准、把「会带地址栏」讲明白。 */
  var oem = /HuaweiBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|Quark|UCBrowser|MQQBrowser/i.test(UA);

  var mask = document.getElementById('a2hsMask');
  var body = document.getElementById('a2hsBody');
  var defer = null;        // 浏览器交给我们的安装事件，只能 prompt 一次
  var cancelled = false;   // 用户点了系统框的「取消」，说明页要提一句
  var noPrompt = false;    // 浏览器发了事件但 prompt() 没反应（华为浏览器就是这样）

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
    /* 自带浏览器加出来的图标带着地址栏，就别再写「全屏没地址栏」了 —— 说了做不到更糟 */
    var lead = (isAndroid && oem)
      ? '加完桌面点开就能玩，图标也在桌面；只是手机自带浏览器加出来的是<strong>桌面快捷方式</strong>，' +
        '打开时上面会带一条地址栏。'
      : '从桌面点开是全屏的，没有地址栏，跟装的 App 一样；' +
        '联网打开过一次之后，<strong>断网也能摇</strong>。';

    var h = '<div class="a2hs-prev">' +
      '<img src="apple-touch-icon.png" alt="">' +
      '<div class="a2hs-prev-tx"><strong>骰子</strong><span>加完桌面就多这个图标</span></div>' +
      '</div>' +
      '<div class="rule-lead">' + lead + '</div>';

    /* 系统框弹过又被取消：先说清楚不是没点上，再给手动路子 */
    if (cancelled) {
      h += '<div class="rule-note">刚才那个安装框点了「取消」。想走系统安装就' +
        '<strong>刷新一下本页再点上面那条</strong>（浏览器一个页面只让弹一次）；' +
        '不想刷新就照下面的步骤手动加，加完效果一样。</div>';
    } else if (noPrompt && !oem) {
      h += '<div class="rule-note">这个浏览器<strong>没有真的弹出安装框</strong>（它支持一半：' +
        '会发安装事件，但不给你那个系统框）。照下面的步骤手动加，一样能上桌面。</div>';
    }

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
         **压根不需要「桌面快捷方式」权限**。能拿到 beforeinstallprompt 的浏览器，
         点首页那条就直接弹系统框了，不会走到这一页；走到这里说明只能手动加。 */
      if (oem) {
        h += '<div class="rule-note">手机自带浏览器<strong>不会弹系统安装框</strong> —— ' +
          '点了像没反应就是这个原因，不是没点上。照下面手动加就行；' +
          '想要全屏无地址栏，用 <strong>Edge 或 Chrome</strong> 打开同一地址，菜单里选「安装应用」。</div>';
        h += steps('安卓 · 手机自带浏览器', [
          '点浏览器底部「<strong>≡</strong>」或右上角「<strong>⋮</strong>」把菜单拉出来',
          '找「<strong>添加到桌面 / 添加到主屏幕</strong>」' +
            '（有的在「工具箱」「书签」里，名字不一定一样）',
          '确认「添加」，桌面上就多一个骰子图标'
        ], '华为 / 荣耀写「添加到桌面」，小米 / OPPO / vivo 可能写「添加到主屏幕」，位置都在菜单里。');
      } else {
        h += steps('安卓', [
          '用任意浏览器打开本页（自带浏览器、Chrome、Edge 都行）',
          '点右上角「<strong>⋮</strong>」，或底部「<strong>≡</strong>」菜单',
          '优先选「<strong>安装应用</strong>」（有的写「安装」）—— 走这条不用额外权限；' +
            '没有这一项再选「<strong>添加到主屏幕 / 添加到桌面</strong>」',
          '确认「安装」/「添加」'
        ]);
      }
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

    /* 这一页里已经没有「调起系统」的按钮了 —— 能调起的那种情况在首页那一条上
       就被直接弹掉了（见下面的 promptNow），走到这一页只可能是加不了自动安装的浏览器。 */
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

  /* 真正「调起系统安装框」的那一下：把浏览器交过来的事件 prompt 出去，
     用户看到的就是系统的「安装应用」框，点「安装」图标自己上桌面。
     接受 → 收摊、记一下；取消 → 打开说明页兜底（同一个事件只能用一次，
     所以说明页里写的是「刷新再点」而不是「再点一次」）。

     fallbackMs：等多久还没有任何反应就当「弹不出来」，直接开说明页。
     为什么需要它：有的浏览器（**实测华为浏览器**）会照发 beforeinstallprompt，
     但 prompt() 打出去什么都不弹、userChoice 也永远不 resolve —— 页面上就是
     「点一下完全没反应」，比不给弹框还糟。手机自带浏览器统一挂这个兜底。 */
  function promptNow(fallbackMs) {
    var d = defer;
    defer = null;
    if (typeof d.prompt !== 'function') {
      open();
      return;
    }
    var settled = false;
    var timer = 0;
    try {
      d.prompt();
    } catch (e) {
      open();
      return;
    }
    if (fallbackMs) {
      timer = setTimeout(function () {
        if (settled) return;
        /* 系统框真弹出来的话，用户迟早会点一下，userChoice 一定会 settle；
           这么久没动静，就是这家浏览器没实现 —— 别让人对着没反应的按钮点第二下。 */
        noPrompt = true;
        open();
      }, fallbackMs);
    }
    if (d.userChoice && d.userChoice.then) {
      d.userChoice.then(function (r) {
        settled = true;
        if (timer) clearTimeout(timer);
        if (noPrompt) return;          // 已经按「弹不出来」处理过了，别再改口成「点了取消」
        if (r && r.outcome === 'accepted') {
          mark();
          bar.hidden = true;
          close();
          return;
        }
        cancelled = true;
        open();
      }, function () {
        settled = true;
        if (timer) clearTimeout(timer);
        if (noPrompt) return;
        cancelled = true;
        open();
      });
    }
  }

  /* 点首页那一条：能直接装就直接弹系统框（一步到位），不能装才给说明页。
     手机自带浏览器额外挂 0.7 秒兜底 —— 它们经常「有事件、没反应」。 */
  bar.addEventListener('click', function () {
    if (defer) {
      promptNow(oem ? 700 : 0);
      return;
    }
    open();
  });

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    defer = e;
    bar.hidden = false;
    var t2 = bar.querySelector('.a2hs-t2');
    if (t2) t2.textContent = oem ? '点一下试试 · 弹不出来会给步骤'
                                 : '点一下直接装 · 系统会问一次「安装」';
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

  /* 自带浏览器加出来的是带地址栏的快捷方式，副标题别写「全屏没地址栏」——
     说得到做不到，比不说更让人失望。 */
  if (isAndroid && oem) {
    var t2o = bar.querySelector('.a2hs-t2');
    if (t2o) t2o.textContent = '点一下试试 · 弹不出来会给步骤';
  }

  bar.hidden = false;
})();

/* LDDEV_BEGIN */
/* ================= 隐藏开关（所有玩法的暗门都由它统一调度） =================

   为什么要有这一层：
   作弊项本来是「长按标题 1.2 秒」直接弹出来的。手机往桌上一放，谁来都能按两下，
   看见了就学会了 —— 这东西藏是藏不住的，只能让它别在别人手里顺手撞见。

   为什么不用密码：这是纯前端，密码就写在 js 里，看源码就知道了。
   密码挡得住手滑，挡不住「学了去」；而且输密码这个动作最招眼 ——
   手指一格一格按，旁边人瞄一眼反而记住了。

   现在的规矩：
     · 默认关着。关着的时候长按标题多久都**什么都不发生**：不震、不弹、连计时都不起。
     · 开的地方在「免责声明」那一层 —— 连点那行标题 7 下。
       选它因为条款页是全家最没人看的一页，标题又是那页上最没人会碰的一行。
     · 再连点 7 下 = 关掉。散场前顺手关一下，手机借人也放心。
     · 开着管 30 天，每次真用到就续一次期 —— 自己天天用就一直有效；
       手机借出去放一个月没人碰，后门自己失效。

   给以后的玩法（350、联机那些）：要做暗门，入口第一句先判
       if (!window.LDDev || !window.LDDev.on()) return;
   真用到隐藏功能的时候再叫一句 window.LDDev.keep()。
   开关只有这一个，别每个玩法各存一份 —— 不然关了这头忘那头，等于没关。

   这里只管状态和「连点 N 下」这个动作，落点在文件末尾那层免责声明里。 */

(function () {
  'use strict';

  var KEY = 'ld_dev_on';
  var TAPS = 7;         // 连点几下
  var GAP = 900;        // 两下之间超过这么久，就当重新开始数
  var KEEP = 30;        // 开着管多少天

  var mem = 0;          // localStorage 不可用时的兜底（无痕模式、旧 WebView）

  function raw() {
    try {
      return Number(localStorage.getItem(KEY) || 0) || 0;
    } catch (e) {
      return mem;
    }
  }

  function set(t) {
    mem = t;
    try {
      if (t) localStorage.setItem(KEY, String(t));
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }

  function on() {
    var t = raw();
    return t > 0 && Date.now() - t < KEEP * 86400000;
  }

  /* 真用到隐藏功能时叫一下：有效期从「最后一次用」重新算 */
  function keep() {
    if (on()) set(Date.now());
  }

  function buzz(p) {
    try {
      if (navigator.vibrate) navigator.vibrate(p);
    } catch (e) {}
  }

  var n = 0;
  var at = 0;

  /* 元素上的「连点 N 下」。凑满了就在开/关之间切一次。
     全程一个字都不弹：开、关只靠震动节奏区分 —— 开是两下短的，关是一下长的。
     元素上闪一下颜色，600ms 退回，别人抬头时已经没了。 */
  function tap(e) {
    var now = Date.now();
    if (now - at > GAP) n = 0;
    n += 1;
    at = now;
    if (n < TAPS) return;
    n = 0;

    var was = on();
    set(was ? 0 : Date.now());
    buzz(was ? 120 : [18, 90, 18]);

    var elx = e && e.currentTarget;
    if (elx && elx.classList) {
      var cls = was ? 'is-dev-off' : 'is-dev-on';
      elx.classList.add(cls);
      setTimeout(function () { elx.classList.remove(cls); }, 700);
    }
  }

  window.LDDev = {
    on: on,
    keep: keep,
    tap: tap,
    off: function () { set(0); }
  };

  /* 落点：首页页脚那行「v1.10.24 · 仅供朋友聚会娱乐」。
     选它的理由：字小、灰色、贴在屏幕最底下，是全家最没存在感的一行，
     谁也不会去点它；而它又一直在首页，不用翻页就能摸到。
     连点 7 下开，再连点 7 下关 —— 同一个动作，不用记第二个手势。 */
  var host = document.getElementById('homeVer');
  if (host) host.addEventListener('click', tap);
})();
/* LDDEV_END */

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

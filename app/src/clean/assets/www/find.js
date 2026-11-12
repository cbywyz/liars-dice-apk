/* 找朋友 —— 潮汕酒桌上的「明骰点名」，第三个玩法，独立一页。

   规则（用户 2026-11-10 口述，已逐条确认）：
     · N 个人围一圈（2~12），每人 2 颗，全部明着摊开，没有盖子
     · 中间 2 颗是「公骰」，由当前这一家摇
     · 轮到谁：先把**所有人的 2 颗重摇一遍**，再由他摇公骰
     · 摇出来的公骰一旦对上某个人 → 那个人喝，这一家**继续摇**
     · 一直摇到「谁都没对上」为止，才轮到下一家；从 1 号到 N 号算一轮
     · 对上分三档，按最高那一档喝：
         ①一模一样（中间 3+4，他 3+4 / 4+3）→ 双倍 2 杯
         ②只是和值相同（中间 3+4=7，他 2+5 / 1+6 也是 7）→ 1 杯
         ③两边都是豹子（中间 55，他 22 / 66，不看点数）→ 1 杯
     · 11 也算豹子（2 点）
     · 摇公骰的人自己也算，公骰点到自己一样喝（用户 2026-11-10 特别强调）
     · 只有「11 正豹」多一项附加：庄家可以再点一个人，罚 1 杯（用户 2026-11-10 追加，
       原话「有公骰摇出来 11 正豹 只有 11 附加可以指定一个玩家喝」）。
       这一杯跟命中无关，是额外的；命中照旧记，「一模一样的双倍」也照旧。

   判定放最上面、只碰纯数据：_real/test_find.js 会把这一段切出来单独跑，
   不复制逻辑 —— 复制一份就等于另写一个实现，改错了照样 PASS。

   这个文件不依赖 app.js，两版（完整版 / 纯净版）都带。 */

(function () {
  'use strict';

  /* ================= 判定（纯函数） ================= */

  /* 人数跟联机版一个口径（2~12，2026-11-10 从 4 人起放开）。
     两个人也玩：一个摇公骰一个喝，只是没那种满桌起哄的热闹。 */
  var MIN_P = 2;
  var MAX_P = 12;

  /* 每一把（= 一个庄家的整个回合）每人最多摇几次自己的 2 颗。
     2026-11-10 用户定成 **1 次**：一开局全桌就自动换一手，之后不能再补摇。
     理由还是那一条 —— 「摇多次就能挑好牌，6-9 最危险」，一次定生死最干净。
     全页只有这一处控制次数，别再散字面量。 */
  var SHAKES_PER_TURN = 1;

  function dsum(v) { return v[0] + v[1]; }
  function isLion(v) { return v[0] === v[1]; }

  /* 两颗是不是「一模一样」的一副（不分先后）：3+4 和 4+3 是同一副。
     用户 2026-11-10：一模一样要喝双倍，只是和值相同算正常喝。 */
  function samePair(a, b) {
    return (a[0] === b[0] && a[1] === b[1]) ||
           (a[0] === b[1] && a[1] === b[0]);
  }

  /* 一次命中喝几杯：一模一样双倍，其余一倍 */
  function cupsOf(why) { return why === 'exact' ? 2 : 1; }

  /* 公骰 c 对上座位 s 没有。对上返回命中类型，否则 ''：
       'exact' 一模一样（34 对 34 / 43）→ 双倍
       'sum'   只是和值相同（34 对 25 / 16，都是 7 点）→ 一杯
       'lion'  豹子碰豹子（中间 55，手里 22 / 66）→ 一杯，不看点数
     exact 放最前：它本来就满足和值，必须按双倍算，不能被 sum 抢先。 */
  function hitOf(c, s) {
    if (samePair(c, s)) return 'exact';
    if (dsum(c) === dsum(s)) return 'sum';
    if (isLion(c) && isLion(s)) return 'lion';
    return '';
  }

  /* 这一把公骰点到了谁：返回 [{ i, why }, …] */
  function hitList(center, seats) {
    var out = [];
    for (var i = 0; i < seats.length; i++) {
      var why = hitOf(center, seats[i].dice);
      if (why) out.push({ i: i, why: why });
    }
    return out;
  }

  /* 公骰摇出「11 正豹」才有的一项附加：庄家可以再点一个人罚 1 杯。
     用户 2026-11-10 追加：「有公骰摇出来 11 正豹 只有 11 附加可以指定一个玩家喝」——
     只认 11，别的豹子（22 33 44 55 66）都没有这项，别顺手推广。
     这一杯是额外的、固定 1 杯：他就算同时被命中，也照样再加这一杯。 */
  function isEleven(v) { return !!v && v[0] === 1 && v[1] === 1; }

  /* ================= 判定结束 ================= */

  var KEY = 'ld_find';
  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var RED = { 1: true, 4: true };

  var $ = function (id) { return document.getElementById(id); };

  var el = {};
  var seatEls = [];
  var redoAt = 0;          // 「重开」两下确认：第一次点只记时间
  /* 公骰正在滚的那个动画句柄（null = 没在滚）。
     它一真，paint() 就不许重画公骰 —— 否则任何一次重绘都会把滚动的画面
     打回静态结果，等于动画白做（跟吹牛那边 dieIn 被重播是同一类坑）。 */
  var coreAnim = null;
  var G = {
    n: 0,
    seats: [],        // [{ dice: [a,b], cups: 0, used: 0 }]  used = 这一把摇了几次
    shaker: 0,        // 当前这一家（0 起）
    round: 1,
    center: null,     // 公骰 [a,b]，还没摇过是 null
    phase: 'ready',   // ready 各家摇自己的 | pick 11 正豹等点人 | hit 刚点到人 | pass 没人对上，等接手
    hits: [],         // 上一把点到的人
    picked: -1,       // 「11 正豹」附加指的那一位：-1 还没点，-2 主动放弃
    afterPick: 'pass',// 点完/放弃之后该接哪个阶段（有命中 → hit，没命中 → pass）
    flash: ''         // 一句临时提示（摇满了 / 还没摇完），1.6 秒后自己消失
  };

  /* ---------------- 小工具 ---------------- */

  function rollOne() { return 1 + Math.floor(Math.random() * 6); }

  function buzz(pat) {
    try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {}
  }

  /* ================= 音效 =================
     全站只有一颗 shake.mp3（吹牛、350 都用这一颗，250 行左右那份）。
     这个玩法从做出来就没接过音频，2026-11-10 用户报「摇骰子没有声音」。

     有一件事必须做在真正出声之前：iOS / 微信里第一次 play() 得落在用户手势里，
     否则后面任何一次播放都会被静默拦掉，表现就是「安卓有声音、iPhone 没有」。
     所以第一次碰屏幕先哑播一下解锁。 */
  var shk = null;

  function ensureShk() {
    if (shk) return shk;
    try {
      shk = new Audio('assets/audio/shake.mp3');
      shk.preload = 'auto';
      /* 加载失败就置空，下次重新来一颗 —— 网络抖一下不该永久变哑 */
      shk.addEventListener('error', function () { shk = null; });
    } catch (e) { shk = null; }
    return shk;
  }

  function unlockShk() {
    var a = ensureShk();
    if (!a) return;
    try {
      a.muted = true;              /* 解锁这一下不能真出声，否则一进页面就嗷一声 */
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

  /* 换人 / 11 正豹 / 有人喝 这几下用全站共用的合成音（snd.js）。
     摇骰的沙沙声合成不出来，所以还是那颗 mp3 —— 两者各管一段，不冲突。
     取不到 LDSnd 就静默：老缓存里只有旧文件时不该因此报错。 */
  function cue(name) {
    if (window.LDSnd) window.LDSnd.cue(name);
  }

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

  /* 只在点数变了的时候重画：每帧重建 innerHTML 会把 pop 动画不停重置 */
  function paintDice(box, vals, size, pop) {
    var key = vals.join('');
    if (box.getAttribute('data-k') === key) return;
    box.setAttribute('data-k', key);
    var h = '';
    for (var i = 0; i < vals.length; i++) h += dieHtml(vals[i], size);
    box.innerHTML = h;
    if (pop) {
      var ds = box.children;
      for (var j = 0; j < ds.length; j++) ds[j].classList.add('pop');
    }
  }

  function nameOf(i) { return (i + 1) + ' 号'; }

  /* 这一把摇过没有：两颗都 0 就是还没摇（wait 状态），不是「摇出 0 点」 */
  function settled(st) { return !!(st && st.dice && (st.dice[0] || st.dice[1])); }

  /* 还有几家没摇 —— 「换成新庄家之后各家自己摇」那道闸门就靠它 */
  function unrolled() {
    var k = 0;
    for (var i = 0; i < G.n; i++) if (!settled(G.seats[i])) k++;
    return k;
  }

  /* 一句临时提示，1.6 秒自己消失。用来回答「为什么点了没反应」 */
  var flashTimer = 0;
  function flash(msg) {
    G.flash = msg;
    paint(false);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      G.flash = '';
      paint(false);
    }, 1600);
  }

  /* ---------------- 建桌 ---------------- */

  function buildSeats() {
    el.seats.innerHTML = '';
    seatEls = [];

    for (var i = 0; i < G.n; i++) {
      var s = document.createElement('div');
      s.className = 'fd-seat';
      s.setAttribute('data-i', String(i));

      /* 1 号摆在左上、顺时针排，最后一个正好落在正上方 ——
         跟桌上真人围一圈的次序一致，也是用户配图里的排法。 */
      var th = 270 - 360 / G.n + i * (360 / G.n);
      var rad = th * Math.PI / 180;
      var R = 0.78;
      s.style.left = (50 + 50 * R * Math.cos(rad)).toFixed(2) + '%';
      s.style.top = (50 + 50 * R * Math.sin(rad)).toFixed(2) + '%';
      if (dense()) s.style.width = '16.2vw';

      s.innerHTML =
        '<span class="fd-n">' + nameOf(i) + '</span>' +
        '<span class="fd-dice" data-k=""></span>' +
        '<span class="fd-cups"></span>' +
        '<span class="fd-tag">指名</span>';

      el.seats.appendChild(s);
      seatEls.push({
        root: s,
        box: s.querySelector('.fd-dice'),
        cups: s.querySelector('.fd-cups')
      });
    }
  }

  /* ---------------- 渲染 ---------------- */

  function paint(pop) {
    var size = dense() ? '5.1vw' : '6vw';

    el.who.textContent = nameOf(G.shaker) + '摇';
    el.round.textContent = '第 ' + G.round + ' 轮';

    /* 等点人时整圈座位一起呼吸（find.css 里的 .fd-ring.pick），点哪算哪 */
    if (el.seats.parentNode) {
      el.seats.parentNode.classList.toggle('pick', G.phase === 'pick');
    }

    for (var i = 0; i < G.n; i++) {
      var st = G.seats[i], se = seatEls[i];
      var hit = false;
      for (var k = 0; k < G.hits.length; k++) if (G.hits[k].i === i) hit = true;

      /* 快换人的时候把下一位圈出来（单机是「手机该递给谁」） */
      var isNext = G.phase === 'pass' && i === (G.shaker + 1) % G.n;
      se.root.classList.toggle('now', i === G.shaker);
      se.root.classList.toggle('next', isNext);
      var tg = se.root.querySelector('.fd-tag');
      if (tg) tg.textContent = isNext ? '接手' : '指名';
      se.root.classList.toggle('hit', hit);
      se.root.classList.toggle('sel', i === G.picked);
      /* 还没摇的座位挂个虚线金边：一眼看出「这个该摇」，不用挨个问 */
      se.root.classList.toggle('todo', G.phase === 'ready' && !settled(st));
      se.cups.textContent = st.cups ? st.cups + ' 杯' : '';
      se.cups.classList.toggle('has', st.cups > 0);
      paintDice(se.box, st.dice, size, pop);
    }

    if (coreAnim) {
      /* 还在滚：这两颗归动画管，这里只留个「正在摇」的说法 */
      el.core.classList.remove('idle');
      el.coreTag.textContent = '摇骰中…';
    } else {
      var ckey = G.center ? G.center.join('') : '--';
      /* 点数没变就别重写 innerHTML：落地那一下的弹跳挂在 .fd-d 上，
         重写一次 DOM 会把动画掐掉（用户看不到「落定」那一顿） */
      if (el.coreDice.getAttribute('data-k') !== ckey) {
        el.coreDice.setAttribute('data-k', ckey);
        el.coreDice.innerHTML = dieHtml(G.center ? G.center[0] : 0, '9.8667vw') +
                                dieHtml(G.center ? G.center[1] : 0, '9.8667vw');
      }
      el.core.classList.toggle('idle', !G.center);
      el.coreTag.textContent = G.center ? (dsum(G.center) + ' 点') : '公骰';
    }

    paintHint();
    paintBtns();
  }

  /* 结果那一行：主行只说结果，明细降到第二行小字。
     12 人桌上一次能点到五六个人，名字塞进一行会把「11 正豹 →」挤成两截
     （2026-11-10 截图看出来的）；而且 .fd-hint 以前是 flex，纯空格的文本节点会被
     当成匿名 flex item 丢掉，所以「喝」和「另指」之间连空格都没了。改成 block。 */
  function whyOf(k) {
    var seat = G.seats[k.i];
    var why = k.why === 'exact' ? '一模一样 · 双倍'
            : k.why === 'lion' ? '豹子' : dsum(seat.dice) + ' 点';
    /* 摇公骰的人被自己点中：界面必须写出来。
       用户 2026-11-10 特意说过「自己摇的时候跟自己点数对上，自己也得喝」，
       不写清楚桌上就会有人说「庄家不算」 */
    if (k.i === G.shaker) why += ' · 自己';
    return why;
  }

  /* 11 正豹那一杯的落点：点完写名字，主动放弃也要写清楚，别让人以为忘了 */
  function pickNote() {
    if (G.picked === -2) return '11 正豹 · 这一杯没指人';
    if (G.picked >= 0) return '11 正豹 · 另指 ' + nameOf(G.picked) + ' 1 杯';
    return '';
  }

  function paintHint() {
    var line = '', sub = '';

    if (G.phase === 'ready') {
      line = '轮到 <b>' + nameOf(G.shaker) + '</b> · 摇公骰';
      var left = unrolled();
      /* 只能摇一次之后，「想换点就再摇几次」这句就不成立了 —— 改成一句状态说明，
         别让人盯着自己座位反复点（点了也只会弹「已经摇过了」）。 */
      sub = left
        ? ('还有 ' + left + ' 家没摇 · 公骰一摇就锁住')
        : (SHAKES_PER_TURN > 1
            ? ('想换点就点自己座位再摇 ' + (SHAKES_PER_TURN - 1) + ' 次 · 公骰一摇就锁住')
            : '都摇好了 · 公骰一摇就锁住');
    } else if (G.phase === 'pick') {
      /* 这一步只为实现「11 正豹可以指定一个玩家喝」——
         命中已经记完了，这里只是额外的 1 杯，别把两件事混成一句话 */
      line = '<b>11 正豹</b> · 点一位，罚 1 杯';
      if (G.hits.length) sub = '对上的 ' + G.hits.length + ' 人已记杯';
    } else {
      var head = '<b>' + (isEleven(G.center) ? '11 正豹' : dsum(G.center) + ' 点') + '</b>';

      if (G.phase === 'hit') {
        var names = [], detail = [];
        for (var i = 0; i < G.hits.length; i++) {
          names.push(nameOf(G.hits[i].i));
          detail.push(nameOf(G.hits[i].i) + ' ' + whyOf(G.hits[i]));
        }
        var brief = names.length > 3
          ? names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 人'
          : names.join('、');
        line = head + ' → <span class="gold">' + brief + '</span> 喝';
        /* 人与人之间用竖线分：每人后面都跟着「· 双倍」这种理由，
           全用中点会看成「一个人 + 一串理由」（12 人桌上一次点到五六个） */
        sub = detail.join(' ｜ ');
      } else {
        line = head + ' → 没人对上 · 轮到 <b>' + nameOf((G.shaker + 1) % G.n) + '</b>';
      }

      /* 指名那一笔只在真摇过 11 的时候存在，没摇到就别写 */
      var pn = isEleven(G.center) ? pickNote() : '';
      if (pn) sub = sub ? sub + ' · ' + pn : pn;
    }

    /* 临时提示（摇满了 / 还有几家没摇）挂在小字行末，1.6 秒自己消失 */
    if (G.flash) sub = sub ? sub + ' · ' + G.flash : G.flash;

    el.hint.innerHTML = line + (sub ? '<span class="fd-sub">' + sub + '</span>' : '');
  }

  function paintBtns() {
    var items = [];
    if (G.phase === 'ready') {
      items.push({ act: 'roll', text: '摇公骰', cls: 'btn primary' });
    } else if (G.phase === 'pick') {
      /* 规则原话是「**可以**指定一个玩家」，所以留一条退路：
         庄家不想指人（或者点错了想退出）也能继续，别卡在这一屏。
         点座位才是主路径，按钮只是兜底，所以给次级样式。 */
      items.push({ act: 'skipPick', text: '这杯算了', cls: 'btn ghost' });
    } else if (G.phase === 'hit') {
      items.push({ act: 'roll', text: '继续摇', cls: 'btn primary' });
    } else {
      items.push({ act: 'next', text: nameOf((G.shaker + 1) % G.n) + ' 接手', cls: 'btn primary' });
    }
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<button class="' + items[i].cls + '" type="button" data-act="' +
        items[i].act + '">' + items[i].text + '</button>';
    }
    el.btns.innerHTML = h;
  }

  /* ---------------- 流程 ---------------- */

  /* 轮到第 i 家：全桌先自动换一手新牌（就是这一把唯一的一手）。
     全自动，而不是让 12 个人挨个点 —— 一台手机传一圈太累，
     而且这玩法的骰子本来就是明的，没必要每家都亲自按一下。
     次数上限见 SHAKES_PER_TURN（现在是 1，点座位补摇这一步等于取消了，
     代码留着，以后想放宽只改那个常量）。 */
  function startTurn(i) {
    G.shaker = i;
    G.center = null;
    G.hits = [];
    G.picked = -1;
    G.afterPick = 'pass';
    G.flash = '';
    G.phase = 'ready';
    for (var k = 0; k < G.n; k++) {
      G.seats[k].dice = [rollOne(), rollOne()];
      G.seats[k].used = 1;          // 自动这一手算第一次
    }
    playShake();                    // 全桌一起重摇，出一声就够
    paint(true);
    save();
  }

  /* 点自己座位补摇：一把里最多 SHAKES_PER_TURN 次（含开局那一手自动的） */
  function shakeSeat(i) {
    if (G.phase !== 'ready') return;
    var st = G.seats[i];
    if (!st) return;
    if (st.used >= SHAKES_PER_TURN) {
      /* 只能摇一次的时候别写「摇满 1 次」：这句话本来是给补摇留余地的，
         一次都没得补时说出口，人会以为还有哪个按钮没按 */
      flash(SHAKES_PER_TURN > 1
        ? nameOf(i) + ' 这一把摇满了 ' + SHAKES_PER_TURN + ' 次'
        : nameOf(i) + ' 这一把已经摇过了 · 公骰一摇就锁');
      return;
    }
    st.dice = [rollOne(), rollOne()];
    st.used += 1;
    G.flash = '';
    playShake();
    buzz(12);
    paint(true);
    save();
  }

  /* ---------------- 公骰滚动 ----------------
     用户 2026-11-12：「点摇之后不要立刻出结果，先有动起来的动作，2~4 秒，
     第一颗先停、第二颗再停，玩家才有期待感」。

     点数在点下去那一刻就已经摇好了（rollOne 先算），动画只决定「什么时候给人看」。
     这么排还有一个好处：中途切后台、锁屏把定时器冻住，最终落下的仍是这一把
     早就算好的那两个数，不会出现「滚完又重摇一次」的第二种牌 —— 明骰玩法里
     这点很要紧，否则别人上一步看到的结果跟你手机上会对不上。 */
  var CORE_LAND = [1550, 2350];   // 第一颗 / 第二颗落定的时刻（ms），全程 2.35 秒

  /* 把一颗骰子的脸换成 v（九宫格那 9 个 i 直接改 class，比重建 DOM 轻） */
  function coreFace(node, v) {
    var on = PIPS[v] || [];
    var kids = node.children;
    for (var i = 0; i < 9; i++) {
      kids[i].className = on.indexOf(i) >= 0 ? (RED[v] ? 'r' : '') : 'blank';
    }
    node.classList.toggle('empty', !v);
  }

  function rollCoreAnim(center, done) {
    var box = el.coreDice;
    if (!box) { done(center); return; }
    box.innerHTML = dieHtml(0, '9.8667vw') + dieHtml(0, '9.8667vw');
    box.removeAttribute('data-k');
    var ds = [box.children[0], box.children[1]];
    var landed = [false, false];

    /* 从第一帧就得写「摇骰中…」：等下一次 paint 才改的话，
       头两百毫秒标签还挂着「公骰」，看着像没反应 */
    el.core.classList.remove('idle');
    if (el.coreTag) el.coreTag.textContent = '摇骰中…';

    for (var i = 0; i < 2; i++) {
      /* 上一把落定时加的 .land 得先摘掉，不然它和 .rolling 两个动画打架 */
      ds[i].classList.remove('land');
      coreFace(ds[i], rollOne());
      ds[i].classList.add('rolling');
    }

    /* 68ms 换一次脸：再快看着像闪屏，再慢就不像在滚 */
    var tick = setInterval(function () {
      for (var i = 0; i < 2; i++) if (!landed[i]) coreFace(ds[i], rollOne());
    }, 68);

    function land(i) {
      landed[i] = true;
      ds[i].classList.remove('rolling');
      coreFace(ds[i], center[i]);
      /* 去掉再加，强制回流一次 —— 落地这下的弹跳才会重播 */
      ds[i].classList.remove('land');
      void ds[i].offsetWidth;
      ds[i].classList.add('land');
      buzz(10);
    }

    var t1 = setTimeout(function () { land(0); }, CORE_LAND[0]);
    var t2 = setTimeout(function () {
      land(1);
      clearInterval(tick);
      /* 记成「已经是这个点数」：随后那次 paint 就不会重写 DOM，
         落地那一顿不会被掐掉 */
      box.setAttribute('data-k', center.join(''));
      coreAnim = null;
      done(center);
    }, CORE_LAND[1]);

    coreAnim = {
      stop: function () {
        clearInterval(tick);
        clearTimeout(t1);
        clearTimeout(t2);
        coreAnim = null;
      }
    };
  }

  function doRoll() {
    /* 公骰一起手就锁：从现在到换人为止，谁都不能再动自己的点数 */
    if (G.phase !== 'ready' && G.phase !== 'hit') return;
    if (unrolled()) {
      flash('还有 ' + unrolled() + ' 家没摇');
      return;
    }
    if (coreAnim) return;              // 正在滚，别叠第二遍

    var center = [rollOne(), rollOne()];
    playShake();
    rollCoreAnim(center, commitRoll);
  }

  /* 滚完才真正落下这一把：命中、加杯、阶段、音效全在这一步。
     动画期间 G.center 还是上一把的值，没人能提前从桌面读出结果。 */
  function commitRoll(center) {
    G.center = center;
    G.hits = hitList(G.center, G.seats);
    for (var i = 0; i < G.hits.length; i++) {
      G.seats[G.hits[i].i].cups += cupsOf(G.hits[i].why);
    }
    G.picked = -1;

    if (isEleven(G.center)) {
      /* 11 正豹：先把命中记完，再单独等他点一位（额外 1 杯）。
         点完该接哪个阶段先存起来 —— 有命中就继续摇，没命中就换人 */
      G.afterPick = G.hits.length ? 'hit' : 'pass';
      G.phase = 'pick';
      buzz([16, 60, 16, 60, 16]);
      cue('lion');
    } else if (G.hits.length) {
      G.phase = 'hit';
      buzz([22, 70, 22]);
      cue('drink');
    } else {
      G.phase = 'pass';
      buzz(14);
      /* 换人的这一刻给一声（2026-11-10 用户提的：换人也要有声音）。
         三个人以上时它是「手机该往下传了」，两个人时就是「该你摇了」——都该有回应。 */
      cue('pass');
    }
    paint(true);
    save();
  }

  /* 11 正豹点了某一位：额外 1 杯，固定一杯（他同时被命中也不并账） */
  function pickSeat(i) {
    if (G.phase !== 'pick') return;
    if (!(i >= 0 && i < G.n)) return;
    G.seats[i].cups += 1;
    G.picked = i;
    G.phase = G.afterPick;
    buzz([30, 50, 30]);
    /* 点完这一位正好就是「没人对上」：同样是换人，同样该响 */
    if (G.phase === 'pass') cue('pass');
    paint(true);
    save();
  }

  function skipPick() {
    if (G.phase !== 'pick') return;
    G.picked = -2;
    G.phase = G.afterPick;
    if (G.phase === 'pass') cue('pass');
    paint(true);
    save();
  }

  function advance() {
    var next = G.shaker + 1;
    if (next >= G.n) { next = 0; G.round++; }
    startTurn(next);
  }

  function newGame(n) {
    /* 换人数 / 重开时公骰还在滚的话，得先掐掉：
       否则定时器还在往那张已经作废的桌子上写点数 */
    if (coreAnim) coreAnim.stop();
    G.n = n;
    G.round = 1;
    G.seats = [];
    for (var i = 0; i < n; i++) G.seats.push({ dice: [0, 0], cups: 0, used: 0 });
    buildSeats();
    startTurn(0);
    /* 人数文案跟着走：以前只在 boot / enter 里写过一次，
       从下拉里换了人数，右上角还挂着旧数字（2026-11-10 端到端测出来的） */
    if (el.countTxt) el.countTxt.textContent = n + ' 人';
  }

  /* ---------------- 存档 ---------------- */

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        n: G.n, shaker: G.shaker, round: G.round,
        center: G.center, phase: G.phase,
        picked: G.picked, afterPick: G.afterPick,
        seats: G.seats
      }));
    } catch (e) {}
  }

  function loadCount() {
    try {
      var n = parseInt(localStorage.getItem('ld_find_count') || '', 10);
      return (n >= MIN_P && n <= MAX_P) ? n : 6;
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
    G.shaker = (o.shaker >= 0 && o.shaker < o.n) ? o.shaker : 0;
    G.round = o.round > 0 ? o.round : 1;
    G.center = (o.center && o.center.length === 2) ? o.center : null;
    G.phase = (o.phase === 'hit' || o.phase === 'pass' || o.phase === 'pick') ? o.phase : 'ready';
    /* -1 没点 / -2 主动放弃 / 0..n-1 点了谁；越界一律当没点，别信脏档 */
    var pk = o.picked | 0;
    G.picked = (pk === -2 || (pk >= -1 && pk < o.n)) ? pk : -1;
    G.afterPick = (o.afterPick === 'hit') ? 'hit' : 'pass';
    /* 存档时点了人但还没接下一阶段 → 别让「指名」这一步被跳过 */
    if (G.phase === 'pick') G.picked = -1;
    G.seats = [];
    G.hits = [];
    for (var i = 0; i < o.n; i++) {
      var s = o.seats[i] || {};
      var d = (s.dice && s.dice.length === 2) ? s.dice : [0, 0];
      /* used 是 2026-11-10 才有的字段，老存档没有 → 摇过的按「已用 1 次」补上，
         不然老档一进来就能白多摇一次 */
      var u = (s.used | 0) >= 0 ? (s.used | 0) : 0;
      if (u === 0 && (d[0] | 0) + (d[1] | 0) > 0) u = 1;
      if (u > SHAKES_PER_TURN) u = SHAKES_PER_TURN;
      G.seats.push({ dice: [d[0] | 0, d[1] | 0], cups: s.cups | 0, used: u });
    }
    /* 点到谁得重新算一遍：桌面可能被清过，别存一份会过期的名单 */
    if (G.phase === 'hit' && G.center) G.hits = hitList(G.center, G.seats);
    buildSeats();
    paint(false);
    return true;
  }

  /* ---------------- 人数下拉 ---------------- */

  function buildDrop() {
    var h = '';
    for (var n = MIN_P; n <= MAX_P; n++) {
      h += '<button class="drop-item' + (n === G.n ? ' on' : '') +
        '" type="button" data-n="' + n + '">' + n + '</button>';
    }
    el.drop.innerHTML = h;
  }

  function openDrop() {
    buildDrop();
    el.drop.hidden = false;
    el.shade.hidden = false;
    el.countBtn.classList.add('on');
  }

  function closeDrop() {
    el.drop.hidden = true;
    el.shade.hidden = true;
    el.countBtn.classList.remove('on');
  }

  function dropOpen() { return el.drop && !el.drop.hidden; }

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

    /* 点座位：等点名的时候是「点名」，轮到新庄家的时候是「补摇自己」。
       其它阶段点座位不做任何事 —— 公骰已经开始摇了，谁都不能再改点数。 */
    el.seats.addEventListener('click', function (e) {
      var s = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!s) return;
      var i = Number(s.getAttribute('data-i'));
      if (G.phase === 'pick') pickSeat(i);
      else if (G.phase === 'ready') shakeSeat(i);
    });

    el.countBtn.addEventListener('click', function () {
      if (dropOpen()) closeDrop(); else openDrop();
    });

    el.drop.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-n]') : null;
      if (!b) return;
      var n = Number(b.getAttribute('data-n'));
      closeDrop();
      if (n === G.n) return;
      try { localStorage.setItem('ld_find_count', String(n)); } catch (e) {}
      newGame(n);          // 换人数 = 重开一桌，杯数一起清掉
      buzz(10);
    });

    el.shade.addEventListener('click', closeDrop);

    /* 重开：第一下只把按钮变成「再点一次」，2.5 秒内点第二下才真清。
       满桌的杯数是这一晚的战绩，手滑一下就没了会想打人。 */
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
      newGame(G.n);
      buzz(18);
    });
  }

  /* ---------------- 入口 ---------------- */

  function enter() {
    if (!G.n) {
      if (!restore()) newGame(loadCount());
      return;
    }
    paint(false);
  }

  function leave() {
    closeDrop();
    redoAt = 0;
    if (el.redo) {
      el.redo.textContent = '重开';
      el.redo.classList.remove('arm');
    }
  }

  function boot() {
    el = {
      seats: $('fdSeats'),
      core: $('fdCore'),
      coreDice: $('fdCoreDice'),
      coreTag: $('fdCoreTag'),
      who: $('fdWho'),
      round: $('fdRound'),
      hint: $('fdHint'),
      btns: $('fdBtns'),
      countBtn: $('fCountBtn'),
      countTxt: $('fCountTxt'),
      drop: $('fDrop'),
      shade: $('fShade'),
      redo: $('findRedo')
    };
    if (!el.seats) return;         // 页面上没有这一页（比如被裁剪过），直接不启动

    bind();
    /* 第一次碰屏幕哑播一下解锁音频（iOS / 微信要求第一次 play() 在手势里） */
    var unlocked = false;
    var once = function () {
      if (unlocked) return;
      unlocked = true;
      unlockShk();
    };
    document.addEventListener('touchstart', once, true);
    document.addEventListener('mousedown', once, true);
    /* 进页面之前就把桌子摆好：切过去就是一副能摇的牌，不用再点一次 */
    if (!restore()) newGame(loadCount());
    if (el.countTxt) el.countTxt.textContent = G.n + ' 人';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 路由（f350.js 里那套）切页时叫一声 */
  window.LDFind = {
    enter: function () {
      enter();
      if (el.countTxt) el.countTxt.textContent = G.n + ' 人';
    },
    leave: leave
  };
})();

/* 吹牛骰子 · 联机（潮汕 350）
 *
 * 这一份只做「跟服务器说话」和「把状态画出来」两件事，
 * 界面元素、类名、尺寸全部沿用单机：.p-strip / .f3-table / .f3-dice /
 * .f3-taken / .f3-score / .f3-btns / .btn。f350.js 那边改一次样式，这里跟着变。
 *
 * 规则不在这里算 —— 点数、爆掉、豹子、锁分线全在服务器判定。
 * 以前考虑过「谁先来谁当主机」，但手机一锁屏浏览器就把页面冻住，
 * 主机一睡整桌人跟着停；放到 Cloudflare 上，谁掉线只影响他自己那一手。
 *
 * 为什么每一步都等服务器回话才动：
 *   350 是明骰，桌上七颗大家都该看见同一副。本地先猜一个再被服务器改，
 *   就会出现「我这儿显示 3 个 5，结账时说只有 2 个」——这种架最伤和气。
 *   80~120ms 的等待用「按钮立刻灰下去 + 骰子抖一下」盖过去，手感不比单机差。
 */
(function () {
  'use strict';

  /* 后端地址。
     整站已经部署在 Cloudflare 上（单机 + 联机同一份 index.html），
     那种情况下页面和房间是同一个域，直接用同源就好 —— 少一次跨域、少一跳网络。
     只有 GitHub Pages 的镜像、APK 里的 file:// 才需要退回这个写死的域名。
     本机联调用 ?net=http://127.0.0.1:8787 覆盖。 */
  var DEFAULT_API = 'https://dice.2582580.xyz';
  var HOME_HOST = 'dice.2582580.xyz';

  /* ================= 跟单机一致的常量 ================= */
  var DICE = 7;
  var BASE = 350;
  var CAP = 700;
  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var CELL = [20, 50, 80];
  var RED = { 1: true, 4: true };
  var TILT = [-9, 6, -4, 8, -7, 5, -6];

  /* 桌面尺寸（rpx），必须和 f350.css 的 .f3-table 对齐：81.3333vw × 50vw */
  var TABLE_W = 610;
  var TABLE_H = 375;

  var VW = 100 / 750;
  function rpx(n) {
    var s = (n * VW).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return (s || '0') + 'vw';
  }

  function $(id) { return document.getElementById(id); }

  function pointsOf(v) { return v === 1 ? 100 : v === 5 ? 50 : 0; }

  /* ================= 音效 / 震动 =================
     联机刚接进首页时是「哑」的：摇骰只有动画没有声，桌上一片安静，
     跟旁边单机一比就是个半成品。这里复用同一颗 shake.mp3，不另存文件
     （和 f350.js 一个来源，两个玩法以后音量、音色永远一致）。

     有一件事必须做在真正出声之前：iOS / 微信里 new Audio() 的第一次 play()
     得落在用户手势里，否则后面任何一次「不是手点出来」的播放都会被静默拦掉，
     表现就是「安卓有声音、iPhone 没有」。所以第一次碰屏幕时先哑播一下解锁。 */
  var SOUND_SRC = 'assets/audio/shake.mp3';
  var snd = null;
  /* 开关的真身是 snd.js 里那一份（全站共用）。这里存 sndOn 只当兜底 ——
     snd.js 没加载（老缓存）时才轮得到它。 */
  var sndOn = window.LDSnd ? window.LDSnd.isOn() : true;

  function soundOn() {
    return window.LDSnd ? window.LDSnd.isOn() : sndOn;
  }

  function ensureSnd() {
    if (snd) return snd;
    try {
      snd = new Audio(SOUND_SRC);
      snd.preload = 'auto';
      /* 加载失败就置空，下次再来一颗新的 —— 网络抖一下不该永久变哑 */
      snd.addEventListener('error', function () { snd = null; });
    } catch (e) { snd = null; }
    return snd;
  }

  function unlockSnd() {
    var a = ensureSnd();
    if (!a) return;
    var quiet = function () { a.muted = false; a.pause(); a.currentTime = 0; };
    try {
      a.muted = true;              // 解锁这一下不能真出声，否则一进页面就嗷一声
      var p = a.play();
      if (p && p.then) p.then(quiet).catch(function () { a.muted = false; });
      else quiet();
    } catch (e) { a.muted = false; }
  }

  function playShake() {
    if (!soundOn()) return;
    var a = ensureSnd();
    if (!a) return;
    try {
      a.muted = false;
      a.currentTime = 0;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  /* 换人 / 豹子 / 爆点 / 结算：全站共用的合成音（snd.js）。
     跟本地那个 🔊 走同一个开关 —— 有人在地铁上关了音效，
     结果换人还在叮一声，那这个开关就是假的。 */
  function cue(name) {
    if (!soundOn()) return;
    if (window.LDSnd) window.LDSnd.cue(name);
  }

  /* ================= 重开要投票 =================

     以前谁按谁洗牌：一手好牌正打着，桌上随便谁手滑一下就全没了。
     现在按服务器的规矩 —— 在线的三分之二点头才真重开（4 人要 3 票、3 人要 2 票）。
     客户端只负责把「几票 / 要几票」写在按钮上，够不够由服务器算，免得两边各有一套。 */

  function voteNow(s) {
    var v = s && s.vote;
    if (!v) return null;
    /* 服务器给的是「还剩多少毫秒」，本地用自己的钟倒计时，别拿手机时间去比服务器时间 */
    if (S.voteUntil && Date.now() > S.voteUntil) return null;
    var mine = false;
    for (var i = 0; i < v.yes.length; i++) if (v.yes[i] === S.you) mine = true;
    return { need: v.need, yes: v.yes.length, mine: mine, kind: v.kind, by: v.by };
  }

  /* 顶栏那颗「重开」：没人发起时就是一个普通按钮，一点就是投票发起人 */
  function renderRedo() {
    var b = el.redo, s = S.state;
    if (!b || !s) return;
    if (!s.started) { b.hidden = true; return; }
    b.hidden = false;
    var v = s.phase === 'over' ? null : voteNow(s);
    if (!v) {
      b.textContent = '重开';
      b.classList.remove('ask', 'on', 'voting');
      return;
    }
    b.textContent = (v.mine ? '已投 ' : '重开 ') + v.yes + '/' + v.need;
    b.classList.add('voting');
    b.classList.toggle('ask', !v.mine);
    b.classList.toggle('on', v.mine);
    /* 票放在那儿没人接就作废了：到点自己重画一次，别让半截投票一直挂着 */
    clearTimeout(S.voteTimer);
    S.voteTimer = setTimeout(render, Math.max(400, S.voteUntil - Date.now()));
  }

  /* ================= 踢人 =================

     有人手机没电、或者干脆把牌桌忘了，座位一直占着。房主点名字直接请出去；
     其他人点名字也行，但要三分之二的人点头 —— 谁手快谁说了算，桌上就该吵了。
     被踢的那位不算分母：让他投票决定自己走不走，等于送他一张否决票。 */

  function kickNow(s) {
    var k = s && s.kick;
    if (!k) return null;
    if (S.kickUntil && Date.now() > S.kickUntil) return null;
    var mine = false;
    for (var i = 0; i < k.yes.length; i++) if (k.yes[i] === S.you) mine = true;
    return { target: k.target, need: k.need, yes: k.yes.length, mine: mine, by: k.by };
  }

  function playerById(s, pid) {
    for (var i = 0; i < s.players.length; i++) if (s.players[i].id === pid) return s.players[i];
    return null;
  }

  function renderKick() {
    var box = el.kick;
    if (!box || box.hidden) return;
    var s = S.state;
    var p = s ? playerById(s, S.kickPid) : null;
    if (!p) { box.hidden = true; return; }
    var host = hostOf(s);
    var isHost = !!host && host.id === s.you;
    var k = kickNow(s);
    var onThis = k && k.target === p.id;

    el.kickName.textContent = p.name + (p.online === false ? ' · 离线' : '');
    if (isHost) {
      el.kickSub.textContent = p.online === false
        ? '离线有一会儿了 · 请出去，座位让给下一位'
        : '他还在线 · 确定要请出去？';
      el.kickOk.textContent = '踢出房间';
    } else if (onThis) {
      el.kickSub.textContent = '已有 ' + k.yes + '/' + k.need + ' 人同意';
      el.kickOk.textContent = k.mine ? '撤回申请' : '同意踢出';
    } else {
      el.kickSub.textContent = '申请后要三分之二的人同意才会请他出去';
      el.kickOk.textContent = '申请踢出';
    }
    /* 红＝这一下就把人送走。发起申请、撤回都还是深灰的普通主按钮：
       按钮一红，点「撤回申请」的人会以为自己在做更狠的事。 */
    var danger = isHost || (onThis && !k.mine && k.yes + 1 >= k.need);
    el.kickOk.classList.toggle('danger', !!danger);
  }

  function openKick(pid) {
    var s = S.state;
    if (!s || !pid) return;
    if (pid === s.you) { toast('这是你自己'); return; }
    var p = playerById(s, pid);
    if (!p) return;
    S.kickPid = pid;
    if (el.kick) el.kick.hidden = false;
    renderKick();
  }

  function closeKick() {
    S.kickPid = '';
    if (el.kick) el.kick.hidden = true;
  }

  /* 点自己那张卡 = 改名字（2026-11-13 用户：「点自己的座位或者头像就可以
     直接更改名字，不用返回上一层」）。点别人还是请出去，两件事不共一个入口。

     本地先判一次重名，只是为了让手马上有个回话；算数的那次在服务器
     （renamePlayer），两个人同时改名时本地这份名单是旧的，服务器会拒。 */
  function openRename() {
    var s = S.state;
    if (!s || !window.LDRename) return;
    if (window.LDRename.isOpen()) return;
    var mine = playerById(s, s.you) || {};
    var cur = mine.name || myName();
    window.LDRename.open({
      name: cur,
      check: function (nm) {
        var k = function (v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); };
        var list = s.players || [];
        for (var i = 0; i < list.length; i++) {
          if (!list[i] || list[i].id === s.you) continue;
          if (k(list[i].name) === k(nm)) return '「' + nm + '」已经有人用了，换一个';
        }
        return '';
      },
      ok: function (nm) {
        if (nm === cur) return;
        /* 不走 send()：它会把「处理中」挂到所有动作按钮上，
           而名字没变时服务端不广播，那个灰就一直撤不掉 */
        if (!S.ws || S.ws.readyState !== 1) { toast('还没连上，正在重连'); return; }
        try { S.ws.send(JSON.stringify({ t: 'rename', name: nm })); } catch (e) {}
      }
    });
  }

  function kickOk() {
    var s = S.state;
    if (!s) return;
    var host = hostOf(s);
    var isHost = !!host && host.id === s.you;
    var k = kickNow(s);
    var mine = k && k.target === S.kickPid && k.mine;
    var pid = S.kickPid;
    closeKick();
    if (!isHost && mine) { send({ t: 'unvotekick' }, 'unvotekick'); return; }
    vibrate(16);
    send({ t: 'kick', pid: pid }, 'kick');
  }

  /* ================= 踢人投票浮卡 =================

     投票状态一直只活在「桌上的人」那个弹层里（按钮变成「同意 1/2」）。
     不打开它，别人发起投票你根本不知道，等 45 秒作废了才发觉。
     所以左边空白处浮一张小卡：谁要被请走、几票、还剩几秒。

     卡片只是通知，pointer-events:none（见 app.css 的 .vcard）——
     它绝不能挡桌面上任何一个能点的地方。投票入口还是原来那两个。

     秒数不靠服务端推：没人动手的时候服务端根本不发消息，
     45 秒到点也不会有哪条回包来告诉你「作废了」。所以本地按
     「这条回包说还剩多少」（state 里的 kick.left，已经存进 S.kickUntil）
     自己每 200ms 走一格，到 0 就收。 */
  function voteCardOff() {
    if (S.vcTimer) { clearInterval(S.vcTimer); S.vcTimer = 0; }
    S.vcSpan = 0;
    S.vcKey = '';
    if (el.vc) el.vc.hidden = true;
  }

  function paintVoteCard() {
    if (!el.vc || el.vc.hidden) return;
    var k = kickNow(S.state);
    if (!k) { voteCardOff(); return; }
    /* 手机时间不准也不影响：kickUntil 是从服务端那句「还剩多少」算出来的 */
    var left = S.kickUntil - Date.now();
    if (left <= 0) { voteCardOff(); return; }
    if (!S.vcSpan) S.vcSpan = left;
    el.vcS.textContent = (k.mine ? '你已同意 · ' : '')
      + k.yes + '/' + k.need + ' 人同意 · ' + Math.ceil(left / 1000) + ' 秒';
    el.vcBar.style.width =
      Math.max(0, Math.min(100, (left / S.vcSpan) * 100)) + '%';
    /* 「同意」那颗按钮：房主点谁谁直接走（服务端 kickPlayer 对房主是立刻生效的），
       被投的那个人也投不了票 —— 这两种都不给按钮，免得点下去意思不对。
       已经投过的留在原位变灰写「已同意」，卡片才不会左右跳一格。 */
    if (el.vcOk) {
      var host = hostOf(S.state);
      var hide = (!!host && host.id === S.you) || k.target === S.you;
      el.vcOk.hidden = hide;
      if (!hide) {
        el.vcOk.disabled = k.mine;
        el.vcOk.textContent = k.mine ? '已同意' : '同意';
      }
    }
  }

  function syncVoteCard() {
    var k = kickNow(S.state);
    if (!k) { voteCardOff(); return; }
    if (!el.vc) return;
    /* 换了被请的人、或换了个发起人 = 新的一次投票：重新滑进来，条子从头走 */
    var key = k.target + '|' + k.by;
    var fresh = key !== S.vcKey;
    S.vcKey = key;
    if (fresh) S.vcSpan = Math.max(1000, S.kickUntil - Date.now());
    var p = playerById(S.state, k.target);
    el.vcWho.textContent = p ? p.name : '—';
    if (fresh) {
      el.vc.hidden = false;
      vibrate(12);
    }
    paintVoteCard();
    if (!S.vcTimer) S.vcTimer = setInterval(paintVoteCard, 200);
  }

  /* 卡片上那颗「同意」。发的东西跟「桌上的人」里点同一行完全一样
     （服务端 kickPlayer：同一个人再点一次就是补一票），所以两边不会打架。 */
  function onVoteOk(e) {
    e.stopPropagation();
    e.preventDefault();
    var k = kickNow(S.state);
    if (!k || k.mine) return;
    send({ t: 'kick', pid: k.target }, 'kick');
  }

  /* ================= 跳过卡住的那一手 =================

     规则跟服务器同一套（src/index.js 的 canSkipBy）：只有房主点得动。
     房主要是自己掉线了、或者他本人就是卡住的那个，就放开给所有人 ——
     房主不在是常态，不能因为它整桌陪着等。

     跳一个人等于让他这一局直接出局，所以这个权力不撒给全桌：
     谁手快谁说了算，桌上就该吵了。 */
  function hostOf(s) {
    for (var i = 0; i < s.players.length; i++) if (s.players[i].seat === 0) return s.players[i];
    return null;
  }

  function canSkip(s) {
    if (!s || !s.started || s.phase === 'over') return null;
    var cur = s.players[s.turn];
    if (!cur || cur.locked) return null;
    if (myTurn()) return null;
    var host = hostOf(s);
    var ok = true;
    if (host) ok = (host.online === false) || (host.id === s.you);
    if (!ok) return null;
    return { name: cur.name, off: cur.online === false };
  }

  /* 交接层底下那行字：能跳就给「跳过 XX」，不能跳就什么都不放 ——
     桌上不需要一个永远点不动的按钮。 */
  function renderSkipBtn(s) {
    var b = el.skip;
    if (!b) return;
    var sk = canSkip(s);
    if (s.phase !== 'handoff' || !sk) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = sk.off ? '跳过 ' + sk.name + '（掉线）' : '跳过 ' + sk.name;
    b.classList.add('on');
  }

  /* 按手牌数排布：≤4 颗一行，多了分两行，行内居中（与 f350.js 同一套算法） */
  var SLOT_CACHE = {};
  function layout(n) {
    if (SLOT_CACHE[n]) return SLOT_CACHE[n];
    var cols = n <= 4 ? n : Math.ceil(n / 2);
    var rows = Math.ceil(n / cols);
    var GX = 16, GY = 24;
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

  /* ================= 状态 ================= */

  var S = {
    api: DEFAULT_API,
    code: '',
    you: null,
    token: '',
    state: null,      // 服务器最后一次给的桌面
    sel: {},          // 本地勾中的手牌下标（只有自己能选）
    handSig: '',
    pending: '',      // 已经发出、还没回来的动作
    ws: null,
    alive: false,
    retry: 0,
    retryTimer: null,
    pingTimer: null,
    tt: null,         // toast 定时器
    shakeTimer: null,
    lastTapIdx: -1,   // 双击收分：上一次点的是哪颗、什么时候
    lastTapAt: 0,
    voteUntil: 0,     // 重开投票作废的时刻（本地钟，按服务器给的和数自己算）
    voteTimer: null,
    kickUntil: 0,     // 踢人投票的作废时刻
    kickPid: '',      // 弹层里正在说的那个人
    /* 左边那张投票浮卡：vcSpan = 这次投票的总时长（画进度条用），
       vcKey = 这一次投票的身份（谁被请 + 谁发起的），换了人就要重新滑进来 */
    vcSpan: 0,
    vcKey: '',
    vcTimer: 0
  };

  var el = {};

  function cache() {
    el.page = $('pageNetGame');
    el.code = $('ngCode');
    el.strip = $('ngStrip');
    el.stage = el.page ? el.page.querySelector('.f3-stage') : null;
    el.panel = el.page ? el.page.querySelector('.f3-panel') : null;
    el.dice = $('ngDice');
    el.lobby = $('ngLobby');
    el.roomCode = $('ngRoomCode');
    el.lobbySub = $('ngLobbySub');
    el.start = $('ngStart');
    el.handoff = $('ngHandoff');
    el.hdKicker = $('ngHdKicker');
    el.hdName = $('ngHdName');
    el.hdSub = $('ngHdSub');
    el.go = $('ngGo');
    el.rank = $('ngRank');
    el.taken = $('ngTaken');
    el.score = $('ngScoreBox');
    el.scoreNum = $('ngScoreNum');
    el.hint = $('ngHint');
    el.btns = $('ngBtns');
    el.redo = $('ngRedo');
    el.skip = $('ngSkip');
    el.kick = $('ngKick');
    el.kickName = $('ngKickName');
    el.kickSub = $('ngKickSub');
    el.kickOk = $('ngKickOk');
    el.kickNo = $('ngKickNo');
    el.vc = $('ngVote');
    el.vcWho = $('ngVoteWho');
    el.vcS = $('ngVoteS');
    el.vcBar = $('ngVoteBar');
    el.vcOk = $('ngVoteOk');
    if (el.vcOk) {
      /* 别让按下的这一下冒到桌面去：卡片就贴在座位条 / 骰盘旁边 */
      el.vcOk.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      el.vcOk.addEventListener('click', onVoteOk);
    }
    /* 本局记录：服务端一直在记（state.log），这里只是把它摊开给人翻 */
    el.logMask = $('ngLog');
    el.logList = $('ngLogList');
    el.logBtn = $('ngLogBtn');
    el.logX = $('ngLogX');
    el.off = null;            // 断线提示条，第一次需要时再插
  }

  /* ================= 本局记录 =================
     以前只有「跳一下就没了」的吐司：低头回个消息，抬头只看到牌已经换了。
     现在能翻回去看 —— 谁摇出豹子、谁被跳过、谁被请出去，全在 log 里。 */
  function renderLog() {
    var box = el.logList;
    if (!box) return;
    var list = (S.state && S.state.log) || [];
    box.textContent = '';
    if (!list.length) {
      var em = document.createElement('div');
      em.className = 'lg-empty';
      em.textContent = '还没有记录 · 打一手就有了';
      box.appendChild(em);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var row = document.createElement('div');
      row.className = 'lg-row';
      row.setAttribute('data-k', it.k || '');
      var dot = document.createElement('i');
      dot.className = 'lg-dot';
      row.appendChild(dot);
      var tx = document.createElement('span');
      /* textContent：名字是别人起的，别当成 HTML 拼进去 */
      tx.textContent = it.text || '';
      row.appendChild(tx);
      box.appendChild(row);
    }
    /* 最新的一条在最下面，打开时直接看尾巴 */
    box.scrollTop = box.scrollHeight;
  }

  function openLog() {
    if (!el.logMask) return;
    renderLog();
    el.logMask.hidden = false;
  }

  function closeLog() {
    if (el.logMask) el.logMask.hidden = true;
  }

  /* ================= 本地记住的东西 ================= */

  function seatKey(code) { return 'ld_net_seat_' + code; }

  function loadSeat(code) {
    try {
      var raw = localStorage.getItem(seatKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveSeat() {
    if (!S.code || !S.you) return;
    try {
      localStorage.setItem(seatKey(S.code), JSON.stringify({ pid: S.you, token: S.token }));
    } catch (e) {}
    rememberRoom();
  }

  /* ================= 「上一桌还在」 =================
     座位是按房号存的（ld_net_seat_1234），大厅因此不知道「你还有一局没打完」——
     中途退出再进来只有「开一个房间 / 加入房间」两个按钮，人只能凭记忆输房号。
     这里额外记一条「最近待过的桌子」，大厅就能把它摆到最上面。

     只记房号不记局内状态：桌上长什么样永远以服务器为准，
     本地记一份分数最容易出现「我这儿 350、你那儿 300」的架。 */
  var LAST_KEY = 'ld_net_last';

  function rememberRoom() {
    if (!S.code) return;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ code: S.code, at: Date.now() }));
    } catch (e) {}
  }

  function lastRoom() {
    try {
      var o = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (!o || !/^(\d{4}|\d{6})$/.test(o.code || '')) return null;
      /* 一天以前的就算了：房间空着一晚上早被清掉了，留着只会点进去扑空 */
      if (Date.now() - (o.at || 0) > 86400000) return null;
      return o;
    } catch (e) { return null; }
  }

  function clearLast() {
    try { localStorage.removeItem(LAST_KEY); } catch (e) {}
  }

  /* 名字：第一次进来自动给一个，不满意自己改。
     以前是空着让人填 —— 酒桌上没人愿意在开局前先打一次字，
     结果一桌全是「玩家1、玩家2」，谁也认不出谁。
     池子挑的都是两个字的常用昵称，念出来不别扭、也不带任何含义。 */
  var NAMES = [
    '橙子', '阿七', '小满', '豆豆', '老王', '阿珍', '大熊', '小北',
    '冬瓜', '阿飞', '团子', '花生', '阿May', '芒果', '小雨', '阿宝',
    '毛豆', '小鱼', '二两', '阿伟', '桃子', '小鹿', '阿泰', '年糕'
  ];

  function randName() {
    return NAMES[Math.floor(Math.random() * NAMES.length)] || '玩家';
  }

  /* 名字统一由「联机」首页给（window.LDName，见 f350.js），这里只取。
     这两行原来是「第一次进来随机给一个」的现场生成 —— 现在起名搬到上一层了，
     保留兜底是防旧缓存 / 裁剪版里没有那份模块。 */
  function myName() {
    if (window.LDName) return window.LDName.get();
    try {
      var n = (localStorage.getItem('ld_net_name') || '').trim();
      if (n) return n;
      n = randName();
      localStorage.setItem('ld_net_name', n);
      return n;
    } catch (e) { return '玩家'; }
  }

  /* ================= 说话 ================= */

  function wsUrl() {
    return S.api.replace(/^http/, 'ws') + '/r/' + S.code + '/ws';
  }

  function connect() {
    if (!S.code) return;
    closeSocket();
    S.alive = true;

    var ws;
    try { ws = new WebSocket(wsUrl()); }
    catch (e) { scheduleRetry(); return; }
    S.ws = ws;

    ws.onopen = function () {
      if (S.ws !== ws) return;
      S.retry = 0;
      showOff(false);
      var seat = loadSeat(S.code);
      ws.send(JSON.stringify({
        t: 'hello',
        name: myName(),
        pid: seat && seat.pid,
        token: seat && seat.token
      }));
      startPing();
    };

    ws.onmessage = function (ev) {
      if (S.ws !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMsg(m);
    };

    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.ws = null;
      stopPing();
      if (S.alive) { showOff(true); scheduleRetry(); }
    };

    ws.onerror = function () {};
  }

  function closeSocket() {
    var ws = S.ws;
    S.ws = null;
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch (e) {}
    }
    stopPing();
  }

  function onMsg(m) {
    if (m.t === 'you') {
      S.you = m.pid;
      S.token = m.token;
      if (m.code) S.code = m.code;
      saveSeat();
      return;
    }
    /* 被请出房间：别装成「网络抽了」在那儿一直重连，说清楚然后回大厅 */
    /* 自己点「退出」：服务端已经把座位摘掉了，这儿收尾 */
    if (m.t === 'quitok') { finishQuit(); return; }
    if (m.t === 'kicked') {
      toast(m.msg || '你被请出了房间');
      try { localStorage.removeItem(seatKey(S.code)); } catch (e) {}
      clearLast();
      goLobby();
      return;
    }

    if (m.t === 'state') {
      /* 先把「上一条状态里我是不是该动了」记下来：接手提醒、爆掉、豹子
         这些都靠新旧对比判断，赋值之后就比不了了 */
      var prev = S.state;
      var wasMine = !!prev && myTurn();
      var prevPhase = prev ? prev.phase : '';

      S.state = m.s;
      S.pending = '';
      /* 投票的倒计时按「服务器说还剩多久」重新起算，手机时间准不准都不影响 */
      S.voteUntil = S.state.vote ? Date.now() + S.state.vote.left : 0;
      S.kickUntil = S.state.kick ? Date.now() + S.state.kick.left : 0;
      /* 手牌变了就把勾选清掉：上一手的勾不能带到这一手，
         否则「点一下收下」收走的可能是自己没看见的那几颗 */
      var sig = handSig();
      if (sig !== S.handSig) {
        S.handSig = sig;
        S.sel = {};
      }
      render();

      /* 投票浮卡跟桌面上的一切解耦：不管现在什么阶段、面板开没开，
         只要服务端那份 state 里还有人被投票请走，就把它画出来 */
      syncVoteCard();

      /* 面板开着的时候来了新状态：跟着刷一遍。
         不刷的话别人摇完一手，你手上这份记录还停在打开那一刻。 */
      if (el.logMask && !el.logMask.hidden) renderLog();

      /* 震动只做「该你动了」和「出事了」两种，响太多就变成骚扰。
         手机搁在桌上，靠这一下把人从聊天里叫回来就够了。 */
      if (S.state && S.state.started) {
        if (!wasMine && myTurn()) vibrate([16, 60, 16]);
        if (prevPhase !== 'bust' && S.state.phase === 'bust') { vibrate([40, 70, 40]); cue('bust'); }
        if (prevPhase !== 'lion' && S.state.phase === 'lion') { vibrate([16, 60, 16, 60, 26]); cue('lion'); }
        if (prevPhase !== 'over' && S.state.phase === 'over') { vibrate([40, 70, 40, 70, 60]); cue('drink'); }
        /* 换人：以前只有震动，搁在桌上听不见 —— 手机上「轮到谁」全靠这一声
           （2026-11-10 用户提的：换人也要有声音）。 */
        if (prevPhase !== 'handoff' && S.state.phase === 'handoff') cue('pass');
        /* 谁被跳过 / 谁被让到队尾，得说一声 —— 桌上突然换了人，
           没看见这句只会以为点到别的什么了。 */
        var lg = S.state.log && S.state.log.length ? S.state.log[S.state.log.length - 1] : null;
        if (lg && lg.k === 'skip' && (!prev || !prev.log
            || prev.log[prev.log.length - 1].text !== lg.text)) {
          toast(lg.text);
        }
        /* 有人发起重开：按钮突然从「重开」变成「重开 1/4」，不说一句谁都以为点错了 */
        var nv = S.state.vote;
        if (nv && (!prev || !prev.vote)) {
          var who = nv.by;
          for (var pi = 0; pi < S.state.players.length; pi++) {
            if (S.state.players[pi].id === nv.by) who = S.state.players[pi].name;
          }
          toast(who + ' 发起重开 · 要 ' + nv.need + ' 人同意');
          vibrate(12);
        }
        /* 有人申请踢人：被点的那张卡上会多一行「踢出 1/2」，再说一句把注意力引过去 */
        var nk = S.state.kick;
        if (nk && (!prev || !prev.kick)) {
          var kname = nk.target;
          for (var ki = 0; ki < S.state.players.length; ki++) {
            if (S.state.players[ki].id === nk.target) kname = S.state.players[ki].name;
          }
          toast('有人想请 ' + kname + ' 出去 · 要 ' + nk.need + ' 人同意');
        }
        /* 票够了、真洗牌了 */
        if (lg && (lg.k === 'restart' || lg.k === 'again')
            && (!prev || !prev.log || prev.log[prev.log.length - 1].text !== lg.text)) {
          toast(lg.text);
        }
      }
      return;
    }
    if (m.t === 'err') {
      var was = S.pending;
      S.pending = '';
      var msg = m.msg || '这一步没成';
      /* 还没进桌就出错（房号没了、局已经开了）：这句话得留在房号下面，
         光一个 1.5 秒的吐司，人一抬头就没了，只剩「正在连房间…」挂在那儿 */
      if (!S.state || !S.state.started) {
        if (el.lobbySub) el.lobbySub.textContent = msg;
      }
      render();
      toast(msg);
      /* 跳过被拒 = 本机看到的状态比服务器旧了（最常见的是他掉线又悄悄连回来，
         那条「上线了」的广播我们没收到）。这时候光弹一句话没用 ——
         界面还停在「可以跳过」上，人会一直点。干脆再要一次全量状态。 */
      if (was === 'skip') send({ t: 'sync' });
    }
  }

  function send(obj, tag) {
    if (!S.ws || S.ws.readyState !== 1) {
      toast('还没连上，正在重连');
      return false;
    }
    S.pending = tag || obj.t;
    S.ws.send(JSON.stringify(obj));
    render();
    return true;
  }

  function scheduleRetry() {
    if (!S.alive) return;
    clearTimeout(S.retryTimer);
    var wait = Math.min(4000, 400 * Math.pow(2, Math.min(S.retry, 4)));
    S.retry++;
    S.retryTimer = setTimeout(function () {
      if (S.alive) connect();
    }, wait);
  }

  /* 心跳：手机网络闲置一会儿就会把长连接悄悄断掉（看起来「连着」实际发不出去）。
     25 秒戳一下，成本一个空包，掉线能早发现 20 秒。 */
  function startPing() {
    stopPing();
    S.pingTimer = setInterval(function () {
      if (S.ws && S.ws.readyState === 1) {
        try { S.ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {}
      }
    }, 25000);
  }

  function stopPing() {
    clearInterval(S.pingTimer);
    S.pingTimer = null;
  }

  function leave() {
    S.alive = false;
    clearTimeout(S.retryTimer);
    closeSocket();
    clearTimeout(S.shakeTimer);
    clearTimeout(S.voteTimer);  // 上一桌的投票倒计时不能接着跑
    S.voteUntil = 0;
    S.state = null;
    S.you = null;
    S.token = '';
    S.sel = {};
    S.handSig = '';
    S.pending = '';
    S.code = '';
    /* 记录弹层跟着这一桌一起收：换到别的房间还挂着上一桌的战报最容易被误读 */
    if (el.logMask) el.logMask.hidden = true;
    if (el.dice) el.dice.classList.remove('shaking');
  }

  /* ================= 看状态 ================= */

  function me() {
    var s = S.state;
    if (!s || !s.you) return null;
    for (var i = 0; i < s.players.length; i++) {
      if (s.players[i].id === s.you) return s.players[i];
    }
    return null;
  }

  /* 房主这个概念在联机里已经不重要了：开局、重开、再来一局谁都能点，
     所以不再有 isHost()。留着它只会让人以为还有哪一步要等房主。 */

  function myTurn() {
    var s = S.state;
    return !!(s && s.started && s.phase !== 'over' &&
      s.players[s.turn] && s.players[s.turn].id === s.you);
  }

  function curName() {
    var s = S.state;
    if (!s || !s.players[s.turn]) return '';
    return s.players[s.turn].name;
  }

  function liveCount() {
    var s = S.state;
    if (!s) return 0;
    var n = 0;
    for (var i = 0; i < s.hand.length; i++) if (s.hand[i].v) n++;
    return n;
  }

  function picked() {
    var out = [], gain = 0;
    var s = S.state;
    if (!s) return { idx: out, gain: gain };
    for (var i = 0; i < s.hand.length; i++) {
      var d = s.hand[i];
      if (d.v && S.sel[i] && pointsOf(d.v)) {
        out.push(i);
        gain += pointsOf(d.v);
      }
    }
    return { idx: out, gain: gain };
  }

  function handSig() {
    var s = S.state;
    if (!s) return '';
    var out = s.phase + '|' + s.turn + '|' + s.took + '|';
    for (var i = 0; i < s.hand.length; i++) {
      out += s.hand[i].v + (S.sel[i] ? '*' : '') + ',';
    }
    return out;
  }

  /* ================= 画 ================= */

  function render() {
    var s = S.state;
    if (!s) return;

    if (el.code) el.code.textContent = s.code;

    renderLobby();
    renderStrip();
    renderDice();
    renderScore();
    renderTaken();
    renderHint();
    renderBtns();
    renderRest();
    renderHandoff();
    renderRedo();
    renderKick();
  }

  function renderLobby() {
    var s = S.state;
    var on = !s.started;
    if (el.lobby) el.lobby.hidden = !on;
    if (el.dice) el.dice.style.display = on ? 'none' : '';
    /* 还没开局时整块分数区（含提示）都收起来：
       「0 本回合」没有意义，而「人齐了就开始」桌上那张卡已经说清楚了。
       少一块压在底下的灰字，房号才是这一页唯一要看的东西。 */
    if (el.panel) el.panel.style.display = on ? 'none' : '';
    /* 还没开局没什么可重开的，把按钮收起来，顶栏只留房号 */
    if (el.redo) el.redo.hidden = on;
    if (!on) return;

    if (el.roomCode) {
      el.roomCode.textContent = s.code;
      /* 6 位房号按 4 位的字号会顶出桌面，按位数收一档 */
      el.roomCode.style.fontSize = s.code.length > 4 ? '10.4vw' : '';
      el.roomCode.style.letterSpacing = s.code.length > 4 ? '1.4vw' : '';
    }
    var full = s.players.length >= 2;
    if (el.start) {
      /* 谁都能开局：房主要是中途退出，剩下的人不该被卡在「等房主」 */
      el.start.hidden = false;
      el.start.classList.toggle('is-off', !full);
      el.start.textContent = full ? '开始' : '还差 1 个人';
    }
    if (el.lobbySub) {
      el.lobbySub.textContent = (full ? '人齐了 · 谁点都行 · ' : '念给朋友 · ')
        + s.players.length + ' 人在房间里';
    }
  }

  /* 这一轮谁还没轮到、排在最前面的那位。
     服务端下发的 queue 是「本轮出手顺序」，存的还是 players 的下标；
     queue[0] 永远等于当前这一手（锁完一个就把它从队列里摘掉），
     所以从第 2 个往后找，第一个还没锁的就是「下一个」。 */
  function nextIdx(s) {
    var q = s.queue || [];
    for (var k = 1; k < q.length; k++) {
      var cand = q[k];
      var p = s.players[cand];
      if (p && !p.locked) return cand;
    }
    return -1;
  }

  function renderStrip() {
    if (!el.strip) return;
    var s = S.state;
    var nxIdx = s.phase === 'over' ? -1 : nextIdx(s);
    var key = s.players.map(function (p) {
      return p.id + ':' + p.score + ':' + (p.locked ? 1 : 0) + ':' + (p.online ? 1 : 0) +
        ':' + (p.lion || 0) + ':' + (p.rest ? 1 : 0) + ':' + (p.away || '');
    }).join('|') + '#' + s.turn + '#' + s.phase
      /* s.you 也得算进 key：刚进桌那次「哪张是我」是后到的，
         不重画就一直是别人那张亮金边 */
      + '#' + s.you
      /* 队列也得算进 key：谁锁了、谁被跳过都会让「下一个」换人 */
      + '#' + (s.queue || []).join('.')
      /* 本轮的出手顺序（右上角那个 1/2/3）：换一局就整排重画 */
      + '#' + (s.startOrder || []).join('.')
      + '#' + (s.kick ? s.kick.target + ':' + s.kick.yes.length + '/' + s.kick.need : '');

    if (el.strip.getAttribute('data-key') === key) return;
    el.strip.setAttribute('data-key', key);
    el.strip.innerHTML = '';

    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      var div = document.createElement('div');
      /* 点名字能把人请出去（房主直接请，其他人发起投票），所以每张卡都得带着 id */
      var asking = !!(s.kick && s.kick.target === p.id);
      div.className = 'p-card tap'
        + (i === s.turn && s.phase !== 'over' ? ' on' : '')
        + (p.locked ? ' done' : '')
        + (p.online === false ? ' off' : '')
        + (asking ? ' asking' : '')
        /* 下手是谁：深色卡说的是「正在打的是他」，可他后面排着谁，
           以前全桌都得自己数人头（用户 2026-11-12：「桌面没有很好的提示
           下一轮轮到哪个玩家」）。下一个出手的那张卡换成淡蓝色 + 内描边，
           状态灯那行直接写「下一个」—— 那张卡只有 82px 宽，加一整行会把
           整排顶高，只能借用现有的那一行。 */
        + (i === nxIdx ? ' next' : '')
        /* 自己那张：粗金边 + 名字前面挂「我」牌。
           350 以前**一点标记都没有**，只有「轮到谁」的深色卡 ——
           别人轮到时自己的卡和别人的长得一模一样，只能靠念昵称认人。 */
        + (p.id === s.you ? ' me' : '')
        /* 休息的人整张卡换底色：82px 的卡里塞不下新的一行，
           得让同桌的人扫一眼就看出「这张卡不在这一局里」 */
        + (p.rest ? ' is-rest' : '')
        + (!p.rest && p.away === 'rest' ? ' is-rest-wait' : '');
      div.setAttribute('data-pid', p.id);

      var nm = document.createElement('div');
      nm.className = 'p-name';
      if (p.id === s.you) {
        var mt = document.createElement('i');
        mt.className = 'me-tag';
        mt.textContent = '我';
        nm.appendChild(mt);
      }
      /* 昵称单独一层：卡只有 4 列宽，8 个字的昵称得在这儿省略，
         不然会把「我」牌顶出卡外（挂载顺序就是「我」在前、名字在后） */
      var ntx = document.createElement('span');
      ntx.className = 'p-nm';
      ntx.textContent = p.name;
      nm.appendChild(ntx);

      /* 在线状态：绿点 · 在线 / 红点 · 离线。
         以前只有「掉线」那两个字挂在名字后面，还得先认出「没字 = 在线」；
         桌上三个人问「他还在不在」的时候，看一眼颜色比读字快。
         轮到「下一个」的那张，这一行改写字 —— 点还留着，掉线的照样是红点。 */
      var st = document.createElement('div');
      st.className = 'p-stat' + (p.online === false ? ' is-off' : '');
      var dot = document.createElement('i');
      dot.className = 'p-dot';
      st.appendChild(dot);
      /* 休息的状态借这一行写：卡片只有 82px，加一整行会把整排格子顶高。
         四个字刚好放得下，掉线优先说离线。 */
      var restTxt = p.rest ? (p.away === 'rest' ? '休息中' : '下把回来')
        : (p.away === 'rest' ? '下把休息' : '');
      st.appendChild(document.createTextNode(p.online === false ? '离线'
        : (restTxt || (i === nxIdx ? '下一个' : '在线'))));

      var sc = document.createElement('div');
      sc.className = 'p-score';
      /* 本把真休息的人没有分数可写，这一格让给离开时长（每秒自己走） */
      if (p.rest) {
        sc.innerHTML = window.LDAwayClock ? window.LDAwayClock.stamp(p) : '';
      } else {
        sc.textContent = p.locked ? String(p.score) : '—';
      }

      div.appendChild(nm);
      div.appendChild(st);
      div.appendChild(sc);

      /* 右上角：这一轮第几个摇（1 = 本轮第一个摇的人）。
         用户 2026-11-13：「3 个人玩，由第二个人开始摇，那给他标注 1，
         下一个标注 2，最后一个标注 3」。
         深色卡只说得出「现在轮到他」，谁先谁后还得数人头 —— 一个数字就够了。
         序号取服务端下发的 startOrder（本轮开始时的顺序快照）；queue 会随着
         锁分一个个变短，拿它算不出来「已经摇过的我是第几」。
         没开打（大厅）不标：那时候还没有顺序。
         角标绝对定位在右上角，名字那行让出 2.4vw，靠右的省略号就不会被压住。 */
      var ord = (s.startOrder || []).indexOf(p.id) + 1;
      if (ord > 0 && s.started) {
        var od = document.createElement('i');
        od.className = 'p-ord' + (i === nxIdx ? ' is-next' : '')
          + (i === s.turn && s.phase !== 'over' ? ' is-turn' : '');
        od.textContent = String(ord);
        div.appendChild(od);
      }

      if (p.lion) {
        var l = document.createElement('div');
        l.className = 'p-lion';
        l.textContent = '豹子 ×' + p.lion;
        div.appendChild(l);
      }
      /* 有人正在申请请他出去：票数直接写在卡上，不然全桌只有发起人知道 */
      if (s.kick && s.kick.target === p.id) {
        var kk = document.createElement('div');
        kk.className = 'p-kick';
        kk.textContent = '踢出 ' + s.kick.yes.length + '/' + s.kick.need;
        div.appendChild(kk);
      }
      el.strip.appendChild(div);
    }
  }

  function renderDice() {
    var s = S.state;
    if (!el.dice) return;
    var sig = handSig() + '#' + (myTurn() ? 1 : 0) + '#' + s.round;
    if (el.dice.getAttribute('data-key') === sig) return;
    el.dice.setAttribute('data-key', sig);
    el.dice.innerHTML = '';

    var n = s.hand.length;
    var slots = layout(n);
    var canPick = myTurn() && s.phase === 'rolled';

    for (var i = 0; i < n; i++) {
      var it = slots[i], d = s.hand[i];
      var slot = document.createElement('div');
      slot.className = 'die-slot';
      slot.setAttribute('data-i', String(i));
      slot.style.left = rpx(it.l);
      slot.style.top = rpx(it.t);
      slot.style.setProperty('--ds', rpx(it.s));
      slot.style.setProperty('--r', it.r + 'deg');
      slot.style.transform = 'rotate(' + it.r + 'deg) scaleY(0.86)';

      var box = document.createElement('div');
      box.className = 'die' + (d.v ? '' : ' blank');
      box.style.animationDelay = i * 26 + 'ms';

      if (d.v) {
        var cells = PIPS[d.v] || [];
        for (var c = 0; c < cells.length; c++) {
          var pip = document.createElement('div');
          pip.className = 'pip' + (RED[d.v] ? ' red' : '');
          pip.style.left = CELL[cells[c] % 3] + '%';
          pip.style.top = CELL[Math.floor(cells[c] / 3)] + '%';
          box.appendChild(pip);
        }
        if (canPick && pointsOf(d.v)) {
          slot.classList.add('countable');
          if (S.sel[i]) slot.classList.add('sel');
          var tag = document.createElement('i');
          tag.className = 'f3-val';
          tag.textContent = String(pointsOf(d.v));
          slot.appendChild(tag);
        }
      }
      slot.appendChild(box);
      el.dice.appendChild(slot);
    }
  }

  function renderScore() {
    if (!el.scoreNum) return;
    var s = S.state;
    var v = s.round;
    if (el.scoreNum.textContent !== String(v)) {
      el.scoreNum.textContent = String(v);
      el.scoreNum.classList.remove('bump');
      void el.scoreNum.offsetWidth;
      el.scoreNum.classList.add('bump');
    }
    el.score.className = 'f3-score' + (v >= CAP ? ' max' : v >= BASE ? ' ok' : '');
  }

  /* 本回合已经收下的 1 和 5（摆出来才知道分是怎么攒的）。
     和 f350.js 同一套「一排还是两排」的挑法：颗数多时按高度让步，别把桌面挤没。 */
  function renderTaken() {
    var box = el.taken;
    if (!box) return;
    var s = S.state;
    var list = s.taken || [];
    var key = list.length + '/' + s.round;
    if (box.getAttribute('data-key') === key) return;

    var n = list.length;
    var vw = window.innerWidth / 100;
    var room = 0;
    if (n && el.stage) {
      var wasHidden = box.hidden;
      box.hidden = true;
      var stageH = el.stage.clientHeight;
      box.hidden = wasHidden;
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

    var row = null;
    for (var i = 0; i < list.length; i++) {
      if (i % perRow === 0) {
        row = document.createElement('div');
        row.className = 'tk-row';
        box.appendChild(row);
      }
      var v = list[i];
      var w = document.createElement('div');
      w.className = 'tk-die' + (i >= prev ? ' new' : '');
      var d = document.createElement('div');
      d.className = 'die';
      var cells = PIPS[v] || [];
      for (var c = 0; c < cells.length; c++) {
        var pip = document.createElement('div');
        pip.className = 'pip' + (RED[v] ? ' red' : '');
        pip.style.left = CELL[cells[c] % 3] + '%';
        pip.style.top = CELL[Math.floor(cells[c] / 3)] + '%';
        d.appendChild(pip);
      }
      w.appendChild(d);
      row.appendChild(w);
    }
    box.hidden = !list.length;
    box.setAttribute('data-key', key);
    box.setAttribute('data-n', String(n));
  }

  function renderHint() {
    if (!el.hint) return;
    var s = S.state;
    var cls = '';
    var text = '';

    if (!s.started) {
      text = '';
    } else if (s.phase === 'over') {
      text = '一局打完 · 按分数排';
      cls = 'good';
    } else if (s.phase === 'handoff') {
      text = '';
    } else if (!myTurn()) {
      var cur = s.players[s.turn];
      var skNow = canSkip(s);
      if (cur && cur.online === false) {
        /* 掉线的时候谁都能看见，但只有房主能点 —— 说清楚是谁该动手，
           免得桌上三个人轮流去戳一个戳不动的按钮 */
        text = cur.name + ' 掉线了 · ' + (skNow ? '点下面跳过' : '等房主跳过');
        cls = 'warn';
      } else {
        /* 在线的人不催：他可能正在看牌。真接不上手，交接层那边有「跳过」
           （见 renderSkipBtn），不用在这行灰字里先给人扣个帽子 */
        text = '轮到 ' + curName();
      }
    } else if (s.phase === 'rolled') {
      var p = picked();
      if (p.gain) {
        text = '选中 ' + p.idx.length + ' 颗 · 收下 ' + p.gain + ' 分';
        cls = 'good';
      } else if (s.took) {
        text = '不点的留在桌上，接着摇';
      } else {
        text = '点要拿走的 1 和 5 · 不点的留在桌上继续摇';
      }
    } else if (s.phase === 'bust') {
      text = '爆了 · 这一把一分没有，清零重摇';
      cls = 'warn';
    } else if (s.phase === 'lion') {
      text = '七个一样 · 收下就锁分';
      cls = 'gold';
    } else {
      var left = liveCount();
      text = left && left < DICE ? '还剩 ' + left + ' 颗 · 摇一摇' : '摇一摇';
    }

    el.hint.textContent = text;
    el.hint.className = 'f3-hint' + (cls ? ' ' + cls : '');
  }

  function renderBtns() {
    if (!el.btns) return;
    var s = S.state;
    el.btns.innerHTML = '';
    if (!s.started) return;

    var list = [];
    var turn = myTurn();

    if (s.phase === 'over') {
      /* 结算时底栏一个按钮都不放。这里原本有个和「摇一摇」一样大的
         「回联机大厅」，跟卡片里的「再来一局」并排摆着，谁都以为主按钮是回大厅 ——
         一局打完顺手点下去，就真散了。回大厅的路留给左上角那个返回箭头。 */
      return;
    } else if (!turn) {
      /* 轮到一个掉线的人：干等没有意义，房主点一下就能把他这一局跳过。
         在线的就不给这个按钮 —— 他可能正看着牌，凭什么替他把这一手也收了。 */
      var sk = canSkip(s);
      if (sk && sk.off) {
        list.push({ t: '跳过 ' + sk.name, cls: 'primary', act: 'skip' });
      } else {
        list.push({ t: '轮到 ' + curName(), cls: 'primary is-off', act: 'none' });
      }
    } else if (s.phase === 'rolled') {
      var p = picked();
      var left = liveCount();
      if (p.gain) {
        list.push({ t: '收下 ' + p.gain + ' 分', cls: 'primary', act: 'take' });
      } else if (s.took) {
        list.push({
          t: left && left < DICE ? '摇剩下 ' + left + ' 颗' : '摇一摇',
          cls: 'primary', act: 'roll'
        });
      } else {
        list.push({ t: '点骰子收分', cls: 'primary is-off', act: 'none' });
      }
    } else if (s.phase === 'lion') {
      var gain = 0;
      for (var i = 0; i < s.hand.length; i++) if (s.hand[i].v) gain += pointsOf(s.hand[i].v);
      var total = Math.min(CAP, s.round + gain);
      list.push({
        t: total >= BASE ? '收下 ' + total + ' 分' : '不收了 · 接着摇',
        cls: 'primary', act: 'liontake'
      });
      list.push({ t: '清零重摇', cls: 'ghost', act: 'reset' });
    } else if (s.phase === 'bust') {
      list.push({ t: '清零重摇', cls: 'primary', act: 'reset' });
    } else if (s.phase === 'handoff') {
      list.push({ t: '轮到你了', cls: 'primary is-off', act: 'none' });
    } else {
      var lv = liveCount();
      list.push({
        t: lv && lv < DICE ? '摇剩下 ' + lv + ' 颗' : '摇一摇',
        cls: 'primary', act: 'roll'
      });
    }

    if (turn && s.phase !== 'over' && s.phase !== 'bust'
        && s.phase !== 'lion' && s.phase !== 'handoff') {
      var ok = s.round >= BASE;
      list.push({
        t: ok ? '锁 ' + s.round + ' 分' : '满 ' + BASE + ' 锁分',
        cls: 'ghost' + (ok ? '' : ' is-off'),
        act: ok ? 'lock' : 'none'
      });
    }

    for (var k = 0; k < list.length; k++) {
      var b = document.createElement('button');
      b.className = 'btn ' + list[k].cls;
      b.setAttribute('data-act', list[k].act);
      b.textContent = list[k].t;
      if (S.pending && list[k].act !== 'none') b.classList.add('is-wait');
      el.btns.appendChild(b);
    }
  }

  /* 底栏临时休息入口：跟吹牛同一套（默认态点开再选，挂起态一颗实底「点击继续」）。
     单独一步 render，是因为 renderBtns 在结算页会直接 return ——
     而 2 人桌有人休息时恰恰停在结算页，等的就是他这一下「继续」。 */
  function renderRest() {
    if (!el.btns) return;
    var old = el.btns.querySelector('.rest-row');
    if (old) old.parentNode.removeChild(old);
    var s = S.state;
    if (!s || !s.started || !window.LDRest) return;
    var me = null;
    for (var i = 0; i < (s.players || []).length; i++) {
      if (s.players[i].id === s.you) me = s.players[i];
    }
    if (!me) return;

    var on = me.away === 'rest';     // 下一把起休息的意愿
    var live = !!me.rest;            // 本把已经生效
    var h = '';
    if (!on && !live) {
      h = '<button class="rest-link" data-act="restopen">临时休息 · 下一把生效</button>';
    } else if (live && !on) {
      h = '<span class="rest-back">下把回来 · 本把照常打完</span>';
    } else {
      h = '<button class="rest-go" data-act="resume">' +
        (live ? '休息中 · 点击继续' : '下把休息 · 点击取消') + '</button>';
    }
    /* 分母 / 离开时长：按钮下面一行，正常玩家也看得见谁不在这一局里 */
    var info = '';
    if (s.away && s.away.rest) {
      info = '桌上 ' + (s.away.active | 0) + ' 人在玩 · ' +
        (s.away.rest | 0) + ' 人休息不算分母';
    }
    var ck = window.LDAwayClock ? window.LDAwayClock.stamp(me) : '';
    if (ck) info += (info ? '<br>' : '') + ck;
    if (info) h += '<div class="rest-info">' + info + '</div>';
    var box = document.createElement('div');
    box.className = 'rest-row';
    box.innerHTML = h;
    el.btns.appendChild(box);
  }

  /* 结算榜的顺序。抽出来是因为「同分谁排前面」这条规则在真房间里凑不出来
     （得几个人正好锁在同一个分数），但它偏偏是这局唯一有争议的地方 ——
     单独给它一条能直接喂数据进来的口子（window.LDNet.rankRows）。

     350 抓的是分**最低**的那个人：分数是攒着往 350 冲的，冲得最少的背锅。
     同分谁背（用户 2026-11-12 定的）：「第一个 500、第二个 500、第三个 500，
     必须是最后一个拿到一样分数的人为最低分」。所以同分时**后锁的排前面**。
     服务端下发的 order 记的就是「锁分先后」，序号越大越晚，比较时倒过来。 */
  function rankRows(players, order) {
    function at(p) {
      /* 不在 order 里 = 这一局一颗骰子都没锁过（0 分坐到底），按最早处理 */
      return order ? order.lastIndexOf(p.id) : -1;
    }
    /* 本把休息的人不进结算榜（2026-11-14 用户拍板）：他一颗骰子没摇，
       0 分摆进「分最少的背」就是白背一口锅。分数 / 名次留着，下一把回来照旧。 */
    return players.filter(function (p) { return !p.rest; }).slice().sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return at(b) - at(a);
    });
  }

  function renderHandoff() {
    var s = S.state;
    var box = el.handoff;
    if (!box) return;

    if (s.phase !== 'handoff' && s.phase !== 'over') {
      box.hidden = true;
      if (el.rank) el.rank.hidden = true;
      if (el.go) el.go.hidden = false;
      if (el.skip) el.skip.hidden = true;
      return;
    }

    box.hidden = false;
    /* 结算态和交接态挤在同一张卡上，但内容量差一大截：
       结算要多摆一张榜，排法得换（顶对齐 + 榜自己滚，见 net.css 的 .f3-handoff.over） */
    box.classList.toggle('over', s.phase === 'over');

    if (s.phase === 'over') {
      /* 350 抓的是「最低分」的那个人，不是最高分 —— 分数是「攒着往 350 冲」的，
         冲得最少的那个才是这局的输家。所以榜从低到高排，头一行就是被抓住的。
         同分的那几个人谁排最前，见 rankRows 上面那段。 */
      var rows = rankRows(s.players, s.order);

      if (el.hdKicker) el.hdKicker.textContent = '一局打完 · 分最低的背';
      if (el.hdName) el.hdName.textContent = rows.length ? rows[0].name + ' · ' + rows[0].score : '';
      if (el.hdSub) {
        var nr = (s.away && s.away.rest) | 0;
        el.hdSub.textContent = '分最少的排第一 · 同分最后锁上的背' +
          (nr ? ' · ' + nr + ' 人休息，本局不排名' : '');
      }

      if (el.rank) {
        el.rank.hidden = false;
        el.rank.innerHTML = '';
        for (var i = 0; i < rows.length; i++) {
          var r = document.createElement('div');
          r.className = 'ng-rank-row' + (i === 0 ? ' top' : '');
          var nm = document.createElement('b');
          nm.textContent = (i + 1) + '. ' + rows[i].name;
          var sc = document.createElement('span');
          sc.textContent = rows[i].score + ' 分';
          var lk = document.createElement('i');
          lk.textContent = rows[i].lion ? ' 豹子×' + rows[i].lion : '';
          r.appendChild(nm);
          r.appendChild(sc);
          r.appendChild(lk);
          el.rank.appendChild(r);
        }
        /* 人多放不下时，最后一行正好卡在卡片边上被切一半，看着像排版坏了 ——
           底部加个渐隐，让人知道这一段是能滚的（只在这种时候加，
           三个人还加就成了最后一名看不清）。读 scrollHeight 会强制一次布局，
           只在结算这一屏做，一次而已。 */
        el.rank.classList.toggle('is-scroll',
          el.rank.scrollHeight > el.rank.clientHeight + 1);
      }

      if (el.go) {
        /* 一局已经打完，分数落定了，谁点都能接着开 —— 这里不投票。
           要投票的是打到一半按「重开」，那才是真的会把牌吞掉。 */
        el.go.hidden = false;
        el.go.classList.remove('is-off');
        el.go.textContent = '再来一局';
      }
      if (el.skip) el.skip.hidden = true;
      return;
    }

    /* 交接：锁完分、下一位真正接手之前，先把桌面盖住 */
    if (el.rank) el.rank.hidden = true;
    if (el.go) {
      el.go.hidden = false;
      el.go.textContent = myTurn() ? '我来了 · 摇' : '等 ' + curName() + ' 接手';
      el.go.classList.toggle('is-off', !myTurn());
    }
    if (el.hdKicker) el.hdKicker.textContent = '轮到';
    if (el.hdName) el.hdName.textContent = curName();
    if (el.hdSub) {
      var rest = 0;
      for (var j = 0; j < s.players.length; j++) if (!s.players[j].locked) rest++;
      el.hdSub.textContent = '还剩 ' + rest + ' 位没锁';
    }
    renderSkipBtn(s);
  }

  /* ================= 操作 ================= */

  function act(a) {
    var s = S.state;
    if (!s) return;
    if (a === 'none') return;
    if (a === 'exit') { goLobby(); return; }

    if (a === 'roll') {
      /* 声音和震动跟着手指走，不等服务器 —— 摇骰这一下要有反馈，
         等 100ms 回包再响就「慢半拍」，比没声音更怪。 */
      playShake();
      vibrate(18);
      shake();
      send({ t: 'roll' }, 'roll');
      return;
    }
    if (a === 'take') {
      var p = picked();
      if (!p.gain) { toast('先点一颗 1 或 5'); return; }
      vibrate(8);
      send({ t: 'take', idx: p.idx }, 'take');
      return;
    }
    if (a === 'lock') { vibrate(24); send({ t: 'lock' }, 'lock'); return; }
    if (a === 'skip') { vibrate(14); send({ t: 'skip' }, 'skip'); return; }
    /* 再来一局：一局已经打完，点一下就走。
       重开：打到一半才要全桌三分之二点头（投过了再点就是撤回）；
       结算之后按重开等于开下一局，也不用投。 */
    if (a === 'again' || (a === 'restart' && s.phase === 'over')) {
      vibrate(12);
      send({ t: a }, a);
      return;
    }
    if (a === 'restart') {
      var vv = voteNow(s);
      if (vv && vv.mine) {
        vibrate(8);
        send({ t: 'unvote' }, 'unvote');
        toast('撤回了，要重开再点一下');
        return;
      }
      vibrate(12);
      send({ t: 'restart' }, 'restart');
      return;
    }
    if (a === 'liontake') { send({ t: 'lionTake' }, 'liontake'); return; }
    /* 临时休息：默认态点开选择卡防误触；挂起态那颗「点击继续」直接发一条 */
    if (a === 'restopen') {
      if (window.LDRest) window.LDRest.open({
        ok: function (k) { send({ t: k === 'rest' ? 'rest' : 'resume' }, 'rest'); }
      });
      return;
    }
    if (a === 'resume') { vibrate(12); send({ t: 'resume' }, 'rest'); return; }
    if (a === 'reset') { send({ t: 'reset' }, 'reset'); return; }
    if (a === 'go') { send({ t: 'go' }, 'go'); return; }
    if (a === 'start') { send({ t: 'start' }, 'start'); return; }
  }

  function shake() {
    if (!el.dice) return;
    el.dice.classList.remove('shaking');
    void el.dice.offsetWidth;
    el.dice.classList.add('shaking');
    clearTimeout(S.shakeTimer);
    S.shakeTimer = setTimeout(function () {
      if (el.dice) el.dice.classList.remove('shaking');
    }, 480);
  }

  function onDieTap(e) {
    var s = S.state;
    if (!s || s.phase !== 'rolled' || !myTurn()) return;
    var t = e.target;
    while (t && t !== el.dice && !t.getAttribute('data-i')) t = t.parentNode;
    if (!t || t === el.dice) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    var d = s.hand[i];
    if (!d || !pointsOf(d.v)) return;

    /* 连点两下同一颗 = 选中它并立刻收下。单机那边一直是这么玩的
       （f350.js 的 onDieTap），联机少了这一步，桌上一半人点两下没反应，
       只能老老实实「点骰子 → 再按底下的收下」，手指头都觉得冤。
       320ms 和单机同一个阈值，手感不分两套。 */
    var now = Date.now();
    var dbl = (S.lastTapIdx === i && now - S.lastTapAt < 320);
    S.lastTapIdx = i;
    S.lastTapAt = now;

    if (dbl) {
      S.sel[i] = true;              // 双击一定把点到的这颗算进去
      vibrate(10);
      render();
      act('take');
      return;
    }

    if (S.sel[i]) delete S.sel[i];
    else S.sel[i] = true;
    vibrate(10);
    render();
  }

  /* ================= 大厅 ================= */

  function tip(msg, ok) {
    var t = $('netTip');
    if (!t) return;
    t.textContent = msg || '';
    /* 跟「找朋友 · 联机」那一屏同一个 .fn-tip：靠 .show 淡入淡出，
       空着的时候不占一条线的注意力 */
    t.className = 'fn-tip' + (msg ? ' show' : '') + (ok ? ' ok' : '');
  }

  function open() {
    tip('');
    var code = $('netCode');
    if (code) code.value = '';
    /* 这一屏跟另外两个玩法的入口长得一样，也得一样会说话：
       把「以谁的身份进房」写出来，人在这一页就知道自己是「胖虎」 */
    var who = $('netWhoName');
    if (who) who.textContent = myName();
    /* 提前把 DNS / TLS 打个照面：进房那一刻直接建 WS，少一次握手的停顿 */
    try {
      fetch(S.api + '/health', { cache: 'no-store', mode: 'cors' }).catch(function () {});
    } catch (e) {}
    refreshResume();
  }

  /* 大厅顶部「上一桌还没打完」那张条。
     本地只记房号，房间是死是活要现场问一句 —— 大家散场之后房间会被回收，
     摆一个点进去是空桌的入口，比不摆更让人恼火。
     问不到 / 房间没了就把记录一起删掉，下次不再惦记。 */
  function refreshResume() {
    var box = $('netResume');
    if (!box) return;
    var last = lastRoom();
    if (!last) { box.hidden = true; return; }
    box.hidden = true;                    // 先收着，确认房间还在再露出来，免得闪一下
    fetch(S.api + '/api/has?code=' + last.code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.room) { clearLast(); return; }
        var c = $('netResumeCode'), sub = $('netResumeSub');
        var n = j.room.n | 0;
        if (c) c.textContent = last.code;
        if (sub) {
          if (j.room.phase === 'over') sub.textContent = '上一局打完了 · 回去再来一局';
          else if (j.room.started) sub.textContent = '局还在打 · 点一下回原位';
          else sub.textContent = n > 1 ? n + ' 人在等开局' : '房间还在 · 点一下进去';
        }
        box.hidden = false;
      })
      .catch(function () { box.hidden = true; });
  }

  function goLobby() {
    leave();
    if (window.F350 && window.F350.switchTo) window.F350.switchTo('net');
    else if (location.hash !== '#net') location.hash = 'net';
    tip('');
    /* 从桌上退下来的这一刻，才最需要那条「上一桌还没打完」——
       不刷一下，人就只能看见「开一个房间 / 加入房间」，还得自己背房号 */
    refreshResume();
  }

  /* ---------------- 主动退出这一桌 ----------------

     goLobby() 是「暂时离开」：关连接、留座位，首页还会摆「上一桌还没打完」。
     这颗「退出」要真离座：先发 {t:'quit'}，服务端摘人后回 quitok，
     本地把座位 token 与房号一起清掉，再走 goLobby 收线切页。 */
  function finishQuit() {
    if (!S.quitting) return;
    S.quitting = false;
    clearTimeout(S.quitTimer);
    var code = S.code;
    if (code) { try { localStorage.removeItem(seatKey(code)); } catch (e) {} }
    clearLast();
    goLobby();
  }

  function quitRoom() {
    if (S.quitting) return;
    if (!S.code) { goLobby(); return; }
    S.quitting = true;
    if (!send({ t: 'quit' })) { finishQuit(); return; }
    S.quitTimer = setTimeout(finishQuit, 900);
  }

  function enterRoom(code) {
    S.code = code;
    S.state = null;
    S.you = null;
    S.token = '';
    S.sel = {};
    S.handSig = '';
    S.pending = '';

    cache();
    if (window.F350 && window.F350.switchTo) window.F350.switchTo('netgame');
    else location.hash = 'netgame';

    /* 先摆个空桌 + 房号，别让人对着一张白屏等握手 */
    if (el.code) el.code.textContent = code;
    if (el.roomCode) el.roomCode.textContent = code;
    /* 清空 DOM 的同时必须把 data-key 一起摘掉：
       那两个函数靠「签名没变就直接 return」省重绘，DOM 被清空了签名却还留着，
       回来后第一帧就被判定成「跟上次一样」直接跳过 —— 桌上于是七颗骰子一颗都不画，
       手里明明有牌、底栏却写着「点骰子收分」，点哪儿都没反应。 */
    if (el.strip) { el.strip.innerHTML = ''; el.strip.removeAttribute('data-key'); }
    if (el.dice) { el.dice.innerHTML = ''; el.dice.removeAttribute('data-key'); }
    if (el.taken) { el.taken.innerHTML = ''; el.taken.removeAttribute('data-key'); }
    if (el.scoreNum) el.scoreNum.textContent = '0';
    if (el.btns) el.btns.innerHTML = '';
    if (el.hint) el.hint.textContent = '';
    if (el.panel) el.panel.style.display = 'none';
    if (el.lobbySub) el.lobbySub.textContent = '正在连房间…';
    if (el.lobby) el.lobby.hidden = false;

    connect();
  }

  function createRoom() {
    if (!S.api || S.connecting) return;
    tip('正在开房…');
    fetch(S.api + '/api/new', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { tip((j && j.msg) || '开房失败，再试一次'); return; }
        tip('');
        enterRoom(j.code);
      })
      .catch(function () { tip('连不上服务器 · 检查一下网络'); });
  }

  function joinRoom() {
    var inp = $('netCode');
    var code = (inp && inp.value || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 4 && code.length !== 6) { tip('房号是 4 位数字'); return; }
    tip('正在找这个房间…');
    fetch(S.api + '/api/has?code=' + code, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { tip((j && j.why) || '房号不对'); return; }
        if (!j.room) { tip('没有这个房间 · 房号念对了吗'); return; }
        tip('');
        enterRoom(code);
      })
      .catch(function () { tip('连不上服务器 · 检查一下网络'); });
  }

  /* ================= 断线提示 / 吐司 ================= */

  function showOff(on) {
    if (!el.stage) return;
    if (!el.off) {
      el.off = document.createElement('div');
      el.off.className = 'ng-off';
      el.off.hidden = true;
      el.off.textContent = '连接断了 · 正在重连';
      el.stage.appendChild(el.off);
    }
    el.off.hidden = !on;
  }

  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(S.tt);
    S.tt = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  /* 座位卡**双击**才算数（2026-11-13 用户：「点击就弹出，可能会误触，改为双击」）。

     牌桌上手指一直在动 —— 递手机、指屏、碰一下杯沿，单击弹一个「把他请出去」
     很容易点错人。这里只在 600ms 内点同一张卡时才认；第一下只回一句提示，
     让人知道「再点一下就行」，不至于以为没反应。 */
  var tapAt = 0, tapKey = '';
  function dblTap(key) {
    var now = Date.now();
    if (tapKey === key && now - tapAt < 600) { tapAt = 0; tapKey = ''; return true; }
    tapAt = now; tapKey = key;
    return false;
  }

  /* ================= 启动 ================= */

  function boot() {
    var q = (location.search.match(/[?&]net=([^&]+)/) || [])[1];
    if (q) {
      try { S.api = decodeURIComponent(q).replace(/\/+$/, ''); } catch (e) {}
    } else if (window.LD_NET_BASE) {
      S.api = String(window.LD_NET_BASE).replace(/\/+$/, '');
    } else if (location.hostname === HOME_HOST) {
      S.api = location.origin;
    }

    cache();

    /* 音效开关：顶栏那颗 🔊 由 snd.js 统一绑（五颗一个写法），
       这里只把图标按当前状态画一遍。
       第一次碰屏幕先哑播一下，把 iOS / 微信的音频解锁掉 —— 只解一次。 */
    if (window.LDSnd) window.LDSnd.sync();

    var unlocked = false;
    function unlockOnce() {
      if (unlocked) return;
      unlocked = true;
      unlockSnd();
      document.removeEventListener('touchstart', unlockOnce, true);
      document.removeEventListener('mousedown', unlockOnce, true);
    }
    document.addEventListener('touchstart', unlockOnce, true);
    document.addEventListener('mousedown', unlockOnce, true);

    var back = $('netBack');
    if (back) back.addEventListener('click', function () {
      /* 往上一层退是「选联机玩法」，不是直接回首页：
         以后这里有别的联机玩法，一次返回就把人扔回首页太粗暴 */
      if (window.F350 && window.F350.switchTo) window.F350.switchTo('netmodes');
      else location.hash = 'netmodes';
    });

    var c = $('netCreate');
    if (c) c.addEventListener('click', createRoom);

    /* 「回到上一桌」：座位上还有自己的位置，服务器凭 token 认人，直接回原位 */
    var rs = $('netResume');
    if (rs) rs.addEventListener('click', function () {
      var last = lastRoom();
      if (!last) { rs.hidden = true; return; }
      enterRoom(last.code);
    });

    /* 房号输入框现在是常驻的（跟另外两个玩法的入口同一套排版），
       以前那个「点开才展开」的折叠块已经删了，这里不用再绑它 */

    var go = $('netGo');
    if (go) go.addEventListener('click', joinRoom);

    var inp = $('netCode');
    if (inp) {
      inp.addEventListener('input', function () {
        /* 只收数字：房间号是纯数字，粘进来带空格或字母直接滤掉 */
        var v = inp.value.replace(/\D/g, '').slice(0, 6);
        if (v !== inp.value) inp.value = v;
        tip('');
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) { inp.blur(); joinRoom(); }
      });
    }

    var ngBack = $('ngBack');
    if (ngBack) ngBack.addEventListener('click', goLobby);

    var rd = $('ngRedo');
    if (rd) rd.addEventListener('click', function () {
      /* 一下就是投一票，不再有「确定？」那一步 ——
         真正的确认是「全桌三分之二都点了」，一个人点两下没有意义 */
      vibrate(10);
      act('restart');
    });

    var st = $('ngStart');
    if (st) st.addEventListener('click', function () { act('start'); });

    if (el.dice) el.dice.addEventListener('click', onDieTap);

    /* 玩家条：双击自己 = 改名字，双击别人 = 聊谁该出去。
       单击只回一句「再点一下」，点错人不会立刻弹出把人请走的浮卡。
       委托在容器上，卡片每次重画都不用重新绑 */
    if (el.strip) el.strip.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t !== el.strip && !t.getAttribute('data-pid')) t = t.parentNode;
      if (!t || t === el.strip) return;
      var pid = t.getAttribute('data-pid');
      var mine = pid === (S.state && S.state.you);
      if (!dblTap(pid)) { toast('再点一下 · ' + (mine ? '改名字' : '请人出去')); return; }
      if (mine) { openRename(); return; }
      openKick(pid);
    });

    if (el.kickOk) el.kickOk.addEventListener('click', kickOk);
    if (el.kickNo) el.kickNo.addEventListener('click', closeKick);
    if (el.kick) el.kick.addEventListener('click', function (ev) {
      if (ev.target === el.kick) closeKick();     // 点背板 = 算了
    });

    /* 本局记录：页脚那颗 + 弹层本身 */
    if (el.logBtn) el.logBtn.addEventListener('click', openLog);
    if (el.logX) el.logX.addEventListener('click', closeLog);
    if (el.logMask) el.logMask.addEventListener('click', function (ev) {
      if (ev.target === el.logMask) closeLog();   // 点背板 = 收起
    });

    if (el.btns) el.btns.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== el.btns && !t.getAttribute('data-act')) t = t.parentNode;
      if (!t || t === el.btns) return;
      act(t.getAttribute('data-act'));
    });

    if (el.go) el.go.addEventListener('click', function () {
      if (!S.state) return;
      act(S.state.phase === 'over' ? 'again' : 'go');
    });

    if (el.skip) el.skip.addEventListener('click', function () {
      if (!el.skip.classList.contains('on')) return;   // 还没到点，别让人白点
      act('skip');
    });

    var rg = $('ngRule');
    if (rg) rg.addEventListener('click', function () {
      /* 直接开联机那份（'net'），不要再借单机那张按钮：
         单机写法里「点右上角 N 人改人数」「重开连点两下」，联机一条都不成立 ——
         照着读的人会去右上角找那个按钮（2026-11-10 用户：「联机版的玩法说明呢」）。 */
      if (window.F350 && window.F350.rules) { window.F350.rules('net'); return; }
      var rb = $('ruleBtn2');
      if (rb) rb.click();
    });

    /* 分享链接 /?room=1234&g=350：别人点开就直接进那一桌。
       留 300ms 让 f350.js 先把首页摆好，再切页，否则切过去又被打回来。
       进过就把 ?room= 从地址栏擦掉：不然之后每次刷新页面都往那一桌钻，
       人还以为「这 App 只会回这一个房间」。

    var room = (location.search.match(/[?&]room=(\d{4}|\d{6})/) || [])[1];
    if (room) {
      var rc = $('netCode');
      if (rc) rc.value = room;
      try {
        if (history.replaceState) {
          history.replaceState(null, '', location.pathname + (location.hash || ''));
        }
      } catch (e) {}
      setTimeout(function () {
        if (window.F350 && window.F350.switchTo) window.F350.switchTo('net');
        joinRoom();
      }, 300);
    }

    /* 切回前台时如果连接已经断了，立刻重连，不等 4 秒退避 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (!S.alive) return;
      if (!S.ws && !S.retryTimer) connect();
      else if (!S.ws) connect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.LDNet = {
    open: open,
    leave: leave,
    goLobby: goLobby,
    quit: quitRoom,
    /* 给自动化测试用：能读当前桌面，也能直接发一条协议 */
    state: function () { return S.state; },
    /* 结算榜的排序规则单独露出来：同分谁背这条没法在真房间里凑
       （要几个人正好锁在同一个分数），只能直接喂数据问它 */
    rankRows: rankRows,
    /* 拿一份造出来的桌面直接画一遍：结算屏、「下一个」这些状态
       真房间要么凑不出来、要么得打半天，验收脚本靠它看真样式 */
    paint: function (st) { S.state = st; render(); },
    send: function (o) { return send(o); }
  };
})();

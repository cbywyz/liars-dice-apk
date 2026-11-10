/* ================= 全站共用提示音 =================
   摇骰那一下用的是真音频（assets/audio/shake.mp3，掷骰的沙沙声，
   合成不出来也没必要合成）。其它几个提示音 —— 换人、豹子、爆点、
   开盖、喝 —— 都是「一句话就说完」的短音，这里用 Web Audio 现场合成：

     · 不用往包里再塞四五个 mp3，纯净版和完整版都不会因为多文件而对不上
     · 不用管它们有没有进 sw 缓存（合成音没有网络这一环）
     · 音量、长短都在一处调，五个玩法听起来才是同一套声音

   iOS / 微信的规矩跟 <audio> 一样：AudioContext 必须在用户手势里创建或恢复，
   否则后面任何一次出声都会被静默吞掉（表现就是「安卓有声、iPhone 没声」）。
   所以这里自己挂一次性监听（捕获阶段），
   第一次落到屏幕上的触摸/点击/按键就把通道打开，哪个页面都算数。

   用法：
     LDSnd.cue('pass')            —— 换人
     LDSnd.cue('lion')            —— 豹子 / 11 正豹
     LDSnd.cue('bust')            —— 爆点
     LDSnd.cue('open')            —— 开盖
     LDSnd.cue('drink')           —— 有人喝 / 结算
   传了不认识的 name 就什么都不做（不会报错，调用点不用防御）。

   ================= 音效总开关（全站一份）=================
   五个玩法页各有一颗 🔊：吹牛、350 单机、找朋友单机、350 联机、找朋友联机。
   以前前两个各记各的（吹牛存内存、350 联机存 ld_net_sound），
   在 350 里关掉、切到找朋友又响起来，看起来就像「这个开关是假的」。

   现在开关只有一个，写在 localStorage['ld_sound']：
     · 谁被点都走 LDSnd.setOn()，页面上所有 .sound-btn 一起变图标
     · cue() 自己先判开关 —— 调用点不用每处再写一遍 if
     · 各玩法那颗 shake.mp3 用 isOn() 判（音频元素在各自模块里，
       音效模块管不到，但状态还是这一份）
   老版本只写过 ld_net_sound，第一次升级上来先把它读过来：
   之前特意关过声音的人，不该因为换了版本又突然被吵一下。
*/
(function () {
  var ctx = null;

  /* ---------------- 总开关 ---------------- */

  var SKEY = 'ld_sound';

  function readOn() {
    try {
      var v = localStorage.getItem(SKEY);
      if (v === '0') return false;
      if (v === '1') return true;
      /* 没写过（老版本装上来的第一把）：沿用联机 350 那份旧记录 */
      return localStorage.getItem('ld_net_sound') !== '0';
    } catch (e) { return true; }
  }

  var on = readOn();

  /* 把状态画到所有 🔊 上，顺手给还没绑过的按钮绑一次点击。
     用 querySelectorAll 而不是逐个 id：以后再加玩法页，
     只要写一个 .sound-btn 进来就自动生效，不必回来改这里。 */
  function paint() {
    var bs = document.querySelectorAll('.sound-btn');
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var ic = b.querySelector('.sound-ic');
      if (ic) ic.textContent = on ? '🔊' : '🔇';
      if (b.__ldSndBound) continue;
      b.__ldSndBound = 1;
      b.addEventListener('click', function (e) {
        /* 顶栏的按钮有时候套在可点的容器里，别让这一下再冒上去 */
        if (e && e.stopPropagation) e.stopPropagation();
        window.LDSnd.setOn(!on);
        /* 开着的时候震一下（跟原来联机 350 那颗一样的力道）；
           关掉就别震了 —— 关了声音还在手里嗡一下，容易以为没关掉 */
        try { if (on && navigator.vibrate) navigator.vibrate(14); } catch (err) {}
      });
    }
  }

  function AC() {
    var C = window.AudioContext || window.webkitAudioContext;
    return C ? new C() : null;
  }

  function get() {
    if (ctx) return ctx;
    try { ctx = AC(); } catch (e) { ctx = null; }
    return ctx;
  }

  /* 一个音：起音 12ms → 指数衰减到几乎听不见。
     线性斜坡收尾会有「啪」的电平跳变，指数衰减听起来才像敲了一下。 */
  function tone(c, o) {
    var t = c.currentTime + (o.at || 0);
    var f = o.f, d = o.d || 0.12;
    try {
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.v || 0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t);
      osc.stop(t + d + 0.03);
    } catch (e) { /* 合成失败也不能影响牌局 */ }
  }

  /* 每个 cue 是一串「在什么音、多长、多响、什么时候接着响」。
     音量统一压在 0.1~0.18：一桌十来台手机同时响，再大就吵人了。 */
  var CUES = {
    /* 换人：两个音往上走，像「该你了」。柔一点，一局里会响好几次。 */
    pass: [
      { f: 659, d: 0.10, v: 0.13 },
      { f: 880, d: 0.17, v: 0.11, at: 0.085 }
    ],
    /* 豹子 / 11 正豹：三连上行，是这一桌最值得抬头的一下 */
    lion: [
      { f: 740, d: 0.09, v: 0.15 },
      { f: 988, d: 0.09, v: 0.15, at: 0.075 },
      { f: 1319, d: 0.24, v: 0.13, at: 0.15 }
    ],
    /* 爆点：低频两下闷响（三角波，比正弦厚一点，但不至于像警报） */
    bust: [
      { f: 190, f2: 92, d: 0.17, v: 0.19, type: 'triangle' },
      { f: 150, f2: 74, d: 0.22, v: 0.15, type: 'triangle', at: 0.11 }
    ],
    /* 开盖：一声短「哒」。方波太尖，用三角波加个下滑。 */
    open: [
      { f: 1180, f2: 620, d: 0.06, v: 0.10, type: 'triangle' }
    ],
    /* 喝 / 结算：一个往下掉的滑音，听感就是「完了」 */
    drink: [
      { f: 430, f2: 176, d: 0.30, v: 0.15, type: 'triangle' }
    ]
  };

  window.LDSnd = {
    /* 在手势里调一次：创建 / 恢复 AudioContext，再用一个 0 增益的极短音
       把输出通道真的打开（iOS 上光 resume 有时还不够）。 */
    unlock: function () {
      var c = get();
      if (!c) return;
      try {
        if (c.state === 'suspended' && c.resume) c.resume();
        var g = c.createGain();
        g.gain.value = 0.0001;
        g.connect(c.destination);
        var o = c.createOscillator();
        o.frequency.value = 440;
        o.connect(g);
        o.start();
        o.stop(c.currentTime + 0.03);
      } catch (e) {}
    },
    cue: function (name) {
      /* 关了声音就一声都不出 —— 包括换人、豹子、结算这些「顺手响一下」的。
         这几声最容易漏，才特意收在这里判，而不是靠每个调用点自觉。 */
      if (!on) return;
      var c = get();
      var list = CUES[name];
      if (!c || !list) return;
      try {
        /* 有些机型从后台切回来会自己 suspend：这里顺手拉一把 */
        if (c.state === 'suspended' && c.resume) c.resume();
      } catch (e) {}
      for (var i = 0; i < list.length; i++) tone(c, list[i]);
    },

    /* 开关：各玩法只管问 isOn()，别再自己存一份 */
    isOn: function () { return on; },
    setOn: function (v) {
      on = !!v;
      try { localStorage.setItem(SKEY, on ? '1' : '0'); } catch (e) {}
      paint();
      /* 页面里除了顶栏那颗 🔊，可能还有别的音效开关（吹牛设置面板的拨杆）。
         用一个事件通知出去，免得它们显示的还是老状态。 */
      try {
        window.dispatchEvent(new CustomEvent('ldsound', { detail: { on: on } }));
      } catch (e) {}
      return on;
    },
    toggle: function () { return window.LDSnd.setOn(!on); },
    /* 顶栏换了 / 新插进来一颗按钮时调一下 */
    sync: paint
  };

  /* 脚本在 body 末尾加载，此时五颗按钮都已经在文档里了；
     DOMContentLoaded 再补一次是给「脚本被挪到前面」留的余量。 */
  paint();
  document.addEventListener('DOMContentLoaded', paint);

  /* 一次性解锁：捕获阶段，先于页面自己的点击逻辑跑。
     用三个事件是因为 iOS 只认 touchstart，桌面调试只发 mousedown，
     键盘/遥控器还可能是 keydown。 */
  var swung = false;
  function once() {
    if (swung) return;
    swung = true;
    window.LDSnd.unlock();
  }
  document.addEventListener('touchstart', once, true);
  document.addEventListener('mousedown', once, true);
  document.addEventListener('keydown', once, true);
})();

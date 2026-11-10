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
*/
(function () {
  var ctx = null;

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
      var c = get();
      var list = CUES[name];
      if (!c || !list) return;
      try {
        /* 有些机型从后台切回来会自己 suspend：这里顺手拉一把 */
        if (c.state === 'suspended' && c.resume) c.resume();
      } catch (e) {}
      for (var i = 0; i < list.length; i++) tone(c, list[i]);
    }
  };

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

/* 木塞（木虱）—— 潮汕扑克罚酒玩法，第五个玩法。

   规则由用户（潮汕本地玩家）2026-11-19 逐条口述确认，见 docs/play-muse.md v1.0。
   判定放最上面、只碰纯数据：_real/unit-muse.mjs 会把这一段切出来单独跑。

   ★ 两套维度，别混：
     · rankOf  = 牌型大小序，只用来比"谁赢"
     · baseMult / finalMult = 罚酒倍率，只在结算时用
     网上把这两套混着写（天公排位高却只有 1~2 倍），这里明确拆开。

   牌表示：普通牌 {r:1..13, s:0..3}（r:A=1,2..10,J=11,Q=12,K=13；s:0红桃1方块2梅花3黑桃）
           大鬼 {r:0,s:'BJ'}（红） 小鬼 {r:0,s:'SJ'}（黑） 白牌 {r:0,s:'W'}（无色，第三鬼）
   点数：J/Q/K=0，A=1，2..10=面值；相加取个位，9 最大 0 最小。
   鬼：大王红、小王黑、白牌无色；鬼可当万能牌补顺子/同花/三条。

   [设计决策] 标 D 的地方是口述规则未覆盖的组合，按最合理方式实现并集中成常量，playtest 一句话可改。 */

(function () {
  'use strict';

  /* ================= 判定（纯函数） ================= */

  var MIN_P = 2;
  var MAX_P = 12;

  function isJoker(c) { return !!c && c.r === 0; }
  function isWhite(c) { return !!c && c.r === 0 && c.s === 'W'; }

  /* 单张点数：鬼=0、JQK=0、A=1、2..10=面值 */
  function pointOf(c) {
    if (!c || c.r === 0) return 0;
    if (c.r >= 11) return 0;
    return c.r;
  }

  /* 手牌点数相加的个位（0..9）。
     ★ 鬼是万能点数：补到让个位最大（=9）。第4局三家都是 9 点应全平；
       第5局带鬼那家补到 9 点应赢。鬼总能补出任意个位，所以含鬼一律按 9。 */
  function unitDigit(hand) {
    var base = 0, i, hasJoker = false;
    for (i = 0; i < hand.length; i++) {
      if (isJoker(hand[i])) hasJoker = true;
      else base += pointOf(hand[i]);
    }
    if (hasJoker) return 9;
    return ((base % 10) + 10) % 10;
  }

  /* 一张牌的颜色：0红 1黑 2无色（白牌）。鬼按大王红/小王黑。 */
  function colorOf(c) {
    if (c.r === 0) {
      if (c.s === 'BJ') return 0;
      if (c.s === 'SJ') return 1;
      return 2;               // 白牌无色
    }
    return (c.s === 0 || c.s === 1) ? 0 : 1;
  }

  /* 这手牌能否算"同花"（v1.24.84 起，用户 2026-11-24 确认）：
     普通牌花色统一就算同花；大小鬼和白牌都当万能牌，不限颜色。
     即「红7红8 + 任意鬼」= 同花，点数成顺就是同花顺。鬼本身不算花色。 */
  function sameSuitInfo(hand) {
    if (!hand || (hand.length !== 2 && hand.length !== 3)) return { same: false, n: hand ? hand.length : 0 };
    var suits = {};
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      if (!isJoker(c)) suits[c.s] = true;   // 鬼（含白牌）万能，不限颜色
    }
    var keys = Object.keys(suits);
    if (keys.length === 0) return { same: false, n: hand.length };    // 全是鬼，走鬼牌型不谈同花
    if (keys.length > 1) return { same: false, n: hand.length };      // 普通牌花色不一致，鬼救不回来
    return { same: true, n: hand.length };
  }

  /* 花色加成：杂花=1，两张同花=2，三张同花=3。用户确认的统一公式第一层。 */
  function suitBonus(hand) {
    var info = sameSuitInfo(hand);
    return info.same ? info.n : 1;
  }

  /* ★ 对子加成（用户 2026-11-20 实机图6「对8 应该是两倍 可以收2」）：
     只认「两张手牌且两张点数相同、都不带鬼」= 2 倍；三张含对不加成（不干扰三条/顺子）。
     图6 的 8♦+8♣ 杂花，花色倍率=1，但对子=2 → 收 2。 */
  function pairBonus(hand) {
    if (!hand || hand.length !== 2) return 1;
    var a = hand[0], b = hand[1];
    if (!a || !b || a.r === 0 || b.r === 0) return 1;   // 鬼不算对子
    return a.r === b.r ? 2 : 1;
  }

  /* 天公是否「双倍」（用户 2026-11-20 纠正，不是一律 2 倍）：
     · 对子天公（两张点数相同，如 4♦4♣=8、9♠9♥=18→8）→ 2 倍
     · 同花天公（两张花色相同，如 3♦5♦=8）→ 2 倍
     · 杂花且非对子（如 3♦5♣=8）→ 1 倍
     带鬼不判天公，这里保险返回 false。 */
  function tiangongDouble(hand) {
    if (!hand || hand.length !== 2) return false;
    var a = hand[0], b = hand[1];
    if (isJoker(a) || isJoker(b)) return false;
    var pair = (a.r === b.r);             // 对子
    var flush = suitBonus(hand) >= 2;     // 同花
    return pair || flush;
  }

  /* 三张普通牌是否顺子（rs 已升序；A=1）。两种顺：
       ① A-2-3(1,2,3) 到 J-Q-K(11,12,13) 的递增串；
       ② Q-K-A：A 当 14 接 K，排序后是 [1,12,13]（用户 2026-11-20 确认 Q+鬼+A 补 K 算顺子）。
     鬼不在其中，另由下面的枚举处理。 */
  function isStraight3(rs) {
    if (rs.length !== 3) return false;
    var a = rs[0], b = rs[1], c = rs[2];
    if (b === a + 1 && c === b + 1 && a >= 1 && a <= 11) return true;
    return a === 1 && b === 12 && c === 13;                  // Q-K-A（A=14）
  }
  function isThreeKind(rs) { return rs.length === 3 && rs[0] === rs[1] && rs[1] === rs[2]; }

  /* 牌型类别（不含大小、不含倍率）：
       tripleJoker 三鬼 / doubleJoker 双鬼 / threeKind 三条 / straightFlush 同花顺
       straight 顺子 / tiangong 天公(两张8或9) / muse 木塞(个位0) / normal 普通
     鬼当万能牌：单鬼时枚举它能补成的普通牌，取能凑出的最强牌型。 */
  function kindOf(hand) {
    if (!hand || (hand.length !== 2 && hand.length !== 3)) return 'normal';
    var jn = 0, i;
    for (i = 0; i < hand.length; i++) if (isJoker(hand[i])) jn++;
    if (jn >= 3) return 'tripleJoker';
    /* ★ 鬼鬼X：两张鬼 + 任意一张普通牌，8 倍。按「手牌张数」区分鬼牌型：
       · 三张全是鬼 → tripleJoker（30 倍），上面已返回
       · 两张牌都是鬼 → doubleJoker（双鬼，10 倍）
       · 两张鬼 + 一张普通牌 → joker5（鬼鬼X，8 倍；X 是那张普通牌的点数）
       用户 2026-11-20 图2 纠正：「鬼鬼9 不是 10 倍是 8 倍」——以前只认点数=5 是鬼鬼5，
       其它点数的两鬼+普通牌被当成双鬼 10 倍，错了。现在只要「两鬼+一普通牌」就是鬼鬼X。 */
    if (jn === 2) {
      if (hand.length === 3) return 'joker5';
      return 'doubleJoker';
    }

    /* 两张牌：天公 / 木塞 / 普通。带鬼不判天公（鬼只补点数，不换牌型） */
    if (hand.length === 2) {
      var u2 = unitDigit(hand);
      if (jn === 1) return 'normal';
      if (u2 === 8 || u2 === 9) return 'tiangong';
      if (u2 === 0) return 'muse';
      return 'normal';
    }

    /* 三张、单鬼或无鬼 */
    var jokers = [], normals = [];
    for (i = 0; i < hand.length; i++) (isJoker(hand[i]) ? jokers : normals).push(hand[i]);

    if (jokers.length === 0) {
      var rs = normals.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
      if (isThreeKind(rs)) return 'threeKind';
      var info = sameSuitInfo(hand);
      if (info.same && isStraight3(rs)) return 'straightFlush';
      if (isStraight3(rs)) return 'straight';
      var u = unitDigit(hand);
      if (u === 0) return 'muse';
      return 'normal';
    }

    /* 单鬼：枚举鬼补成普通牌，取能凑的最强牌型。
       优先级 三条 > 同花顺 > 顺子；都不成就按鬼=0点看木塞/普通。
       ★ v1.24.84 起（用户 2026-11-24 确认）：大鬼/小鬼/白牌都能补任意花色，
         两张普通牌花色一样 + 任意鬼 = 同花（「红7红8+白牌」算同花顺）。
         枚举四种花色只是让补牌能匹配上普通牌的花色，鬼本身不限颜色。 */
    var best = 'normal';
    var base = normals[0], other = normals[1];
    for (var r = 1; r <= 13; r++) {
      for (var s = 0; s < 4; s++) {
        var cand = { r: r, s: s };
        var three = [base, other, cand];
        var rs3 = three.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
        var info3 = sameSuitInfo(three);
        if (isThreeKind(rs3)) { return 'threeKind'; }
        if (info3.same && isStraight3(rs3)) { best = 'straightFlush'; }
        else if (isStraight3(rs3) && best !== 'straightFlush') { best = 'straight'; }
      }
    }
    if (best !== 'normal') return best;
    var u3 = unitDigit(hand);
    return u3 === 0 ? 'muse' : 'normal';
  }

  /* 牌型大小序（常规，不含"0点克双鬼"特判）。
     GDD 第三节网上顺序：三鬼>双鬼>天公>同花顺>三条>顺子>普通；
     木塞(个位0)属普通点数，最小。8/9 天公按个位再细分（见 compare 内的细比较）。
     大=强。D：三条与同花顺的先后按 GDD 网上序（同花顺>三条），与倍率(三条10>同花顺7)故意相反。 */
  var RANK = {
    tripleJoker: 90, doubleJoker: 80, joker5: 75, tiangong: 70,
    straightFlush: 60, threeKind: 50, straight: 40,
    muse: 10, normal: 0
  };
  function rankOf(kind) { return RANK[kind] === undefined ? 0 : RANK[kind]; }

  /* 牌型底倍率（花色加成之前）。用户确认：三条5/同花顺7/顺子4/双鬼10/鬼鬼X=8/三鬼30/
     天公底1/木塞底1。同花顺的 7 已含同花概念，不再叠花色加成。 */
  var BASE = {
    tripleJoker: 30, doubleJoker: 10, joker5: 8,
    straightFlush: 7, threeKind: 5, straight: 4,
    tiangong: 1, muse: 1, normal: 1
  };
  function baseMult(kind) { return BASE[kind] === undefined ? 1 : BASE[kind]; }

  /* 最终罚酒倍率。花色加成只作用在"天公"和"木塞/普通"两类（其余牌型倍率已固定/已含同花）。
     木塞克双鬼：花色倍率 × 10（用户确认 10/20/30）；鬼鬼5 固定 8、同花固定 3。 */
  function finalMult(kind, hand, opponentKind) {
    var b = suitBonus(hand);
    if (kind === 'joker5') return 8;       // 鬼鬼X 固定 8 倍，含鬼不算花色加成
    /* 天公倍率（用户 2026-11-20 纠正）：对子 或 同花 → 2 倍；杂花非对子 → 1 倍。
       图1 的 4♦4♣ 是对子（虽杂花）应 2 倍；图3 天公之间按此双倍/单倍裁决谁吃谁。 */
    if (kind === 'tiangong') return tiangongDouble(hand) ? 2 : 1;
    if (kind === 'muse' && opponentKind === 'doubleJoker') return b * 10;
    if (kind === 'muse' && opponentKind === 'tripleJoker') return b * 30;
    /* 普通牌：花色倍率 × 对子倍率（两张手牌同点数=2）。
       图6 的 8♦8♣ 杂花对子 → 1×2=2 倍、收 2；图1 三张同花 8♣3♣2♣ → 3×1=3 倍。 */
    if (kind === 'normal') return b * pairBonus(hand) * BASE[kind];
    if (kind === 'muse') return b * BASE[kind];
    return BASE[kind];
  }

  /* 循环相克：a 克 b 返回 1 / b 克 a 返回 -1 / 同档 0。
     ★ 用户 2026-11-20 实战截图确认的特例，其余按倍率（BASE）大的吃小的：
        木塞只赢双鬼、三鬼，别的都赢不了（含鬼鬼X）；
        鬼鬼X=8 倍，克 8 倍以下（木塞/普通/同花/顺子/三条/同花顺），但输天公、双鬼、三鬼；
        天公克鬼鬼X；同花越级赢双鬼；倍率相同时交给 compare 比点数个位。 */
  function beats(a, b) {
    if (a === b) return 0;
    /* 木塞只赢双鬼、三鬼，别的都赢不了（鬼鬼X 也不行） */
    if (a === 'muse' && (b === 'doubleJoker' || b === 'tripleJoker')) return 1;
    if (b === 'muse' && (a === 'doubleJoker' || a === 'tripleJoker')) return -1;
    /* 鬼鬼X=8 倍，克 8 倍以下（木塞/普通/同花顺/三条/顺子），但输天公、双鬼、三鬼 */
    if (a === 'joker5' && b !== 'tiangong' && (BASE[b] === undefined ? 1 : BASE[b]) < 8) return 1;
    if (b === 'joker5' && a !== 'tiangong' && (BASE[a] === undefined ? 1 : BASE[a]) < 8) return -1;
    if (a === 'tiangong' && b === 'joker5') return 1;
    if (b === 'tiangong' && a === 'joker5') return -1;
    /* 木塞是最小的：普通也赢它 */
    if (a === 'normal' && b === 'muse') return 1;
    if (b === 'normal' && a === 'muse') return -1;
    /* 其余按牌型大小序 RANK（天公>同花顺>三条>顺子>木塞>普通） */
    var ra = rankOf(a), rb = rankOf(b);
    return ra === rb ? 0 : (ra > rb ? 1 : -1);
  }

  /* 比大小：返回 1=A赢 / -1=B赢 / 0=平。
     ★ v1.24.84（用户 2026-11-24 确认）：木塞(坐庄) 和 木塞鱼(大吃小) 裁决完全一致——
       所有牌型只比点数个位（8 吃 6、6 吃 3），点数相同一律打平，不再比花色/对子倍率。
       原先木塞鱼独有的「同点数时三倍吃两倍、两倍吃一倍」已取消。
       · 天公：牌型大于普通牌，天公 8/9 赢补牌的普 8/普 9（同点也赢）；
         两张天公互比才拼点数——9 吃 8，同点打平，不按双倍/单倍裁决。
       · 顺子/同花顺/三条这类成型牌型：同牌型打平，不拼点数。
       两玩法差别只剩流程：坐庄模式庄家控开，木塞鱼 2/3 投票一起开。 */
  function compare(handA, handB, mode) {
    var ka = kindOf(handA), kb = kindOf(handB);
    var c = beats(ka, kb);
    if (c !== 0) return c;
    if (ka === 'tiangong') {
      /* ★ v1.24.84（用户 2026-11-24 确认）：天公之间只拼点数——9 吃 8，点数相同就打平。
         不再按双倍/单倍裁决（对子/同花那种加倍只算罚酒倍率，不参与谁吃谁）。
         补牌的普通 8/9 点赢不了天公，但两张天公互比时点数说了算。 */
      var ua = unitDigit(handA), ub = unitDigit(handB);
      if (ua !== ub) return ua > ub ? 1 : -1;
      return 0;                                          // 同点数打平，不拼倍数
    }
    /* v1.24.84（用户 2026-11-24 确认）：木塞≈木塞鱼，全部只拼点数，同点就平。
       原先木塞鱼独有的「同点数比倍率（三同花×3 吃杂花×1）」已取消，两玩法裁决一致。 */
    var ua = unitDigit(handA), ub = unitDigit(handB);
    if (ua !== ub) return ua > ub ? 1 : -1;             // 两模式通吃：点数个位大的吃小的
    return 0;   // 点数类同点数一律打平；成型牌型同牌型也打平
  }

  /* 生成一副 55 张：52 普通 + 大鬼 + 小王 + 白牌 */
  function newDeck() {
    var d = [], s, r;
    for (s = 0; s < 4; s++) for (r = 1; r <= 13; r++) d.push({ r: r, s: s });
    d.push({ r: 0, s: 'BJ' });
    d.push({ r: 0, s: 'SJ' });
    d.push({ r: 0, s: 'W' });
    return d;
  }

  /* Fisher-Yates 洗牌，rnd 可注入（测试用） */
  function shuffle(deck, rnd) {
    var r = rnd || Math.random, a = deck.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(r() * (i + 1));
      t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 发牌：从牌堆顶取 n 张，返回 {hand, rest} */
  function deal(deck, n) {
    var a = deck.slice();
    return { hand: a.splice(0, n), rest: a };
  }

  /* ================= 判定结束 ================= */

  /* 纯规则出口：给单测 / 联机 / 裁剪脚本用。
     裁剪脚本 make_clean_h5.py 不必动它（木塞两版都带、只有公开规则），
     但出口名集中在此，方便以后要裁时一处处理。 */
  window.LDMuseRules = {
    MIN_P: MIN_P, MAX_P: MAX_P,
    isJoker: isJoker, isWhite: isWhite, pointOf: pointOf, unitDigit: unitDigit,
    colorOf: colorOf, sameSuitInfo: sameSuitInfo, suitBonus: suitBonus,
    tiangongDouble: tiangongDouble,
    kindOf: kindOf, rankOf: rankOf, baseMult: baseMult, finalMult: finalMult,
    beats: beats,
    compare: compare, newDeck: newDeck, shuffle: shuffle, deal: deal,
    RANK: RANK, BASE: BASE
  };

  /* 木塞联机：判定层供服务端 / 单测复用，UI 与 WS 全在 museNet.js。 */
})();

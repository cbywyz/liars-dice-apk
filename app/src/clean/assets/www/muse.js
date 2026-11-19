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

  /* 手牌点数相加的个位（0..9） */
  function unitDigit(hand) {
    var sum = 0;
    for (var i = 0; i < hand.length; i++) sum += pointOf(hand[i]);
    return ((sum % 10) + 10) % 10;
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

  /* 这手牌能否算"同花"：普通牌花色统一，鬼按红/黑补到该花色，白牌无色不参与 → false。
     返回 {same:bool, n:同花张数}；n 取手牌张数（2 或 3）。 */
  function sameSuitInfo(hand) {
    if (!hand || (hand.length !== 2 && hand.length !== 3)) return { same: false, n: hand ? hand.length : 0 };
    var suits = {};
    var jokerRed = false, jokerBlack = false;
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      if (colorOf(c) === 2) return { same: false, n: hand.length };   // 白牌无色，凑不了同花
      if (isJoker(c)) {
        if (colorOf(c) === 0) jokerRed = true; else jokerBlack = true;
      } else {
        suits[c.s] = true;
      }
    }
    var keys = Object.keys(suits);
    if (keys.length === 0) return { same: false, n: hand.length };    // 全是鬼，走鬼牌型不谈同花（D）
    if (keys.length > 1) return { same: false, n: hand.length };
    var s = +keys[0];
    var need = (s === 0 || s === 1) ? 0 : 1;                          // 该花色需要的鬼颜色
    if (need === 0 && jokerBlack) return { same: false, n: hand.length }; // 小鬼(黑)补不了红花
    if (need === 1 && jokerRed) return { same: false, n: hand.length };   // 大鬼(红)补不了黑花
    return { same: true, n: hand.length };
  }

  /* 花色加成：杂花=1，两张同花=2，三张同花=3。用户确认的统一公式第一层。 */
  function suitBonus(hand) {
    var info = sameSuitInfo(hand);
    return info.same ? info.n : 1;
  }

  /* 三张普通牌是否顺子（A=1 不接 K；J-Q-K=11,12,13 算顺；鬼不在其中，另由枚举处理） */
  function isStraight3(rs) {
    if (rs.length !== 3) return false;
    var a = rs[0], b = rs[1], c = rs[2];
    return b === a + 1 && c === b + 1 && a >= 1 && a <= 11;
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
    if (jn === 2) return 'doubleJoker';

    /* 两张牌：天公 / 木塞 / 普通（鬼按 0 点参与，D：单鬼两张不枚举点数凑天公） */
    if (hand.length === 2) {
      var u2 = unitDigit(hand);
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
       ★ 鬼的花色限制（用户确认）：大鬼红=只补红桃/方块(s 0/1)、小王黑=只补梅花/黑桃(s 2/3)，
         白牌无色=不能补同花；但三条/顺子只看点数，三种鬼都能补。
         不可把白牌/大鬼枚举成任意花色，否则「红7红8+白牌」会被误判成同花顺。 */
    var ghost = jokers[0];
    var canFlush = !isWhite(ghost);
    var gc = colorOf(ghost);                             // 0红 1黑 2无色
    var candSuits = gc === 0 ? [0, 1] : (gc === 1 ? [2, 3] : [0, 1, 2, 3]);
    var best = 'normal';
    var base = normals[0], other = normals[1];
    for (var r = 1; r <= 13; r++) {
      for (var ci = 0; ci < candSuits.length; ci++) {
        var cand = { r: r, s: candSuits[ci] };
        var three = [base, other, cand];
        var rs3 = three.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
        var info3 = sameSuitInfo(three);
        if (isThreeKind(rs3)) { return 'threeKind'; }
        if (canFlush && info3.same && isStraight3(rs3)) { best = 'straightFlush'; }
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
    tripleJoker: 90, doubleJoker: 80, tiangong: 70,
    straightFlush: 60, threeKind: 50, straight: 40,
    muse: 10, normal: 0
  };
  function rankOf(kind) { return RANK[kind] === undefined ? 0 : RANK[kind]; }

  /* 牌型底倍率（花色加成之前）。用户确认：三条10/同花顺7/顺子4/双鬼10/三鬼30/天公底1/木塞底1。
     同花顺的 7 已含同花概念，不再叠花色加成。 */
  var BASE = {
    tripleJoker: 30, doubleJoker: 10, threeKind: 10,
    straightFlush: 7, straight: 4, tiangong: 1, muse: 1, normal: 1
  };
  function baseMult(kind) { return BASE[kind] === undefined ? 1 : BASE[kind]; }

  /* 最终罚酒倍率。花色加成只作用在"天公"和"木塞/普通"两类（其余牌型倍率已固定/已含同花）。
     木塞克双鬼：花色倍率 × 10（用户确认 10/20/30）。 */
  function finalMult(kind, hand, opponentKind) {
    var b = suitBonus(hand);
    if (kind === 'tiangong') return b * BASE.tiangong;
    if (kind === 'muse' && opponentKind === 'doubleJoker') return b * 10;
    if (kind === 'muse' || kind === 'normal') return b * BASE[kind];
    return BASE[kind];
  }

  /* 比大小：返回 1=A赢 / -1=B赢 / 0=平。
     特判（用户确认）：木塞(0点)克双鬼；天公输双鬼（RANK 已保证）。
     同档时：天公比个位(9>8)；普通/木塞比个位(9>0)；鬼与固定牌型同档算平。 */
  function compare(handA, handB) {
    var ka = kindOf(handA), kb = kindOf(handB);
    if (ka === 'muse' && kb === 'doubleJoker') return 1;
    if (kb === 'muse' && ka === 'doubleJoker') return -1;
    var ra = rankOf(ka), rb = rankOf(kb);
    if (ra !== rb) return ra > rb ? 1 : -1;
    var ua = unitDigit(handA), ub = unitDigit(handB);
    if (ua !== ub) return ua > ub ? 1 : -1;
    return 0;
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
    kindOf: kindOf, rankOf: rankOf, baseMult: baseMult, finalMult: finalMult,
    compare: compare, newDeck: newDeck, shuffle: shuffle, deal: deal,
    RANK: RANK, BASE: BASE
  };

  /* 木塞只做联机：判定层供服务端 / 单测复用，UI 与 WS 全在 museNet.js。 */
})();

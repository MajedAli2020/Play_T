'use strict';
// محرك اللعبة (منطق البوكر فقط) — ما فيه سوكت ولا ديسكورد، عشان يكون سهل الاختبار.
const { randomInt } = require('crypto');
const CONFIG = require('./config');

const HN = ['ورقة عالية', 'زوج', 'زوجين', 'ثلاثة متشابهة', 'تسلسل', 'فلاش', 'فل هاوس', 'أربعة متشابهة', 'ستريت فلاش'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class GameError extends Error {
  constructor(m) { super(m); this.user = true; }
}

/* ---------- تقييم الأوراق ---------- */
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};

// الورق: أكه شايب بنت ولد عشرة تسعة ثمانية سبعة (حسب عدد اللاعبين)
const RANKS_ALL = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const MAX_PLAYERS = 11; // 4 أوراق لكل لاعب + ٥ على الطاولة من ٥٢ ورقة

function newDeck(ranks = RANKS_ALL) {
  const d = [];
  for (let s = 0; s < 4; s++) for (const r of ranks) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

function ev5(c) {
  const n = {};
  c.forEach(x => n[x.r] = (n[x.r] || 0) + 1);
  const g = Object.keys(n).map(Number).sort((a, b) => n[b] - n[a] || b - a);
  const fl = c.every(x => x.s === c[0].s);
  const k = g.map(r => n[r]).join('');
  let st = 0;
  if (g.length === 5) {
    if (g[0] - g[4] === 4) st = g[0];
    else if (g[0] === 14 && g[1] === 5) st = 5; // A-2-3-4-5
  }
  const rk = st === 5 ? [5, 4, 3, 2, 1] : g;
  let cat = 0;
  if (st && fl) cat = 8;
  else if (k === '41') cat = 7;
  else if (k === '32') cat = 6;
  else if (fl) cat = 5;
  else if (st) cat = 4;
  else if (k === '311') cat = 3;
  else if (k === '221') cat = 2;
  else if (k === '2111') cat = 1;
  return [cat, ...rk];
}

// أفضل ٥ أوراق من أي عدد أوراق (٥ فأكثر)
function best(c) {
  let b = null;
  const pick = [];
  (function rec(i) {
    if (pick.length === 5) { const v = ev5(pick); if (!b || cmp(v, b) > 0) b = v; return; }
    if (c.length - i < 5 - pick.length) return;
    pick.push(c[i]); rec(i + 1); pick.pop(); rec(i + 1);
  })(0);
  return b;
}

// اسم اليد قبل ما تكتمل ٥ أوراق (زوج/زوجين/ثلاثة/أربعة)
function partialCat(c) {
  const n = {};
  c.forEach(x => n[x.r] = (n[x.r] || 0) + 1);
  const v = Object.values(n).sort((a, b) => b - a);
  if (v[0] === 4) return 7;
  if (v[0] === 3) return 3;
  if (v[0] === 2 && v[1] === 2) return 2;
  if (v[0] === 2) return 1;
  return 0;
}

function myHand(r, p, HN) {
  const c = [...p.hand, ...r.board];
  if (c.length < 5) return HN[partialCat(c)];
  return HN[best(c)[0]];
}

/* ---------- المحرك ---------- */
function createEngine(hooks = {}, timing = {}, config) {
  const cfg = config || CONFIG.defaults();
  // التوقيت يُقرأ من الإعدادات الحيّة كل مرة (timing للاختبارات فقط)
  const T = {
    get turn() { return timing.turn ?? cfg.turnSec * 1000; },
    get next() { return timing.next ?? cfg.nextSec * 1000; },
    get end() { return timing.end ?? cfg.endSec * 1000; },
    get grace() { return timing.grace ?? cfg.graceSec * 1000; },
    get idle() { return timing.idle ?? cfg.idleMin * 60000; }
  };
  const HNs = () => (Array.isArray(cfg.handNames) && cfg.handNames.length === 9 ? cfg.handNames : HN);
  const maxP = r => r.maxPlayers || cfg.maxPlayers;
  const minP = r => r.minPlayers || cfg.minPlayers;
  const calcBB = ticket => Math.max(2, Math.round(ticket / cfg.bbDivisor) * 2);
  const rooms = new Map();
  const call = (name, ...a) => { try { if (hooks[name]) hooks[name](...a); } catch (e) { console.error('hook ' + name + ':', e); } };

  const live = r => r.players.filter(p => p.in && !p.folded);
  const canAct = r => live(r).filter(p => !p.allin);
  const pay = (p, a) => { a = Math.min(a, p.chips); p.chips -= a; p.bet += a; p.tot += a; if (p.chips === 0) p.allin = true; };
  const nxt = (r, i, f) => { const n = r.players.length; for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (f(r.players[j])) return j; } return -1; };
  const mkP = (id, sid, name, chips) => ({ id, sid, name, chips, in: false, folded: false, allin: false, bet: 0, tot: 0, acted: false, hand: [], win: 0, left: false, leftAt: 0, score: null });
  const changed = r => call('onChange', r);

  function touch(r) {
    clearTimeout(r.gc);
    r.gc = setTimeout(() => destroy(r, 'idle'), T.idle);
    if (r.gc.unref) r.gc.unref();
  }
  function destroy(r, why) {
    clearTimeout(r.t); clearTimeout(r.gc);
    if (rooms.get(r.code) === r) rooms.delete(r.code);
    call('onClose', r, why); call('onDirty');
  }

  // المنظّم: اللي أنشأ الطاولة من الموقع (لو طلع من اللوبي ينتقل مؤقتاً لأول لاعب)
  function hostOf(r) {
    const h = r.meta && r.meta.hostPid;
    if (!h) return null;
    return r.players.some(x => x.id === h) ? h : (r.players[0] ? r.players[0].id : null);
  }

  function view(r, me) {
    const sd = r.phase === 'showdown' && r.reveal;
    // ترتيب الأقوى عند كشف الأوراق (١ = الأقوى، التعادل نفس الرقم)
    const rankOf = new Map();
    if (sd) {
      const L = live(r).filter(p => p.score).sort((a, b) => cmp(b.score, a.score));
      L.forEach((p, i) => rankOf.set(p, i > 0 && cmp(L[i - 1].score, p.score) === 0 ? rankOf.get(L[i - 1]) : i + 1));
    }
    return {
      code: r.code, phase: r.phase, host: hostOf(r), by: (r.meta && r.meta.creatorName) || '', me: me.id, bb: r.bb,
      ticket: r.ticket, win: r.win, la: r.last || null, board: r.board, cur: r.cur, minRaise: r.minRaise,
      pot: r.players.reduce((s, p) => s + p.tot, 0),
      turn: r.players[r.turn] ? r.players[r.turn].id : undefined,
      left: r.paused ? 0 : Math.max(0, r.deadline - Date.now()), tt: T.turn, msg: r.paused ? '⏸ الطاولة متوقفة مؤقتاً من الإدارة' : r.msg,
      mh: (me.in && me.hand.length && r.phase !== 'lobby') ? myHand(r, me, HNs()) : '', minp: minP(r), maxp: maxP(r), rk: r.ranks || [], paused: !!r.paused,
      players: r.players.map((p, i) => {
        const show = p === me || (sd && p.in && !p.folded);
        return {
          id: p.id, name: p.name, chips: p.chips, bet: p.bet, tot: p.tot, folded: p.folded, allin: p.allin, in: p.in,
          dealer: i === r.dealer, win: p.win || 0,
          hand: p.hand.length ? (show ? p.hand : [0, 0]) : [],
          hn: (sd && p.in && !p.folded && p.score) ? HNs()[p.score[0]] : '', rk: rankOf.get(p) || 0
        };
      })
    };
  }
  function send(r) {
    touch(r); call('onDirty');
    r.players.forEach(p => { if (!p.left && p.sid) call('push', p.sid, view(r, p)); });
  }

  /* ---------- نهاية المباراة ---------- */
  function endMatch(r, w, reason) {
    clearTimeout(r.t);
    r.over = true;
    if (!w) return;
    const standings = r.players.map(p => ({ name: p.name, chips: p.chips })).sort((a, b) => b.chips - a.chips);
    r.lastWinner = { name: w.name, chips: w.chips };
    call('onEnd', {
      code: r.code, meta: r.meta, ticket: r.ticket, win: r.win, reason,
      winner: { name: w.name, chips: w.chips }, standings,
      hands: r.hands, players: r.players.length, durationMs: Date.now() - (r.startedAt || Date.now())
    });
  }
  function toLobby(r, msg) {
    clearTimeout(r.t);
    r.players = r.players.filter(p => !p.left);
    r.players.forEach(p => {
      p.chips = r.ticket; p.in = false; p.folded = false; p.allin = false; p.bet = 0; p.tot = 0;
      p.acted = false; p.hand = []; p.win = 0; p.score = null;
    });
    r.phase = 'lobby'; r.board = []; r.dealer = -1; r.turn = -1; r.deadline = 0; r.reveal = false;
    r.msg = msg || ''; r.over = false;
    send(r); changed(r);
  }

  /* ---------- سير اليد ---------- */
  function startHand(r) {
    clearTimeout(r.t);
    // شيل اللي طلعوا من فترة، وحافظ على مكان الموزّع
    const now = Date.now(), kept = [];
    let nd = -1, removed = 0;
    r.players.forEach((p, i) => {
      if (p.left && now - p.leftAt > T.grace) removed++; else kept.push(p);
      if (i === r.dealer) nd = kept.length - 1;
    });
    r.players = kept; r.dealer = nd;
    r.players.forEach(p => {
      p.in = p.chips > 0; p.folded = false; p.allin = false; p.bet = 0; p.tot = 0;
      p.acted = false; p.hand = []; p.win = 0; p.score = null;
    });
    const n = r.players.filter(p => p.in).length;
    if (n < 2) {
      const w = r.players.find(p => p.in);
      endMatch(r, w, removed > 0 ? 'forfeit' : 'last');
      return toLobby(r, w ? 'انتهت المباراة — 🏆 ' + w.name + ' فاز' : 'انتهت المباراة');
    }
    r.hands = (r.hands || 0) + 1;
    // عدد رتب الورق = عدد اللاعبين (٤ → أكه شايب بنت ولد، ٥ تزيد العشرة، … ٨ → لين السبعة)
    const H = cfg.holeCards;
    if (H * n + 5 > 52) throw new GameError('عدد اللاعبين كبير على ' + H + ' أوراق لكل لاعب');
    let k = cfg.deckByPlayers ? Math.min(cfg.maxRanks, Math.max(cfg.minRanks, n)) : cfg.maxRanks;
    while (4 * k < H * n + 5 && k < 13) k++;
    r.ranks = RANKS_ALL.slice(0, k);
    r.deck = newDeck(r.ranks); r.board = []; r.msg = ''; r.reveal = false; r.last = null;
    r.dealer = nxt(r, r.dealer, p => p.in);
    const sb = n === 2 ? r.dealer : nxt(r, r.dealer, p => p.in), bbI = nxt(r, sb, p => p.in);
    r.players.forEach(p => { if (p.in) p.hand = Array.from({ length: cfg.holeCards }, () => r.deck.pop()); });
    pay(r.players[sb], Math.max(1, Math.floor(r.bb * cfg.sbRatio))); pay(r.players[bbI], r.bb);
    r.cur = r.bb; r.minRaise = cfg.raiseStep; r.phase = 'preflop'; r.turn = bbI;
    step(r);
  }

  function turnStart(r) {
    clearTimeout(r.t);
    const p = r.players[r.turn];
    r.deadline = Date.now() + T.turn;
    r.t = setTimeout(() => {
      if (r.players[r.turn] === p) act0(r, p, 'fold', 0, true); // انتهى الوقت = يطلع من الجولة
    }, p.left ? Math.min(400, T.turn) : T.turn + 200);
    send(r);
  }

  function step(r) {
    const lv = live(r);
    if (lv.length === 1) return award(r, lv, true);
    if (!canAct(r).every(p => p.acted && p.bet === r.cur)) {
      r.turn = nxt(r, r.turn, p => p.in && !p.folded && !p.allin && !(p.acted && p.bet === r.cur));
      return turnStart(r);
    }
    r.players.forEach(p => { p.bet = 0; p.acted = false; });
    r.cur = 0; r.minRaise = cfg.raiseStep;
    if (r.phase === 'river') return showdown(r);
    r.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[r.phase];
    for (let i = 0; i < (r.phase === 'flop' ? 3 : 1); i++) r.board.push(r.deck.pop());
    if (canAct(r).length < 2) canAct(r).forEach(p => p.acted = true);
    r.turn = r.dealer; step(r);
  }

  function act0(r, p, type, amt, timeout) {
    if (r.paused || r.players[r.turn] !== p || !['preflop', 'flop', 'turn', 'river'].includes(r.phase)) return;
    const to = r.cur - p.bet;
    if (type === 'fold') p.folded = true;
    else if (type === 'check' || type === 'call') pay(p, to);
    else if (type === 'allin' || type === 'raise') {
      // الرفع: أقل شي 100 وبعدها زيادات 100 بدون حد أعلى (لين كل فلوسه)
      const mx = p.chips + p.bet, st = cfg.raiseStep;
      let t;
      if (type === 'allin') t = mx;
      else {
        const inc = Math.max(st, Math.ceil(((Math.floor(+amt) || 0) - r.cur) / st) * st);
        t = Math.min(r.cur + inc, mx);
      }
      if (t <= r.cur) pay(p, to);
      else {
        pay(p, t - p.bet);
        r.minRaise = st;
        r.cur = t;
        r.players.forEach(o => { if (o !== p) o.acted = false; });
      }
    } else return;
    // آخر حركة: تنعرض في النص الأعلى للكل
    const paid = p.bet;
    const kind = type === 'fold' ? 'fold' : p.allin ? 'allin' : type === 'raise' ? 'raise' : to > 0 ? 'call' : 'check';
    r.last = { id: p.id, name: p.name, kind, amt: kind === 'call' ? Math.min(to, paid) : paid, timeout: !!timeout, seq: (r.seq = (r.seq || 0) + 1) };
    p.acted = true; step(r);
  }

  function showdown(r) {
    live(r).forEach(p => p.score = best([...p.hand, ...r.board]));
    award(r, live(r), false);
  }

  function award(r, lv, fold) {
    clearTimeout(r.t);
    const all = r.players.filter(p => p.in);
    const lvls = [...new Set(lv.map(p => p.tot))].sort((a, b) => a - b);
    let prev = 0;
    lvls.forEach((l, i) => {
      const top = i === lvls.length - 1;
      const pot = all.reduce((s, p) => s + Math.max(0, (top ? p.tot : Math.min(p.tot, l)) - prev), 0);
      const el = lv.filter(p => p.tot >= l);
      let b = null;
      if (!fold) el.forEach(p => { if (!b || cmp(p.score, b) > 0) b = p.score; });
      const w = fold ? el : el.filter(p => cmp(p.score, b) === 0);
      const sh = Math.floor(pot / w.length), rem = pot - sh * w.length;
      w.forEach((p, k) => { const g = sh + (k === 0 ? rem : 0); p.chips += g; p.win += g; });
      prev = l;
    });
    const ws = all.filter(p => p.win > 0);
    r.msg = ws.map(p => p.name + ' فاز بـ ' + p.win.toLocaleString('en') + (fold ? '' : ' (' + HNs()[p.score[0]] + ')')).join(' • ');
    const champ = r.players.filter(p => p.chips >= r.win).sort((a, b) => b.chips - a.chips)[0];
    r.reveal = !fold; r.phase = 'showdown'; r.turn = -1; r.deadline = 0;
    if (champ) {
      r.msg += ' — 🏆 ' + champ.name + ' فاز بالمباراة!';
      endMatch(r, champ, 'target');
      send(r);
      r.t = setTimeout(() => toLobby(r, ''), T.end);
      return;
    }
    send(r);
    r.t = setTimeout(() => startHand(r), T.next);
  }

  /* ---------- واجهة المحرك ---------- */
  function createRoom({ ticket, win, meta, maxPlayers, minPlayers } = {}) {
    ticket = Math.floor(+ticket); win = Math.floor(+win);
    const okN = v => Number.isInteger(v) && v >= 2 && v <= MAX_PLAYERS;
    maxPlayers = maxPlayers == null ? null : Math.floor(+maxPlayers); minPlayers = minPlayers == null ? null : Math.floor(+minPlayers);
    if ((maxPlayers != null && !okN(maxPlayers)) || (minPlayers != null && !okN(minPlayers))) throw new GameError('عدد اللاعبين لازم من 2 إلى ' + MAX_PLAYERS);
    if ((minPlayers || cfg.minPlayers) > (maxPlayers || cfg.maxPlayers)) throw new GameError('الحد الأدنى للاعبين أكبر من الأقصى');
    if (cfg.maintenance && !(meta && meta.admin)) throw new GameError(cfg.maintenanceMsg || 'اللعبة تحت الصيانة');
    if (!(ticket >= cfg.minTicket && ticket <= cfg.maxTicket)) throw new GameError('تذكرة الدخول لازم تكون من ' + cfg.minTicket.toLocaleString('en') + ' إلى ' + cfg.maxTicket.toLocaleString('en'));
    if (!(win > ticket && win <= cfg.maxWin)) throw new GameError('رصيد الفوز لازم يكون أكبر من تذكرة الدخول' + (win > cfg.maxWin ? ' وأقل من ' + cfg.maxWin.toLocaleString('en') : ''));
    if (rooms.size >= cfg.maxRooms) throw new GameError('فيه طاولات كثيرة الحين، جرّب بعد شوي');
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(code));
    const r = {
      code, meta: meta || {}, maxPlayers, minPlayers, players: [], phase: 'lobby', board: [], cur: 0, minRaise: 0,
      bb: calcBB(ticket), ticket, win, turn: -1, dealer: -1, deadline: 0,
      msg: '', ranks: RANKS_ALL.slice(), paused: false, t: null, gc: null, hands: 0, startedAt: 0, lastWinner: null, over: false, reveal: false
    };
    rooms.set(code, r);
    touch(r);
    return r;
  }

  function join(r, sid, pid, name) {
    let p = r.players.find(x => x.id === pid);
    if (cfg.bannedPids.includes(pid)) throw new GameError('تم حظرك من اللعبة');
    if (p && p.kicked) throw new GameError('تم طردك من هذه الطاولة');
    if (p) {
      p.sid = sid; p.left = false; p.leftAt = 0; send(r);
      if (r.autoResume) { r.autoResume = false; setTimeout(() => { if (rooms.get(r.code) === r) admin.resume(r); }, 5000); }
      return p;
    } // رجوع لنفس المقعد
    if (!cfg.allowJoin) throw new GameError('الانضمام مقفل حالياً');
    if (r.phase !== 'lobby') throw new GameError('اللعبة بدأت — ما تقدر تنضم الحين');
    if (!name) throw new GameError('اكتب اسمك');
    if (cfg.bannedNames.some(b => b.toLowerCase() === name.toLowerCase())) throw new GameError('هذا الاسم ممنوع');
    if (r.players.length >= maxP(r)) throw new GameError('الطاولة ممتلئة (الحد ' + maxP(r) + ')');
    p = mkP(pid, sid, name, r.ticket);
    r.players.push(p);
    send(r); changed(r);
    return p;
  }

  function leave(r, pid, sid) {
    const p = r.players.find(x => x.id === pid);
    if (!p || p.sid !== sid) return; // سوكت قديم، اللاعب رجع من سوكت ثاني
    if (r.phase === 'lobby') { r.players = r.players.filter(x => x !== p); send(r); changed(r); return; }
    p.left = true; p.leftAt = Date.now(); // يبقى مقعده؛ لو دوره ينسحب/يمرر تلقائي
    send(r);
  }

  function start(r, force) {
    if (r.phase !== 'lobby') throw new GameError('اللعبة جارية');
    const need = force ? 2 : minP(r);
    if (r.players.filter(p => p.chips > 0).length < need) throw new GameError('لازم ' + need + ' لاعبين على الأقل');
    if (cfg.holeCards * r.players.filter(p => p.chips > 0).length + 5 > 52) throw new GameError('عدد اللاعبين كبير على ' + cfg.holeCards + ' أوراق لكل لاعب');
    r.startedAt = Date.now(); r.hands = 0; r.lastWinner = null;
    startHand(r);
    changed(r);
  }

  function act(r, pid, type, amount) {
    const p = r.players.find(x => x.id === pid);
    if (p && !p.left) act0(r, p, type, amount);
  }

  /* ---------- أدوات الإدارة (لوحة التحكم فقط) ---------- */
  const betting = r => ['preflop', 'flop', 'turn', 'river'].includes(r.phase);
  const P = (r, pid) => { const p = r.players.find(x => x.id === pid); if (!p) throw new GameError('اللاعب غير موجود'); return p; };
  const cardOk = (c, r) => c && (r.ranks || RANKS_ALL).includes(c.r) && Number.isInteger(c.s) && c.s >= 0 && c.s <= 3;
  const key = c => c.r * 4 + c.s;

  const admin = {
    // كل شي عن الطاولة بما فيها أوراق اللاعبين
    snapshot(r) {
      return {
        code: r.code, maxPlayers: maxP(r), minPlayers: minP(r), ranks: r.ranks || [], phase: r.phase, paused: !!r.paused, ticket: r.ticket, win: r.win, bb: r.bb, cur: r.cur, minRaise: r.minRaise,
        pot: r.players.reduce((s, p) => s + p.tot, 0), board: r.board, msg: r.msg, hands: r.hands, dealer: r.dealer,
        turn: r.players[r.turn] ? r.players[r.turn].id : null, left: Math.max(0, r.deadline - Date.now()),
        host: hostOf(r), by: (r.meta && (r.meta.creatorName || r.meta.creatorId)) || '', source: (r.meta && r.meta.source) || (r.meta && r.meta.creatorId ? 'discord' : ''),
        startedAt: r.startedAt, lastWinner: r.lastWinner,
        players: r.players.map((p, i) => ({
          id: p.id, name: p.name, chips: p.chips, bet: p.bet, tot: p.tot, in: p.in, folded: p.folded, allin: p.allin,
          left: p.left, hand: p.hand, dealer: i === r.dealer, online: !p.left
        }))
      };
    },
    settings(r, o = {}) {
      if (o.maxPlayers !== undefined || o.minPlayers !== undefined) {
        const mx = o.maxPlayers !== undefined ? Math.floor(+o.maxPlayers) : maxP(r), mn = o.minPlayers !== undefined ? Math.floor(+o.minPlayers) : minP(r);
        if (!(mx >= 2 && mx <= MAX_PLAYERS && mn >= 2 && mn <= MAX_PLAYERS)) throw new GameError('عدد اللاعبين لازم من 2 إلى ' + MAX_PLAYERS);
        if (mn > mx) throw new GameError('الحد الأدنى للاعبين أكبر من الأقصى');
        r.maxPlayers = mx; r.minPlayers = mn;
      }
      if (o.ticket !== undefined) {
        const t = Math.floor(+o.ticket);
        if (!(t >= 1 && t <= 1e12)) throw new GameError('تذكرة غير صالحة');
        r.ticket = t;
        if (r.phase === 'lobby') r.players.forEach(p => { p.chips = t; });
        if (o.bb === undefined) r.bb = calcBB(t);
      }
      if (o.win !== undefined) {
        const w = Math.floor(+o.win);
        if (!(w > 0 && w <= 1e13)) throw new GameError('رصيد فوز غير صالح');
        r.win = w;
      }
      if (o.bb !== undefined) {
        const b = Math.floor(+o.bb);
        if (!(b >= 2 && b <= 1e12)) throw new GameError('بلايند غير صالح');
        r.bb = b; // يسري من اليد الجاية
      }
      send(r); changed(r);
    },
    message(r, text) { r.msg = String(text || '').slice(0, 140); send(r); },
    rename(r, pid, name) {
      name = String(name || '').trim().slice(0, 14);
      if (!name) throw new GameError('اسم فاضي');
      P(r, pid).name = name; send(r); changed(r);
    },
    setHost(r, pid) { P(r, pid); r.meta = r.meta || {}; r.meta.hostPid = pid; send(r); changed(r); },
    setChips(r, pid, n) {
      n = Math.floor(+n);
      if (!(n >= 0 && n <= 1e13)) throw new GameError('رصيد غير صالح');
      const p = P(r, pid);
      p.chips = n;
      if (p.in && !p.folded && betting(r)) p.allin = n === 0;
      send(r);
    },
    kick(r, pid, ban) {
      const p = P(r, pid);
      if (ban) { if (!cfg.bannedPids.includes(pid)) cfg.bannedPids.push(pid); CONFIG.save(cfg); }
      call('onKick', r, p, !!ban);
      if (r.phase === 'lobby') { r.players = r.players.filter(x => x !== p); send(r); changed(r); return; }
      const wasTurn = betting(r) && r.players[r.turn] === p;
      p.left = true; p.kicked = true; p.leftAt = 0; p.sid = null; // يتشال في اليد الجاية
      if (betting(r) && p.in && !p.folded) {
        if (wasTurn) act0(r, p, 'fold');
        else { p.folded = true; if (live(r).length === 1) step(r); else send(r); }
      } else send(r);
    },
    act(r, pid, type, amt) {
      const p = P(r, pid);
      if (!betting(r) || r.players[r.turn] !== p) throw new GameError('مو دور هذا اللاعب');
      if (r.paused) throw new GameError('الطاولة متوقفة');
      act0(r, p, type, amt);
    },
    skipTurn(r) {
      if (!betting(r) || r.turn < 0) throw new GameError('ما فيه دور حالياً');
      const p = r.players[r.turn];
      act0(r, p, p.bet < r.cur ? 'fold' : 'check');
    },
    addTime(r, sec) {
      if (!betting(r) || r.turn < 0) throw new GameError('ما فيه دور حالياً');
      const p = r.players[r.turn], ms = Math.max(1, Math.min(600, +sec || 10)) * 1000;
      clearTimeout(r.t);
      r.deadline = Date.now() + ms;
      r.t = setTimeout(() => { if (r.players[r.turn] === p) act0(r, p, 'fold', 0, true); }, ms + 200);
      send(r);
    },
    pause(r) {
      if (r.paused) return;
      r.paused = true; clearTimeout(r.t); send(r);
    },
    resume(r) {
      if (!r.paused) return;
      r.paused = false;
      if (betting(r) && r.turn >= 0) turnStart(r);
      else if (r.phase === 'showdown') r.t = setTimeout(() => (r.over ? toLobby(r, '') : startHand(r)), T.next);
      else send(r);
    },
    forceStart(r) { start(r, true); },
    nextHand(r) {
      if (r.phase !== 'showdown' || r.over) throw new GameError('تقدر تتخطى فقط بعد انتهاء اليد');
      startHand(r);
    },
    toLobby(r, msg) { r.paused = false; toLobby(r, msg || 'رجّعت الإدارة الطاولة للوبي'); },
    declareWinner(r, pid) {
      const p = P(r, pid);
      r.paused = false;
      endMatch(r, p, 'admin');
      toLobby(r, '🏆 ' + p.name + ' فاز بقرار الإدارة');
    },
    close(r, why) { destroy(r, why || 'admin'); },
    // تغيير أوراق لاعب أو أوراق الطاولة (بنفس العدد الحالي)
    setCards(r, { pid, hand, board }) {
      if (!betting(r) && r.phase !== 'showdown') throw new GameError('الأوراق ما تتغير إلا أثناء اليد');
      const inUse = new Set();
      r.players.forEach(p => { if (!(hand && p.id === pid)) p.hand.forEach(c => inUse.add(key(c))); });
      if (!board) r.board.forEach(c => inUse.add(key(c)));
      let target;
      if (hand) {
        const p = P(r, pid);
        if (!p.hand.length || hand.length !== p.hand.length) throw new GameError('لازم ' + p.hand.length + ' أوراق لهذا اللاعب');
        target = p.hand; if (!hand.every(c => cardOk(c, r))) throw new GameError('ورقة غير صالحة');
      } else if (board) {
        if (board.length !== r.board.length || !board.every(c => cardOk(c, r))) throw new GameError('لازم ' + r.board.length + ' أوراق للطاولة');
        target = r.board;
      } else throw new GameError('ما فيه أوراق');
      const nw = hand || board;
      if (new Set(nw.map(key)).size !== nw.length) throw new GameError('ورقة مكررة');
      if (nw.some(c => inUse.has(key(c)))) throw new GameError('إحدى الأوراق مستخدمة عند لاعب أو في الطاولة');
      const old = target.map(c => ({ r: c.r, s: c.s }));
      target.splice(0, target.length, ...nw.map(c => ({ r: c.r, s: c.s })));
      // رجّع القديمة للمجموعة وشيل الجديدة منها
      const gone = new Set(nw.map(key));
      r.deck = (r.deck || []).filter(c => !gone.has(key(c)));
      old.forEach(c => { if (!gone.has(key(c))) r.deck.unshift(c); });
      // أعد تقييم الشوداون لو انكشفت الأوراق
      if (r.phase === 'showdown' && r.reveal) live(r).forEach(p => { p.score = best([...p.hand, ...r.board]); });
      send(r);
    }
  };

  /* ---------- حفظ/استرجاع الطاولات عند إعادة تشغيل السيرفر ---------- */
  const KEEP = ['code', 'meta', 'phase', 'board', 'cur', 'minRaise', 'maxPlayers', 'minPlayers', 'bb', 'ticket', 'win', 'turn', 'dealer', 'msg', 'hands', 'startedAt', 'lastWinner', 'over', 'reveal', 'ranks', 'deck', 'paused'];
  function exportRooms() {
    return [...rooms.values()].map(r => {
      const o = {}; KEEP.forEach(k => { o[k] = r[k]; });
      o.players = r.players.map(p => ({ ...p, sid: null }));
      return o;
    });
  }
  function importRooms(list) {
    let n = 0;
    for (const o of list || []) {
      if (!o || !o.code || rooms.has(o.code)) continue;
      const r = {
        ...o, players: [], t: null, gc: null, deadline: 0, paused: !!o.paused,
        deck: o.deck || [], board: o.board || []
      };
      if (o.phase === 'lobby') { /* اللاعبين يرجعون تلقائياً من المتصفح */ }
      else {
        r.players = (o.players || []).map(p => ({ ...p, sid: null, left: true, leftAt: Date.now() }));
        r.paused = true; r.autoResume = true; // يكمّل لما يرجع أول لاعب
      }
      rooms.set(r.code, r); touch(r); n++;
    }
    return n;
  }

  return { exportRooms, importRooms, rooms, createRoom, join, leave, start, act, destroy, view, hostOf, admin, cfg };
}

module.exports = { createEngine, GameError, ev5, best, cmp };

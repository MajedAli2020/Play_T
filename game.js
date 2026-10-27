'use strict';
// محرك اللعبة (منطق البوكر فقط) — ما فيه سوكت ولا ديسكورد، عشان يكون سهل الاختبار.
const { randomInt } = require('crypto');

const MAX = 8;
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

function newDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s });
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

function best(c) {
  let b = null;
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) {
      const v = ev5(c.filter((_, k) => k !== i && k !== j));
      if (!b || cmp(v, b) > 0) b = v;
    }
  return b;
}

function myHand(r, p) {
  const c = [...p.hand, ...r.board];
  if (c.length < 5) return p.hand[0].r === p.hand[1].r ? HN[1] : HN[0];
  let b = null;
  if (c.length === 5) b = ev5(c);
  else if (c.length === 6) {
    for (let i = 0; i < 6; i++) {
      const v = ev5(c.filter((_, k) => k !== i));
      if (!b || cmp(v, b) > 0) b = v;
    }
  } else b = best(c);
  return HN[b[0]];
}

/* ---------- المحرك ---------- */
function createEngine(hooks = {}, timing = {}) {
  const T = { turn: 10000, next: 6500, end: 9000, grace: 60000, idle: 30 * 60000, ...timing };
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
    call('onClose', r, why);
  }

  // المنظّم: اللي أنشأ الطاولة من الموقع (لو طلع من اللوبي ينتقل مؤقتاً لأول لاعب)
  function hostOf(r) {
    const h = r.meta && r.meta.hostPid;
    if (!h) return null;
    return r.players.some(x => x.id === h) ? h : (r.players[0] ? r.players[0].id : null);
  }

  function view(r, me) {
    const sd = r.phase === 'showdown' && r.reveal;
    return {
      code: r.code, phase: r.phase, host: hostOf(r), by: (r.meta && r.meta.creatorName) || '', me: me.id, bb: r.bb,
      ticket: r.ticket, win: r.win, board: r.board, cur: r.cur, minRaise: r.minRaise,
      pot: r.players.reduce((s, p) => s + p.tot, 0),
      turn: r.players[r.turn] ? r.players[r.turn].id : undefined,
      left: Math.max(0, r.deadline - Date.now()), msg: r.msg,
      mh: (me.in && me.hand.length && r.phase !== 'lobby') ? myHand(r, me) : '',
      players: r.players.map((p, i) => {
        const show = p === me || (sd && p.in && !p.folded);
        return {
          id: p.id, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allin: p.allin, in: p.in,
          dealer: i === r.dealer, win: p.win || 0,
          hand: p.hand.length ? (show ? p.hand : [0, 0]) : [],
          hn: (sd && p.in && !p.folded && p.score) ? HN[p.score[0]] : ''
        };
      })
    };
  }
  function send(r) {
    touch(r);
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
    r.deck = newDeck(); r.board = []; r.msg = ''; r.reveal = false;
    r.dealer = nxt(r, r.dealer, p => p.in);
    const sb = n === 2 ? r.dealer : nxt(r, r.dealer, p => p.in), bbI = nxt(r, sb, p => p.in);
    r.players.forEach(p => { if (p.in) p.hand = [r.deck.pop(), r.deck.pop()]; });
    pay(r.players[sb], Math.floor(r.bb / 2)); pay(r.players[bbI], r.bb);
    r.cur = r.bb; r.minRaise = r.bb; r.phase = 'preflop'; r.turn = bbI;
    step(r);
  }

  function turnStart(r) {
    clearTimeout(r.t);
    const p = r.players[r.turn];
    r.deadline = Date.now() + T.turn;
    r.t = setTimeout(() => {
      if (r.players[r.turn] === p) act0(r, p, p.bet < r.cur ? 'fold' : 'check');
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
    r.cur = 0; r.minRaise = r.bb;
    if (r.phase === 'river') return showdown(r);
    r.phase = { preflop: 'flop', flop: 'turn', turn: 'river' }[r.phase];
    for (let i = 0; i < (r.phase === 'flop' ? 3 : 1); i++) r.board.push(r.deck.pop());
    if (canAct(r).length < 2) canAct(r).forEach(p => p.acted = true);
    r.turn = r.dealer; step(r);
  }

  function act0(r, p, type, amt) {
    if (r.players[r.turn] !== p || !['preflop', 'flop', 'turn', 'river'].includes(r.phase)) return;
    const to = r.cur - p.bet;
    if (type === 'fold') p.folded = true;
    else if (type === 'check' || type === 'call') pay(p, to);
    else if (type === 'allin' || type === 'raise') {
      const mx = p.chips + p.bet;
      let t = type === 'allin' ? mx : Math.floor(+amt || 0);
      t = Math.max(Math.min(t, mx), Math.min(r.cur + r.minRaise, mx));
      if (t <= r.cur) pay(p, to);
      else {
        const inc = t - r.cur;
        pay(p, t - p.bet);
        if (inc >= r.minRaise) r.minRaise = inc;
        r.cur = t;
        r.players.forEach(o => { if (o !== p) o.acted = false; });
      }
    } else return;
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
    r.msg = ws.map(p => p.name + ' فاز بـ ' + p.win.toLocaleString('en') + (fold ? '' : ' (' + HN[p.score[0]] + ')')).join(' • ');
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
  function createRoom({ ticket, win, meta } = {}) {
    ticket = Math.floor(+ticket); win = Math.floor(+win);
    if (!(ticket >= 20 && ticket <= 1e9)) throw new GameError('تذكرة الدخول لازم تكون من 20 إلى 1,000,000,000');
    if (!(win > ticket && win <= 1e12)) throw new GameError('رصيد الفوز لازم يكون أكبر من تذكرة الدخول');
    if (rooms.size >= 200) throw new GameError('فيه طاولات كثيرة الحين، جرّب بعد شوي');
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(code));
    const r = {
      code, meta: meta || {}, players: [], phase: 'lobby', board: [], cur: 0, minRaise: 0,
      bb: Math.max(2, Math.round(ticket / 200) * 2), ticket, win, turn: -1, dealer: -1, deadline: 0,
      msg: '', t: null, gc: null, hands: 0, startedAt: 0, lastWinner: null, over: false, reveal: false
    };
    rooms.set(code, r);
    touch(r);
    return r;
  }

  function join(r, sid, pid, name) {
    let p = r.players.find(x => x.id === pid);
    if (p) { p.sid = sid; p.left = false; p.leftAt = 0; send(r); return p; } // رجوع لنفس المقعد
    if (r.phase !== 'lobby') throw new GameError('اللعبة بدأت — ما تقدر تنضم الحين');
    if (!name) throw new GameError('اكتب اسمك');
    if (r.players.length >= MAX) throw new GameError('الطاولة ممتلئة (الحد ' + MAX + ')');
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

  function start(r) {
    if (r.phase !== 'lobby') throw new GameError('اللعبة جارية');
    if (r.players.filter(p => p.chips > 0).length < 3) throw new GameError('لازم 3 لاعبين على الأقل');
    r.startedAt = Date.now(); r.hands = 0; r.lastWinner = null;
    startHand(r);
    changed(r);
  }

  function act(r, pid, type, amount) {
    const p = r.players.find(x => x.id === pid);
    if (p && !p.left) act0(r, p, type, amount);
  }

  return { rooms, createRoom, join, leave, start, act, destroy, view, hostOf };
}

module.exports = { createEngine, GameError, ev5, best, cmp };

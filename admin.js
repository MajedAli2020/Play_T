'use strict';
// لوحة التحكم — مربوطة بآيدي ديسكورد واحد فقط (ADMIN_ID).
// الدخول: الأمر /admin في ديسكورد يعطي رابط دخول لمرة وحدة (5 دقائق) لصاحب الآيدي فقط.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const express = require('express');
const CONFIG = require('./config');
const { GameError } = require('./game');

const LOGS = path.join(__dirname, 'logs');
const rnd = n => crypto.randomBytes(n).toString('hex');
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function parseCookies(h) {
  const o = {};
  String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}

function attach({ app, io, engine, cfg, getBot, adminId, port }) {
  const sessions = new Map(); // token -> expiry
  const links = new Map();    // one-time login token -> expiry
  const fails = new Map();    // ip -> [timestamps]
  const audit = [];
  const SESSION_MS = 12 * 3600e3, LINK_MS = 5 * 60e3;
  const base = () => (cfg.baseUrl || 'http://localhost:' + port).replace(/\/+$/, '');
  const secure = () => /^https:/.test(cfg.baseUrl || '');

  setInterval(() => {
    const n = Date.now();
    for (const [k, v] of sessions) if (v < n) sessions.delete(k);
    for (const [k, v] of links) if (v < n) links.delete(k);
    for (const [k, v] of fails) { const f = v.filter(t => n - t < 60e3); f.length ? fails.set(k, f) : fails.delete(k); }
  }, 60e3).unref();

  function issueLink(userId) {
    if (!adminId || String(userId) !== String(adminId)) return null;
    const t = rnd(24);
    links.set(t, Date.now() + LINK_MS);
    return base() + '/admin/login?t=' + t;
  }
  const hasSession = cookieHeader => {
    const t = parseCookies(cookieHeader).adm;
    const e = t && sessions.get(t);
    return !!e && e > Date.now();
  };
  const limited = ip => { const f = fails.get(ip) || []; return f.length >= 8; };
  const fail = ip => { const f = fails.get(ip) || []; f.push(Date.now()); fails.set(ip, f); };

  const page = (title, body) => '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title +
    '</title><body style="font-family:Tahoma,sans-serif;background:#0e1122;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:380px;padding:28px;text-align:center;border:2px solid #8a6a2c;border-radius:16px;background:#1c130d">' + body + '</div></body></html>';

  app.use('/admin', (q, s, n) => { s.set('Cache-Control', 'no-store'); s.set('X-Frame-Options', 'DENY'); s.set('Referrer-Policy', 'no-referrer'); n(); });

  app.get('/admin/login', (q, s) => {
    const t = String(q.query.t || '');
    if (!links.has(t) || links.get(t) < Date.now()) return s.status(403).send(page('منتهي', '<h2>الرابط منتهي أو مستخدم</h2><p>اكتب <b>/admin</b> في ديسكورد للحصول على رابط جديد.</p>'));
    s.send(page('دخول', '<h2>لوحة التحكم</h2><p>اضغط للدخول</p><form method="post" action="/admin/login"><input type="hidden" name="t" value="' + t.replace(/[^a-f0-9]/g, '') +
      '"><button style="font:inherit;font-weight:800;padding:12px 28px;border-radius:12px;border:0;background:#e7b84b;color:#3a2400;cursor:pointer">دخول</button></form>'));
  });
  app.post('/admin/login', express.urlencoded({ extended: false, limit: '1kb' }), (q, s) => {
    const ip = q.ip;
    if (limited(ip)) return s.status(429).send(page('كثير', '<h2>محاولات كثيرة</h2>'));
    const t = String((q.body && q.body.t) || '');
    const exp = links.get(t);
    if (!exp || exp < Date.now()) { fail(ip); return s.status(403).send(page('منتهي', '<h2>الرابط منتهي أو مستخدم</h2>')); }
    links.delete(t);
    const sid = rnd(32);
    sessions.set(sid, Date.now() + SESSION_MS);
    s.setHeader('Set-Cookie', 'adm=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + SESSION_MS / 1000 + (secure() ? '; Secure' : ''));
    s.redirect('/admin');
  });
  app.post('/admin/logout', (q, s) => {
    const t = parseCookies(q.headers.cookie).adm;
    if (t) sessions.delete(t);
    s.setHeader('Set-Cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    s.redirect('/');
  });
  app.get('/admin', (q, s) => {
    if (!hasSession(q.headers.cookie)) return s.status(403).send(page('ممنوع', '<h2>🔒 للإدارة فقط</h2><p>اكتب <b>/admin</b> في ديسكورد لتحصل على رابط الدخول.</p>'));
    s.sendFile(path.join(__dirname, 'admin', 'admin.html'));
  });

  /* ---------- السوكت ---------- */
  const ns = io.of('/admin');
  ns.use((s, next) => {
    const o = s.handshake.headers.origin;
    if (o) { try { if (new URL(o).host !== s.handshake.headers.host) return next(new Error('origin')); } catch (_) { return next(new Error('origin')); } }
    if (!hasSession(s.handshake.headers.cookie)) return next(new Error('unauthorized'));
    next();
  });

  const winners = () => {
    try {
      return fs.readFileSync(path.join(LOGS, 'winners.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-150).reverse().map(l => JSON.parse(l));
    } catch (_) { return []; }
  };
  const logAdmin = (cmd, a) => {
    const e = { at: new Date().toISOString(), cmd, code: a && a.code, pid: a && a.pid };
    audit.unshift(e); audit.length = Math.min(audit.length, 100);
    try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'admin.jsonl'), JSON.stringify({ ...e, args: a }) + '\n'); } catch (_) { /* */ }
  };

  const A = engine.admin;
  const ROOM = {
    settings: (r, a) => A.settings(r, a), message: (r, a) => A.message(r, a.text), rename: (r, a) => A.rename(r, a.pid, a.name),
    setHost: (r, a) => A.setHost(r, a.pid), setChips: (r, a) => A.setChips(r, a.pid, a.chips), kick: (r, a) => A.kick(r, a.pid, !!a.ban),
    act: (r, a) => A.act(r, a.pid, a.type, a.amount), skip: r => A.skipTurn(r), addTime: (r, a) => A.addTime(r, a.sec),
    pause: r => A.pause(r), resume: r => A.resume(r), forceStart: r => A.forceStart(r), nextHand: r => A.nextHand(r),
    lobby: (r, a) => A.toLobby(r, a.msg), winner: (r, a) => A.declareWinner(r, a.pid), close: r => A.close(r, 'admin'),
    cards: (r, a) => A.setCards(r, { pid: a.pid, hand: a.hand, board: a.board })
  };

  const summary = () => [...engine.rooms.values()].map(r => ({
    code: r.code, phase: r.phase, paused: !!r.paused, n: r.players.length, on: r.players.filter(p => !p.left).length,
    ticket: r.ticket, win: r.win, by: (r.meta && (r.meta.creatorName || r.meta.creatorId)) || '', hands: r.hands,
    pot: r.players.reduce((s, p) => s + p.tot, 0)
  }));
  const stats = () => {
    const bot = getBot();
    return { uptime: Math.round(process.uptime()), mem: Math.round(process.memoryUsage().rss / 1048576), clients: io.engine.clientsCount, bot: bot ? bot.status() : null, node: process.version };
  };

  ns.on('connection', s => {
    let cnt = 0;
    const rl = setInterval(() => { cnt = 0; }, 1000);
    s.emit('hello', { schema: CONFIG.SCHEMA, values: cfg, audit, adminId, base: base() });
    s.on('watch', c => { s.data.watch = String(c || '').toUpperCase().slice(0, 8); });
    s.on('disconnect', () => clearInterval(rl));

    s.on('cmd', async (name, a, ack) => {
      if (typeof ack !== 'function') return;
      if (++cnt > 20) return ack({ ok: false, error: 'بطّئ شوي' });
      if (!hasSession(s.handshake.headers.cookie)) return ack({ ok: false, error: 'انتهت الجلسة — ادخل من جديد' });
      a = a && typeof a === 'object' ? a : {};
      try {
        let out = null;
        if (name.startsWith('room:')) {
          const f = ROOM[name.slice(5)];
          const r = engine.rooms.get(String(a.code || '').toUpperCase());
          if (!f) throw new Error('أمر غير معروف');
          if (!r) throw new GameError('الطاولة غير موجودة');
          f(r, a);
        } else if (name === 'create') {
          const r = engine.createRoom({ ticket: a.ticket ?? cfg.defaultTicket, win: a.win ?? Math.floor((a.ticket ?? cfg.defaultTicket) * cfg.winMult), meta: { creatorName: 'الإدارة', source: 'admin', admin: true } });
          out = { code: r.code };
        } else if (name === 'closeAll') {
          [...engine.rooms.values()].forEach(r => engine.destroy(r, 'admin'));
        } else if (name === 'settings:set') {
          out = CONFIG.update(cfg, a.patch);
        } else if (name === 'settings:reset') {
          CONFIG.reset(cfg); out = cfg;
        } else if (name === 'unban') {
          cfg.bannedPids = cfg.bannedPids.filter(x => x !== a.pid); CONFIG.save(cfg);
        } else if (name === 'winners') {
          out = winners();
        } else if (name === 'bot:say') {
          const bot = getBot();
          if (!bot) throw new GameError('البوت مو شغّال');
          await bot.say(String(a.text || '').slice(0, 1800));
        } else throw new Error('أمر غير معروف');
        if (name !== 'winners') logAdmin(name, a);
        ack({ ok: true, out });
        if (name === 'settings:set' || name === 'settings:reset' || name === 'unban') ns.emit('values', cfg);
      } catch (e) {
        if (!(e instanceof GameError)) console.error('admin cmd ' + name + ':', e.message);
        ack({ ok: false, error: e.message || 'خطأ' });
      }
    });
  });

  // بث حيّ كل ثانية (فقط لو فيه أحد فاتح اللوحة)
  setInterval(() => {
    if (!ns.sockets.size) return;
    const rooms = summary(), st = stats();
    for (const s of ns.sockets.values()) {
      s.emit('tick', { rooms, stats: st });
      const r = s.data.watch && engine.rooms.get(s.data.watch);
      s.emit('room', r ? A.snapshot(r) : null);
    }
  }, 1000).unref();

  return { issueLink };
}

module.exports = { attach };

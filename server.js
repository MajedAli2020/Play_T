'use strict';
require('dotenv').config();
const path = require('path'), fs = require('fs'), http = require('http');
const express = require('express'), { Server } = require('socket.io');
const { createEngine, GameError } = require('./game');

const PORT = process.env.PORT || 3000;
const app = express(), srv = http.createServer(app), io = new Server(srv);
let bot = null;

/* لوق محلي احتياطي لكل مباراة تنتهي (بالإضافة لإرسالها في ديسكورد) */
function logWinner(s) {
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, 'logs', 'winners.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...s }) + '\n');
  } catch (e) { console.error('winner log failed:', e.message); }
}

const engine = createEngine({
  push: (sid, st) => io.to(sid).emit('state', st),
  onEnd: s => { logWinner(s); if (bot) bot.onEnd(s); },
  onChange: r => { if (bot) bot.onChange(r); },
  onClose: (r, why) => {
    io.to(r.code).emit('closed', 'الطاولة انتهت' + (why === 'idle' ? ' بسبب عدم النشاط' : ''));
    if (bot) bot.onClose(r, why);
  }
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/r/:c', (q, s) => s.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (q, s) => s.json({ ok: true, rooms: engine.rooms.size, bot: !!bot }));

/* بدون توكن ديسكورد: روابط تجربة محلية فقط */
if (!process.env.DISCORD_TOKEN) {
  console.warn('⚠️  DISCORD_TOKEN غير موجود — شغّال بوضع التجربة (/dev/new) بدون بوت ولا لوق ديسكورد');
  app.get('/dev/new', (q, s) => {
    try { s.redirect('/r/' + engine.createRoom({ ticket: +q.query.ticket || 10000, win: +q.query.win || 30000, meta: { creatorName: 'تجربة' } }).code); }
    catch (e) { s.status(400).send(e.message); }
  });
  app.get('/dev/start/:c', (q, s) => {
    const r = engine.rooms.get(String(q.params.c).toUpperCase());
    if (!r) return s.status(404).send('no room');
    try { engine.start(r); s.send('started'); } catch (e) { s.status(400).send(e.message); }
  });
}

/* ---------- السوكت ---------- */
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 14);
const cleanPid = p => (/^[\w-]{8,64}$/.test(String(p || '')) ? String(p) : null);

io.on('connection', s => {
  let room = null, pid = null, cnt = 0;
  const rl = setInterval(() => { cnt = 0; }, 1000);
  const on = (ev, fn) => s.on(ev, d => {
    if (++cnt > 30) return; // حماية من الإغراق
    try { fn(d && typeof d === 'object' ? d : {}); }
    catch (e) { if (e instanceof GameError) s.emit('err', e.message); else console.error('socket ' + ev + ':', e); }
  });

  on('join', d => {
    if (room) return;
    const r = engine.rooms.get(String(d.code || '').trim().toUpperCase().slice(0, 8));
    if (!r) throw new GameError('الغرفة غير موجودة');
    const id = cleanPid(d.pid) || s.id;
    engine.join(r, s.id, id, cleanName(d.name));
    room = r; pid = id; s.join(r.code);
  });
  on('act', d => { if (room) engine.act(room, pid, d.type, d.amount); });
  s.on('disconnect', () => {
    clearInterval(rl);
    try { if (room) engine.leave(room, pid, s.id); } catch (e) { console.error('disconnect:', e); }
  });
});

if (process.env.DISCORD_TOKEN) {
  try {
    bot = require('./bot').start({
      engine, token: process.env.DISCORD_TOKEN,
      baseUrl: (process.env.BASE_URL || 'http://localhost:' + PORT).replace(/\/+$/, ''),
      logChannelId: process.env.LOG_CHANNEL_ID || '1552271543579574283',
      guildId: process.env.GUILD_ID || ''
    });
  } catch (e) { console.error('تعذّر تشغيل البوت:', e.message); }
}

process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
srv.listen(PORT, () => console.log('Poker on :' + PORT));

'use strict';
require('dotenv').config();
const path = require('path'), fs = require('fs'), http = require('http');
const express = require('express'), { Server } = require('socket.io');
const { createEngine, GameError } = require('./game');
const CONFIG = require('./config');

const ADMIN_ID = process.env.ADMIN_ID || '1241144201199226965';

const PORT = process.env.PORT || 3000;
const cfg = CONFIG.load({ baseUrl: process.env.BASE_URL, logChannelId: process.env.LOG_CHANNEL_ID });
const app = express(), srv = http.createServer(app), io = new Server(srv);
let bot = null;

/* لوق محلي احتياطي لكل مباراة تنتهي (بالإضافة لإرسالها في ديسكورد) */
function logWinner(s) {
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, 'logs', 'winners.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...s }) + '\n');
  } catch (e) { console.error('winner log failed:', e.message); }
}

const ROOMS_FILE = path.join(__dirname, 'data', 'rooms.json');
let saveT = null;
function saveRooms() {
  try {
    fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true });
    fs.writeFileSync(ROOMS_FILE + '.tmp', JSON.stringify(engine.exportRooms()));
    fs.renameSync(ROOMS_FILE + '.tmp', ROOMS_FILE);
  } catch (e) { console.error('rooms save failed:', e.message); }
}
function scheduleSave() { if (!saveT) saveT = setTimeout(() => { saveT = null; saveRooms(); }, 1000); }

const engine = createEngine({
  push: (sid, st) => io.to(sid).emit('state', st),
  onEnd: s => { logWinner(s); if (bot) bot.onEnd(s); },
  onChange: r => { if (bot) bot.onChange(r); },
  onDirty: () => scheduleSave(),
  onKick: (r, p, ban) => { if (p.sid) io.to(p.sid).emit('closed', ban ? 'تم حظرك من اللعبة' : 'تم طردك من الطاولة'); },
  onClose: (r, why) => {
    io.to(r.code).emit('closed', 'الطاولة انتهت' + (why === 'idle' ? ' بسبب عدم النشاط' : why === 'admin' ? ' — أغلقتها الإدارة' : ''));
    if (bot) bot.onClose(r, why);
  }
}, {}, cfg);

try {
  const n = engine.importRooms(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')));
  if (n) console.log('♻️  رجّعت ' + n + ' طاولة بعد إعادة التشغيل');
} catch (_) { /* أول تشغيل */ }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveRooms(); process.exit(0); });

/* إعدادات الواجهة العامة (بدون أي شي سري) */
app.get('/config.json', (q, s) => s.json({
  title: cfg.title, accent: cfg.accent, defaultTicket: cfg.defaultTicket, winMult: cfg.winMult, minPlayers: cfg.minPlayers,
  minTicket: cfg.minTicket, maxPlayers: cfg.maxPlayers, adminLogin: !!process.env.DISCORD_CLIENT_SECRET, allowWebCreate: cfg.allowWebCreate, maintenance: cfg.maintenance, maintenanceMsg: cfg.maintenanceMsg
}));

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
  on('create', d => {
    if (room) return;
    const name = cleanName(d.name);
    if (!name) throw new GameError('اكتب اسمك');
    const id = cleanPid(d.pid) || s.id;
    if (!cfg.allowWebCreate) throw new GameError('إنشاء الطاولات من الموقع مقفل — استخدم /poker في ديسكورد');
    const r = engine.createRoom({ ticket: d.ticket, win: d.win, maxPlayers: +d.players || 4, minPlayers: +d.players || 4, meta: { creatorName: name, hostPid: id, source: 'web' } });
    try { engine.join(r, s.id, id, name); } catch (e) { engine.destroy(r, 'error'); throw e; }
    room = r; pid = id; s.join(r.code);
  });
  on('start', () => {
    if (!room) return;
    const h = engine.hostOf(room);
    if (!h) throw new GameError('المنظّم يبدأ اللعبة من ديسكورد');
    if (h !== pid) throw new GameError('بس المنظّم يقدر يبدأ اللعبة');
    engine.start(room);
  });
  on('act', d => { if (room) engine.act(room, pid, d.type, d.amount); });
  s.on('disconnect', () => {
    clearInterval(rl);
    try { if (room) engine.leave(room, pid, s.id); } catch (e) { console.error('disconnect:', e); }
  });
});

/* لوحة التحكم — مربوطة بآيدي ديسكورد واحد */
const adminPanel = require('./admin').attach({ app, io, engine, cfg, getBot: () => bot, adminId: ADMIN_ID, port: PORT });

if (process.env.DISCORD_TOKEN) {
  try {
    if (!cfg.baseUrl) cfg.baseUrl = 'http://localhost:' + PORT;
    bot = require('./bot').start({
      engine, cfg, token: process.env.DISCORD_TOKEN, guildId: process.env.GUILD_ID || '',
      adminId: ADMIN_ID, issueAdminLink: adminPanel.issueLink
    });
  } catch (e) { console.error('تعذّر تشغيل البوت:', e.message); }
}
// رابط دخول احتياطي في الكونسول (صالح 5 دقائق، لمرة وحدة) — لو الأمر /admin ما ظهر
setTimeout(() => { const l = adminPanel.issueLink(ADMIN_ID); if (l) console.log('🔑 رابط دخول لوحة التحكم (5 دقائق، مرة وحدة):', l); }, 2500);

process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
srv.listen(PORT, () => console.log('Poker on :' + PORT));

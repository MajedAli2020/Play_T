'use strict';
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags, PermissionFlagsBits, escapeMarkdown
} = require('discord.js');

const fmt = n => Number(n).toLocaleString('en');
const safe = s => escapeMarkdown(String(s)).replace(/[<>]/g, '').replace(/@/g, '@\u200b').slice(0, 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REASON = { target: 'وصل لهدف الفوز', last: 'بقي آخر لاعب معه رصيد', forfeit: 'انسحاب باقي اللاعبين' };
const EPH = MessageFlags.Ephemeral;

function start({ engine, token, baseUrl, logChannelId, guildId }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const panels = new Map(); // code -> { message, timer }

  if (/localhost|127\.0\.0\.1/.test(baseUrl))
    console.warn('⚠️  BASE_URL يشير للجهاز المحلي — اللاعبين ما راح يقدرون يفتحون الرابط. حط رابط السيرفر العام في .env');

  const command = new SlashCommandBuilder()
    .setName('poker').setDescription('افتح طاولة بوكر جديدة')
    .addIntegerOption(o => o.setName('ticket').setDescription('تذكرة الدخول (رصيد كل لاعب) — الافتراضي 10000').setMinValue(20).setMaxValue(1000000000))
    .addIntegerOption(o => o.setName('win').setDescription('رصيد الفوز (يفوز أول من يوصله) — الافتراضي ثلاثة أضعاف التذكرة').setMinValue(40).setMaxValue(1000000000000));

  /* ---------- لوحة الطاولة (الرسالة اللي فيها الأزرار) ---------- */
  function panel(room) {
    const lobby = room.phase === 'lobby';
    const names = room.players.filter(p => !p.left).map(p => safe(p.name));
    let status;
    if (!lobby) status = '🎲 اللعبة جارية — اليد رقم ' + room.hands;
    else status = (room.lastWinner ? '🏆 آخر فائز: **' + safe(room.lastWinner.name) + '**\n' : '') +
      (names.length >= 3 ? 'جاهزين — المنظّم يضغط «ابدأ»' : 'بانتظار اللاعبين — يلزم 3 على الأقل');
    const embed = new EmbedBuilder().setColor(0xe7b84b)
      .setTitle('♠️ رويال بوكر — طاولة ' + room.code)
      .setDescription(status)
      .addFields(
        { name: 'المنظّم', value: '<@' + room.meta.creatorId + '>', inline: true },
        { name: 'تذكرة الدخول', value: fmt(room.ticket), inline: true },
        { name: 'هدف الفوز', value: fmt(room.win), inline: true },
        { name: 'اللاعبين (' + names.length + '/8)', value: names.length ? names.join('، ') : '—' }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🎮 ادخل الطاولة').setURL(baseUrl + '/r/' + room.code),
      new ButtonBuilder().setCustomId('pk:start:' + room.code).setStyle(ButtonStyle.Success)
        .setLabel(lobby ? '▶️ ابدأ اللعبة' : '🎲 جارية').setDisabled(!lobby)
    );
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
  }
  function closedPanel(room, why) {
    const embed = new EmbedBuilder().setColor(0x555555)
      .setTitle('♠️ طاولة ' + room.code + ' — انتهت')
      .setDescription(why === 'idle' ? 'أُغلقت الطاولة بسبب عدم النشاط.' : 'أُغلقت الطاولة.' + (room.lastWinner ? '\n🏆 آخر فائز: **' + safe(room.lastWinner.name) + '**' : ''));
    return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
  }
  function refresh(room) { // تأخير بسيط عشان ما نضغط على ديسكورد
    const p = panels.get(room.code);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => p.message.edit(panel(room)).catch(e => console.error('panel edit:', e.message)), 1500);
  }

  /* ---------- الأوامر والأزرار ---------- */
  async function onPoker(i) {
    const ticket = i.options.getInteger('ticket') ?? 10000;
    const win = i.options.getInteger('win') ?? ticket * 3;
    let room;
    try {
      room = engine.createRoom({
        ticket, win,
        meta: { creatorId: i.user.id, creatorName: i.member?.displayName || i.user.username, channelId: i.channelId }
      });
    } catch (e) { return i.reply({ content: '❌ ' + e.message, flags: EPH }); }
    await i.reply(panel(room));
    panels.set(room.code, { message: await i.fetchReply(), timer: null });
  }

  async function onStart(i) {
    const room = engine.rooms.get(i.customId.split(':')[2]);
    if (!room) return i.reply({ content: 'هذي الطاولة انتهت.', flags: EPH });
    const ok = i.user.id === room.meta.creatorId || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!ok) return i.reply({ content: 'بس منظّم الطاولة يقدر يبدأ اللعبة.', flags: EPH });
    try { engine.start(room); } catch (e) { return i.reply({ content: '❌ ' + e.message, flags: EPH }); }
    await i.update(panel(room));
  }

  client.once(Events.ClientReady, async c => {
    console.log('✅ بوت ديسكورد شغّال: ' + c.user.tag);
    try {
      if (guildId) await c.application.commands.set([command.toJSON()], guildId);
      else await c.application.commands.set([command.toJSON()]);
      console.log('✅ تم تسجيل الأمر /poker' + (guildId ? ' (سيرفر محدد)' : ' (عام — قد يتأخر حتى ساعة)'));
    } catch (e) { console.error('فشل تسجيل الأوامر:', e.message); }
  });

  client.on(Events.InteractionCreate, async i => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'poker') await onPoker(i);
      else if (i.isButton() && i.customId.startsWith('pk:start:')) await onStart(i);
    } catch (e) {
      console.error('interaction error:', e);
      try {
        const m = { content: '❌ صار خطأ، جرّب مرة ثانية.', flags: EPH };
        if (i.replied || i.deferred) await i.followUp(m); else await i.reply(m);
      } catch (_) { /* ignore */ }
    }
  });
  client.on(Events.Error, e => console.error('discord client error:', e.message));

  /* ---------- لوق الفائزين ---------- */
  async function sendLog(s) {
    const medals = ['🥇', '🥈', '🥉'];
    const board = s.standings.slice(0, 8).map((p, k) => (medals[k] || '▫️') + ' ' + safe(p.name) + ' — ' + fmt(p.chips)).join('\n');
    const embed = new EmbedBuilder().setColor(0xe7b84b)
      .setTitle('🏆 نهاية مباراة بوكر')
      .setDescription('الفائز: **' + safe(s.winner.name) + '** برصيد **' + fmt(s.winner.chips) + '**')
      .addFields(
        { name: 'الطاولة', value: s.code, inline: true },
        { name: 'المنظّم', value: s.meta && s.meta.creatorId ? '<@' + s.meta.creatorId + '>' : '—', inline: true },
        { name: 'اللاعبين', value: String(s.players), inline: true },
        { name: 'تذكرة الدخول', value: fmt(s.ticket), inline: true },
        { name: 'هدف الفوز', value: fmt(s.win), inline: true },
        { name: 'الأيدي / المدة', value: s.hands + ' / ' + Math.max(1, Math.round(s.durationMs / 60000)) + ' د', inline: true },
        { name: 'سبب الانتهاء', value: REASON[s.reason] || '—' },
        { name: 'الترتيب النهائي', value: board || '—' }
      ).setTimestamp();
    for (let a = 1; a <= 3; a++) {
      try {
        const ch = await client.channels.fetch(logChannelId);
        if (!ch || !ch.isTextBased()) throw new Error('القناة غير صالحة أو البوت ما يشوفها');
        await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
      } catch (e) {
        console.error('فشل إرسال اللوق (محاولة ' + a + '): ' + e.message);
        if (a < 3) await sleep(2000 * a);
      }
    }
  }

  client.login(token).catch(e => console.error('فشل تسجيل دخول البوت:', e.message));

  return {
    onEnd: s => { sendLog(s).catch(e => console.error('sendLog:', e)); },
    onChange: room => refresh(room),
    onClose: (room, why) => {
      const p = panels.get(room.code);
      if (!p) return;
      clearTimeout(p.timer); panels.delete(room.code);
      p.message.edit(closedPanel(room, why)).catch(() => {});
    }
  };
}

module.exports = { start };

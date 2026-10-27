'use strict';
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags, PermissionFlagsBits, escapeMarkdown
} = require('discord.js');

const fmt = n => Number(n).toLocaleString('en');
const safe = s => escapeMarkdown(String(s)).replace(/[<>]/g, '').replace(/@/g, '@\u200b').slice(0, 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REASON = { target: 'وصل لهدف الفوز', last: 'بقي آخر لاعب معه رصيد', forfeit: 'انسحاب باقي اللاعبين', admin: 'قرار الإدارة' };
const EPH = MessageFlags.Ephemeral;

function start({ engine, cfg, token, guildId, adminId, issueAdminLink }) {
  const color = () => parseInt(String(cfg.embedColor || '#e7b84b').slice(1), 16);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const panels = new Map(); // code -> { message, timer }

  if (/localhost|127\.0\.0\.1/.test(cfg.baseUrl))
    console.warn('⚠️  BASE_URL يشير للجهاز المحلي — اللاعبين ما راح يقدرون يفتحون الرابط. حط رابط السيرفر العام في .env');

  const command = new SlashCommandBuilder()
    .setName('poker').setDescription('افتح طاولة بوكر جديدة')
    .addIntegerOption(o => o.setName('ticket').setDescription('تذكرة الدخول (رصيد كل لاعب) — الافتراضي 10000').setMinValue(20).setMaxValue(1000000000))
    .addIntegerOption(o => o.setName('players').setDescription('أقصى عدد لاعبين في الطاولة (2-12)').setMinValue(2).setMaxValue(12))
    .addIntegerOption(o => o.setName('min').setDescription('أقل عدد لاعبين لبدء اللعبة (2-12)').setMinValue(2).setMaxValue(12))
    .addIntegerOption(o => o.setName('win').setDescription('رصيد الفوز (يفوز أول من يوصله) — الافتراضي ثلاثة أضعاف التذكرة').setMinValue(40).setMaxValue(1000000000000));
  const adminCommand = new SlashCommandBuilder().setName('admin').setDescription('لوحة التحكم (للمالك فقط)');

  /* ---------- لوحة الطاولة (الرسالة اللي فيها الأزرار) ---------- */
  function panel(room) {
    const lobby = room.phase === 'lobby';
    const names = room.players.filter(p => !p.left).map(p => safe(p.name));
    let status;
    if (!lobby) status = '🎲 اللعبة جارية — اليد رقم ' + room.hands;
    else status = (room.lastWinner ? '🏆 آخر فائز: **' + safe(room.lastWinner.name) + '**\n' : '') +
      (names.length >= (room.minPlayers || cfg.minPlayers) ? 'جاهزين — المنظّم يضغط «ابدأ»' : 'بانتظار اللاعبين — يلزم ' + (room.minPlayers || cfg.minPlayers) + ' على الأقل');
    const embed = new EmbedBuilder().setColor(color())
      .setTitle(cfg.panelTitle + ' — طاولة ' + room.code)
      .setDescription(status)
      .addFields(
        { name: 'المنظّم', value: '<@' + room.meta.creatorId + '>', inline: true },
        { name: 'تذكرة الدخول', value: fmt(room.ticket), inline: true },
        { name: 'هدف الفوز', value: fmt(room.win), inline: true },
        { name: 'اللاعبين (' + names.length + '/' + (room.maxPlayers || cfg.maxPlayers) + ')', value: names.length ? names.join('، ') : '—' }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🎮 ادخل الطاولة').setURL(cfg.baseUrl + '/r/' + room.code),
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
    if (cfg.pokerAllowedIds.length && !cfg.pokerAllowedIds.includes(i.user.id) && i.user.id !== adminId)
      return i.reply({ content: '❌ ما عندك صلاحية تفتح طاولات.', flags: EPH });
    const ticket = i.options.getInteger('ticket') ?? cfg.defaultTicket;
    const win = i.options.getInteger('win') ?? Math.floor(ticket * cfg.winMult);
    let room;
    try {
      room = engine.createRoom({
        ticket, win, maxPlayers: i.options.getInteger('players'), minPlayers: i.options.getInteger('min'),
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

  async function onAdmin(i) {
    const link = issueAdminLink && issueAdminLink(i.user.id);
    if (!link) return i.reply({ content: '🔒 هذا الأمر للمالك فقط.', flags: EPH });
    await i.reply({
      content: 'رابط لوحة التحكم — صالح 5 دقائق ويشتغل مرة وحدة. لا تشاركه مع أحد.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🛠️ افتح لوحة التحكم').setURL(link))],
      flags: EPH
    });
  }

  client.once(Events.ClientReady, async c => {
    console.log('✅ بوت ديسكورد شغّال: ' + c.user.tag);
    try {
      const cmds = [command.toJSON(), adminCommand.toJSON()];
      // تسجيل لكل سيرفر البوت فيه (فوري). الأوامر العامة تتأخر وتتكرر، فنفضّيها.
      await c.application.commands.set([]);
      for (const g of c.guilds.cache.values()) await g.commands.set(cmds).catch(e => console.error('guild cmds ' + g.id + ':', e.message));
      client.on(Events.GuildCreate, g => g.commands.set(cmds).catch(() => {}));
      console.log('✅ تم تسجيل الأوامر /poker و /admin في ' + c.guilds.cache.size + ' سيرفر');
    } catch (e) { console.error('فشل تسجيل الأوامر:', e.message); }
  });

  client.on(Events.InteractionCreate, async i => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'poker') await onPoker(i);
      else if (i.isChatInputCommand() && i.commandName === 'admin') await onAdmin(i);
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
    const embed = new EmbedBuilder().setColor(color())
      .setTitle(cfg.winTitle)
      .setDescription('الفائز: **' + safe(s.winner.name) + '** برصيد **' + fmt(s.winner.chips) + '**')
      .addFields(
        { name: 'الطاولة', value: s.code, inline: true },
        { name: 'المنظّم', value: s.meta && s.meta.creatorId ? '<@' + s.meta.creatorId + '>' : (s.meta && s.meta.creatorName ? safe(s.meta.creatorName) : '—'), inline: true },
        { name: 'اللاعبين', value: String(s.players), inline: true },
        { name: 'تذكرة الدخول', value: fmt(s.ticket), inline: true },
        { name: 'هدف الفوز', value: fmt(s.win), inline: true },
        { name: 'الأيدي / المدة', value: s.hands + ' / ' + Math.max(1, Math.round(s.durationMs / 60000)) + ' د', inline: true },
        { name: 'سبب الانتهاء', value: REASON[s.reason] || '—' },
        { name: 'الترتيب النهائي', value: board || '—' }
      ).setTimestamp();
    for (let a = 1; a <= 3; a++) {
      try {
        const ch = await client.channels.fetch(cfg.logChannelId);
        if (!ch || !ch.isTextBased()) throw new Error('القناة غير صالحة أو البوت ما يشوفها');
        await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
      } catch (e) {
        console.error('فشل إرسال اللوق (محاولة ' + a + '): ' + e.message);
        if (a < 3) await sleep(2000 * a);
      }
    }
  }

  async function say(text) {
    const ch = await client.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!ch || !ch.isTextBased()) throw new Error('روم اللوق غير صالح أو البوت ما يشوفه');
    await ch.send({ content: text, allowedMentions: { parse: [] } });
  }

  client.login(token).catch(e => console.error('فشل تسجيل دخول البوت:', e.message));

  return {
    say,
    status: () => ({ appId: client.application ? client.application.id : null, ready: client.isReady(), tag: client.user ? client.user.tag : null, guilds: client.guilds.cache.size, ping: client.ws.ping }),
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

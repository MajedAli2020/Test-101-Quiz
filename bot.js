'use strict';
/**
 * بوت ديسكورد (discord.js) — يشتغل كعملية منفصلة:  npm install  ثم  node bot.js
 * يتواصل مع الموقع عبر API داخلي بمفتاح سري، ولا يلمس ملفات البيانات مباشرة.
 *
 * الأوامر:
 *   /نتيجتي                 → يعرض نتيجة المتقدم الأخيرة ومدة الانتظار
 *   /فك-الانتظار @عضو       → للإدارة فقط (صلاحية Manage Server)
 *
 * (إرسال الرسالة الخاصة وإعطاء رتبة النجاح يتم من السيرفر تلقائياً عند انتهاء الاختبار)
 */
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActivityType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const KEY = process.env.INTERNAL_API_KEY;
const SITE = (process.env.SITE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
if (!TOKEN || !GUILD_ID || !KEY) {
  console.error('❌ لازم تضبط DISCORD_BOT_TOKEN و DISCORD_GUILD_ID و INTERNAL_API_KEY في .env (عبّئ ملف .env)');
  process.exit(1);
}

async function site(method, url, body) {
  const r = await fetch(SITE + url, {
    method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('site ' + r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}
const fmtMs = (ms) => `${Math.floor(ms / 60000)} دقيقة و${String(Math.ceil((ms % 60000) / 1000)).padStart(2, '0')} ثانية`;

const commands = [
  new SlashCommandBuilder().setName('نتيجتي').setDescription('اعرض نتيجة اختبار HP1 الأخيرة الخاصة بك'),
  new SlashCommandBuilder().setName('فك-الانتظار').setDescription('فك مدة الانتظار عن متقدم (للإدارة)')
    .addUserOption((o) => o.setName('العضو').setDescription('المتقدم').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] }); // لا يحتاج أي Privileged Intent

client.once('ready', async () => {
  client.user.setActivity('اختبارات HP1 Police Mod', { type: ActivityType.Watching });
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log(`✅ البوت شغّال: ${client.user.tag} — تم تسجيل الأوامر في ${guild.name}`);
});

/* زر «إرسال إشعار للعضو» تحت نتيجة المتقدم في روم النتائج */
async function handleNotifyButton(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const doneRow = (label) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('done').setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(true));
  try {
    const r = await site('POST', '/internal/notify', { submissionId: i.customId.slice('notify:'.length), userId: i.user.id });
    await i.message.edit({ components: [doneRow(`✅ تم إشعار العضو (${r.passed ? 'ناجح' : 'راسب'}) بواسطة ${i.user.displayName || i.user.username}`)] }).catch(() => {});
    return i.editReply(`✅ تم إرسال إشعار ${r.passed ? 'النجاح' : 'الرسوب'} للعضو في الخاص.`);
  } catch (e) {
    if (e.status === 403) return i.editReply('⛔ ما عندك صلاحية (تحتاج الوصول لخانة «نتائج المتقدمين» في لوحة التحكم).');
    if (e.status === 404) return i.editReply('⚠️ هذه النتيجة غير موجودة (ممكن انحذفت من اللوحة).');
    if (e.status === 409) {
      await i.message.edit({ components: [doneRow('✅ تم إشعار العضو مسبقاً')] }).catch(() => {});
      return i.editReply('ℹ️ تم إرسال الإشعار لهذا العضو مسبقاً.');
    }
    if (e.status === 502) return i.editReply('⚠️ تعذر الإرسال — غالباً الخاص مقفل عند العضو أو ما هو في السيرفر. تقدر تكلمه يدوياً.');
    throw e;
  }
}

client.on('interactionCreate', async (i) => {
  if (i.isButton() && i.customId.startsWith('notify:')) {
    return handleNotifyButton(i).catch((e) => {
      console.error(e);
      const msg = '⚠️ تعذر الاتصال بالموقع، حاول لاحقاً.';
      (i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => {});
    });
  }
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'نتيجتي') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const d = await site('GET', `/internal/result?discord=${i.user.id}`);
      if (!d.latest) return i.editReply('ما عندك أي محاولة مسجلة بعد. ادخل الموقع وسجّل دخولك بديسكورد لبدء الاختبار.');
      const l = d.latest;
      const e = new EmbedBuilder().setTitle('نتيجة اختبار HP1 Police Mod').setColor(l.passed ? 0x6fbf73 : 0xd6606c)
        .addFields(
          { name: 'النتيجة', value: `${l.correctCount}/${l.total} (${l.percent}%)`, inline: true },
          { name: 'الحالة', value: l.passed ? '✅ ناجح' : '❌ راسب', inline: true },
          { name: 'عدد المحاولات', value: String(d.attempts), inline: true },
        ).setTimestamp(l.at);
      if (d.locked) e.setFooter({ text: 'إعادة الاختبار غير متاحة (اجتزت الاختبار)' });
      else if (d.remainingMs > 0) e.setFooter({ text: `إعادة الاختبار بعد: ${fmtMs(d.remainingMs)}` });
      return i.editReply({ embeds: [e] });
    }
    if (i.commandName === 'فك-الانتظار') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.editReply('⛔ هذا الأمر للإدارة فقط.');
      const u = i.options.getUser('العضو', true);
      const r = await site('POST', '/internal/reset', { discordId: u.id });
      return i.editReply(r.cleared ? `✅ تم فك الانتظار عن <@${u.id}> (${r.cleared}).` : `ℹ️ <@${u.id}> ما عليه مدة انتظار.`);
    }
  } catch (e) {
    console.error(e);
    const msg = '⚠️ تعذر الاتصال بالموقع، حاول لاحقاً.';
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {}); else i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);

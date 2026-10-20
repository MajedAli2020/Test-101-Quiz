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

const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActivityType, MessageFlags } = require('discord.js');

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
  if (!r.ok) throw new Error('site ' + r.status);
  return r.json();
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

client.on('interactionCreate', async (i) => {
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
      if (!l.passed && d.remainingMs > 0) e.setFooter({ text: `إعادة الاختبار بعد: ${fmtMs(d.remainingMs)}` });
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

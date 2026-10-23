'use strict';
/* تنبيهات إلى روم في ديسكورد (يستخدمها السيرفر والبوت وstart.js). تشتغل حتى لو الموقع واقف لأنها ترسل مباشرة بتوكن البوت */
const fs = require('fs');
const path = require('path');
const common = require('./common');

const ID = /^\d{17,20}$/;
const last = new Map(); // لمنع تكرار نفس التنبيه (سبام)

function alertChannel(root) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(common.dataDir(root).dir, 'config.json'), 'utf8')); } catch {}
  for (const c of [process.env.DISCORD_ALERTS_CHANNEL_ID, cfg.alertsChannelId, cfg.resultsChannelId, process.env.DISCORD_RESULTS_CHANNEL_ID]) {
    if (ID.test(c || '')) return c;
  }
  return '';
}

/* opts: { title, text, color, key, cooldownMs }  ← يرجع true لو انرسل */
async function sendAlert(root, opts) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return false;
  const { title, text = '', color = 0xe74c3c, key = title, cooldownMs = 5 * 60_000 } = opts;
  const now = Date.now();
  if (cooldownMs && last.has(key) && now - last.get(key) < cooldownMs) return false;
  const ch = alertChannel(root);
  if (!ch) return false;
  last.set(key, now);
  // لو حطيت OWNER_ID في .env يمنشنك التنبيه (بدون ما يمنشن غيرك)
  const owner = ID.test(process.env.OWNER_ID || '') ? process.env.OWNER_ID : '';
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${ch}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: owner ? `<@${owner}>` : undefined,
        embeds: [{ title: String(title).slice(0, 250), description: String(text).slice(0, 1800), color, timestamp: new Date().toISOString(), footer: { text: 'HP1 Police Mod | مراقبة الموقع' } }],
        allowed_mentions: owner ? { users: [owner] } : { parse: [] },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('alert send failed', r.status);
    return r.ok;
  } catch (e) { console.error('alert send error:', e.message); return false; }
}
module.exports = { sendAlert, alertChannel };

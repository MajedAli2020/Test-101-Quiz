'use strict';
/**
 * نسخ احتياطي مشفّر لبيانات الموقع داخل روم خاص في ديسكورد (مجاني، بدون قاعدة بيانات).
 * - كل تعديل ← بعد 20 ثانية يُرفع ملف مشفّر (AES-256-GCM) في روم #hp1-data (يُنشأ تلقائياً).
 * - عند تشغيل السيرفر من جديد (Render يمسح الملفات) ← تُسترجع آخر نسخة تلقائياً.
 * المفتاح مشتق من توكن البوت، فالملف ما يُفتح بدونه.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FILE_NAME = 'hp1-backup.bin';
const CHANNEL_NAME = 'hp1-data';
const META = 'backup-meta.json';
const MAX_BYTES = 9.5 * 1024 * 1024; // حد رفع الملفات في ديسكورد (10MB)
const KEEP = 3;

module.exports = function createBackup({ dataDir, uploadDir, token, derive, getGuildId, clientId, discordApi }) {
  const key = Buffer.from(derive(token, 'backup'), 'hex');
  const metaFile = path.join(dataDir, META);
  let timer = null, busy = false, channelId = '';
  const state = { lastAt: 0, ok: null, error: '', size: 0 };
  const auth = { Authorization: 'Bot ' + token };

  const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return {}; } };

  function snapshot() {
    const files = {}, uploads = {};
    for (const f of fs.readdirSync(dataDir)) {
      if (!f.endsWith('.json') || f === META) continue;
      files[f] = fs.readFileSync(path.join(dataDir, f)).toString('base64');
    }
    try { for (const f of fs.readdirSync(uploadDir)) uploads[f] = fs.readFileSync(path.join(uploadDir, f)).toString('base64'); } catch {}
    return { v: 1, savedAt: Date.now(), files, uploads };
  }
  function seal(obj) {
    const raw = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(raw), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }
  function open(buf) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(28)), d.final()])).toString('utf8'));
  }

  async function getChannel(create) {
    if (channelId) return channelId;
    const gid = getGuildId();
    if (!gid) return '';
    const list = await discordApi('GET', `/guilds/${gid}/channels`);
    if (!Array.isArray(list)) return '';
    let c = list.find((x) => x.type === 0 && x.name === CHANNEL_NAME);
    if (!c && create) {
      // روم خاص: مخفي عن الجميع، ظاهر للبوت فقط
      c = await discordApi('POST', `/guilds/${gid}/channels`, {
        name: CHANNEL_NAME, type: 0, topic: 'نسخة احتياطية مشفرة لبيانات الموقع — لا تحذفها',
        permission_overwrites: [{ id: gid, type: 0, deny: '1024' }, { id: clientId, type: 1, allow: '101376' }],
      });
    }
    channelId = c && c.id ? c.id : '';
    return channelId;
  }
  const backupMessages = async (ch) => {
    const msgs = await discordApi('GET', `/channels/${ch}/messages?limit=50`);
    return Array.isArray(msgs) ? msgs.filter((m) => (m.attachments || []).some((a) => a.filename === FILE_NAME)) : []; // الأحدث أولاً
  };

  async function run() {
    if (busy) return false;
    busy = true;
    try {
      const ch = await getChannel(true);
      if (!ch) throw new Error('ما قدرت أنشئ روم النسخ الاحتياطي. أنشئ روم خاص اسمه hp1-data وأعطِ البوت صلاحية رؤيته وإرسال الملفات.');
      const snap = snapshot();
      const buf = seal(snap);
      if (buf.length > MAX_BYTES) throw new Error('حجم البيانات أكبر من حد ديسكورد (10MB).');
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content: '🗄️ نسخة احتياطية — ' + new Date(snap.savedAt).toISOString(), attachments: [{ id: 0, filename: FILE_NAME }] }));
      fd.append('files[0]', new Blob([buf]), FILE_NAME);
      const r = await fetch(`https://discord.com/api/v10/channels/${ch}/messages`, { method: 'POST', headers: auth, body: fd, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('رفع النسخة فشل (' + r.status + ')');
      fs.writeFileSync(metaFile, JSON.stringify({ savedAt: snap.savedAt }));
      Object.assign(state, { lastAt: snap.savedAt, ok: true, error: '', size: buf.length });
      const old = (await backupMessages(ch)).slice(KEEP);
      for (const m of old) await discordApi('DELETE', `/channels/${ch}/messages/${m.id}`);
      return true;
    } catch (e) {
      Object.assign(state, { ok: false, error: e.message });
      console.error('Backup error:', e.message);
      return false;
    } finally { busy = false; }
  }
  const schedule = (ms = 20_000) => { clearTimeout(timer); timer = setTimeout(run, ms); };

  /* استرجاع آخر نسخة (إذا كانت أحدث من اللي عندنا) */
  async function restore() {
    const ch = await getChannel(false);
    if (!ch) return false;
    const msg = (await backupMessages(ch))[0];
    if (!msg) return false;
    const att = msg.attachments.find((a) => a.filename === FILE_NAME);
    const r = await fetch(att.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('تحميل النسخة فشل (' + r.status + ')');
    const snap = open(Buffer.from(await r.arrayBuffer()));
    if (!snap || snap.v !== 1 || snap.savedAt <= (readMeta().savedAt || 0)) return false;
    for (const [name, b64] of Object.entries(snap.files || {})) {
      if (/^[\w.-]+\.json$/.test(name) && name !== META) fs.writeFileSync(path.join(dataDir, name), Buffer.from(b64, 'base64'));
    }
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const [name, b64] of Object.entries(snap.uploads || {})) {
      if (/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(name)) fs.writeFileSync(path.join(uploadDir, name), Buffer.from(b64, 'base64'));
    }
    fs.writeFileSync(metaFile, JSON.stringify({ savedAt: snap.savedAt }));
    Object.assign(state, { lastAt: snap.savedAt, ok: true, error: '' });
    return true;
  }
  return { schedule, run, restore, state, _seal: seal, _open: open };
};

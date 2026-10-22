'use strict';
/**
 * HP1 Police Mod — server (بدون أي مكتبات خارجية، يحتاج Node 18+)
 *
 *   public/   → الموقع (الوحيد المفتوح للعامة)
 *   private/  → لوحة التحكم + البيانات (لا تُخدم أبداً كملفات ثابتة)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRIVATE_DIR = path.join(ROOT, 'private');
const DATA_DIR = path.join(PRIVATE_DIR, 'data');

/* ---------------------------- .env ---------------------------- */
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT || 3000);
// على الاستضافات (Render وغيرها) يحدد PORT تلقائياً → نستمع على كل الواجهات
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const D = {
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  redirect: process.env.DISCORD_REDIRECT_URI || '',
  botToken: process.env.DISCORD_BOT_TOKEN || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  passRoleId: process.env.DISCORD_PASS_ROLE_ID || '',
};
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';
const LOGIN_ENABLED = !!(D.clientId && D.clientSecret && D.redirect);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === '1'
  : process.env.NODE_ENV === 'production';
const SESSION_HOURS = 4;
// المالك: الوحيد الذي يدخل «إعدادات خاصة» ويدخل اللوحة حتى بدون رول
const OWNER_ID = /^\d{17,20}$/.test(process.env.OWNER_ID || '') ? process.env.OWNER_ID : '1241144201199226965';

const missing = [];
if (SESSION_SECRET.length < 32) missing.push('SESSION_SECRET');
for (const [k, v] of Object.entries({ DISCORD_CLIENT_ID: D.clientId, DISCORD_CLIENT_SECRET: D.clientSecret, DISCORD_REDIRECT_URI: D.redirect,
  DISCORD_BOT_TOKEN: D.botToken, DISCORD_GUILD_ID: D.guildId, DISCORD_ADMIN_ROLE_ID: ADMIN_ROLE_ID })) if (!v) missing.push(k);
if (missing.length) {
  console.error('\n❌ ناقص في ملف .env: ' + missing.join(', ') + '\n');
  process.exit(1);
}

/* ---------------------------- data ---------------------------- */
const FILES = {
  questions: path.join(DATA_DIR, 'questions.json'),
  config: path.join(DATA_DIR, 'config.json'),
  submissions: path.join(DATA_DIR, 'submissions.json'),
  owner: path.join(DATA_DIR, 'owner.json'),
};
const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJSON = (f, data) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
};
const getQuestions = () => readJSON(FILES.questions, []);
const getConfig = () => ({ passPercent: 60, retryMinutes: 60, ...readJSON(FILES.config, {}) });
const getSubmissions = () => readJSON(FILES.submissions, []);
/* إعدادات المالك: رولات دخول اللوحة (لو ما انحفظت تُستخدم DISCORD_ADMIN_ROLE_ID) + رقم نسخة يُلغي جلسات الإدارة القديمة عند التغيير */
const getOwnerCfg = () => {
  const c = readJSON(FILES.owner, {});
  return { adminRoleIds: Array.isArray(c.adminRoleIds) ? c.adminRoleIds : null, version: Number(c.version) || 1 };
};
const getAdminRoleIds = () => {
  const c = getOwnerCfg();
  return c.adminRoleIds !== null ? c.adminRoleIds : (ADMIN_ROLE_ID ? [ADMIN_ROLE_ID] : []);
};

/* ---------------------------- helpers ---------------------------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/* rate limiter بسيط في الذاكرة */
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) b = { n: 0, reset: now + windowMs };
  b.n++;
  buckets.set(key, b);
  return { ok: b.n <= limit, retryMs: b.reset - now };
}
const peek = (key) => {
  const b = buckets.get(key);
  return b && b.reset > Date.now() ? b : null;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
}, 60_000).unref();

/* جلسة الأدمن: كوكي موقّع، تُصدر فقط لمن يملك رول الإدارة في السيرفر */
function makeSession(u) {
  const payload = b64u(JSON.stringify({ u: u.id, name: u.name, v: getOwnerCfg().version, exp: Date.now() + SESSION_HOURS * 3600_000 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(req) {
  const m = /(?:^|;\s*)hp1_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEq(sig, good)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!(d.exp > Date.now() && /^\d{17,20}$/.test(d.u))) return null;
    d.isOwner = d.u === OWNER_ID;
    // لو المالك غيّر الرولات، جلسات الإدارة القديمة تنتهي (المالك مستثنى)
    if (!d.isOwner && d.v !== getOwnerCfg().version) return null;
    return d;
  } catch { return null; }
}
const cookie = (value, maxAgeSec) =>
  `hp1_admin=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
  (SECURE_COOKIE ? '; Secure' : '');

/* جلسة المتقدّم (تسجيل الدخول بديسكورد) — كوكي موقّع بمفتاح مستقل عن الأدمن */
const USER_KEY = crypto.createHmac('sha256', SESSION_SECRET).update('user-session').digest();
const userCookie = (value, maxAgeSec) =>
  `hp1_user=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` + (SECURE_COOKIE ? '; Secure' : '');
function makeUserSession(u) {
  const payload = b64u(JSON.stringify({ id: u.id, name: u.name, avatar: u.avatar, exp: Date.now() + 7 * 86400_000 }));
  return `${payload}.${crypto.createHmac('sha256', USER_KEY).update(payload).digest('base64url')}`;
}
function readUser(req) {
  const m = /(?:^|;\s*)hp1_user=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  if (!safeEq(sig, crypto.createHmac('sha256', USER_KEY).update(payload).digest('base64url'))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() && /^\d{17,20}$/.test(d.id) ? d : null;
  } catch { return null; }
}

/* Discord REST (بوت) */
async function discordApi(method, apiPath, body) {
  try {
    const r = await fetch('https://discord.com/api/v10' + apiPath, {
      method, headers: { Authorization: 'Bot ' + D.botToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.error('Discord API', method, apiPath.replace(/\d{17,20}/g, '<id>'), r.status); return null; }
    return r.status === 204 ? {} : await r.json();
  } catch (e) { console.error('Discord API error:', e.message); return null; }
}
async function notifyApplicant(sub) {
  if (!D.botToken) return;
  if (sub.passed && D.guildId && D.passRoleId) await discordApi('PUT', `/guilds/${D.guildId}/members/${sub.discordId}/roles/${D.passRoleId}`);
  const dm = await discordApi('POST', '/users/@me/channels', { recipient_id: sub.discordId });
  if (!dm) return;
  const mins = getConfig().retryMinutes;
  await discordApi('POST', `/channels/${dm.id}/messages`, { content: sub.passed
    ? `🎉 مبروك! اجتزت اختبار **HP1 Police Mod** بنسبة **${sub.percent}%**.\nسيتم مراجعة طلبك من الإدارة والتواصل معك قريباً.`
    : `❌ للأسف لم تجتز اختبار **HP1 Police Mod** (نسبتك ${sub.percent}%).\nيمكنك إعادة الاختبار بعد ${mins} دقيقة.` });
}

/* responses */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const ext = path.extname(file).toLowerCase();
  // منع الخروج من public + منع الملفات المخفية + السماح بالامتدادات المعروفة فقط
  if (!file.startsWith(PUBLIC_DIR + path.sep) || rel.split('/').some((p) => p.startsWith('.')) || !MIME[ext]) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const headers = { ...SEC_HEADERS, 'Content-Type': MIME[ext], 'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------------------- quiz logic ---------------------------- */
function remainingCooldown(discordId) {
  const { retryMinutes } = getConfig();
  const ms = retryMinutes * 60_000;
  let last = 0;
  for (const s of getSubmissions()) if (s.discordId === discordId && !s.passed && !s.cooldownCleared && s.at > last) last = s.at;
  return Math.max(0, last + ms - Date.now());
}

async function postToDiscord(sub) {
  if (!WEBHOOK) return;
  const chunks = []; let buf = '';
  sub.details.forEach((d, i) => {
    const block = `**${i + 1}) ${d.question}**\n• الإجابة: ${d.chosen ?? 'لم تتم الإجابة'} ${d.ok ? '✅' : '❌'}\n• الصحيحة: ${d.correct}\n\n`;
    if ((buf + block).length > 3800) { chunks.push(buf); buf = ''; }
    buf += block;
  });
  if (buf) chunks.push(buf);
  const color = sub.passed ? 0x6fbf73 : 0xd6606c;
  const embeds = [{
    title: 'طلب تفعيل - HP1 Police Mod', color,
    fields: [
      { name: 'المتقدم', value: sub.name.slice(0, 100) || '-', inline: true },
      { name: 'العمر', value: String(sub.age), inline: true },
      { name: 'Discord', value: `<@${sub.discordId}>` + (sub.username ? ` (${sub.username})` : ''), inline: true },
      { name: 'النتيجة', value: `${sub.correctCount}/${sub.total} (${sub.percent}%)`, inline: true },
      { name: 'الحالة', value: sub.passed ? '✅ اجتاز الاختبار' : '❌ لم يجتز الاختبار', inline: true },
    ],
    footer: { text: 'HP1 Police Mod | نظام الإدارة' }, timestamp: new Date(sub.at).toISOString(),
  }];
  chunks.forEach((c, i) => embeds.push({ title: i === 0 ? 'تفاصيل الإجابات' : `تفاصيل الإجابات (${i + 1})`, description: c, color }));
  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: embeds.slice(0, 10), allowed_mentions: { users: [sub.discordId] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('Discord webhook status', r.status);
  } catch (e) { console.error('Discord webhook error:', e.message); }
}

function clearCooldown(id) {
  let cleared = 0;
  const all = getSubmissions().map((x) => {
    if (x.discordId === id && !x.passed && !x.cooldownCleared) { cleared++; return { ...x, cooldownCleared: true }; }
    return x;
  });
  writeJSON(FILES.submissions, all);
  return cleared;
}

async function handleSubmit(req, res) {
  const ip = clientIp(req);
  const rl = hit('submit:' + ip, 15, 3600_000);
  if (!rl.ok) return json(res, 429, { error: 'محاولات كثيرة، حاول لاحقاً.' });

  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const user = readUser(req);
  if (!user) return json(res, 401, { error: 'سجّل الدخول بحساب ديسكورد أولاً.' });
  const discordId = user.id; // موثَّق من ديسكورد، لا يُؤخذ من المتصفح
  const age = Number(body.age);
  if (!name || name.length > 60) return json(res, 400, { error: 'الاسم غير صالح.' });
  if (!Number.isInteger(age) || age < 10 || age > 99) return json(res, 400, { error: 'العمر غير صالح.' });
  if (!Array.isArray(body.answers) || body.answers.length > 200) return json(res, 400, { error: 'إجابات غير صالحة.' });

  const left = remainingCooldown(discordId);
  if (left > 0) return json(res, 429, { error: 'إعادة الاختبار غير متاحة الآن.', remainingMs: left });

  const questions = getQuestions();
  if (!questions.length) return json(res, 503, { error: 'لا توجد أسئلة.' });
  const given = new Map(body.answers.map((a) => [String(a && a.id), a && typeof a.answer === 'string' ? a.answer : null]));

  let correctCount = 0;
  const details = questions.map((q) => {
    const a = given.get(q.id);
    const valid = a !== null && q.options.includes(a);
    const ok = valid && a === q.options[q.correct];
    if (ok) correctCount++;
    return { question: q.question, chosen: valid ? a : null, correct: q.options[q.correct], ok };
  });
  const total = questions.length;
  const percent = Math.round((correctCount / total) * 100);
  const passed = percent >= getConfig().passPercent;

  const sub = { id: crypto.randomUUID(), at: Date.now(), name, discordId, username: user.name, age, correctCount, total, percent, passed, details };
  const all = getSubmissions(); all.push(sub);
  writeJSON(FILES.submissions, all.slice(-5000));
  postToDiscord(sub); // لا ننتظرهما
  notifyApplicant(sub);

  return json(res, 200, { correctCount, total, percent, passed });
}

/* ---------------------------- admin API ---------------------------- */
function validateQuestions(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 300) throw new Error('قائمة الأسئلة غير صالحة (1-300 سؤال).');
  const used = new Set();
  return list.map((q, i) => {
    const question = String(q.question || '').trim();
    const options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
    const correct = Number(q.correct);
    if (!question || question.length > 500) throw new Error(`السؤال ${i + 1}: نص غير صالح.`);
    if (options.length < 2 || options.length > 8 || options.some((o) => o.length > 300)) throw new Error(`السؤال ${i + 1}: يجب أن يحتوي بين 2 و 8 خيارات.`);
    if (new Set(options).size !== options.length) throw new Error(`السؤال ${i + 1}: توجد خيارات مكررة.`);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error(`السؤال ${i + 1}: الإجابة الصحيحة غير محددة.`);
    let id = typeof q.id === 'string' && /^[\w-]{1,40}$/.test(q.id) && !used.has(q.id) ? q.id : 'q' + crypto.randomBytes(4).toString('hex');
    used.add(id);
    return { id, question, options, correct };
  });
}

async function handleAdminApi(req, res, pathname, url) {
  const ip = clientIp(req);

  // ما بعد هذه النقطة: يتطلب تسجيل دخول
  const session = readSession(req);
  if (!session) return json(res, 401, { error: 'غير مصرّح.' });

  if (req.method !== 'GET') {
    // حماية CSRF: ترويسة مخصصة + فحص الـ Origin
    if (req.headers['x-requested-with'] !== 'hp1-admin') return json(res, 403, { error: 'طلب مرفوض.' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'طلب مرفوض.' });
  }

  if (pathname === '/admin/api/me' && req.method === 'GET') {
    return json(res, 200, { id: session.u, name: session.name, isOwner: session.isOwner });
  }

  /* ---- إعدادات خاصة: للمالك فقط (يُفحص هنا في السيرفر، مو في الواجهة) ---- */
  if (pathname.startsWith('/admin/api/owner/')) {
    if (!session.isOwner) return json(res, 403, { error: 'هذه الخانة للمالك فقط.' });
    if (pathname === '/admin/api/owner/roles' && req.method === 'GET') {
      const list = await discordApi('GET', `/guilds/${D.guildId}/roles`);
      const roles = Array.isArray(list)
        ? list.filter((r) => r.id !== D.guildId).sort((a, b) => b.position - a.position)
            .map((r) => ({ id: r.id, name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }))
        : null; // null = تعذّر جلب رولات السيرفر
      return json(res, 200, { roles, selected: getAdminRoleIds(), isDefault: getOwnerCfg().adminRoleIds === null });
    }
    if (pathname === '/admin/api/owner/roles' && req.method === 'PUT') {
      const b = await readBody(req, 8192);
      if (!Array.isArray(b.roleIds) || b.roleIds.length > 25) return json(res, 400, { error: 'قائمة الرولات غير صالحة (حد أقصى 25).' });
      const ids = [...new Set(b.roleIds.map(String))];
      if (ids.some((x) => !/^\d{17,20}$/.test(x))) return json(res, 400, { error: 'أيدي رول غير صالح.' });
      const list = await discordApi('GET', `/guilds/${D.guildId}/roles`);
      if (Array.isArray(list)) {
        const known = new Set(list.map((r) => r.id));
        const unknown = ids.filter((x) => !known.has(x));
        if (unknown.length) return json(res, 400, { error: 'رول غير موجود في السيرفر: ' + unknown.join(', ') });
      }
      writeJSON(FILES.owner, { adminRoleIds: ids, version: getOwnerCfg().version + 1 });
      console.log('Admin roles changed by owner:', ids.length, 'roles');
      return json(res, 200, { ok: true, selected: ids });
    }
    return json(res, 404, { error: 'غير موجود.' });
  }

  if (pathname === '/admin/api/logout' && req.method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (pathname === '/admin/api/questions') {
    if (req.method === 'GET') return json(res, 200, getQuestions());
    if (req.method === 'PUT') {
      const body = await readBody(req, 1024 * 1024);
      try { const clean = validateQuestions(body); writeJSON(FILES.questions, clean); return json(res, 200, clean); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
  }
  if (pathname === '/admin/api/config') {
    if (req.method === 'GET') return json(res, 200, getConfig());
    if (req.method === 'PUT') {
      const b = await readBody(req, 4096);
      const passPercent = Number(b.passPercent), retryMinutes = Number(b.retryMinutes);
      if (!Number.isInteger(passPercent) || passPercent < 1 || passPercent > 100) return json(res, 400, { error: 'نسبة النجاح من 1 إلى 100.' });
      if (!Number.isInteger(retryMinutes) || retryMinutes < 0 || retryMinutes > 10080) return json(res, 400, { error: 'مدة الانتظار من 0 إلى 10080 دقيقة.' });
      writeJSON(FILES.config, { passPercent, retryMinutes });
      return json(res, 200, getConfig());
    }
  }
  if (pathname === '/admin/api/submissions' && req.method === 'GET') {
    return json(res, 200, getSubmissions().slice().reverse());
  }
  const del = /^\/admin\/api\/submissions\/([\w-]{1,64})$/.exec(pathname);
  if (del && req.method === 'DELETE') {
    const all = getSubmissions();
    writeJSON(FILES.submissions, all.filter((s) => s.id !== del[1]));
    return json(res, 200, { ok: true });
  }
  if (pathname === '/admin/api/cooldown/reset' && req.method === 'POST') {
    const b = await readBody(req, 4096);
    const id = String(b.discordId || '');
    if (!/^\d{17,20}$/.test(id)) return json(res, 400, { error: 'أيدي غير صالح.' });
    const cleared = clearCooldown(id);
    return json(res, 200, { ok: true, cleared });
  }
  return json(res, 404, { error: 'غير موجود.' });
}

/* ---------------------------- router ---------------------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;

    /* ---- لوحة التحكم ---- */
    if (pathname === '/admin' || pathname === '/admin/') {
      const page = readSession(req) ? 'admin.html' : 'login.html';
      return send(res, 200, fs.readFileSync(path.join(PRIVATE_DIR, page)), {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
      });
    }
    if (pathname.startsWith('/admin/api/')) {
      const g = hit('api:' + clientIp(req), 300, 60_000);
      if (!g.ok) return json(res, 429, { error: 'طلبات كثيرة.' });
      return await handleAdminApi(req, res, pathname, url);
    }
    if (pathname.startsWith('/admin')) return send(res, 404, 'Not found');

    /* ---- تسجيل الدخول بديسكورد ---- */
    if (pathname === '/auth/discord' && req.method === 'GET') {
      if (!LOGIN_ENABLED) return send(res, 503, 'Discord login not configured');
      const state = crypto.randomBytes(16).toString('hex');
      const purpose = url.searchParams.get('next') === 'admin' ? 'a' : 'u';
      const q = new URLSearchParams({ client_id: D.clientId, redirect_uri: D.redirect, response_type: 'code', scope: 'identify', state });
      return send(res, 302, '', { Location: 'https://discord.com/oauth2/authorize?' + q,
        'Set-Cookie': `hp1_oauth=${state}.${purpose}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600` + (SECURE_COOKIE ? '; Secure' : '') });
    }
    if (pathname === '/auth/callback' && req.method === 'GET') {
      if (!hit('oauth:' + clientIp(req), 30, 600_000).ok) return send(res, 429, 'Too many requests');
      const clear = `hp1_oauth=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`;
      let purpose = 'u';
      const fail = () => send(res, 302, '', { Location: purpose === 'a' ? '/admin?denied=1' : '/?login=failed', 'Set-Cookie': clear });
      const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
      const m = /(?:^|;\s*)hp1_oauth=([a-f0-9]{32})\.([au])/.exec(req.headers.cookie || '');
      if (m) purpose = m[2];
      if (!LOGIN_ENABLED || !code || !m || !safeEq(m[1], state)) return fail();
      try {
        const tr = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
          body: new URLSearchParams({ client_id: D.clientId, client_secret: D.clientSecret, grant_type: 'authorization_code', code, redirect_uri: D.redirect }),
        });
        if (!tr.ok) throw new Error('token ' + tr.status);
        const { access_token } = await tr.json();
        const ur = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bearer ' + access_token }, signal: AbortSignal.timeout(8000) });
        if (!ur.ok) throw new Error('user ' + ur.status);
        const u = await ur.json();
        const name = String(u.global_name || u.username || '').slice(0, 60);
        const cookies = [clear, userCookie(makeUserSession({ id: u.id, name, avatar: u.avatar || '' }), 7 * 86400)];
        if (purpose === 'a') {
          // الدخول للوحة: يجب أن يملك العضو رول الإدارة في السيرفر (يُفحص عبر البوت)
          if (u.id !== OWNER_ID) {
            const allowed = getAdminRoleIds();
            const member = await discordApi('GET', `/guilds/${D.guildId}/members/${u.id}`);
            if (!member || !Array.isArray(member.roles) || !member.roles.some((r) => allowed.includes(r))) {
              console.warn('Admin login denied for', u.id);
              return fail();
            }
          }
          cookies.push(cookie(makeSession({ id: u.id, name }), SESSION_HOURS * 3600));
          return send(res, 302, '', { Location: '/admin', 'Set-Cookie': cookies });
        }
        return send(res, 302, '', { Location: '/?login=ok', 'Set-Cookie': cookies });
      } catch (e) { console.error('OAuth error:', e.message); return fail(); }
    }
    if (pathname === '/auth/me' && req.method === 'GET') {
      const u = readUser(req);
      return json(res, 200, { enabled: LOGIN_ENABLED, loggedIn: !!u, ...(u ? { id: u.id, name: u.name,
        avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null } : {}) });
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': userCookie('', 0) });
    }

    /* ---- API داخلية للبوت (مفتاح سري) ---- */
    if (pathname.startsWith('/internal/')) {
      const key = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!INTERNAL_KEY || INTERNAL_KEY.length < 32 || !safeEq(key, INTERNAL_KEY)) return json(res, 401, { error: 'غير مصرّح.' });
      if (pathname === '/internal/result' && req.method === 'GET') {
        const id = String(url.searchParams.get('discord') || '');
        if (!/^\d{17,20}$/.test(id)) return json(res, 400, { error: 'أيدي غير صالح.' });
        const mine = getSubmissions().filter((x) => x.discordId === id);
        const l = mine[mine.length - 1];
        return json(res, 200, { latest: l ? { at: l.at, percent: l.percent, correctCount: l.correctCount, total: l.total, passed: l.passed } : null,
          attempts: mine.length, remainingMs: remainingCooldown(id) });
      }
      if (pathname === '/internal/reset' && req.method === 'POST') {
        const b = await readBody(req, 4096); const id = String(b.discordId || '');
        if (!/^\d{17,20}$/.test(id)) return json(res, 400, { error: 'أيدي غير صالح.' });
        return json(res, 200, { ok: true, cleared: clearCooldown(id) });
      }
      return json(res, 404, { error: 'غير موجود.' });
    }

    /* ---- API العامة للكويز ---- */
    if (pathname === '/api/quiz' && req.method === 'GET') {
      const { passPercent, retryMinutes } = getConfig();
      return json(res, 200, {
        passPercent, retryMinutes,
        questions: getQuestions().map(({ id, question, options }) => ({ id, question, options })), // بدون الإجابات الصحيحة
      });
    }
    if (pathname === '/api/cooldown' && req.method === 'GET') {
      const u = readUser(req);
      return json(res, 200, { remainingMs: u ? remainingCooldown(u.id) : 0 });
    }
    if (pathname === '/api/submit' && req.method === 'POST') return await handleSubmit(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'غير موجود.' });

    /* ---- الموقع ---- */
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e && e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) return json(res, 500, { error: 'خطأ في السيرفر.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ HP1 server يعمل على http://${HOST}:${PORT}   (لوحة التحكم: /admin)`);
  if (!WEBHOOK) console.log('ℹ️  DISCORD_WEBHOOK_URL غير مضبوط — النتائج تُحفظ في اللوحة فقط.');
});
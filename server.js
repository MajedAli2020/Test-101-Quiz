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
const RESULTS_CHANNEL = /^\d{17,20}$/.test(process.env.DISCORD_RESULTS_CHANNEL_ID || '') ? process.env.DISCORD_RESULTS_CHANNEL_ID : '';
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
  site: path.join(DATA_DIR, 'site.json'),
  perms: path.join(DATA_DIR, 'perms.json'),
};
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJSON = (f, data) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
};
const getQuestions = () => readJSON(FILES.questions, []);
/* نصوص الإشعار الافتراضية — المتغيرات: {name} {mention} {percent} {correct} {total} {pass_percent} {minutes} */
const DEFAULT_PASS_MSG = '🎉 مبروك! اجتزت اختبار **HP1 Police Mod** بنسبة **{percent}%**.\nسيتم مراجعة طلبك من الإدارة والتواصل معك قريباً.';
const DEFAULT_FAIL_MSG = '❌ للأسف لم تجتز اختبار **HP1 Police Mod** (نسبتك {percent}%).\nيمكنك إعادة الاختبار بعد {minutes} دقيقة.';
const getConfig = () => ({ passPercent: 60, retryMinutes: 60, resultsChannelId: '', passMessage: DEFAULT_PASS_MSG, failMessage: DEFAULT_FAIL_MSG, ...readJSON(FILES.config, {}) });
/* روم النتائج: من الإعدادات في اللوحة، وإن ما انضبط يُستخدم DISCORD_RESULTS_CHANNEL_ID من .env */
const getResultsChannel = () => { const c = getConfig().resultsChannelId; return /^\d{17,20}$/.test(c || '') ? c : RESULTS_CHANNEL; };
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

/* ---- خانات اللوحة + صلاحية كل خانة (يحددها المالك) ---- */
const TABS = ['questions', 'settings', 'subs', 'site'];
// perms.json: { [tab]: [roleIds] }  — الخانة بدون قيد = كل من يدخل اللوحة
const getPerms = () => {
  const p = readJSON(FILES.perms, {});
  const out = {};
  for (const t of TABS) out[t] = Array.isArray(p[t]) ? p[t].filter((x) => /^\d{17,20}$/.test(x)) : null;
  return out;
};
const tabForPath = (p) =>
  p === '/admin/api/questions' ? 'questions'
  : p === '/admin/api/config' || p === '/admin/api/channels' ? 'settings'
  : p === '/admin/api/submissions' || p.startsWith('/admin/api/submissions/') || p === '/admin/api/cooldown/reset' ? 'subs'
  : p.startsWith('/admin/api/site') ? 'site' : null;

/* رولات العضو من ديسكورد عبر البوت (كاش قصير) */
const memberCache = new Map();
async function memberRoles(id) {
  const c = memberCache.get(id);
  if (c && c.exp > Date.now()) return c.roles;
  const m = await discordApi('GET', `/guilds/${D.guildId}/members/${id}`);
  const roles = m && Array.isArray(m.roles) ? m.roles : null; // null = مو في السيرفر / تعذّر الجلب
  memberCache.set(id, { roles, exp: Date.now() + (roles ? 45_000 : 20_000) });
  if (memberCache.size > 2000) memberCache.clear();
  return roles;
}
async function isAdminUser(id) {
  if (id === OWNER_ID) return true;
  const roles = await memberRoles(id);
  const allowed = getAdminRoleIds();
  return !!roles && roles.some((r) => allowed.includes(r));
}
/* خريطة {tab: true/false} لما يقدر يفتحه هذا المستخدم */
async function tabAccess(userId) {
  const res = {};
  if (userId === OWNER_ID) { for (const t of TABS) res[t] = true; return res; }
  const roles = await memberRoles(userId);
  const admin = !!roles && roles.some((r) => getAdminRoleIds().includes(r));
  const perms = getPerms();
  for (const t of TABS) res[t] = admin && (perms[t] === null || perms[t].some((r) => roles.includes(r)));
  return res;
}

/* ---- محتوى الموقع (قوانين + تواصل) ---- */
const getSite = () => {
  const s = readJSON(FILES.site, {});
  return { rules: Array.isArray(s.rules) ? s.rules : [], contacts: Array.isArray(s.contacts) ? s.contacts : [],
    staff: Array.isArray(s.staff) ? s.staff : [], quizIntro: s.quizIntro && typeof s.quizIntro === 'object' ? s.quizIntro : null };
};
const IMG_RE = /^\/(?:uploads\/)?[\w.-]{1,80}\.(?:png|jpe?g|webp|gif)$/i;
const str = (v, max, what) => {
  const t = String(v ?? '').trim();
  if (t.length > max) throw new Error(`${what}: أطول من ${max} حرف.`);
  return t;
};
const newId = (used, given) => {
  const id = typeof given === 'string' && /^[\w-]{1,40}$/.test(given) && !used.has(given) ? given : 'x' + crypto.randomBytes(4).toString('hex');
  used.add(id); return id;
};
function validateRules(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 12) throw new Error('عدد أقسام القوانين من 1 إلى 12.');
  const used = new Set();
  return list.map((c, i) => {
    const title = str(c.title, 40, `القسم ${i + 1}`);
    if (!title) throw new Error(`القسم ${i + 1}: اكتب اسم القسم.`);
    const rules = (Array.isArray(c.rules) ? c.rules : []).map((r) => str(r, 1000, `قانون في «${title}»`)).filter(Boolean);
    if (rules.length > 300) throw new Error(`«${title}»: الحد 300 قانون.`);
    const intro = (Array.isArray(c.intro) ? c.intro : []).map((r) => str(r, 1000, `ملاحظة في «${title}»`)).filter(Boolean);
    if (intro.length > 10) throw new Error(`«${title}»: الحد 10 ملاحظات.`);
    return { id: newId(used, c.id), title, intro, highlight: str(c.highlight, 300, `سطر مميز في «${title}»`), rules };
  });
}
function validateContacts(list) {
  if (!Array.isArray(list) || list.length > 24) throw new Error('الحد الأقصى 24 وسيلة تواصل.');
  const used = new Set();
  return list.map((c, i) => {
    const name = str(c.name, 60, `التواصل ${i + 1}`);
    if (!name) throw new Error(`التواصل ${i + 1}: الاسم مطلوب.`);
    const url = str(c.url, 300, `رابط «${name}»`);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`رابط «${name}» يجب أن يبدأ بـ https://`);
    const image = str(c.image, 120, `صورة «${name}»`);
    if (image && !IMG_RE.test(image)) throw new Error(`صورة «${name}» غير صالحة.`);
    return { id: newId(used, c.id), name, description: str(c.description, 300, `وصف «${name}»`), url, buttonText: str(c.buttonText, 30, `زر «${name}»`), image };
  });
}
const STAFF_STYLES = ['featured', 'cols1', 'cols2', 'cols3'];
function validateStaff(list) {
  if (!Array.isArray(list) || list.length > 12) throw new Error('الحد الأقصى 12 قسم في الطاقم الإداري.');
  const used = new Set();
  return list.map((t, i) => {
    const style = STAFF_STYLES.includes(t.style) ? t.style : 'cols3';
    const title = str(t.title, 80, `القسم ${i + 1}`);
    const members = (Array.isArray(t.members) ? t.members : []).map((m, j) => {
      const name = str(m.name, 80, `عضو ${j + 1} في «${title || 'القسم ' + (i + 1)}»`);
      if (!name) throw new Error(`عضو ${j + 1} في «${title || 'القسم ' + (i + 1)}»: الاسم مطلوب.`);
      const image = str(m.image, 120, `صورة «${name}»`);
      if (image && !IMG_RE.test(image)) throw new Error(`صورة «${name}» غير صالحة.`);
      return { id: newId(used, m.id), name, role: str(m.role, 80, `رتبة «${name}»`), description: str(m.description, 300, `وصف «${name}»`), image };
    });
    if (members.length > 40) throw new Error('الحد الأقصى 40 عضو في القسم.');
    return { id: newId(used, t.id), title, style, members };
  });
}
function validateQuizIntro(b) {
  const paragraphs = (Array.isArray(b.paragraphs) ? b.paragraphs : []).map((x) => str(x, 1000, 'فقرة التعليمات')).filter(Boolean);
  if (paragraphs.length > 12) throw new Error('الحد الأقصى 12 فقرة.');
  const durationMinutes = Number(b.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180) throw new Error('مدة الاختبار من 1 إلى 180 دقيقة.');
  return { title: str(b.title, 100, 'العنوان'), paragraphs, startMessage: str(b.startMessage, 120, 'رسالة البداية'),
    agreeText: str(b.agreeText, 150, 'نص الموافقة'), durationMinutes };
}
/* يحذف الصور اللي ما عاد أحد يستخدمها (مع مهلة ساعة عشان الصور المرفوعة وما انحفظت بعد) */
function pruneUploads() {
  const site = getSite();
  const imgs = [...site.contacts.map((c) => c.image), ...site.staff.flatMap((t) => (t.members || []).map((m) => m.image))];
  const keep = new Set(imgs.filter((x) => typeof x === 'string' && x.startsWith('/uploads/')).map((x) => x.slice(9)));
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const fp = path.join(UPLOAD_DIR, f);
      if (!keep.has(f) && Date.now() - fs.statSync(fp).mtimeMs > 3600_000) fs.unlinkSync(fp);
    }
  } catch (e) { console.error('prune', e.message); }
}
const IMG_TYPES = [
  { ext: 'png', ok: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', ok: (b) => b.length > 6 && /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  { ext: 'webp', ok: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

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
/* رتبة الناجح (تلقائي). الرسالة الخاصة ما تنرسل تلقائياً — تنرسل بزر الإشعار في روم النتائج */
async function grantPassRole(sub) {
  if (sub.passed && D.botToken && D.guildId && D.passRoleId) await discordApi('PUT', `/guilds/${D.guildId}/members/${sub.discordId}/roles/${D.passRoleId}`);
}
function renderMessage(tpl, sub) {
  const cfg = getConfig();
  const vars = { name: sub.name, mention: `<@${sub.discordId}>`, percent: sub.percent, correct: sub.correctCount, total: sub.total, pass_percent: cfg.passPercent, minutes: cfg.retryMinutes };
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)).slice(0, 2000);
}
async function sendNotice(sub) {
  const cfg = getConfig();
  const content = renderMessage(sub.passed ? cfg.passMessage : cfg.failMessage, sub);
  const dm = await discordApi('POST', '/users/@me/channels', { recipient_id: sub.discordId });
  if (!dm) return false;
  return !!(await discordApi('POST', `/channels/${dm.id}/messages`, { content, allowed_mentions: { parse: [] } }));
}
const notifying = new Set();

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
function serveStatic(req, res, pathname, baseDir = PUBLIC_DIR) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(baseDir, rel));
  const ext = path.extname(file).toLowerCase();
  // منع الخروج من المجلد + منع الملفات المخفية + السماح بالامتدادات المعروفة فقط
  if (!file.startsWith(baseDir + path.sep) || rel.split('/').some((p) => p.startsWith('.')) || !MIME[ext]) {
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

/* إرسال نتيجة الاختبار لروم الإدارة عن طريق البوت (إيمبد أخضر للناجح / أحمر للراسب) */
async function postToDiscord(sub, avatar) {
  const channelId = getResultsChannel();
  if (!channelId) return;
  const color = sub.passed ? 0x2ecc71 : 0xe74c3c;
  const chunks = []; let buf = '';
  sub.details.forEach((d, i) => {
    const block = `**${i + 1}) ${d.question}**\n• الإجابة: ${d.chosen ?? 'لم تتم الإجابة'} ${d.ok ? '✅' : '❌'}\n• الصحيحة: ${d.correct}\n\n`;
    if ((buf + block).length > 3800) { chunks.push(buf); buf = ''; }
    buf += block;
  });
  if (buf) chunks.push(buf);
  const main = {
    title: (sub.passed ? '✅ ناجح' : '❌ راسب') + ' — طلب تفعيل HP1 Police Mod',
    color,
    fields: [
      { name: '👤 المتقدم', value: sub.name.slice(0, 100) || '-', inline: true },
      { name: '🎂 العمر', value: String(sub.age), inline: true },
      { name: '🪪 ديسكورد', value: `<@${sub.discordId}>\n\`${sub.discordId}\`` + (sub.username ? `\n${sub.username}` : ''), inline: true },
      { name: '📊 النتيجة', value: `${sub.correctCount}/${sub.total} (**${sub.percent}%**)`, inline: true },
      { name: '🎯 نسبة النجاح المطلوبة', value: getConfig().passPercent + '%', inline: true },
      { name: '📌 الحالة', value: sub.passed ? '🟢 اجتاز الاختبار' : '🔴 لم يجتز الاختبار', inline: true },
    ],
    footer: { text: 'HP1 Police Mod | نظام الإدارة' }, timestamp: new Date(sub.at).toISOString(),
  };
  if (avatar && /^[\w]+$/.test(avatar)) main.thumbnail = { url: `https://cdn.discordapp.com/avatars/${sub.discordId}/${avatar}.png?size=128` };
  const path_ = `/channels/${channelId}/messages`;
  const allowed = { allowed_mentions: { parse: [] } }; // بدون منشن فعلي (المنشن داخل الإيمبد يظهر بدون إزعاج)
  const button = { type: 2, style: sub.passed ? 3 : 4, custom_id: 'notify:' + sub.id,
    label: sub.passed ? '📩 إرسال إشعار النجاح للعضو' : '📩 إرسال إشعار الرسوب للعضو' };
  await discordApi('POST', path_, { embeds: [main], components: [{ type: 1, components: [button] }], ...allowed });
  for (let i = 0; i < chunks.length && i < 6; i++) {
    await discordApi('POST', path_, { embeds: [{ title: i === 0 ? 'تفاصيل الإجابات' : `تفاصيل الإجابات (${i + 1})`, description: chunks[i], color }], ...allowed });
  }
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
  postToDiscord(sub, user.avatar); // لا ننتظرهما
  grantPassRole(sub);

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
    return json(res, 200, { id: session.u, name: session.name, isOwner: session.isOwner, tabs: await tabAccess(session.u) });
  }

  /* صلاحية الخانة: تُفحص في السيرفر عند كل طلب (الرولات من ديسكورد مباشرة) */
  const needTab = tabForPath(pathname);
  if (needTab && !(await tabAccess(session.u))[needTab]) return json(res, 403, { error: '🔒 ما عندك صلاحية لهذه الخانة.', locked: true });

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
    /* صلاحيات الخانات: لكل خانة قائمة رولات (null = كل أصحاب اللوحة) */
    if (pathname === '/admin/api/owner/perms' && req.method === 'GET') return json(res, 200, getPerms());
    const pm = /^\/admin\/api\/owner\/perms\/(\w+)$/.exec(pathname);
    if (pm && req.method === 'PUT') {
      if (!TABS.includes(pm[1])) return json(res, 404, { error: 'خانة غير موجودة.' });
      const b = await readBody(req, 8192);
      let ids = null;
      if (b.roleIds !== null) {
        if (!Array.isArray(b.roleIds) || b.roleIds.length > 25) return json(res, 400, { error: 'قائمة الرولات غير صالحة.' });
        ids = [...new Set(b.roleIds.map(String))];
        if (ids.some((x) => !/^\d{17,20}$/.test(x))) return json(res, 400, { error: 'أيدي رول غير صالح.' });
      }
      const all = getPerms(); all[pm[1]] = ids;
      writeJSON(FILES.perms, all);
      return json(res, 200, { ok: true, perms: all });
    }
    return json(res, 404, { error: 'غير موجود.' });
  }

  /* ---- إعدادات الموقع: القوانين + تواصل معنا ---- */
  if (pathname === '/admin/api/site' && req.method === 'GET') return json(res, 200, getSite());
  if (pathname === '/admin/api/site/rules' && req.method === 'PUT') {
    const b = await readBody(req, 1024 * 1024);
    try { const rules = validateRules(b.rules); writeJSON(FILES.site, { ...getSite(), rules }); return json(res, 200, { rules }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/admin/api/site/contacts' && req.method === 'PUT') {
    const b = await readBody(req, 1024 * 1024);
    try {
      const contacts = validateContacts(b.contacts);
      writeJSON(FILES.site, { ...getSite(), contacts });
      pruneUploads();
      return json(res, 200, { contacts });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/admin/api/site/staff' && req.method === 'PUT') {
    const b = await readBody(req, 1024 * 1024);
    try { const staff = validateStaff(b.staff); writeJSON(FILES.site, { ...getSite(), staff }); pruneUploads(); return json(res, 200, { staff }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/admin/api/site/quiz' && req.method === 'PUT') {
    const b = await readBody(req, 64 * 1024);
    try { const quizIntro = validateQuizIntro(b); writeJSON(FILES.site, { ...getSite(), quizIntro }); return json(res, 200, { quizIntro }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pathname === '/admin/api/site/upload' && req.method === 'POST') {
    const b = await readBody(req, 3 * 1024 * 1024);
    const m = /^data:image\/[\w+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!m) return json(res, 400, { error: 'ملف الصورة غير صالح.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 2 * 1024 * 1024) return json(res, 400, { error: 'حجم الصورة أكبر من 2MB.' });
    const type = IMG_TYPES.find((t) => t.ok(buf));
    if (!type) return json(res, 400, { error: 'الصيغة غير مدعومة (PNG / JPG / GIF / WEBP).' });
    if (fs.readdirSync(UPLOAD_DIR).length > 300) return json(res, 400, { error: 'تراكمت صور كثيرة، احفظ التغييرات أولاً.' });
    const name = crypto.randomBytes(8).toString('hex') + '.' + type.ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return json(res, 200, { url: '/uploads/' + name });
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
  if (pathname === '/admin/api/channels' && req.method === 'GET') {
    const list = await discordApi('GET', `/guilds/${D.guildId}/channels`);
    const channels = Array.isArray(list)
      ? list.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name }))
      : null; // null = تعذّر جلب الرومات
    return json(res, 200, { channels });
  }
  if (pathname === '/admin/api/config') {
    if (req.method === 'GET') return json(res, 200, getConfig());
    if (req.method === 'PUT') {
      const b = await readBody(req, 16384);
      const passPercent = Number(b.passPercent), retryMinutes = Number(b.retryMinutes);
      if (!Number.isInteger(passPercent) || passPercent < 1 || passPercent > 100) return json(res, 400, { error: 'نسبة النجاح من 1 إلى 100.' });
      if (!Number.isInteger(retryMinutes) || retryMinutes < 0 || retryMinutes > 10080) return json(res, 400, { error: 'مدة الانتظار من 0 إلى 10080 دقيقة.' });
      const resultsChannelId = String(b.resultsChannelId || '').trim();
      if (resultsChannelId) {
        if (!/^\d{17,20}$/.test(resultsChannelId)) return json(res, 400, { error: 'أيدي الروم غير صالح.' });
        const list = await discordApi('GET', `/guilds/${D.guildId}/channels`);
        if (Array.isArray(list) && !list.some((c) => c.id === resultsChannelId && (c.type === 0 || c.type === 5))) return json(res, 400, { error: 'هذا الروم غير موجود في السيرفر أو ليس روم كتابي.' });
      }
      const passMessage = String(b.passMessage || '').trim() || DEFAULT_PASS_MSG;
      const failMessage = String(b.failMessage || '').trim() || DEFAULT_FAIL_MSG;
      if (passMessage.length > 1500 || failMessage.length > 1500) return json(res, 400, { error: 'الرسالة أطول من 1500 حرف.' });
      writeJSON(FILES.config, { passPercent, retryMinutes, resultsChannelId, passMessage, failMessage });
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
      const hdr = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
      let page = readSession(req) ? 'admin.html' : 'login.html';
      if (page === 'login.html') {
        // داخل من الموقع وهو مسجّل دخول بديسكورد؟ نتحقق من رولاته ونفتح له اللوحة بدون تسجيل ثاني
        const u = readUser(req);
        if (u && await isAdminUser(u.id)) { page = 'admin.html'; hdr['Set-Cookie'] = cookie(makeSession({ id: u.id, name: u.name }), SESSION_HOURS * 3600); }
      }
      return send(res, 200, fs.readFileSync(path.join(PRIVATE_DIR, page)), hdr);
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
      const isAdmin = u ? await isAdminUser(u.id) : false;
      return json(res, 200, { enabled: LOGIN_ENABLED, loggedIn: !!u, isAdmin, ...(u ? { id: u.id, name: u.name,
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
      if (pathname === '/internal/notify' && req.method === 'POST') {
        const b = await readBody(req, 4096);
        const sid = String(b.submissionId || ''), uid = String(b.userId || '');
        if (!/^[\w-]{1,64}$/.test(sid) || !/^\d{17,20}$/.test(uid)) return json(res, 400, { error: 'bad_request' });
        if (!(await tabAccess(uid)).subs) return json(res, 403, { error: 'forbidden' }); // نفس صلاحية خانة «نتائج المتقدمين» في اللوحة
        const sub = getSubmissions().find((x) => x.id === sid);
        if (!sub) return json(res, 404, { error: 'not_found' });
        if (sub.notifiedAt || notifying.has(sid)) return json(res, 409, { error: 'already', by: sub.notifiedBy || null });
        notifying.add(sid);
        try {
          if (!(await sendNotice(sub))) return json(res, 502, { error: 'dm_failed' });
          const all = getSubmissions(); const i = all.findIndex((x) => x.id === sid); // نعيد القراءة (ممكن تكون تغيّرت أثناء الإرسال)
          if (i >= 0) { all[i] = { ...all[i], notifiedAt: Date.now(), notifiedBy: uid }; writeJSON(FILES.submissions, all); }
          return json(res, 200, { ok: true, passed: sub.passed });
        } finally { notifying.delete(sid); }
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
    if (pathname === '/api/site' && req.method === 'GET') return json(res, 200, getSite(), { 'Cache-Control': 'no-cache' });
    if (pathname === '/api/cooldown' && req.method === 'GET') {
      const u = readUser(req);
      return json(res, 200, { remainingMs: u ? remainingCooldown(u.id) : 0 });
    }
    if (pathname === '/api/submit' && req.method === 'POST') return await handleSubmit(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'غير موجود.' });

    /* ---- الموقع ---- */
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (pathname.startsWith('/uploads/')) return serveStatic(req, res, pathname.slice(8), UPLOAD_DIR);
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e && e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) return json(res, 500, { error: 'خطأ في السيرفر.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ HP1 server يعمل على http://${HOST}:${PORT}   (لوحة التحكم: /admin)`);
  if (!getResultsChannel()) console.log('ℹ️  روم النتائج غير محدد — حدده من اللوحة ← الإعدادات (أو DISCORD_RESULTS_CHANNEL_ID). النتائج تُحفظ في اللوحة فقط حالياً.');
});
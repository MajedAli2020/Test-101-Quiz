'use strict';
// node scripts/setup.js  → ينشئ ملف .env (اسم الأدمن + كلمة السر مشفّرة + مفتاح الجلسات)
const fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const envPath = path.join(__dirname, '..', '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { process.stdout.write(q); const { value } = await lines.next(); return value === undefined ? '' : value; };

(async () => {
  if (fs.existsSync(envPath) && (await ask('.env موجود مسبقاً، استبداله؟ (y/N) ')).toLowerCase() !== 'y') return rl.close();
  const user = (await ask('اسم مستخدم الأدمن: ')).trim();
  const pass = await ask('كلمة السر (12 حرف على الأقل): ');
  const webhook = (await ask('رابط Discord Webhook (اختياري، Enter للتخطي): ')).trim();
  rl.close();
  if (!user || pass.length < 12) { console.error('❌ اسم مستخدم مطلوب وكلمة سر لا تقل عن 12 حرف.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, 64).toString('hex');
  fs.writeFileSync(envPath, [
    'PORT=3000', 'HOST=127.0.0.1',
    `ADMIN_USER=${user}`, `ADMIN_PASS_HASH=scrypt$${salt.toString('hex')}$${hash}`,
    `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`,
    `DISCORD_WEBHOOK_URL=${webhook}`,
    '# على الاستضافة (HTTPS): NODE_ENV=production و TRUST_PROXY=1 لو خلف Nginx/Cloudflare',
    'NODE_ENV=development', 'TRUST_PROXY=0', '',
  ].join('\n'), { mode: 0o600 });
  console.log('✅ تم إنشاء .env — شغّل السيرفر بـ: node server.js');
})();

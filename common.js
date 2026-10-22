'use strict';
/* دوال مشتركة بين السيرفر والبوت: قراءة .env + اشتقاق القيم من التوكن + مكان البيانات */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv(root) {
  const f = path.join(root, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
/* أيدي التطبيق (Client ID) هو أول جزء من التوكن */
function clientIdFromToken(token) {
  try {
    const id = Buffer.from(String(token).split('.')[0], 'base64').toString('utf8');
    return /^\d{17,20}$/.test(id) ? id : '';
  } catch { return ''; }
}
/* مفاتيح ثابتة تُشتق من التوكن (نفس القيمة في السيرفر والبوت، بدون ما تكتبها) */
const derive = (token, label) => crypto.createHmac('sha256', String(token)).update('hp1:' + label).digest('hex');

/* مكان البيانات: DATA_DIR إن حددته، أو قرص دائم /var/data إن وُجد، وإلا private/data */
function dataDir(root) {
  const seed = path.join(root, 'private', 'data');
  if (process.env.DATA_DIR) return { dir: path.resolve(process.env.DATA_DIR), seed };
  if (fs.existsSync('/var/data')) return { dir: '/var/data/hp1', seed };
  return { dir: seed, seed };
}
module.exports = { loadEnv, clientIdFromToken, derive, dataDir };

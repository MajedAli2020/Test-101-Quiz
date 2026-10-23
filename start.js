'use strict';
// يشغّل الموقع والبوت مع بعض (خدمة Render وحدة)
const { spawn } = require('child_process');
const common = require('./common');
const { sendAlert } = require('./alerts');
common.loadEnv(__dirname);
function run(file) {
  const p = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => {
    console.error(`${file} وقف (code ${code}) — إعادة تشغيل بعد 5 ثواني`);
    sendAlert(__dirname, { title: `🚨 توقف ${file === 'server.js' ? 'الموقع' : 'البوت'} (${file})`, text: `خرجت العملية بالكود ${code}.\nتتم إعادة تشغيلها تلقائياً بعد 5 ثواني. لو تكرر التنبيه، راجع Logs في الاستضافة.`, key: 'exit:' + file, cooldownMs: 5 * 60_000 });
    setTimeout(() => run(file), 5000);
  });
}
run('server.js');
setTimeout(() => run('bot.js'), 3000); // ننتظر السيرفر يقوم

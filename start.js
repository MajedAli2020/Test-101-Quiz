'use strict';
// يشغّل الموقع والبوت مع بعض (خدمة Render وحدة)
const { spawn } = require('child_process');
function run(file) {
  const p = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => {
    console.error(`${file} وقف (code ${code}) — إعادة تشغيل بعد 5 ثواني`);
    setTimeout(() => run(file), 5000);
  });
}
run('server.js');
setTimeout(() => run('bot.js'), 3000); // ننتظر السيرفر يقوم

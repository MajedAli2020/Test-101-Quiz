# HP1 Police Mod — الموقع + لوحة التحكم + بوت ديسكورد

دخول لوحة التحكم = بحساب ديسكورد + **رول تحدده أنت** (بدون كلمة سر).

## الهيكل
- `public/`   الموقع فقط (الوحيد المفتوح للعامة)
- `private/`  لوحة التحكم + البيانات (لا تُخدم إلا لصاحب الرول)
- `server.js` السيرفر (بدون مكتبات)
- `bot.js`    بوت discord.js (/نتيجتي و /فك-الانتظار)
- `.env`      الإعدادات — عبّئ الحقول الفاضية فقط

## الإعداد (https://discord.com/developers/applications)
1. New Application ← انسخ **Application ID** (→ DISCORD_CLIENT_ID).
2. OAuth2 ← انسخ **Client Secret**، وأضف Redirect: `http://localhost:3000/auth/callback`
3. Bot ← Reset Token (→ DISCORD_BOT_TOKEN). لا تفعّل أي Privileged Intent.
4. OAuth2 ← URL Generator: scopes `bot` + `applications.commands`، صلاحية **Manage Roles** ← أدخل البوت لسيرفرك.
5. فعّل Developer Mode في ديسكورد، وانسخ (كليك يمين ← Copy ID):
   أيدي السيرفر (DISCORD_GUILD_ID) وأيدي رول الإدارة (DISCORD_ADMIN_ROLE_ID).
6. اجعل رتبة البوت فوق رتبة الناجحين (لو استخدمت DISCORD_PASS_ROLE_ID).

## التشغيل
    node server.js              ← الموقع http://localhost:3000   اللوحة /admin
    npm install && node bot.js  ← البوت (الوحيد اللي يحتاج مكتبة)

## على الاستضافة
- `.env`: `NODE_ENV=production` و`TRUST_PROXY=1` و`DISCORD_REDIRECT_URI` بـ https (وأضفه في OAuth2 Redirects).
- شغّله خلف HTTPS، ولا تشارك `.env`، وامنع `/internal/` من الخارج في Nginx.
- سحب الرول من شخص يسري خلال 4 ساعات كحد أقصى (مدة الجلسة).

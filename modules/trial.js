const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { storeFooter } = require('./storeFooter');
const db = new sqlite3.Database('./sellvpn.db');

function normalizeTrialQuotaGb(quota, fallback = '2') {
  const n = Number(quota);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return String(Math.floor(n));
}

function normalizeTrialTimelimit(timelimit, fallback = '1h') {
  const text = String(timelimit || '').trim().toLowerCase();
  if (/^\d+[hm]$/.test(text)) return text;
  return fallback;
}

function buildTrialRequestBody({ quota, limitip, timelimit, telegramUserId, telegramChatId }) {
  return JSON.stringify({
    timelimit: normalizeTrialTimelimit(timelimit),
    kuota: normalizeTrialQuotaGb(quota),
    limitip: String(limitip || '1'),
    telegram_user_id: String(telegramUserId || ''),
    telegram_chat_id: String(telegramChatId || '')
  });
}

function quotaText(quota) {
  const value = normalizeTrialQuotaGb(quota);
  return value === '0' ? 'Unlimited' : `${value} GB`;
}

function accountRemarks(payload, fallbackUsername = '') {
  return payload?.remark || payload?.remarks || payload?.username || fallbackUsername || '-';
}

async function trialssh(username, password, exp, iplimit, serverId, telegramUserId = '', telegramChatId = '', quota = '2', timelimit = '1h') {
  console.log(`Creating SSH account for ${username} with expiry ${exp} days, quota ${quota} GB, timelimit ${timelimit}, IP limit ${iplimit}, and password ${password}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialsshvpn`;
      const web_URL = `http://${domain}${param}`; // misalnya: http://idnusastb.domain.web.id/vps/sshvpn
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = normalizeTrialQuotaGb(quota);
      const TIMELIMIT = normalizeTrialTimelimit(timelimit);
      const LIMIT_IP = iplimit;
      const requestBody = buildTrialRequestBody({ quota: KUOTA, limitip: LIMIT_IP, timelimit: TIMELIMIT, telegramUserId, telegramChatId });

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "X-Telegram-User-Id: ${telegramUserId}" \
-H "X-Telegram-Chat-Id: ${telegramChatId}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '${requestBody}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;

const msg = `
=============================
     *TRIAL SSH ACCOUNT*
=============================

*[ SSH PREMIUM DETAILS ]*
-----------------------------
*SSH WS*       : \`${s.hostname}:80@${s.username}:${s.password}\`
*SSH SSL*      : \`${s.hostname}:443@${s.username}:${s.password}\`
*DNS SELOW*    : \`${s.hostname}:5300@${s.username}:${s.password}\`

*[ HOST INFORMATION ]*
-----------------------------
*Hostname*     : \`${s.hostname}\`
*Username*     : \`${s.username}\`
*Password*     : \`${s.password}\`
*Expiry Date*  : \`${s.exp}\`
*Expiry Time*  : \`${s.time}\`
*Quota*        : \`${quotaText(KUOTA)}\`
*IP Limit*     : 1 pengguna

*[ PORTS ]*
-----------------------------
*TLS*          : \`${s.port.tls}\`
*Non-TLS*      : \`${s.port.none}\`
*OVPN TCP*     : \`${s.port.ovpntcp}\`
*OVPN UDP*     : \`${s.port.ovpnudp}\`
*SSH OHP*      : \`${s.port.sshohp}\`
*UDP Custom*   : \`${s.port.udpcustom}\`

*[ PAYLOAD WS ]*
-----------------------------
\`GET wss://[host_port]/ HTTP/1.1[crlf]Host: [host_port][crlf]Upgrade: Websocket[crlf]Connection: Keep-Alive[crlf][crlf]\`

*[ PAYLOAD ENHANCED + SPLIT ]*
-----------------------------
\`PATCH /ssh-ws HTTP/1.1[crlf]Host: [host][crlf]Host: www.google.com[crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf][crlf][split]HTTP/1.1 200 OK[crlf][crlf]\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/myvpn-config.zip

-----------------------------
*${storeFooter(2025, true)}*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}

async function trialudphttp(username, password, exp, iplimit, serverId, telegramUserId = '', telegramChatId = '', quota = '2', timelimit = '1h') {
  console.log(`Creating UDP HTTP Custom trial for ${username} with expiry ${exp} days, quota ${quota} GB, timelimit ${timelimit}, IP limit ${iplimit}, and password ${password}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialsshvpn`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const KUOTA = normalizeTrialQuotaGb(quota);
      const TIMELIMIT = normalizeTrialTimelimit(timelimit);
      const LIMIT_IP = iplimit;
      const requestBody = buildTrialRequestBody({ quota: KUOTA, limitip: LIMIT_IP, timelimit: TIMELIMIT, telegramUserId, telegramChatId });

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "X-Telegram-User-Id: ${telegramUserId}" \
-H "X-Telegram-Chat-Id: ${telegramChatId}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '${requestBody}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const port = '1-65535';
        const expired = s.exp || s.expired || s.to || 'N/A';
        const ipLimitText = iplimit === "0" ? "Unlimited" : iplimit;
        const copy = `${s.hostname}:${port}@${s.username}:${s.password}`;

        const msg = `*TRIAL UDP HTTP CUSTOM*

*Hostname*   : \`${s.hostname}\`
*Username*   : \`${s.username}\`
*Password*   : \`${s.password}\`
*Port*       : \`${port}\`
*Expired*    : \`${expired}\`
*Quota*      : \`${quotaText(KUOTA)}\`
*IP Limit*   : \`${ipLimitText}\`

*Copy*:
\`${copy}\``;

        return resolve(msg);
      });
    });
  });
}
async function trialvmess(username, exp, quota, limitip, serverId, telegramUserId = '', telegramChatId = '', timelimit = '1h') {
  console.log(`Creating VMess account for ${username} with expiry ${exp} days, quota ${quota} GB, timelimit ${timelimit}, IP limit ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialvmessall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://idnusastb.domain.web.id/vps/vmess
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = normalizeTrialQuotaGb(quota);
      const TIMELIMIT = normalizeTrialTimelimit(timelimit);
      const LIMIT_IP = limitip;
      const requestBody = buildTrialRequestBody({ quota: KUOTA, limitip: LIMIT_IP, timelimit: TIMELIMIT, telegramUserId, telegramChatId });

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "X-Telegram-User-Id: ${telegramUserId}" \
-H "X-Telegram-Chat-Id: ${telegramChatId}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '${requestBody}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const remarks = accountRemarks(s, username);

const msg = `
=============================
    *TRIAL VMESS ACCOUNT*
=============================

*[ VMESS DETAILS ]*
-----------------------------
*REMARKS*     : \`${remarks}\`
*HOST*        : \`${s.hostname}\`
*PORT TLS*    : \`${s.port.tls}\`
*PORT NTLS*   : \`${s.port.none}\`
*UUID*        : \`${s.uuid}\`
*ALTER ID*    : \`0\`
*NETWORK*     : \`ws, grpc, upgrade\`
*PATH*        : \`${s.path.stn}\`
*EXPIRED*     : \`${s.expired}\` - \`${s.time}\`
*QUOTA*       : \`${quotaText(KUOTA)}\`

*[ VMESS URL ]*
-----------------------------
TLS:
\`${s.link.tls}\`

Non-TLS:
\`${s.link.none}\`

gRPC:
\`${s.link.grpc}\`

*[ HOST INFORMATION ]*
-----------------------------
*Domain*      : \`${s.hostname}\`
*SNI*         : \`${s.hostname}\`
*IP Limit*    : ${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} pengguna

*[ PORTS ]*
-----------------------------
*WS TLS*      : \`${s.port.tls}\`
*WS NTLS*     : \`${s.port.none}\`

*[ SUGGESTED SNI / BUG ]*
-----------------------------
\`${s.hostname}\`
\`www.google.com\`
\`www.bing.com\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/vmess-config.zip

-----------------------------
*${storeFooter(2025, true)}*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}

async function trialvless(username, exp, quota, limitip, serverId, telegramUserId = '', telegramChatId = '', timelimit = '1h') {
  console.log(`Creating VLESS account for ${username} with expiry ${exp} days, quota ${quota} GB, timelimit ${timelimit}, limit IP ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialvlessall`;
      const web_URL = `http://${domain}${param}`; // Contoh: http://domainmu.com/vps/vless
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = normalizeTrialQuotaGb(quota);
      const TIMELIMIT = normalizeTrialTimelimit(timelimit);
      const LIMIT_IP = limitip;
      const requestBody = buildTrialRequestBody({ quota: KUOTA, limitip: LIMIT_IP, timelimit: TIMELIMIT, telegramUserId, telegramChatId });

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "X-Telegram-User-Id: ${telegramUserId}" \
-H "X-Telegram-Chat-Id: ${telegramChatId}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '${requestBody}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const remarks = accountRemarks(s, username);

const msg = `
=============================
    *TRIAL VLESS ACCOUNT*
=============================

*[ VLESS DETAILS ]*
-----------------------------
*REMARKS*     : \`${remarks}\`
*HOST*        : \`${s.hostname}\`
*PORT TLS*    : \`${s.port.tls}\`
*PORT NTLS*   : \`${s.port.none}\`
*UUID*        : \`${s.uuid}\`
*NETWORK*     : \`ws, grpc, upgrade\`
*PATH*        : \`${s.path.stn}\`
*EXPIRED*     : \`${s.expired}\` - \`${s.time}\`
*QUOTA*       : \`${quotaText(KUOTA)}\`
*IP LIMIT*    : \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} pengguna\`

*[ VLESS URL ]*
-----------------------------
TLS:
\`${s.link.tls}\`

Non-TLS:
\`${s.link.none}\`

gRPC:
\`${s.link.grpc}\`

Up TLS:
\`${s.link.uptls}\`

Up Non-TLS:
\`${s.link.upntls}\`

*[ HOST INFORMATION ]*
-----------------------------
*Domain*      : \`${s.hostname}\`
*SNI*         : \`${s.hostname}\`

*[ PORTS ]*
-----------------------------
*WS TLS*      : \`${s.port.tls}\`
*WS NTLS*     : \`${s.port.none}\`
*ANY PORT*    : \`${s.port.any}\`

*[ SUGGESTED SNI / BUG ]*
-----------------------------
\`${s.hostname}\`
\`www.google.com\`
\`www.bing.com\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/vless-config.zip

-----------------------------
*${storeFooter(2025, true)}*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}
async function trialtrojan(username, exp, quota, limitip, serverId, telegramUserId = '', telegramChatId = '', timelimit = '1h') {
  console.log(`Creating Trojan account for ${username} with expiry ${exp} days, quota ${quota} GB, timelimit ${timelimit}, limit IP ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialtrojanall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://domainmu.com/vps/trojan
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = normalizeTrialQuotaGb(quota);
      const TIMELIMIT = normalizeTrialTimelimit(timelimit);
      const LIMIT_IP = limitip;
      const requestBody = buildTrialRequestBody({ quota: KUOTA, limitip: LIMIT_IP, timelimit: TIMELIMIT, telegramUserId, telegramChatId });

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "X-Telegram-User-Id: ${telegramUserId}" \
-H "X-Telegram-Chat-Id: ${telegramChatId}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '${requestBody}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const remarks = accountRemarks(s, username);

const msg = `
=============================
    *TRIAL TROJAN ACCOUNT*
=============================

*[ TROJAN DETAILS ]*
-----------------------------
*REMARKS*     : \`${remarks}\`
*HOST*        : \`${s.hostname}\`
*PORT TLS*    : \`${s.port.tls}\`
*PORT NTLS*   : \`${s.port.none}\`
*KEY*         : \`${s.uuid}\`
*NETWORK*     : \`ws, grpc, upgrade\`
*PATH*        : \`${s.path.stn}\`
*EXPIRED*     : \`${s.expired}\` - \`${s.time}\`
*QUOTA*       : \`${quotaText(KUOTA)}\`
*IP LIMIT*    : \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} pengguna\`

*[ TROJAN LINK ]*
-----------------------------
TLS:
\`${s.link.tls}\`

gRPC:
\`${s.link.grpc}\`

Up TLS:
\`${s.link.uptls}\`

*[ HOST INFORMATION ]*
-----------------------------
*Domain*      : \`${s.hostname}\`
*SNI*         : \`${s.hostname}\`

*[ PORTS ]*
-----------------------------
*WS TLS*      : \`${s.port.tls}\`
*WS NTLS*     : \`${s.port.none}\`
*ANY PORT*    : \`${s.port.any}\`

*[ SUGGESTED SNI / BUG ]*
-----------------------------
\`${s.hostname}\`
\`www.google.com\`
\`www.bing.com\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/trojan-config.zip

-----------------------------
*${storeFooter(2025, true)}*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}


//create shadowsocks ga ada di potato
async function trialshadowsocks(username, exp, quota, limitip, serverId) {
  console.log(`Creating Shadowsocks account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip} on server ${serverId}`);
  
  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  // Ambil domain dari database
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err) {
        console.error('Error fetching server:', err.message);
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      if (!server) return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');

      const domain = server.domain;
      const auth = server.auth;
      const param = `:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${auth}`;
      const url = `http://${domain}${param}`;
      axios.get(url)
        .then(response => {
          if (response.data.status === "success") {
            const shadowsocksData = response.data.data;
            const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${shadowsocksData.username}\`
│ *Domain*   : \`${shadowsocksData.domain}\`
│ *NS*       : \`${shadowsocksData.ns_domain}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Alter ID* : \`0\`
│ *Security* : \`Auto\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/shadowsocks\`
│ *Path GRPC*: \`shadowsocks-grpc\`
└─────────────────────
🔐 *URL SHADOWSOCKS TLS*
\`\`\`
${shadowsocksData.ss_link_ws}
\`\`\`
🔒 *URL SHADOWSOCKS GRPC*
\`\`\`
${shadowsocksData.ss_link_grpc}
\`\`\`
🔒 *PUBKEY*
\`\`\`
${shadowsocksData.pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${shadowsocksData.expired}\`
│ Quota: \`${shadowsocksData.quota === '0 GB' ? 'Unlimited' : shadowsocksData.quota}\`
│ IP Limit: \`${shadowsocksData.ip_limit === '0' ? 'Unlimited' : shadowsocksData.ip_limit} IP\`
└─────────────────────
Save Account Link: [Save Account](https://${shadowsocksData.domain}:81/shadowsocks-${shadowsocksData.username}.txt)
✨ Selamat menggunakan layanan kami! ✨
`;
              console.log('Shadowsocks account created successfully');
              return resolve(msg);
            } else {
              console.log('Error creating Shadowsocks account');
              return resolve(`❌ Terjadi kesalahan: ${response.data.message}`);
            }
          })
        .catch(error => {
          console.error('Error saat membuat Shadowsocks:', error);
          return resolve('❌ Terjadi kesalahan saat membuat Shadowsocks. Silakan coba lagi nanti.');
        });
    });
  });
}

module.exports = { trialssh, trialudphttp, trialvmess, trialvless, trialtrojan, trialshadowsocks }; 

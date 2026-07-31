const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { storeFooter } = require('./storeFooter');
const db = new sqlite3.Database('./sellvpn.db');

function isValidUsername(username) {
  return !(/\s/.test(username) || /[^a-zA-Z0-9]/.test(username));
}

function normalizeApiBase(rawDomain) {
  const value = String(rawDomain || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return `http://${value}`.replace(/\/+$/, '');
}

function normalizeAuthToken(rawAuth) {
  const value = String(rawAuth || '').trim();
  if (!value) return '';
  return value.replace(/^Bearer\s+/i, '').trim();
}

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function getServer(serverId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) return resolve(null);
      resolve(server);
    });
  });
}

function execJson(command) {
  return new Promise((resolve) => {
    exec(command, (_, stdout) => {
      try {
        resolve({ ok: true, data: JSON.parse(stdout) });
      } catch (e) {
        resolve({ ok: false, error: 'Format respon dari server tidak valid.', raw: stdout });
      }
    });
  });
}

function buildRenewMessage(title, s, withQuota = false) {
  let msg = `✅ *${title}*

🔄 Akun berhasil diperpanjang
────────────────────────────
👤 Username    : \`${s.username}\`
`;

  if (withQuota) {
    msg += `📦 Quota       : \`${s.quota === '0' ? 'Unlimited' : s.quota} GB\`
`;
  }

  msg += `📆 Masa Aktif  :
🕒 Dari         : \`${s.from || '-'}\`
🕒 Sampai       : \`${s.to || s.exp || '-'}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami.
${storeFooter(2025, true)}`;

  return msg;
}

async function renewByEndpoint({ username, exp, quota = 0, limitip = '', password = '', serverId, endpoint, title, withQuota = false }) {
  if (!isValidUsername(username)) {
    return '❌ Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return '❌ Server tidak ditemukan. Silakan coba lagi.';
  }

  const baseUrl = normalizeApiBase(server.domain);
  const authToken = normalizeAuthToken(server.auth);
  if (!baseUrl) return '❌ Domain server tidak valid.';
  if (!authToken) return '❌ Auth token server kosong/tidak valid.';
  const webURL = `${baseUrl}${endpoint}/${username}/${exp}`;
  const requestBody = { kuota: Number(quota || 0) };
  const limitValue = String(limitip ?? '').trim();
  const passwordValue = String(password || '').trim();
  if (limitValue) requestBody.limitip = limitValue;
  if (passwordValue) {
    requestBody.password = passwordValue;
    requestBody.recover_missing = true;
  }

  const curlCommand = `curl -s -X PATCH "${webURL}" \
-H "Authorization: ${authToken}" \
-H "accept: application/json" \
-H "Content-Type: application/json" \
-d ${shellSingleQuote(JSON.stringify(requestBody))}`;

  const result = await execJson(curlCommand);
  if (!result.ok) {
    return '❌ ' + result.error;
  }

  const d = result.data;
  if (d?.meta?.code !== 200 || !d.data) {
    const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
    return `❌ Respons error:\n${errMsg}`;
  }

  if (withQuota && (d.data.quota === undefined || d.data.quota === null || d.data.quota === '')) {
    d.data.quota = String(quota || 0);
  }

  return buildRenewMessage(title, d.data, withQuota);
}

async function renewssh(username, exp, quota, limitip, serverId, password = '') {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    password,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew SSH Account Success',
    withQuota: true
  });
}

async function renewudphttp(username, exp, quota, limitip, serverId, password = '') {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    password,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew UDP HTTP Custom Success',
    withQuota: true
  });
}

async function renewvmess(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    serverId,
    endpoint: '/vps/renewvmess',
    title: 'Renew VMess Account Success',
    withQuota: true
  });
}

async function renewvless(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    serverId,
    endpoint: '/vps/renewvless',
    title: 'Renew VLESS Account Success',
    withQuota: true
  });
}

async function renewtrojan(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    serverId,
    endpoint: '/vps/renewtrojan',
    title: 'Renew TROJAN Account Success',
    withQuota: true
  });
}

async function renewshadowsocks(username, exp, quota, limitip, serverId) {
  if (!isValidUsername(username)) {
    return '❌ Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return '❌ Server tidak ditemukan. Silakan coba lagi.';
  }

  const baseUrl = normalizeApiBase(server.domain);
  const authToken = normalizeAuthToken(server.auth);
  if (!baseUrl) return '❌ Domain server tidak valid.';
  if (!authToken) return '❌ Auth token server kosong/tidak valid.';
  const param = `:5888/renewshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${authToken}`;
  const url = `${baseUrl}${param}`;

  try {
    const response = await axios.get(url);
    if (response.data?.status !== 'success') {
      return `❌ Terjadi kesalahan: ${response.data?.message || 'unknown'}`;
    }

    const data = response.data.data || {};
    return `✅ *RENEW SHADOWSOCKS PREMIUM*

🔹 Informasi Akun
────────────────────────────
👤 Username     : \`${username}\`
📆 Kadaluarsa   : \`${data.exp || '-'}\`
📦 Quota        : \`${data.quota || '-'}\`
📶 Batas IP     : \`${data.limitip || limitip} IP\`
────────────────────────────
✅ Akun ${username} berhasil diperbarui.`;
  } catch (error) {
    return '❌ Terjadi kesalahan saat memperbarui Shadowsocks. Silakan coba lagi nanti.';
  }
}

async function renewzivpn(username, exp, quota, limitip, serverId, password = '') {
  return renewByEndpoint({
    username,
    exp,
    quota,
    limitip,
    password,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew ZIVPN Success',
    withQuota: true
  });
}

module.exports = {
  renewshadowsocks,
  renewtrojan,
  renewvless,
  renewvmess,
  renewssh,
  renewudphttp,
  renewzivpn
};

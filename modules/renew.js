const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { storeFooter } = require('./storeFooter');

const db = new sqlite3.Database('./sellvpn.db');

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_REQUEST_TIMEOUT_MS = normalizeTimeout(process.env.RENEW_REQUEST_TIMEOUT_MS, 60000, 5000, 180000);
const RENEW_VERIFY_TIMEOUT_MS = normalizeTimeout(process.env.RENEW_VERIFY_TIMEOUT_MS, 5000, 2000, 60000);

function normalizeTimeout(value, fallback, min, max) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

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

function normalizeSyncHost(rawHost) {
  const value = String(rawHost || '').trim();
  if (!value) return '';

  try {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
    return url.hostname;
  } catch (_) {
    return value.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  }
}

function normalizeExportType(type) {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'zivpn' || value === 'udp_http' || value === 'udp') return 'ssh';
  return value;
}

function getServer(serverId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) return resolve(null);
      resolve(server);
    });
  });
}

function parseDateExpToTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function responseLost(error) {
  return Boolean(error && !error.response);
}

function getErrorMessageFromResponse(error) {
  const data = error?.response?.data;
  return data?.message || data?.meta?.message || error?.message || 'request gagal';
}

async function fetchAccountFromSummary(server, authToken, type, username) {
  const host = normalizeSyncHost(server.sync_host || server.domain);
  if (!host) return null;

  const port = Number(server.sync_port) || 8789;
  const url = `http://${host}:${port}/internal/export-accounts`;
  const response = await axios.get(url, {
    timeout: RENEW_VERIFY_TIMEOUT_MS,
    headers: { 'x-sync-token': authToken },
    params: {
      type: normalizeExportType(type),
      limit: 50000,
      include_inactive: 1
    },
    validateStatus: () => true
  });

  const data = response.data || {};
  if (response.status < 200 || response.status >= 300 || !data.ok || !Array.isArray(data.accounts)) {
    return null;
  }

  const needle = String(username || '').trim().toLowerCase();
  return data.accounts.find((account) => String(account?.username || '').trim().toLowerCase() === needle) || null;
}

function hasExpiryAdvanced(beforeAccount, afterAccount, exp) {
  if (!afterAccount) return false;

  const afterTs = parseDateExpToTimestamp(afterAccount.date_exp || afterAccount.exp || afterAccount.to);
  if (!afterTs) return false;

  const beforeTs = parseDateExpToTimestamp(beforeAccount?.date_exp || beforeAccount?.exp || beforeAccount?.to);
  const requestedMs = Math.max(1, Number(exp || 1)) * DAY_MS;
  const toleranceMs = 6 * 60 * 60 * 1000;

  if (beforeTs) {
    return afterTs >= beforeTs + Math.max(1, requestedMs - toleranceMs);
  }

  return afterTs >= Date.now() + Math.max(1, requestedMs - toleranceMs);
}

function accountDataFromVerification(username, beforeAccount, afterAccount, fallbackQuota, fallbackLimitIp) {
  return {
    username: afterAccount?.username || username,
    from: beforeAccount?.date_exp || beforeAccount?.exp || beforeAccount?.to || '-',
    to: afterAccount?.date_exp || afterAccount?.exp || afterAccount?.to || '-',
    exp: afterAccount?.date_exp || afterAccount?.exp || afterAccount?.to || '-',
    quota: String(afterAccount?.quota ?? fallbackQuota ?? 0),
    limitip: String(afterAccount?.limitip ?? fallbackLimitIp ?? ''),
    status: afterAccount?.status || 'AKTIF'
  };
}

function buildRenewMessage(title, s, withQuota = false) {
  const lines = [
    `[OK] *${title}*`,
    '',
    'Akun berhasil diperpanjang',
    '----------------------------',
    `Username    : \`${s.username || '-'}\``
  ];

  if (withQuota) {
    lines.push(`Quota       : \`${String(s.quota) === '0' ? 'Unlimited' : s.quota} GB\``);
  }

  lines.push(
    'Masa Aktif  :',
    `Dari        : \`${s.from || '-'}\``,
    `Sampai      : \`${s.to || s.exp || '-'}\``,
    '----------------------------',
    '',
    'Terima kasih telah memperpanjang layanan kami.',
    storeFooter(2025, true)
  );

  return lines.join('\n');
}

async function renewByEndpoint({
  username,
  exp,
  quota = 0,
  limitip = '',
  password = '',
  serverId,
  endpoint,
  title,
  type,
  withQuota = false
}) {
  if (!isValidUsername(username)) {
    return 'Gagal: Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return 'Gagal: Server tidak ditemukan. Silakan coba lagi.';
  }

  const baseUrl = normalizeApiBase(server.domain);
  const authToken = normalizeAuthToken(server.auth);
  if (!baseUrl) return 'Gagal: Domain server tidak valid.';
  if (!authToken) return 'Gagal: Auth token server kosong/tidak valid.';

  const webURL = `${baseUrl}${endpoint}/${username}/${exp}`;
  const requestBody = { kuota: Number(quota || 0) };
  const limitValue = String(limitip ?? '').trim();
  const passwordValue = String(password || '').trim();
  if (limitValue) requestBody.limitip = limitValue;
  if (passwordValue) {
    requestBody.password = passwordValue;
    requestBody.recover_missing = true;
  }

  let beforeAccount = null;
  try {
    beforeAccount = await fetchAccountFromSummary(server, authToken, type, username);
  } catch (_) {}

  let response;
  try {
    response = await axios.patch(webURL, requestBody, {
      timeout: RENEW_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: authToken,
        accept: 'application/json',
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });
  } catch (error) {
    if (responseLost(error)) {
      try {
        const afterAccount = await fetchAccountFromSummary(server, authToken, type, username);
        if (hasExpiryAdvanced(beforeAccount, afterAccount, exp)) {
          return buildRenewMessage(
            title,
            accountDataFromVerification(username, beforeAccount, afterAccount, quota, limitip),
            withQuota
          );
        }
      } catch (_) {}

      return `Gagal: Server VPN tidak memberi respons setelah ${Math.round(RENEW_REQUEST_TIMEOUT_MS / 1000)} detik. Jika akun di server sudah berubah, hubungi admin untuk cek manual sebelum mengulang perpanjangan.`;
    }

    return `Gagal: Terjadi kesalahan saat menghubungi server VPN: ${getErrorMessageFromResponse(error)}`;
  }

  const d = response.data || {};
  if (response.status < 200 || response.status >= 300) {
    const errMsg = d?.message || d?.meta?.message || JSON.stringify(d || {}, null, 2);
    return `Gagal: Respons error:\n${errMsg}`;
  }

  if (d?.meta?.code !== 200 || !d.data) {
    const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
    return `Gagal: Respons error:\n${errMsg}`;
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
    type: 'ssh',
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
    type: 'udp_http',
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
    type: 'vmess',
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
    type: 'vless',
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
    type: 'trojan',
    withQuota: true
  });
}

async function renewshadowsocks(username, exp, quota, limitip, serverId) {
  if (!isValidUsername(username)) {
    return 'Gagal: Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return 'Gagal: Server tidak ditemukan. Silakan coba lagi.';
  }

  const baseUrl = normalizeApiBase(server.domain);
  const authToken = normalizeAuthToken(server.auth);
  if (!baseUrl) return 'Gagal: Domain server tidak valid.';
  if (!authToken) return 'Gagal: Auth token server kosong/tidak valid.';

  const param = `:5888/renewshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${authToken}`;
  const url = `${baseUrl}${param}`;

  try {
    const response = await axios.get(url, { timeout: RENEW_REQUEST_TIMEOUT_MS });
    if (response.data?.status !== 'success') {
      return `Gagal: ${response.data?.message || 'unknown'}`;
    }

    const data = response.data.data || {};
    return [
      '[OK] *RENEW SHADOWSOCKS PREMIUM*',
      '',
      'Informasi Akun',
      '----------------------------',
      `Username     : \`${username}\``,
      `Kadaluarsa   : \`${data.exp || '-'}\``,
      `Quota        : \`${data.quota || '-'}\``,
      `Batas IP     : \`${data.limitip || limitip} IP\``,
      '----------------------------',
      `[OK] Akun ${username} berhasil diperbarui.`
    ].join('\n');
  } catch (error) {
    return `Gagal: Terjadi kesalahan saat memperbarui Shadowsocks: ${error?.message || 'request gagal'}`;
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
    type: 'zivpn',
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

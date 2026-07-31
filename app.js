const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { Telegraf } = require('telegraf');
const app = express();
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  generateHcConfigViaApi,
  unlockHcConfigViaApi,
  generateDarkTunnelViaApi,
  unlockDarkTunnelViaApi,
  formatGeneratorApiError,
  getGeneratorInfo,
  DEFAULT_GENERATOR_API_URL,
  normalizeBaseUrl: normalizeGeneratorApiBaseUrl
} = require('./lib/generatorApiClient');
const { parseHcCompactXrayInput, parseHcEndpoint } = require('./lib/hcXrayInput');
const {
  inspectForeignBotDatabase,
  importForeignBotDatabase
} = require('./lib/foreignDbRestore');
const {
  parseSshAccount: parseDarkSshAccount,
  parseVmessAccount: parseDarkVmessAccount,
  parseXrayAccount: parseDarkXrayAccount
} = require('./lib/darkAccountInput');
const ppobService = require('./lib/ppobService');
const { createRateLimiter, runBroadcastDelivery } = require('./lib/broadcastWorker');
const ROOT_DIR = __dirname;
const RUNTIME_DIR = ROOT_DIR;

process.env.BOTVPN_ROOT_DIR = ROOT_DIR;
process.env.BOTVPN_RUNTIME_DIR = RUNTIME_DIR;
process.env.BOTVPN_STANDALONE = '1';

function runtimePath(...parts) {
  return path.join(RUNTIME_DIR, ...parts);
}

function readJsonFileSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

const resselFilePath = runtimePath('ressel.db');
const resellerTermsPath = runtimePath('reseller_terms.json');
const defaultResellerTerms = { min_accounts: 0, min_topup: 30000, join_topup_min: 30000 };
const topupManualPath = runtimePath('topup_manual.json');
const defaultTopupManual = { enabled: true };
const topupAutoPath = runtimePath('topup_auto.json');
const defaultTopupAuto = { enabled: true };
const topupBonusPath = runtimePath('topup_bonus.json');
const defaultTopupBonus = { enabled: true, range_10_40: 0, range_50_70: 0, range_70_100: 0 };
const scNexusMenuPath = runtimePath('sc_nexus_menu.json');
const defaultScNexusMenu = { enabled: true };
const maintenancePath = runtimePath('maintenance_mode.json');
const defaultMaintenance = { enabled: false, estimate: '' };
const hcDefaultNotePath = runtimePath('hc_default_note.json');
const defaultHcDefaultNote = { enabled: false, html: '' };
const darkDefaultNotePath = runtimePath('dark_default_note.json');
const defaultDarkDefaultNote = { enabled: false, html: '' };
const varsPath = runtimePath('.vars.json');
const danaBridgeStatusPath = runtimePath('dana_bridge_status.json');

function loadResellerTerms() {
  try {
    const raw = fs.readFileSync(resellerTermsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const minAccounts = Number(parsed.min_accounts);
    const minTopup = Number(parsed.min_topup);
    const joinTopupMin = Number(parsed.join_topup_min);
    if (!Number.isFinite(minAccounts) || !Number.isFinite(minTopup)) {
      return { ...defaultResellerTerms };
    }
    return {
      min_accounts: Math.max(0, Math.floor(minAccounts)),
      min_topup: Math.max(0, Math.floor(minTopup)),
      join_topup_min: Number.isFinite(joinTopupMin)
        ? Math.max(0, Math.floor(joinTopupMin))
        : defaultResellerTerms.join_topup_min
    };
  } catch (err) {
    return { ...defaultResellerTerms };
  }
}

function saveResellerTerms(terms) {
  const current = loadResellerTerms();
  const payload = {
    min_accounts: Math.max(0, Math.floor(Number(terms.min_accounts ?? current.min_accounts) || 0)),
    min_topup: Math.max(0, Math.floor(Number(terms.min_topup ?? current.min_topup) || 0)),
    join_topup_min: Math.max(0, Math.floor(Number(terms.join_topup_min ?? current.join_topup_min) || 0))
  };
  fs.writeFileSync(resellerTermsPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadTopupManualSetting() {
  try {
    const raw = fs.readFileSync(topupManualPath, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch (err) {
    return defaultTopupManual.enabled;
  }
}

function saveTopupManualSetting(enabled) {
  const payload = { enabled: !!enabled };
  fs.writeFileSync(topupManualPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.enabled;
}

function loadTopupAutoSetting() {
  try {
    const raw = fs.readFileSync(topupAutoPath, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch (err) {
    return defaultTopupAuto.enabled;
  }
}

function saveTopupAutoSetting(enabled) {
  const payload = { enabled: !!enabled };
  fs.writeFileSync(topupAutoPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.enabled;
}

function loadTopupBonusSetting() {
  try {
    const raw = fs.readFileSync(topupBonusPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      range_10_40: Number(parsed.range_10_40) || 0,
      range_50_70: Number(parsed.range_50_70) || 0,
      range_70_100: Number(parsed.range_70_100) || 0
    };
  } catch (err) {
    return { ...defaultTopupBonus };
  }
}

function saveTopupBonusSetting(next) {
  const payload = {
    enabled: next.enabled !== false,
    range_10_40: Math.max(0, Math.min(100, Number(next.range_10_40) || 0)),
    range_50_70: Math.max(0, Math.min(100, Number(next.range_50_70) || 0)),
    range_70_100: Math.max(0, Math.min(100, Number(next.range_70_100) || 0))
  };
  fs.writeFileSync(topupBonusPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadScNexusMenuSetting() {
  try {
    const raw = fs.readFileSync(scNexusMenuPath, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch (err) {
    return defaultScNexusMenu.enabled;
  }
}

function saveScNexusMenuSetting(enabled) {
  const payload = { enabled: !!enabled };
  fs.writeFileSync(scNexusMenuPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.enabled;
}

function loadMaintenanceSetting() {
  try {
    const raw = fs.readFileSync(maintenancePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      estimate: String(parsed.estimate || '').trim(),
      updated_at: Number(parsed.updated_at || 0)
    };
  } catch (err) {
    return { ...defaultMaintenance, updated_at: 0 };
  }
}

function saveMaintenanceSetting(next) {
  const payload = {
    enabled: !!next.enabled,
    estimate: String(next.estimate || '').trim(),
    updated_at: Date.now()
  };
  fs.writeFileSync(maintenancePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadHcDefaultNoteSetting() {
  try {
    const raw = fs.readFileSync(hcDefaultNotePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      html: String(parsed.html || '')
    };
  } catch (err) {
    return { ...defaultHcDefaultNote };
  }
}

function saveHcDefaultNoteSetting(next) {
  const current = loadHcDefaultNoteSetting();
  const payload = {
    enabled: !!(next.enabled ?? current.enabled),
    html: String(next.html ?? current.html ?? '')
  };
  fs.writeFileSync(hcDefaultNotePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadDarkDefaultNoteSetting() {
  try {
    const raw = fs.readFileSync(darkDefaultNotePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      html: String(parsed.html || '')
    };
  } catch (err) {
    return { ...defaultDarkDefaultNote };
  }
}

function saveDarkDefaultNoteSetting(next) {
  const current = loadDarkDefaultNoteSetting();
  const payload = {
    enabled: !!(next.enabled ?? current.enabled),
    html: String(next.html ?? current.html ?? '')
  };
  fs.writeFileSync(darkDefaultNotePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function formatRupiah(amount) {
  return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`;
}

const ACCOUNT_TYPES = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http'];
const ACCOUNT_TYPE_LABELS = {
  ssh: 'SSH',
  vmess: 'VMESS',
  vless: 'VLESS',
  trojan: 'TROJAN',
  shadowsocks: 'SS',
  zivpn: 'ZIVPN',
  udp_http: 'UDP HTTP'
};

function getDayRange(dayOffset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function getMonthRange(monthOffset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime(), labelDate: start };
}

function formatMonthLabel(dateObj) {
  try {
    return dateObj.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  } catch (_) {
    return `${dateObj.getMonth() + 1}/${dateObj.getFullYear()}`;
  }
}

function getAccountTypeLabel(type) {
  return ACCOUNT_TYPE_LABELS[String(type || '').toLowerCase()] || String(type || '').toUpperCase();
}

function getAccountTransactionCount({ userId = null, startTs = null, endTs = null } = {}) {
  const placeholders = ACCOUNT_TYPES.map(() => '?').join(',');
  const where = [
    `type IN (${placeholders})`,
    `(reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`
  ];
  const params = [...ACCOUNT_TYPES];

  if (userId !== null && userId !== undefined) {
    where.unshift('user_id = ?');
    params.unshift(userId);
  }
  if (startTs !== null && startTs !== undefined) {
    where.push('timestamp >= ?');
    params.push(startTs);
  }
  if (endTs !== null && endTs !== undefined) {
    where.push('timestamp < ?');
    params.push(endTs);
  }

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS count FROM transactions WHERE ${where.join(' AND ')}`,
      params,
      (err, row) => {
        if (err) return reject(err);
        resolve(Number(row?.count || 0));
      }
    );
  });
}

function getAccountTypeBreakdown({ userId = null } = {}) {
  const placeholders = ACCOUNT_TYPES.map(() => '?').join(',');
  const where = [
    `type IN (${placeholders})`,
    `(reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`
  ];
  const params = [...ACCOUNT_TYPES];

  if (userId !== null && userId !== undefined) {
    where.unshift('user_id = ?');
    params.unshift(userId);
  }

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT type, COUNT(*) AS count
       FROM transactions
       WHERE ${where.join(' AND ')}
       GROUP BY type`,
      params,
      (err, rows) => {
        if (err) return reject(err);
        const result = {};
        ACCOUNT_TYPES.forEach((type) => {
          result[type] = 0;
        });
        (rows || []).forEach((row) => {
          const type = String(row.type || '').toLowerCase();
          if (Object.prototype.hasOwnProperty.call(result, type)) {
            result[type] = Number(row.count || 0);
          }
        });
        resolve(result);
      }
    );
  });
}

function formatAccountBreakdownBlock(stats) {
  const visibleTypes = ACCOUNT_TYPES.filter((type) => type !== 'shadowsocks');
  const labels = visibleTypes.map((type) => getAccountTypeLabel(type));
  const width = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return visibleTypes
    .map((type) => {
      const label = getAccountTypeLabel(type).padEnd(width, ' ');
      return `${label} : ${Number(stats?.[type] || 0)} akun`;
    })
    .join('\n');
}

function formatMainMenuLinkText(label, enabled, url) {
  if (!enabled || !url) return 'Nonaktif';
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function calculateDurationQuotaGb(quotaPerDay, expDays) {
  const daily = Math.max(0, Number(quotaPerDay || 0));
  const days = Math.max(1, Number(expDays || 1));
  if (!Number.isFinite(daily) || daily <= 0) return 0;
  return Math.round(daily * days);
}

function getTopupIncomeNonResellerByRange(startTs, endTs) {
  const resellerIds = (listResellersSync() || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  return new Promise((resolve, reject) => {
    if (resellerIds.length === 0) {
      db.get(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE timestamp >= ? AND timestamp < ?
           AND type = 'deposit'`,
        [startTs, endTs],
        (err, row) => {
          if (err) return reject(err);
          resolve(Number(row?.total || 0));
        }
      );
      return;
    }

    const placeholders = resellerIds.map(() => '?').join(',');
    db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE timestamp >= ? AND timestamp < ?
         AND type = 'deposit'
         AND user_id NOT IN (${placeholders})`,
      [startTs, endTs, ...resellerIds],
      (err, row) => {
        if (err) return reject(err);
        resolve(Number(row?.total || 0));
      }
    );
  });
}

function getTopupIncomeResellerByRange(startTs, endTs) {
  const resellerIds = (listResellersSync() || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  return new Promise((resolve, reject) => {
    if (resellerIds.length === 0) {
      return resolve(0);
    }

    const placeholders = resellerIds.map(() => '?').join(',');
    db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE timestamp >= ? AND timestamp < ?
         AND type = 'deposit'
         AND user_id IN (${placeholders})`,
      [startTs, endTs, ...resellerIds],
      (err, row) => {
        if (err) return reject(err);
        resolve(Number(row?.total || 0));
      }
    );
  });
}

function getUserRoleCounts() {
  const resellerIds = (listResellersSync() || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as total FROM users', [], (totalErr, totalRow) => {
      if (totalErr) return reject(totalErr);
      const totalUsers = Number(totalRow?.total || 0);

      if (resellerIds.length === 0) {
        return resolve({
          totalUsers,
          resellerUsers: 0,
          nonResellerUsers: totalUsers,
          resellerListCount: 0
        });
      }

      const placeholders = resellerIds.map(() => '?').join(',');
      db.get(
        `SELECT COUNT(*) as total
         FROM users
         WHERE user_id IN (${placeholders})`,
        resellerIds,
        (resErr, resRow) => {
          if (resErr) return reject(resErr);
          const resellerUsers = Number(resRow?.total || 0);
          resolve({
            totalUsers,
            resellerUsers,
            nonResellerUsers: Math.max(0, totalUsers - resellerUsers),
            resellerListCount: resellerIds.length
          });
        }
      );
    });
  });
}

function getIncomeStatsByRange(startTs, endTs) {
  const accountTypes = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http'];
  const placeholders = accountTypes.map(() => '?').join(',');
  const accountParams = [startTs, endTs, ...accountTypes];
  const topupParams = [startTs, endTs];

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE timestamp >= ? AND timestamp < ?
         AND type IN (${placeholders})
         AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`,
      accountParams,
      (accountErr, accountRow) => {
        if (accountErr) return reject(accountErr);
        db.get(
          `SELECT COALESCE(SUM(amount), 0) as total
           FROM transactions
           WHERE timestamp >= ? AND timestamp < ?
             AND type = 'deposit'`,
          topupParams,
          (topupErr, topupRow) => {
            if (topupErr) return reject(topupErr);
            resolve({
              accountCount: Number(accountRow?.count || 0),
              accountIncome: Number(accountRow?.total || 0),
              topupIncome: Number(topupRow?.total || 0)
            });
          }
        );
      }
    );
  });
}

function escapeHtmlLocal(text) {
  if (!text && text !== 0) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');
const { isUserReseller, addReseller, removeReseller, listResellersSync } = require('./modules/reseller');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' }),
  ],
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer || '');
  }
}));
app.use(express.urlencoded({ extended: true }));

const { createzivpn } = require('./modules/createzivpn');
const { trialzivpn } = require('./modules/trialzivpn');

const { 
  createssh, 
  createudphttp,
  createvmess, 
  createvless, 
  createtrojan, 
  createshadowsocks 
} = require('./modules/create');

const { 
  trialssh, 
  trialudphttp,
  trialvmess, 
  trialvless, 
  trialtrojan, 
  trialshadowsocks 
} = require('./modules/trial');

const { 
  renewssh, 
  renewudphttp,
  renewvmess, 
  renewvless, 
  renewtrojan, 
  renewshadowsocks,
  renewzivpn
} = require('./modules/renew');

const { 
  delssh, 
  delvmess, 
  delvless, 
  deltrojan, 
  delzivpn,
  deludphttp
} = require('./modules/del');

const { 
  lockssh, 
  lockvmess, 
  lockvless, 
  locktrojan, 
  lockshadowsocks 
} = require('./modules/lock');

const { 
  unlockssh, 
  unlockvmess, 
  unlockvless, 
  unlocktrojan, 
  unlockshadowsocks 
} = require('./modules/unlock');

const trialFile = runtimePath('trial.db');

// Mengecek apakah user sudah pakai trial hari ini
async function checkTrialAccess(userId) {
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    const trialData = JSON.parse(data);
    const lastAccess = trialData[userId];

    const today = new Date().toISOString().slice(0, 10); // format YYYY-MM-DD
    return lastAccess === today;
  } catch (err) {
    return false; // anggap belum pernah pakai kalau file belum ada
  }
}
/////////
async function checkServerAccess(serverId, userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT is_reseller_only FROM Server WHERE id = ?', [serverId], async (err, row) => {
      if (err) return reject(err);
      // jika server tidak ada => tolak (caller menangani pesan)
      if (!row) return resolve({ ok: false, reason: 'not_found' });
      const flag = row.is_reseller_only === 1 || row.is_reseller_only === '1';
      if (!flag) return resolve({ ok: true }); // publik
      // jika reseller-only, cek apakah user terdaftar reseller
      try {
        const isR = await isUserReseller(userId);
        if (isR) return resolve({ ok: true });
        return resolve({ ok: false, reason: 'reseller_only' });
      } catch (e) {
        // fallback: tolak akses
        return resolve({ ok: false, reason: 'reseller_only' });
      }
    });
  });
}

// Menyimpan bahwa user sudah pakai trial hari ini
async function saveTrialAccess(userId) {
  let trialData = {};
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    trialData = JSON.parse(data);
  } catch (err) {
    // file belum ada, lanjut
  }

  const today = new Date().toISOString().slice(0, 10);
  trialData[userId] = today;
  await fsPromises.writeFile(trialFile, JSON.stringify(trialData, null, 2));
}

function loadVars() {
  return readJsonFileSafe(varsPath, {});
}

function saveVars(next) {
  const payload = { ...(next || {}) };
  fs.writeFileSync(varsPath, JSON.stringify(payload, null, 2), 'utf8');
}

function normalizeHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch (_err) {
    return '';
  }
}

function getSharedWebhookOrigin() {
  const configured = String(SC_MULTI_LOGIN_WEBHOOK_URL || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`);
    return url.origin;
  } catch (_) {
    return '';
  }
}

function getDanaBridgePublicEventUrl() {
  const origin = getSharedWebhookOrigin();
  return origin ? `${origin}/payment/dana-notification` : '';
}

function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '-';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function isPlaceholderSecret(secret) {
  const text = String(secret || '').trim().toLowerCase();
  return !text || ['none', 'null', 'undefined', '-', '0', 'false'].includes(text);
}

function compactText(value, maxLen = 180) {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch (_err) {
      text = String(value);
    }
  }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function formatGatewayAxiosError(provider, error, context = {}) {
  const gatewayBase = context.gatewayBase ? ` di ${context.gatewayBase}` : '';
  const status = error?.response?.status;
  const responseText = compactText(error?.response?.data, 180);

  if (status === 404) {
    return `${provider} gagal create QR: endpoint tidak ditemukan (HTTP 404)${gatewayBase}. Cek Gateway URL/path dari provider API.`;
  }
  if (status) {
    return `${provider} gagal create QR: HTTP ${status}${responseText ? ` - ${responseText}` : ''}`;
  }
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
    return `${provider} gagal create QR: request timeout ke gateway.`;
  }
  return `${provider} gagal create QR: ${error?.message || 'request gagal'}`;
}

function formatPaymentUserError(error) {
  return compactText(error?.message || error, 360) || 'Terjadi kesalahan saat membuat pembayaran.';
}

const vars = loadVars();

const BOT_TOKEN = vars.BOT_TOKEN;
const port = vars.PORT || 6969;
const ADMIN = vars.USER_ID; 
const NAMA_STORE = vars.NAMA_STORE || '@ARI_VPN_STORE';
process.env.BOTVPN_STORE_NAME = NAMA_STORE;

function getGeneratorApiConfig() {
  const currentVars = loadVars();
  return {
    GENERATOR_API_URL: currentVars.GENERATOR_API_URL || vars.GENERATOR_API_URL || DEFAULT_GENERATOR_API_URL,
    GENERATOR_API_KEY: currentVars.GENERATOR_API_KEY || currentVars.GENERATOR_API_TOKEN || vars.GENERATOR_API_KEY || vars.GENERATOR_API_TOKEN || '',
    GENERATOR_API_TIMEOUT_MS: currentVars.GENERATOR_API_TIMEOUT_MS || vars.GENERATOR_API_TIMEOUT_MS || 120000
  };
}

function normalizeGeneratorApiUrl(raw) {
  return normalizeGeneratorApiBaseUrl(raw);
}

let DATA_QRIS = vars.DATA_QRIS;
let DANA_QRIS = String(vars.DANA_QRIS || '').trim();
let MERCHANT_ID = vars.MERCHANT_ID;
let API_KEY = vars.API_KEY;
let RAJASERVER_API_KEY = vars.RAJASERVER_API_KEY;
let LOCAL_PAYMENT_API_KEY = String(vars.LOCAL_PAYMENT_API_KEY || vars.RAJASERVER_API_KEY || vars.API_KEY || '').trim();
let PAYMENT_GATEWAY_BASE_URL = String(vars.PAYMENT_GATEWAY_BASE_URL || 'https://api.rajaserver.web.id/orderkuota/createpayment').trim();
let PAYMENT_GATEWAY_MODE = String(vars.PAYMENT_GATEWAY_MODE || 'orderkuota').trim().toLowerCase();
let ORDERKUOTA_CREATE_MODE = String(vars.ORDERKUOTA_CREATE_MODE || 'local').trim().toLowerCase();
let GOPAY_API_BASE_URL = String(vars.GOPAY_API_BASE_URL || 'https://api-gopay.sawargipay.cloud').trim();
let GOPAY_API_KEY = String(vars.GOPAY_API_KEY || '').trim();
let DANA_BRIDGE_SECRET = String(vars.DANA_BRIDGE_SECRET || '').trim();
let ORDERKUOTA_QR_EXPIRE_MINUTES = Number(vars.ORDERKUOTA_QR_EXPIRE_MINUTES || 10);
let GOPAY_QR_EXPIRE_MINUTES = Number(vars.GOPAY_QR_EXPIRE_MINUTES || 15);
let DANA_BRIDGE_QR_EXPIRE_MINUTES = Number(vars.DANA_BRIDGE_QR_EXPIRE_MINUTES || 15);
let ORDERKUOTA_MIN_TOPUP = Number(vars.ORDERKUOTA_MIN_TOPUP || 2000);
let GOPAY_MIN_TOPUP = Number(vars.GOPAY_MIN_TOPUP || 2000);
let DANA_BRIDGE_MIN_TOPUP = Number(vars.DANA_BRIDGE_MIN_TOPUP || 10);
let DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS = Number(vars.DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS || 300);
let ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS = Number(vars.ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS || 10);
let ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES = Number(vars.ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES || 3);
let ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS = Number(vars.ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS || 60);
let ORDERKUOTA_CHECK_MAX_TAPS = Number(vars.ORDERKUOTA_CHECK_MAX_TAPS || 5);
const GROUP_ID = vars.GROUP_ID;
const BW_NOTIF_GROUP_ID = vars.BW_NOTIF_GROUP_ID;
function numberFromRuntimeSetting(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (Number.isFinite(min) && floored < min) return min;
  if (Number.isFinite(max) && floored > max) return max;
  return floored;
}

function normalizeTrialTimelimit(value, fallback = '1h') {
  const text = String(value || '').trim().toLowerCase();
  if (/^\d+[hm]$/.test(text)) return text;
  return fallback;
}

const TRIAL_QUOTA_GB = numberFromRuntimeSetting(
  vars.TRIAL_QUOTA_GB || process.env.TRIAL_QUOTA_GB,
  2,
  0,
  1024
);
const TRIAL_TIMELIMIT = normalizeTrialTimelimit(
  vars.TRIAL_TIMELIMIT || process.env.TRIAL_TIMELIMIT || '1h',
  '1h'
);
const TUNNEL_SUMMARY_TIMEOUT_MS = numberFromRuntimeSetting(
  vars.TUNNEL_SUMMARY_TIMEOUT_MS || process.env.TUNNEL_SUMMARY_TIMEOUT_MS,
  45000,
  5000,
  180000
);
const TUNNEL_EXPORT_TIMEOUT_MS = numberFromRuntimeSetting(
  vars.TUNNEL_EXPORT_TIMEOUT_MS || process.env.TUNNEL_EXPORT_TIMEOUT_MS,
  90000,
  10000,
  300000
);
const TUNNEL_VNSTAT_TIMEOUT_MS = numberFromRuntimeSetting(
  vars.TUNNEL_VNSTAT_TIMEOUT_MS || process.env.TUNNEL_VNSTAT_TIMEOUT_MS,
  30000,
  5000,
  120000
);
const TUNNEL_SYNC_RETRIES = numberFromRuntimeSetting(
  vars.TUNNEL_SYNC_RETRIES || process.env.TUNNEL_SYNC_RETRIES,
  1,
  0,
  3
);
const TUNNEL_SYNC_USE_EXPORT_COUNT = /^(1|true|yes|on)$/i.test(String(
  vars.TUNNEL_SYNC_USE_EXPORT_COUNT || process.env.TUNNEL_SYNC_USE_EXPORT_COUNT || '0'
).trim());
let BW_REPORT_INTERVAL_MINUTES = Number(vars.BW_REPORT_INTERVAL_MINUTES || 180);
if (!Number.isFinite(BW_REPORT_INTERVAL_MINUTES) || BW_REPORT_INTERVAL_MINUTES < 5) {
  BW_REPORT_INTERVAL_MINUTES = 180;
}
if (BW_REPORT_INTERVAL_MINUTES > 1440) BW_REPORT_INTERVAL_MINUTES = 1440;
let NOTIF_BOT_TOKEN = vars.NOTIF_BOT_TOKEN || '';
let NOTIF_CHAT_ID = vars.NOTIF_CHAT_ID || '';
let GLOBAL_CREATE_NOTIF_GROUP_ID = vars.GLOBAL_CREATE_NOTIF_GROUP_ID || '';
let BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN = String(
  vars.BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN ||
  vars.SC_EVENT_WEBHOOK_TOKEN ||
  ''
).trim();
let SC_MULTI_LOGIN_WEBHOOK_URL = String(
  vars.SC_MULTI_LOGIN_WEBHOOK_URL ||
  vars.BOT_ACCOUNT_EVENT_WEBHOOK_URL ||
  ''
).trim();
let ADMIN_WHATSAPP = String(vars.ADMIN_WHATSAPP || vars.CONTACT_WA || '').replace(/\D/g, '');
let ADMIN_TELEGRAM = String(vars.ADMIN_TELEGRAM || vars.CONTACT_TELEGRAM || '').trim().replace(/^@+/, '');
let MAIN_MENU_GROUP_ENABLED = parseBooleanSetting(vars.MAIN_MENU_GROUP_ENABLED, false);
let MAIN_MENU_GROUP_LABEL = normalizeMainMenuButtonLabel(vars.MAIN_MENU_GROUP_LABEL, 'Grup Telegram');
let MAIN_MENU_GROUP_URL = normalizeMainMenuButtonUrl(vars.MAIN_MENU_GROUP_URL || vars.MAIN_MENU_GROUP_LINK || '');
let MAIN_MENU_CHANNEL_ENABLED = parseBooleanSetting(vars.MAIN_MENU_CHANNEL_ENABLED, false);
let MAIN_MENU_CHANNEL_LABEL = normalizeMainMenuButtonLabel(vars.MAIN_MENU_CHANNEL_LABEL, 'Channel Telegram');
let MAIN_MENU_CHANNEL_URL = normalizeMainMenuButtonUrl(vars.MAIN_MENU_CHANNEL_URL || vars.MAIN_MENU_CHANNEL_LINK || '');
let MAIN_MENU_TUTORIAL_ENABLED = parseBooleanSetting(vars.MAIN_MENU_TUTORIAL_ENABLED, true);
let PPOB_ENABLED = parseBooleanSetting(vars.PPOB_ENABLED ?? process.env.PPOB_ENABLED, true);
let PPOB_MARKUP_FEE = numberFromRuntimeSetting(
  vars.PPOB_MARKUP_FEE || vars.PRODUCT_MARKUP_FEE || process.env.PPOB_MARKUP_FEE || process.env.PRODUCT_MARKUP_FEE,
  0,
  0,
  1000000
);
let DIGIFLAZZ_BASE_URL = String(vars.DIGIFLAZZ_BASE_URL || process.env.DIGIFLAZZ_BASE_URL || 'https://api.digiflazz.com').trim();
let DIGIFLAZZ_USERNAME = String(vars.DIGIFLAZZ_USERNAME || process.env.DIGIFLAZZ_USERNAME || '').trim();
let DIGIFLAZZ_API_KEY = String(vars.DIGIFLAZZ_API_KEY || process.env.DIGIFLAZZ_API_KEY || '').trim();
let PPOB_NOTIF_GROUP_ID = String(vars.PPOB_NOTIF_GROUP_ID || '').trim();
let PPOB_ADMIN_GROUP_ID = String(vars.PPOB_ADMIN_GROUP_ID || '').trim();
let PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD = numberFromRuntimeSetting(
  vars.PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD || process.env.PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD,
  100000,
  0,
  1000000000
);
let PPOB_CUTOFF_ENABLED = parseBooleanSetting(vars.PPOB_CUTOFF_ENABLED ?? process.env.PPOB_CUTOFF_ENABLED, true);
let PPOB_CUTOFF_START = String(vars.PPOB_CUTOFF_START || process.env.PPOB_CUTOFF_START || '23:30').trim();
let PPOB_CUTOFF_END = String(vars.PPOB_CUTOFF_END || process.env.PPOB_CUTOFF_END || '01:15').trim();
let PPOB_AUTOSYNC_ENABLED = parseBooleanSetting(vars.PPOB_AUTOSYNC_ENABLED ?? process.env.PPOB_AUTOSYNC_ENABLED, true);
let PPOB_AUTOSYNC_TIME = String(vars.PPOB_AUTOSYNC_TIME || process.env.PPOB_AUTOSYNC_TIME || '00:05').trim();
let PPOB_DISABLED_CATEGORIES = parsePpobDisabledListSetting(vars.PPOB_DISABLED_CATEGORIES);
let PPOB_DISABLED_BRANDS = parsePpobDisabledListSetting(vars.PPOB_DISABLED_BRANDS);
let PPOB_DISABLED_TYPES = parsePpobDisabledListSetting(vars.PPOB_DISABLED_TYPES);
let PPOB_DISABLED_SKUS = parsePpobDisabledListSetting(vars.PPOB_DISABLED_SKUS);
let ppobAutoSyncJob = null;

function getPpobConfig() {
  return {
    baseUrl: DIGIFLAZZ_BASE_URL,
    username: DIGIFLAZZ_USERNAME,
    apiKey: DIGIFLAZZ_API_KEY,
    markupFee: PPOB_MARKUP_FEE,
    sharedCacheDir: path.join(ROOT_DIR, 'data', 'ppob-pricelist-cache'),
    sharedCacheTtlMs: 15 * 60 * 1000
  };
}

async function getEffectivePpobContext() {
  return {
    mode: 'own',
    markupFee: PPOB_MARKUP_FEE,
    config: getPpobConfig(),
    account: null
  };
}

function normalizeWalletType(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'ppob' ? 'ppob' : 'vpn';
}

function getWalletColumn(walletType) {
  return normalizeWalletType(walletType) === 'ppob' ? 'saldo_ppob' : 'saldo';
}

function getWalletLabel(walletType) {
  return normalizeWalletType(walletType) === 'ppob' ? 'Saldo PPOB' : 'Saldo VPN';
}

function getWalletTransactionSuffix(walletType) {
  return normalizeWalletType(walletType) === 'ppob' ? 'ppob' : 'vpn';
}

function parsePpobDisabledListSetting(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  const text = String(value || '').trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsePpobDisabledListSetting(parsed);
    } catch (_) {}
  }

  return text
    .split(/[\n,|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePpobCompare(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePpobDisabledList(values) {
  const seen = new Set();
  const result = [];
  parsePpobDisabledListSetting(values).forEach((item) => {
    const key = normalizePpobCompare(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(String(item).trim());
  });
  return result;
}

function ppobDisabledListHas(list, value) {
  const key = normalizePpobCompare(value);
  if (!key) return false;
  return normalizePpobDisabledList(list).some((item) => normalizePpobCompare(item) === key);
}

function ppobUniqueSorted(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'id-ID'));
}

function ppobBuildCatalog(products) {
  const rows = Array.isArray(products) ? products : [];
  return {
    products: rows,
    categories: ppobUniqueSorted(rows.map((product) => product.category)),
    brands: ppobUniqueSorted(rows.map((product) => product.brand)),
    types: ppobUniqueSorted(rows.map((product) => product.type))
  };
}

function ppobProductIsVisible(product) {
  if (!product) return false;
  if (ppobDisabledListHas(PPOB_DISABLED_CATEGORIES, product.category)) return false;
  if (ppobDisabledListHas(PPOB_DISABLED_BRANDS, product.brand)) return false;
  if (ppobDisabledListHas(PPOB_DISABLED_TYPES, product.type)) return false;
  if (ppobDisabledListHas(PPOB_DISABLED_SKUS, product.buyerSkuCode)) return false;
  return true;
}

function ppobApplyVisibilityFilter(catalog) {
  const products = Array.isArray(catalog?.products) ? catalog.products.filter(ppobProductIsVisible) : [];
  return ppobBuildCatalog(products);
}

function normalizePpobCutoffTime(value, fallback = '00:00') {
  const text = String(value || '').trim().replace('.', ':');
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function ppobTimeToMinutes(value) {
  const text = normalizePpobCutoffTime(value, '');
  if (!text) return null;
  const [hour, minute] = text.split(':').map(Number);
  return hour * 60 + minute;
}

function getJakartaMinutesOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function getPpobCutoffStatus(date = new Date()) {
  const start = normalizePpobCutoffTime(PPOB_CUTOFF_START, '23:30');
  const end = normalizePpobCutoffTime(PPOB_CUTOFF_END, '01:15');
  const startMinutes = ppobTimeToMinutes(start);
  const endMinutes = ppobTimeToMinutes(end);
  const nowMinutes = getJakartaMinutesOfDay(date);
  const active = Boolean(PPOB_CUTOFF_ENABLED) && startMinutes !== endMinutes && (
    startMinutes < endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes
  );
  return { active, start, end };
}

function formatPpobCutoffNotice(status = getPpobCutoffStatus()) {
  return [
    '<b>PPOB sedang maintenance provider harian.</b>',
    '',
    `Pembelian ditutup pukul <b>${escapeHtml(status.start)}-${escapeHtml(status.end)} WIB</b>.`,
    `Silakan transaksi lagi setelah <b>${escapeHtml(status.end)} WIB</b>.`
  ].join('\n');
}

function savePpobRuntimeVars(partial) {
  const shouldClearCatalogCache = ['DIGIFLAZZ_USERNAME', 'DIGIFLAZZ_API_KEY', 'DIGIFLAZZ_BASE_URL']
    .some((key) => Object.prototype.hasOwnProperty.call(partial || {}, key));
  const shouldRestartAutoSync = ['PPOB_AUTOSYNC_ENABLED', 'PPOB_AUTOSYNC_TIME']
    .some((key) => Object.prototype.hasOwnProperty.call(partial || {}, key));
  const nextVars = loadVars();
  Object.assign(nextVars, partial || {});
  saveVars(nextVars);
  if (shouldClearCatalogCache && typeof ppobService.clearCache === 'function') {
    ppobService.clearCache();
  }
  reloadRuntimePaymentConfig();
  if (shouldRestartAutoSync && typeof restartPpobAutoSyncScheduler === 'function') {
    restartPpobAutoSyncScheduler();
  }
  return nextVars;
}

function getPpobDisabledVarsKey(kind) {
  const map = {
    category: 'PPOB_DISABLED_CATEGORIES',
    brand: 'PPOB_DISABLED_BRANDS',
    type: 'PPOB_DISABLED_TYPES',
    sku: 'PPOB_DISABLED_SKUS'
  };
  return map[kind] || '';
}

function getPpobDisabledValues(kind) {
  switch (kind) {
    case 'category':
      return PPOB_DISABLED_CATEGORIES;
    case 'brand':
      return PPOB_DISABLED_BRANDS;
    case 'type':
      return PPOB_DISABLED_TYPES;
    case 'sku':
      return PPOB_DISABLED_SKUS;
    default:
      return [];
  }
}

function setPpobDisabledValues(kind, values) {
  const varsKey = getPpobDisabledVarsKey(kind);
  if (!varsKey) return [];
  const normalized = normalizePpobDisabledList(values);
  savePpobRuntimeVars({ [varsKey]: normalized });
  return normalized;
}

function togglePpobDisabledValue(kind, value) {
  const current = normalizePpobDisabledList(getPpobDisabledValues(kind));
  const targetKey = normalizePpobCompare(value);
  const exists = current.some((item) => normalizePpobCompare(item) === targetKey);
  const next = exists
    ? current.filter((item) => normalizePpobCompare(item) !== targetKey)
    : [...current, String(value || '').trim()].filter(Boolean);
  setPpobDisabledValues(kind, next);
  return !exists;
}

function parseBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return !!fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'aktif', 'active'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'nonaktif', 'inactive'].includes(text)) return false;
  return !!fallback;
}

function normalizeMainMenuButtonLabel(raw, fallback) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.slice(0, 48);
}

function normalizeMainMenuButtonUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^@[a-zA-Z0-9_]{5,32}$/.test(text)) return `https://t.me/${text.slice(1)}`;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function applyMainMenuRuntimeSettings(source) {
  MAIN_MENU_GROUP_ENABLED = parseBooleanSetting(source.MAIN_MENU_GROUP_ENABLED, MAIN_MENU_GROUP_ENABLED);
  MAIN_MENU_GROUP_LABEL = normalizeMainMenuButtonLabel(source.MAIN_MENU_GROUP_LABEL, MAIN_MENU_GROUP_LABEL || 'Grup Telegram');
  MAIN_MENU_GROUP_URL = normalizeMainMenuButtonUrl(source.MAIN_MENU_GROUP_URL || source.MAIN_MENU_GROUP_LINK || MAIN_MENU_GROUP_URL);
  MAIN_MENU_CHANNEL_ENABLED = parseBooleanSetting(source.MAIN_MENU_CHANNEL_ENABLED, MAIN_MENU_CHANNEL_ENABLED);
  MAIN_MENU_CHANNEL_LABEL = normalizeMainMenuButtonLabel(source.MAIN_MENU_CHANNEL_LABEL, MAIN_MENU_CHANNEL_LABEL || 'Channel Telegram');
  MAIN_MENU_CHANNEL_URL = normalizeMainMenuButtonUrl(source.MAIN_MENU_CHANNEL_URL || source.MAIN_MENU_CHANNEL_LINK || MAIN_MENU_CHANNEL_URL);
  MAIN_MENU_TUTORIAL_ENABLED = parseBooleanSetting(source.MAIN_MENU_TUTORIAL_ENABLED, MAIN_MENU_TUTORIAL_ENABLED);
}

function saveMainMenuRuntimeVars(partial) {
  const nextVars = loadVars();
  Object.assign(nextVars, partial);
  saveVars(nextVars);
  applyMainMenuRuntimeSettings(nextVars);
  return nextVars;
}

function reloadRuntimePaymentConfig() {
  const current = loadVars();
  DATA_QRIS = current.DATA_QRIS || '';
  DANA_QRIS = String(current.DANA_QRIS || '').trim();
  MERCHANT_ID = current.MERCHANT_ID || '';
  API_KEY = current.API_KEY || '';
  RAJASERVER_API_KEY = current.RAJASERVER_API_KEY || '';
  LOCAL_PAYMENT_API_KEY = String(current.LOCAL_PAYMENT_API_KEY || current.RAJASERVER_API_KEY || current.API_KEY || '').trim();
  ORDERKUOTA_CREATE_MODE = String(current.ORDERKUOTA_CREATE_MODE || ORDERKUOTA_CREATE_MODE || 'local').trim().toLowerCase();
  if (!['local', 'gateway'].includes(ORDERKUOTA_CREATE_MODE)) {
    ORDERKUOTA_CREATE_MODE = 'local';
  }
  PAYMENT_GATEWAY_MODE = String(current.PAYMENT_GATEWAY_MODE || PAYMENT_GATEWAY_MODE || 'orderkuota').trim().toLowerCase();
  if (!['orderkuota', 'gopay', 'both', 'dana_notification'].includes(PAYMENT_GATEWAY_MODE)) {
    PAYMENT_GATEWAY_MODE = 'orderkuota';
  }
  PAYMENT_GATEWAY_BASE_URL = normalizeHttpUrl(current.PAYMENT_GATEWAY_BASE_URL || PAYMENT_GATEWAY_BASE_URL)
    || 'https://api.rajaserver.web.id/orderkuota/createpayment';
  GOPAY_API_BASE_URL = normalizeHttpUrl(current.GOPAY_API_BASE_URL || GOPAY_API_BASE_URL)
    || 'https://api-gopay.sawargipay.cloud';
  GOPAY_API_KEY = String(current.GOPAY_API_KEY || '').trim();
  DANA_BRIDGE_SECRET = String(current.DANA_BRIDGE_SECRET || '').trim();
  ORDERKUOTA_QR_EXPIRE_MINUTES = Number(current.ORDERKUOTA_QR_EXPIRE_MINUTES || ORDERKUOTA_QR_EXPIRE_MINUTES || 10);
  GOPAY_QR_EXPIRE_MINUTES = Number(current.GOPAY_QR_EXPIRE_MINUTES || GOPAY_QR_EXPIRE_MINUTES || 15);
  DANA_BRIDGE_QR_EXPIRE_MINUTES = Number(current.DANA_BRIDGE_QR_EXPIRE_MINUTES || DANA_BRIDGE_QR_EXPIRE_MINUTES || 15);
  ORDERKUOTA_MIN_TOPUP = Number(current.ORDERKUOTA_MIN_TOPUP || ORDERKUOTA_MIN_TOPUP || 2000);
  GOPAY_MIN_TOPUP = Number(current.GOPAY_MIN_TOPUP || GOPAY_MIN_TOPUP || 2000);
  DANA_BRIDGE_MIN_TOPUP = Number(current.DANA_BRIDGE_MIN_TOPUP || DANA_BRIDGE_MIN_TOPUP || 10);
  DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS = Number(current.DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS || DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS || 300);
  ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS = Number(current.ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS || ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS || 10);
  ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES = Number(current.ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES || ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES || 3);
  ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS = Number(current.ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS || ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS || 60);
  ORDERKUOTA_CHECK_MAX_TAPS = Number(current.ORDERKUOTA_CHECK_MAX_TAPS || ORDERKUOTA_CHECK_MAX_TAPS || 5);

  if (!Number.isFinite(ORDERKUOTA_QR_EXPIRE_MINUTES) || ORDERKUOTA_QR_EXPIRE_MINUTES < 1) ORDERKUOTA_QR_EXPIRE_MINUTES = 10;
  if (!Number.isFinite(GOPAY_QR_EXPIRE_MINUTES) || GOPAY_QR_EXPIRE_MINUTES < 1) GOPAY_QR_EXPIRE_MINUTES = 15;
  if (!Number.isFinite(DANA_BRIDGE_QR_EXPIRE_MINUTES) || DANA_BRIDGE_QR_EXPIRE_MINUTES < 1) DANA_BRIDGE_QR_EXPIRE_MINUTES = 15;
  if (!Number.isFinite(ORDERKUOTA_MIN_TOPUP) || ORDERKUOTA_MIN_TOPUP < 1000) ORDERKUOTA_MIN_TOPUP = 2000;
  if (!Number.isFinite(GOPAY_MIN_TOPUP) || GOPAY_MIN_TOPUP < 1000) GOPAY_MIN_TOPUP = 2000;
  if (!Number.isFinite(DANA_BRIDGE_MIN_TOPUP) || DANA_BRIDGE_MIN_TOPUP < 10) DANA_BRIDGE_MIN_TOPUP = 10;
  if (!Number.isFinite(DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS) || DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS < 30) DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS = 300;
  if (!Number.isFinite(ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS) || ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS < 5) ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS = 10;
  if (!Number.isFinite(ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES) || ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES < 1) ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES = 3;
  if (!Number.isFinite(ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS) || ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS < 10) ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS = 60;
  if (!Number.isFinite(ORDERKUOTA_CHECK_MAX_TAPS) || ORDERKUOTA_CHECK_MAX_TAPS < 1) ORDERKUOTA_CHECK_MAX_TAPS = 5;
  PPOB_ENABLED = parseBooleanSetting(current.PPOB_ENABLED ?? PPOB_ENABLED, PPOB_ENABLED);
  PPOB_MARKUP_FEE = numberFromRuntimeSetting(
    current.PPOB_MARKUP_FEE || current.PRODUCT_MARKUP_FEE || PPOB_MARKUP_FEE,
    PPOB_MARKUP_FEE,
    0,
    1000000
  );
  DIGIFLAZZ_BASE_URL = String(current.DIGIFLAZZ_BASE_URL || DIGIFLAZZ_BASE_URL || 'https://api.digiflazz.com').trim();
  DIGIFLAZZ_USERNAME = String(current.DIGIFLAZZ_USERNAME || process.env.DIGIFLAZZ_USERNAME || DIGIFLAZZ_USERNAME || '').trim();
  DIGIFLAZZ_API_KEY = String(current.DIGIFLAZZ_API_KEY || process.env.DIGIFLAZZ_API_KEY || DIGIFLAZZ_API_KEY || '').trim();
  PPOB_NOTIF_GROUP_ID = String(current.PPOB_NOTIF_GROUP_ID || PPOB_NOTIF_GROUP_ID || '').trim();
  PPOB_ADMIN_GROUP_ID = String(current.PPOB_ADMIN_GROUP_ID || PPOB_ADMIN_GROUP_ID || '').trim();
  PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD = numberFromRuntimeSetting(
    current.PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD || PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD,
    PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD,
    0,
    1000000000
  );
  PPOB_CUTOFF_ENABLED = parseBooleanSetting(current.PPOB_CUTOFF_ENABLED ?? PPOB_CUTOFF_ENABLED, PPOB_CUTOFF_ENABLED);
  PPOB_CUTOFF_START = normalizePpobCutoffTime(current.PPOB_CUTOFF_START || PPOB_CUTOFF_START, '23:30');
  PPOB_CUTOFF_END = normalizePpobCutoffTime(current.PPOB_CUTOFF_END || PPOB_CUTOFF_END, '01:15');
  PPOB_AUTOSYNC_ENABLED = parseBooleanSetting(current.PPOB_AUTOSYNC_ENABLED ?? PPOB_AUTOSYNC_ENABLED, PPOB_AUTOSYNC_ENABLED);
  PPOB_AUTOSYNC_TIME = normalizePpobCutoffTime(current.PPOB_AUTOSYNC_TIME || PPOB_AUTOSYNC_TIME, '00:05');
  PPOB_DISABLED_CATEGORIES = normalizePpobDisabledList(current.PPOB_DISABLED_CATEGORIES || PPOB_DISABLED_CATEGORIES);
  PPOB_DISABLED_BRANDS = normalizePpobDisabledList(current.PPOB_DISABLED_BRANDS || PPOB_DISABLED_BRANDS);
  PPOB_DISABLED_TYPES = normalizePpobDisabledList(current.PPOB_DISABLED_TYPES || PPOB_DISABLED_TYPES);
  PPOB_DISABLED_SKUS = normalizePpobDisabledList(current.PPOB_DISABLED_SKUS || PPOB_DISABLED_SKUS);
  applyMainMenuRuntimeSettings(current);
}
reloadRuntimePaymentConfig();

function loadDanaBridgeStatus() {
  return readJsonFileSafe(danaBridgeStatusPath, {
    last_seen_at: 0,
    device_id: '',
    app_version: '',
    queue_size: 0,
    last_event_at: 0
  });
}

function saveDanaBridgeStatus(partial) {
  const current = loadDanaBridgeStatus();
  const next = { ...current, ...(partial || {}) };
  fs.writeFileSync(danaBridgeStatusPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function isDanaBridgeOnline(now = Date.now()) {
  const status = loadDanaBridgeStatus();
  return Number(status.last_seen_at || 0) > 0 && now - Number(status.last_seen_at) <= 3 * 60 * 1000;
}

function isGatewayEnabled(name) {
  const mode = String(PAYMENT_GATEWAY_MODE || 'orderkuota').toLowerCase();
  if (mode === 'both') return name === 'orderkuota' || name === 'gopay';
  return mode === name;
}

function formatGatewayModeLabel() {
  switch (String(PAYMENT_GATEWAY_MODE || '').toLowerCase()) {
    case 'gopay':
      return 'GoPay saja';
    case 'both':
      return 'OrderKuota + GoPay';
    case 'dana_notification':
      return 'DANA Bisnis (Notifikasi HP)';
    default:
      return 'OrderKuota saja';
  }
}

function formatOrderKuotaCreateModeLabel() {
  return ORDERKUOTA_CREATE_MODE === 'gateway'
    ? 'Gateway eksternal'
    : 'Lokal bot tanpa RajaServer';
}

function getMinTopupByProvider(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'orderkuota') return Math.max(1000, Number(ORDERKUOTA_MIN_TOPUP || 2000));
  if (p === 'dana_notification') return Math.max(10, Number(DANA_BRIDGE_MIN_TOPUP || 10));
  return Math.max(1000, Number(GOPAY_MIN_TOPUP || 2000));
}

function getMinTopupByGatewayMode(mode) {
  const normalizedMode = String(mode || PAYMENT_GATEWAY_MODE || 'orderkuota').toLowerCase();
  if (normalizedMode === 'gopay') return getMinTopupByProvider('gopay');
  if (normalizedMode === 'dana_notification') return getMinTopupByProvider('dana_notification');
  if (normalizedMode === 'both') return Math.max(getMinTopupByProvider('orderkuota'), getMinTopupByProvider('gopay'));
  return getMinTopupByProvider('orderkuota');
}

function isOrderKuotaCredentialDefault() {
  try {
    const { buildPayload } = require('./api-cekpayment-orkut');
    const qs = require('qs');
    const payload = buildPayload();
    const decoded = qs.parse(payload);
    return (
      decoded.username === 'yantoxxx' ||
      decoded.username === 'AKUN_DEFAULT' ||
      (decoded.token && (
        decoded.token.includes('xxxxx') ||
        decoded.token.includes('TOKEN_DEFAULT') ||
        decoded.token.includes('contoh')
      ))
    );
  } catch (err) {
    logger.warn('Gagal membaca credential OrderKuota: ' + err.message);
    return true;
  }
}

function getPaymentGatewayReadiness() {
  const orderKuotaMissing = [];
  if (ORDERKUOTA_CREATE_MODE === 'gateway' && isPlaceholderSecret(RAJASERVER_API_KEY)) {
    orderKuotaMissing.push('RAJASERVER_API_KEY');
  }
  if (!DATA_QRIS) orderKuotaMissing.push('DATA_QRIS');
  if (isOrderKuotaCredentialDefault()) orderKuotaMissing.push('ORKUT_USERNAME/ORKUT_TOKEN');

  const gopayMissing = [];
  if (!GOPAY_API_KEY) gopayMissing.push('GOPAY_API_KEY');

  const danaMissing = [];
  if (!DANA_QRIS) danaMissing.push('DANA_QRIS');
  if (DANA_BRIDGE_SECRET.length < 32) danaMissing.push('DANA_BRIDGE_SECRET');

  return {
    orderkuota: {
      enabled: isGatewayEnabled('orderkuota'),
      ready: orderKuotaMissing.length === 0,
      missing: orderKuotaMissing
    },
    gopay: {
      enabled: isGatewayEnabled('gopay'),
      ready: gopayMissing.length === 0,
      missing: gopayMissing
    },
    danaNotification: {
      enabled: isGatewayEnabled('dana_notification'),
      ready: danaMissing.length === 0 && isDanaBridgeOnline(),
      configured: danaMissing.length === 0,
      online: isDanaBridgeOnline(),
      missing: danaMissing.length ? danaMissing : (isDanaBridgeOnline() ? [] : ['APLIKASI BRIDGE OFFLINE'])
    }
  };
}

function hasReadyEnabledPaymentGateway(readiness = getPaymentGatewayReadiness()) {
  return (
    (readiness.orderkuota.enabled && readiness.orderkuota.ready) ||
    (readiness.gopay.enabled && readiness.gopay.ready) ||
    (readiness.danaNotification.enabled && readiness.danaNotification.ready)
  );
}

function formatMissingGatewayConfig(readiness) {
  const lines = [];
  if (readiness.orderkuota.enabled && !readiness.orderkuota.ready) {
    lines.push(`OrderKuota kurang: ${readiness.orderkuota.missing.join(', ')}`);
  }
  if (readiness.gopay.enabled && !readiness.gopay.ready) {
    lines.push(`GoPay kurang: ${readiness.gopay.missing.join(', ')}`);
  }
  if (readiness.danaNotification.enabled && !readiness.danaNotification.ready) {
    lines.push(`DANA Notifikasi kurang: ${readiness.danaNotification.missing.join(', ')}`);
  }
  return lines.join('\n') || 'Gateway aktif belum siap.';
}

function formatDateId(date) {
  try {
    return date.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

function getAdminWhatsappNumber() {
  return String(ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

function getAdminWhatsappUrl() {
  const number = getAdminWhatsappNumber();
  return number ? `https://wa.me/${number}` : null;
}

function getAdminTelegramUsername() {
  const normalized = String(ADMIN_TELEGRAM || '').trim().replace(/^@+/, '');
  if (normalized) return `@${normalized}`;
  return ADMIN_USERNAME || 'Admin';
}

function upsertAccountRecord(payload) {
  const now = Date.now();
  db.get(
    `SELECT id FROM accounts
      WHERE user_id = ?
        AND type = ?
        AND username = ?
        AND (
          server_id = ?
          OR (
            ? <> ''
            AND LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
          )
        )
      ORDER BY id DESC
      LIMIT 1`,
    [
      payload.userId,
      payload.type,
      payload.username,
      payload.serverId,
      String(payload.domain || '').trim(),
      String(payload.domain || '').trim()
    ],
    (err, row) => {
      if (err) {
        logger.error('Gagal cek akun:', err.message);
        return;
      }
      if (row) {
        db.run(
          'UPDATE accounts SET password = ?, server_id = ?, server_name = ?, domain = ?, link_tls = ?, link_none = ?, link_grpc = ?, link_uptls = ?, link_upntls = ?, account_ip_package = ?, account_price_per_day = ?, expires_at = ? WHERE id = ?',
          [
            payload.password || null,
            payload.serverId,
            payload.serverName || null,
            payload.domain || null,
            payload.link_tls || null,
            payload.link_none || null,
            payload.link_grpc || null,
            payload.link_uptls || null,
            payload.link_upntls || null,
            Number(payload.accountIpPackage || 1) === 2 ? 2 : 1,
            Math.max(0, Number(payload.accountPricePerDay || 0)),
            payload.expiresAt,
            row.id
          ]
        );
      } else {
        db.run(
          'INSERT INTO accounts (user_id, type, username, password, server_id, server_name, domain, link_tls, link_none, link_grpc, link_uptls, link_upntls, account_ip_package, account_price_per_day, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            payload.userId,
            payload.type,
            payload.username,
            payload.password || null,
            payload.serverId,
            payload.serverName || null,
            payload.domain || null,
            payload.link_tls || null,
            payload.link_none || null,
            payload.link_grpc || null,
            payload.link_uptls || null,
            payload.link_upntls || null,
            Number(payload.accountIpPackage || 1) === 2 ? 2 : 1,
            Math.max(0, Number(payload.accountPricePerDay || 0)),
            now,
            payload.expiresAt
          ]
        );
      }
    }
  );
}

function getAccountExistingExpiry(userId, type, username, serverId, domain = '') {
  return new Promise((resolve) => {
    db.get(
      `SELECT expires_at FROM accounts
        WHERE user_id = ?
          AND type = ?
          AND username = ?
          AND (
            server_id = ?
            OR (
              ? <> ''
              AND LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
            )
          )
        ORDER BY expires_at DESC
        LIMIT 1`,
      [userId, type, username, serverId, String(domain || '').trim(), String(domain || '').trim()],
      (err, row) => {
        if (err) {
          logger.error('Gagal ambil expires_at akun:', err.message);
          return resolve(null);
        }
        const exp = Number(row?.expires_at || 0);
        resolve(Number.isFinite(exp) && exp > 0 ? exp : null);
      }
    );
  });
}

function cleanupExpiredAccounts() {
  const now = Date.now();
  const cutoff = now - (3 * 24 * 60 * 60 * 1000);
  db.run('DELETE FROM accounts WHERE expires_at IS NOT NULL AND expires_at < ?', [cutoff], (err) => {
    if (err) {
      logger.error('Gagal cleanup accounts expired:', err.message);
    }
  });
}

function migrateAccountServerByDomain() {
  return new Promise((resolve) => {
    db.all(
      `SELECT a.id, a.domain
       FROM accounts a
       WHERE (a.server_id IS NULL OR a.server_id = 0)
         AND a.domain IS NOT NULL
         AND TRIM(a.domain) <> ''`,
      [],
      (err, rows) => {
        if (err) {
          logger.error('Gagal membaca accounts untuk migrasi server_id:', err.message);
          return resolve({ updated: 0, total: 0 });
        }

        if (!rows || rows.length === 0) {
          return resolve({ updated: 0, total: 0 });
        }

        let updated = 0;
        let processed = 0;

        const done = () => {
          if (processed >= rows.length) {
            return resolve({ updated, total: rows.length });
          }
        };

        rows.forEach((row) => {
          const domain = String(row.domain || '').trim();
          db.get(
            `SELECT id, COALESCE(NULLIF(nama_server, ''), domain) AS server_label
             FROM Server
             WHERE LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
             ORDER BY id DESC
             LIMIT 1`,
            [domain],
            (mapErr, serverRow) => {
              if (mapErr) {
                logger.error('Gagal mapping domain ke server saat migrasi:', mapErr.message);
                processed += 1;
                return done();
              }

              if (!serverRow) {
                processed += 1;
                return done();
              }

              db.run(
                'UPDATE accounts SET server_id = ?, server_name = COALESCE(server_name, ?), domain = ? WHERE id = ?',
                [serverRow.id, serverRow.server_label || domain, domain, row.id],
                function(updateErr) {
                  if (updateErr) {
                    logger.error('Gagal update accounts saat migrasi server_id:', updateErr.message);
                  } else if (this && this.changes > 0) {
                    updated += this.changes;
                  }
                  processed += 1;
                  done();
                }
              );
            }
          );
        });
      }
    );
  });
}

function extractAccountLinksFromMessage(message) {
  const text = String(message || '');
  const getLine = (label) => {
    const re = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, 'i');
    const m = text.match(re);
    return m ? m[1].replace(/[`]/g, '').trim() : null;
  };

  const linkTls = getLine('link TLS') || getLine('TLS');
  const linkNone = getLine('link none TLS') || getLine('Non-TLS');
  const linkGrpc = getLine('link GRPC') || getLine('gRPC');
  const linkUpTls = getLine('link Upgrade TLS') || getLine('Up TLS');
  const linkUpNone = getLine('link Upgrade nTLS') || getLine('Up Non-TLS');

  return {
    link_tls: linkTls,
    link_none: linkNone,
    link_grpc: linkGrpc,
    link_uptls: linkUpTls,
    link_upntls: linkUpNone
  };
}

setInterval(cleanupExpiredAccounts, 6 * 60 * 60 * 1000);

async function sendNonResellerCreateNotification(payload) {
  if (!NOTIF_BOT_TOKEN || !NOTIF_CHAT_ID) return;
  try {
    const text =
      `🔔 NOTIFIKASI AKUN BARU (NON-RESELLER)\n\n` +
      `Layanan: ${payload.service}\n` +
      `Server: ${payload.serverName || '-'}\n` +
      `Domain: ${payload.domain || '-'}\n` +
      `Username: ${payload.accountUsername}\n` +
      `Password: ${payload.accountPassword || '-'}\n` +
      `Masa Aktif: ${payload.expDays} hari\n` +
      `Expired: ${payload.expiredDate}\n\n` +
      `Pembuat: ${payload.creatorLabel}\n` +
      `User ID: ${payload.creatorId}`;

    await axios.post(
      `https://api.telegram.org/bot${NOTIF_BOT_TOKEN}/sendMessage`,
      { chat_id: NOTIF_CHAT_ID, text }
    );
  } catch (err) {
    logger.error('❌ Gagal kirim notif create non-reseller:', err.message);
  }
}

function maskAfterFirstTwoChars(raw) {
  const value = String(raw || '').trim();
  if (!value) return '-';
  if (value.length <= 2) return value;
  return value.slice(0, 2) + '*'.repeat(value.length - 2);
}

function maskKeepFirstThreeChars(raw) {
  const value = String(raw || '').trim();
  if (!value) return '-';
  if (value.length <= 3) return value;
  return value.slice(0, 3) + '*'.repeat(value.length - 3);
}

function buildCreateNotifRemarks(type, username) {
  const t = String(type || '').toLowerCase();
  const u = String(username || '').trim();
  if (!u) return '-';
  if (t === 'zivpn' || t === 'ssh' || t === 'udp_http') return maskKeepFirstThreeChars(u);
  return u;
}

async function sendGlobalCreateAccountNotification(payload) {
  const groupId = Number(String(GLOBAL_CREATE_NOTIF_GROUP_ID || '').trim());
  if (!Number.isFinite(groupId) || groupId === 0) return;

  const text =
    '*🔥AKUN BERHASIL DIBUAT !!*\n\n' +
    '```Informasi\n' +
    `ID TELE PEMBUAT : ${payload.creatorId || '-'}\n` +
    `USERNAME TELE   : ${payload.creatorUsername || '-'}\n` +
    `SERVER          : ${payload.serverName || '-'}\n` +
    `JENIS AKUN      : ${payload.accountType || '-'}\n` +
    `ROLE            : ${payload.role || '-'}\n` +
    `REMAKS          : ${payload.remarks || '-'}\n` +
    `MASA AKTIF      : (${payload.expDays || 0} Hari)\n` +
    `EXPIRED         : ${payload.expiredDate || '-'}\n` +
    `PEMBAYARAN      : ${payload.payment || '-'}\n` +
    '```';

  try {
    await bot.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Gagal kirim notif create akun ke grup global:', err.message);
  }
}

async function sendGlobalRenewAccountNotification(payload) {
  const groupId = Number(String(GLOBAL_CREATE_NOTIF_GROUP_ID || '').trim());
  if (!Number.isFinite(groupId) || groupId === 0) return;

  const text =
    '*🔄AKUN BERHASIL DIRENEW !!*\n\n' +
    '```Informasi\n' +
    `ID TELE PEMBUAT : ${payload.creatorId || '-'}\n` +
    `USERNAME TELE   : ${payload.creatorUsername || '-'}\n` +
    `SERVER          : ${payload.serverName || '-'}\n` +
    `JENIS AKUN      : ${payload.accountType || '-'}\n` +
    `ROLE            : ${payload.role || '-'}\n` +
    `REMAKS          : ${payload.remarks || '-'}\n` +
    `TAMBAH AKTIF    : (+${payload.expDays || 0} Hari)\n` +
    `EXPIRED BARU    : ${payload.expiredDate || '-'}\n` +
    `PEMBAYARAN      : ${payload.payment || '-'}\n` +
    '```';

  try {
    await bot.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Gagal kirim notif renew akun ke grup global:', err.message);
  }
}

// =================== PERBAIKAN GROUP_ID ===================
let GROUP_ID_NUM = null;
let BW_NOTIF_GROUP_ID_NUM = null;

try {
  // Debug: log asli dari config
  logger.info(`🔍 GROUP_ID dari .vars.json: "${GROUP_ID}" (type: ${typeof GROUP_ID})`);
  
  // Konversi ke number dengan handle berbagai format
  if (GROUP_ID === undefined || GROUP_ID === null || GROUP_ID === "") {
    logger.error('❌ GROUP_ID tidak ditemukan di config!');
  } else {
    // Handle string atau number
    let groupIdStr = String(GROUP_ID).trim();
    
    // Jika ada tanda kutip di string, hapus
    groupIdStr = groupIdStr.replace(/['"]/g, '');
    
    // Konversi ke number
    const converted = Number(groupIdStr);
    
    if (!isNaN(converted)) {
      GROUP_ID_NUM = converted;
      logger.info(`✅ GROUP_ID valid: ${GROUP_ID_NUM}`);
      
      // Cek apakah ID negatif (semua grup Telegram punya ID negatif)
      if (GROUP_ID_NUM > 0) {
        logger.warn(`⚠️ GROUP_ID positif (${GROUP_ID_NUM}), biasanya grup Telegram ID-nya negatif`);
        logger.warn(`⚠️ Jika notifikasi gagal, coba ubah ke negatif di .vars.json`);
      }
    } else {
      logger.error(`❌ GROUP_ID tidak valid: "${GROUP_ID}" - harus berupa angka`);
    }
  }
} catch (e) {
  logger.error(`❌ Error processing GROUP_ID:`, e.message);
}

try {
  if (BW_NOTIF_GROUP_ID !== undefined && BW_NOTIF_GROUP_ID !== null && BW_NOTIF_GROUP_ID !== '') {
    const bwGroupStr = String(BW_NOTIF_GROUP_ID).trim().replace(/['"]/g, '');
    const convertedBw = Number(bwGroupStr);
    if (!Number.isNaN(convertedBw)) {
      BW_NOTIF_GROUP_ID_NUM = convertedBw;
      logger.info(`✅ BW_NOTIF_GROUP_ID valid: ${BW_NOTIF_GROUP_ID_NUM}`);
    } else {
      logger.warn(`⚠️ BW_NOTIF_GROUP_ID tidak valid: "${BW_NOTIF_GROUP_ID}"`);
    }
  }
} catch (e) {
  logger.warn(`⚠️ Error processing BW_NOTIF_GROUP_ID: ${e.message}`);
}

function normalizeAdminIdList(value) {
  const rawList = Array.isArray(value) ? value : [value];
  return rawList
    .flatMap((item) => String(item || '').split(','))
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN belum diisi di .vars.json.');
}

const BOT_HANDLER_TIMEOUT_MS = numberFromRuntimeSetting(
  vars.BOT_HANDLER_TIMEOUT_MS || process.env.BOT_HANDLER_TIMEOUT_MS,
  15 * 60 * 1000,
  90000,
  30 * 60 * 1000
);
const BROADCAST_CONCURRENCY = numberFromRuntimeSetting(
  vars.BROADCAST_CONCURRENCY || process.env.BROADCAST_CONCURRENCY,
  4,
  1,
  10
);
const BROADCAST_SEND_INTERVAL_MS = numberFromRuntimeSetting(
  vars.BROADCAST_SEND_INTERVAL_MS || process.env.BROADCAST_SEND_INTERVAL_MS,
  60,
  35,
  1000
);
const BROADCAST_RECIPIENT_TIMEOUT_MS = numberFromRuntimeSetting(
  vars.BROADCAST_RECIPIENT_TIMEOUT_MS || process.env.BROADCAST_RECIPIENT_TIMEOUT_MS,
  15000,
  3000,
  60000
);
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: BOT_HANDLER_TIMEOUT_MS });
let ADMIN_USERNAME = '';
const adminIds = normalizeAdminIdList(ADMIN);
logger.info('Bot initialized');

function buildMaintenanceNotice() {
  const setting = loadMaintenanceSetting();
  const estimateText = setting.estimate || 'belum ditentukan';
  return (
    '🚧 *Bot Sedang Maintenance*\n\n' +
    'Mohon maaf, layanan bot sementara tidak tersedia.\n' +
    `Estimasi selesai maintenance: *${estimateText}*.\n\n` +
    'Silakan coba lagi nanti.'
  );
}

bot.use(async (ctx, next) => {
  const userId = Number(ctx.from?.id || 0);
  const isAdminUser = adminIds.includes(userId);

  if (isAdminUser) return next();

  const maintenance = loadMaintenanceSetting();
  if (!maintenance.enabled) return next();

  const notice = buildMaintenanceNotice();
  if (ctx.updateType === 'callback_query') {
    try {
      await ctx.answerCbQuery('Bot sedang maintenance', { show_alert: true });
    } catch (_) {}
  }
  await ctx.reply(notice, { parse_mode: 'Markdown' });
  return;
});

function getScEventBearerToken(req) {
  const auth = String(req.headers?.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const fromScHeader = String(req.headers?.['x-sc-event-token'] || '').trim();
  const fromWebhookHeader = String(req.headers?.['x-webhook-token'] || '').trim();
  const fromBody = String(req.body?.token || req.body?.webhook_token || '').trim();
  const fromQuery = String(req.query?.token || req.query?.webhook_token || '').trim();
  return fromScHeader || fromWebhookHeader || fromBody || fromQuery || auth;
}

function normalizeTelegramTarget(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '0' || text.toLowerCase() === 'null') return '';
  return text;
}

function formatMultiLoginUserNotification(payload = {}) {
  const rawService = String(payload.service || payload.layanan || '-').toUpperCase();
  const service = rawService === 'SSH/ZIVPN' ? 'SSH/ZIVPN/UDPHC' : rawService;
  const username = String(payload.username || '-').trim() || '-';
  const limitIp = Number(payload.limitip || payload.limit_ip || 0);
  const detected = Number(payload.detected_effective || payload.detected || payload.connected_ip || 0);
  const detectedRaw = Number(payload.detected_raw || 0);
  const unlockMinutes = Number(payload.unlock_minutes || payload.unlock || 0);
  const ips = Array.isArray(payload.ips)
    ? payload.ips.map((ip) => String(ip || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const now = new Date();
  const unlockAt = unlockMinutes > 0
    ? new Date(now.getTime() + (unlockMinutes * 60 * 1000))
    : null;
  const unlockAtText = unlockAt
    ? unlockAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    : '-';
  const timeText = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const extraDetectedText =
    detectedRaw > 0 && detectedRaw !== detected
      ? `Info      : Terdeteksi raw ${detectedRaw} IP, dihitung ${detected} IP/device`
      : '';
  return [
    '⚠️ NOTIFIKASI MULTI LOGIN',
    '',
    `Layanan  : ${service}`,
    `Username : ${username}`,
    `Limit IP : ${limitIp}`,
    `Terdeteksi: ${detected}`,
    '',
    `Akun akan normal lagi di jam ${unlockAtText}`,
    `Waktu    : ${timeText}`,
    '',
    'Akun dikunci sementara karena login melebihi limit IP, Mohon untuk tidak gunakan akun ini secara bersama sama melebihi IP limit yang sudah di tentukan',
    '',
    '1IP = Gunakan 1HP/Device',
    '2IP = Gunakan 2HP/Device',
    '',
    'Jangan mode pesawat, jika zivpn bengong konek tapi ga ada internetnya cukup stop apk udpnya lalu start ulang.'
  ].filter((v) => v !== null && v !== undefined).join('\n');
}

async function isValidScEventToken(token) {
  const incoming = String(token || '').trim();
  if (!incoming) return false;
  if (BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN && incoming === BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN) return true;

  try {
    const row = await dbGetAsync(
      'SELECT id FROM Server WHERE auth = ? LIMIT 1',
      [incoming]
    );
    return !!row;
  } catch (err) {
    logger.warn(`Validasi token event SC gagal: ${err.message}`);
    return false;
  }
}

app.post('/sc1forcr/events/multi-login', async (req, res) => {
  try {
    const givenToken = getScEventBearerToken(req);
    if (!(await isValidScEventToken(givenToken))) {
      return res.status(401).json({ ok: false, message: 'unauthorized' });
    }

    const payload = req.body || {};
    const event = String(payload.event || '').trim().toUpperCase();
    if (event && event !== 'MULTI_LOGIN') {
      return res.status(400).json({ ok: false, message: 'unsupported event' });
    }

    const targetChatId = normalizeTelegramTarget(
      payload.owner_telegram_chat_id ||
      payload.telegram_chat_id ||
      payload.chat_id ||
      payload.owner_telegram_id ||
      payload.telegram_user_id
    );
    if (!targetChatId) {
      return res.status(202).json({ ok: false, skipped: true, message: 'owner telegram id is empty' });
    }

    const text = formatMultiLoginUserNotification(payload);
    await bot.telegram.sendMessage(targetChatId, text);
    logger.info(`✅ Multi-login notif dikirim ke user ${targetChatId} (${payload.service || '-'}:${payload.username || '-'})`);
    return res.json({ ok: true });
  } catch (err) {
    logger.error('❌ Gagal proses webhook multi-login:', err.message);
    return res.status(500).json({ ok: false, message: 'internal error' });
  }
});

async function notifyGroupAccountDeleted(payload) {
  if (!GROUP_ID_NUM) return;

  try {
    const actorName = payload.actorUsername ? '@' + String(payload.actorUsername).replace(/^@/, '') : '-';
    const deletedName = payload.deletedUsername ? '@' + String(payload.deletedUsername).replace(/^@/, '') : '-';
    const text =
      'NOTIFIKASI HAPUS AKUN\n\n' +
      'Aksi: ' + (payload.action || 'delete') + '\n' +
      'Pelaku ID: ' + String(payload.actorId || '-') + '\n' +
      'Pelaku Username: ' + actorName + '\n' +
      'Target User ID: ' + String(payload.targetUserId || '-') + '\n' +
      'Username Akun: ' + String(payload.accountUsername || '-') + '\n' +
      'Layanan: ' + String(payload.service || '-') + '\n' +
      'Server: ' + String(payload.serverName || '-') + '\n' +
      'Refund Saldo: Rp ' + Number(payload.refund || 0).toLocaleString('id-ID') + '\n' +
      'Sisa Hari: ' + Number(payload.remainingDays || 0) + ' hari\n' +
      'Waktu: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + '\n' +
      'Keterangan: ' + String(payload.note || '-');

    await bot.telegram.sendMessage(GROUP_ID_NUM, text);
  } catch (err) {
    logger.warn('Gagal kirim notif hapus akun ke grup: ' + err.message);
  }
}


(async () => {
  try {
    const adminId = Array.isArray(adminIds) ? adminIds[0] : adminIds;
    const chat = await bot.telegram.getChat(adminId);
    ADMIN_USERNAME = chat.username ? `@${chat.username}` : 'Admin';
    logger.info(`Admin username detected: ${ADMIN_USERNAME}`);
  } catch (e) {
    ADMIN_USERNAME = 'Admin';
    logger.warn('Tidak bisa ambil username admin otomatis.');
  }
})();
/////
const dbPath = runtimePath('sellvpn.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Kesalahan koneksi SQLite3:', err.message);
  } else {
    logger.info('Terhubung ke SQLite3');
  }
});

db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
  unique_code TEXT PRIMARY KEY,
  user_id INTEGER,
  amount INTEGER,
  original_amount INTEGER,
  timestamp INTEGER,
  status TEXT,
  qr_message_id INTEGER,
  gateway_provider TEXT DEFAULT 'orderkuota',
  provider_tx_id TEXT,
  reference_id TEXT,
  admin_fee INTEGER DEFAULT 0,
  topup_purpose TEXT DEFAULT 'regular',
  wallet_type TEXT DEFAULT 'vpn',
  expires_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel pending_deposits:', err.message);
  }
});

const pendingDepositMigrations = [
  "ALTER TABLE pending_deposits ADD COLUMN gateway_provider TEXT DEFAULT 'orderkuota'",
  "ALTER TABLE pending_deposits ADD COLUMN provider_tx_id TEXT",
  "ALTER TABLE pending_deposits ADD COLUMN reference_id TEXT",
  "ALTER TABLE pending_deposits ADD COLUMN admin_fee INTEGER DEFAULT 0",
  "ALTER TABLE pending_deposits ADD COLUMN topup_purpose TEXT DEFAULT 'regular'",
  "ALTER TABLE pending_deposits ADD COLUMN wallet_type TEXT DEFAULT 'vpn'",
  "ALTER TABLE pending_deposits ADD COLUMN expires_at INTEGER"
];
pendingDepositMigrations.forEach((sql) => {
  db.run(sql, (err) => {
    if (err && !String(err.message || '').toLowerCase().includes('duplicate column')) {
      logger.warn('Migrasi pending_deposits gagal: ' + err.message);
    }
  });
});

db.run(`CREATE TABLE IF NOT EXISTS dana_bridge_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payer_source TEXT,
  notification_key TEXT,
  posted_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  title TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  matched_unique_code TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS dana_bridge_requests (
  nonce TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS Server (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT,
  auth TEXT,
  harga INTEGER,
  harga_reseller INTEGER,
  harga_1ip INTEGER DEFAULT 0,
  harga_2ip INTEGER DEFAULT 0,
  harga_reseller_1ip INTEGER DEFAULT 0,
  harga_reseller_2ip INTEGER DEFAULT 0,
  harga_1ip_30hari INTEGER DEFAULT 0,
  harga_2ip_30hari INTEGER DEFAULT 0,
  harga_reseller_1ip_30hari INTEGER DEFAULT 0,
  harga_reseller_2ip_30hari INTEGER DEFAULT 0,
  harga_mode_harian_enabled INTEGER DEFAULT 1,
  harga_mode_30hari_enabled INTEGER DEFAULT 0,
  nama_server TEXT,
  quota INTEGER,
  iplimit INTEGER,
  batas_create_akun INTEGER,
  total_create_akun INTEGER,
  is_reseller_only INTEGER DEFAULT 0,
  support_ssh INTEGER DEFAULT 1,
  support_vmess INTEGER DEFAULT 1,
  support_vless INTEGER DEFAULT 1,
  support_trojan INTEGER DEFAULT 1,
  support_shadowsocks INTEGER DEFAULT 1,
  support_zivpn INTEGER DEFAULT 0,
  support_udp_http INTEGER DEFAULT 0,
  service TEXT DEFAULT 'ssh',
  sync_host TEXT,
  sync_port INTEGER DEFAULT 8789,
  sync_endpoint TEXT DEFAULT '/internal/account-summary',
  sync_enabled INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  bandwidth_limit_tb REAL DEFAULT 0,
  bandwidth_user_daily_gb REAL DEFAULT 8,
  bandwidth_daily_gb REAL DEFAULT 0,
  bandwidth_monthly_used_tb REAL DEFAULT 0,
  bandwidth_remaining_tb REAL DEFAULT 0,
  bandwidth_estimated_capacity INTEGER DEFAULT 0,
  bandwidth_last_sync_at INTEGER DEFAULT 0,
  bandwidth_alert_last_notified_at INTEGER DEFAULT 0
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel Server:', err.message);
  } else {
    logger.info('Server table created or already exists');
  }
});

db.run(`CREATE TABLE IF NOT EXISTS server_iplimit_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  ip_package INTEGER NOT NULL,
  iplimit INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0,
  UNIQUE(server_id, protocol, ip_package)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel server_iplimit_rules:', err.message);
  }
});

db.run("UPDATE Server SET total_create_akun = 0 WHERE total_create_akun IS NULL", function(err) {
  if (err) {
    logger.error('Error fixing NULL total_create_akun:', err.message);
  } else {
    if (this.changes > 0) {
      logger.info(`✅ Fixed ${this.changes} servers with NULL total_create_akun`);
    }
  }
});

db.all("PRAGMA table_info(Server)", (err, rows) => {
  if (err) {
    logger.error('Error checking Server schema:', err.message);
    return;
  }

  const cols = rows.map(r => r.name);

  db.serialize(() => {
    if (!cols.includes('support_ssh')) {
      db.run("ALTER TABLE Server ADD COLUMN support_ssh INTEGER DEFAULT 1");
    }
    if (!cols.includes('support_vmess')) {
      db.run("ALTER TABLE Server ADD COLUMN support_vmess INTEGER DEFAULT 1");
    }
    if (!cols.includes('support_vless')) {
      db.run("ALTER TABLE Server ADD COLUMN support_vless INTEGER DEFAULT 1");
    }
    if (!cols.includes('support_trojan')) {
      db.run("ALTER TABLE Server ADD COLUMN support_trojan INTEGER DEFAULT 1");
    }
    if (!cols.includes('support_shadowsocks')) {
      db.run("ALTER TABLE Server ADD COLUMN support_shadowsocks INTEGER DEFAULT 1");
    }
    if (!cols.includes('support_zivpn')) {
      db.run("ALTER TABLE Server ADD COLUMN support_zivpn INTEGER DEFAULT 0");
    }
    if (!cols.includes('support_udp_http')) {
      db.run("ALTER TABLE Server ADD COLUMN support_udp_http INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller INTEGER");
    }
    if (!cols.includes('harga_1ip')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_1ip INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_2ip')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_2ip INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller_1ip')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller_1ip INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller_2ip')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller_2ip INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_1ip_30hari')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_1ip_30hari INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_2ip_30hari')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_2ip_30hari INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller_1ip_30hari')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller_1ip_30hari INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller_2ip_30hari')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller_2ip_30hari INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_mode_harian_enabled')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_mode_harian_enabled INTEGER DEFAULT 1");
    }
    if (!cols.includes('harga_mode_30hari_enabled')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_mode_30hari_enabled INTEGER DEFAULT 0");
    }
    if (!cols.includes('sync_host')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_host TEXT");
    }
    if (!cols.includes('sync_port')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_port INTEGER DEFAULT 8789");
    }
    if (!cols.includes('sync_endpoint')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_endpoint TEXT DEFAULT '/internal/account-summary'");
    }
    if (!cols.includes('sync_enabled')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_enabled INTEGER DEFAULT 1");
    }
    if (!cols.includes('is_active')) {
      db.run("ALTER TABLE Server ADD COLUMN is_active INTEGER DEFAULT 1");
    }
    if (!cols.includes('bandwidth_limit_tb')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_limit_tb REAL DEFAULT 0");
    }
    if (!cols.includes('bandwidth_user_daily_gb')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_user_daily_gb REAL DEFAULT 8");
    }
    if (!cols.includes('bandwidth_daily_gb')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_daily_gb REAL DEFAULT 0");
    }
    if (!cols.includes('bandwidth_monthly_used_tb')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_monthly_used_tb REAL DEFAULT 0");
    }
    if (!cols.includes('bandwidth_remaining_tb')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_remaining_tb REAL DEFAULT 0");
    }
    if (!cols.includes('bandwidth_estimated_capacity')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_estimated_capacity INTEGER DEFAULT 0");
    }
    if (!cols.includes('bandwidth_last_sync_at')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_last_sync_at INTEGER DEFAULT 0");
    }
    if (!cols.includes('bandwidth_alert_last_notified_at')) {
      db.run("ALTER TABLE Server ADD COLUMN bandwidth_alert_last_notified_at INTEGER DEFAULT 0");
    }

    // Jalankan normalisasi setelah migrasi kolom ter-queue
    db.run("UPDATE Server SET support_ssh = 1 WHERE support_ssh IS NULL");
    db.run("UPDATE Server SET support_vmess = 1 WHERE support_vmess IS NULL");
    db.run("UPDATE Server SET support_vless = 1 WHERE support_vless IS NULL");
    db.run("UPDATE Server SET support_trojan = 1 WHERE support_trojan IS NULL");
    db.run("UPDATE Server SET support_shadowsocks = 1 WHERE support_shadowsocks IS NULL");
    db.run("UPDATE Server SET support_zivpn = 0 WHERE support_zivpn IS NULL");
    db.run("UPDATE Server SET support_udp_http = 0 WHERE support_udp_http IS NULL");
    db.run("UPDATE Server SET support_zivpn = 1 WHERE service = 'zivpn' AND support_zivpn = 0");
    db.run("UPDATE Server SET harga_1ip = COALESCE(NULLIF(harga_1ip, 0), harga, 0)");
    db.run("UPDATE Server SET harga_2ip = COALESCE(NULLIF(harga_2ip, 0), harga, 0)");
    db.run("UPDATE Server SET harga_reseller_1ip = COALESCE(NULLIF(harga_reseller_1ip, 0), harga_reseller, harga_1ip, harga, 0)");
    db.run("UPDATE Server SET harga_reseller_2ip = COALESCE(NULLIF(harga_reseller_2ip, 0), harga_reseller, harga_2ip, harga, 0)");
    db.run("UPDATE Server SET harga_1ip_30hari = COALESCE(NULLIF(harga_1ip_30hari, 0), COALESCE(harga_1ip, harga, 0) * 30)");
    db.run("UPDATE Server SET harga_2ip_30hari = COALESCE(NULLIF(harga_2ip_30hari, 0), COALESCE(harga_2ip, harga, 0) * 30)");
    db.run("UPDATE Server SET harga_reseller_1ip_30hari = COALESCE(NULLIF(harga_reseller_1ip_30hari, 0), COALESCE(harga_reseller_1ip, harga_reseller, harga_1ip, harga, 0) * 30)");
    db.run("UPDATE Server SET harga_reseller_2ip_30hari = COALESCE(NULLIF(harga_reseller_2ip_30hari, 0), COALESCE(harga_reseller_2ip, harga_reseller, harga_2ip, harga, 0) * 30)");
    db.run("UPDATE Server SET harga_mode_harian_enabled = 1 WHERE harga_mode_harian_enabled IS NULL");
    db.run("UPDATE Server SET harga_mode_30hari_enabled = 0 WHERE harga_mode_30hari_enabled IS NULL");
    db.run("UPDATE Server SET sync_port = 8789 WHERE sync_port IS NULL OR sync_port = 0");
    db.run("UPDATE Server SET sync_endpoint = '/internal/account-summary' WHERE sync_endpoint IS NULL OR TRIM(sync_endpoint) = ''");
    db.run("UPDATE Server SET sync_enabled = 1 WHERE sync_enabled IS NULL");
    db.run("UPDATE Server SET is_active = 1 WHERE is_active IS NULL");
    db.run("UPDATE Server SET bandwidth_limit_tb = 0 WHERE bandwidth_limit_tb IS NULL");
    db.run("UPDATE Server SET bandwidth_user_daily_gb = 8 WHERE bandwidth_user_daily_gb IS NULL OR bandwidth_user_daily_gb <= 0");
    db.run("UPDATE Server SET bandwidth_daily_gb = 0 WHERE bandwidth_daily_gb IS NULL");
    db.run("UPDATE Server SET bandwidth_monthly_used_tb = 0 WHERE bandwidth_monthly_used_tb IS NULL");
    db.run("UPDATE Server SET bandwidth_remaining_tb = 0 WHERE bandwidth_remaining_tb IS NULL");
    db.run("UPDATE Server SET bandwidth_estimated_capacity = 0 WHERE bandwidth_estimated_capacity IS NULL");
    db.run("UPDATE Server SET bandwidth_last_sync_at = 0 WHERE bandwidth_last_sync_at IS NULL");
    db.run("UPDATE Server SET bandwidth_alert_last_notified_at = 0 WHERE bandwidth_alert_last_notified_at IS NULL");
  });
});
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  saldo INTEGER DEFAULT 0,
  saldo_ppob INTEGER DEFAULT 0,
  CONSTRAINT unique_user_id UNIQUE (user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel users:', err.message);
  } else {
    logger.info('Users table created or already exists');
  }
});

db.run('ALTER TABLE users ADD COLUMN saldo_ppob INTEGER DEFAULT 0', (err) => {
  if (err && !String(err.message || '').toLowerCase().includes('duplicate column')) {
    logger.warn('Migrasi users saldo_ppob gagal: ' + err.message);
  }
});
db.run('UPDATE users SET saldo_ppob = 0 WHERE saldo_ppob IS NULL', (err) => {
  if (err && !String(err.message || '').toLowerCase().includes('no such column')) {
    logger.warn('Normalisasi saldo_ppob gagal: ' + err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  type TEXT,
  reference_id TEXT,
  timestamp INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel transactions:', err.message);
  } else {
    logger.info('Transactions table created or already exists');
    
    // Add reference_id column if it doesn't exist
    db.get("PRAGMA table_info(transactions)", (err, rows) => {
      if (err) {
        logger.error('Kesalahan memeriksa struktur tabel:', err.message);
        return;
      }
      
      db.get("SELECT * FROM transactions WHERE reference_id IS NULL LIMIT 1", (err, row) => {
        if (err && err.message.includes('no such column')) {
          // Column doesn't exist, add it
          db.run("ALTER TABLE transactions ADD COLUMN reference_id TEXT", (err) => {
            if (err) {
              logger.error('Kesalahan menambahkan kolom reference_id:', err.message);
            } else {
              logger.info('Kolom reference_id berhasil ditambahkan ke tabel transactions');
            }
          });
        } else if (row) {
          // Update existing transactions with reference_id
          db.all("SELECT id, user_id, type, timestamp FROM transactions WHERE reference_id IS NULL", [], (err, rows) => {
            if (err) {
              logger.error('Kesalahan mengambil transaksi tanpa reference_id:', err.message);
              return;
            }
            
            rows.forEach(row => {
              const referenceId = `account-${row.type}-${row.user_id}-${row.timestamp}`;
              db.run("UPDATE transactions SET reference_id = ? WHERE id = ?", [referenceId, row.id], (err) => {
                if (err) {
                  logger.error(`Kesalahan mengupdate reference_id untuk transaksi ${row.id}:`, err.message);
                } else {
                  logger.info(`Berhasil mengupdate reference_id untuk transaksi ${row.id}`);
                }
              });
            });
          });
        }
      });
    });
  }
});

db.run(`CREATE TABLE IF NOT EXISTS ppob_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ref_id TEXT UNIQUE NOT NULL,
  buyer_sku_code TEXT NOT NULL,
  product_name TEXT,
  category TEXT,
  brand TEXT,
  product_type TEXT,
  customer_no TEXT NOT NULL,
  amount INTEGER NOT NULL,
  base_price INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  message TEXT,
  serial_number TEXT,
  raw_response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel ppob_orders:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS ppob_products (
  buyer_sku_code TEXT PRIMARY KEY,
  product_name TEXT,
  category TEXT,
  brand TEXT,
  product_type TEXT,
  buyer_price INTEGER DEFAULT 0,
  stock INTEGER,
  is_active INTEGER DEFAULT 1,
  raw_json TEXT,
  synced_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel ppob_products:', err.message);
  }
});

db.run('CREATE INDEX IF NOT EXISTS idx_ppob_products_active_category ON ppob_products (is_active, category, brand, product_type)', (err) => {
  if (err) logger.warn('Gagal membuat index ppob_products:', err.message);
});

db.run(`CREATE TABLE IF NOT EXISTS broadcast_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER,
  is_active INTEGER DEFAULT 1
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel broadcast_polls:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS broadcast_poll_votes (
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL,
  voted_at INTEGER,
  PRIMARY KEY (poll_id, user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel broadcast_poll_votes:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS broadcast_delivery_status (
  user_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat broadcast_delivery_status:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS download_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_size INTEGER DEFAULT 0,
  uploaded_by INTEGER,
  created_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel download_configs:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS hc_config_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_file_name TEXT,
  template_text TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  uploaded_by INTEGER,
  created_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel hc_config_templates:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS dark_config_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_file_name TEXT,
  template_text TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  uploaded_by INTEGER,
  created_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel dark_config_templates:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS tutorial_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER,
  updated_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel tutorial_items:', err.message);
  }
});

const userState = {};
const lastMenuMessageId = new Map();
const allResellerStatsSessions = new Map();
const hcTemplateUploadBatches = new Map();
const darkTemplateUploadBatches = new Map();
const HC_TEMPLATE_UPLOAD_MAX_FILES = 10;
const HC_TEMPLATE_UPLOAD_BATCH_DELAY_MS = 4000;
const DARK_TEMPLATE_UPLOAD_MAX_FILES = 10;
const DARK_TEMPLATE_UPLOAD_BATCH_DELAY_MS = 4000;
const BULK_CONFIG_SEND_DELAY_MS = 350;
const ORDERKUOTA_CHECK_REPLY_TEXT = '✅ Sudah Bayar, Cek Status';
logger.info('User state initialized');

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(err) {
    if (err) return reject(err);
    resolve(this);
  });
});

const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
});

function normalizeTutorialTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeTutorialContent(raw) {
  return String(raw || '').trim().slice(0, 3500);
}

function normalizeTutorialLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^@[a-zA-Z0-9_]{5,32}$/.test(text)) return `https://t.me/${text.slice(1)}`;
  const candidate = /^t\.me\//i.test(text) ? `https://${text}` : text;
  if (!/^https?:\/\//i.test(candidate)) return '';
  try {
    const url = new URL(candidate);
    return /^https?:$/i.test(url.protocol) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function isTutorialLink(raw) {
  return Boolean(normalizeTutorialLink(raw));
}

async function getTutorialRows(includeDisabled = false) {
  return dbAllAsync(
    `SELECT id, title, content, enabled, created_by, created_at, updated_at
     FROM tutorial_items
     ${includeDisabled ? '' : 'WHERE enabled = 1'}
     ORDER BY title COLLATE NOCASE ASC, id ASC`
  );
}

function buildTutorialRowsKeyboard(rows, backCallback = 'send_main_menu') {
  const keyboard = [];
  for (const row of rows) {
    const title = String(row.title || `Tutorial ${row.id}`).slice(0, 55);
    const link = normalizeTutorialLink(row.content);
    keyboard.push([
      link
        ? { text: title, url: link }
        : { text: title, callback_data: `tutorial_view_${row.id}` }
    ]);
  }
  keyboard.push([{ text: '🔙 Kembali', callback_data: backCallback }]);
  return keyboard;
}

async function sendTutorialMenu(ctx) {
  const rows = await getTutorialRows(false).catch((err) => {
    logger.error('Gagal mengambil daftar tutorial:', err.message);
    return [];
  });

  const message = rows.length
    ? '<b>📘 TUTORIAL</b>\n\nPilih tutorial yang ingin dibuka.'
    : '<b>📘 TUTORIAL</b>\n\nBelum ada tutorial yang tersedia.';
  const options = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildTutorialRowsKeyboard(rows) }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(message, options).catch(() => ctx.reply(message, options));
  }
  return ctx.reply(message, options);
}

async function sendAdminTutorialMenu(ctx) {
  const rows = await getTutorialRows(true).catch((err) => {
    logger.error('Gagal mengambil daftar tutorial admin:', err.message);
    return [];
  });

  const lines = rows.length
    ? rows.map((row, index) => {
        const status = Number(row.enabled || 0) === 1 ? 'Aktif' : 'Nonaktif';
        const type = isTutorialLink(row.content) ? 'Link' : 'Teks';
        return `${index + 1}. ${escapeHtml(row.title || `Tutorial ${row.id}`)} (${status}, ${type})`;
      }).join('\n')
    : 'Belum ada tutorial.';

  const keyboard = [
    [{ text: '➕ Tambah Tutorial', callback_data: 'admin_tutorial_add' }]
  ];

  rows.slice(0, 20).forEach((row, index) => {
    const statusText = Number(row.enabled || 0) === 1 ? 'Nonaktifkan' : 'Aktifkan';
    keyboard.push([
      { text: `${index + 1}. Detail`, callback_data: `admin_tutorial_preview_${row.id}` },
      { text: statusText, callback_data: `admin_tutorial_toggle_${row.id}` },
      { text: 'Hapus', callback_data: `admin_tutorial_delete_${row.id}` }
    ]);
  });
  keyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_menu_tools' }]);

  const message =
    '<b>📘 KELOLA TUTORIAL</b>\n\n' +
    '<code>' + lines + '</code>\n\n' +
    'Tambah tutorial dengan format:\n' +
    '<code>Nama Tutorial | isi tutorial atau link</code>';

  const options = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(message, options).catch(() => ctx.reply(message, options));
  }
  return ctx.reply(message, options);
}

const SERVER_PROTOCOL_SUPPORT = {
  ssh: { column: 'support_ssh', label: 'SSH', defaultEnabled: 1 },
  vmess: { column: 'support_vmess', label: 'VMess', defaultEnabled: 1 },
  vless: { column: 'support_vless', label: 'VLess', defaultEnabled: 1 },
  trojan: { column: 'support_trojan', label: 'Trojan', defaultEnabled: 1 },
  shadowsocks: { column: 'support_shadowsocks', label: 'Shadowsocks', defaultEnabled: 1 },
  zivpn: { column: 'support_zivpn', label: 'ZIVPN', defaultEnabled: 0 },
  udp_http: { column: 'support_udp_http', label: 'UDP HTTP', defaultEnabled: 0 }
};

const SERVER_PROTOCOL_KEYS = Object.keys(SERVER_PROTOCOL_SUPPORT);

function getServerProtocolSupport(type) {
  return SERVER_PROTOCOL_SUPPORT[String(type || '').toLowerCase()] || null;
}

function isServerProtocolEnabled(server, type) {
  const protocol = getServerProtocolSupport(type);
  if (!protocol) return true;
  return Number(server?.[protocol.column] ?? protocol.defaultEnabled) === 1;
}

function formatServerProtocolStatusLine(server) {
  return SERVER_PROTOCOL_KEYS
    .map((key) => {
      const protocol = SERVER_PROTOCOL_SUPPORT[key];
      const enabled = Number(server?.[protocol.column] ?? protocol.defaultEnabled) === 1;
      return `${protocol.label}:${enabled ? 'ON' : 'OFF'}`;
    })
    .join(' | ');
}

function sanitizeDownloadConfigName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

function sanitizeHcTemplateName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

function slugifyHcTemplateName(raw) {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32);
  return slug || 'hc';
}

function sanitizeHcFilePart(raw, fallback = 'config') {
  const safe = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '')
    .slice(0, 48);
  return safe || fallback;
}

function inspectHcTemplateText(templateText) {
  const text = String(templateText || '').trim();
  if (!text || text.length < 16) {
    throw new Error('Template HC kosong atau terlalu pendek.');
  }
  return {
    lockAll: 'via API',
    lockPayload: 'via API',
    expiryTime: 'via API',
    sni: '',
    sshField: '',
    xrayConfig: '',
    formatLabel: '.hc via API'
  };
}

function parseHcSshAccountInput(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Format akun kosong.');
  }

  const keyed = {};
  text.split(/\r?\n/).forEach((line) => {
    const match = String(line || '').match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/);
    if (!match) return;
    const key = match[1].toLowerCase().replace(/[^a-z0-9]+/g, '');
    keyed[key] = match[2].trim();
  });

  const keyedHost = keyed.host || keyed.sshhost || keyed.server || keyed.domain || keyed.hostname || '';
  const keyedPort = keyed.port || keyed.sshport || keyed.portssh || '';
  const keyedUser = keyed.username || keyed.user || keyed.sshuser || keyed.akun || keyed.login || '';
  const keyedPass = keyed.password || keyed.pass || keyed.sshpass || keyed.pw || '';
  if (keyedHost && keyedPort && keyedUser && keyedPass) {
    return normalizeHcSshAccount(keyedHost, keyedPort, keyedUser, keyedPass);
  }

  if (/^ssh:\/\//i.test(text)) {
    const url = new URL(text);
    return normalizeHcSshAccount(
      url.hostname,
      url.port || '22',
      decodeURIComponent(url.username || ''),
      decodeURIComponent(url.password || '')
    );
  }

  const compact = text.replace(/\s+/g, '');
  const atIndex = compact.indexOf('@');
  if (atIndex !== -1) {
    const left = compact.slice(0, atIndex);
    const right = compact.slice(atIndex + 1);
    const leftParts = left.split(':');
    const rightParts = right.split(':');

    if (leftParts.length >= 2 && /^\d{1,5}$/.test(leftParts[leftParts.length - 1])) {
      const port = leftParts.pop();
      const host = leftParts.join(':');
      const user = rightParts.shift();
      const pass = rightParts.join(':');
      return normalizeHcSshAccount(host, port, user, pass);
    }

    if (rightParts.length >= 2 && /^\d{1,5}$/.test(rightParts[rightParts.length - 1])) {
      const port = rightParts.pop();
      const host = rightParts.join(':');
      const user = leftParts.shift();
      const pass = leftParts.join(':');
      return normalizeHcSshAccount(host, port, user, pass);
    }
  }

  const colonParts = compact.split(':');
  if (colonParts.length >= 4 && /^\d{1,5}$/.test(colonParts[1])) {
    const [host, port, username, ...passParts] = colonParts;
    return normalizeHcSshAccount(host, port, username, passParts.join(':'));
  }

  throw new Error(
    'Format akun tidak dikenali. Pakai host:port@username:password atau kirim baris Host, Port, Username, Password.'
  );
}

function normalizeHcSshAccount(host, port, username, password) {
  const cleanHost = String(host || '').trim();
  const cleanPort = Number(port);
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '').trim();

  if (!cleanHost || !Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535 || !cleanUser || !cleanPass) {
    throw new Error('Data akun tidak lengkap. Pastikan host, port, username, dan password terisi.');
  }

  return {
    host: cleanHost,
    port: cleanPort,
    username: cleanUser,
    password: cleanPass,
    sshField: `${cleanHost}:${cleanPort}@${cleanUser}:${cleanPass}`
  };
}

function normalizeHcMethod(method) {
  return String(method || '').toLowerCase() === 'xray' ? 'xray' : 'ssh';
}

function getHcMethodLabel(method) {
  return normalizeHcMethod(method) === 'xray' ? 'Xray' : 'SSH';
}

function parseHcXrayConfigInput(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Config Xray kosong.');
  }

  if (text.startsWith('{')) {
    const parsedJson = JSON.parse(text);
    return {
      method: 'xray',
      protocol: 'json',
      username: 'xray',
      xrayConfig: JSON.stringify(parsedJson)
    };
  }

  const keyed = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  lines.forEach((line) => {
    const match = line.match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/);
    if (!match) return;
    const key = match[1].toLowerCase().replace(/[^a-z0-9]+/g, '');
    keyed[key] = match[2].trim();
  });

  const link = lines.find((line) => /^(vmess|vless|trojan):\/\//i.test(line)) || text;
  let parsed;
  let compactInput = false;
  if (/^vmess:\/\//i.test(link)) {
    parsed = parseVmessLink(link);
  } else if (/^vless:\/\//i.test(link)) {
    parsed = parseVlessLink(link);
  } else if (/^trojan:\/\//i.test(link)) {
    parsed = parseTrojanLink(link);
  } else {
    const compactLine = lines.find((line) => !/^(?:bug|hostbug|customhost|addr|address|protocol|type|method|host|server|domain|port|uuid|id|password|pass|token)\s*[:=]/i.test(line));
    parsed = parseHcCompactXrayInput(compactLine || text, keyed);
    compactInput = true;
  }

  const explicitBug = keyed.bug || keyed.hostbug || keyed.customhost || keyed.addr ||
    (!compactInput ? (keyed.address || keyed.host) : '') || '';
  const xrayJson = buildHcJson(parsed, explicitBug || parsed.address);
  return {
    method: 'xray',
    protocol: parsed.protocol || 'xray',
    username: parsed.protocol || 'xray',
    xrayConfig: JSON.stringify(xrayJson),
    preserveXrayEndpoint: Boolean(explicitBug),
    compactXrayInput: compactInput
  };
}

async function getDownloadConfigRows() {
  return dbAllAsync(
    `SELECT id, name, file_id, file_name, file_size, uploaded_by, created_at
     FROM download_configs
     ORDER BY id DESC`
  );
}

async function getHcTemplateRows(includeDisabled = false) {
  return dbAllAsync(
    `SELECT id, name, slug, source_file_name, enabled, uploaded_by, created_at
     FROM hc_config_templates
     ${includeDisabled ? '' : 'WHERE enabled = 1'}
     ORDER BY name COLLATE NOCASE ASC, id ASC`
  );
}

function getHcTemplateNameFromFileName(fileName, fallbackIndex = 1) {
  const baseName = String(fileName || '')
    .replace(/\.(hc|txt)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sanitized = sanitizeHcTemplateName(baseName);
  return sanitized.length >= 2 ? sanitized : `Template HC ${fallbackIndex}`;
}

async function readHcTemplateDocument(ctx, doc) {
  const fileSize = Number(doc.file_size || 0);
  if (fileSize > 2 * 1024 * 1024) {
    throw new Error('file terlalu besar, maksimal 2 MB');
  }

  const fileLink = await ctx.telegram.getFileLink(doc.file_id);
  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  const templateText = Buffer.from(response.data).toString('utf8');
  const info = inspectHcTemplateText(templateText);

  return { storedTemplateText: templateText, formatLabel: info.formatLabel };
}

async function saveHcTemplateDocument(ctx, doc, fallbackIndex = 1) {
  const templateName = getHcTemplateNameFromFileName(doc.file_name, fallbackIndex);
  const parsed = await readHcTemplateDocument(ctx, doc);

  await dbRunAsync(
    `INSERT INTO hc_config_templates
     (name, slug, source_file_name, template_text, enabled, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [
      templateName,
      slugifyHcTemplateName(templateName),
      String(doc.file_name || 'template-hc.txt'),
      parsed.storedTemplateText,
      ctx.from.id,
      Date.now()
    ]
  );

  return {
    name: templateName,
    fileName: String(doc.file_name || 'template-hc.txt'),
    formatLabel: parsed.formatLabel
  };
}

async function processHcTemplateUploadDocuments(ctx, docs) {
  const selectedDocs = docs.slice(0, HC_TEMPLATE_UPLOAD_MAX_FILES);
  const ignoredCount = Math.max(0, docs.length - selectedDocs.length);
  const saved = [];
  const failed = [];

  if (selectedDocs.length === 1 && ignoredCount === 0) {
    const doc = selectedDocs[0];
    try {
      const parsed = await readHcTemplateDocument(ctx, doc);
      const suggestedTemplateName = getHcTemplateNameFromFileName(doc.file_name, 1);
      userState[ctx.chat.id] = {
        step: 'admin_hc_template_name_input',
        templateText: parsed.storedTemplateText,
        sourceFileName: String(doc.file_name || 'template-hc.txt'),
        suggestedTemplateName,
        formatLabel: parsed.formatLabel
      };

      return ctx.reply(
        'Template HC diterima.\n' +
        `Format: ${parsed.formatLabel}\n` +
        `Nama dari file: ${suggestedTemplateName}\n\n` +
        'Kirim nama template yang akan tampil di menu user.\n' +
        'Ketik "-" untuk memakai nama dari file.\n' +
        'Ketik "batal" untuk membatalkan.'
      );
    } catch (err) {
      logger.error('Gagal membaca template HC:', err.message);
      return ctx.reply(
        'Template tidak valid. Kirim file .hc asli dari HTTP Custom.'
      );
    }
  }

  for (let i = 0; i < selectedDocs.length; i += 1) {
    const doc = selectedDocs[i];
    try {
      saved.push(await saveHcTemplateDocument(ctx, doc, i + 1));
    } catch (err) {
      failed.push({
        fileName: String(doc.file_name || `file-${i + 1}`),
        reason: err.message || 'template tidak valid'
      });
    }
  }

  delete userState[ctx.from.id];
  delete userState[ctx.chat.id];

  const lines = [];
  if (saved.length) {
    lines.push('<b>Template HC berhasil disimpan</b>');
    saved.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${escapeHtml(item.name)} - ${escapeHtml(item.formatLabel)}`);
    });
  }

  if (failed.length) {
    if (lines.length) lines.push('');
    lines.push('<b>Gagal disimpan</b>');
    failed.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${escapeHtml(item.fileName)} - ${escapeHtml(item.reason)}`);
    });
  }

  if (ignoredCount > 0) {
    if (lines.length) lines.push('');
    lines.push(`${ignoredCount} file diabaikan karena maksimal upload sekaligus ${HC_TEMPLATE_UPLOAD_MAX_FILES} file.`);
  }

  if (!lines.length) {
    lines.push('Tidak ada template HC yang berhasil diproses.');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  return sendAdminHcTemplateMenu(ctx);
}

function scheduleHcTemplateUploadBatch(ctx, doc) {
  const mediaGroupId = String(ctx.message.media_group_id || '');
  const batchKey = mediaGroupId
    ? `${ctx.chat.id}:media:${mediaGroupId}`
    : `${ctx.chat.id}:hc-template-docs`;
  const current = hcTemplateUploadBatches.get(batchKey) || { ctx, docs: [], timer: null };
  current.ctx = ctx;
  current.docs.push(doc);
  if (current.timer) clearTimeout(current.timer);

  current.timer = setTimeout(() => {
    const batch = hcTemplateUploadBatches.get(batchKey);
    hcTemplateUploadBatches.delete(batchKey);
    if (!batch) return;
    const state = userState[ctx.from.id] || userState[ctx.chat.id];
    if (!state || state.step !== 'admin_hc_template_upload_document') return;
    processHcTemplateUploadDocuments(batch.ctx, batch.docs).catch((err) => {
      logger.error('Gagal memproses batch template HC:', err.message);
      batch.ctx.reply('Gagal memproses upload template HC. Silakan coba lagi.').catch(() => {});
    });
  }, HC_TEMPLATE_UPLOAD_BATCH_DELAY_MS);

  hcTemplateUploadBatches.set(batchKey, current);
  return true;
}

function normalizeDarkMethod(method) {
  const value = String(method || '').toLowerCase();
  if (value === 'vmess' || value === 'v2ray' || value === 'xray') return 'vmess';
  if (value === 'vless') return 'vless';
  if (value === 'trojan') return 'trojan';
  return 'ssh';
}

function getDarkMethodLabel(method) {
  const value = normalizeDarkMethod(method);
  if (value === 'vmess') return 'VMess';
  if (value === 'vless') return 'VLESS';
  if (value === 'trojan') return 'Trojan';
  return 'SSH';
}

function isDarkTemplateCompatibleWithMethod(templateType, method) {
  const type = String(templateType || '').toUpperCase();
  if (!type || type === 'REMOTE' || type === 'API') return true;
  const normalizedMethod = normalizeDarkMethod(method);
  const expectedType = normalizedMethod === 'ssh' ? 'SSH' : normalizedMethod.toUpperCase();
  return type === expectedType || (expectedType !== 'SSH' && type === 'SSH');
}

function inspectDarkTemplateText(templateText) {
  const text = extractDarkTunnelLinkFromText(templateText) || String(templateText || '').trim();
  if (!/^darktunnel:\/\//i.test(text)) {
    throw new Error('Template Dark Tunnel harus berupa link/file .dark valid.');
  }

  return {
    config: { name: '' },
    type: 'REMOTE',
    isLocked: false,
    hasVisibleTunnel: false,
    lockLabel: 'via API',
    sourceFormat: 'dark',
    formatLabel: '.dark via API'
  };
}

function extractDarkTunnelLinkFromText(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/darktunnel:\/\/[A-Za-z0-9_\-=]+/i);
  return match ? match[0] : '';
}

function parseDarkTemplateTextInput(raw) {
  const templateText = extractDarkTunnelLinkFromText(raw);
  if (!templateText) {
    throw new Error('Teks tidak berisi link darktunnel:// yang valid.');
  }
  const info = inspectDarkTemplateText(templateText);
  return {
    storedTemplateText: templateText,
    formatLabel: info.formatLabel,
    type: info.type,
    isLocked: info.isLocked,
    hasVisibleTunnel: info.hasVisibleTunnel,
    configName: String(info.config?.name || '').trim()
  };
}

function getSuggestedDarkTemplateNameFromParsed(parsed, fallback = 'Template Dark Link') {
  const name = sanitizeHcTemplateName(parsed?.configName || fallback);
  return name.length >= 2 ? name : fallback;
}

async function startDarkTemplateTextUpload(ctx, rawText) {
  try {
    const parsed = parseDarkTemplateTextInput(rawText);
    const suggestedTemplateName = getSuggestedDarkTemplateNameFromParsed(parsed);
    userState[ctx.chat.id] = {
      step: 'admin_dark_template_name_input',
      templateText: parsed.storedTemplateText,
      sourceFileName: 'template-dark-link.dark',
      suggestedTemplateName,
      formatLabel: parsed.formatLabel
    };

    return ctx.reply(
      'Template Dark Tunnel dari link diterima.\n' +
      `Format: ${parsed.formatLabel}\n` +
      `Nama dari config: ${suggestedTemplateName}\n\n` +
      'Kirim nama template yang akan tampil di menu user.\n' +
      'Ketik "-" untuk memakai nama dari config.\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  } catch (err) {
    logger.error('Gagal membaca link template Dark Tunnel:', err.message);
    return ctx.reply('Link Dark Tunnel tidak valid. Kirim link yang diawali darktunnel:// atau file .dark asli.');
  }
}

async function replaceDarkTemplateWithText(ctx, state, rawText) {
  const templateId = Number(state.templateId || 0);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    delete userState[ctx.from.id];
    delete userState[ctx.chat.id];
    return ctx.reply('Sesi ganti template tidak valid. Ulangi dari menu admin.');
  }

  try {
    const parsed = parseDarkTemplateTextInput(rawText);
    const result = await dbRunAsync(
      `UPDATE dark_config_templates
       SET source_file_name = ?, template_text = ?, uploaded_by = ?
       WHERE id = ?`,
      [
        'template-dark-link.dark',
        parsed.storedTemplateText,
        ctx.from.id,
        templateId
      ]
    );

    delete userState[ctx.from.id];
    delete userState[ctx.chat.id];
    await ctx.reply(
      result.changes > 0
        ? `Template Dark Tunnel berhasil diganti dari link.\nFormat: ${parsed.formatLabel}`
        : 'Template Dark Tunnel tidak ditemukan.'
    );
    return sendAdminDarkTemplateMenu(ctx);
  } catch (err) {
    logger.error('Gagal mengganti template Dark Tunnel dari link:', err.message);
    return ctx.reply('Link Dark Tunnel tidak valid. Kirim link darktunnel:// atau file .dark asli.');
  }
}

async function sendUnlockedDarkConfigFromText(ctx, state, rawText) {
  let outputPath = '';
  try {
    const templateText = extractDarkTunnelLinkFromText(rawText);
    if (!templateText) {
      return ctx.reply('Link Dark Tunnel tidak valid. Kirim link yang diawali darktunnel:// atau file .dark sebagai document.');
    }

    const method = normalizeDarkMethod(state.method);
    const beforeInfo = inspectDarkTemplateText(templateText);
    const unlocked = await unlockDarkTunnelViaApi(templateText, { filename: 'locked.dark' }, getGeneratorApiConfig());
    const afterInfo = inspectDarkTemplateText(unlocked.text);

    const outputDir = runtimePath('generated', 'dark');
    await fsPromises.mkdir(outputDir, { recursive: true });
    const originalBase = sanitizeHcFilePart(beforeInfo.config?.name || 'config-link', 'config');
    const filename = `${originalBase}_unlocked.dark`;
    outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
    await fsPromises.writeFile(outputPath, unlocked.text, 'utf8');

    delete userState[ctx.from.id];
    delete userState[ctx.chat.id];
    const previewLines = [
      unlocked.fullyUnlocked ? '<b>Config Dark Tunnel berhasil di-unlock</b>' : '<b>Config Dark Tunnel diproses</b>',
      `Metode: ${escapeHtml(getDarkMethodLabel(method))}`,
      `Type link: <code>${escapeHtml(beforeInfo.type)}</code>`,
      `File: <code>${escapeHtml(filename)}</code>`,
      `Status: <code>${escapeHtml(beforeInfo.lockLabel)}</code> -> <code>${escapeHtml(afterInfo.lockLabel)}</code>`,
      unlocked.warning ? `⚠️ ${escapeHtml(unlocked.warning)}` : ''
    ].filter(Boolean);

    await ctx.replyWithDocument(
      { source: outputPath, filename },
      {
        caption: previewLines.join('\n'),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Unlock Lagi', callback_data: 'dark_unlock_menu' }]]
        }
      }
    );
    await sendDarkTunnelConfigLinkOutput(ctx, unlocked.text, filename);
  } catch (err) {
    logger.error('Gagal unlock config Dark Tunnel dari link:', err.message);
    return ctx.reply(formatGeneratorApiError(
      err,
      'Gagal unlock link Dark Tunnel. Pastikan API generator aktif, API key valid, dan link darktunnel:// lengkap.'
    ));
  } finally {
    if (outputPath) {
      fsPromises.unlink(outputPath).catch(() => {});
    }
  }
}

async function sendDarkTunnelConfigLinkOutput(ctx, linkText, filenameBase = 'config.dark') {
  const link = String(linkText || '').trim();
  if (!link) return;

  const plainMessage = `LINK CONFIG DARK TUNNEL\n\n${link}`;
  if (plainMessage.length <= 3900) {
    await ctx.reply(
      '<b>LINK CONFIG DARK TUNNEL</b>\n\n' +
      `<blockquote expandable>${escapeHtml(link)}</blockquote>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  let outputPath = '';
  try {
    const outputDir = runtimePath('generated', 'dark-links');
    await fsPromises.mkdir(outputDir, { recursive: true });
    const base = sanitizeHcFilePart(String(filenameBase || 'config').replace(/\.[^.]+$/, ''), 'config');
    const filename = `${base}_link.txt`;
    outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
    await fsPromises.writeFile(outputPath, link, 'utf8');
    await ctx.replyWithDocument(
      { source: outputPath, filename },
      {
        caption:
          '<b>Link Config Dark Tunnel</b>\n' +
          'Link terlalu panjang untuk dikirim sebagai pesan, jadi dikirim sebagai file teks.',
        parse_mode: 'HTML'
      }
    );
  } finally {
    if (outputPath) fsPromises.unlink(outputPath).catch(() => {});
  }
}

async function getDarkTemplateRows(includeDisabled = false) {
  const rows = await dbAllAsync(
    `SELECT id, name, slug, source_file_name, template_text, enabled, uploaded_by, created_at
     FROM dark_config_templates
     ${includeDisabled ? '' : 'WHERE enabled = 1'}
     ORDER BY name COLLATE NOCASE ASC, id ASC`
  );
  return rows.map((row) => ({ ...row, templateSource: 'dark' }));
}

async function getDarkUserTemplateRows() {
  const darkRows = await getDarkTemplateRows(false);
  return darkRows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id', { sensitivity: 'base' }));
}

async function getDarkTemplateRowBySource(source, templateId) {
  if (source === 'hc') return null;
  const row = await dbGetAsync(
    `SELECT id, name, slug, source_file_name, template_text
     FROM dark_config_templates
     WHERE id = ? AND enabled = 1`,
    [templateId]
  );
  return row ? { ...row, templateSource: 'dark' } : null;
}

function getDarkTemplateNameFromFileName(fileName, fallbackIndex = 1) {
  const baseName = String(fileName || '')
    .replace(/\.(dark|hc|txt)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sanitized = sanitizeHcTemplateName(baseName);
  return sanitized.length >= 2 ? sanitized : `Template Dark ${fallbackIndex}`;
}

async function readDarkTemplateDocument(ctx, doc) {
  const fileSize = Number(doc.file_size || 0);
  if (fileSize > 2 * 1024 * 1024) {
    throw new Error('file terlalu besar, maksimal 2 MB');
  }

  const fileLink = await ctx.telegram.getFileLink(doc.file_id);
  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  const templateText = Buffer.from(response.data).toString('utf8').trim();
  return parseDarkTemplateTextInput(templateText);
}

async function saveDarkTemplateDocument(ctx, doc, fallbackIndex = 1) {
  const templateName = getDarkTemplateNameFromFileName(doc.file_name, fallbackIndex);
  const parsed = await readDarkTemplateDocument(ctx, doc);

  await dbRunAsync(
    `INSERT INTO dark_config_templates
     (name, slug, source_file_name, template_text, enabled, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [
      templateName,
      slugifyHcTemplateName(templateName),
      String(doc.file_name || 'template-dark.dark'),
      parsed.storedTemplateText,
      ctx.from.id,
      Date.now()
    ]
  );

  return {
    name: templateName,
    fileName: String(doc.file_name || 'template-dark.dark'),
    formatLabel: parsed.formatLabel
  };
}

async function processDarkTemplateUploadDocuments(ctx, docs) {
  const selectedDocs = docs.slice(0, DARK_TEMPLATE_UPLOAD_MAX_FILES);
  const ignoredCount = Math.max(0, docs.length - selectedDocs.length);
  const saved = [];
  const failed = [];

  if (selectedDocs.length === 1 && ignoredCount === 0) {
    const doc = selectedDocs[0];
    try {
      const parsed = await readDarkTemplateDocument(ctx, doc);
      const suggestedTemplateName = getDarkTemplateNameFromFileName(doc.file_name, 1);
      userState[ctx.chat.id] = {
        step: 'admin_dark_template_name_input',
        templateText: parsed.storedTemplateText,
        sourceFileName: String(doc.file_name || 'template-dark.dark'),
        suggestedTemplateName,
        formatLabel: parsed.formatLabel
      };

      return ctx.reply(
        'Template Dark Tunnel diterima.\n' +
        `Format: ${parsed.formatLabel}\n` +
        `Nama dari file: ${suggestedTemplateName}\n\n` +
        'Kirim nama template yang akan tampil di menu user.\n' +
        'Ketik "-" untuk memakai nama dari file.\n' +
        'Ketik "batal" untuk membatalkan.'
      );
    } catch (err) {
      logger.error('Gagal membaca template Dark Tunnel:', err.message);
      return ctx.reply('Template tidak valid. Kirim file .dark asli dari Dark Tunnel atau .hc HTTP Custom yang bisa dikonversi.');
    }
  }

  for (let i = 0; i < selectedDocs.length; i += 1) {
    const doc = selectedDocs[i];
    try {
      saved.push(await saveDarkTemplateDocument(ctx, doc, i + 1));
    } catch (err) {
      failed.push({
        fileName: String(doc.file_name || `file-${i + 1}`),
        reason: err.message || 'template tidak valid'
      });
    }
  }

  delete userState[ctx.from.id];
  delete userState[ctx.chat.id];

  const lines = [];
  if (saved.length) {
    lines.push('<b>Template Dark Tunnel berhasil disimpan</b>');
    saved.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${escapeHtml(item.name)} - ${escapeHtml(item.formatLabel)}`);
    });
  }

  if (failed.length) {
    if (lines.length) lines.push('');
    lines.push('<b>Gagal disimpan</b>');
    failed.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${escapeHtml(item.fileName)} - ${escapeHtml(item.reason)}`);
    });
  }

  if (ignoredCount > 0) {
    if (lines.length) lines.push('');
    lines.push(`${ignoredCount} file diabaikan karena maksimal upload sekaligus ${DARK_TEMPLATE_UPLOAD_MAX_FILES} file.`);
  }

  if (!lines.length) {
    lines.push('Tidak ada template Dark Tunnel yang berhasil diproses.');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  return sendAdminDarkTemplateMenu(ctx);
}

function scheduleDarkTemplateUploadBatch(ctx, doc) {
  const mediaGroupId = String(ctx.message.media_group_id || '');
  const batchKey = mediaGroupId
    ? `${ctx.chat.id}:media:${mediaGroupId}`
    : `${ctx.chat.id}:dark-template-docs`;
  const current = darkTemplateUploadBatches.get(batchKey) || { ctx, docs: [], timer: null };
  current.ctx = ctx;
  current.docs.push(doc);
  if (current.timer) clearTimeout(current.timer);

  current.timer = setTimeout(() => {
    const batch = darkTemplateUploadBatches.get(batchKey);
    darkTemplateUploadBatches.delete(batchKey);
    if (!batch) return;
    const state = userState[ctx.from.id] || userState[ctx.chat.id];
    if (!state || state.step !== 'admin_dark_template_upload_document') return;
    processDarkTemplateUploadDocuments(batch.ctx, batch.docs).catch((err) => {
      logger.error('Gagal memproses batch template Dark Tunnel:', err.message);
      batch.ctx.reply('Gagal memproses upload template Dark Tunnel. Silakan coba lagi.').catch(() => {});
    });
  }, DARK_TEMPLATE_UPLOAD_BATCH_DELAY_MS);

  darkTemplateUploadBatches.set(batchKey, current);
  return true;
}

function parseDarkSshAccountInput(raw) {
  return parseDarkSshAccount(parseHcSshAccountInput(raw));
}

function parseDarkVmessAccountInput(raw) {
  return parseDarkXrayAccountInput(raw, 'vmess');
}

function parseDarkXrayAccountInput(raw, method = 'vmess') {
  const normalizedMethod = normalizeDarkMethod(method);
  const type = normalizedMethod.toUpperCase();
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error(`Data ${getDarkMethodLabel(normalizedMethod)} kosong.`);
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const keyed = {};
  lines.forEach((line) => {
    const match = String(line || '').match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/);
    if (!match) return;
    const key = match[1].toLowerCase().replace(/[^a-z0-9]+/g, '');
    keyed[key] = match[2].trim();
  });
  const link = lines.find((line) => /^(vmess|vless|trojan):\/\//i.test(line)) || text;
  const domainAddress = keyed.bug || keyed.hostbug || keyed.customhost || keyed.addr || '';

  if (/^vmess:\/\//i.test(link)) {
    if (normalizedMethod !== 'vmess') throw new Error(`Link yang dikirim adalah VMess, bukan ${getDarkMethodLabel(normalizedMethod)}.`);
    const parsed = parseVmessLink(link);
    return parseDarkXrayAccount({
      host: parsed.address,
      port: parsed.port || (parsed.tls === 'tls' || parsed.security === 'tls' ? 443 : 80),
      uuid: parsed.id,
      domainAddress,
      tls: parsed.tls === 'tls' || parsed.security === 'tls',
      serverNameIndication: keyed.sni || keyed.servernameindication || keyed.servername || parsed.sni || parsed.host || parsed.address,
      wsPath: keyed.path || keyed.wspath || parsed.path || '/',
      wsHeaderHost: keyed.wsheaderhost || keyed.headerhost || keyed.hostheader || parsed.host || parsed.address,
      transportNetwork: parsed.network || 'ws'
    }, type);
  }
  if (/^vless:\/\//i.test(link) || /^trojan:\/\//i.test(link)) {
    const linkType = /^vless:\/\//i.test(link) ? 'vless' : 'trojan';
    if (normalizedMethod !== linkType) {
      throw new Error(`Link yang dikirim adalah ${getDarkMethodLabel(linkType)}, bukan ${getDarkMethodLabel(normalizedMethod)}.`);
    }
    const parsed = parseDarkXrayAccount(link, type);
    return {
      ...parsed,
      domainAddress,
      serverNameIndication: keyed.sni || keyed.servernameindication || keyed.servername || parsed.serverNameIndication,
      wsPath: keyed.path || keyed.wspath || parsed.wsPath,
      wsHeaderHost: keyed.wsheaderhost || keyed.headerhost || keyed.hostheader || parsed.wsHeaderHost || parsed.host
    };
  }

  const host = keyed.host || keyed.server || keyed.domain || keyed.address || keyed.add || '';
  const uuid = keyed.uuid || keyed.id || keyed.password || keyed.pass || keyed.user || '';
  if (host && uuid) {
    const tlsText = String(keyed.tls || keyed.security || '').toLowerCase();
    const inheritTemplateTransport = !keyed.port && !tlsText;
    return parseDarkXrayAccount({
      host,
      port: keyed.port || (tlsText ? (tlsText === 'tls' ? 443 : 80) : undefined),
      uuid,
      domainAddress,
      tls: tlsText ? ['true', '1', 'yes', 'on', 'tls'].includes(tlsText) : undefined,
      serverNameIndication: keyed.sni || keyed.servernameindication || keyed.servername || '',
      wsPath: keyed.path || keyed.wspath || undefined,
      wsHeaderHost: keyed.wsheaderhost || keyed.headerhost || keyed.hostheader || host,
      inheritTemplateTransport
    }, type);
  }

  return parseDarkXrayAccount(text, type);
}

async function sendGeneratedDarkTemplateConfig(ctx, state, account, noteSetting = { enabled: false, html: '' }) {
  let outputPath = '';
  const method = normalizeDarkMethod(state.method);
  const hasCustomMessage = Boolean(
    noteSetting &&
    noteSetting.enabled &&
    String(noteSetting.html || '').trim()
  );

  try {
    const row = await getDarkTemplateRowBySource(state.templateSource, state.templateId);

    if (!row) {
      delete userState[ctx.chat.id];
      return ctx.reply('Template Dark Tunnel tidak ditemukan atau sedang nonaktif.');
    }

    const templateInfo = inspectDarkTemplateText(row.template_text);
    const generated = await generateDarkTunnelViaApi(row.template_text, {
      method: method === 'ssh' ? 'SSH' : method.toUpperCase(),
      name: row.name,
      account,
      noteSetting,
      filename: row.source_file_name || 'template.dark'
    }, getGeneratorApiConfig());

    const outputDir = runtimePath('generated', 'dark');
    await fsPromises.mkdir(outputDir, { recursive: true });

    const accountPart = account.username || String(account.uuid || account.password || '').slice(0, 8) || 'user';
    const filename =
      `${sanitizeHcFilePart(row.slug || state.templateSlug || row.name, 'dark')}` +
      `${sanitizeHcFilePart(accountPart, 'user')}.dark`;
    outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
    await fsPromises.writeFile(outputPath, generated.text, 'utf8');

    delete userState[ctx.chat.id];
    const templateStatus = templateInfo.isLocked ? '\nTemplate locked: Dibuka otomatis' : '';
    await ctx.replyWithDocument(
      { source: outputPath, filename },
      {
        caption:
          `<b>Config Dark Tunnel siap dipakai</b>\n` +
          `Template: ${escapeHtml(row.name)}\n` +
          `Metode: ${escapeHtml(getDarkMethodLabel(method))}\n` +
          `${method === 'ssh' ? 'Username' : (method === 'trojan' ? 'Password' : 'UUID')}: <code>${escapeHtml(accountPart)}</code>\n` +
          `Message: ${hasCustomMessage ? 'Custom' : 'Bawaan template'}\n` +
          `File: <code>${escapeHtml(filename)}</code>` +
          templateStatus,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Buat Config Lagi', callback_data: 'dark_template_menu' }]]
        }
      }
    );
    await sendDarkTunnelConfigLinkOutput(ctx, generated.text, filename);
    return;
  } catch (err) {
    logger.error('Gagal membuat config Dark Tunnel:', err.message);
    return ctx.reply(formatGeneratorApiError(
      err,
      'Gagal membuat config Dark Tunnel. Pastikan API generator aktif, API key valid, template .dark valid, dan metode akun sesuai template.'
    ));
  } finally {
    if (outputPath) {
      fsPromises.unlink(outputPath).catch(() => {});
    }
  }
}

async function sendDarkCreateMethodMenu(ctx) {
  const text =
    '<b>BUAT CONFIG DARK TUNNEL</b>\n\n' +
    'Pilih metode akun yang akan dimasukkan ke template Dark Tunnel.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'SSH', callback_data: 'dark_template_method_ssh' }],
        [{ text: 'VMess', callback_data: 'dark_template_method_vmess' }],
        [{ text: 'VLESS', callback_data: 'dark_template_method_vless' }],
        [{ text: 'Trojan', callback_data: 'dark_template_method_trojan' }],
        [{ text: 'Kembali', callback_data: 'config_unlock_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendDarkUnlockMethodMenu(ctx) {
  const text =
    '<b>UNLOCK CONFIG DARK TUNNEL</b>\n\n' +
    'Pilih metode config yang mau dibuka, lalu kirim file <code>.dark</code>.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Unlock SSH', callback_data: 'dark_unlock_method_ssh' }],
        [{ text: 'Unlock VMess', callback_data: 'dark_unlock_method_vmess' }],
        [{ text: 'Unlock VLESS', callback_data: 'dark_unlock_method_vless' }],
        [{ text: 'Unlock Trojan', callback_data: 'dark_unlock_method_trojan' }],
        [{ text: 'Kembali', callback_data: 'config_unlock_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendConfigUnlockMenu(ctx) {
  const text =
    '<b>BUAT CONFIG DAN UNLOCK</b>\n\n' +
    'Pilih jenis config yang mau dibuat atau dibuka.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🧩 Buat Config HC', callback_data: 'hc_template_menu' },
          { text: '🧩 Buat Config Dark', callback_data: 'dark_template_menu' }
        ],
        [
          { text: '🔓 Unlock Config HC', callback_data: 'hc_unlock_menu' },
          { text: '🔓 Unlock Config Dark', callback_data: 'dark_unlock_menu' }
        ],
        [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function getDarkUnlockResellerRequiredMessage() {
  return (
    'Menu Unlock Config Dark Tunnel khusus untuk reseller.\n\n' +
    'Untuk menggunakan menu ini Anda harus menjadi reseller terlebih dahulu.'
  );
}

async function sendDarkTemplateUserMenu(ctx, method = 'ssh', page = 0) {
  const normalizedMethod = normalizeDarkMethod(method);
  const methodLabel = getDarkMethodLabel(normalizedMethod);
  const allRows = await getDarkUserTemplateRows();
  const rows = allRows.filter((row) => {
    try {
      const info = inspectDarkTemplateText(row.template_text);
      return isDarkTemplateCompatibleWithMethod(info.type, normalizedMethod);
    } catch (_) {
      return false;
    }
  });

  if (!rows.length) {
    return ctx.reply(`Belum ada template Dark Tunnel untuk metode ${methodLabel}. Silakan hubungi admin.`, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Kembali', callback_data: 'dark_template_menu' }]]
      }
    });
  }

  const { safePage, totalPages, start } = getSafePage(page, rows.length, DARK_TEMPLATE_PAGE_SIZE);
  const pageRows = rows.slice(start, start + DARK_TEMPLATE_PAGE_SIZE);
  const keyboard = pageRows.map((row) => ([{
    text: `${row.name || `Template ${row.id}`}`,
    callback_data: `dark_template_select_${normalizedMethod}_${row.templateSource}_${row.id}`
  }]));
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `dark_template_page_${normalizedMethod}_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `dark_template_page_${normalizedMethod}_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'dark_template_menu' }]);

  const text =
    `Pilih template Dark Tunnel untuk metode ${methodLabel}:\n` +
    (normalizedMethod === 'ssh'
      ? ''
      : 'Template SSH akan otomatis dikonversi dan memakai bug proxy/SNI dari template.\n') +
    `Halaman ${safePage + 1}/${totalPages}`;
  const payload = { reply_markup: { inline_keyboard: keyboard } };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendAdminDarkTemplateMenu(ctx, page = 0) {
  const rows = await getDarkTemplateRows(true);
  const { safePage, totalPages, start } = getSafePage(page, rows.length, DARK_TEMPLATE_PAGE_SIZE);
  const pageRows = rows.slice(start, start + DARK_TEMPLATE_PAGE_SIZE);
  const lines = pageRows.length
    ? pageRows.map((row, idx) => {
        const status = Number(row.enabled) === 1 ? 'Aktif' : 'Nonaktif';
        let info = '';
        try {
          info = inspectDarkTemplateText(row.template_text).formatLabel;
        } catch (_) {
          info = 'format rusak';
        }
        return `${start + idx + 1}. ${escapeHtml(row.name || `Template ${row.id}`)} (${status}, ${escapeHtml(info)})`;
      }).join('\n')
    : 'Belum ada template Dark Tunnel.';

  const keyboard = [
    [{ text: 'Upload Template Dark', callback_data: 'admin_dark_template_upload' }]
  ];

  pageRows.forEach((row) => {
    keyboard.push([
      {
        text: String(row.name || `Template ${row.id}`).slice(0, 60),
        callback_data: `admin_dark_template_manage_${row.id}_${safePage}`
      }
    ]);
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `admin_dark_template_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `admin_dark_template_page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'admin_menu_tools' }]);

  const text =
    '<b>TEMPLATE CONFIG DARK TUNNEL</b>\n\n' +
    `Halaman: <b>${safePage + 1}/${totalPages}</b>\n\n` +
    lines + '\n\n' +
    'Template HC dan Dark Tunnel dipisah. Menu ini khusus template Dark Tunnel.\n\n' +
    'Upload file <code>.dark</code> asli dari Dark Tunnel sebagai template khusus Dark.\n\n' +
    'Saat user membuat config, template locked akan dibuka otomatis lalu akun diganti sesuai input user.\n' +
    'Template HC tidak ditampilkan di menu Dark Tunnel. Upload template .dark khusus jika ingin membuat config Dark.\n' +
    'Message/note Dark Tunnel dipertahankan dari template agar tetap kompatibel saat import.';

  const payload = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }

  return ctx.reply(text, payload);
}

async function sendAdminDarkTemplateActionMenu(ctx, templateId, page = 0) {
  const row = await dbGetAsync(
    `SELECT id, name, source_file_name, enabled
     FROM dark_config_templates
     WHERE id = ?`,
    [templateId]
  );

  if (!row) {
    return ctx.reply('Template Dark Tunnel tidak ditemukan.');
  }

  const templateName = row.name || `Template ${row.id}`;
  const status = Number(row.enabled) === 1 ? 'Aktif' : 'Nonaktif';
  const text =
    '<b>KELOLA TEMPLATE DARK TUNNEL</b>\n\n' +
    `Template: <b>${escapeHtml(templateName)}</b>\n` +
    `Status: ${status}\n` +
    `File: <code>${escapeHtml(row.source_file_name || '-')}</code>\n\n` +
    'Pilih tindakan untuk template ini.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Edit Nama', callback_data: `admin_dark_template_rename_${row.id}` }],
        [
          { text: 'Ganti File', callback_data: `admin_dark_template_replace_${row.id}` },
          { text: 'Hapus', callback_data: `admin_dark_template_delete_${row.id}` }
        ],
        [{ text: 'Kembali', callback_data: `admin_dark_template_page_${Math.max(0, Number(page) || 0)}` }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }

  return ctx.reply(text, payload);
}

function resolveHcUserNoteSetting(rawNoteText) {
  const text = String(rawNoteText || '').trim();
  const lower = text.toLowerCase();
  if (!text || ['-', 'skip', 'lewati', 'tanpa note', 'kosong', 'no note'].includes(lower)) {
    return { enabled: false, html: '' };
  }
  if (['default', 'bawaan', 'note default'].includes(lower)) {
    return loadHcDefaultNoteSetting();
  }
  return { enabled: true, html: text };
}

function getHcPendingNoteState(ctx) {
  const state = userState[ctx.chat.id];
  if (!state || !state.account || !state.templateId) {
    delete userState[ctx.chat.id];
    return null;
  }
  return state;
}

function sendHcNoteChoiceMenu(ctx) {
  const text =
    '<b>Note Config</b>\n\n' +
    'Pilih note untuk config HC ini.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Default', callback_data: 'hc_note_default' },
          { text: 'Tambah Note', callback_data: 'hc_note_custom' }
        ],
        [{ text: 'Skip', callback_data: 'hc_note_skip' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function resolveDarkUserNoteSetting(rawNoteText) {
  const text = String(rawNoteText || '').trim();
  const lower = text.toLowerCase();
  if (!text || ['-', 'skip', 'lewati', 'tanpa note', 'kosong', 'no note'].includes(lower)) {
    return { enabled: false, html: '' };
  }
  if (['default', 'bawaan', 'note default'].includes(lower)) {
    return loadDarkDefaultNoteSetting();
  }
  return { enabled: true, html: text };
}

function getDarkPendingNoteState(ctx) {
  const state = userState[ctx.chat.id];
  if (!state || !state.account || !state.templateId) {
    delete userState[ctx.chat.id];
    return null;
  }
  return state;
}

function sendDarkNoteChoiceMenu(ctx) {
  const text =
    '<b>Note Config Dark Tunnel</b>\n\n' +
    'Pilih pesan/note untuk config Dark Tunnel ini.\n' +
    'Note HTML akan otomatis dijadikan teks biasa agar aman di-import.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Default', callback_data: 'dark_note_default' },
          { text: 'Tambah Note', callback_data: 'dark_note_custom' }
        ],
        [{ text: 'Skip', callback_data: 'dark_note_skip' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendGeneratedHcTemplateConfig(ctx, state, account, noteSetting) {
  let outputPath = '';
  const method = normalizeHcMethod(state.method);

  try {
    const row = await dbGetAsync(
      `SELECT id, name, slug, source_file_name, template_text
       FROM hc_config_templates
       WHERE id = ? AND enabled = 1`,
      [state.templateId]
    );

    if (!row) {
      delete userState[ctx.chat.id];
      return ctx.reply('Template HC tidak ditemukan atau sedang nonaktif.');
    }

    const configBuffer = await generateHcConfigViaApi(row.template_text, {
      method,
      templateName: row.name,
      name: row.name,
      noteEnabled: noteSetting.enabled,
      noteHtml: noteSetting.html,
      account,
      filename: row.source_file_name || 'template.hc'
    }, getGeneratorApiConfig());

    const outputDir = runtimePath('generated', 'hc');
    await fsPromises.mkdir(outputDir, { recursive: true });

    const filename =
      `${sanitizeHcFilePart(row.slug || state.templateSlug || row.name, 'hc')}` +
      `${sanitizeHcFilePart(account.username, 'user')}.hc`;
    outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
    await fsPromises.writeFile(outputPath, configBuffer);

    delete userState[ctx.chat.id];
    await ctx.replyWithDocument(
      { source: outputPath, filename },
      {
        caption:
          `<b>Config HC siap dipakai</b>\n` +
          `Template: ${escapeHtml(row.name)}\n` +
          `Metode: ${escapeHtml(getHcMethodLabel(method))}\n` +
          `${method === 'xray' ? 'Protocol' : 'Username'}: <code>${escapeHtml(account.username)}</code>\n` +
          `Note: ${noteSetting.enabled && String(noteSetting.html || '').trim() ? 'Dipakai' : 'Kosong'}\n` +
          `File: <code>${escapeHtml(filename)}</code>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Buat Config Lagi', callback_data: 'hc_template_menu' }]]
        }
      }
    );
    return;
  } catch (err) {
    logger.error('Gagal membuat config HC:', err.message);
    return ctx.reply(formatGeneratorApiError(
      err,
      'Gagal membuat config HC. Pastikan API generator aktif, API key valid, template .hc valid, dan metode akun sesuai template.'
    ));
  } finally {
    if (outputPath) {
      fsPromises.unlink(outputPath).catch(() => {});
    }
  }
}

async function sendHcCreateMethodMenu(ctx) {
  const text =
    '<b>BUAT CONFIG HC</b>\n\n' +
    'Pilih metode akun yang akan dimasukkan ke template.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'SSH', callback_data: 'hc_template_method_ssh' }],
        [{ text: 'Xray / V2Ray', callback_data: 'hc_template_method_xray' }],
        [{ text: 'Kembali', callback_data: 'config_unlock_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendHcUnlockMethodMenu(ctx) {
  const text =
    '<b>UNLOCK CONFIG HC</b>\n\n' +
    'Pilih metode config yang mau dibuka, lalu kirim file <code>.hc</code>.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Unlock SSH', callback_data: 'hc_unlock_method_ssh' }],
        [{ text: 'Unlock Xray / V2Ray', callback_data: 'hc_unlock_method_xray' }],
        [{ text: 'Kembali', callback_data: 'config_unlock_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function getHcUnlockResellerRequiredMessage() {
  return (
    'Menu Unlock Config HC khusus untuk reseller.\n\n' +
    'Untuk menggunakan menu ini Anda harus menjadi reseller terlebih dahulu.'
  );
}

async function sendHcTemplateUserMenu(ctx, method = 'ssh', page = 0) {
  const normalizedMethod = normalizeHcMethod(method);
  const methodLabel = getHcMethodLabel(normalizedMethod);
  const rows = await getHcTemplateRows(false);
  if (!rows.length) {
    return ctx.reply('Belum ada template config HC. Silakan hubungi admin.', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Kembali', callback_data: 'hc_template_menu' }]]
      }
    });
  }

  const { safePage, totalPages, start } = getSafePage(page, rows.length, HC_TEMPLATE_PAGE_SIZE);
  const pageRows = rows.slice(start, start + HC_TEMPLATE_PAGE_SIZE);
  const keyboard = pageRows.map((row) => ([{
    text: row.name || `Template ${row.id}`,
    callback_data: `hc_template_select_${normalizedMethod}_${row.id}`
  }]));
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `hc_template_page_${normalizedMethod}_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `hc_template_page_${normalizedMethod}_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'hc_template_menu' }]);

  const text = `Pilih template config HC untuk metode ${methodLabel}:\nHalaman ${safePage + 1}/${totalPages}`;
  const payload = { reply_markup: { inline_keyboard: keyboard } };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendAdminHcTemplateMenu(ctx, page = 0) {
  const rows = await getHcTemplateRows(true);
  const noteSetting = loadHcDefaultNoteSetting();
  const noteEnabled = !!noteSetting.enabled && String(noteSetting.html || '').trim().length > 0;
  const noteStatus = noteEnabled ? 'Aktif' : 'Nonaktif';
  const noteLength = String(noteSetting.html || '').length;
  const { safePage, totalPages, start } = getSafePage(page, rows.length, HC_TEMPLATE_PAGE_SIZE);
  const pageRows = rows.slice(start, start + HC_TEMPLATE_PAGE_SIZE);
  const lines = pageRows.length
    ? pageRows.map((row, idx) => {
        const status = Number(row.enabled) === 1 ? 'Aktif' : 'Nonaktif';
        return `${start + idx + 1}. ${escapeHtml(row.name || `Template ${row.id}`)} (${status})`;
      }).join('\n')
    : 'Belum ada template HC.';

  const keyboard = [
    [{ text: 'Upload Template HC', callback_data: 'admin_hc_template_upload' }],
    [
      { text: `Note Default: ${noteStatus}`, callback_data: 'admin_hc_note_toggle' },
      { text: 'Set Note Default', callback_data: 'admin_hc_note_set' }
    ],
    [{ text: 'Hapus Note Default', callback_data: 'admin_hc_note_clear' }]
  ];

  pageRows.forEach((row) => {
    keyboard.push([
      {
        text: String(row.name || `Template ${row.id}`).slice(0, 60),
        callback_data: `admin_hc_template_manage_${row.id}_${safePage}`
      }
    ]);
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `admin_hc_template_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `admin_hc_template_page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'admin_menu_tools' }]);

  const text =
    '<b>TEMPLATE CONFIG HC</b>\n\n' +
    `<b>Note Default</b>: ${noteStatus}\n` +
    `Panjang Note: ${noteLength} karakter\n\n` +
    `Halaman: <b>${safePage + 1}/${totalPages}</b>\n\n` +
    lines + '\n\n' +
    'Upload file <code>.hc</code> asli dari HTTP Custom. Untuk SSH, bot mengirim akun SSH ke API generator. Untuk Xray, gunakan template yang sudah mode V2Ray/Xray.\n\n' +
    'Generate dan unlock diproses oleh API generator private. Source generator tidak ada di bot clone ini.';

  const payload = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }

  return ctx.reply(text, payload);
}

async function sendAdminHcTemplateActionMenu(ctx, templateId, page = 0) {
  const row = await dbGetAsync(
    `SELECT id, name, source_file_name, enabled
     FROM hc_config_templates
     WHERE id = ?`,
    [templateId]
  );

  if (!row) {
    return ctx.reply('Template HC tidak ditemukan.');
  }

  const templateName = row.name || `Template ${row.id}`;
  const status = Number(row.enabled) === 1 ? 'Aktif' : 'Nonaktif';
  const text =
    '<b>KELOLA TEMPLATE HC</b>\n\n' +
    `Template: <b>${escapeHtml(templateName)}</b>\n` +
    `Status: ${status}\n` +
    `File: <code>${escapeHtml(row.source_file_name || '-')}</code>\n\n` +
    'Pilih tindakan untuk template ini.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Edit Nama', callback_data: `admin_hc_template_rename_${row.id}` }],
        [
          { text: 'Ganti File', callback_data: `admin_hc_template_replace_${row.id}` },
          { text: 'Hapus', callback_data: `admin_hc_template_delete_${row.id}` }
        ],
        [{ text: 'Kembali', callback_data: `admin_hc_template_page_${Math.max(0, Number(page) || 0)}` }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }

  return ctx.reply(text, payload);
}

async function sendDownloadConfigMenu(ctx) {
  const rows = await getDownloadConfigRows();
  if (!rows.length) {
    return ctx.reply('Belum ada config yang tersedia. Silakan cek lagi nanti.', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Kembali', callback_data: 'send_main_menu' }]]
      }
    });
  }

  const keyboard = rows.map((row) => ([{
    text: row.name || row.file_name || `Config ${row.id}`,
    callback_data: `download_config_${row.id}`
  }]));
  keyboard.push([{ text: 'Kembali', callback_data: 'send_main_menu' }]);

  return ctx.reply('Pilih config yang ingin didownload:', {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminDownloadConfigMenu(ctx) {
  const rows = await getDownloadConfigRows();
  const lines = rows.length
    ? rows.map((row, idx) => `${idx + 1}. ${escapeHtml(row.name || row.file_name || `Config ${row.id}`)}`).join('\n')
    : 'Belum ada config yang diupload.';

  const keyboard = [
    [{ text: 'Upload Config Baru', callback_data: 'admin_config_upload' }]
  ];

  rows.slice(0, 20).forEach((row) => {
    keyboard.push([
      { text: `Hapus: ${row.name || row.file_name || `Config ${row.id}`}`.slice(0, 60), callback_data: `admin_config_delete_${row.id}` }
    ]);
  });

  keyboard.push([{ text: 'Kembali', callback_data: 'admin_menu_tools' }]);

  const payload = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };

  const text =
    '<b>DOWNLOAD CONFIG</b>\n\n' +
    lines + '\n\n' +
    'Upload file config sebagai document, lalu beri nama config.';

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }

  return ctx.reply(text, payload);
}

function normalizeBulkConfigPrefix(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '-' || /^tanpa(\s+prefix)?$/i.test(text)) return '';
  const safe = sanitizeHcFilePart(text, '');
  if (!safe) return '';
  return /[_-]$/.test(safe) ? safe : `${safe}_`;
}

function getBulkConfigMethodLabel(format, method) {
  return format === 'hc' ? getHcMethodLabel(method) : getDarkMethodLabel(method);
}

function getBulkConfigAccountPart(format, method, account) {
  if (method === 'ssh') return account.username || 'user';
  if (format === 'hc') return account.protocol || account.username || 'xray';
  return String(account.uuid || account.password || 'xray').slice(0, 12) || 'xray';
}

function buildBulkConfigFilename(row, prefix, accountPart, ext, variant = '') {
  const base = sanitizeHcFilePart(row.slug || row.name || 'config', 'config');
  const accountSuffix = accountPart ? `_${sanitizeHcFilePart(accountPart, 'user')}` : '';
  const variantSuffix = variant ? `_${sanitizeHcFilePart(variant, 'config')}` : '';
  return `${prefix || ''}${base}${accountSuffix}${variantSuffix}.${ext}`;
}

async function getBulkHcTemplateRows() {
  return dbAllAsync(
    `SELECT id, name, slug, source_file_name, template_text
     FROM hc_config_templates
     WHERE enabled = 1
     ORDER BY name COLLATE NOCASE ASC, id ASC`
  );
}

async function getBulkDarkTemplateRows(method) {
  const rows = await getDarkUserTemplateRows();
  return rows.filter((row) => {
    try {
      const info = inspectDarkTemplateText(row.template_text);
      return isDarkTemplateCompatibleWithMethod(info.type, method);
    } catch (_) {
      return false;
    }
  });
}

async function sendAdminBulkConfigMenu(ctx) {
  const text =
    '<b>BULK GENERATE CONFIG</b>\n\n' +
    'Menu ini khusus admin untuk membuat config dari semua template aktif sekaligus.\n' +
    'Setiap template akan dikirim 2 file: versi lock dan versi unlock.\n' +
    'Pilih jenis config, isi prefix nama file, lalu kirim akun.';
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'HC SSH', callback_data: 'admin_bulk_config_hc_ssh' },
          { text: 'HC Xray', callback_data: 'admin_bulk_config_hc_xray' }
        ],
        [
          { text: 'Dark SSH', callback_data: 'admin_bulk_config_dark_ssh' },
          { text: 'Dark VMess', callback_data: 'admin_bulk_config_dark_vmess' }
        ],
        [
          { text: 'Dark VLESS', callback_data: 'admin_bulk_config_dark_vless' },
          { text: 'Dark Trojan', callback_data: 'admin_bulk_config_dark_trojan' }
        ],
        [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function startAdminBulkConfigFlow(ctx, format, method) {
  const normalizedFormat = format === 'dark' ? 'dark' : 'hc';
  const normalizedMethod = normalizedFormat === 'hc' ? normalizeHcMethod(method) : normalizeDarkMethod(method);
  userState[ctx.chat.id] = {
    step: 'admin_bulk_config_prefix_input',
    format: normalizedFormat,
    method: normalizedMethod
  };

  return ctx.reply(
    `<b>Bulk Generate ${normalizedFormat.toUpperCase()} ${escapeHtml(getBulkConfigMethodLabel(normalizedFormat, normalizedMethod))}</b>\n\n` +
    'Kirim prefix nama file.\n' +
    'Contoh: <code>1forcr_</code> agar file menjadi <code>1forcr_namatemplate_user.hc</code>.\n\n' +
    'Kirim <code>-</code> untuk tanpa prefix.\n' +
    'Ketik <code>batal</code> untuk membatalkan.',
    { parse_mode: 'HTML' }
  );
}

function sendAdminBulkAccountPrompt(ctx, state) {
  const format = state.format === 'dark' ? 'dark' : 'hc';
  const method = format === 'hc' ? normalizeHcMethod(state.method) : normalizeDarkMethod(state.method);
  const methodLabel = getBulkConfigMethodLabel(format, method);
  const prefixText = state.prefix ? `<code>${escapeHtml(state.prefix)}</code>` : '<code>tanpa prefix</code>';

  if (method === 'ssh') {
    return ctx.reply(
      `<b>Bulk Generate ${format.toUpperCase()} ${escapeHtml(methodLabel)}</b>\n` +
      `Prefix: ${prefixText}\n\n` +
      'Kirim akun SSH dengan format:\n' +
      '<code>host:port@username:password</code>\n\n' +
      'Atau kirim baris Host, Port, Username, Password.\n' +
      'Ketik <code>batal</code> untuk membatalkan.',
      { parse_mode: 'HTML' }
    );
  }

  if (format === 'hc') {
    return ctx.reply(
      `<b>Bulk Generate HC Xray</b>\n` +
      `Prefix: ${prefixText}\n\n` +
      'Kirim link <code>vmess://</code>, <code>vless://</code>, atau <code>trojan://</code>.\n' +
      'Format ringkas: <code>host:UUID</code> (VMess), <code>vless:host:UUID</code>, atau <code>trojan:host:PASSWORD</code>.\n' +
      'Bisa juga kirim JSON V2Ray mentah. Bug/Domain Address otomatis mengikuti Remote Proxy atau SNI template SSH.\n\n' +
      'Ketik <code>batal</code> untuk membatalkan.',
      { parse_mode: 'HTML' }
    );
  }

  const secretLabel = method === 'trojan' ? 'password' : 'uuid';
  const linkPrefix = method === 'trojan' ? 'trojan://' : (method === 'vless' ? 'vless://' : 'vmess://');
  return ctx.reply(
    `<b>Bulk Generate Dark ${escapeHtml(methodLabel)}</b>\n` +
    `Prefix: ${prefixText}\n\n` +
    `Kirim akun ${escapeHtml(methodLabel)} dengan format:\n` +
    `<code>host:${secretLabel}</code> untuk mengikuti port/transport template\n` +
    `<code>host:port@${secretLabel}</code>\n\n` +
    `Atau kirim link <code>${linkPrefix}...</code> saja. Kalau template asalnya SSH, bug/Domain Address otomatis diambil dari Proxy/SNI template.\n` +
    'Override bug opsional: <code>Bug: bug.domain.com</code> di baris berikutnya.\n' +
    'Ketik <code>batal</code> untuk membatalkan.',
    { parse_mode: 'HTML' }
  );
}

async function generateBulkHcConfigFiles(row, method, account, noteSetting, outputDir, prefix) {
  const lockedBuffer = await generateHcConfigViaApi(row.template_text, {
    method,
    templateName: row.name,
    name: row.name,
    noteEnabled: noteSetting.enabled,
    noteHtml: noteSetting.html,
    account,
    filename: row.source_file_name || 'template.hc'
  }, getGeneratorApiConfig());
  const unlockedBuffer = await unlockHcConfigViaApi(lockedBuffer, {
    method,
    filename: 'generated.hc'
  }, getGeneratorApiConfig());
  const accountPart = getBulkConfigAccountPart('hc', method, account);
  const timestamp = Date.now();
  const lockedFilename = buildBulkConfigFilename(row, prefix, accountPart, 'hc', 'lock');
  const unlockedFilename = buildBulkConfigFilename(row, prefix, accountPart, 'hc', 'unlock');
  const lockedOutputPath = path.join(outputDir, `${timestamp}_${row.id}_lock_${lockedFilename}`);
  const unlockedOutputPath = path.join(outputDir, `${timestamp}_${row.id}_unlock_${unlockedFilename}`);

  await fsPromises.writeFile(lockedOutputPath, lockedBuffer);
  await fsPromises.writeFile(unlockedOutputPath, unlockedBuffer);

  return {
    files: [
      { outputPath: lockedOutputPath, filename: lockedFilename, variant: 'LOCK' },
      { outputPath: unlockedOutputPath, filename: unlockedFilename, variant: 'UNLOCK' }
    ]
  };
}

async function generateBulkDarkConfigFiles(row, method, account, noteSetting, outputDir, prefix) {
  const templateInfo = inspectDarkTemplateText(row.template_text);
  const generated = await generateDarkTunnelViaApi(row.template_text, {
    method: method === 'ssh' ? 'SSH' : method.toUpperCase(),
    name: row.name,
    account,
    noteSetting,
    filename: row.source_file_name || 'template.dark'
  }, getGeneratorApiConfig());
  const unlocked = await unlockDarkTunnelViaApi(generated.text, {
    filename: 'generated.dark'
  }, getGeneratorApiConfig());

  const accountPart = getBulkConfigAccountPart('dark', method, account);
  const timestamp = Date.now();
  const source = row.templateSource || 'dark';
  const lockedFilename = buildBulkConfigFilename(row, prefix, accountPart, 'dark', 'lock');
  const unlockedFilename = buildBulkConfigFilename(row, prefix, accountPart, 'dark', 'unlock');
  const lockedOutputPath = path.join(outputDir, `${timestamp}_${source}_${row.id}_lock_${lockedFilename}`);
  const unlockedOutputPath = path.join(outputDir, `${timestamp}_${source}_${row.id}_unlock_${unlockedFilename}`);

  await fsPromises.writeFile(lockedOutputPath, generated.text, 'utf8');
  await fsPromises.writeFile(unlockedOutputPath, unlocked.text, 'utf8');

  return {
    templateInfo,
    files: [
      { outputPath: lockedOutputPath, filename: lockedFilename, variant: 'LOCK' },
      { outputPath: unlockedOutputPath, filename: unlockedFilename, variant: 'UNLOCK', warning: unlocked.warning || '' }
    ]
  };
}

async function sendBulkGeneratedConfigs(ctx, state, account) {
  const format = state.format === 'dark' ? 'dark' : 'hc';
  const method = format === 'hc' ? normalizeHcMethod(state.method) : normalizeDarkMethod(state.method);
  const prefix = state.prefix || '';
  const outputDir = runtimePath('generated', 'bulk', format);
  await fsPromises.mkdir(outputDir, { recursive: true });

  const noteSetting = format === 'hc' ? loadHcDefaultNoteSetting() : loadDarkDefaultNoteSetting();
  const rows = format === 'hc'
    ? await getBulkHcTemplateRows()
    : await getBulkDarkTemplateRows(method);

  if (!rows.length) {
    delete userState[ctx.chat.id];
    return ctx.reply(
      `Belum ada template aktif untuk ${format.toUpperCase()} ${getBulkConfigMethodLabel(format, method)}.`,
      { reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'admin_bulk_config_menu' }]] } }
    );
  }

  await ctx.reply(
    `Memproses ${rows.length} template ${format.toUpperCase()} ${getBulkConfigMethodLabel(format, method)}.\n` +
    `Output: versi lock + unlock (${rows.length * 2} file jika semua berhasil).\n` +
    `Prefix file: ${prefix || 'tanpa prefix'}\n` +
    `Note default: ${noteSetting.enabled && String(noteSetting.html || '').trim() ? 'Dipakai' : 'Kosong'}`
  );

  const sent = [];
  const failed = [];

  for (const row of rows) {
    let generatedBundle = null;
    try {
      generatedBundle = format === 'hc'
        ? await generateBulkHcConfigFiles(row, method, account, noteSetting, outputDir, prefix)
        : await generateBulkDarkConfigFiles(row, method, account, noteSetting, outputDir, prefix);

      const sourceLabel = `Template ${format.toUpperCase()}`;
      for (const generatedFile of generatedBundle.files || []) {
        await ctx.replyWithDocument(
          { source: generatedFile.outputPath, filename: generatedFile.filename },
          {
            caption:
              `<b>Bulk Config ${format.toUpperCase()} ${escapeHtml(generatedFile.variant)}</b>\n` +
              `Template: ${escapeHtml(row.name || `Template ${row.id}`)}\n` +
              `Metode: ${escapeHtml(getBulkConfigMethodLabel(format, method))}\n` +
              `Sumber: ${escapeHtml(sourceLabel)}\n` +
              `Versi: <b>${escapeHtml(generatedFile.variant)}</b>\n` +
              `File: <code>${escapeHtml(generatedFile.filename)}</code>` +
              (generatedFile.warning ? `\n⚠️ ${escapeHtml(generatedFile.warning)}` : ''),
            parse_mode: 'HTML'
          }
        );
        sent.push(generatedFile.filename);
        await sleepMs(BULK_CONFIG_SEND_DELAY_MS);
      }
    } catch (err) {
      logger.error(`Gagal bulk generate ${format} template ${row.id}:`, err.message);
      failed.push({ name: row.name || `Template ${row.id}`, reason: err.message || 'gagal generate' });
    } finally {
      if (generatedBundle && Array.isArray(generatedBundle.files)) {
        generatedBundle.files.forEach((file) => {
          if (file && file.outputPath) fsPromises.unlink(file.outputPath).catch(() => {});
        });
      }
    }
  }

  delete userState[ctx.chat.id];

  const lines = [
    '<b>Bulk generate selesai</b>',
    `Berhasil: <b>${sent.length}</b> file`,
    `Gagal: <b>${failed.length}</b> template`
  ];

  if (failed.length) {
    lines.push('', '<b>Gagal:</b>');
    failed.slice(0, 20).forEach((item, idx) => {
      lines.push(`${idx + 1}. ${escapeHtml(item.name)} - ${escapeHtml(item.reason)}`);
    });
    if (failed.length > 20) lines.push(`...dan ${failed.length - 20} template lainnya.`);
  }

  return ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Kembali ke Bulk Config', callback_data: 'admin_bulk_config_menu' }]] }
  });
}

async function reserveAccountChargeAtomic(userId, amount, type, action = 'other', walletType = 'vpn') {
  const referenceId = `account-${action}-${type}-${userId}-${Date.now()}`;
  const walletColumn = getWalletColumn(walletType);
  const pendingType = normalizeWalletType(walletType) === 'ppob' ? 'account_pending_ppob' : 'account_pending';

  try {
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

    const updateResult = await dbRunAsync(
      `UPDATE users SET ${walletColumn} = ${walletColumn} - ? WHERE user_id = ? AND ${walletColumn} >= ?`,
      [amount, userId, amount]
    );

    if (!updateResult || Number(updateResult.changes || 0) === 0) {
      throw new Error('SALDO_NOT_ENOUGH_OR_USER_NOT_FOUND');
    }

    await dbRunAsync(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [userId, amount, pendingType, referenceId, Date.now()]
    );

    await dbRunAsync('COMMIT');
    return { ok: true, referenceId };
  } catch (error) {
    try {
      await dbRunAsync('ROLLBACK');
    } catch (_) {}
    return { ok: false, error: error?.message || 'UNKNOWN' };
  }
}

async function finalizeReservedAccountCharge(referenceId, finalType) {
  try {
    const result = await dbRunAsync(
      'UPDATE transactions SET type = ? WHERE reference_id = ? AND type IN (?, ?)',
      [finalType, referenceId, 'account_pending', 'account_pending_ppob']
    );
    if (!result || Number(result.changes || 0) === 0) {
      throw new Error('PENDING_TRANSACTION_NOT_FOUND');
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'UNKNOWN' };
  }
}

async function cancelReservedAccountCharge(userId, amount, referenceId, walletType = 'vpn') {
  const walletColumn = getWalletColumn(walletType);
  try {
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    await dbRunAsync(`UPDATE users SET ${walletColumn} = ${walletColumn} + ? WHERE user_id = ?`, [amount, userId]);
    await dbRunAsync(
      'UPDATE transactions SET type = ? WHERE reference_id = ? AND type IN (?, ?)',
      ['account_canceled', referenceId, 'account_pending', 'account_pending_ppob']
    );
    await dbRunAsync('COMMIT');
    return { ok: true };
  } catch (error) {
    try {
      await dbRunAsync('ROLLBACK');
    } catch (_) {}
    return { ok: false, error: error?.message || 'UNKNOWN' };
  }
}

const PPOB_PAGE_SIZE = 8;
const PPOB_MENU_PAGE_SIZE = 10;
const PPOB_ADMIN_PAGE_SIZE = 10;
const HC_TEMPLATE_PAGE_SIZE = 10;
const DARK_TEMPLATE_PAGE_SIZE = 10;

function ppobButtonText(value, max = 44) {
  const text = String(value || '-').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getSafePage(page, totalItems, pageSize) {
  const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  return { safePage, totalPages, start: safePage * pageSize };
}

function buildPpobGridRows(items, buildButton, perRow = 2) {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = items
      .slice(i, i + perRow)
      .map((item, offset) => buildButton(item, i + offset))
      .filter(Boolean);
    if (row.length) rows.push(row);
  }
  return rows;
}

function ppobFormatProduct(product) {
  return [
    `<b>${escapeHtml(product.productName || product.buyerSkuCode)}</b>`,
    `SKU: <code>${escapeHtml(product.buyerSkuCode)}</code>`,
    `Kategori: ${escapeHtml(product.category || '-')}`,
    `Brand: ${escapeHtml(product.brand || '-')}`,
    `Type: ${escapeHtml(product.type || '-')}`,
    `Harga: <b>${escapeHtml(formatRupiah(product.price || 0))}</b>`
  ].join('\n');
}

function normalizeTelegramChatIdSetting(value) {
  const text = String(value || '').trim();
  if (/^(0|-|kosong|hapus|off)$/i.test(text)) return '';
  if (!/^-?\d{5,32}$/.test(text)) return null;
  return text;
}

function getPpobNotifGroupId() {
  const groupId = Number(String(PPOB_NOTIF_GROUP_ID || '').trim());
  return Number.isFinite(groupId) && groupId !== 0 ? groupId : null;
}

function getPpobAdminGroupId() {
  const groupId = Number(String(PPOB_ADMIN_GROUP_ID || '').trim());
  return Number.isFinite(groupId) && groupId !== 0 ? groupId : null;
}

function getPpobWarningGroupId() {
  return getPpobAdminGroupId() || getPpobNotifGroupId();
}

function formatTelegramActor(user = {}) {
  const username = user.username ? `@${user.username}` : '-';
  const fullName = `${user.first_name || ''}${user.last_name ? ` ${user.last_name}` : ''}`.trim() || '-';
  return { username, fullName };
}

function maskPpobCustomerNo(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const compact = text.replace(/\s+/g, '');
  if (compact.length <= 4) {
    return `${compact.slice(0, 1)}${'*'.repeat(Math.max(2, compact.length - 1))}`;
  }
  if (compact.length <= 8) {
    return `${compact.slice(0, 2)}${'*'.repeat(Math.max(3, compact.length - 4))}${compact.slice(-2)}`;
  }
  return `${compact.slice(0, 3)}${'*'.repeat(Math.max(4, compact.length - 6))}${compact.slice(-3)}`;
}

async function getDigiflazzBalanceSafe() {
  try {
    const context = await getEffectivePpobContext();
    const result = await ppobService.checkBalance(context.config);
    return {
      ok: true,
      balance: Number(result.balance || 0),
      payload: result.payload
    };
  } catch (err) {
    logger.warn(`Gagal cek saldo Digiflazz: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function warnLowDigiflazzBalanceIfNeeded(balance, context = '') {
  const threshold = Number(PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD || 0);
  const warningGroupId = getPpobWarningGroupId();
  if (!warningGroupId) return { sent: false, reason: 'Grup warning saldo belum diset.' };
  if (threshold <= 0) return { sent: false, reason: 'Warning saldo Digiflazz sedang nonaktif.' };
  if (!Number.isFinite(Number(balance))) return { sent: false, reason: 'Saldo Digiflazz tidak valid.' };
  if (Number(balance) >= threshold) return { sent: false, reason: 'Saldo masih di atas batas warning.' };

  const now = Date.now();
  const varsNow = loadVars();
  const lastWarnAt = Number(varsNow.PPOB_DIGIFLAZZ_LOW_BALANCE_LAST_WARN_AT || 0);
  const minIntervalMs = 30 * 60 * 1000;
  if (now - lastWarnAt < minIntervalMs) {
    const waitMinutes = Math.max(1, Math.ceil((minIntervalMs - (now - lastWarnAt)) / 60000));
    return { sent: false, reason: `Cooldown warning aktif. Coba lagi sekitar ${waitMinutes} menit.` };
  }

  const providerLabel = 'Digiflazz Sendiri';
  const text = [
    '<b>WARNING SALDO DIGIFLAZZ RENDAH</b>',
    '',
    `Provider: <b>${escapeHtml(providerLabel)}</b>`,
    `Saldo saat ini: <b>${formatRupiah(balance)}</b>`,
    `Batas warning: <b>${formatRupiah(threshold)}</b>`,
    context ? `Konteks: ${escapeHtml(context)}` : '',
    '',
    'Segera isi ulang saldo Digiflazz agar transaksi PPOB tidak gagal.'
  ].filter(Boolean).join('\n');

  try {
    const sent = await bot.telegram.sendMessage(warningGroupId, text, { parse_mode: 'HTML' });
    await bot.telegram.pinChatMessage(warningGroupId, sent.message_id, { disable_notification: false }).catch((pinErr) => {
      logger.warn(`Gagal pin warning saldo Digiflazz: ${pinErr.message}`);
    });
    savePpobRuntimeVars({
      PPOB_DIGIFLAZZ_LOW_BALANCE_LAST_WARN_AT: now,
      PPOB_DIGIFLAZZ_LOW_BALANCE_PINNED_MESSAGE_ID: sent.message_id
    });
    return { sent: true, groupId: warningGroupId, messageId: sent.message_id };
  } catch (err) {
    logger.warn(`Gagal kirim warning saldo Digiflazz: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

async function notifyPpobPurchaseGroups(ctx, orderRow, balanceResult) {
  const status = String(orderRow?.status || '-').toUpperCase();
  if (status !== 'SUCCESS') return;

  const generalGroupId = getPpobNotifGroupId();
  const adminGroupId = getPpobAdminGroupId();
  if (!generalGroupId && !adminGroupId) return;

  const actor = formatTelegramActor(ctx.from || {});
  const maskedCustomerNo = maskPpobCustomerNo(orderRow.customer_no || '');
  const generalText =
    '<b>🛒 PRODUK PPOB BERHASIL DIBELI</b>\n\n' +
    '<pre>Informasi\n' +
    `ID TELE PEMBELI : ${escapeHtml(ctx.from?.id || '-')}\n` +
    `USERNAME TELE   : ${escapeHtml(actor.username)}\n` +
    `PRODUK          : ${escapeHtml(orderRow.product_name || orderRow.buyer_sku_code || '-')}\n` +
    `KATEGORI        : ${escapeHtml(orderRow.category || '-')}\n` +
    `BRAND           : ${escapeHtml(orderRow.brand || '-')}\n` +
    `TUJUAN          : ${escapeHtml(maskedCustomerNo)}\n` +
    `HARGA           : ${escapeHtml(formatRupiah(orderRow.amount || 0))}\n` +
    `STATUS          : ${escapeHtml(status)}\n` +
    '</pre>';

  const basePrice = Number(orderRow.base_price || 0);
  const buyerPrice = Number(orderRow.amount || 0);
  const profit = Math.max(0, buyerPrice - basePrice);
  const adminText = [
    '<b>DETAIL TRANSAKSI PPOB</b>',
    '',
    `User ID: <code>${escapeHtml(ctx.from?.id || '-')}</code>`,
    `Username: <b>${escapeHtml(actor.username)}</b>`,
    `Nama: <b>${escapeHtml(actor.fullName)}</b>`,
    `Produk: <b>${escapeHtml(orderRow.product_name || orderRow.buyer_sku_code || '-')}</b>`,
    `SKU: <code>${escapeHtml(orderRow.buyer_sku_code || '-')}</code>`,
    `Kategori: ${escapeHtml(orderRow.category || '-')}`,
    `Brand: ${escapeHtml(orderRow.brand || '-')}`,
    `Type: ${escapeHtml(orderRow.product_type || '-')}`,
    `Tujuan: <code>${escapeHtml(maskedCustomerNo)}</code>`,
    `Harga buyer: <b>${formatRupiah(buyerPrice)}</b>`,
    `Harga Digiflazz: <b>${formatRupiah(basePrice)}</b>`,
    `Profit/fee: <b>${formatRupiah(profit)}</b>`,
    `Status: <b>${escapeHtml(status)}</b>`,
    orderRow.serial_number ? `SN: <code>${escapeHtml(orderRow.serial_number)}</code>` : '',
    orderRow.message ? `Pesan: ${escapeHtml(orderRow.message)}` : '',
    `Ref: <code>${escapeHtml(orderRow.ref_id || '-')}</code>`,
    balanceResult?.ok
      ? `Saldo Digiflazz: <b>${formatRupiah(balanceResult.balance)}</b>`
      : `Saldo Digiflazz: gagal dicek (${escapeHtml(balanceResult?.error || '-')})`,
    `Waktu: ${escapeHtml(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}`
  ].filter(Boolean).join('\n');

  if (generalGroupId) {
    await bot.telegram.sendMessage(generalGroupId, generalText, { parse_mode: 'HTML' }).catch((err) => {
      logger.warn(`Gagal kirim notif PPOB general: ${err.message}`);
    });
  }
  if (adminGroupId) {
    await bot.telegram.sendMessage(adminGroupId, adminText, { parse_mode: 'HTML' }).catch((err) => {
      logger.warn(`Gagal kirim notif PPOB admin: ${err.message}`);
    });
  }
}

async function notifyPpobTopupGroups(deposit, currentBalance, bonusAmount = 0) {
  if (normalizeWalletType(deposit?.walletType || 'vpn') !== 'ppob') return;
  const generalGroupId = getPpobNotifGroupId();
  const adminGroupId = getPpobAdminGroupId();
  if (!generalGroupId && !adminGroupId) return;

  const generalText =
    '<b>💰 TOPUP SALDO PPOB BERHASIL</b>\n\n' +
    '<pre>Informasi\n' +
    `ID TELE USER    : ${escapeHtml(deposit.userId || '-')}\n` +
    `NOMINAL         : ${escapeHtml(formatRupiah(deposit.originalAmount || 0))}\n` +
    `BONUS           : ${escapeHtml(formatRupiah(bonusAmount || 0))}\n` +
    `TOTAL MASUK     : ${escapeHtml(formatRupiah(Number(deposit.originalAmount || 0) + Number(bonusAmount || 0)))}\n` +
    `SALDO SEKARANG  : ${escapeHtml(formatRupiah(currentBalance || 0))}\n` +
    '</pre>';

  const adminText = [
    '<b>DETAIL TOPUP SALDO PPOB</b>',
    '',
    `User ID: <code>${escapeHtml(deposit.userId || '-')}</code>`,
    `Nominal topup: <b>${formatRupiah(deposit.originalAmount || 0)}</b>`,
    bonusAmount > 0 ? `Bonus: <b>${formatRupiah(bonusAmount)}</b>` : '',
    `Total masuk: <b>${formatRupiah(Number(deposit.originalAmount || 0) + Number(bonusAmount || 0))}</b>`,
    `Total bayar: <b>${formatRupiah(deposit.amount || 0)}</b>`,
    `Saldo PPOB sekarang: <b>${formatRupiah(currentBalance || 0)}</b>`,
    `Gateway: ${escapeHtml(deposit.gatewayProvider || '-')}`,
    `Ref: <code>${escapeHtml(deposit.referenceId || '-')}</code>`,
    `Waktu: ${escapeHtml(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}`
  ].filter(Boolean).join('\n');

  if (generalGroupId) {
    await bot.telegram.sendMessage(generalGroupId, generalText, { parse_mode: 'HTML' }).catch((err) => {
      logger.warn(`Gagal kirim notif topup PPOB general: ${err.message}`);
    });
  }
  if (adminGroupId) {
    await bot.telegram.sendMessage(adminGroupId, adminText, { parse_mode: 'HTML' }).catch((err) => {
      logger.warn(`Gagal kirim notif topup PPOB admin: ${err.message}`);
    });
  }
}

async function notifyVpnTopupGroups(deposit, currentBalance, bonusAmount = 0) {
  if (normalizeWalletType(deposit?.walletType || 'vpn') !== 'vpn') {
    logger.warn(`⚠️ [DEBUG] notifyVpnTopupGroups di-skip: walletType bukan vpn (${deposit?.walletType})`);
    return;
  }
  const generalGroupId = Number(String(GLOBAL_CREATE_NOTIF_GROUP_ID || '').trim());
  if (!generalGroupId) {
    logger.warn('⚠️ [DEBUG] notifyVpnTopupGroups di-skip: GLOBAL_CREATE_NOTIF_GROUP_ID kosong/null.');
    return;
  }

  const generalText =
    '<b>💰 TOPUP SALDO VPN BERHASIL</b>\n\n' +
    '<pre>' +
    `ID TELE USER    : ${escapeHtml(deposit.userId || '-')}\n` +
    `NOMINAL         : ${escapeHtml(formatRupiah(deposit.originalAmount || 0))}\n` +
    `BONUS           : ${escapeHtml(formatRupiah(bonusAmount || 0))}\n` +
    `TOTAL MASUK     : ${escapeHtml(formatRupiah(Number(deposit.originalAmount || 0) + Number(bonusAmount || 0)))}\n` +
    `SALDO SEKARANG  : ${escapeHtml(formatRupiah(currentBalance || 0))}\n` +
    '</pre>';

  await bot.telegram.sendMessage(generalGroupId, generalText, { parse_mode: 'HTML' }).catch((err) => {
    logger.warn(`Gagal kirim notif topup VPN group: ${err.message}`);
  });
}

function ppobSafeJsonParse(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (_) {
    return fallback;
  }
}

function mapPpobDbProduct(row = {}, markupFee = PPOB_MARKUP_FEE) {
  const buyerPrice = Number(row.buyer_price || 0);
  const calculatedPrice = typeof ppobService.calculatePrice === 'function'
    ? ppobService.calculatePrice(buyerPrice, markupFee)
    : buyerPrice;
  const price = calculatedPrice === null || calculatedPrice === undefined ? buyerPrice : calculatedPrice;
  return {
    buyerSkuCode: String(row.buyer_sku_code || '').trim(),
    productName: String(row.product_name || row.buyer_sku_code || '').trim(),
    category: String(row.category || 'Lainnya').trim() || 'Lainnya',
    brand: String(row.brand || 'Lainnya').trim() || 'Lainnya',
    type: String(row.product_type || 'Umum').trim() || 'Umum',
    buyerPrice,
    price,
    stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
    isActive: Number(row.is_active ?? 1) === 1,
    syncedAt: Number(row.synced_at || 0),
    raw: ppobSafeJsonParse(row.raw_json, {})
  };
}

async function ppobLoadCatalogFromDb(options = {}) {
  const includeInactive = !!options.includeInactive;
  const effectiveMarkup = PPOB_MARKUP_FEE;
  const rows = await dbAllAsync(
    `SELECT * FROM ppob_products
     ${includeInactive ? '' : 'WHERE is_active = 1'}
     ORDER BY category COLLATE NOCASE, brand COLLATE NOCASE, product_type COLLATE NOCASE, product_name COLLATE NOCASE`,
    []
  );
  return ppobBuildCatalog(rows.map((row) => mapPpobDbProduct(row, effectiveMarkup)).filter((product) => product.buyerSkuCode));
}

async function ppobGetProductStats() {
  const row = await dbGetAsync(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
       MAX(synced_at) AS last_sync
     FROM ppob_products`
  ).catch(() => null);
  return {
    total: Number(row?.total || 0),
    active: Number(row?.active || 0),
    lastSync: Number(row?.last_sync || 0)
  };
}

function formatPpobLastSync(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return 'Belum pernah sync';
  return new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

let ppobProductSyncInFlight = null;

async function performPpobProductsSync() {
  const context = await getEffectivePpobContext();
  const catalog = await ppobService.getCatalog(context.config, { forceRefresh: true });
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const syncedAt = Date.now();

  await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const product of products) {
      await dbRunAsync(
        `INSERT INTO ppob_products
         (buyer_sku_code, product_name, category, brand, product_type, buyer_price, stock,
          is_active, raw_json, synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(buyer_sku_code) DO UPDATE SET
           product_name = excluded.product_name,
           category = excluded.category,
           brand = excluded.brand,
           product_type = excluded.product_type,
           buyer_price = excluded.buyer_price,
           stock = excluded.stock,
           is_active = 1,
           raw_json = excluded.raw_json,
           synced_at = excluded.synced_at,
           updated_at = excluded.updated_at`,
        [
          product.buyerSkuCode,
          product.productName || product.buyerSkuCode,
          product.category || 'Lainnya',
          product.brand || 'Lainnya',
          product.type || 'Umum',
          Number(product.buyerPrice || 0),
          product.stock === null || product.stock === undefined ? null : Number(product.stock),
          JSON.stringify(product.raw || {}),
          syncedAt,
          syncedAt
        ]
      );
    }

    const inactiveResult = await dbRunAsync(
      'UPDATE ppob_products SET is_active = 0, updated_at = ? WHERE synced_at <> ? AND is_active = 1',
      [syncedAt, syncedAt]
    );
    await dbRunAsync('COMMIT');

    return {
      fetched: products.length,
      deactivated: Number(inactiveResult?.changes || 0),
      syncedAt
    };
  } catch (err) {
    await dbRunAsync('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function syncPpobProductsFromDigiflazz() {
  if (ppobProductSyncInFlight) return ppobProductSyncInFlight;
  const task = performPpobProductsSync();
  ppobProductSyncInFlight = task;
  try {
    return await task;
  } finally {
    if (ppobProductSyncInFlight === task) ppobProductSyncInFlight = null;
  }
}

async function ppobLoadCatalog(ctx) {
  if (!PPOB_ENABLED) throw new Error('Menu PPOB sedang nonaktif.');
  const rawCatalog = await ppobLoadCatalogFromDb();
  if (!rawCatalog.products.length) {
    throw new Error('Katalog PPOB belum disync admin. Buka Admin > Tools > PPOB > Sync Produk Digiflazz.');
  }
  const catalog = ppobApplyVisibilityFilter(rawCatalog);
  const state = userState[ctx.chat.id] || {};
  userState[ctx.chat.id] = {
    ...state,
    step: 'ppob_browse',
    ppobCatalog: catalog,
    ppobLoadedAt: Date.now()
  };
  return userState[ctx.chat.id];
}

async function ppobGetState(ctx) {
  const state = userState[ctx.chat.id];
  if (state?.ppobCatalog?.products?.length) return state;
  return ppobLoadCatalog(ctx);
}

async function sendPpobMenu(ctx, options = {}) {
  try {
    const state = await ppobLoadCatalog(ctx, !!options.forceRefresh);
    const products = state.ppobCatalog.products || [];
    const stats = await ppobGetProductStats();
    const cutoffStatus = getPpobCutoffStatus();
    const page = Number(options.page || 0);
    const categories = state.ppobCatalog.categories || [];
    const { safePage, totalPages, start } = getSafePage(page, categories.length, PPOB_MENU_PAGE_SIZE);
    const pageCategories = categories.slice(start, start + PPOB_MENU_PAGE_SIZE);
    const text = [
      '<b>🛒 PPOB DIGITAL</b>',
      '',
      '<b>INFORMASI LAYANAN</b>',
      `• Produk Aktif : <b>${products.length}</b>`,
      `• Status       : <b>${cutoffStatus.active ? 'Maintenance' : 'Normal'}</b>`,
      cutoffStatus.active ? `• Buka Lagi    : <b>${escapeHtml(cutoffStatus.end)} WIB</b>` : '',
      `• Update       : <b>${escapeHtml(formatPpobLastSync(stats.lastSync))}</b>`,
      '',
      '<b>KATEGORI PRODUK</b>',
      `Halaman <b>${safePage + 1}/${totalPages}</b>`,
      'Pilih kategori melalui tombol di bawah.'
    ].filter((line) => line !== '').join('\n');
    const rows = buildPpobGridRows(pageCategories, (category, index) => ({
      text: ppobButtonText(category),
      callback_data: `ppob_cat_${start + index}`
    }), 2);
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `ppob_cat_page_${safePage - 1}` });
    if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `ppob_cat_page_${safePage + 1}` });
    if (nav.length) rows.push(nav);
    rows.push([
      { text: '🔄 Muat Ulang Produk', callback_data: 'ppob_refresh' },
      { text: '📜 Riwayat', callback_data: 'ppob_history' }
    ]);
    rows.push([{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]);
    const payload = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
    }
    return ctx.reply(text, payload);
  } catch (err) {
    logger.error('Gagal membuka menu PPOB:', err.message);
    return ctx.reply(`PPOB belum siap: ${err.message}`);
  }
}

async function sendPpobBrands(ctx, categoryIndex, page = 0) {
  const state = await ppobGetState(ctx);
  const category = state.ppobCatalog.categories[Number(categoryIndex)];
  if (!category) return sendPpobMenu(ctx);
  const products = ppobService.filterProducts(state.ppobCatalog.products, { category });
  const brands = Array.from(new Set(products.map((product) => product.brand))).sort((a, b) => a.localeCompare(b, 'id-ID'));
  userState[ctx.chat.id] = { ...state, ppobCategory: category, ppobBrands: brands };
  const { safePage, totalPages, start } = getSafePage(page, brands.length, PPOB_MENU_PAGE_SIZE);
  const pageBrands = brands.slice(start, start + PPOB_MENU_PAGE_SIZE);
  const rows = buildPpobGridRows(pageBrands, (brand, index) => ({
    text: ppobButtonText(`${brand} (${products.filter((p) => p.brand === brand).length})`),
    callback_data: `ppob_brand_${start + index}`
  }), 2);
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `ppob_brand_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `ppob_brand_page_${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 Kategori', callback_data: 'ppob_menu' }]);
  await ctx.answerCbQuery().catch(() => {});
  return ctx.editMessageText(`<b>PPOB</b>\nKategori: <b>${escapeHtml(category)}</b>\nHalaman brand: <b>${safePage + 1}/${totalPages}</b>\n\nPilih brand.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  }).catch(() => ctx.reply('Pilih brand.', { reply_markup: { inline_keyboard: rows } }));
}

async function sendPpobTypes(ctx, brandIndex, page = 0) {
  const state = await ppobGetState(ctx);
  const brand = state.ppobBrands?.[Number(brandIndex)];
  if (!state.ppobCategory || !brand) return sendPpobMenu(ctx);
  const products = ppobService.filterProducts(state.ppobCatalog.products, {
    category: state.ppobCategory,
    brand
  });
  const types = Array.from(new Set(products.map((product) => product.type))).sort((a, b) => a.localeCompare(b, 'id-ID'));
  userState[ctx.chat.id] = { ...state, ppobBrand: brand, ppobTypes: types };
  const { safePage, totalPages, start } = getSafePage(page, types.length, PPOB_MENU_PAGE_SIZE);
  const pageTypes = types.slice(start, start + PPOB_MENU_PAGE_SIZE);
  const rows = buildPpobGridRows(pageTypes, (type, index) => ({
    text: ppobButtonText(`${type} (${products.filter((p) => p.type === type).length})`),
    callback_data: `ppob_type_${start + index}`
  }), 2);
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `ppob_type_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `ppob_type_page_${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 Brand', callback_data: `ppob_cat_${state.ppobCatalog.categories.indexOf(state.ppobCategory)}` }]);
  await ctx.answerCbQuery().catch(() => {});
  return ctx.editMessageText(
    `<b>PPOB</b>\nKategori: <b>${escapeHtml(state.ppobCategory)}</b>\nBrand: <b>${escapeHtml(brand)}</b>\nHalaman type: <b>${safePage + 1}/${totalPages}</b>\n\nPilih type.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
  ).catch(() => ctx.reply('Pilih type.', { reply_markup: { inline_keyboard: rows } }));
}

async function sendPpobProducts(ctx, typeIndexOrPage, maybePage = 0) {
  const state = await ppobGetState(ctx);
  let type = state.ppobType;
  let page = Number(maybePage || 0);
  if (typeIndexOrPage !== null && typeIndexOrPage !== undefined && String(typeIndexOrPage) !== 'page') {
    type = state.ppobTypes?.[Number(typeIndexOrPage)];
    page = 0;
  }
  if (!state.ppobCategory || !state.ppobBrand || !type) return sendPpobMenu(ctx);
  const products = ppobService.filterProducts(state.ppobCatalog.products, {
    category: state.ppobCategory,
    brand: state.ppobBrand,
    type
  }).sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  const totalPages = Math.max(1, Math.ceil(products.length / PPOB_PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const pageProducts = products.slice(page * PPOB_PAGE_SIZE, (page + 1) * PPOB_PAGE_SIZE);
  const start = page * PPOB_PAGE_SIZE;
  userState[ctx.chat.id] = {
    ...state,
    ppobType: type,
    ppobProducts: products,
    ppobPageProducts: pageProducts,
    step: 'ppob_product_select',
    ppobPage: page
  };
  const lines = [
    '<b>PPOB Produk</b>',
    `${escapeHtml(state.ppobCategory)} / ${escapeHtml(state.ppobBrand)} / ${escapeHtml(type)}`,
    `Halaman <b>${page + 1}/${totalPages}</b>`,
    '',
    pageProducts.length
      ? pageProducts.map((product, index) => (
          `${index + 1}. <b>${escapeHtml(product.productName || product.buyerSkuCode)}</b>\n` +
          `   SKU: <code>${escapeHtml(product.buyerSkuCode)}</code>\n` +
          `   Harga: <b>${formatRupiah(product.price || 0)}</b>`
        )).join('\n\n')
      : 'Belum ada produk.',
    '',
    pageProducts.length
      ? 'Pilih produk lewat tombol di bawah.'
      : 'Pilih type lain atau hubungi admin.'
  ];
  const rows = [];
  const productRows = buildPpobGridRows(pageProducts, (product, index) => ({
    text: String(index + 1),
    callback_data: `ppob_product_${start + index}`
  }), 3);
  if (productRows.length) rows.push(...productRows);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ppob_page_${page - 1}` });
  if (page < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `ppob_page_${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 Type', callback_data: `ppob_brand_${state.ppobBrands.indexOf(state.ppobBrand)}` }]);
  await ctx.answerCbQuery().catch(() => {});
  return ctx.editMessageText(
    lines.join('\n'),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
  ).catch(() => ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }));
}

function buildPpobCustomerNoKeyboard(draft, page = 0) {
  return [
    [
      { text: '1', callback_data: 'ppob_no_1' },
      { text: '2', callback_data: 'ppob_no_2' },
      { text: '3', callback_data: 'ppob_no_3' }
    ],
    [
      { text: '4', callback_data: 'ppob_no_4' },
      { text: '5', callback_data: 'ppob_no_5' },
      { text: '6', callback_data: 'ppob_no_6' }
    ],
    [
      { text: '7', callback_data: 'ppob_no_7' },
      { text: '8', callback_data: 'ppob_no_8' },
      { text: '9', callback_data: 'ppob_no_9' }
    ],
    [
      { text: 'Reset', callback_data: 'ppob_no_clear' },
      { text: '0', callback_data: 'ppob_no_0' },
      { text: 'Hapus', callback_data: 'ppob_no_del' }
    ],
    [{ text: draft ? `Lanjut: ${String(draft).slice(-18)}` : 'Lanjut', callback_data: 'ppob_no_ok' }],
    [{ text: '🔙 Produk', callback_data: `ppob_page_${page || 0}` }]
  ];
}

function getPpobProductSearchText(product) {
  return [
    product?.category,
    product?.brand,
    product?.type,
    product?.productName,
    product?.buyerSkuCode
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getPpobCustomerNoKind(product) {
  const text = getPpobProductSearchText(product);
  if (/(pln|listrik|token listrik)/i.test(text)) return 'pln';
  if (/(pdam|air\s+minum)/i.test(text)) return 'pdam';
  if (/(bpjs|kesehatan)/i.test(text)) return 'bpjs';
  if (/(e-?wallet|dompet digital|dana|ovo|gopay|go pay|shopee\s*pay|linkaja|isaku|sakuku)/i.test(text)) return 'phone';
  if (/(pulsa|paket data|\bdata\b|kuota|sms|telepon)/i.test(text)) return 'phone';
  if (/(indihome|telkom|wifi|internet rumah|tv kabel|first media|biznet|myrepublic|mnc|iconnet)/i.test(text)) return 'numeric_id';
  return 'generic';
}

function ppobNeedsPhoneNumber(product) {
  return getPpobCustomerNoKind(product) === 'phone';
}

function normalizePpobCustomerNo(value, product) {
  let text = String(value || '').trim();
  if (!text) return '';

  const kind = getPpobCustomerNoKind(product);

  if (kind === 'phone') {
    text = text.replace(/[\s().-]/g, '');
    if (text.startsWith('+62')) text = `0${text.slice(3)}`;
    else if (text.startsWith('62')) text = `0${text.slice(2)}`;
    if (!/^08\d{8,11}$/.test(text)) return '';
    return text;
  }

  if (kind === 'pln') {
    text = text.replace(/\D/g, '');
    if (!/^\d{10,13}$/.test(text)) return '';
    return text;
  }

  if (kind === 'pdam' || kind === 'bpjs' || kind === 'numeric_id') {
    text = text.replace(/\D/g, '');
    if (!/^\d{5,25}$/.test(text)) return '';
    return text;
  }

  text = text.replace(/\s+/g, ' ');
  if (text.length < 3 || text.length > 64) return '';
  if (!/^[a-zA-Z0-9._()+\/\- ]+$/.test(text)) return '';
  return text.trim();
}

function getPpobCustomerNoInstruction(product) {
  const kind = getPpobCustomerNoKind(product);
  if (kind === 'phone') {
    return 'Produk ini membutuhkan nomor HP. Kirim angka dengan awalan 08, contoh: 089123456789.';
  }
  if (kind === 'pln') {
    return 'Produk PLN membutuhkan ID pelanggan / nomor meter. Kirim angka saja, contoh: 12345678901.';
  }
  if (kind === 'pdam') {
    return 'Produk PDAM membutuhkan ID pelanggan air. Kirim angka sesuai tagihan PDAM.';
  }
  if (kind === 'bpjs') {
    return 'Produk BPJS membutuhkan nomor VA / nomor peserta. Kirim angka saja sesuai tagihan BPJS.';
  }
  if (kind === 'numeric_id') {
    return 'Produk ini membutuhkan ID pelanggan. Kirim angka saja sesuai tagihan layanan.';
  }
  return 'Produk ini membutuhkan nomor tujuan / ID pelanggan. Kirim ID sesuai tagihan atau layanan yang dipilih.';
}

function getPpobCustomerNoInvalidText(product) {
  const kind = getPpobCustomerNoKind(product);
  if (kind === 'phone') {
    return 'Nomor HP tidak valid. Gunakan angka 10-13 digit dan harus diawali 08. Contoh: 089123456789. Format 62/+62 akan otomatis diubah ke 08.';
  }
  if (kind === 'pln') {
    return 'ID pelanggan / nomor meter PLN tidak valid. Kirim angka 10-13 digit, contoh: 12345678901.';
  }
  if (kind === 'pdam') {
    return 'ID pelanggan PDAM tidak valid. Kirim angka 5-25 digit sesuai tagihan PDAM.';
  }
  if (kind === 'bpjs') {
    return 'Nomor VA / peserta BPJS tidak valid. Kirim angka 5-25 digit sesuai tagihan BPJS.';
  }
  if (kind === 'numeric_id') {
    return 'ID pelanggan tidak valid. Kirim angka 5-25 digit sesuai tagihan layanan.';
  }
  return 'ID pelanggan tidak valid. Gunakan 3-64 karakter, boleh angka/huruf dan tanda . _ ( ) + / -.';
}

function formatPpobCustomerNoInputText(product, draft = '', errorText = '') {
  return [
    ppobFormatProduct(product),
    '',
    '<b>Nomor tujuan / ID pelanggan</b>',
    `<code>${escapeHtml(draft || '-')}</code>`,
    '',
    errorText ? `<b>${escapeHtml(errorText)}</b>` : '',
    errorText ? '' : '',
    getPpobCustomerNoInstruction(product)
  ].filter((line) => line !== '').join('\n');
}

async function sendPpobCustomerNoInput(ctx, product, draft = '', errorText = '') {
  const state = await ppobGetState(ctx);
  const text = formatPpobCustomerNoInputText(product, draft, errorText);
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Produk', callback_data: `ppob_page_${state.ppobPage || 0}` }],
        [{ text: '❌ Batal', callback_data: 'ppob_cancel' }]
      ]
    }
  };
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

async function sendPpobPurchaseConfirmation(ctx, customerNo) {
  const state = userState[ctx.chat.id] || {};
  const product = state.ppobSelectedProduct;
  if (!product) {
    delete userState[ctx.chat.id];
    return ctx.reply('Sesi PPOB tidak valid. Ulangi dari menu PPOB.');
  }

  userState[ctx.chat.id] = {
    ...state,
    step: 'ppob_confirm',
    ppobCustomerNo: customerNo
  };

  const row = await dbGetAsync('SELECT saldo_ppob FROM users WHERE user_id = ?', [ctx.from.id]).catch(() => null);
  const saldo = Number(row?.saldo_ppob || 0);
  const textConfirm = [
    '<b>KONFIRMASI PPOB</b>',
    '',
    ppobFormatProduct(product),
    '',
    `Tujuan: <code>${escapeHtml(customerNo)}</code>`,
    `Saldo PPOB kamu: <b>${formatRupiah(saldo)}</b>`,
    '',
    saldo < Number(product.price || 0)
      ? '<b>Saldo tidak cukup. TopUp dulu untuk melanjutkan.</b>'
      : 'Tekan tombol konfirmasi untuk membeli.'
  ].join('\n');

  const keyboard = saldo < Number(product.price || 0)
    ? [
        [{ text: '💰 TopUp Saldo PPOB', callback_data: 'topup_wallet_ppob' }],
        [{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]
      ]
    : [
        [{ text: '✅ Beli Sekarang', callback_data: 'ppob_confirm' }],
        [{ text: '❌ Batal', callback_data: 'ppob_cancel' }]
      ];

  const payload = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(textConfirm, payload).catch(() => ctx.reply(textConfirm, payload));
  }
  return ctx.reply(textConfirm, payload);
}

async function sendPpobProductDetailForProduct(ctx, product) {
  const state = await ppobGetState(ctx);
  if (!product) return sendPpobMenu(ctx);
  userState[ctx.chat.id] = {
    ...state,
    step: 'ppob_customer_no',
    ppobSelectedProduct: product,
    ppobCustomerNoDraft: ''
  };
  return sendPpobCustomerNoInput(ctx, product, '');
}

async function sendPpobProductDetail(ctx, productIndex) {
  const state = await ppobGetState(ctx);
  const product = state.ppobProducts?.[Number(productIndex)];
  return sendPpobProductDetailForProduct(ctx, product);
}

async function sendPpobHistory(ctx) {
  const rows = await dbAllAsync(
    'SELECT * FROM ppob_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
    [ctx.from.id]
  ).catch(() => []);
  if (!rows.length) {
    return ctx.reply('Belum ada riwayat PPOB.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]] }
    });
  }
  const lines = ['<b>RIWAYAT PPOB</b>', ''];
  const buttons = [];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${escapeHtml(row.product_name || row.buyer_sku_code)} - ${escapeHtml(row.status)} - ${formatRupiah(row.amount)}`);
    lines.push(`   Tujuan: <code>${escapeHtml(row.customer_no)}</code>`);
    if (['PROCESS', 'PENDING'].includes(String(row.status || '').toUpperCase())) {
      buttons.push([{ text: `Cek ${index + 1}`, callback_data: `ppob_check_${row.id}` }]);
    }
  });
  buttons.push([{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]);
  const payload = { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(lines.join('\n'), payload).catch(() => ctx.reply(lines.join('\n'), payload));
  }
  return ctx.reply(lines.join('\n'), payload);
}

async function sendPpobAdminMenu(ctx) {
  reloadRuntimePaymentConfig();
  const stats = await ppobGetProductStats();
  const cutoffStatus = getPpobCutoffStatus();
  const text = [
    '<b>PENGELOLA PPOB</b>',
    '',
    `Status Menu: <b>${PPOB_ENABLED ? 'Aktif' : 'Nonaktif'}</b>`,
    'Sumber Produk: <b>Digiflazz Sendiri</b>',
    `Digiflazz Username: <code>${escapeHtml(DIGIFLAZZ_USERNAME || '-')}</code>`,
    `Digiflazz API Key: <code>${escapeHtml(maskSecret(DIGIFLAZZ_API_KEY))}</code>`,
    `Base URL: <code>${escapeHtml(DIGIFLAZZ_BASE_URL || '-')}</code>`,
    `Warning Saldo Digi: <b>${formatRupiah(PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD)}</b>`,
    `Fee/Markup: <b>${formatRupiah(PPOB_MARKUP_FEE)}</b>`,
    `Grup Notif PPOB: <code>${escapeHtml(PPOB_NOTIF_GROUP_ID || '-')}</code>`,
    `Grup Admin PPOB: <code>${escapeHtml(PPOB_ADMIN_GROUP_ID || '-')}</code>`,
    `Grup Warning Saldo: <code>${escapeHtml(PPOB_ADMIN_GROUP_ID || PPOB_NOTIF_GROUP_ID || '-')}</code>`,
    `Cut Off PPOB: <b>${PPOB_CUTOFF_ENABLED ? 'Aktif' : 'Nonaktif'}</b> (${escapeHtml(cutoffStatus.start)}-${escapeHtml(cutoffStatus.end)} WIB)`,
    `Auto Sync Produk: <b>${PPOB_AUTOSYNC_ENABLED ? 'Aktif' : 'Nonaktif'}</b> (${escapeHtml(PPOB_AUTOSYNC_TIME)} WIB)`,
    `Status Sekarang: <b>${cutoffStatus.active ? 'Maintenance' : 'Normal'}</b>`,
    `IP VPS Production: <code>202.74.74.124</code>`,
    '',
    '<b>Katalog DB</b>',
    `Produk aktif DB: <b>${stats.active}</b>`,
    `Total tersimpan: <b>${stats.total}</b>`,
    `Sync terakhir: <b>${escapeHtml(formatPpobLastSync(stats.lastSync))}</b>`,
    '',
    '<b>Filter nonaktif</b>',
    `Kategori: ${PPOB_DISABLED_CATEGORIES.length}`,
    `Brand: ${PPOB_DISABLED_BRANDS.length}`,
    `Type: ${PPOB_DISABLED_TYPES.length}`,
    `Produk/SKU: ${PPOB_DISABLED_SKUS.length}`,
    '',
    '<b>Catatan Digiflazz</b>',
    'Untuk PPOB production, pastikan IP VPS bot <code>202.74.74.124</code> sudah dimasukkan ke whitelist IP production Digiflazz.',
    '',
    'User membaca katalog dari database. Digiflazz price-list dipanggil saat sync manual admin atau auto sync harian.'
  ].join('\n');

  const keyboard = [
    [{ text: PPOB_ENABLED ? 'Nonaktifkan Menu PPOB' : 'Aktifkan Menu PPOB', callback_data: 'ppob_admin_toggle_enabled' }],
    [
      { text: 'Set Username', callback_data: 'ppob_admin_set_username' },
      { text: 'Set API Key', callback_data: 'ppob_admin_set_api_key' }
    ],
    [
      { text: 'Set Base URL', callback_data: 'ppob_admin_set_base_url' },
      { text: 'Set Fee PPOB', callback_data: 'ppob_admin_set_fee' }
    ],
    [
      { text: 'Set Grup Notif', callback_data: 'ppob_admin_set_notif_group' },
      { text: 'Set Grup Admin', callback_data: 'ppob_admin_set_admin_group' }
    ],
    [
      { text: 'Set Warning Saldo Digi', callback_data: 'ppob_admin_set_digi_threshold' },
      { text: 'Cek Saldo Digi', callback_data: 'ppob_admin_check_digi_balance' }
    ],
    [
      { text: PPOB_CUTOFF_ENABLED ? 'Nonaktifkan Cut Off' : 'Aktifkan Cut Off', callback_data: 'ppob_admin_toggle_cutoff' },
      { text: 'Set Jam Cut Off', callback_data: 'ppob_admin_set_cutoff' }
    ],
    [
      { text: PPOB_AUTOSYNC_ENABLED ? 'Nonaktifkan Auto Sync' : 'Aktifkan Auto Sync', callback_data: 'ppob_admin_toggle_autosync' },
      { text: 'Set Jam Auto Sync', callback_data: 'ppob_admin_set_autosync_time' }
    ],
    [{ text: 'Saldo User PPOB', callback_data: 'ppob_admin_balance_menu' }],
    [{ text: 'Sync Produk Digiflazz', callback_data: 'ppob_admin_refresh_catalog' }],
    [
      { text: 'Kategori', callback_data: 'ppob_admin_list_category' },
      { text: 'Brand', callback_data: 'ppob_admin_list_brand' }
    ],
    [
      { text: 'Type', callback_data: 'ppob_admin_list_type' },
      { text: 'Produk/SKU', callback_data: 'ppob_admin_list_sku' }
    ],
    [{ text: 'Reset Filter Nonaktif', callback_data: 'ppob_admin_clear_filters' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  const payload = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function parsePpobAdminAmountInput(value, { allowZero = false } = {}) {
  const amountText = String(value || '').replace(/[^\d]/g, '');
  if (!amountText) return null;
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount)) return null;
  if (allowZero ? amount < 0 : amount <= 0) return null;
  return amount;
}

function normalizePpobAdminUserIdInput(value) {
  const text = String(value || '').trim();
  return /^\d{5,20}$/.test(text) ? text : '';
}

async function getPpobUserBalanceRow(userId) {
  return dbGetAsync('SELECT user_id, saldo, saldo_ppob FROM users WHERE user_id = ?', [userId]);
}

async function adjustPpobUserBalance({ targetUserId, amount, mode, adminId }) {
  const timestamp = Date.now();
  const referenceId = `ppob_admin_${mode}_${targetUserId}_${timestamp}`;

  await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (mode === 'add' || mode === 'set') {
      await dbRunAsync('INSERT OR IGNORE INTO users (user_id) VALUES (?)', [targetUserId]);
    }

    const row = await dbGetAsync('SELECT saldo_ppob FROM users WHERE user_id = ?', [targetUserId]);
    if (!row) throw new Error('USER_NOT_FOUND');

    const previous = Number(row.saldo_ppob || 0);
    let next = previous;
    let logAmount = amount;
    let type = 'ppob_admin_add';

    if (mode === 'add') {
      next = previous + amount;
    } else if (mode === 'remove') {
      if (amount > previous) throw new Error('INSUFFICIENT_PPOB_BALANCE');
      next = previous - amount;
      type = 'ppob_admin_remove';
    } else if (mode === 'set') {
      next = amount;
      logAmount = next - previous;
      type = 'ppob_admin_set';
    } else {
      throw new Error('UNKNOWN_PPOB_BALANCE_MODE');
    }

    await dbRunAsync('UPDATE users SET saldo_ppob = ? WHERE user_id = ?', [next, targetUserId]);
    await dbRunAsync(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [targetUserId, logAmount, type, referenceId, timestamp]
    );
    await dbRunAsync('COMMIT');

    logger.info(`Admin ${adminId} ${mode} saldo PPOB user ${targetUserId}: ${previous} -> ${next}`);
    return { previous, next, amount, referenceId, type };
  } catch (err) {
    await dbRunAsync('ROLLBACK').catch(() => {});
    throw err;
  }
}

function formatPpobBalanceActionText({ title, targetUserId, previous, amount, next, mode }) {
  const amountLabel = mode === 'set' ? 'Saldo diset' : (mode === 'remove' ? 'Saldo dihapus' : 'Saldo ditambah');
  return [
    `<b>${escapeHtml(title)}</b>`,
    '',
    `User ID: <code>${escapeHtml(targetUserId)}</code>`,
    `Saldo sebelumnya: <b>${formatRupiah(previous)}</b>`,
    `${amountLabel}: <b>${formatRupiah(amount)}</b>`,
    `Saldo sekarang: <b>${formatRupiah(next)}</b>`
  ].join('\n');
}

async function sendPpobAdminBalanceMenu(ctx) {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const text = [
    '<b>SALDO USER PPOB</b>',
    '',
    'Kelola saldo PPOB user berdasarkan ID Telegram.',
    'Saldo ini terpisah dari saldo VPN dan dipakai khusus pembelian PPOB.'
  ].join('\n');
  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Tambah Saldo', callback_data: 'ppob_admin_balance_add' },
          { text: 'Hapus Saldo', callback_data: 'ppob_admin_balance_remove' }
        ],
        [
          { text: 'Set Saldo', callback_data: 'ppob_admin_balance_set' },
          { text: 'Cek Saldo', callback_data: 'ppob_admin_balance_check' }
        ],
        [{ text: 'Riwayat Saldo', callback_data: 'ppob_admin_balance_history' }],
        [{ text: 'Kembali', callback_data: 'ppob_admin_menu' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function getPpobAdminKindLabel(kind) {
  switch (kind) {
    case 'category':
      return 'Kategori';
    case 'brand':
      return 'Brand';
    case 'type':
      return 'Type';
    case 'sku':
      return 'Produk/SKU';
    default:
      return 'Item';
  }
}

function getPpobAdminItems(catalog, kind) {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  if (kind === 'category') {
    return (catalog.categories || []).map((value) => ({
      value,
      label: value,
      count: products.filter((product) => product.category === value).length
    }));
  }
  if (kind === 'brand') {
    return (catalog.brands || []).map((value) => ({
      value,
      label: value,
      count: products.filter((product) => product.brand === value).length
    }));
  }
  if (kind === 'type') {
    return (catalog.types || []).map((value) => ({
      value,
      label: value,
      count: products.filter((product) => product.type === value).length
    }));
  }
  if (kind === 'sku') {
    return products
      .slice()
      .sort((a, b) => String(a.productName || '').localeCompare(String(b.productName || ''), 'id-ID'))
      .map((product) => ({
        value: product.buyerSkuCode,
        label: `${product.productName || product.buyerSkuCode} (${product.buyerSkuCode})`,
        count: 1,
        price: product.price
      }));
  }
  return [];
}

async function sendPpobAdminDimensionMenu(ctx, kind, page = 0, options = {}) {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  try {
    const catalog = await ppobLoadCatalogFromDb();
    const items = getPpobAdminItems(catalog, kind);
    const totalPages = Math.max(1, Math.ceil(items.length / PPOB_ADMIN_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
    const start = safePage * PPOB_ADMIN_PAGE_SIZE;
    const pageItems = items.slice(start, start + PPOB_ADMIN_PAGE_SIZE);
    const disabledValues = getPpobDisabledValues(kind);
    const kindLabel = getPpobAdminKindLabel(kind);

    userState[ctx.chat.id] = {
      ...(userState[ctx.chat.id] || {}),
      step: 'ppob_admin_dimension',
      ppobAdminKind: kind,
      ppobAdminItems: items,
      ppobAdminPage: safePage
    };

    const lines = [
      `<b>PPOB ${escapeHtml(kindLabel.toUpperCase())}</b>`,
      '',
      `Total: <b>${items.length}</b>`,
      `Halaman: <b>${safePage + 1}/${totalPages}</b>`,
      '',
      pageItems.length
        ? pageItems.map((item, idx) => {
            const disabled = ppobDisabledListHas(disabledValues, item.value);
            const number = start + idx + 1;
            const status = disabled ? 'Nonaktif' : 'Aktif';
            const suffix = kind === 'sku'
              ? ` - ${formatRupiah(item.price || 0)}`
              : ` - ${item.count} produk`;
            return `${number}. <b>${status}</b> - ${escapeHtml(item.label)}${escapeHtml(suffix)}`;
          }).join('\n')
        : 'Belum ada data.'
    ];

    const keyboard = pageItems.map((item, idx) => {
      const globalIndex = start + idx;
      const disabled = ppobDisabledListHas(disabledValues, item.value);
      return [{
        text: `${disabled ? 'Aktifkan' : 'Nonaktifkan'} ${globalIndex + 1}`,
        callback_data: `ppob_admin_toggle_${kind}_${globalIndex}`
      }];
    });

    const nav = [];
    if (safePage > 0) nav.push({ text: 'Prev', callback_data: `ppob_admin_page_${kind}_${safePage - 1}` });
    if (safePage < totalPages - 1) nav.push({ text: 'Next', callback_data: `ppob_admin_page_${kind}_${safePage + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: 'Muat Ulang DB', callback_data: `ppob_admin_refresh_${kind}_${safePage}` }]);
    keyboard.push([{ text: 'Kembali', callback_data: 'ppob_admin_menu' }]);

    const payload = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.editMessageText(lines.join('\n'), payload).catch(() => ctx.reply(lines.join('\n'), payload));
    }
    return ctx.reply(lines.join('\n'), payload);
  } catch (err) {
    logger.error('Gagal membuka pengelola PPOB:', err.message);
    await ctx.answerCbQuery().catch(() => {});
    return ctx.reply(`Katalog PPOB belum bisa dibaca: ${err.message}`);
  }
}

async function savePpobOrder(row) {
  await dbRunAsync(
    `INSERT INTO ppob_orders
     (user_id, ref_id, buyer_sku_code, product_name, category, brand, product_type, customer_no,
      amount, base_price, status, message, serial_number, raw_response, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.userId,
      row.refId,
      row.buyerSkuCode,
      row.productName || row.buyerSkuCode,
      row.category || '',
      row.brand || '',
      row.type || '',
      row.customerNo,
      row.amount,
      row.basePrice || 0,
      row.status || 'PENDING',
      row.message || '',
      row.serialNumber || '',
      row.rawResponse ? JSON.stringify(row.rawResponse) : '',
      Date.now(),
      Date.now()
    ]
  );
}

async function updatePpobOrderByRef(refId, patch) {
  await dbRunAsync(
    `UPDATE ppob_orders
     SET status = ?, message = ?, serial_number = ?, raw_response = ?, updated_at = ?
     WHERE ref_id = ?`,
    [
      patch.status,
      patch.message || '',
      patch.serialNumber || '',
      patch.rawResponse ? JSON.stringify(patch.rawResponse) : '',
      Date.now(),
      refId
    ]
  );
}

async function markPpobOrderRefunded(refId, reason) {
  await dbRunAsync(
    'UPDATE ppob_orders SET status = ?, message = ?, updated_at = ? WHERE ref_id = ?',
    ['REFUNDED', reason || 'Transaksi gagal, saldo dikembalikan.', Date.now(), refId]
  );
}

async function refundPpobOrder(row, reason) {
  await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
  try {
    await dbRunAsync('UPDATE users SET saldo_ppob = saldo_ppob + ? WHERE user_id = ?', [row.amount, row.user_id]);
    await dbRunAsync(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [row.user_id, row.amount, 'ppob_refund', `${row.ref_id}-refund`, Date.now()]
    );
    await dbRunAsync(
      'UPDATE ppob_orders SET status = ?, message = ?, updated_at = ? WHERE id = ?',
      ['REFUNDED', reason || 'Transaksi gagal, saldo dikembalikan.', Date.now(), row.id]
    );
    await dbRunAsync('COMMIT');
  } catch (err) {
    await dbRunAsync('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function executePpobOrder(row) {
  const context = await getEffectivePpobContext();
  const result = await ppobService.createTransaction(context.config, {
    buyerSkuCode: row.buyer_sku_code,
    customerNo: row.customer_no,
    refId: row.ref_id,
    maxPrice: row.base_price || row.amount
  });
  await updatePpobOrderByRef(row.ref_id, {
    status: result.status,
    message: result.message,
    serialNumber: result.serialNumber,
    rawResponse: result.payload
  });
  return result;
}

async function confirmPpobPurchase(ctx) {
  const state = userState[ctx.chat.id];
  const product = state?.ppobSelectedProduct;
  const customerNo = normalizePpobCustomerNo(state?.ppobCustomerNo, product);
  if (!product || !customerNo) {
    delete userState[ctx.chat.id];
    return ctx.reply('Sesi PPOB tidak valid. Silakan ulangi dari menu PPOB.');
  }

  const cutoffStatus = getPpobCutoffStatus();
  if (cutoffStatus.active) {
    return ctx.reply(formatPpobCutoffNotice(cutoffStatus), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]] }
    });
  }

  let providerContext;
  try {
    providerContext = await getEffectivePpobContext();
  } catch (error) {
    return ctx.reply(`Transaksi belum dapat diproses: ${error.message}`);
  }

  const amount = Number(ppobService.calculatePrice(product.buyerPrice, providerContext.markupFee) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply('Harga produk tidak valid. Silakan refresh produk.');
  }

  const reserve = await reserveAccountChargeAtomic(ctx.from.id, amount, 'ppob', 'purchase', 'ppob');
  if (!reserve.ok) {
    return ctx.reply(
      `Saldo PPOB tidak cukup untuk membeli produk ini.\n\nHarga: ${formatRupiah(amount)}`,
      { reply_markup: { inline_keyboard: [[{ text: 'TopUp Saldo PPOB', callback_data: 'topup_wallet_ppob' }], [{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]] } }
    );
  }

  try {
    await savePpobOrder({
      userId: ctx.from.id,
      refId: reserve.referenceId,
      buyerSkuCode: product.buyerSkuCode,
      productName: product.productName,
      category: product.category,
      brand: product.brand,
      type: product.type,
      customerNo,
      amount,
      basePrice: product.buyerPrice,
      status: 'PENDING'
    });
  } catch (error) {
    await cancelReservedAccountCharge(ctx.from.id, amount, reserve.referenceId, 'ppob').catch(() => {});
    return ctx.reply(`Transaksi dibatalkan karena order gagal disimpan: ${error.message}`);
  }

  delete userState[ctx.chat.id];
  await ctx.reply('Pembayaran saldo berhasil. Memproses transaksi ke Digiflazz...');

  let orderRow = await dbGetAsync('SELECT * FROM ppob_orders WHERE ref_id = ?', [reserve.referenceId]);
  try {
    const result = await executePpobOrder(orderRow);
    orderRow = await dbGetAsync('SELECT * FROM ppob_orders WHERE ref_id = ?', [reserve.referenceId]);

    if (result.status === 'FAILED') {
      await cancelReservedAccountCharge(ctx.from.id, amount, reserve.referenceId, 'ppob').catch(() => {});
      await markPpobOrderRefunded(reserve.referenceId, result.message || 'Transaksi gagal, saldo dikembalikan.').catch(() => {});
    } else {
      await finalizeReservedAccountCharge(reserve.referenceId, result.status === 'SUCCESS' ? 'ppob_success' : 'ppob_process');
    }

    const finalRow = await dbGetAsync('SELECT * FROM ppob_orders WHERE ref_id = ?', [reserve.referenceId]);
    const balanceResult = await getDigiflazzBalanceSafe();
    await notifyPpobPurchaseGroups(ctx, finalRow, balanceResult);
    if (balanceResult.ok) {
      await warnLowDigiflazzBalanceIfNeeded(balanceResult.balance, `Transaksi PPOB ${finalRow.ref_id || '-'}`);
    }
    const text = [
      '<b>TRANSAKSI PPOB</b>',
      '',
      `Produk: <b>${escapeHtml(product.productName)}</b>`,
      `Tujuan: <code>${escapeHtml(customerNo)}</code>`,
      `Harga: <b>${formatRupiah(amount)}</b>`,
      `Status: <b>${escapeHtml(finalRow.status)}</b>`,
      finalRow.serial_number ? `SN: <code>${escapeHtml(finalRow.serial_number)}</code>` : '',
      finalRow.message ? `Pesan: ${escapeHtml(finalRow.message)}` : '',
      `Ref: <code>${escapeHtml(reserve.referenceId)}</code>`
    ].filter(Boolean).join('\n');
    return ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ['PROCESS', 'PENDING'].includes(String(finalRow.status || '').toUpperCase())
            ? [{ text: 'Cek Status', callback_data: `ppob_check_${finalRow.id}` }]
            : [],
          [{ text: '📜 Riwayat', callback_data: 'ppob_history' }],
          [{ text: '🔙 Menu PPOB', callback_data: 'ppob_menu' }]
        ].filter((row) => row.length)
      }
    });
  } catch (err) {
    logger.error('Gagal proses PPOB:', err.message);
    const latest = await dbGetAsync('SELECT * FROM ppob_orders WHERE ref_id = ?', [reserve.referenceId]).catch(() => null);
    const latestStatus = String(latest?.status || 'PENDING').toUpperCase();
    if (latestStatus === 'PENDING') {
      await updatePpobOrderByRef(reserve.referenceId, {
        status: 'PENDING',
        message: `Status belum dapat dipastikan: ${err.message}`,
        serialNumber: latest?.serial_number || '',
        rawResponse: latest?.raw_response ? ppobSafeJsonParse(latest.raw_response, {}) : null
      }).catch(() => {});
      return ctx.reply(
        `Status transaksi belum dapat dipastikan. Saldo tetap ditahan agar tidak terjadi refund ganda.\n\nRef: ${reserve.referenceId}\nError: ${err.message}`,
        { reply_markup: { inline_keyboard: [[{ text: 'Cek Status', callback_data: `ppob_check_${latest?.id || 0}` }]] } }
      ).catch(() => {});
    }
    return ctx.reply(`Transaksi sudah tercatat dengan status ${latestStatus}.\nRef: ${reserve.referenceId}`).catch(() => {});
  }
}

async function checkPpobOrderStatus(ctx, orderId) {
  const row = await dbGetAsync('SELECT * FROM ppob_orders WHERE id = ? AND user_id = ?', [Number(orderId), ctx.from.id]);
  if (!row) return ctx.reply('Order PPOB tidak ditemukan.');
  if (!['PENDING', 'PROCESS'].includes(String(row.status || '').toUpperCase())) {
    return ctx.reply(`Status order: ${row.status}\n${row.message || ''}`);
  }
  await ctx.answerCbQuery('Mengecek status...').catch(() => {});
  try {
    const previousStatus = String(row.status || '').toUpperCase();
    const result = await executePpobOrder(row);
    const latest = await dbGetAsync('SELECT * FROM ppob_orders WHERE id = ?', [row.id]);
    if (result.status === 'FAILED') {
      if (String(row.status || '').toUpperCase() === 'PENDING') {
        await cancelReservedAccountCharge(row.user_id, row.amount, row.ref_id, 'ppob').catch(() => {});
        await markPpobOrderRefunded(row.ref_id, result.message || 'Transaksi gagal, saldo dikembalikan.').catch(() => {});
      } else {
        await refundPpobOrder(latest, result.message || 'Transaksi gagal, saldo dikembalikan.').catch(() => {});
      }
    } else if (result.status === 'SUCCESS') {
      await finalizeReservedAccountCharge(row.ref_id, 'ppob_success').catch(() => {});
    } else if (String(row.status || '').toUpperCase() === 'PENDING') {
      await finalizeReservedAccountCharge(row.ref_id, 'ppob_process').catch(() => {});
    }
    const finalRow = await dbGetAsync('SELECT * FROM ppob_orders WHERE id = ?', [row.id]);
    if (String(finalRow.status || '').toUpperCase() === 'SUCCESS' && previousStatus !== 'SUCCESS') {
      const balanceResult = await getDigiflazzBalanceSafe();
      await notifyPpobPurchaseGroups(ctx, finalRow, balanceResult);
      if (balanceResult.ok) {
        await warnLowDigiflazzBalanceIfNeeded(balanceResult.balance, `Transaksi PPOB ${finalRow.ref_id || '-'}`);
      }
    }
    return ctx.reply(
      `<b>Status PPOB</b>\n\nProduk: ${escapeHtml(finalRow.product_name || finalRow.buyer_sku_code)}\nTujuan: <code>${escapeHtml(finalRow.customer_no)}</code>\nStatus: <b>${escapeHtml(finalRow.status)}</b>\n${finalRow.serial_number ? `SN: <code>${escapeHtml(finalRow.serial_number)}</code>\n` : ''}${finalRow.message ? `Pesan: ${escapeHtml(finalRow.message)}` : ''}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('Gagal cek status PPOB:', err.message);
    return ctx.reply(`Gagal cek status: ${err.message}`);
  }
}

const PPOB_AUTO_POLL_INTERVAL_MS = 15 * 1000; // cek ulang order PENDING/PROCESS tiap 15 detik
let ppobAutoPollInFlight = false;

async function pollPendingPpobOrders() {
  if (ppobAutoPollInFlight) return;
  ppobAutoPollInFlight = true;
  try {
    const rows = await dbAllAsync(
      "SELECT * FROM ppob_orders WHERE UPPER(status) IN ('PENDING','PROCESS') ORDER BY id ASC LIMIT 25"
    );
    for (const row of rows) {
      const previousStatus = String(row.status || '').toUpperCase();
      try {
        const result = await executePpobOrder(row);
        const latest = await dbGetAsync('SELECT * FROM ppob_orders WHERE id = ?', [row.id]);
        if (result.status === 'FAILED') {
          if (previousStatus === 'PENDING') {
            await cancelReservedAccountCharge(row.user_id, row.amount, row.ref_id, 'ppob').catch(() => {});
            await markPpobOrderRefunded(row.ref_id, result.message || 'Transaksi gagal, saldo dikembalikan.').catch(() => {});
          } else {
            await refundPpobOrder(latest, result.message || 'Transaksi gagal, saldo dikembalikan.').catch(() => {});
          }
        } else if (result.status === 'SUCCESS') {
          await finalizeReservedAccountCharge(row.ref_id, 'ppob_success').catch(() => {});
        } else if (previousStatus === 'PENDING') {
          await finalizeReservedAccountCharge(row.ref_id, 'ppob_process').catch(() => {});
        }

        const finalRow = await dbGetAsync('SELECT * FROM ppob_orders WHERE id = ?', [row.id]);
        const finalStatus = String(finalRow.status || '').toUpperCase();
        if (finalStatus !== previousStatus && ['SUCCESS', 'FAILED', 'REFUNDED'].includes(finalStatus)) {
          if (finalStatus === 'SUCCESS') {
            const balanceResult = await getDigiflazzBalanceSafe();
            const pseudoCtx = { from: { id: finalRow.user_id } };
            await notifyPpobPurchaseGroups(pseudoCtx, finalRow, balanceResult).catch(() => {});
            if (balanceResult.ok) {
              await warnLowDigiflazzBalanceIfNeeded(balanceResult.balance, `Transaksi PPOB ${finalRow.ref_id || '-'}`).catch(() => {});
            }
          }
          const text = [
            finalStatus === 'SUCCESS' ? '✅ <b>TRANSAKSI PPOB SUKSES</b>' : '⚠️ <b>TRANSAKSI PPOB GAGAL</b>',
            '',
            `Produk: <b>${escapeHtml(finalRow.product_name || finalRow.buyer_sku_code)}</b>`,
            `Tujuan: <code>${escapeHtml(finalRow.customer_no)}</code>`,
            `Status: <b>${escapeHtml(finalRow.status)}</b>`,
            finalRow.serial_number ? `SN: <code>${escapeHtml(finalRow.serial_number)}</code>` : '',
            finalRow.message ? `Pesan: ${escapeHtml(finalRow.message)}` : '',
            `Ref: <code>${escapeHtml(finalRow.ref_id)}</code>`
          ].filter(Boolean).join('\n');
          await bot.telegram.sendMessage(finalRow.user_id, text, { parse_mode: 'HTML' }).catch((err) => {
            logger.warn('Gagal kirim notif auto PPOB ke user ' + finalRow.user_id + ': ' + err.message);
          });
        }
      } catch (err) {
        logger.error(`Gagal auto-poll PPOB order ${row.ref_id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Gagal menjalankan pollPendingPpobOrders: ' + err.message);
  } finally {
    ppobAutoPollInFlight = false;
  }
}

setInterval(pollPendingPpobOrders, PPOB_AUTO_POLL_INTERVAL_MS);

function normalizeSyncHost(rawHost) {
  const value = String(rawHost || '').trim();
  if (!value) return '';
  const cleaned = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return cleaned.split('/')[0].trim();
}

function normalizeSyncEndpoint(rawEndpoint) {
  const value = String(rawEndpoint || '').trim();
  if (!value) return '/internal/account-summary';
  return value.startsWith('/') ? value : `/${value}`;
}

function buildTunnelSyncCandidateUrls(host, port, endpoint) {
  const safeHost = String(host || '').trim();
  const safeEndpoint = normalizeSyncEndpoint(endpoint);
  const safePort = Number(port);
  const hasPort = Number.isFinite(safePort) && safePort > 0;

  const urls = [];
  if (hasPort) {
    urls.push(`http://${safeHost}:${safePort}${safeEndpoint}`);
    urls.push(`https://${safeHost}:${safePort}${safeEndpoint}`);
  }
  urls.push(`http://${safeHost}${safeEndpoint}`);
  urls.push(`https://${safeHost}${safeEndpoint}`);
  return [...new Set(urls)];
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTunnelError(error) {
  if (error?.response) return false;
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    message.includes('timeout')
  );
}

async function requestTunnelSync(server, endpoint, requestConfig = {}, method = 'get', body = null) {
  const req = buildTunnelSyncRequest(server, endpoint);
  const candidateUrls = buildTunnelSyncCandidateUrls(req.host, req.port, req.endpoint);
  const {
    retries: requestRetries,
    retryDelayMs,
    ...axiosConfig
  } = requestConfig || {};
  const retries = numberFromRuntimeSetting(
    requestRetries ?? TUNNEL_SYNC_RETRIES,
    TUNNEL_SYNC_RETRIES,
    0,
    3
  );
  const headers = {
    'x-sync-token': req.token,
    ...(axiosConfig.headers || {})
  };

  let lastError = null;
  for (const url of candidateUrls) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        if (method === 'post') {
          return await axios.post(url, body, { ...axiosConfig, headers });
        }
        return await axios.get(url, { ...axiosConfig, headers });
      } catch (error) {
        lastError = error;
        if (error?.response || attempt >= retries || !isRetryableTunnelError(error)) break;
        await sleepMs(Number(retryDelayMs || 750));
      }
    }
    if (lastError?.response) break;
  }

  throw lastError || new Error('request gagal');
}

function readCountGroup(source) {
  const src = source && typeof source === 'object' ? source : {};
  const ssh = Number(src.ssh || 0);
  const vmess = Number(src.vmess || 0);
  const vless = Number(src.vless || 0);
  const trojan = Number(src.trojan || 0);
  const total = Number(src.total ?? (ssh + vmess + vless + trojan));
  return {
    ssh: Number.isFinite(ssh) ? ssh : 0,
    vmess: Number.isFinite(vmess) ? vmess : 0,
    vless: Number.isFinite(vless) ? vless : 0,
    trojan: Number.isFinite(trojan) ? trojan : 0,
    total: Number.isFinite(total) ? total : (ssh + vmess + vless + trojan)
  };
}

function hasCountGroup(source) {
  if (!source || typeof source !== 'object') return false;
  return ['ssh', 'vmess', 'vless', 'trojan', 'total'].some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

async function fetchTunnelAccountSummary(server) {
  const req = buildTunnelSyncRequest(server);

  let response;
  try {
    response = await requestTunnelSync(
      server,
      req.endpoint,
      { timeout: TUNNEL_SUMMARY_TIMEOUT_MS, retries: TUNNEL_SYNC_RETRIES },
      'get'
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API summary gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API summary gagal: ${data.message || 'unknown error'}`);
  }

  if (hasCountGroup(data.active_regular)) {
    return readCountGroup(data.active_regular);
  }

  const summaryCounts = readCountGroup(data);
  if (!TUNNEL_SYNC_USE_EXPORT_COUNT) {
    return summaryCounts;
  }

  // Prioritas: hitung akun aktif non-trial dari export-accounts
  // agar /syncservernow tidak memasukkan akun trial ke total akun aktif berbayar.
  const normalizeStatus = (raw) => String(raw || '').trim().toUpperCase();
  const isTrialUsername = (raw) => /^trial/i.test(String(raw || '').trim());
  const countPaidActive = (accounts) => {
    if (!Array.isArray(accounts)) return 0;
    return accounts.filter((acc) => {
      const username = String(acc?.username || '').trim();
      if (!username || isTrialUsername(username)) return false;
      const status = normalizeStatus(acc?.status);
      if (!status) return true; // beberapa endpoint export tidak kirim status
      return status === 'AKTIF' || status === 'ACTIVE';
    }).length;
  };

  try {
    const [sshExport, vmessExport, vlessExport, trojanExport] = await Promise.all([
      fetchTunnelExportAccounts(server, 'ssh', 50000),
      fetchTunnelExportAccounts(server, 'vmess', 50000),
      fetchTunnelExportAccounts(server, 'vless', 50000),
      fetchTunnelExportAccounts(server, 'trojan', 50000)
    ]);

    const paidSsh = countPaidActive(sshExport.accounts);
    const paidVmess = countPaidActive(vmessExport.accounts);
    const paidVless = countPaidActive(vlessExport.accounts);
    const paidTrojan = countPaidActive(trojanExport.accounts);
    const paidTotal = paidSsh + paidVmess + paidVless + paidTrojan;

    return {
      ssh: paidSsh,
      vmess: paidVmess,
      vless: paidVless,
      trojan: paidTrojan,
      total: paidTotal
    };
  } catch (exportErr) {
    logger.warn(`[SyncServer] fallback summary count (export-accounts gagal): ${exportErr.message}`);
    return summaryCounts;
  }
}
function buildTunnelSyncRequest(server, endpointOverride = null) {
  const host = normalizeSyncHost(server.sync_host || server.domain);
  if (!host) throw new Error('domain/sync_host server belum diisi');

  const token = String(server.auth || '').trim();
  if (!token) throw new Error('auth token server kosong');

  const port = Number(server.sync_port) || 8789;
  const summaryEndpoint = normalizeSyncEndpoint(server.sync_endpoint);
  const endpoint = endpointOverride
    ? normalizeSyncEndpoint(endpointOverride)
    : summaryEndpoint;

  return {
    host,
    token,
    port,
    summaryEndpoint,
    endpoint,
    url: `http://${host}:${port}${endpoint}`
  };
}

function parseDateExpToTimestamp(dateExp) {
  const value = String(dateExp || '').trim();
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return new Date(y, mo, d, 23, 59, 59, 999).getTime();
}

function calcRemainingDaysFromDateExp(dateExp) {
  const value = String(dateExp || '').trim();
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const expDay = new Date(y, mo, d);
  const msPerDay = 24 * 60 * 60 * 1000;

  const diffDays = Math.floor((expDay.getTime() - todayStart.getTime()) / msPerDay);
  return Math.max(0, diffDays);
}

async function fetchOwnedAccountsByTelegramFromServer(server, telegramUserId) {
  try {
    const userId = String(telegramUserId || '').trim();
    if (!userId) return [];

    const host = normalizeSyncHost(server?.sync_host || server?.domain || '');
    const authToken = String(server?.auth || '').trim();
    if (!host || !authToken) return [];

    const response = await axios.get(`http://${host}/vps/my-accounts`, {
      timeout: TUNNEL_SUMMARY_TIMEOUT_MS,
      headers: {
        Authorization: authToken,
        'x-telegram-user-id': userId
      },
      params: {
        telegram_user_id: userId,
        include_inactive: '1'
      }
    });

    const data = response?.data || {};
    const accounts = Array.isArray(data?.data?.accounts)
      ? data.data.accounts
      : Array.isArray(data?.accounts)
        ? data.accounts
        : [];

    const serverId = Number(server?.id || 0);
    const serverName = String(server?.nama_server || server?.domain || ('ID ' + serverId)).trim();
    const serverDomain = String(server?.domain || '').trim();

    return accounts.map((item) => {
      const type = String(item?.type || 'ssh').trim().toLowerCase() || 'ssh';
      const username = String(item?.username || '').trim();
      const dateExp = String(item?.date_exp || '').trim();
      const expiresAt = Number(item?.expires_at || 0) || parseDateExpToTimestamp(dateExp);
      return {
        id: null,
        type,
        username,
        password: String(item?.password || '').trim(),
        server_id: serverId,
        server_name: serverName,
        domain: String(item?.domain || serverDomain).trim(),
        date_exp: dateExp,
        expires_at: expiresAt || null,
        quota: Number(item?.quota || 0),
        limitip: Number(item?.limitip || 0),
        status: String(item?.status || '').trim().toUpperCase()
      };
    }).filter((item) => item.username);
  } catch (e) {
    logger.warn(`Gagal fetch owned accounts dari server ${server?.id || '-'}: ${e.message}`);
    return [];
  }
}

async function fetchTunnelAccountExpiryByUsername(server, username) {
  try {
    const req = buildTunnelSyncRequest(server);
    const expiryEndpoint = req.summaryEndpoint.endsWith('/account-summary')
      ? req.summaryEndpoint.replace(/account-summary$/, 'account-expiry')
      : '/internal/account-expiry';

    const response = await requestTunnelSync(
      server,
      expiryEndpoint,
      { timeout: TUNNEL_SUMMARY_TIMEOUT_MS, retries: TUNNEL_SYNC_RETRIES, params: { username } },
      'get'
    );

    const data = response?.data || {};
    if (!data.ok || !data.found) {
      return { found: false };
    }

    return {
      found: true,
      service: String(data.service || '').toLowerCase(),
      dateExp: String(data.date_exp || '').trim(),
      expiresAt: parseDateExpToTimestamp(data.date_exp)
    };
  } catch (error) {
    const msg = error?.response?.data?.message || error.message || 'request gagal';
    logger.warn(`fetchTunnelAccountExpiryByUsername gagal: ${msg}`);
    return { found: false };
  }
}

function formatDateYmdLocal(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchTunnelExpirySummaryByDate(server, dateYmd) {
  const req = buildTunnelSyncRequest(server);
  const expirySummaryEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'expiry-summary')
    : '/internal/expiry-summary';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      expirySummaryEndpoint,
      { timeout: TUNNEL_SUMMARY_TIMEOUT_MS, retries: TUNNEL_SYNC_RETRIES, params: { date: dateYmd } },
      'get'
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API expiry-summary gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API expiry-summary gagal: ${data.message || 'unknown error'}`);
  }

  const ssh = Number(data.ssh || 0);
  const vmess = Number(data.vmess || 0);
  const vless = Number(data.vless || 0);
  const trojan = Number(data.trojan || 0);
  const totalExpired = Number(
    data.total_expired ??
    data.total ??
    data.expired_total ??
    (ssh + vmess + vless + trojan)
  );

  return { date: dateYmd, ssh, vmess, vless, trojan, totalExpired };
}

async function fetchTunnelVnstatDailySummary(server) {
  const req = buildTunnelSyncRequest(server);
  const vnstatEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'vnstat-daily')
    : '/internal/vnstat-daily';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      vnstatEndpoint,
      { timeout: TUNNEL_VNSTAT_TIMEOUT_MS, retries: TUNNEL_SYNC_RETRIES },
      'get'
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API vnstat-daily gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API vnstat-daily gagal: ${data.message || 'unknown error'}`);
  }

  const totalGb = Number(data.total_gb || data.totalGb || 0);
  const monthTotalTb = Number(
    data.month_total_tb ??
    data.monthTotalTb ??
    (Number(data.month_total_gb || 0) / 1024)
  );

  return {
    date: String(data.date || '').trim(),
    totalGb: Number.isFinite(totalGb) ? totalGb : 0,
    monthTotalTb: Number.isFinite(monthTotalTb) ? monthTotalTb : 0
  };
}

function normalizeMigrationType(rawType) {
  const value = String(rawType || '').trim().toLowerCase();
  if (value === 'udp' || value === 'udp_http' || value === 'zivpn') return 'zivpn';
  if (value === 'ssh' || value === 'vmess' || value === 'vless' || value === 'trojan') return value;
  return '';
}

function isSupportedMigrationType(type) {
  const t = normalizeMigrationType(type);
  return t === 'ssh' || t === 'zivpn';
}

async function fetchTunnelExportAccounts(server, accountType, limit) {
  const req = buildTunnelSyncRequest(server);
  const exportEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'export-accounts')
    : '/internal/export-accounts';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      exportEndpoint,
      { timeout: TUNNEL_EXPORT_TIMEOUT_MS, retries: TUNNEL_SYNC_RETRIES, params: { type: accountType, limit } },
      'get'
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API export-accounts gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API export-accounts gagal: ${data.message || 'unknown error'}`);
  }

  return {
    type: String(data.type || accountType).toLowerCase(),
    exported: Number(data.exported || 0),
    accounts: Array.isArray(data.accounts) ? data.accounts : []
  };
}

async function importTunnelAccounts(server, accountType, accounts) {
  const req = buildTunnelSyncRequest(server);
  const importEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'import-accounts')
    : '/internal/import-accounts';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      importEndpoint,
      { timeout: 60000 },
      'post',
      { type: accountType, accounts }
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API import-accounts gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API import-accounts gagal: ${data.message || 'unknown error'}`);
  }

  return {
    imported: Number(data.imported || 0),
    skipped: Number(data.skipped || 0),
    usernames: Array.isArray(data.usernames) ? data.usernames : [],
    type: String(data.type || accountType).toLowerCase()
  };
}

async function deleteTunnelAccounts(server, accountType, usernames) {
  const req = buildTunnelSyncRequest(server);
  const deleteEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'delete-accounts')
    : '/internal/delete-accounts';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      deleteEndpoint,
      { timeout: 45000 },
      'post',
      { type: accountType, usernames }
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API delete-accounts gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API delete-accounts gagal: ${data.message || 'unknown error'}`);
  }

  return {
    deleted: Number(data.deleted || 0),
    type: String(data.type || accountType).toLowerCase()
  };
}

async function deleteAllTunnelAccounts(server, accountType) {
  const req = buildTunnelSyncRequest(server);
  const endpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'delete-all-accounts')
    : '/internal/delete-all-accounts';

  let response;
  try {
    response = await requestTunnelSync(
      server,
      endpoint,
      { timeout: 60000 },
      'post',
      { type: accountType }
    );
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API delete-all-accounts gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API delete-all-accounts gagal: ${data.message || 'unknown error'}`);
  }

  return {
    type: String(data.type || accountType).toLowerCase(),
    deletedDb: Number(data.deleted_db || data.deleted || 0),
    deletedZivpn: Number(data.deleted_zivpn || 0)
  };
}

async function migrateTunnelAccountsBetweenServers(sourceServer, targetServer, type, limit) {
  const normalizedType = normalizeMigrationType(type);
  if (!normalizedType) {
    throw new Error('Jenis akun migrasi tidak valid.');
  }

  const maxLimit = Math.max(1, Math.min(500, Number(limit || 0)));
  const exported = await fetchTunnelExportAccounts(sourceServer, normalizedType, maxLimit);
  if (!exported.accounts.length) {
    return { type: normalizedType, requested: maxLimit, exported: 0, imported: 0, skipped: 0, deleted: 0 };
  }

  const imported = await importTunnelAccounts(targetServer, normalizedType, exported.accounts);
  const usernamesToDelete = Array.isArray(imported.usernames) ? imported.usernames : [];
  const importedSet = new Set(usernamesToDelete.map((u) => String(u || '').toLowerCase()));
  const migratedAccounts = exported.accounts
    .filter((acc) => importedSet.has(String(acc?.username || '').toLowerCase()))
    .map((acc) => ({
      username: String(acc?.username || '').trim(),
      password: String(acc?.password || '').trim(),
      dateExp: String(acc?.date_exp || '').trim(),
      days: Number(acc?.days || 0)
    }));
  let deleted = 0;
  if (usernamesToDelete.length > 0) {
    const deletedResult = await deleteTunnelAccounts(sourceServer, normalizedType, usernamesToDelete);
    deleted = deletedResult.deleted;
  }
  return {
    type: normalizedType,
    requested: maxLimit,
    exported: exported.accounts.length,
    imported: imported.imported,
    skipped: imported.skipped,
    deleted,
    migratedAccounts
  };
}

function getDaysInCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

function getRemainingDaysInCurrentMonthInclusive() {
  const now = new Date();
  const daysInMonth = getDaysInCurrentMonth();
  return Math.max(1, daysInMonth - now.getDate() + 1);
}

function getElapsedDaysInCurrentMonth() {
  return Math.max(1, new Date().getDate());
}

const BANDWIDTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function calculateServerEffectiveCapacity(input) {
  const usedAccounts = Math.max(0, Number(input.usedAccounts || 0));
  const manualLimitRaw = Number(input.manualLimit || 0);
  const bandwidthLimitTb = Number(input.bandwidthLimitTb || 0);
  const rawDailyBandwidthGb = Math.max(0, Number(input.dailyBandwidthGb || 0));
  const fallbackPerUserDailyGb = Math.max(0, Number(input.fallbackPerUserDailyGb || 8));
  const monthUsedTb = Math.max(0, Number(input.monthUsedTb || 0));
  const projectionDays = Math.max(1, Number(input.projectionDays || 30));
  const elapsedDays = Math.max(1, Number(input.elapsedDaysInMonth || getElapsedDaysInCurrentMonth()));
  const monthUsedGb = monthUsedTb * 1024;
  const avgDailyFromMonthGb = monthUsedGb > 0 ? (monthUsedGb / elapsedDays) : 0;
  // Pakai nilai harian yang lebih aman agar tidak under-estimate ketika data daily stale/rendah.
  const effectiveDailyBandwidthGb = Math.max(rawDailyBandwidthGb, avgDailyFromMonthGb);

  const hasManualLimit = Number.isFinite(manualLimitRaw) && manualLimitRaw > 0;
  const manualLimit = hasManualLimit ? Math.floor(manualLimitRaw) : 0;

  const hasBandwidthLimit = Number.isFinite(bandwidthLimitTb) && bandwidthLimitTb > 0;
  if (!hasBandwidthLimit) {
    const projectedMonthlyTbFromToday = (effectiveDailyBandwidthGb * projectionDays) / 1024;
    return {
      hasBandwidthLimit: false,
      effectiveLimit: hasManualLimit ? manualLimit : 0,
      remainingSlots: hasManualLimit ? Math.max(0, manualLimit - usedAccounts) : null,
      isFull: hasManualLimit ? usedAccounts >= manualLimit : false,
      estimatedCapacityByBandwidth: 0,
      safeUsersFromTodayProjection: 0,
      safeUsersForRemainingMonth: 0,
      projectedMonthlyTbFromToday,
      monthlyRemainingTb: null,
      estimatedPerUserDailyGb: 0,
      effectiveDailyBandwidthGb
    };
  }

  const perUserDailyGbFromEffectiveUsage = usedAccounts > 0 && effectiveDailyBandwidthGb > 0
    ? (effectiveDailyBandwidthGb / usedAccounts)
    : 0;
  const estimatedPerUserDailyGb = perUserDailyGbFromEffectiveUsage > 0
    ? perUserDailyGbFromEffectiveUsage
    : (fallbackPerUserDailyGb > 0 ? fallbackPerUserDailyGb : 8);
  const daysInMonth = projectionDays;
  const remainingDaysInMonth = getRemainingDaysInCurrentMonthInclusive();

  let safeUsersFromTodayProjection = 0;
  if (estimatedPerUserDailyGb > 0) {
    safeUsersFromTodayProjection = Math.floor((bandwidthLimitTb * 1024) / (estimatedPerUserDailyGb * daysInMonth));
  }
  safeUsersFromTodayProjection = Math.max(0, safeUsersFromTodayProjection);

  const monthlyRemainingTb = Math.max(0, bandwidthLimitTb - monthUsedTb);
  let safeUsersForRemainingMonth = safeUsersFromTodayProjection;
  if (estimatedPerUserDailyGb > 0) {
    safeUsersForRemainingMonth = Math.floor((monthlyRemainingTb * 1024) / (estimatedPerUserDailyGb * remainingDaysInMonth));
  }
  safeUsersForRemainingMonth = Math.max(0, safeUsersForRemainingMonth);

  const estimatedCapacityByBandwidth = Math.max(0, Math.min(safeUsersFromTodayProjection, safeUsersForRemainingMonth));
  const projectedMonthlyTbFromToday = (effectiveDailyBandwidthGb * projectionDays) / 1024;

  const effectiveLimit = hasManualLimit
    ? Math.min(manualLimit, estimatedCapacityByBandwidth)
    : estimatedCapacityByBandwidth;

  return {
    hasBandwidthLimit: true,
    effectiveLimit,
    remainingSlots: Math.max(0, effectiveLimit - usedAccounts),
    isFull: usedAccounts >= effectiveLimit,
    estimatedCapacityByBandwidth,
    safeUsersFromTodayProjection,
    safeUsersForRemainingMonth,
    projectedMonthlyTbFromToday,
    monthlyRemainingTb,
    estimatedPerUserDailyGb,
    effectiveDailyBandwidthGb
  };
}

async function sendBandwidthRiskAlert(payload) {
  const lines = [
    'PERINGATAN BANDWIDTH SERVER',
    '',
    `Server: ${payload.serverName}`,
    `Host: ${payload.host}`,
    `User aktif saat ini: ${payload.usedAccounts}`,
    `Traffic hari ini: ${payload.dailyGb.toFixed(2)} GB`,
    `Rata-rata/user/hari: ${payload.avgPerUserGb.toFixed(3)} GB`,
    `Proyeksi 30 hari: ${payload.projectedMonthlyTb.toFixed(2)} TB`,
    `Limit BW bulanan: ${payload.limitTb.toFixed(2)} TB`,
    `Batas aman user (estimasi): ${payload.safeUsers} user`
  ];
  const message = lines.join('\n');

  const targets = new Set();
  if (Number(BW_NOTIF_GROUP_ID_NUM)) targets.add(Number(BW_NOTIF_GROUP_ID_NUM));
  if (targets.size === 0) {
    logger.warn('Notif peringatan bandwidth dilewati: group id notif bandwidth belum diset.');
    return;
  }

  for (const chatId of targets) {
    try {
      await bot.telegram.sendMessage(chatId, message);
    } catch (err) {
      logger.warn(`Gagal kirim notif bandwidth ke ${chatId}: ${err.message}`);
    }
  }
}

async function sendBandwidthReportToGroup(chatId) {
  const targetChatId = Number(chatId);
  if (!Number.isFinite(targetChatId)) return;

  const allRows = await dbAllAsync(
    'SELECT id, nama_server, domain, sync_host, total_create_akun, batas_create_akun, bandwidth_limit_tb, bandwidth_daily_gb, bandwidth_monthly_used_tb, bandwidth_user_daily_gb FROM Server ORDER BY nama_server COLLATE NOCASE ASC'
  );
  if (!allRows || allRows.length === 0) {
    await bot.telegram.sendMessage(targetChatId, 'Laporan bandwidth: belum ada server.');
    return;
  }

  const rows = allRows.filter((srv) => Number(srv.bandwidth_limit_tb || 0) > 0);
  if (rows.length === 0) {
    await bot.telegram.sendMessage(targetChatId, 'Laporan bandwidth: belum ada server yang di-set limit bandwidth.');
    return;
  }

  const header = [
    'LAPORAN BANDWIDTH SERVER (3 JAM)',
    `Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
    ''
  ];
  const lines = [...header];

  rows.forEach((srv, idx) => {
    const capacity = calculateServerEffectiveCapacity({
      usedAccounts: srv.total_create_akun,
      manualLimit: srv.batas_create_akun,
      bandwidthLimitTb: srv.bandwidth_limit_tb,
      dailyBandwidthGb: srv.bandwidth_daily_gb,
      fallbackPerUserDailyGb: srv.bandwidth_user_daily_gb,
      monthUsedTb: srv.bandwidth_monthly_used_tb
    });
    const bwLimitTb = Number(srv.bandwidth_limit_tb || 0);
    const riskOver = capacity.hasBandwidthLimit && capacity.projectedMonthlyTbFromToday > bwLimitTb ? 'YA' : 'TIDAK';
    const host = normalizeSyncHost(srv.sync_host || srv.domain) || '-';
    const manualLimit = Number(srv.batas_create_akun || 0);
    const manualLimitText = manualLimit > 0 ? String(manualLimit) : 'Unlimited';

    lines.push(`${idx + 1}. ${srv.nama_server || '-'}`);
    lines.push(`- Host: ${host}`);
    lines.push(`- Akun Terpakai: ${Number(srv.total_create_akun || 0)}/${manualLimitText}`);
    lines.push(`- Bandwidth Hari Ini (raw): ${Number(srv.bandwidth_daily_gb || 0).toFixed(2)} GB`);
    lines.push(`- Bandwidth Hari Ini (efektif): ${Number(capacity.effectiveDailyBandwidthGb || 0).toFixed(2)} GB`);
    lines.push(`- Bandwidth Bulan Ini: ${Number(srv.bandwidth_monthly_used_tb || 0).toFixed(2)}/${bwLimitTb > 0 ? bwLimitTb.toFixed(2) : '-'} TB`);
    lines.push(`- Proyeksi 30 Hari: ${capacity.projectedMonthlyTbFromToday.toFixed(2)} TB`);
    lines.push(`- Batas Aman User (BW): ${capacity.hasBandwidthLimit ? capacity.estimatedCapacityByBandwidth : '-'}`);
    lines.push(`- Risiko Over BW: ${riskOver}`);
    lines.push('');
  });

  let buffer = '';
  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length > 3500) {
      await bot.telegram.sendMessage(targetChatId, buffer);
      buffer = line;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) await bot.telegram.sendMessage(targetChatId, buffer);
}

function formatBandwidthReportInterval(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes) || 0));
  if (m % 60 === 0) {
    const h = m / 60;
    return `${h} jam`;
  }
  return `${m} menit`;
}

function parseBandwidthIntervalInput(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    return Number(text);
  }

  const jamMatch = text.match(/^(\d+)\s*(jam|j)$/);
  if (jamMatch) return Number(jamMatch[1]) * 60;

  const menitMatch = text.match(/^(\d+)\s*(menit|m)$/);
  if (menitMatch) return Number(menitMatch[1]);

  return null;
}

async function syncServerUsageFromTunnel(trigger = 'manual', options = {}) {
  const targetServerId = options.serverId ? Number(options.serverId) : null;
  const force = options.force === true;
  const whereParts = ['1=1'];
  const params = [];

  if (Number.isFinite(targetServerId)) {
    whereParts.push('id = ?');
    params.push(targetServerId);
  }

  const servers = await dbAllAsync(
    `SELECT id, nama_server, domain, auth, batas_create_akun, total_create_akun,
            sync_host, sync_port, sync_endpoint, sync_enabled,
            bandwidth_limit_tb, bandwidth_user_daily_gb,
            bandwidth_daily_gb, bandwidth_monthly_used_tb,
            bandwidth_alert_last_notified_at
     FROM Server
     WHERE ${whereParts.join(' AND ')}`,
    params
  );

  const result = {
    checked: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    totals: { used: 0, remaining: 0, capacity: 0, unlimitedServers: 0, syncedServers: 0 }
  };

  const makeGroupKey = (server) => normalizeSyncHost(server.sync_host || server.domain) || (`id-${server.id}`);

  const groups = new Map();
  const skippedGroupKeys = new Set();

  for (const server of servers) {
    if (!force && !Number.isFinite(targetServerId) && Number(server.sync_enabled) === 0) {
      skippedGroupKeys.add(makeGroupKey(server));
      continue;
    }

    const key = makeGroupKey(server);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(server);
  }

  result.skipped = skippedGroupKeys.size;

  for (const groupServers of groups.values()) {
    const primary = groupServers[0];
    result.checked += 1;

    const syncAuth = String(groupServers.find((s) => String(s.auth || '').trim())?.auth || '').trim();
    const syncPort = Number(groupServers.find((s) => Number(s.sync_port) > 0)?.sync_port || primary.sync_port) || 8789;
    const syncEndpoint = normalizeSyncEndpoint(groupServers.find((s) => String(s.sync_endpoint || '').trim())?.sync_endpoint || primary.sync_endpoint);
    const summaryRequestServer = { ...primary, auth: syncAuth || primary.auth, sync_port: syncPort, sync_endpoint: syncEndpoint };

    try {
      const counts = await fetchTunnelAccountSummary(summaryRequestServer);
      let vnstatSummary = null;
      try {
        vnstatSummary = await fetchTunnelVnstatDailySummary(summaryRequestServer);
      } catch (vnErr) {
        logger.warn(`[SyncServer:${trigger}] vnstat skip ${primary.nama_server}: ${vnErr.message}`);
      }

      for (const server of groupServers) {
        const dailyBandwidthGb = vnstatSummary ? Number(vnstatSummary.totalGb || 0) : Number(server.bandwidth_daily_gb || 0);
        const monthUsedTb = vnstatSummary ? Number(vnstatSummary.monthTotalTb || 0) : Number(server.bandwidth_monthly_used_tb || 0);
        const capacity = calculateServerEffectiveCapacity({
          usedAccounts: counts.total,
          manualLimit: server.batas_create_akun,
          bandwidthLimitTb: server.bandwidth_limit_tb,
          dailyBandwidthGb,
          fallbackPerUserDailyGb: server.bandwidth_user_daily_gb,
          monthUsedTb
        });

        await dbRunAsync(
          'UPDATE Server SET total_create_akun = ?, bandwidth_daily_gb = ?, bandwidth_monthly_used_tb = ?, bandwidth_remaining_tb = ?, bandwidth_estimated_capacity = ?, bandwidth_last_sync_at = ? WHERE id = ?',
          [
            counts.total,
            dailyBandwidthGb,
            monthUsedTb,
            capacity.monthlyRemainingTb === null ? 0 : capacity.monthlyRemainingTb,
            capacity.estimatedCapacityByBandwidth,
            Date.now(),
            server.id
          ]
        );
      }

      const groupManualLimit = groupServers
        .map((s) => Number(s.batas_create_akun || 0))
        .filter((v) => Number.isFinite(v) && v > 0)
        .reduce((max, cur) => Math.max(max, cur), 0);
      const groupBandwidthLimitTb = groupServers
        .map((s) => Number(s.bandwidth_limit_tb || 0))
        .filter((v) => Number.isFinite(v) && v > 0)
        .reduce((max, cur) => Math.max(max, cur), 0);
      const groupFallbackDailyGb = groupServers
        .map((s) => Number(s.bandwidth_user_daily_gb || 0))
        .filter((v) => Number.isFinite(v) && v > 0)
        .reduce((max, cur) => Math.max(max, cur), 0);
      const groupDailyGb = vnstatSummary ? Number(vnstatSummary.totalGb || 0) : Number(primary.bandwidth_daily_gb || 0);
      const groupMonthTb = vnstatSummary ? Number(vnstatSummary.monthTotalTb || 0) : Number(primary.bandwidth_monthly_used_tb || 0);

      const capacity = calculateServerEffectiveCapacity({
        usedAccounts: counts.total,
        manualLimit: groupManualLimit,
        bandwidthLimitTb: groupBandwidthLimitTb,
        dailyBandwidthGb: groupDailyGb,
        fallbackPerUserDailyGb: groupFallbackDailyGb || 8,
        monthUsedTb: groupMonthTb
      });

      const latestAlertTs = groupServers
        .map((s) => Number(s.bandwidth_alert_last_notified_at || 0))
        .filter((v) => Number.isFinite(v) && v > 0)
        .reduce((max, cur) => Math.max(max, cur), 0);
      const nowTs = Date.now();
      const shouldAlertOverBandwidth =
        capacity.hasBandwidthLimit &&
        groupBandwidthLimitTb > 0 &&
        capacity.projectedMonthlyTbFromToday > groupBandwidthLimitTb;
      const cooldownPassed = latestAlertTs <= 0 || (nowTs - latestAlertTs) >= BANDWIDTH_ALERT_COOLDOWN_MS;

      if (shouldAlertOverBandwidth && cooldownPassed) {
        await sendBandwidthRiskAlert({
          serverName: primary.nama_server || '-',
          host: normalizeSyncHost(primary.sync_host || primary.domain) || '-',
          usedAccounts: counts.total,
          dailyGb: groupDailyGb,
          avgPerUserGb: capacity.estimatedPerUserDailyGb,
          projectedMonthlyTb: capacity.projectedMonthlyTbFromToday,
          limitTb: groupBandwidthLimitTb,
          safeUsers: capacity.estimatedCapacityByBandwidth
        });
        for (const server of groupServers) {
          await dbRunAsync(
            'UPDATE Server SET bandwidth_alert_last_notified_at = ? WHERE id = ?',
            [nowTs, server.id]
          );
        }
      }

      result.updated += 1;
      result.totals.used += counts.total;
      result.totals.syncedServers += 1;

      if (capacity.remainingSlots === null) {
        result.totals.unlimitedServers += 1;
      } else {
        result.totals.remaining += capacity.remainingSlots;
        result.totals.capacity += capacity.effectiveLimit;
      }

      logger.info(
        `[SyncServer:${trigger}] ${primary.nama_server} => akun ${counts.total}/${capacity.effectiveLimit || '-'}, bw ${groupMonthTb.toFixed(2)}/${groupBandwidthLimitTb || 0} TB (group ${groupServers.length} row)`
      );
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        serverId: primary.id,
        serverName: primary.nama_server,
        message: err.message
      });
      logger.error(`[SyncServer:${trigger}] Gagal sync ${primary.nama_server}: ${err.message}`);
    }
  }

  return result;
}

// Tambah di section command, setelah command 'admin'
bot.command('edithargareseller', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
    return ctx.reply('Format salah. Gunakan: /edithargareseller <domain> <harga>');
  }

  const [domain, hargaReseller] = args.slice(1);
  if (!/^\d+$/.test(hargaReseller)) {
    return ctx.reply('harga reseller harus berupa angka.');
  }

  db.run(
    'UPDATE Server SET harga_reseller = ? WHERE domain = ?',
    [parseInt(hargaReseller, 10), domain],
    function(err) {
      if (err) {
        logger.error('Error saat update harga reseller:', err.message);
        return ctx.reply('Terjadi kesalahan saat update harga reseller.');
      }
      if (this.changes === 0) {
        return ctx.reply('Server dengan domain tersebut tidak ditemukan.');
      }
      return ctx.reply(`Harga reseller untuk ${domain} berhasil diupdate ke Rp ${Number(hargaReseller).toLocaleString('id-ID')}`);
    }
  );
});

bot.command('checkpaymentconfig', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  await ctx.reply('Memeriksa konfigurasi payment gateway...');

  try {
    reloadRuntimePaymentConfig();
    const readiness = getPaymentGatewayReadiness();

    const currentVars = loadVars();
    let message = '<b>KONFIGURASI PAYMENT GATEWAY</b>\n\n';
    message += `Mode aktif: <code>${escapeHtmlLocal(formatGatewayModeLabel())}</code>\n\n`;

    message += '<b>OrderKuota</b>\n';
    message += `- Aktif: ${isGatewayEnabled('orderkuota') ? 'YA' : 'TIDAK'}\n`;
    message += `- Siap dipakai: ${readiness.orderkuota.ready ? 'YA' : 'TIDAK'}\n`;
    if (!readiness.orderkuota.ready) {
      message += `- Kurang: <code>${escapeHtmlLocal(readiness.orderkuota.missing.join(', '))}</code>\n`;
    }
    message += `- Mode create QR: <code>${escapeHtmlLocal(formatOrderKuotaCreateModeLabel())}</code>\n`;
    message += `- Endpoint lokal: <code>/orderkuota/createpayment</code>\n`;
    if (ORDERKUOTA_CREATE_MODE === 'gateway') {
      message += `- Gateway URL: <code>${escapeHtmlLocal(PAYMENT_GATEWAY_BASE_URL)}</code>\n`;
      message += `- Gateway API Key: <code>${escapeHtmlLocal(maskSecret(RAJASERVER_API_KEY))}</code>\n`;
    }
    message += `- Local Endpoint API Key: <code>${escapeHtmlLocal(maskSecret(getLocalPaymentApiKey()))}</code>\n`;
    message += `- DATA_QRIS: <code>${DATA_QRIS ? 'Tersimpan' : 'Belum diisi'}</code>\n`;
    message += `- ORKUT Username: <code>${escapeHtmlLocal(currentVars.ORKUT_USERNAME || 'Belum diisi')}</code>\n`;
    message += `- ORKUT Token: <code>${escapeHtmlLocal(maskSecret(currentVars.ORKUT_TOKEN))}</code>\n`;
    message += `- Expired QRIS: <code>${ORDERKUOTA_QR_EXPIRE_MINUTES} menit</code>\n`;
    message += `- Minimal TopUp: <code>Rp ${Math.round(getMinTopupByProvider('orderkuota')).toLocaleString('id-ID')}</code>\n`;
    message += `- Interval polling cek: <code>${ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS} detik</code>\n`;
    message += `- Cooldown tombol cek: <code>${ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS} detik</code>\n`;
    message += `- Maksimal tekan tombol: <code>${ORDERKUOTA_CHECK_MAX_TAPS}x per transaksi</code>\n`;
    message += `- Auto-stop polling: <code>${ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES} menit</code>\n\n`;
    if (isGatewayEnabled('orderkuota')) {
      const endpointTest = await testOrderKuotaCreateEndpoint();
      message += `- Test endpoint create QR: <code>${escapeHtmlLocal(endpointTest.message)}</code>\n\n`;
    }

    message += '<b>GoPay</b>\n';
    message += `- Aktif: ${isGatewayEnabled('gopay') ? 'YA' : 'TIDAK'}\n`;
    message += `- Siap dipakai: ${readiness.gopay.ready ? 'YA' : 'TIDAK'}\n`;
    if (!readiness.gopay.ready) {
      message += `- Kurang: <code>${escapeHtmlLocal(readiness.gopay.missing.join(', '))}</code>\n`;
    }
    message += `- Base URL: <code>${escapeHtmlLocal(GOPAY_API_BASE_URL)}</code>\n`;
    message += `- API Key: <code>${escapeHtmlLocal(maskSecret(GOPAY_API_KEY))}</code>\n`;
    message += `- Expired QRIS: <code>${GOPAY_QR_EXPIRE_MINUTES} menit</code>\n`;
    message += `- Minimal TopUp: <code>Rp ${Math.round(getMinTopupByProvider('gopay')).toLocaleString('id-ID')}</code>\n`;

    if (isGatewayEnabled('gopay') && GOPAY_API_KEY) {
      try {
        const testRes = await axios.post(
          `${normalizeHttpUrl(GOPAY_API_BASE_URL) || 'https://api-gopay.sawargipay.cloud'}/transactions`,
          {},
          {
            headers: {
              Authorization: `Bearer ${GOPAY_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 8000
          }
        );
        const count = Number(testRes?.data?.data?.transactions?.length || 0);
        message += `- Test API: Berhasil (transaksi terbaca: ${count})\n`;
      } catch (err) {
        message += `- Test API: Gagal (${escapeHtmlLocal(String(err.message || 'unknown error'))})\n`;
      }
    }

    const danaStatus = loadDanaBridgeStatus();
    message += '\n\n<b>DANA Bisnis Notification Bridge</b>\n';
    message += `- Aktif: ${isGatewayEnabled('dana_notification') ? 'YA' : 'TIDAK'}\n`;
    message += `- Siap dipakai: ${readiness.danaNotification.ready ? 'YA' : 'TIDAK'}\n`;
    message += `- Aplikasi HP: ${readiness.danaNotification.online ? 'ONLINE' : 'OFFLINE'}\n`;
    if (!readiness.danaNotification.ready) {
      message += `- Kurang: <code>${escapeHtmlLocal(readiness.danaNotification.missing.join(', '))}</code>\n`;
    }
    message += `- Endpoint: <code>${escapeHtmlLocal(getDanaBridgePublicEventUrl() || '/payment/dana-notification')}</code>\n`;
    message += `- Device: <code>${escapeHtmlLocal(danaStatus.device_id || '-')}</code>\n`;
    message += `- Shared Secret: <code>${escapeHtmlLocal(maskSecret(DANA_BRIDGE_SECRET))}</code>\n`;
    message += `- QRIS: <code>${DANA_QRIS ? 'Tersimpan' : 'Belum diisi'}</code>\n`;
    message += `- Expired QRIS: <code>${DANA_BRIDGE_QR_EXPIRE_MINUTES} menit</code>\n`;
    message += `- Minimal TopUp: <code>Rp ${Math.round(getMinTopupByProvider('dana_notification')).toLocaleString('id-ID')}</code>\n`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`Gagal memeriksa konfigurasi: ${error.message}`);
  }
});

bot.command('syncservernow', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  try {
    await ctx.reply('Menjalankan sinkronisasi server...');
    const result = await syncServerUsageFromTunnel('manual_command', { force: true });

    const lines = [
      'Sync server selesai.',
      `Dicek: ${result.checked}`,
      `Berhasil: ${result.updated}`,
      `Gagal: ${result.failed}`,
      `Dilewati: ${result.skipped}`,
      '',
      `Total akun aktif: ${result.totals.used}`,
      `Total akun tersisa: ${result.totals.remaining}`,
      `Total kapasitas: ${result.totals.capacity}`
    ];

    if (result.errors.length > 0) {
      const preview = result.errors.slice(0, 5)
        .map((e) => `- ${e.serverName || e.serverId}: ${e.message}`)
        .join('\n');
      lines.push('', 'Detail gagal (maks 5):', preview);
    }

    await ctx.reply(lines.join('\n'));
  } catch (err) {
    logger.error('Gagal menjalankan sync server manual:', err.message);
    await ctx.reply('Gagal menjalankan sinkronisasi server.');
  }
});

bot.command('setserverbw', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const args = ctx.message.text.trim().split(/\s+/);
  if (args.length < 3 || args.length > 4) {
    return ctx.reply(
      'Format salah.\n' +
      'Gunakan: /setserverbw <server_id> <limit_tb> [avg_gb_per_user_per_hari]\n' +
      'Contoh: /setserverbw 1 25 8'
    );
  }

  const serverId = Number(args[1]);
  const limitTb = Number(args[2]);
  const avgUserDailyGb = args[3] !== undefined ? Number(args[3]) : 8;

  if (!Number.isFinite(serverId) || serverId <= 0) {
    return ctx.reply('server_id harus angka yang valid.');
  }
  if (!Number.isFinite(limitTb) || limitTb < 0) {
    return ctx.reply('limit_tb harus angka >= 0. Pakai 0 untuk menonaktifkan limit bandwidth.');
  }
  if (!Number.isFinite(avgUserDailyGb) || avgUserDailyGb <= 0) {
    return ctx.reply('avg_gb_per_user_per_hari harus angka > 0.');
  }

  db.run(
    'UPDATE Server SET bandwidth_limit_tb = ?, bandwidth_user_daily_gb = ? WHERE id = ?',
    [limitTb, avgUserDailyGb, serverId],
    async function (err) {
      if (err) {
        logger.error('Gagal set limit bandwidth server:', err.message);
        return ctx.reply('Terjadi kesalahan saat menyimpan limit bandwidth server.');
      }
      if (this.changes === 0) {
        return ctx.reply('Server tidak ditemukan.');
      }

      try {
        await syncServerUsageFromTunnel('setserverbw', { serverId, force: true });
      } catch (syncErr) {
        logger.warn(`Sync setelah setserverbw gagal: ${syncErr.message}`);
      }

      return ctx.reply(
        `Limit bandwidth server #${serverId} berhasil diupdate.\n` +
        `- Limit bulanan: ${limitTb.toFixed(2)} TB\n` +
        `- Asumsi rata-rata: ${avgUserDailyGb.toFixed(2)} GB/user/hari`
      );
    }
  );
});
// =================== COMMAND HAPUS SALDO ===================
bot.command('hapussaldo', async (ctx) => {
  try {
    const adminId = ctx.from.id;
    
    // Hanya admin
    if (!adminIds.includes(adminId)) {
      return ctx.reply('❌ *Hanya admin yang bisa menggunakan command ini!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.trim().split(/\s+/);
    if (args.length !== 3) {
      return ctx.reply('❌ *Format salah!*\n\nGunakan:\n`/hapussaldo <user_id> <jumlah>`\n\nContoh:\n`/hapussaldo 123456789 50000`', { parse_mode: 'Markdown' });
    }
    
    const targetUserId = args[1].trim();
    const amount = parseInt(args[2], 10);
    
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ *Jumlah harus angka positif lebih dari 0!*', { parse_mode: 'Markdown' });
    }
    
    // Cek apakah user ada
    db.get('SELECT user_id, saldo FROM users WHERE user_id = ?', [targetUserId], (err, user) => {
      if (err) {
        logger.error('❌ Error cek user:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }
      
      if (!user) {
        return ctx.reply(`❌ *User dengan ID ${targetUserId} tidak ditemukan!*`, { parse_mode: 'Markdown' });
      }
      
      // Cek apakah saldo mencukupi
      if (user.saldo < amount) {
        return ctx.reply(`❌ *Saldo user tidak mencukupi!*\n\nSaldo user: Rp ${user.saldo.toLocaleString('id-ID')}\nJumlah hapus: Rp ${amount.toLocaleString('id-ID')}\nKekurangan: Rp ${(amount - user.saldo).toLocaleString('id-ID')}`, { 
          parse_mode: 'Markdown' 
        });
      }
      
      // Lakukan pengurangan saldo
      db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, targetUserId], function (err) {
        if (err) {
          logger.error('❌ Error hapus saldo:', err.message);
          return ctx.reply('❌ Gagal menghapus saldo.');
        }
        
        if (this.changes === 0) {
          return ctx.reply('⚠️ Tidak ada user yang diupdate. Pastikan ID benar.');
        }
        
        // Ambil saldo terbaru
        db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err2, updatedRow) => {
          if (err2) {
            ctx.reply(`✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.`);
          } else {
            ctx.reply(
              `✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.\n💰 Saldo user sekarang: *Rp ${updatedRow.saldo.toLocaleString('id-ID')}*`,
              { parse_mode: 'Markdown' }
            );
          }
          
          // Log ke transactions
          const referenceId = `remove_saldo_${targetUserId}_${Date.now()}`;
          db.run(
            'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
            [targetUserId, amount, 'saldo_removed', referenceId, Date.now()],
            (err3) => {
              if (err3) logger.error('Gagal log transaksi hapus saldo:', err3.message);
            }
          );
          
          // Log di filestat
          logger.info(`Admin ${adminId} menghapus saldo Rp${amount} dari user ${targetUserId}. Saldo akhir: Rp${updatedRow ? updatedRow.saldo : 'N/A'}`);
        });
      });
    });
    
  } catch (e) {
    logger.error('❌ Error in /hapussaldo:', e);
    return ctx.reply('❌ Terjadi kesalahan internal.');
  }
});

//resellerstat
bot.command('resellerstats', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    // Cek apakah user reseller
    const isReseller = await isUserReseller(userId);
    
    if (!isReseller) {
      return ctx.reply('❌ *Fitur ini hanya untuk reseller!*', { parse_mode: 'Markdown' });
    }
    
    // Ambil saldo user
    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], async (err, user) => {
      if (err) {
        logger.error('❌ Error ambil saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil data.');
      }
      
      const saldo = user ? user.saldo : 0;
      
      // Hitung tanggal awal dan akhir bulan ini
      const now = new Date();
      const monthRange = getMonthRange(0);
      const startTimestamp = monthRange.start;
      const endTimestamp = monthRange.end;
      
      // Query transaksi bulan ini
      const query = `
        SELECT type, COUNT(*) as count, SUM(amount) as total 
        FROM transactions 
        WHERE user_id = ? 
          AND timestamp >= ? 
          AND timestamp < ?
          AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
          AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')
        GROUP BY type
      `;
      
      db.all(query, [userId, startTimestamp, endTimestamp], async (err, rows) => {
        if (err) {
          logger.error('❌ Error ambil transaksi:', err.message);
          return ctx.reply('❌ Terjadi kesalahan saat mengambil transaksi.');
        }
        
        const totalTopup = await new Promise((resolve) => {
          db.get(
            `SELECT SUM(amount) as total FROM transactions
             WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND type = 'deposit'`,
            [userId, startTimestamp, endTimestamp],
            (err2, row2) => resolve(!err2 && row2 && row2.total ? row2.total : 0)
          );
        });

        // Hitung total akun bulan ini
        let totalAccounts = 0;
        let totalRevenue = 0;
        const typeDetails = [];
        
        rows.forEach(row => {
          totalAccounts += row.count;
          totalRevenue += row.total || 0;
          const safeType = row.type.toUpperCase().replace(/_/g, '\\_');
          typeDetails.push(`• ${safeType}: ${row.count} akun`);
        });
        
        // Format pesan
        const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                          "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const currentMonth = monthNames[now.getMonth()];
        const currentYear = now.getFullYear();
        
        const message = 
          `📊 *STATISTIK RESELLER*\n` +
          `📅 Periode: ${currentMonth} ${currentYear}\n` +
          `👤 ID Reseller: ${userId}\n\n` +
          `💰 *Saldo Saat Ini:* Rp ${saldo.toLocaleString('id-ID')}\n` +
          `💳 *Top Up Bulan Ini:* Rp ${totalTopup.toLocaleString('id-ID')}\n\n` +
          `📈 *AKTIVITAS BULAN INI:*\n` +
          (typeDetails.length > 0 ? typeDetails.join('\n') : '• Belum ada transaksi') + `\n\n` +
          `📊 *TOTAL BULAN INI:*\n` +
          `• Jumlah Akun: ${totalAccounts} akun\n` +
          `• Total Pendapatan: Rp ${totalRevenue.toLocaleString('id-ID')}\n\n` +
          `📌 *Catatan:*\n` +
          `• Data diambil dari 1 ${currentMonth} ${currentYear}\n` +
          `• Hanya menampilkan transaksi pembuatan/perpanjangan akun\n` +
          `• Update real-time setiap transaksi`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
        // Log
        logger.info(`📊 Stats reseller ditampilkan untuk ${userId}: ${totalAccounts} akun bulan ini`);
      });
    });
    
  } catch (error) {
    logger.error('❌ Error di /resellerstats:', error);
    await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.');
  }
});

//allreseller stat
bot.command('allresellerstats', async (ctx) => {
  try {
    const adminId = ctx.from.id;
    
    // Hanya admin
    if (!adminIds.includes(adminId)) {
      return ctx.reply('❌ Hanya admin yang bisa menggunakan command ini!');
    }
    
    // Ambil semua user yang reseller
    const resellers = listResellersSync();
    
    if (resellers.length === 0) {
      return ctx.reply('📭 Belum ada reseller terdaftar.');
    }
    
    const now = new Date();
    const monthRange = getMonthRange(0);
    const startTimestamp = monthRange.start;
    const endTimestamp = monthRange.end;
    
    // Total semua
    let totalAllAccounts = 0;
    let totalAllRevenue = 0;
    let totalAllTopup = 0;
    
    const resellerStats = [];

    // Loop melalui setiap reseller
    for (const resellerId of resellers) {
      // Ambil saldo
      const user = await new Promise((resolve) => {
        db.get('SELECT saldo FROM users WHERE user_id = ?', [resellerId], (err, row) => {
          resolve(row || { saldo: 0 });
        });
      });
      
      // Ambil transaksi bulan ini
      const transactions = await new Promise((resolve) => {
        db.all(
          `SELECT COUNT(*) as count, SUM(amount) as total FROM transactions 
           WHERE user_id = ? AND timestamp >= ? AND timestamp < ? 
           AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
           AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`,
          [resellerId, startTimestamp, endTimestamp],
          (err, rows) => {
            resolve(rows[0] || { count: 0, total: 0 });
          }
        );
      });

      const topupTotal = await new Promise((resolve) => {
        db.get(
          `SELECT SUM(amount) as total FROM transactions
           WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND type = 'deposit'`,
          [resellerId, startTimestamp, endTimestamp],
          (err, row) => resolve(!err && row && row.total ? row.total : 0)
        );
      });
      
      // Tambah ke total
      totalAllAccounts += transactions.count;
      totalAllRevenue += transactions.total || 0;
      totalAllTopup += topupTotal;

      resellerStats.push({
        resellerId,
        saldo: user.saldo || 0,
        count: transactions.count || 0,
        total: transactions.total || 0,
        topup: topupTotal || 0
      });
    }

    resellerStats.sort((a, b) => b.total - a.total);

    const entries = [];
    for (const stat of resellerStats) {
      let usernameText = '-';
      try {
        const username = await getUsernameById(stat.resellerId);
        usernameText = username ? `@${username.replace(/^@/, '')}` : '-';
      } catch (e) {
        usernameText = '-';
      }
      const displayId = `<code>${stat.resellerId}</code>`;
      const entry =
        `<b>👤 Username:</b> ${escapeHtml(usernameText)}\n` +
        `<b>🆔 ID:</b> ${displayId}\n` +
        `<code>💰 Saldo:</code> Rp ${stat.saldo.toLocaleString('id-ID')}\n` +
        `<code>📊 Akun Bulan Ini:</code> ${stat.count}\n` +
        `<code>💵 Pendapatan:</code> Rp ${stat.total.toLocaleString('id-ID')}\n` +
        `<code>💳 Top Up Bulan Ini:</code> Rp ${stat.topup.toLocaleString('id-ID')}\n` +
        `────────────────────`;
      entries.push(entry);
    }

    const totalResellers = resellers.length;
    const periodText = escapeHtml(now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }));
    const summaryText =
      `\n<b>📈 RINGKASAN:</b>\n` +
      `• <b>Total Reseller:</b> ${totalResellers} orang\n` +
      `• <b>Total Akun Bulan Ini:</b> ${totalAllAccounts} akun\n` +
      `• <b>Total Pendapatan:</b> Rp ${totalAllRevenue.toLocaleString('id-ID')}\n` +
      `• <b>Total Top Up:</b> Rp ${totalAllTopup.toLocaleString('id-ID')}\n` +
      `• <b>Periode:</b> ${periodText}\n` +
      `• <b>Update:</b> ${escapeHtml(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }))}`;

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const pages = [];
    for (let page = 0; page < totalPages; page += 1) {
      const start = page * pageSize;
      const body = entries.slice(start, start + pageSize).join('\n');
      const header =
        `<b>📊 STATISTIK SEMUA RESELLER</b>\n` +
        `<i>📅 Periode: ${periodText}</i>\n` +
        `<i>📄 Halaman ${page + 1}/${totalPages}</i>\n\n`;
      const withSummary = page === totalPages - 1 ? `\n${summaryText}` : '';
      pages.push(`${header}${body}${withSummary}`);
    }

    const sessionKey = `${ctx.chat.id}:${adminId}`;
    allResellerStatsSessions.set(sessionKey, {
      ownerId: adminId,
      chatId: ctx.chat.id,
      pages,
      updatedAt: Date.now()
    });

    const firstKeyboard = totalPages > 1
      ? { inline_keyboard: [[{ text: 'Next ➡️', callback_data: 'allresellerstats_page_1' }]] }
      : null;
    const firstReplyOptions = { parse_mode: 'HTML' };
    if (firstKeyboard) firstReplyOptions.reply_markup = firstKeyboard;

    await ctx.reply(pages[0], firstReplyOptions);
    
    logger.info(`📊 Admin ${adminId} melihat statistik semua reseller`);
    
  } catch (error) {
    logger.error('❌ Error di /allresellerstats:', error);
    await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.');
  }
});

bot.action(/allresellerstats_page_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const adminId = ctx.from.id;
    if (!adminIds.includes(adminId)) {
      return ctx.reply('❌ Hanya admin yang bisa menggunakan menu ini!');
    }

    const sessionKey = `${ctx.chat.id}:${adminId}`;
    const session = allResellerStatsSessions.get(sessionKey);
    if (!session || !Array.isArray(session.pages) || session.pages.length === 0) {
      return ctx.reply('⚠️ Sesi statistik reseller sudah habis. Jalankan /allresellerstats lagi.');
    }

    const maxAgeMs = 10 * 60 * 1000;
    if (Date.now() - Number(session.updatedAt || 0) > maxAgeMs) {
      allResellerStatsSessions.delete(sessionKey);
      return ctx.reply('⚠️ Sesi statistik reseller sudah kadaluarsa. Jalankan /allresellerstats lagi.');
    }

    const totalPages = session.pages.length;
    let page = Number(ctx.match[1] || 0);
    if (!Number.isFinite(page)) page = 0;
    page = Math.max(0, Math.min(totalPages - 1, page));

    const row = [];
    if (page > 0) row.push({ text: '⬅️ Prev', callback_data: `allresellerstats_page_${page - 1}` });
    if (page < totalPages - 1) row.push({ text: 'Next ➡️', callback_data: `allresellerstats_page_${page + 1}` });
    const editOptions = { parse_mode: 'HTML' };
    if (row.length) editOptions.reply_markup = { inline_keyboard: [row] };
    await ctx.editMessageText(session.pages[page], editOptions);
  } catch (error) {
    logger.error('❌ Error pagination allresellerstats:', error.message);
    await ctx.reply('❌ Terjadi kesalahan saat membuka halaman statistik reseller.');
  }
});

// ✅ FUNGSI UNTUK ESCAPE HTML (untuk aman)
function escapeHtml(text) {
  if (!text && text !== 0) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getResellerStatsForPeriod(userId, startTimestamp, endTimestamp) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM transactions
       WHERE user_id = ?
        AND timestamp >= ?
        AND timestamp < ?
        AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
        AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`,
      [userId, startTimestamp, endTimestamp],
      (err, row) => {
        const count = !err && row ? row.count : 0;
        db.get(
          `SELECT SUM(amount) as total
           FROM transactions
           WHERE user_id = ?
             AND timestamp >= ?
              AND timestamp < ?
              AND type = 'deposit'`,
          [userId, startTimestamp, endTimestamp],
          (err2, row2) => {
            const total = !err2 && row2 && row2.total ? row2.total : 0;
            resolve({ count, topup: total });
          }
        );
      }
    );
  });
}

async function evaluateResellerTermsForPeriod(startTimestamp, endTimestamp, periodLabel) {
  const terms = loadResellerTerms();
  const resellers = listResellersSync();
  if (resellers.length === 0) return;

  for (const resellerId of resellers) {
    const stats = await getResellerStatsForPeriod(resellerId, startTimestamp, endTimestamp);
    const failedTopup = stats.topup < terms.min_topup;

    if (failedTopup) {
      removeReseller(resellerId);
      const message =
        `Syarat reseller bulan ${periodLabel} tidak terpenuhi.\n\n` +
        `Top up: ${formatRupiah(stats.topup)} (minimal ${formatRupiah(terms.min_topup)})\n\n` +
        'Status reseller dinonaktifkan. Untuk aktif kembali, hubungi admin.';
      try {
        await bot.telegram.sendMessage(resellerId, message);
      } catch (err) {
        logger.error('Gagal kirim notifikasi demote reseller:', err.message);
      }
      logger.info(`Reseller ${resellerId} diturunkan karena tidak memenuhi syarat bulan ${periodLabel}`);
    }
  }
}

////
bot.command('addserverzivpn_reseller', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('⚠️ Tidak ada izin.');
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const params = parts.slice(1);

  if (!(params.length === 7 || params.length === 10)) {
    return ctx.reply(
      '⚠️ Format:\n`/addserverzivpn_reseller <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>`\n\n' +
      'Format lama (7 argumen) masih didukung, semua harga akan disamakan.',
      { parse_mode: 'Markdown' }
    );
  }

  let domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas;
  if (params.length === 7) {
    [domain, auth, harga1, nama_server, quota, iplimit, batas] = params;
    harga2 = harga1;
    hargaRes1 = harga1;
    hargaRes2 = harga1;
  } else {
    [domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas] = params;
  }

  if (![harga1, harga2, hargaRes1, hargaRes2, quota, iplimit, batas].every(v => /^\d+$/.test(v))) {
    return ctx.reply('⚠️ harga, quota, iplimit, batas harus angka.');
  }

  db.run(
    `INSERT INTO Server
     (domain, auth, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, 0, 'ssh')`,
    [
      domain,
      auth,
      parseInt(harga1),
      parseInt(hargaRes1),
      parseInt(harga1),
      parseInt(harga2),
      parseInt(hargaRes1),
      parseInt(hargaRes2),
      nama_server,
      parseInt(quota),
      parseInt(iplimit),
      parseInt(batas)
    ],
    (err) => {
      if (err) {
        logger.error(err.message);
        return ctx.reply('❌ Gagal menambahkan server ZIVPN reseller.');
      }

      ctx.reply(
        `✅ Server *ZIVPN Reseller* \`${nama_server}\` berhasil ditambahkan.\n` +
        `• Harga User 1IP: Rp${parseInt(harga1).toLocaleString('id-ID')}\n` +
        `• Harga User 2IP: Rp${parseInt(harga2).toLocaleString('id-ID')}\n` +
        `• Harga Reseller 1IP: Rp${parseInt(hargaRes1).toLocaleString('id-ID')}\n` +
        `• Harga Reseller 2IP: Rp${parseInt(hargaRes2).toLocaleString('id-ID')}`,
        { parse_mode: 'Markdown' }
      );
    }
  );
});

//////
bot.command(['start', 'menu'], async (ctx) => {
  logger.info('Start or Menu command received');
  
  const userId = ctx.from.id;
  db.run('DELETE FROM broadcast_delivery_status WHERE user_id = ?', [userId], (err) => {
    if (err) logger.warn(`Gagal mengaktifkan ulang penerima broadcast ${userId}: ${err.message}`);
  });
  // hapus pesan /start atau /menu agar tidak menumpuk
  if (ctx.message && ctx.message.text && (ctx.message.text.startsWith('/start') || ctx.message.text.startsWith('/menu'))) {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // ignore jika tidak bisa dihapus
    }
  }
  ctx.state = ctx.state || {};
  ctx.state.forceNewMenu = true;
  db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      logger.error('Kesalahan saat memeriksa user_id:', err.message);
      return;
    }

    if (row) {
      logger.info(`User ID ${userId} sudah ada di database`);
    } else {
      db.run('INSERT INTO users (user_id) VALUES (?)', [userId], (err) => {
        if (err) {
          logger.error('Kesalahan saat menyimpan user_id:', err.message);
        } else {
          logger.info(`User ID ${userId} berhasil disimpan`);
        }
      });
    }
  });

  await sendMainMenu(ctx);
});

cleanupExpiredAccounts();
////////////////
// Manual admin command: /addsaldo <user_id> <jumlah>
bot.command('addsaldo', async (ctx) => {
  try {
    const userId = ctx.message.from.id;

    // hanya admin
    if (!adminIds || !adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.');
    }

    const args = ctx.message.text.trim().split(/\s+/);
    if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah.\nGunakan:\n`/addsaldo <user_id> <jumlah>`', { parse_mode: 'Markdown' });
    }

    const targetUserId = args[1].trim();
    const amount = parseInt(args[2], 10);

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Jumlah saldo harus berupa angka dan lebih dari 0.');
    }

    // Cek apakah user ada
    db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err, row) => {
      if (err) {
        logger.error('❌ Gagal memeriksa user_id:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }

      if (!row) {
        return ctx.reply(`⚠️ User dengan ID ${targetUserId} belum terdaftar di database.`);
      }

      // Lakukan update saldo
      db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetUserId], function (err) {
        if (err) {
          logger.error('❌ Gagal menambah saldo:', err.message);
          return ctx.reply('❌ Gagal menambah saldo.');
        }

        // pastikan ada perubahan (this.changes tersedia karena function)
        if (this.changes === 0) {
          return ctx.reply('⚠️ Tidak ada user yang diupdate. Pastikan ID benar.');
        }

// Ambil saldo terbaru dan kirim ke Telegram + log
db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], async (err2, updatedRow) => {
  if (err2 || !updatedRow) {
    logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetUserId}, namun gagal membaca saldo terbaru.`);
    await ctx.reply(`✅ Saldo sebesar Rp${amount.toLocaleString()} berhasil ditambahkan ke user ${targetUserId}.`);
    await bot.telegram.sendMessage(
      targetUserId,
      `✅ Saldo Anda berhasil ditambahkan admin.\n` +
      `💰 Nominal: Rp${amount.toLocaleString('id-ID')}`
    ).catch((notifyErr) => {
      logger.error(`Gagal kirim notifikasi tambah saldo ke ${targetUserId}: ${notifyErr.message}`);
    });
    return;
  }

          // Kirim pesan ke Telegram dengan saldo akhir
          await ctx.reply(
            `✅ Saldo sebesar *Rp${amount.toLocaleString()}* berhasil ditambahkan ke user \`${targetUserId}\`.\n💰 Saldo user sekarang: *Rp${updatedRow.saldo.toLocaleString()}*`,
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendMessage(
            targetUserId,
            `✅ Saldo Anda berhasil ditambahkan admin.\n` +
            `💰 Nominal: Rp${amount.toLocaleString('id-ID')}\n` +
            `🏦 Saldo sekarang: Rp${updatedRow.saldo.toLocaleString('id-ID')}`
          ).catch((notifyErr) => {
            logger.error(`Gagal kirim notifikasi tambah saldo ke ${targetUserId}: ${notifyErr.message}`);
          });

          // Log di file
          logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetUserId}. Saldo user sekarang: Rp${updatedRow.saldo}`);
        });
      });
    });
  } catch (e) {
    logger.error('❌ Error in /addsaldo command:', e);
    return ctx.reply('❌ Terjadi kesalahan internal saat memproses perintah.');
  }
});

//////////////////
bot.command('admin', async (ctx) => {
  logger.info('Admin menu requested');
  
  if (!adminIds.includes(ctx.from.id)) {
    await ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu admin.');
    return;
  }

  await sendAdminMenu(ctx);
});

async function sendMainMenu(ctx) {
  // Ambil data user
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || '-';
  let saldoVpn = 0;
  let saldoPpob = 0;
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT saldo, saldo_ppob FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
    saldoVpn = row ? Number(row.saldo || 0) : 0;
    saldoPpob = row ? Number(row.saldo_ppob || 0) : 0;
  } catch (e) { saldoVpn = 0; saldoPpob = 0; }

  // Statistik user
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let globalToday = 0, globalWeek = 0, globalMonth = 0, globalAllTime = 0;
  try {
    [
      globalToday,
      globalWeek,
      globalMonth,
      globalAllTime
    ] = await Promise.all([
      getAccountTransactionCount({ startTs: todayStart }),
      getAccountTransactionCount({ startTs: weekStart }),
      getAccountTransactionCount({ startTs: monthStart }),
      getAccountTransactionCount()
    ]);
  } catch (e) {
    logger.error('Gagal mengambil statistik menu utama:', e.message);
  }

  // Jumlah pengguna bot
  let jumlahPengguna = 0;
  
  // Cek status reseller - GUNAKAN VARIABLE YANG SUDAH ADA
  let isReseller = false;
  if (fs.existsSync(resselFilePath)) {
    const resellerList = fs.readFileSync(resselFilePath, 'utf8').split('\n').map(x => x.trim());
    isReseller = resellerList.includes(userId.toString());
  }
  const statusReseller = isReseller ? 'Reseller' : 'Bukan Reseller';
  
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS count FROM users', (err, row) => { if (err) reject(err); else resolve(row); });
    });
    jumlahPengguna = row.count;
  } catch (e) { jumlahPengguna = 0; }

  // Latency (dummy, bisa diubah sesuai kebutuhan)
  const latency = (Math.random() * 0.1 + 0.01).toFixed(2);
  const adminDisplayName = getAdminTelegramUsername();
  const cleanStoreName = String(NAMA_STORE || '').trim().replace(/^@+/, '');
  const botTitle = /^bot\s*vpn\b/i.test(cleanStoreName)
    ? cleanStoreName
    : `BOT VPN ${cleanStoreName || 'BOTVPN'}`;
  const communityInfoLines = [
    MAIN_MENU_GROUP_ENABLED && MAIN_MENU_GROUP_URL
      ? `🔗 Grup   : ${formatMainMenuLinkText(MAIN_MENU_GROUP_LABEL || 'Grup Telegram', true, MAIN_MENU_GROUP_URL)}`
      : '',
    MAIN_MENU_CHANNEL_ENABLED && MAIN_MENU_CHANNEL_URL
      ? `📢 Channel: ${formatMainMenuLinkText(MAIN_MENU_CHANNEL_LABEL || 'Channel Telegram', true, MAIN_MENU_CHANNEL_URL)}`
      : ''
  ].filter(Boolean);
  const communityInfoText = communityInfoLines.length ? `\n${communityInfoLines.join('\n')}` : '';

  const messageText = `
<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>
<b>    ${escapeHtml(botTitle)}</b>
<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>

<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>
<b>    STATISTIK BOT</b>
<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>
📅 Hari ini   : ${globalToday} akun
📆 Minggu ini : ${globalWeek} akun
🗓️ Bulan ini  : ${globalMonth} akun
📦 Total akun : ${globalAllTime} akun
👥 Users      : ${jumlahPengguna}
<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>

<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>
<b>    STATUS SISTEM</b>
<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>
⏱️ Latency : ${latency} ms
👨‍💻 Admin  : ${escapeHtml(adminDisplayName)}${communityInfoText}
<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>

<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>
<b>    INFORMASI AKUN</b>
<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>
👤 Username: ${escapeHtml(userName)}
🆔 ID Tele :<code>${userId}</code>
🏷️ Status  :${escapeHtml(statusReseller)}
💰 VPN     : ${escapeHtml(formatRupiah(saldoVpn))}
🛒 PPOB    : ${escapeHtml(formatRupiah(saldoPpob))}
<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>
`;

  // Susun semua tombol menu utama sebagai daftar flat dulu, baru dirapikan 2 tombol per baris.
  // Urutan sengaja disusun biar tiap pasangan dalam 1 baris panjang teksnya mirip (gak ada yg nonjol).
  let menuButtons = [
    { text: 'Menu VPN', callback_data: 'menu_vpn' },
    { text: 'Menu PPOB', callback_data: 'ppob_menu' },
    { text: 'Tools', callback_data: 'menu_tools' },
    { text: 'Admin', callback_data: 'hubungi_admin' }
  ];

  if (MAIN_MENU_TUTORIAL_ENABLED) {
    menuButtons.push({ text: 'Tutorial', callback_data: 'tutorial_bot' });
  }

  menuButtons.push({ text: 'Statistik', callback_data: 'global_stats_detail' });

  if (loadScNexusMenuSetting()) {
    menuButtons.push({ text: 'SC Nexus', url: 'https://t.me/sc1forcrnexusbot' });
  }

  if (loadTopupAutoSetting()) {
    menuButtons.push({ text: 'TopUp Auto', callback_data: 'topup_saldo' });
  }
  if (loadTopupManualSetting()) {
    menuButtons.push({ text: 'TopUp QRIS', callback_data: 'topup_manual' });
  }

  menuButtons.push({ text: 'Join Reseller', callback_data: 'jadi_reseller' });

  // Rapikan jadi baris berisi 2 tombol; sisa ganjil (kalau ada) jadi baris terakhir sendiri.
  let keyboard = [];
  for (let i = 0; i < menuButtons.length; i += 2) {
    keyboard.push(menuButtons.slice(i, i + 2));
  }

  if (isReseller) {
    logger.info('🛡️ Menu reseller ditampilkan untuk user: ' + userId);
  }

  try {
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(messageText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
          lastMenuMessageId.set(userId, ctx.callbackQuery.message.message_id);
        }
      } catch (error) {
        if (error && error.response && error.response.error_code === 400 &&
            (error.response.description.includes('message is not modified') ||
             error.response.description.includes('message to edit not found') ||
             error.response.description.includes('message can\'t be edited'))
        ) {
          logger.info('Edit message diabaikan karena pesan sudah diedit/dihapus atau tidak berubah.');
        } else {
          logger.error('Error saat mengedit menu utama:', error);
        }
      }
    } else {
      try {
        const forceNewMenu = ctx.state && ctx.state.forceNewMenu;
        const isStartCommand = forceNewMenu || (ctx.message && typeof ctx.message.text === 'string' && (ctx.message.text.startsWith('/start') || ctx.message.text.startsWith('/menu')));
        if (isStartCommand) {
          if (lastMenuMessageId.has(userId)) {
            try {
              await ctx.telegram.deleteMessage(userId, lastMenuMessageId.get(userId));
            } catch (e) {
              // ignore if cannot delete
            }
          }
          const sent = await ctx.reply(messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
          if (sent && sent.message_id) {
            lastMenuMessageId.set(userId, sent.message_id);
          }
          logger.info('Main menu sent');
          return;
        }

        if (lastMenuMessageId.has(userId)) {
          try {
            await ctx.telegram.editMessageText(
              userId,
              lastMenuMessageId.get(userId),
              null,
              messageText,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
            );
          } catch (e) {
            // fallback: hapus lama lalu kirim baru
            try {
              await ctx.telegram.deleteMessage(userId, lastMenuMessageId.get(userId));
            } catch (delErr) {
              // ignore jika tidak bisa dihapus
            }
            const sent = await ctx.reply(messageText, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: keyboard }
            });
            if (sent && sent.message_id) {
              lastMenuMessageId.set(userId, sent.message_id);
            }
          }
        } else {
          const sent = await ctx.reply(messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
          if (sent && sent.message_id) {
            lastMenuMessageId.set(userId, sent.message_id);
          }
        }
      } catch (error) {
        logger.error('Error saat mengirim menu utama:', error);
      }
    }
    logger.info('Main menu sent');
  } catch (error) {
    logger.error('Error umum saat mengirim menu utama:', error);
  }
}

bot.command('hapuslog', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Tidak ada izin!');
  try {
    if (fs.existsSync('bot-combined.log')) fs.unlinkSync('bot-combined.log');
    if (fs.existsSync('bot-error.log')) fs.unlinkSync('bot-error.log');
    ctx.reply('Log berhasil dihapus.');
    logger.info('Log file dihapus oleh admin.');
  } catch (e) {
    ctx.reply('Gagal menghapus log: ' + e.message);
    logger.error('Gagal menghapus log: ' + e.message);
  }
});

bot.command('restartserver', async (ctx) => {
  const userId = ctx.from?.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Tidak ada izin!');
  }

  const rawTarget = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim();
  const defaultTarget = process.env.pm_id || process.env.name || 'all';
  const target = rawTarget || String(defaultTarget);

  if (!/^[a-zA-Z0-9_.-]+$/.test(target)) {
    return ctx.reply('Target restart tidak valid. Gunakan nama app PM2 atau id numerik.');
  }

  await ctx.reply('Menjalankan restart PM2: ' + target);

  exec('pm2 restart ' + target, (error, stdout, stderr) => {
    if (error) {
      logger.error('Gagal restart PM2 via Telegram: ' + error.message);
      return ctx.reply('Gagal restart PM2: ' + error.message);
    }

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const safeOutput = output ? output.slice(0, 1200) : 'OK';
    return ctx.reply('Restart PM2 berhasil.\n' + safeOutput);
  });
});

async function sendHelpAdmin(ctx) {
  const userId = ctx.from?.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }
  
  const helpMessage = `
*Daftar Perintah Admin:*

1. /addsaldo - Menambahkan saldo ke akun pengguna.
2. /hapussaldo - Menghapus saldo dari akun pengguna.
3. /addserver - Menambahkan server baru.
4. /addserver_reseller - Menambahkan server khusus reseller.
5. /addserverzivpn - Menambahkan server ZIVPN.
6. /addserverzivpn_reseller - Menambahkan server ZIVPN khusus reseller.
7. /addressel - Menambahkan reseller baru.
8. /delressel - Menghapus ID reseller.
9. /broadcast - Mengirim pesan siaran ke semua pengguna.
10. /broadcastreseller - Mengirim pesan siaran khusus reseller.
11. /broadcastpoll - Mengirim polling ke semua pengguna.
12. /editharga - Mengedit harga layanan.
13. /edithargareseller - Mengedit harga reseller (legacy).
14. /editauth - Mengedit auth server.
15. /editdomain - Mengedit domain server.
16. /editlimitcreate - Mengedit batas pembuatan akun server.
17. /editlimitip - Mengedit batas IP server.
18. /editlimitquota - Mengedit quota server per hari.
19. /editnama - Mengedit nama server.
20. /edittotalcreate - Mengedit total pembuatan akun server.
21. /syncservernow - Sinkronisasi data akun dan bandwidth server.
22. /setserverbw <id> <limit_tb> [estimasi_gb_per_user_hari] - Set limit bandwidth server via command.
23. /checkpaymentconfig - Cek konfigurasi payment API.
24. /allresellerstats - Ambil data statistik semua reseller.
25. /resellerstats - Ambil data statistik reseller sendiri.
26. /restartserver [target] - Restart app PM2 dari Telegram.
27. /hapuslog - Menghapus log bot.

Menu Admin > Server > Atur Harga Masa Aktif: aktif/nonaktif harga harian dan 30 hari, edit per server, dan edit global semua server.

Gunakan perintah dengan format yang benar untuk menghindari kesalahan.
`;
  ctx.reply(helpMessage);
}

bot.command('helpadmin', async (ctx) => {
  await sendHelpAdmin(ctx);
});

//////////
bot.command('addserver_reseller', async (ctx) => {
  try {
    const params = ctx.message.text.trim().split(/\s+/).slice(1);
    if (!(params.length === 7 || params.length === 10)) {
      return ctx.reply(
        '⚠️ Format salah!\n\n' +
        'Format baru:\n/addserver_reseller <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>\n\n' +
        'Format lama (7 argumen) masih didukung, semua harga akan disamakan.',
        { parse_mode: 'Markdown' }
      );
    }

    let domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun;
    if (params.length === 7) {
      [domain, auth, harga1, nama_server, quota, iplimit, batas_create_akun] = params;
      harga2 = harga1;
      hargaRes1 = harga1;
      hargaRes2 = harga1;
    } else {
      [domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun] = params;
    }

    if (![harga1, harga2, hargaRes1, hargaRes2, quota, iplimit, batas_create_akun].every(v => /^\d+$/.test(v))) {
      return ctx.reply('⚠️ Semua nilai harga/quota/iplimit/batas harus angka.', { parse_mode: 'Markdown' });
    }

    db.run(`INSERT INTO Server (domain, auth, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, nama_server, quota, iplimit, batas_create_akun, is_reseller_only, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 'ssh')`,
      [
        domain,
        auth,
        parseInt(harga1),
        parseInt(hargaRes1),
        parseInt(harga1),
        parseInt(harga2),
        parseInt(hargaRes1),
        parseInt(hargaRes2),
        nama_server,
        quota,
        iplimit,
        batas_create_akun
      ],
      function (err) {
        if (err) {
          logger.error('❌ Gagal menambah server reseller:', err.message);
          return ctx.reply('❌ *Gagal menambah server reseller.*', { parse_mode: 'Markdown' });
        }
        ctx.reply(
          '✅ *Server khusus reseller berhasil ditambahkan!*\n' +
          `• Harga User 1IP: Rp${parseInt(harga1).toLocaleString('id-ID')}\n` +
          `• Harga User 2IP: Rp${parseInt(harga2).toLocaleString('id-ID')}\n` +
          `• Harga Reseller 1IP: Rp${parseInt(hargaRes1).toLocaleString('id-ID')}\n` +
          `• Harga Reseller 2IP: Rp${parseInt(hargaRes2).toLocaleString('id-ID')}`,
          { parse_mode: 'Markdown' }
        );
      }
    );
  } catch (e) {
    logger.error('Error di /addserver_reseller:', e);
    ctx.reply('❌ *Terjadi kesalahan.*', { parse_mode: 'Markdown' });
  }
});
//////////
const activeBroadcastJobs = new Map();
const MAX_ACTIVE_BROADCAST_JOBS = 3;
const waitForBroadcastSendSlot = createRateLimiter(BROADCAST_SEND_INTERVAL_MS);
let broadcastJobSequence = 0;

async function getReachableBroadcastUserIds() {
  const rows = await dbAllAsync(
    `SELECT u.user_id
     FROM users u
     LEFT JOIN broadcast_delivery_status b ON b.user_id = u.user_id
     WHERE COALESCE(b.status, 'active') <> 'unreachable'
     ORDER BY u.id ASC`
  );
  return rows.map((row) => Number(row.user_id)).filter((id) => Number.isSafeInteger(id) && id !== 0);
}

async function filterReachableBroadcastIds(ids) {
  const blockedRows = await dbAllAsync(
    "SELECT user_id FROM broadcast_delivery_status WHERE status = 'unreachable'"
  );
  const blocked = new Set(blockedRows.map((row) => Number(row.user_id)));
  return Array.from(new Set(ids)).filter((id) => !blocked.has(Number(id)));
}

async function recordBroadcastFailure(result) {
  if (result.ok || !result.error) return;
  const status = result.error.permanent ? 'unreachable' : 'active';
  await dbRunAsync(
    `INSERT INTO broadcast_delivery_status (user_id, status, fail_count, last_error, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       status = excluded.status,
       fail_count = broadcast_delivery_status.fail_count + 1,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [result.recipient, status, String(result.error.description || '').slice(0, 500), Date.now()]
  );
}

async function deliverBroadcastPayload(chatId, payload, signal) {
  if (payload?.type === 'photo' && payload?.fileId) {
    return bot.telegram.callApi(
      'sendPhoto',
      {
        chat_id: chatId,
        photo: payload.fileId,
        ...(payload.caption ? { caption: payload.caption } : {})
      },
      { signal }
    );
  }

  return bot.telegram.callApi(
    'sendMessage',
    {
      chat_id: chatId,
      text: String(payload?.text || ''),
      ...(payload?.options || {})
    },
    { signal }
  );
}

function queueBroadcastJob({ label, recipientIds, payload, reportChatId }) {
  const recipients = Array.from(new Set(
    (recipientIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id !== 0)
  ));
  if (!recipients.length) return { started: false, total: 0, reason: 'empty' };
  if (activeBroadcastJobs.size >= MAX_ACTIVE_BROADCAST_JOBS) {
    return { started: false, total: recipients.length, reason: 'busy' };
  }

  broadcastJobSequence += 1;
  const jobId = `${Date.now().toString(36)}-${broadcastJobSequence.toString(36)}`;
  const startedAt = Date.now();
  const jobPromise = runBroadcastDelivery({
    recipients,
    concurrency: BROADCAST_CONCURRENCY,
    waitForSlot: waitForBroadcastSendSlot,
    timeoutMs: BROADCAST_RECIPIENT_TIMEOUT_MS,
    maxRetries: 1,
    deliver: (chatId, delivery) => deliverBroadcastPayload(chatId, payload, delivery.signal),
    onResult: async (item, progress) => {
      await recordBroadcastFailure(item).catch((err) => {
        logger.warn(`Gagal menyimpan status broadcast ${item.recipient}: ${err.message}`);
      });
      const done = progress.ok + progress.fail;
      if (done % 100 === 0 || done === progress.total) {
        logger.info(`Broadcast ${jobId}: ${done}/${progress.total}, berhasil=${progress.ok}, gagal=${progress.fail}`);
      }
    }
  });

  activeBroadcastJobs.set(jobId, { label, startedAt, total: recipients.length, promise: jobPromise });
  jobPromise
    .then(async (result) => {
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      logger.info(`Broadcast ${jobId} selesai: berhasil=${result.ok}, gagal=${result.fail}, unreachable=${result.unreachable}`);
      if (reportChatId) {
        await bot.telegram.sendMessage(
          reportChatId,
          `✅ ${label} selesai.\n` +
          `- Job: ${jobId}\n` +
          `- Berhasil: ${result.ok}\n` +
          `- Gagal: ${result.fail}\n` +
          `- Tidak terjangkau: ${result.unreachable}\n` +
          `- Timeout: ${result.timeout}\n` +
          `- Durasi: ${durationSeconds} detik`
        ).catch(() => {});
      }
    })
    .catch(async (err) => {
      logger.error(`Broadcast ${jobId} gagal: ${err.message || err}`);
      if (reportChatId) {
        await bot.telegram.sendMessage(reportChatId, `❌ ${label} gagal.\nJob: ${jobId}\nError: ${err.message || err}`).catch(() => {});
      }
    })
    .finally(() => {
      activeBroadcastJobs.delete(jobId);
    });

  return { started: true, total: recipients.length, jobId };
}

function formatBroadcastQueuedMessage(result, label = 'Broadcast') {
  if (result?.reason === 'busy') {
    return `⚠️ ${label} belum dimulai karena sudah ada terlalu banyak job aktif. Coba lagi setelah salah satu job selesai.`;
  }
  if (!result?.started) {
    return `ℹ️ ${label} tidak dimulai karena tidak ada penerima aktif.`;
  }
  return (
    `✅ ${label} dimulai di background.\n` +
    `- Job: ${result.jobId}\n` +
    `- Penerima: ${result.total}\n\n` +
    'Bot tetap bisa dipakai selama pengiriman. Laporan akhir akan dikirim otomatis.'
  );
}

async function broadcastToAllUsers(payload, reportChatId = 0, label = 'Broadcast') {
  const recipientIds = await getReachableBroadcastUserIds();
  return queueBroadcastJob({ label, recipientIds, payload, reportChatId });
}

async function broadcastMessageToAllUsers(message, reportChatId = 0) {
  return broadcastToAllUsers(
    { type: 'text', text: String(message || '') },
    reportChatId,
    'Broadcast pesan'
  );
}

async function broadcastMessageToResellers(message, reportChatId = 0) {
  const resellerIds = listResellersSync()
    .map((id) => Number(String(id || '').trim()))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (resellerIds.length === 0) {
    return { started: false, total: 0, reason: 'empty' };
  }
  const recipientIds = await filterReachableBroadcastIds(resellerIds);
  return queueBroadcastJob({
    label: 'Broadcast reseller',
    recipientIds,
    payload: { type: 'text', text: String(message || '') },
    reportChatId
  });
}

function buildBroadcastPollText(question, options, counts, totalVotes, userChoiceIndex = -1) {
  const lines = ['*Polling Broadcast*', '', question, ''];
  for (let i = 0; i < options.length; i++) {
    const count = Number(counts[i] || 0);
    const pct = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : '0.0';
    const me = userChoiceIndex === i ? ' (pilihan kamu)' : '';
    lines.push((i + 1) + '. ' + options[i] + ' -> ' + count + ' vote (' + pct + '%)' + me);
  }
  lines.push('');
  lines.push('Total vote: ' + totalVotes);
  return lines.join('\n');
}

function buildBroadcastPollKeyboard(pollId, options) {
  const rows = options.map((opt, idx) => ([{ text: opt, callback_data: 'bpv_' + pollId + '_' + idx }]));
  rows.push([{ text: 'Refresh Hasil', callback_data: 'bpr_' + pollId }]);
  return { inline_keyboard: rows };
}

async function createBroadcastPoll(question, options, createdBy) {
  const now = Date.now();
  const result = await dbRunAsync(
    'INSERT INTO broadcast_polls (question, options_json, created_by, created_at, is_active) VALUES (?, ?, ?, ?, 1)',
    [question, JSON.stringify(options), Number(createdBy || 0), now]
  );
  return result.lastID;
}

async function getBroadcastPollById(pollId) {
  const rows = await dbAllAsync(
    'SELECT id, question, options_json, is_active FROM broadcast_polls WHERE id = ? LIMIT 1',
    [pollId]
  );
  const row = rows[0];
  if (!row) return null;
  let options = [];
  try {
    const parsed = JSON.parse(row.options_json || '[]');
    options = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    options = [];
  }
  return {
    id: Number(row.id),
    question: String(row.question || ''),
    isActive: Number(row.is_active || 0) === 1,
    options
  };
}

async function getBroadcastPollStats(pollId, optionCount) {
  const rows = await dbAllAsync(
    'SELECT option_index, COUNT(*) as c FROM broadcast_poll_votes WHERE poll_id = ? GROUP BY option_index',
    [pollId]
  );
  const counts = new Array(optionCount).fill(0);
  let total = 0;
  for (const row of rows) {
    const idx = Number(row.option_index);
    const c = Number(row.c || 0);
    if (idx >= 0 && idx < optionCount) {
      counts[idx] = c;
      total += c;
    }
  }
  return { counts, total };
}

async function getUserBroadcastPollChoice(pollId, userId) {
  const rows = await dbAllAsync(
    'SELECT option_index FROM broadcast_poll_votes WHERE poll_id = ? AND user_id = ? LIMIT 1',
    [pollId, userId]
  );
  if (!rows[0]) return -1;
  return Number(rows[0].option_index);
}

async function upsertBroadcastPollVote(pollId, userId, optionIndex) {
  const now = Date.now();
  await dbRunAsync('DELETE FROM broadcast_poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]);
  await dbRunAsync(
    'INSERT INTO broadcast_poll_votes (poll_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)',
    [pollId, userId, optionIndex, now]
  );
}

const BROADCAST_POLL_RETENTION_DAYS = 7;

async function cleanupOldBroadcastPolls(retentionDays = BROADCAST_POLL_RETENTION_DAYS) {
  try {
    const threshold = Date.now() - (Math.max(1, Number(retentionDays) || 7) * 24 * 60 * 60 * 1000);
    const oldRows = await dbAllAsync(
      'SELECT id FROM broadcast_polls WHERE COALESCE(created_at, 0) > 0 AND created_at < ?',
      [threshold]
    );
    if (!oldRows.length) return 0;

    const ids = oldRows.map(r => Number(r.id)).filter(Number.isFinite);
    if (!ids.length) return 0;

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    for (const id of ids) {
      await dbRunAsync('DELETE FROM broadcast_poll_votes WHERE poll_id = ?', [id]);
      await dbRunAsync('DELETE FROM broadcast_polls WHERE id = ?', [id]);
    }
    await dbRunAsync('COMMIT');

    logger.info('Cleanup polling broadcast: ' + ids.length + ' polling lama dihapus');
    return ids.length;
  } catch (err) {
    try { await dbRunAsync('ROLLBACK'); } catch (_) {}
    logger.error('Gagal cleanup polling broadcast:', err.message);
    return 0;
  }
}

async function broadcastPollToAllUsers(question, options, createdBy = 0, reportChatId = 0) {
  const pollId = await createBroadcastPoll(question, options, createdBy);
  const stats = await getBroadcastPollStats(pollId, options.length);
  const text = buildBroadcastPollText(question, options, stats.counts, stats.total, -1);
  const keyboard = buildBroadcastPollKeyboard(pollId, options);
  const recipientIds = await getReachableBroadcastUserIds();
  const job = queueBroadcastJob({
    label: `Broadcast polling #${pollId}`,
    recipientIds,
    payload: {
      type: 'text',
      text,
      options: { parse_mode: 'Markdown', reply_markup: keyboard }
    },
    reportChatId
  });
  return { ...job, pollId };
}

//////////
bot.action(/bpv_(\d+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pollId = Number(ctx.match[1]);
  const optionIndex = Number(ctx.match[2]);
  const userId = Number(ctx.from.id);

  try {
    const poll = await getBroadcastPollById(pollId);
    if (!poll || !poll.isActive) {
      return ctx.reply('Polling tidak ditemukan atau sudah ditutup.');
    }

    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
      return ctx.reply('Opsi polling tidak valid.');
    }

    await upsertBroadcastPollVote(pollId, userId, optionIndex);
    const stats = await getBroadcastPollStats(pollId, poll.options.length);
    const myChoice = await getUserBroadcastPollChoice(pollId, userId);
    const text = buildBroadcastPollText(poll.question, poll.options, stats.counts, stats.total, myChoice);
    const keyboard = buildBroadcastPollKeyboard(pollId, poll.options);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (e) {
    const errText = String(
      e?.response?.description ||
      e?.description ||
      e?.message ||
      e
    );

    if (/message is not modified/i.test(errText)) {
      return ctx.answerCbQuery('Belum ada perubahan hasil.', { show_alert: false }).catch(() => {});
    }

    logger.error('Error vote broadcast poll: ' + errText);
    await ctx.reply('Terjadi kesalahan saat menyimpan vote.');
  }
});

bot.action(/bpr_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pollId = Number(ctx.match[1]);
  const userId = Number(ctx.from.id);

  try {
    const poll = await getBroadcastPollById(pollId);
    if (!poll || !poll.isActive) {
      return ctx.reply('Polling tidak ditemukan atau sudah ditutup.');
    }

    const stats = await getBroadcastPollStats(pollId, poll.options.length);
    const myChoice = await getUserBroadcastPollChoice(pollId, userId);
    const text = buildBroadcastPollText(poll.question, poll.options, stats.counts, stats.total, myChoice);
    const keyboard = buildBroadcastPollKeyboard(pollId, poll.options);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (e) {
    const errText = String(
      e?.response?.description ||
      e?.description ||
      e?.message ||
      e
    );

    if (/message is not modified/i.test(errText)) {
      return ctx.answerCbQuery('Belum ada perubahan hasil.', { show_alert: false }).catch(() => {});
    }

    logger.error('Error refresh broadcast poll: ' + errText);
    await ctx.reply('Terjadi kesalahan saat refresh hasil polling.');
  }
});

bot.command('broadcast', async (ctx) => {
  const userId = ctx.message.from.id;
  logger.info(`Broadcast command received from user_id: ${userId}`);
  if (!adminIds.includes(userId)) {
      logger.info(`⚠️ User ${userId} tidak memiliki izin untuk menggunakan perintah ini.`);
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const commandPattern = /^\/broadcast(?:@\w+)?\s*/i;
  const rawText = ctx.message.text || '';
  const repliedMessage = ctx.message.reply_to_message || null;
  const sourcePhoto = repliedMessage?.photo?.length
    ? repliedMessage.photo[repliedMessage.photo.length - 1]
    : (ctx.message.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : null);

  if (sourcePhoto?.file_id) {
    const rawCaption = repliedMessage
      ? (repliedMessage.caption || repliedMessage.text || '')
      : (ctx.message.caption || '');
    const caption = repliedMessage ? rawCaption : rawCaption.replace(commandPattern, '').trim();
    const result = await broadcastToAllUsers({
      type: 'photo',
      fileId: sourcePhoto.file_id,
      caption: caption || ''
    }, ctx.chat.id, 'Broadcast foto');

    return ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast foto'));
  }

  const message = repliedMessage
    ? (repliedMessage.text || repliedMessage.caption || '')
    : rawText.replace(commandPattern, '');

  if (!String(message || '').trim()) {
      logger.info('⚠️ Pesan untuk disiarkan tidak diberikan.');
      return ctx.reply(
        '⚠️ Mohon berikan pesan untuk disiarkan.\n' +
        'Kamu juga bisa kirim foto + caption pakai /broadcast.',
        { parse_mode: 'Markdown' }
      );
  }

  const result = await broadcastMessageToAllUsers(String(message).trim(), ctx.chat.id);
  return ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast pesan'));
});

bot.on('photo', async (ctx, next) => {
  try {
    const caption = String(ctx.message?.caption || '').trim();
    if (!/^\/broadcast(?:@\w+)?(\s|$)/i.test(caption)) {
      return next();
    }

    const userId = Number(ctx.message?.from?.id || 0);
    if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
    }

    const photos = ctx.message?.photo || [];
    const sourcePhoto = photos.length ? photos[photos.length - 1] : null;
    if (!sourcePhoto?.file_id) {
      return ctx.reply('⚠️ Foto tidak ditemukan. Coba kirim ulang.');
    }

    const textCaption = caption.replace(/^\/broadcast(?:@\w+)?\s*/i, '').trim();
    const result = await broadcastToAllUsers({
      type: 'photo',
      fileId: sourcePhoto.file_id,
      caption: textCaption
    }, ctx.chat.id, 'Broadcast foto');

    return ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast foto'));
  } catch (err) {
    logger.error('Gagal proses broadcast foto dari caption:', err.message || err);
    return ctx.reply('⚠️ Terjadi kesalahan saat broadcast foto.');
  }
});

bot.command('broadcastreseller', async (ctx) => {
  const userId = Number(ctx.message?.from?.id || 0);
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const rawText = ctx.message.text || '';
  const message = ctx.message.reply_to_message
    ? (ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '')
    : rawText.replace(/^\/broadcastreseller(?:@\w+)?\s*/i, '');

  if (!message || !String(message).trim()) {
    return ctx.reply(
      '⚠️ Mohon berikan pesan untuk reseller.\n\n' +
      'Contoh:\n`/broadcastreseller Halo reseller, ada update harga.`',
      { parse_mode: 'Markdown' }
    );
  }

  const result = await broadcastMessageToResellers(String(message).trim(), ctx.chat.id);
  if (result.total === 0) {
    return ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast reseller'));
  }

  return ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast reseller'));
});



bot.command('broadcastpoll', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const rawText = (ctx.message.text || '').replace(/^\/broadcastpoll(?:@\w+)?\s*/i, '').trim();
  const sourceText = ctx.message.reply_to_message
    ? ((ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '').trim())
    : rawText;

  if (!sourceText) {
    return ctx.reply(
      'Format: /broadcastpoll Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n' +
      'Minimal 2 opsi, maksimal 10 opsi.'
    );
  }

  const parts = sourceText.split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) {
    return ctx.reply('Format salah. Minimal: Pertanyaan | Opsi A | Opsi B');
  }

  const question = parts[0];
  const options = parts.slice(1, 11);

  if (question.length < 5) {
    return ctx.reply('Pertanyaan terlalu pendek. Minimal 5 karakter.');
  }

  if (options.length < 2) {
    return ctx.reply('Opsi polling minimal 2 pilihan.');
  }

  const pollResult = await broadcastPollToAllUsers(question, options, userId, ctx.chat.id);

  return ctx.reply(
    formatBroadcastQueuedMessage(pollResult, `Broadcast polling #${pollResult.pollId}`)
  );
});
//command addserver biasa potato//command addserver biasa potato
bot.command('addserver', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const params = parts.slice(1);

  // Format baru: wajib dua harga user + dua harga reseller
  // Format lama (7 arg) masih didukung, semua harga disamakan.
  if (!(params.length === 7 || params.length === 10)) {
    return ctx.reply(
      '⚠️ Format salah.\n' +
      'Format baru:\n`/addserver <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>`\n\n' +
      'Format lama (7 argumen) masih bisa dipakai, semua harga akan disamakan.',
      { parse_mode: 'Markdown' }
    );
  }

  let domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun;

  if (params.length === 7) {
    [domain, auth, harga1, nama_server, quota, iplimit, batas_create_akun] = params;
    harga2 = harga1;
    hargaRes1 = harga1;
    hargaRes2 = harga1;
  } else {
    [domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun] = params;
  }

  const numberOnlyRegex = /^\d+$/;
  if (
    ![harga1, harga2, hargaRes1, hargaRes2, quota, iplimit, batas_create_akun].every(v => numberOnlyRegex.test(v))
  ) {
    return ctx.reply('⚠️ Semua nilai harga/quota/iplimit/batas harus berupa angka.', { parse_mode: 'Markdown' });
  }

  const service = userState[ctx.chat.id]?.service || 'ssh';
  const hargaInt1 = parseInt(harga1);
  const hargaInt2 = parseInt(harga2);
  const hargaResInt1 = parseInt(hargaRes1);
  const hargaResInt2 = parseInt(hargaRes2);

  db.run(
    "INSERT INTO Server (domain, auth, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)",
    [
      domain,
      auth,
      hargaInt1, // harga dasar = harga paket 1IP user
      hargaResInt1,
      hargaInt1,
      hargaInt2,
      hargaResInt1,
      hargaResInt2,
      nama_server,
      parseInt(quota),
      parseInt(iplimit),
      parseInt(batas_create_akun),
      service
    ],
    function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
        return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      delete userState[ctx.chat.id];

      ctx.reply(
        `✅ Server \`${nama_server}\` berhasil ditambahkan.\n` +
        `• Harga User 1IP: Rp${hargaInt1.toLocaleString('id-ID')}\n` +
        `• Harga User 2IP: Rp${hargaInt2.toLocaleString('id-ID')}\n` +
        `• Harga Reseller 1IP: Rp${hargaResInt1.toLocaleString('id-ID')}\n` +
        `• Harga Reseller 2IP: Rp${hargaResInt2.toLocaleString('id-ID')}`,
        { parse_mode: 'Markdown' }
      );
    }
  );
});

//command addserver zivpn
bot.command('addserverzivpn', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const params = parts.slice(1);

  if (!(params.length === 7 || params.length === 10)) {
    return ctx.reply(
      '⚠️ Format salah.\n' +
      'Format baru:\n`/addserverzivpn <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>`\n\n' +
      'Format lama (7 argumen) masih bisa dipakai, semua harga akan disamakan.',
      { parse_mode: 'Markdown' }
    );
  }

  let domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun;

  if (params.length === 7) {
    [domain, auth, harga1, nama_server, quota, iplimit, batas_create_akun] = params;
    harga2 = harga1;
    hargaRes1 = harga1;
    hargaRes2 = harga1;
  } else {
    [domain, auth, harga1, harga2, hargaRes1, hargaRes2, nama_server, quota, iplimit, batas_create_akun] = params;
  }

  const numberOnlyRegex = /^\d+$/;
  if (![harga1, harga2, hargaRes1, hargaRes2, quota, iplimit, batas_create_akun].every(v => numberOnlyRegex.test(v))) {
    return ctx.reply('⚠️ Semua nilai harga/quota/iplimit/batas harus berupa angka.');
  }

  db.run(
    "INSERT INTO Server (domain, auth, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 'ssh')",
    [
      domain,
      auth,
      parseInt(harga1),
      parseInt(hargaRes1),
      parseInt(harga1),
      parseInt(harga2),
      parseInt(hargaRes1),
      parseInt(hargaRes2),
      nama_server,
      parseInt(quota),
      parseInt(iplimit),
      parseInt(batas_create_akun)
    ],
    function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan server ZIVPN:', err.message);
        return ctx.reply('⚠️ Kesalahan saat menambahkan server ZIVPN.');
      }

      ctx.reply(
        `✅ Server ZIVPN \`${nama_server}\` berhasil ditambahkan.\n` +
        `• Harga User 1IP: Rp${parseInt(harga1).toLocaleString('id-ID')}\n` +
        `• Harga User 2IP: Rp${parseInt(harga2).toLocaleString('id-ID')}\n` +
        `• Harga Reseller 1IP: Rp${parseInt(hargaRes1).toLocaleString('id-ID')}\n` +
        `• Harga Reseller 2IP: Rp${parseInt(hargaRes2).toLocaleString('id-ID')}`,
        { parse_mode: 'Markdown' }
      );
    }
  );
});

//////
bot.command('editharga', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editharga <domain> <harga>`', { parse_mode: 'Markdown' });
  }

  const [domain, harga] = args.slice(1);

  if (!/^\d+$/.test(harga)) {
      return ctx.reply('⚠️ `harga` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'ssh')", 
      [domain, auth, parseInt(harga), nama_server, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun)], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan.`, { parse_mode: 'Markdown' });
  });
});


bot.command('editnama', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editnama <domain> <nama_server>`', { parse_mode: 'Markdown' });
  }

  const [domain, nama_server] = args.slice(1);

  db.run("UPDATE Server SET nama_server = ? WHERE domain = ?", [nama_server, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit nama server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Nama server \`${domain}\` berhasil diubah menjadi \`${nama_server}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editdomain', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editdomain <old_domain> <new_domain>`', { parse_mode: 'Markdown' });
  }

  const [old_domain, new_domain] = args.slice(1);

  db.run("UPDATE Server SET domain = ? WHERE domain = ?", [new_domain, old_domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit domain server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit domain server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Domain server \`${old_domain}\` berhasil diubah menjadi \`${new_domain}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editauth', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editauth <domain> <auth>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth] = args.slice(1);

  db.run("UPDATE Server SET auth = ? WHERE domain = ?", [auth, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit auth server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit auth server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Auth server \`${domain}\` berhasil diubah menjadi \`${auth}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitquota', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitquota <domain> <quota_per_hari_gb>`', { parse_mode: 'Markdown' });
  }

  const [domain, quota] = args.slice(1);

  if (!/^\d+$/.test(quota)) {
      return ctx.reply('⚠️ `quota` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET quota = ? WHERE domain = ?", [parseInt(quota), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit quota harian server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit quota harian server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Quota harian server \`${domain}\` berhasil diubah menjadi \`${quota} GB/hari\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitip', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitip <domain> <iplimit>`', { parse_mode: 'Markdown' });
  }

  const [domain, iplimit] = args.slice(1);

  if (!/^\d+$/.test(iplimit)) {
      return ctx.reply('⚠️ `iplimit` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET iplimit = ? WHERE domain = ?", [parseInt(iplimit), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit iplimit server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit iplimit server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Iplimit server \`${domain}\` berhasil diubah menjadi \`${iplimit}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitcreate <domain> <batas_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, batas_create_akun] = args.slice(1);

  if (!/^\d+$/.test(batas_create_akun)) {
      return ctx.reply('⚠️ `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET batas_create_akun = ? WHERE domain = ?", [parseInt(batas_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit batas_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit batas_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Batas create akun server \`${domain}\` berhasil diubah menjadi \`${batas_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
bot.command('edittotalcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/edittotalcreate <domain> <total_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, total_create_akun] = args.slice(1);

  if (!/^\d+$/.test(total_create_akun)) {
      return ctx.reply('⚠️ `total_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET total_create_akun = ? WHERE domain = ?", [parseInt(total_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit total_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit total_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Total create akun server \`${domain}\` berhasil diubah menjadi \`${total_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
async function handleServiceAction(ctx, action) {
  let keyboard;
  if (action === 'create') {
    keyboard = [
      [{ text: 'Buat UDP ZIVPN', callback_data: 'create_zivpn' }],
      [
        { text: 'Buat Ssh/Ovpn', callback_data: 'create_ssh' },
        { text: 'Buat UDP HC', callback_data: 'create_udp_http' }
      ],
      [{ text: 'Buat Vmess', callback_data: 'create_vmess' }, { text: 'Buat Vless', callback_data: 'create_vless' }],
      [{ text: 'Buat Trojan', callback_data: 'create_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  } else if (action === 'trial') {
    keyboard = [
      [{ text: 'Trial UDP ZIVPN', callback_data: 'trial_zivpn' }],
      [
        { text: 'Trial Ssh/Ovpn', callback_data: 'trial_ssh' },
        { text: 'Trial UDP HTTP', callback_data: 'trial_udp_http' }
      ],
      [{ text: 'Trial Vmess', callback_data: 'trial_vmess' }, { text: 'Trial Vless', callback_data: 'trial_vless' }],
      [{ text: 'Trial Trojan', callback_data: 'trial_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  } else if (action === 'renew') {
    keyboard = [
      [{ text: 'Perpanjang UDP ZIVPN', callback_data: 'renew_zivpn' }],
      [
        { text: 'Perpanjang Ssh/Ovpn', callback_data: 'renew_ssh' },
        { text: 'Perpanjang UDP HTTP', callback_data: 'renew_udp_http' }
      ],
      [{ text: 'Perpanjang Vmess', callback_data: 'renew_vmess' }, { text: 'Perpanjang Vless', callback_data: 'renew_vless' }],
      [{ text: 'Perpanjang Trojan', callback_data: 'renew_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  } else if (action === 'del') {
    keyboard = [
      [
        { text: 'Hapus Ssh/Ovpn', callback_data: 'del_ssh' },
        { text: 'Hapus UDP HTTP', callback_data: 'del_udp_http' }
      ],
      [{ text: 'Hapus UDP ZIVPN', callback_data: 'del_zivpn' }],
      [{ text: 'Hapus Vmess', callback_data: 'del_vmess' }, { text: 'Hapus Vless', callback_data: 'del_vless' }],
      [{ text: 'Hapus Trojan', callback_data: 'del_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  } else if (action === 'lock') {
    keyboard = [
      [
        { text: 'Lock Ssh/Ovpn', callback_data: 'lock_ssh' },
        { text: 'Lock UDP HTTP', callback_data: 'lock_udp_http' }
      ],
      [{ text: 'Lock Vmess', callback_data: 'lock_vmess' }, { text: 'Lock Vless', callback_data: 'lock_vless' }],
      [{ text: 'Lock Trojan', callback_data: 'lock_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  } else if (action === 'unlock') {
    keyboard = [
      [
        { text: 'Unlock Ssh/Ovpn', callback_data: 'unlock_ssh' },
        { text: 'Unlock UDP HTTP', callback_data: 'unlock_udp_http' }
      ],
      [{ text: 'Unlock Vmess', callback_data: 'unlock_vmess' }, { text: 'Unlock Vless', callback_data: 'unlock_vless' }],
      [{ text: 'Unlock Trojan', callback_data: 'unlock_trojan' }, { text: 'Kembali', callback_data: 'menu_vpn' }]
    ];
  }
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: keyboard
    });
    logger.info(`${action} service menu sent`);
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply(`Pilih jenis layanan yang ingin Anda ${action}:`, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
      logger.info(`${action} service menu sent as new message`);
    } else {
      logger.error(`Error saat mengirim menu ${action}:`, error);
    }
  }
}
async function sendAdminMenu(ctx) {
  const adminKeyboard = [
    [{ text: '🖥️ Server', callback_data: 'admin_menu_server' }],
    [{ text: '💳 Saldo', callback_data: 'admin_menu_saldo' }],
    [{ text: '🤝 Reseller', callback_data: 'admin_menu_reseller' }],
    [{ text: '🧰 Tools', callback_data: 'admin_menu_tools' }],
    [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
  ];

  try {
    await ctx.editMessageText('*🛠️ MENU ADMIN*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: adminKeyboard
      }
    });
    logger.info('Admin menu sent');
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      try {
        await ctx.reply('*🛠️ MENU ADMIN*', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: adminKeyboard
          }
        });
        logger.info('Admin menu sent as new message');
      } catch (sendError) {
        logger.error('Error sending admin menu as new message:', sendError);
      }
    } else {
      logger.error('Error saat mengirim menu admin:', error);
    }
  }
}

async function sendServerIpLimitProtocolMenu(ctx, serverId, serverName) {
  const server = await dbGetAsync('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId]).catch(() => null);
  if (!server) {
    return ctx.reply('Server tidak ditemukan.');
  }

  const currentRows = await dbAllAsync(
    'SELECT protocol, ip_package, iplimit FROM server_iplimit_rules WHERE server_id = ?',
    [serverId]
  ).catch(() => []);

  const currentMap = new Map();
  currentRows.forEach((row) => {
    const protocol = normalizeIpLimitProtocol(row.protocol);
    const pkg = Number(row.ip_package || 0) === 2 ? 2 : 1;
    if (!currentMap.has(protocol)) currentMap.set(protocol, {});
    currentMap.get(protocol)[pkg] = Number(row.iplimit || 0);
  });

  const lines = SERVER_IPLIMIT_PROTOCOLS.map((item) => {
    const values = currentMap.get(item.key) || {};
    const oneIp = Number.isFinite(values[1]) && values[1] >= 0 ? values[1] : getDefaultServerIpLimit(item.key, 1);
    const twoIp = Number.isFinite(values[2]) && values[2] >= 0 ? values[2] : getDefaultServerIpLimit(item.key, 2);
    return `- ${item.label}: 1IP=${oneIp}, 2IP=${twoIp}`;
  });

  const keyboard = [];
  for (let i = 0; i < SERVER_IPLIMIT_PROTOCOLS.length; i += 2) {
    keyboard.push(SERVER_IPLIMIT_PROTOCOLS.slice(i, i + 2).map((item) => ({
      text: item.label,
      callback_data: `edit_server_iplimit_rules_protocol_${serverId}_${item.key}`
    })));
  }
  keyboard.push([{ text: '🔙 Kembali', callback_data: 'editserver_iplimit_rules' }]);

  await ctx.reply(
    `Pilih protocol untuk server:\n*${serverName || server.nama_server || server.domain || `ID ${serverId}`}*\n\n` +
    'Saat ini:\n' + lines.join('\n') + '\n\n' +
    'Setelah pilih protocol, kirim nilai IP untuk paket 1IP lalu 2IP.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

bot.action('admin_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminMenu(ctx);
});

async function sendAdminServerMenu(ctx) {
  const keyboard = [
    [{ text: '➕ Add Server', callback_data: 'addserver' }],
        [
      { text: '🛠️ Kelola Server', callback_data: 'admin_manage_server' }
    ],
    [{ text: '📶 Cek Bandwidth Server', callback_data: 'admin_check_bandwidth_servers' }],
        [
      { text: 'Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: 'Edit Harga User 1IP', callback_data: 'editserver_harga_1ip' },
      { text: 'Edit Harga User 2IP', callback_data: 'editserver_harga_2ip' }
    ],
    [
      { text: 'Edit Harga Reseller 1IP', callback_data: 'editserver_harga_reseller_1ip' },
      { text: 'Edit Harga Reseller 2IP', callback_data: 'editserver_harga_reseller_2ip' }
    ],
    [
      { text: '⏱️ Atur Harga Masa Aktif', callback_data: 'editserver_price_duration' }
    ],
    [
      { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
      { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
      { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: '📋 List Server', callback_data: 'listserver' },
      { text: 'ℹ️ Detail Server', callback_data: 'detailserver' }
    ],
    [
      { text: '⚙️ Atur Limit IP Paket', callback_data: 'editserver_iplimit_rules' }
    ],
    [
      { text: '❌ Hapus Server', callback_data: 'deleteserver' },
      { text: '♻️ Reset Server', callback_data: 'resetdb' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🖥️ MENU SERVER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminSaldoMenu(ctx) {
  const autoEnabled = loadTopupAutoSetting();
  const autoLabel = autoEnabled ? '✅ TopUp Otomatis: Aktif' : '🚫 TopUp Otomatis: Nonaktif';
  const keyboard = [
    [
      { text: '💵 Tambah Saldo', callback_data: 'tambah_saldo' },
      { text: '🗑️ Hapus Saldo', callback_data: 'hapus_saldo' }
    ],
    [
      { text: '💳 Lihat Saldo User', callback_data: 'cek_saldo_user' },
      { text: '🖼️ Upload QRIS', callback_data: 'upload_qris' }
    ],
    [{ text: '🎁 Bonus Topup', callback_data: 'bonus_topup_menu' }],
    [{ text: 'Pendapatan Hari Ini & Kemarin', callback_data: 'admin_income_summary' }],
    [{ text: 'Pendapatan Topup Bulanan', callback_data: 'admin_income_monthly_non_reseller' }],
    [{ text: autoLabel, callback_data: 'toggle_topup_auto' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*💳 MENU SALDO*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminResellerMenu(ctx) {
  const keyboard = [
    [
      { text: '➕ Tambah Reseller', callback_data: 'add_reseller_menu' },
      { text: '🗑️ Hapus Reseller', callback_data: 'del_reseller_menu' }
    ],
    [{ text: '📜 Syarat Reseller', callback_data: 'reseller_terms_menu' }],
    [{ text: '⚡ Trigger Cek Syarat', callback_data: 'reseller_terms_trigger' }],
    [{ text: '♻️ Restore Reseller', callback_data: 'reseller_restore' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🤝 MENU RESELLER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.action('add_reseller_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
  }
  userState[ctx.chat.id] = { step: 'add_reseller_userid' };
  await ctx.reply('Masukkan ID Telegram user yang ingin dijadikan reseller:');
});

bot.action('del_reseller_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
  }
  userState[ctx.chat.id] = { step: 'del_reseller_userid' };
  await ctx.reply('Masukkan ID Telegram reseller yang ingin dihapus:');
});

async function sendAdminToolsMenu(ctx) {
  const maintenance = loadMaintenanceSetting();
  const maintenanceLabel = maintenance.enabled
    ? `🚧 Maintenance: ON (${maintenance.estimate || 'estimasi belum diisi'})`
    : '✅ Maintenance: OFF';
  const keyboard = [
    [
      { text: '📋 Help Admin', callback_data: 'helpadmin_menu' },
      { text: '📘 Tutorial', callback_data: 'admin_tutorial_menu' }
    ],
    [
      { text: '📥 Download Config', callback_data: 'admin_download_config_menu' },
      { text: '🧩 Template HC', callback_data: 'admin_hc_template_menu' }
    ],
    [
      { text: '🧩 Template Dark', callback_data: 'admin_dark_template_menu' },
      { text: '📦 Bulk Config', callback_data: 'admin_bulk_config_menu' }
    ],
    [
      { text: '📣 Broadcast', callback_data: 'admin_broadcast_menu' },
      { text: '📊 Polling', callback_data: 'admin_broadcast_poll_menu' }
    ],
    [
      { text: '💾 Restore DB', callback_data: 'restore_db_menu' },
      { text: '🗄️ Backup DB', callback_data: 'auto_backup_now' }
    ],
    [
      { text: '🔄 Sync Server', callback_data: 'admin_sync_server_now' },
      { text: '⚙️ Auto Sync', callback_data: 'admin_sync_server_toggle_menu' }
    ],
    [
      { text: '🔔 Notif Akun', callback_data: 'notif_settings_menu' },
      { text: '📶 Notif BW', callback_data: 'bw_notif_settings_menu' }
    ],
    [
      { text: '🔐 Webhook SC', callback_data: 'sc_webhook_settings_menu' },
      { text: '🌐 Nginx Webhook', callback_data: 'nginx_webhook_menu' }
    ],
    [{ text: '🧩 Generator API', callback_data: 'generator_api_settings_menu' }],
    [{ text: '💳 Payment Gateway', callback_data: 'payment_gateway_settings_menu' }],
    [{ text: '🛒 PPOB', callback_data: 'ppob_admin_menu' }],
    [{ text: maintenanceLabel, callback_data: 'maintenance_menu' }],
    [
      { text: '🏠 Halaman Utama', callback_data: 'main_menu_settings' },
      { text: '📞 Kontak Admin', callback_data: 'admin_contact_settings_menu' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🧰 MENU TOOLS*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendGeneratorApiSettingsMenu(ctx) {
  const config = getGeneratorApiConfig();
  const url = normalizeGeneratorApiUrl(config.GENERATOR_API_URL || DEFAULT_GENERATOR_API_URL);
  const key = String(config.GENERATOR_API_KEY || '').trim();
  const timeoutMs = Number(config.GENERATOR_API_TIMEOUT_MS || 120000);
  const timeoutSeconds = Math.round((Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000) / 1000);

  const text =
    '<b>🧩 GENERATOR API</b>\n\n' +
    'Menu ini dipakai untuk fitur generate/unlock HC dan Dark Tunnel.\n\n' +
    `URL: <code>${escapeHtml(url || '-')}</code>\n` +
    `API Key: <code>${escapeHtml(key ? maskSecret(key) : 'Belum diisi')}</code>\n` +
    `Timeout: <code>${timeoutSeconds} detik</code>\n\n` +
    'Source generator tetap tidak ada di bot clone. Bot hanya memanggil API private.';

  const payload = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Set API URL', callback_data: 'generator_api_set_url' }],
        [{ text: 'Set API Key', callback_data: 'generator_api_set_key' }],
        [{ text: 'Set Timeout', callback_data: 'generator_api_set_timeout' }],
        [{ text: 'Cek Koneksi', callback_data: 'generator_api_test' }],
        [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
      ]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  }
  return ctx.reply(text, payload);
}

function sanitizeNginxHostInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const withoutScheme = text.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  return withoutScheme;
}

function buildNginxWebhookConfig(host, appPort = 6969) {
  const safeHost = sanitizeNginxHostInput(host);
  const safePort = Number(appPort) > 0 ? Number(appPort) : 6969;
  return (
`server {
    listen 80;
    server_name ${safeHost};

    location / {
        proxy_pass http://127.0.0.1:${safePort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`
  );
}

function getNginxWebhookConfName(host) {
  const base = `botvpn-webhook-${sanitizeNginxHostInput(host).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'default'}`;
  return `${base}.conf`;
}

function isIpv4Host(host) {
  const h = String(host || '').trim();
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(h);
}

function isDomainHost(host) {
  const h = String(host || '').trim();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(h);
}

function formatExecSyncError(err) {
  const stderr = err?.stderr ? Buffer.from(err.stderr).toString('utf8').trim() : '';
  const stdout = err?.stdout ? Buffer.from(err.stdout).toString('utf8').trim() : '';
  return stderr || stdout || err?.message || String(err);
}

function commandExistsSync(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function ensureNginxWebhookPackagesSync() {
  const hasNginx = commandExistsSync('nginx');
  const hasCertbot = commandExistsSync('certbot');
  if (hasNginx && hasCertbot) return;

  if (!commandExistsSync('apt-get')) {
    throw new Error('nginx/certbot belum terinstall dan auto install hanya mendukung apt-get.');
  }

  execSync('apt-get update -y', { stdio: 'pipe' });
  execSync('apt-get install -y nginx certbot python3-certbot-nginx', { stdio: 'pipe' });
}

function reloadNginxSync() {
  try {
    execSync('systemctl reload nginx', { stdio: 'pipe' });
  } catch (_) {
    execSync('service nginx reload', { stdio: 'pipe' });
  }
}

function setupNginxWebhookAuto(host, appPort = 6969) {
  const safeHost = sanitizeNginxHostInput(host);
  if (!safeHost || !/^[a-zA-Z0-9.-]+$/.test(safeHost)) {
    return { ok: false, message: 'Host/domain tidak valid.' };
  }

  const confName = getNginxWebhookConfName(safeHost);
  const confPath = `/etc/nginx/sites-available/${confName}`;
  const enabledPath = `/etc/nginx/sites-enabled/${confName}`;
  const baseConfig = buildNginxWebhookConfig(safeHost, appPort);

  try {
    ensureNginxWebhookPackagesSync();
    fs.mkdirSync('/etc/nginx/sites-available', { recursive: true });
    fs.mkdirSync('/etc/nginx/sites-enabled', { recursive: true });
    fs.writeFileSync(confPath, `${baseConfig}\n`, 'utf8');
    execSync(`ln -sfn ${confPath} ${enabledPath}`, { stdio: 'pipe' });
    execSync('nginx -t', { stdio: 'pipe' });
    reloadNginxSync();
  } catch (err) {
    return { ok: false, message: `Gagal setup nginx: ${formatExecSyncError(err)}` };
  }

  // Jika host berupa IP, SSL Let's Encrypt tidak bisa dipasang.
  if (!isDomainHost(safeHost) || isIpv4Host(safeHost)) {
    return {
      ok: true,
      ssl: false,
      url: `http://${safeHost}/sc1forcr/events/multi-login`,
      message: 'Nginx aktif via HTTP (host berupa IP/non-domain).'
    };
  }

  // Coba issue SSL otomatis untuk domain.
  try {
    execSync(
      `certbot --nginx -d ${safeHost} --non-interactive --agree-tos --register-unsafely-without-email --redirect`,
      { stdio: 'pipe' }
    );
    execSync('nginx -t', { stdio: 'pipe' });
    reloadNginxSync();
    return {
      ok: true,
      ssl: true,
      url: `https://${safeHost}/sc1forcr/events/multi-login`,
      message: 'Nginx + SSL aktif (HTTPS).'
    };
  } catch (err) {
    return {
      ok: true,
      ssl: false,
      url: `http://${safeHost}/sc1forcr/events/multi-login`,
      message: `SSL gagal dipasang (${formatExecSyncError(err)}). Fallback ke HTTP.`
    };
  }
}

async function sendNginxWebhookMenu(ctx) {
  const currentUrl = SC_MULTI_LOGIN_WEBHOOK_URL || '-';
  const message =
    '*🌐 SETUP NGINX WEBHOOK SC*\n\n' +
    `URL webhook saat ini: \`${currentUrl}\`\n\n` +
    `Menu ini bantu generate config Nginx untuk forward port 80 ke bot (${port}), lalu set URL webhook SC.`;

  const keyboard = [
    [{ text: '⚡ Auto Setup Nginx + SSL', callback_data: 'nginx_webhook_auto_setup' }],
    [{ text: '🧾 Generate Config Nginx', callback_data: 'nginx_webhook_generate' }],
    [{ text: '🔗 Set URL Webhook dari Domain/IP', callback_data: 'nginx_webhook_set_url_from_host' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendMaintenanceMenu(ctx) {
  const maintenance = loadMaintenanceSetting();
  const statusText = maintenance.enabled ? 'AKTIF' : 'NONAKTIF';
  const estimateText = maintenance.estimate || 'belum ditentukan';
  const keyboard = [
    [{ text: maintenance.enabled ? '🚫 Nonaktifkan Maintenance' : '✅ Aktifkan Maintenance', callback_data: 'maintenance_toggle' }],
    [{ text: '⏱️ Set Estimasi Maintenance', callback_data: 'maintenance_set_estimate' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(
    '*🚧 MODE MAINTENANCE BOT*\n\n' +
    `Status: *${statusText}*\n` +
    `Estimasi: *${estimateText}*\n\n` +
    'Contoh estimasi: `30 menit` atau `2 jam`.',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

async function sendScWebhookSettingsMenu(ctx) {
  const tokenStatus = BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN ? `✅ ${maskSecret(BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN)}` : '❌ Belum diisi';
  const urlStatus = SC_MULTI_LOGIN_WEBHOOK_URL || '-';
  const message =
    '*🔐 WEBHOOK MULTI-LOGIN SC*\n\n' +
    `Token webhook: ${tokenStatus}\n` +
    `URL webhook: \`${escapeHtmlLocal(urlStatus)}\`\n\n` +
    'URL ini endpoint yang dipanggil server SC saat multi-login terdeteksi.';

  const keyboard = [
    [{ text: 'Set Token Webhook', callback_data: 'sc_webhook_set_token' }],
    [{ text: 'Set URL Webhook', callback_data: 'sc_webhook_set_url' }],
    [{ text: 'Test Webhook (kirim ke saya)', callback_data: 'sc_webhook_test' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminSyncToggleMenu(ctx) {
  try {
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server, domain, sync_enabled FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    if (servers.length === 0) {
      return ctx.editMessageText('Tidak ada server yang tersedia.', {
        reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'admin_menu_tools' }]] }
      });
    }

    const inlineKeyboard = servers.map((server) => {
      const statusText = Number(server.sync_enabled) === 1 ? '[ON]' : '[OFF]';
      return [{
        text: statusText + ' ' + (server.nama_server || server.domain || ('ID ' + server.id)),
        callback_data: 'admin_sync_server_toggle_' + server.id
      }];
    });

    inlineKeyboard.push([{ text: 'Kembali', callback_data: 'admin_menu_tools' }]);

    await ctx.editMessageText(
      '*AUTO SYNC SERVER*\n\nPilih server untuk aktif/nonaktif autosync.\nLabel [ON] berarti ikut autosync, [OFF] berarti dilewati.',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }
    );
  } catch (err) {
    logger.error('Gagal menampilkan menu toggle autosync:', err.message);
    await ctx.reply('Terjadi kesalahan saat membuka menu autosync server.');
  }
}

bot.action('admin_menu_server', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminServerMenu(ctx);
});

async function sendAdminManageServerMenu(ctx) {
  const keyboard = [
    [{ text: '🔢 Edit Total + Batas', callback_data: 'manage_edit_total_batas' }],
    [{ text: '📶 Set Limit Bandwidth', callback_data: 'manage_set_bw_limit' }],
    [{ text: '🔄 Migrasi User Server', callback_data: 'admin_migrate_users_menu' }],
    [{ text: '🗑️ Hapus Semua SSH/ZIVPN', callback_data: 'admin_delete_all_accounts_manual' }],
    [{ text: '🕹️ Aktif/Nonaktifkan dari List', callback_data: 'manage_server_visibility' }],
    [{ text: '🔌 Aktif/Nonaktifkan Protocol', callback_data: 'manage_server_protocols' }],
    [{ text: '🚫 Jadikan Server Penuh', callback_data: 'manage_server_full' }],
    [{ text: '✅ Jadikan Server Tersedia', callback_data: 'manage_server_activate' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_server' }]
  ];

  await ctx.editMessageText('*🛠️ KELOLA SERVER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.action('admin_manage_server', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminManageServerMenu(ctx);
});

bot.action('admin_migrate_users_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const requesterId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(requesterId)) {
    return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
  }

  const keyboard = [
    [
      { text: 'SSH', callback_data: 'migr_user_type_ssh' },
      { text: 'VMESS', callback_data: 'migr_user_type_vmess' }
    ],
    [
      { text: 'VLESS', callback_data: 'migr_user_type_vless' },
      { text: 'TROJAN', callback_data: 'migr_user_type_trojan' }
    ],
    [{ text: 'UDP ZIVPN', callback_data: 'migr_user_type_zivpn' }],
    [{ text: 'Kembali', callback_data: 'admin_manage_server' }]
  ];

  await ctx.reply('Pilih jenis akun yang ingin dimigrasi:', {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action('admin_delete_all_accounts_manual', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const requesterId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(requesterId)) {
    return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
  }

  userState[ctx.chat.id] = { step: 'delete_all_input_host' };
  return ctx.reply(
    'Hapus semua akun SSH/ZIVPN (DANGEROUS)\n\n' +
    'Masukkan host server target (contoh: id1.prem-1forcr.shop).\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/migr_user_type_(ssh|vmess|vless|trojan|zivpn)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const requesterId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(requesterId)) {
    return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
  }

  const type = normalizeMigrationType(ctx.match[1]);
  if (!isSupportedMigrationType(type)) {
    return ctx.reply(
      `Migrasi ${String(type || '').toUpperCase()} belum didukung saat ini.\n` +
      'Saat ini migrasi yang tersedia: SSH dan UDP ZIVPN.'
    );
  }
  userState[ctx.chat.id] = {
    step: 'migrate_input_source_host',
    migrationType: type
  };

  await ctx.reply(
    `Migrasi ${type.toUpperCase()}\n` +
    'Masukkan host server sumber (contoh: id1.prem-1forcr.shop).\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/migr_src_(ssh|vmess|vless|trojan|zivpn)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(
    'Alur migrasi terbaru menggunakan input manual host + key.\n' +
    'Silakan buka lagi menu Migrasi User Server.'
  );
});

bot.action('admin_check_bandwidth_servers', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const requesterId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(requesterId)) {
    return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
  }

  try {
    await ctx.reply('Mengambil data bandwidth terbaru dari server tunnel...');
    await syncServerUsageFromTunnel('admin_check_bandwidth', { force: true });
  } catch (syncErr) {
    logger.warn(`Sync saat cek bandwidth gagal: ${syncErr.message}`);
  }

  db.all(
    'SELECT id, nama_server, domain, sync_host, total_create_akun, batas_create_akun, bandwidth_limit_tb, bandwidth_daily_gb, bandwidth_monthly_used_tb, bandwidth_user_daily_gb FROM Server ORDER BY nama_server COLLATE NOCASE ASC',
    [],
    async (err, rows) => {
      if (err) {
        logger.error('❌ Gagal mengambil data bandwidth server:', err.message);
        return ctx.reply('❌ Gagal mengambil data bandwidth server.');
      }
      if (!rows || rows.length === 0) {
        return ctx.reply('Belum ada server yang ditambahkan.');
      }

      const lines = ['*CEK BANDWIDTH SERVER*', ''];
      const groupedServers = [];
      const groups = new Map();
      for (const srv of rows) {
        const key = normalizeSyncHost(srv.sync_host || srv.domain) || (`id-${srv.id}`);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(srv);
      }

      for (const hostKey of groups.keys()) {
        const group = groups.get(hostKey) || [];
        if (group.length === 0) continue;
        const primary = group[0];
        groupedServers.push({
          nama_server: primary.nama_server,
          host: normalizeSyncHost(primary.sync_host || primary.domain) || '-',
          total_create_akun: group
            .map((s) => Number(s.total_create_akun || 0))
            .reduce((max, cur) => Math.max(max, cur), 0),
          batas_create_akun: group
            .map((s) => Number(s.batas_create_akun || 0))
            .filter((v) => Number.isFinite(v) && v > 0)
            .reduce((max, cur) => Math.max(max, cur), 0),
          bandwidth_limit_tb: group
            .map((s) => Number(s.bandwidth_limit_tb || 0))
            .filter((v) => Number.isFinite(v) && v > 0)
            .reduce((max, cur) => Math.max(max, cur), 0),
          bandwidth_daily_gb: group
            .map((s) => Number(s.bandwidth_daily_gb || 0))
            .reduce((max, cur) => Math.max(max, cur), 0),
          bandwidth_monthly_used_tb: group
            .map((s) => Number(s.bandwidth_monthly_used_tb || 0))
            .reduce((max, cur) => Math.max(max, cur), 0),
          bandwidth_user_daily_gb: group
            .map((s) => Number(s.bandwidth_user_daily_gb || 0))
            .filter((v) => Number.isFinite(v) && v > 0)
            .reduce((max, cur) => Math.max(max, cur), 0)
        });
      }

      let idx = 1;
      for (const srv of groupedServers) {
        const capacity = calculateServerEffectiveCapacity({
          usedAccounts: srv.total_create_akun,
          manualLimit: srv.batas_create_akun,
          bandwidthLimitTb: srv.bandwidth_limit_tb,
          dailyBandwidthGb: srv.bandwidth_daily_gb,
          fallbackPerUserDailyGb: srv.bandwidth_user_daily_gb,
          monthUsedTb: srv.bandwidth_monthly_used_tb
        });
        const manualLimit = Number(srv.batas_create_akun || 0);
        const manualLimitText = manualLimit > 0 ? String(manualLimit) : 'Unlimited';
        const host = srv.host || '-';
        const bwLimitTb = Number(srv.bandwidth_limit_tb || 0);
        const bwMonthTb = Number(srv.bandwidth_monthly_used_tb || 0);
        const riskOver = capacity.hasBandwidthLimit && capacity.projectedMonthlyTbFromToday > bwLimitTb ? 'YA' : 'TIDAK';

        lines.push(`${idx}. ${srv.nama_server || '-'}`);
        lines.push(`- Host: ${host}`);
        lines.push(`- Akun Terpakai (manual): ${Number(srv.total_create_akun || 0)}/${manualLimitText}`);
        lines.push(`- Bandwidth Hari Ini (vnstat): ${Number(srv.bandwidth_daily_gb || 0).toFixed(2)} GB`);
        lines.push(`- Bandwidth Hari Ini (estimasi): ${Number(capacity.effectiveDailyBandwidthGb || 0).toFixed(2)} GB`);
        lines.push(`- Bandwidth Bulan Ini: ${bwMonthTb.toFixed(2)}/${bwLimitTb > 0 ? bwLimitTb.toFixed(2) : '-'} TB`);
        lines.push(`- Estimasi BW 30 Hari: ${capacity.projectedMonthlyTbFromToday.toFixed(2)} TB`);
        lines.push(`- Batas Aman User (BW): ${capacity.hasBandwidthLimit ? capacity.estimatedCapacityByBandwidth : '-'}`);
        lines.push(`- Estimasi Pemakaian/User/Hari: ${capacity.hasBandwidthLimit ? capacity.estimatedPerUserDailyGb.toFixed(3) + ' GB' : '-'}`);
        lines.push(`- Risiko Over BW: ${riskOver}`);
        lines.push('');
        idx += 1;
      }

      const msg = lines.join('\n');
      if (msg.length <= 3900) {
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      } else {
        // Bagi per potongan agar aman dari limit telegram
        let buffer = '';
        for (const line of lines) {
          const candidate = buffer ? `${buffer}\n${line}` : line;
          if (candidate.length > 3500) {
            await ctx.reply(buffer, { parse_mode: 'Markdown' });
            buffer = line;
          } else {
            buffer = candidate;
          }
        }
        if (buffer) await ctx.reply(buffer, { parse_mode: 'Markdown' });
      }
    }
  );
});

bot.action('manage_edit_total_batas', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_batas_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('📊 Pilih server untuk edit total+batas:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('manage_server_full', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `set_server_full_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('🚫 Pilih server yang akan dijadikan penuh:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('manage_server_activate', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `activate_server_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('✅ Pilih server yang akan diaktifkan (isi ulang total & batas):', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('manage_server_visibility', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah status server.');
  }

  db.all(
    'SELECT id, nama_server, domain, is_active FROM Server ORDER BY nama_server COLLATE NOCASE ASC',
    [],
    async (err, servers) => {
      if (err) {
        logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
      }
      if (!servers || servers.length === 0) {
        return ctx.reply('⚠️ Tidak ada server yang tersedia.');
      }

      const buttons = servers.map((server) => {
        const active = Number(server.is_active ?? 1) === 1;
        const label = `${active ? '[AKTIF]' : '[NONAKTIF]'} ${server.nama_server || server.domain || ('ID ' + server.id)}`;
        return {
          text: label,
          callback_data: `toggle_server_visibility_${server.id}`
        };
      });

      const inlineKeyboard = [];
      for (let i = 0; i < buttons.length; i += 1) {
        inlineKeyboard.push([buttons[i]]);
      }
      inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

      return ctx.reply(
        '*AKTIF/NONAKTIF SERVER DI LIST USER*\n\n' +
        'Server *NONAKTIF* tidak muncul di menu pilih server user. Klik server untuk toggle status.',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard }
        }
      );
    }
  );
});

bot.action(/toggle_server_visibility_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah status server.');
  }

  const serverId = Number(ctx.match[1]);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    return ctx.reply('ID server tidak valid.');
  }

  try {
    const server = await dbGetAsync(
      'SELECT id, nama_server, domain, is_active FROM Server WHERE id = ?',
      [serverId]
    );
    if (!server) {
      return ctx.reply('Server tidak ditemukan.');
    }

    const nextValue = Number(server.is_active ?? 1) === 1 ? 0 : 1;
    await dbRunAsync('UPDATE Server SET is_active = ? WHERE id = ?', [nextValue, serverId]);

    await ctx.reply(
      `Server ${(server.nama_server || server.domain || ('ID ' + server.id))} sekarang ` +
      (nextValue === 1 ? 'AKTIF dan muncul di list user.' : 'NONAKTIF dan disembunyikan dari list user.')
    );
    return ctx.reply('Buka ulang menu toggle status server:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Aktif/Nonaktifkan Server', callback_data: 'manage_server_visibility' }]]
      }
    });
  } catch (err) {
    logger.error('Gagal toggle status aktif server:', err.message);
    return ctx.reply('Gagal mengubah status server.');
  }
});

bot.action('manage_server_protocols', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah support protocol server.');
  }

  const selectColumns = SERVER_PROTOCOL_KEYS
    .map((key) => SERVER_PROTOCOL_SUPPORT[key].column)
    .join(', ');

  db.all(
    `SELECT id, nama_server, domain, ${selectColumns}
     FROM Server
     ORDER BY nama_server COLLATE NOCASE ASC`,
    [],
    async (err, servers) => {
      if (err) {
        logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
      }
      if (!servers || servers.length === 0) {
        return ctx.reply('⚠️ Tidak ada server yang tersedia.');
      }

      const keyboard = servers.map((server) => ([{
        text: server.nama_server || server.domain || ('ID ' + server.id),
        callback_data: `server_protocols_${server.id}`
      }]));
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

      return ctx.reply(
        '*SUPPORT PROTOCOL SERVER*\n\n' +
        'Pilih server untuk mengatur protocol yang muncul di list user.',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
    }
  );
});

async function sendServerProtocolToggleMenu(ctx, serverId) {
  const selectColumns = SERVER_PROTOCOL_KEYS
    .map((key) => SERVER_PROTOCOL_SUPPORT[key].column)
    .join(', ');
  const server = await dbGetAsync(
    `SELECT id, nama_server, domain, ${selectColumns}
     FROM Server
     WHERE id = ?`,
    [serverId]
  );

  if (!server) {
    return ctx.reply('Server tidak ditemukan.');
  }

  const keyboard = SERVER_PROTOCOL_KEYS.map((key) => {
    const protocol = SERVER_PROTOCOL_SUPPORT[key];
    const enabled = Number(server[protocol.column] ?? protocol.defaultEnabled) === 1;
    return [{
      text: `${enabled ? '[ON]' : '[OFF]'} ${protocol.label}`,
      callback_data: `toggle_server_protocol_${server.id}_${key}`
    }];
  });
  keyboard.push([{ text: '🔙 Pilih Server Lain', callback_data: 'manage_server_protocols' }]);
  keyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

  return ctx.reply(
    '*SUPPORT PROTOCOL*\n\n' +
    `Server: *${server.nama_server || server.domain || ('ID ' + server.id)}*\n` +
    `Status: \`${formatServerProtocolStatusLine(server)}\`\n\n` +
    'Klik protocol untuk ON/OFF. Protocol OFF tidak muncul di list server user untuk menu protocol tersebut.',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

bot.action(/server_protocols_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah support protocol server.');
  }

  const serverId = Number(ctx.match[1]);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    return ctx.reply('ID server tidak valid.');
  }

  return sendServerProtocolToggleMenu(ctx, serverId);
});

bot.action(/toggle_server_protocol_(\d+)_(ssh|vmess|vless|trojan|shadowsocks|zivpn|udp_http)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah support protocol server.');
  }

  const serverId = Number(ctx.match[1]);
  const protocolKey = String(ctx.match[2] || '').toLowerCase();
  const protocol = getServerProtocolSupport(protocolKey);
  if (!Number.isInteger(serverId) || serverId <= 0 || !protocol) {
    return ctx.reply('Data protocol tidak valid.');
  }

  try {
    const server = await dbGetAsync(
      `SELECT id, nama_server, domain, ${protocol.column}
       FROM Server
       WHERE id = ?`,
      [serverId]
    );
    if (!server) {
      return ctx.reply('Server tidak ditemukan.');
    }

    const current = Number(server[protocol.column] ?? protocol.defaultEnabled) === 1 ? 1 : 0;
    const nextValue = current === 1 ? 0 : 1;
    await dbRunAsync(`UPDATE Server SET ${protocol.column} = ? WHERE id = ?`, [nextValue, serverId]);

    await ctx.reply(
      `${protocol.label} untuk server ${server.nama_server || server.domain || ('ID ' + server.id)} sekarang ` +
      (nextValue === 1 ? 'ON.' : 'OFF dan tidak muncul di list protocol itu.')
    );
    return sendServerProtocolToggleMenu(ctx, serverId);
  } catch (err) {
    logger.error('Gagal toggle support protocol server:', err.message);
    return ctx.reply('Gagal mengubah support protocol server.');
  }
});

bot.action('manage_set_bw_limit', async (ctx) => {
  await ctx.answerCbQuery();
  db.all(
    'SELECT id, nama_server, bandwidth_limit_tb, bandwidth_user_daily_gb FROM Server ORDER BY nama_server COLLATE NOCASE ASC',
    [],
    async (err, servers) => {
      if (err) {
        logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
      }
      if (!servers || servers.length === 0) {
        return ctx.reply('⚠️ Tidak ada server yang tersedia.');
      }

      const buttons = servers.map((server) => ({
        text: `${server.nama_server} (${Number(server.bandwidth_limit_tb || 0).toFixed(1)}TB)`,
        callback_data: `set_server_bw_limit_${server.id}`
      }));
      const inlineKeyboard = [];
      for (let i = 0; i < buttons.length; i += 2) {
        inlineKeyboard.push(buttons.slice(i, i + 2));
      }
      inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

      await ctx.reply('📶 Pilih server untuk set limit bandwidth:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }
  );
});

bot.action(/set_server_bw_limit_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = Number(ctx.match[1]);
  if (!Number.isFinite(serverId) || serverId <= 0) {
    return ctx.reply('ID server tidak valid.');
  }

  db.get(
    'SELECT id, nama_server, bandwidth_limit_tb, bandwidth_user_daily_gb FROM Server WHERE id = ?',
    [serverId],
    (err, row) => {
      if (err || !row) {
        return ctx.reply('Server tidak ditemukan.');
      }

      userState[ctx.chat.id] = { step: 'edit_bw_limit_input', serverId };
      return ctx.reply(
        `Server: ${row.nama_server}\n` +
        `Setting saat ini:\n` +
        `- Limit bulanan: ${Number(row.bandwidth_limit_tb || 0).toFixed(2)} TB\n` +
        `- Estimasi/user/hari: ${Number(row.bandwidth_user_daily_gb || 8).toFixed(2)} GB\n\n` +
        'Kirim format: <limit_tb> <avg_gb_per_user_per_hari>\n' +
        'Contoh: 25 8\n' +
        'Ketik batal untuk membatalkan.'
      );
    }
  );
});

bot.action('admin_menu_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminSaldoMenu(ctx);
});

bot.action('admin_income_summary', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  try {
    const todayRange = getDayRange(0);
    const yesterdayRange = getDayRange(-1);
    const [todayStats, yesterdayStats] = await Promise.all([
      getIncomeStatsByRange(todayRange.start, todayRange.end),
      getIncomeStatsByRange(yesterdayRange.start, yesterdayRange.end)
    ]);

    const message =
      '*INFORMASI PENDAPATAN*\n\n' +
      '*Hari Ini*\n' +
      '- Pendapatan akun: ' + formatRupiah(todayStats.accountIncome) + '\n' +
      '- Jumlah akun terjual: ' + todayStats.accountCount + '\n' +
      '- Topup masuk: ' + formatRupiah(todayStats.topupIncome) + '\n\n' +
      '*Kemarin*\n' +
      '- Pendapatan akun: ' + formatRupiah(yesterdayStats.accountIncome) + '\n' +
      '- Jumlah akun terjual: ' + yesterdayStats.accountCount + '\n' +
      '- Topup masuk: ' + formatRupiah(yesterdayStats.topupIncome);

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Gagal mengambil informasi pendapatan admin:', error.message);
    await ctx.reply('Gagal mengambil informasi pendapatan. Coba lagi.');
  }
});

bot.action('admin_income_monthly_non_reseller', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  try {
    const thisMonth = getMonthRange(0);
    const prevMonth = getMonthRange(-1);
    const [thisMonthTopupNonReseller, prevMonthTopupNonReseller, thisMonthTopupReseller, prevMonthTopupReseller, roleCounts] = await Promise.all([
      getTopupIncomeNonResellerByRange(thisMonth.start, thisMonth.end),
      getTopupIncomeNonResellerByRange(prevMonth.start, prevMonth.end),
      getTopupIncomeResellerByRange(thisMonth.start, thisMonth.end),
      getTopupIncomeResellerByRange(prevMonth.start, prevMonth.end),
      getUserRoleCounts()
    ]);

    const thisMonthTopupTotal = thisMonthTopupNonReseller + thisMonthTopupReseller;
    const prevMonthTopupTotal = prevMonthTopupNonReseller + prevMonthTopupReseller;

    const message =
      '*TOPUP BULANAN*\n\n' +
      `*${formatMonthLabel(thisMonth.labelDate)}*\n` +
      '- Total topup (gabungan): ' + formatRupiah(thisMonthTopupTotal) + '\n' +
      '- Topup non-reseller: ' + formatRupiah(thisMonthTopupNonReseller) + '\n' +
      '- Topup reseller: ' + formatRupiah(thisMonthTopupReseller) + '\n\n' +
      `*${formatMonthLabel(prevMonth.labelDate)}*\n` +
      '- Total topup (gabungan): ' + formatRupiah(prevMonthTopupTotal) + '\n' +
      '- Topup non-reseller: ' + formatRupiah(prevMonthTopupNonReseller) + '\n' +
      '- Topup reseller: ' + formatRupiah(prevMonthTopupReseller) + '\n\n' +
      '*JUMLAH USER*\n' +
      `- Reseller: ${roleCounts.resellerUsers}\n` +
      `- Non-reseller: ${roleCounts.nonResellerUsers}\n` +
      `- Total user: ${roleCounts.totalUsers}\n` +
      `- Total ID reseller terdaftar: ${roleCounts.resellerListCount}`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Gagal mengambil pendapatan topup bulanan non-reseller:', error.message);
    await ctx.reply('Gagal mengambil data pendapatan topup bulanan. Coba lagi.');
  }
});

bot.action('bonus_topup_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  const bonus = loadTopupBonusSetting();
  const statusLabel = bonus.enabled ? '✅ Aktif' : '🚫 Nonaktif';
  const message =
    '*🎁 BONUS TOPUP OTOMATIS*\n\n' +
    `Status: ${statusLabel}\n` +
    `• 10-40rb  : ${bonus.range_10_40}%\n` +
    `• 50-70rb  : ${bonus.range_50_70}%\n` +
    `• 70-100rb+: ${bonus.range_70_100}%\n\n` +
    'Pilih range untuk ubah persen bonus:';
  const keyboard = [
    [{ text: bonus.enabled ? '🚫 Nonaktifkan Bonus' : '✅ Aktifkan Bonus', callback_data: 'bonus_toggle' }],
    [{ text: 'Set 10-40rb', callback_data: 'bonus_set_10_40' }],
    [{ text: 'Set 50-70rb', callback_data: 'bonus_set_50_70' }],
    [{ text: 'Set 70-100rb+', callback_data: 'bonus_set_70_100' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_saldo' }]
  ];
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
});

bot.action('bonus_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  const current = loadTopupBonusSetting();
  current.enabled = !current.enabled;
  saveTopupBonusSetting(current);
  await ctx.reply(current.enabled ? '✅ Bonus topup diaktifkan.' : '🚫 Bonus topup dinonaktifkan.');
  return sendAdminSaldoMenu(ctx);
});

bot.action('bonus_set_10_40', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_10_40' };
  await ctx.reply('Masukkan persen bonus untuk topup 10-40rb (contoh: 5):');
});

bot.action('bonus_set_50_70', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_50_70' };
  await ctx.reply('Masukkan persen bonus untuk topup 50-70rb (contoh: 7):');
});

bot.action('bonus_set_70_100', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_70_100' };
  await ctx.reply('Masukkan persen bonus untuk topup 70-100rb+ (contoh: 10):');
});

bot.action('notif_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const tokenStatus = NOTIF_BOT_TOKEN ? '✅ Tersimpan' : '❌ Belum diisi';
  const chatStatus = NOTIF_CHAT_ID ? '✅ Tersimpan' : '❌ Belum diisi';
  const globalGroupStatus = GLOBAL_CREATE_NOTIF_GROUP_ID ? `✅ ${GLOBAL_CREATE_NOTIF_GROUP_ID}` : '❌ Belum diisi';
  const message =
    '*🔔 PENGATURAN NOTIF CREATE (BOT)*\n\n' +
    `Token Bot: ${tokenStatus}\n` +
    `Chat ID: ${chatStatus}\n` +
    `Group Global Create: ${globalGroupStatus}\n\n` +
    'Gunakan tombol di bawah untuk mengatur Token, Chat ID, dan Group Global.';

  const keyboard = [
    [{ text: 'Set Token Bot', callback_data: 'notif_set_token' }],
    [{ text: 'Set Chat ID', callback_data: 'notif_set_chat' }],
    [{ text: 'Set Group Global Create', callback_data: 'notif_set_global_group' }],
    [{ text: 'Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action('notif_set_global_group', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'notif_global_create_group_id' };
  await ctx.reply('Kirim *GROUP ID GLOBAL* untuk notif create akun.\nContoh: `-1001234567890`\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('notif_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'notif_bot_token' };
  await ctx.reply('Kirim *BOT TOKEN* untuk notifikasi create akun.\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('notif_set_chat', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'notif_chat_id' };
  await ctx.reply('Kirim *CHAT ID* tujuan notifikasi.\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('sc_webhook_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendScWebhookSettingsMenu(ctx);
});

bot.action('nginx_webhook_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendNginxWebhookMenu(ctx);
});

bot.action('nginx_webhook_generate', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  userState[ctx.chat.id] = { step: 'nginx_webhook_host_input_generate' };
  return ctx.reply(
    'Kirim domain/IP publik VPS bot untuk generate config Nginx.\n' +
    'Contoh: `47.236.58.59` atau `bot.domain.com`\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('nginx_webhook_auto_setup', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  userState[ctx.chat.id] = { step: 'nginx_webhook_host_input_auto' };
  return ctx.reply(
    'Kirim domain/IP publik VPS bot untuk AUTO setup Nginx webhook.\n' +
    'Contoh: `bot.domain.com` atau `47.236.58.59`\n' +
    'Catatan: SSL otomatis hanya bisa untuk domain.\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('nginx_webhook_set_url_from_host', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  userState[ctx.chat.id] = { step: 'nginx_webhook_host_input_seturl' };
  return ctx.reply(
    'Kirim domain/IP publik VPS bot untuk set URL webhook otomatis.\n' +
    'Format URL akan jadi: `http://DOMAIN_OR_IP/sc1forcr/events/multi-login`\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('sc_webhook_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('🚫 Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'sc_webhook_token' };
  return ctx.reply('Kirim token webhook SC.\nKetik "batal" untuk membatalkan.');
});

bot.action('sc_webhook_set_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('🚫 Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'sc_webhook_url' };
  return ctx.reply('Kirim URL webhook SC.\nContoh: https://domain-bot/sc1forcr/events/multi-login\nKetik "batal" untuk membatalkan.');
});

bot.action('sc_webhook_test', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('🚫 Anda tidak memiliki izin.');
  if (!SC_MULTI_LOGIN_WEBHOOK_URL || !BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN) {
    return ctx.reply('URL/token webhook belum diisi. Isi dulu di menu Webhook Multi-Login SC.');
  }
  try {
    await axios.post(
      SC_MULTI_LOGIN_WEBHOOK_URL,
      {
        event: 'MULTI_LOGIN',
        action: 'LOCK_TMP',
        service: 'VMESS',
        username: 'test-user',
        limitip: 1,
        detected: 3,
        ips: ['1.1.1.1', '2.2.2.2'],
        unlock_minutes: 15,
        owner_telegram_id: ctx.from.id,
        owner_telegram_chat_id: ctx.from.id
      },
      {
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN}`,
          'x-sc-event-token': BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN
        }
      }
    );
    return ctx.reply('✅ Test webhook terkirim. Cek apakah notif multi-login masuk ke akun Telegram kamu.');
  } catch (err) {
    const msg = err?.response?.data?.message || err?.message || 'unknown error';
    return ctx.reply(`❌ Test webhook gagal: ${msg}`);
  }
});

bot.action('bw_notif_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const status = BW_NOTIF_GROUP_ID_NUM ? `✅ ${BW_NOTIF_GROUP_ID_NUM}` : '❌ Belum diisi';
  const intervalText = formatBandwidthReportInterval(BW_REPORT_INTERVAL_MINUTES);
  const message =
    '*📶 PENGATURAN NOTIF BANDWIDTH SERVER*\n\n' +
    `Group ID tujuan notif BW: ${status}\n` +
    `Interval laporan otomatis: ${intervalText}\n` +
    'Anda bisa ubah ke menit atau jam.';

  const keyboard = [
    [{ text: 'Set Group ID Notif BW', callback_data: 'bw_notif_set_group_id' }],
    [{ text: 'Set Interval Laporan BW', callback_data: 'bw_notif_set_interval' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action('bw_notif_set_group_id', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'bw_notif_group_id' };
  await ctx.reply('Kirim *GROUP ID* tujuan notifikasi bandwidth.\nContoh: `-1001234567890`\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('bw_notif_set_interval', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'bw_notif_interval' };
  await ctx.reply(
    'Kirim interval laporan bandwidth.\n' +
    'Contoh: `180` (menit), `3 jam`, atau `30 menit`.\n' +
    'Rentang: 5 menit sampai 24 jam.\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

async function sendPaymentGatewayMainMenu(ctx) {
  reloadRuntimePaymentConfig();
  const message =
    '*SETTING PAYMENT GATEWAY*\n\n' +
    `Mode Gateway Aktif: \`${formatGatewayModeLabel()}\`\n\n` +
    `Masa Aktif QRIS: \`OrderKuota ${ORDERKUOTA_QR_EXPIRE_MINUTES} | GoPay ${GOPAY_QR_EXPIRE_MINUTES} | DANA ${DANA_BRIDGE_QR_EXPIRE_MINUTES} menit\`\n\n` +
    'Pilih mode gateway atau masuk ke submenu provider.';

  const keyboard = [
    [{ text: 'Mode: OrderKuota saja', callback_data: 'payment_gateway_mode_orderkuota' }],
    [{ text: 'Mode: GoPay saja', callback_data: 'payment_gateway_mode_gopay' }],
    [{ text: 'Mode: DANA Notifikasi', callback_data: 'payment_gateway_mode_dana_notification' }],
    [{ text: 'Mode: Keduanya (fallback)', callback_data: 'payment_gateway_mode_both' }],
    [{ text: '⏱️ Set Masa Aktif QRIS', callback_data: 'payment_gateway_set_all_qris_expire' }],
    [{ text: '⚙️ Setting OrderKuota', callback_data: 'payment_gateway_menu_orderkuota' }],
    [{ text: '⚙️ Setting GoPay', callback_data: 'payment_gateway_menu_gopay' }],
    [{ text: '⚙️ Setting DANA Notifikasi', callback_data: 'payment_gateway_menu_dana_notification' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendPaymentGatewayOrderKuotaMenu(ctx) {
  reloadRuntimePaymentConfig();
  const currentVars = loadVars();
  const message =
    '*SETTING ORDERKUOTA*\n\n' +
    `Mode Create QR: \`${formatOrderKuotaCreateModeLabel()}\`\n` +
    `Endpoint Lokal: \`/orderkuota/createpayment\`\n` +
    `Gateway URL: \`${ORDERKUOTA_CREATE_MODE === 'gateway' ? (PAYMENT_GATEWAY_BASE_URL || '-') : 'Tidak dipakai'}\`\n` +
    `Gateway API Key: \`${ORDERKUOTA_CREATE_MODE === 'gateway' ? maskSecret(RAJASERVER_API_KEY) : 'Tidak wajib'}\`\n` +
    `Local Endpoint API Key: \`${maskSecret(getLocalPaymentApiKey())}\`\n` +
    `QRIS String: \`${DATA_QRIS ? 'Tersimpan' : 'Belum diisi'}\`\n` +
    `ORKUT Username: \`${currentVars.ORKUT_USERNAME || 'Belum diisi'}\`\n` +
    `ORKUT Token: \`${maskSecret(currentVars.ORKUT_TOKEN)}\`\n` +
    `Merchant ID: \`${MERCHANT_ID || '-'}\`\n` +
    `API Key (legacy): \`${maskSecret(API_KEY)}\`\n` +
    `Expired QRIS: \`${ORDERKUOTA_QR_EXPIRE_MINUTES} menit\`\n` +
    `Minimal TopUp: \`Rp ${Math.round(getMinTopupByProvider('orderkuota')).toLocaleString('id-ID')}\`\n` +
    `Interval polling cek: \`${ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS} detik\`\n` +
    `Cooldown tombol cek: \`${ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS} detik\`\n` +
    `Maksimal tekan tombol: \`${ORDERKUOTA_CHECK_MAX_TAPS}x per transaksi\`\n` +
    `Auto-stop polling: \`${ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES} menit\`\n\n` +
    'Pilih parameter OrderKuota yang ingin diubah.';

  const keyboard = [
    [{ text: ORDERKUOTA_CREATE_MODE === 'gateway' ? 'Mode Create: Gateway' : 'Mode Create: Lokal', callback_data: 'payment_gateway_toggle_orderkuota_create_mode' }],
    [{ text: 'Set Gateway URL/Domain', callback_data: 'payment_gateway_set_url' }],
    [{ text: 'Set Gateway/Local API Key', callback_data: 'payment_gateway_set_raja_api_key' }],
    [{ text: 'Set QRIS String', callback_data: 'payment_gateway_set_qris' }],
    [{ text: 'Set ORKUT Username', callback_data: 'payment_gateway_set_orkut_username' }],
    [{ text: 'Set ORKUT Token', callback_data: 'payment_gateway_set_orkut_token' }],
    [{ text: 'Set Merchant ID', callback_data: 'payment_gateway_set_merchant_id' }],
    [{ text: 'Set API Key (legacy)', callback_data: 'payment_gateway_set_api_key' }],
    [{ text: 'Set Expired QRIS (menit)', callback_data: 'payment_gateway_set_orderkuota_expire' }],
    [{ text: 'Set Minimal TopUp', callback_data: 'payment_gateway_set_orderkuota_min_topup' }],
    [{ text: 'Set Interval Polling (detik)', callback_data: 'payment_gateway_set_orderkuota_poll_interval' }],
    [{ text: 'Set Cooldown Tombol (detik)', callback_data: 'payment_gateway_set_orderkuota_check_cooldown' }],
    [{ text: 'Set Maksimal Tekan Tombol', callback_data: 'payment_gateway_set_orderkuota_check_max_taps' }],
    [{ text: 'Set Stop Polling (menit)', callback_data: 'payment_gateway_set_orderkuota_poll_window' }],
    [{ text: '🔙 Kembali', callback_data: 'payment_gateway_settings_menu' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendPaymentGatewayGoPayMenu(ctx) {
  reloadRuntimePaymentConfig();
  const message =
    '*SETTING GOPAY*\n\n' +
    `GoPay API Base URL: \`${GOPAY_API_BASE_URL || '-'}\`\n` +
    `GoPay API Key: \`${maskSecret(GOPAY_API_KEY)}\`\n` +
    `Expired QRIS: \`${GOPAY_QR_EXPIRE_MINUTES} menit\`\n` +
    `Minimal TopUp: \`Rp ${Math.round(getMinTopupByProvider('gopay')).toLocaleString('id-ID')}\`\n\n` +
    'Pilih parameter GoPay yang ingin diubah.';

  const keyboard = [
    [{ text: 'Set GoPay API Base URL', callback_data: 'payment_gateway_set_gopay_base_url' }],
    [{ text: 'Set GoPay API Key', callback_data: 'payment_gateway_set_gopay_api_key' }],
    [{ text: 'Set Expired QRIS (menit)', callback_data: 'payment_gateway_set_gopay_expire' }],
    [{ text: 'Set Masa Aktif QRIS Semua Gateway', callback_data: 'payment_gateway_set_all_qris_expire' }],
    [{ text: 'Set Minimal TopUp', callback_data: 'payment_gateway_set_gopay_min_topup' }],
    [{ text: '🔙 Kembali', callback_data: 'payment_gateway_settings_menu' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendPaymentGatewayDanaMenu(ctx) {
  reloadRuntimePaymentConfig();
  const bridgeStatus = loadDanaBridgeStatus();
  const sharedWebhookOrigin = getSharedWebhookOrigin();
  const publicEventUrl = getDanaBridgePublicEventUrl();
  const lastSeen = Number(bridgeStatus.last_seen_at || 0);
  const lastSeenText = lastSeen
    ? new Date(lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })
    : 'Belum pernah terhubung';
  const message =
    '*SETTING DANA NOTIFIKASI*\n\n' +
    `Status aplikasi: \`${isDanaBridgeOnline() ? 'ONLINE' : 'OFFLINE'}\`\n` +
    `Terakhir aktif: \`${lastSeenText}\`\n` +
    `Device ID: \`${bridgeStatus.device_id || '-'}\`\n` +
    `Antrean HP: \`${Math.max(0, Number(bridgeStatus.queue_size || 0))}\`\n` +
    `Domain bersama: \`${sharedWebhookOrigin || 'Webhook SC belum diset'}\`\n` +
    `URL aplikasi: \`${sharedWebhookOrigin || '-'}\`\n` +
    `Endpoint event: \`${publicEventUrl || '/payment/dana-notification'}\`\n` +
    `Shared Secret: \`${maskSecret(DANA_BRIDGE_SECRET)}\`\n` +
    `QRIS DANA: \`${DANA_QRIS ? 'Tersimpan' : 'Belum diisi'}\`\n` +
    `Expired QRIS: \`${DANA_BRIDGE_QR_EXPIRE_MINUTES} menit\`\n` +
    `Minimal TopUp: \`Rp ${Math.round(getMinTopupByProvider('dana_notification')).toLocaleString('id-ID')}\`\n\n` +
    'Aplikasi Android harus online dan mengirim heartbeat sebelum top-up dapat dipakai.';

  const keyboard = [
    [{ text: 'Buat/Reset Shared Secret', callback_data: 'payment_gateway_generate_dana_secret' }],
    [{ text: 'Set Shared Secret Manual', callback_data: 'payment_gateway_set_dana_secret' }],
    [{ text: 'Set QRIS DANA Bisnis', callback_data: 'payment_gateway_set_dana_qris' }],
    [{ text: 'Set Expired QRIS', callback_data: 'payment_gateway_set_dana_expire' }],
    [{ text: 'Set Minimal TopUp', callback_data: 'payment_gateway_set_dana_min_topup' }],
    [{ text: 'Tampilkan URL dari Webhook SC', callback_data: 'payment_gateway_show_dana_url' }],
    [{ text: 'Refresh Status HP', callback_data: 'payment_gateway_menu_dana_notification' }],
    [{ text: '🔙 Kembali', callback_data: 'payment_gateway_settings_menu' }]
  ];
  return ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

bot.action('payment_gateway_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendPaymentGatewayMainMenu(ctx);
});

async function setPaymentGatewayMode(ctx, mode) {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const allowed = ['orderkuota', 'gopay', 'both', 'dana_notification'];
  if (!allowed.includes(mode)) return ctx.reply('Mode gateway tidak valid.');
  const nextVars = loadVars();
  nextVars.PAYMENT_GATEWAY_MODE = mode;
  saveVars(nextVars);
  reloadRuntimePaymentConfig();
  await ctx.answerCbQuery('Mode gateway tersimpan.');
  try {
    return await sendPaymentGatewayMainMenu(ctx);
  } catch (_) {
    return ctx.reply(`Mode gateway aktif: ${formatGatewayModeLabel()}`);
  }
}

bot.action('payment_gateway_mode_orderkuota', async (ctx) => setPaymentGatewayMode(ctx, 'orderkuota'));
bot.action('payment_gateway_mode_gopay', async (ctx) => setPaymentGatewayMode(ctx, 'gopay'));
bot.action('payment_gateway_mode_both', async (ctx) => setPaymentGatewayMode(ctx, 'both'));
bot.action('payment_gateway_mode_dana_notification', async (ctx) => setPaymentGatewayMode(ctx, 'dana_notification'));

bot.action('payment_gateway_toggle_orderkuota_create_mode', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const nextVars = loadVars();
  const currentMode = String(nextVars.ORDERKUOTA_CREATE_MODE || ORDERKUOTA_CREATE_MODE || 'local').toLowerCase();
  nextVars.ORDERKUOTA_CREATE_MODE = currentMode === 'gateway' ? 'local' : 'gateway';
  saveVars(nextVars);
  reloadRuntimePaymentConfig();
  try {
    return await sendPaymentGatewayOrderKuotaMenu(ctx);
  } catch (_) {
    return ctx.reply(`Mode create QR OrderKuota: ${formatOrderKuotaCreateModeLabel()}`);
  }
});

bot.action('payment_gateway_menu_orderkuota', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  return sendPaymentGatewayOrderKuotaMenu(ctx);
});

bot.action('payment_gateway_menu_gopay', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  return sendPaymentGatewayGoPayMenu(ctx);
});

bot.action('payment_gateway_menu_dana_notification', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  return sendPaymentGatewayDanaMenu(ctx);
});

bot.action('payment_gateway_generate_dana_secret', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const secret = crypto.randomBytes(32).toString('hex');
  const nextVars = loadVars();
  nextVars.DANA_BRIDGE_SECRET = secret;
  saveVars(nextVars);
  reloadRuntimePaymentConfig();
  await ctx.reply(
    'Shared Secret DANA baru dibuat. Masukkan nilai berikut ke aplikasi Android:\n\n' +
    `\`${secret}\`\n\nSecret lama langsung tidak berlaku.`,
    { parse_mode: 'Markdown' }
  );
  return sendPaymentGatewayDanaMenu(ctx);
});

bot.action('payment_gateway_set_dana_secret', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_dana_secret_input' };
  return ctx.reply('Kirim Shared Secret DANA minimal 32 karakter. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_dana_expire', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_dana_expire_input' };
  return ctx.reply('Kirim masa expired QRIS DANA dalam menit (1-180).');
});

bot.action('payment_gateway_set_dana_min_topup', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_dana_min_topup_input' };
  return ctx.reply('Kirim minimal topup DANA, minimal Rp 10.');
});

bot.action('payment_gateway_show_dana_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const origin = getSharedWebhookOrigin();
  if (!origin) {
    return ctx.reply('URL webhook multi-login belum diatur. Atur lewat menu Nginx Webhook terlebih dahulu.');
  }
  if (!origin.startsWith('https://')) {
    return ctx.reply(`Domain webhook masih HTTP dan ditolak aplikasi Android:\n${origin}\n\nPasang SSL terlebih dahulu.`);
  }
  return ctx.reply(
    'Masukkan URL berikut pada kolom URL Server Bot di aplikasi DANA Bridge:\n\n' +
    `<code>${escapeHtmlLocal(origin)}</code>\n\n` +
    `Endpoint event otomatis: <code>${escapeHtmlLocal(getDanaBridgePublicEventUrl())}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.action('payment_gateway_set_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_url_input' };
  await ctx.reply('Kirim URL/domain payment gateway eksternal. Ini hanya dipakai jika Mode Create QR diset Gateway. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_raja_api_key', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_raja_api_key_input' };
  await ctx.reply('Kirim API Key untuk gateway eksternal sekaligus endpoint lokal. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_qris', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_qris_input' };
  await ctx.reply('Kirim DATA_QRIS string baru. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_dana_qris', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_dana_qris_input' };
  await ctx.reply('Kirim string QRIS milik DANA Bisnis. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_orkut_username', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orkut_username_input' };
  await ctx.reply('Kirim ORKUT username untuk cek mutasi OrderKuota. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_orkut_token', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orkut_token_input' };
  await ctx.reply('Kirim ORKUT token untuk cek mutasi OrderKuota. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_merchant_id', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_merchant_id_input' };
  await ctx.reply('Kirim Merchant ID baru. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_api_key', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_api_key_input' };
  await ctx.reply('Kirim API Key legacy baru. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_orderkuota_expire', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_expire_input' };
  await ctx.reply('Kirim masa expired QRIS OrderKuota dalam menit. Contoh: 10. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_orderkuota_min_topup', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_min_topup_input' };
  await ctx.reply('Kirim minimal topup OrderKuota (angka rupiah). Contoh: 2000. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_orderkuota_poll_interval', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_poll_interval_input' };
  await ctx.reply('Kirim interval polling cek pembayaran OrderKuota (detik). Contoh: 10. Rentang 5-120 detik.');
});

bot.action('payment_gateway_set_orderkuota_check_cooldown', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_check_cooldown_input' };
  await ctx.reply('Kirim cooldown tombol cek pembayaran (detik). Contoh: 60. Rentang 10-600 detik.');
});

bot.action('payment_gateway_set_orderkuota_check_max_taps', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_check_max_taps_input' };
  await ctx.reply('Kirim maksimal jumlah tekan tombol cek per transaksi. Contoh: 5. Rentang 1-20 kali.');
});

bot.action('payment_gateway_set_orderkuota_poll_window', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_orderkuota_poll_window_input' };
  await ctx.reply('Kirim durasi auto-stop polling setelah tombol cek ditekan (menit). Contoh: 3. Rentang 1-30 menit.');
});

bot.action('payment_gateway_set_gopay_base_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_gopay_base_url_input' };
  await ctx.reply('Kirim GoPay API base URL. Contoh: https://api-gopay.sawargipay.cloud. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_gopay_api_key', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_gopay_api_key_input' };
  await ctx.reply('Kirim GoPay API Key baru. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_gopay_expire', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_gopay_expire_input' };
  await ctx.reply('Kirim masa expired QRIS GoPay dalam menit. Contoh: 15. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_all_qris_expire', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_all_qris_expire_input' };
  await ctx.reply('Kirim masa aktif QRIS untuk semua gateway (OrderKuota + GoPay + DANA) dalam menit. Contoh: 15. Ketik "batal" untuk membatalkan.');
});

bot.action('payment_gateway_set_gopay_min_topup', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'payment_gateway_gopay_min_topup_input' };
  await ctx.reply('Kirim minimal topup GoPay (angka rupiah). Contoh: 2000. Ketik "batal" untuk membatalkan.');
});
bot.action('restore_db_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const keyboard = [
    [{ text: 'Restore sellvpn.db', callback_data: 'restore_db_target_sellvpn' }],
    [{ text: 'Restore ressel.db', callback_data: 'restore_db_target_ressel' }],
    [{ text: 'Import DB Bot Lain', callback_data: 'restore_foreign_db_upload' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.reply('Pilih database yang ingin di-restore:', {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action('restore_foreign_db_upload', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak memiliki izin untuk import database.');
  }
  const nextState = { step: 'restore_foreign_db_upload' };
  userState[ctx.chat.id] = nextState;
  userState[ctx.from.id] = nextState;
  return ctx.reply(
    '<b>Import Database Bot Lain</b>\n\n' +
    'Upload file SQLite <code>.db</code> sebagai document. Bot akan memvalidasi dan menampilkan preview sebelum data diimport.\n\n' +
    'Import tidak menimpa file <code>sellvpn.db</code>. Data akan dikonversi dan digabungkan.\n' +
    'Ketik <code>batal</code> untuk membatalkan.',
    { parse_mode: 'HTML' }
  );
});

function formatForeignDbPreview(info, fileName) {
  const protocols = Object.entries(info.protocols || {})
    .map(([name, count]) => `${String(name).toUpperCase()}: ${count}`)
    .join(', ') || '-';
  return (
    '<b>Preview Import DB Bot Lain</b>\n\n' +
    `File: <code>${escapeHtml(fileName || 'backup.db')}</code>\n` +
    `Format: <code>${escapeHtml(info.format)}</code>\n` +
    `Ukuran: <code>${Math.ceil(Number(info.size || 0) / 1024)} KB</code>\n` +
    `Fingerprint: <code>${escapeHtml(String(info.fingerprint || '').slice(0, 16))}</code>\n\n` +
    `User: <b>${info.counts.users}</b>\n` +
    `Total saldo backup: <b>Rp ${Number(info.totalBalance || 0).toLocaleString('id-ID')}</b>\n` +
    `Reseller: <b>${info.counts.resellers}</b>\n` +
    `Server: <b>${info.counts.servers}</b>\n` +
    `Akun: <b>${info.counts.accounts}</b> (${escapeHtml(protocols)})\n` +
    `Transaksi: <b>${info.counts.transactions}</b>\n` +
    `Log trial: <b>${info.counts.trials}</b>\n` +
    `Akun dengan server lama yang sudah hilang: <b>${info.counts.missingServerAccounts}</b>\n\n` +
    '<b>Import Aman</b>: saldo user yang sudah ada tetap dipertahankan.\n' +
    '<b>Timpa Saldo</b>: saldo user yang sudah ada diganti dengan saldo dari backup.\n\n' +
    'Server dari bot lama diimport dalam kondisi nonaktif karena file ini tidak memiliki token API auth.'
  );
}

function backupOpenSqliteDatabase(destinationPath) {
  return new Promise((resolve, reject) => {
    if (typeof db.backup !== 'function') {
      return reject(new Error('Fitur SQLite online backup tidak tersedia.'));
    }
    db.backup(destinationPath, (err) => err ? reject(err) : resolve());
  });
}

async function cleanupForeignRestoreState(ctx) {
  const state = userState[ctx.chat.id] || userState[ctx.from.id];
  if (state && state.foreignDbTempPath) {
    await fsPromises.unlink(state.foreignDbTempPath).catch(() => {});
  }
  delete userState[ctx.chat.id];
  delete userState[ctx.from.id];
}

bot.action('foreign_db_import_cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await cleanupForeignRestoreState(ctx);
  return ctx.reply('Import database bot lain dibatalkan.');
});

bot.action('foreign_db_import_overwrite_warning', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const state = userState[ctx.chat.id];
  if (!state || state.step !== 'restore_foreign_db_preview' || !state.foreignDbTempPath) {
    return ctx.reply('Sesi import sudah tidak tersedia. Upload ulang database.');
  }
  const nextState = { ...state, step: 'restore_foreign_db_overwrite_confirm' };
  userState[ctx.chat.id] = nextState;
  userState[ctx.from.id] = nextState;
  return ctx.reply(
    '<b>Konfirmasi Timpa Saldo</b>\n\n' +
    'Saldo semua user yang juga ada di backup akan diganti dengan nilai dari backup. Backup database aktif dibuat terlebih dahulu.',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Ya, Timpa Saldo', callback_data: 'foreign_db_import_overwrite_confirm' }],
          [{ text: 'Batal', callback_data: 'foreign_db_import_cancel' }]
        ]
      }
    }
  );
});

bot.action(/foreign_db_import_(keep|overwrite_confirm)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');

  const mode = ctx.match[1];
  const state = userState[ctx.chat.id];
  const expectedStep = mode === 'keep'
    ? 'restore_foreign_db_preview'
    : 'restore_foreign_db_overwrite_confirm';
  if (!state || state.step !== expectedStep || !state.foreignDbTempPath) {
    return ctx.reply('Sesi import sudah tidak tersedia. Upload ulang database.');
  }

  const backupDir = runtimePath('backup', 'foreign_restore', String(Date.now()));
  try {
    await fsPromises.mkdir(backupDir, { recursive: true });
    await backupOpenSqliteDatabase(path.join(backupDir, 'sellvpn.before_import.db'));
    for (const plainFile of [resselFilePath, trialFile]) {
      if (fs.existsSync(plainFile)) {
        await fsPromises.copyFile(plainFile, path.join(backupDir, path.basename(plainFile)));
      }
    }

    await ctx.reply('Database valid. Proses import dimulai...');
    const result = await importForeignBotDatabase({
      sourcePath: state.foreignDbTempPath,
      sourceName: state.foreignDbOriginalName,
      targetDb: db,
      overwriteBalances: mode === 'overwrite_confirm',
      resellerFilePath: resselFilePath,
      trialFilePath: trialFile
    });
    const summary = result.summary;
    await cleanupForeignRestoreState(ctx);

    return ctx.reply(
      '<b>Import DB Bot Lain Berhasil</b>\n\n' +
      `User baru: <b>${summary.usersInserted}</b>\n` +
      `Saldo user ditimpa: <b>${summary.usersUpdated}</b>\n` +
      `Saldo user dipertahankan: <b>${summary.usersKept}</b>\n` +
      `Reseller baru: <b>${summary.resellersAdded}</b>\n` +
      `Server nonaktif baru: <b>${summary.serversInserted}</b>\n` +
      `Server cocok dengan data lama: <b>${summary.serversMatched}</b>\n` +
      `Akun baru: <b>${summary.accountsInserted}</b>\n` +
      `Akun digabung: <b>${summary.accountsMerged}</b>\n` +
      `Transaksi baru: <b>${summary.transactionsInserted}</b>\n` +
      `Log trial digabung: <b>${summary.trialsMerged}</b>\n\n` +
      `Backup sebelum import: <code>${escapeHtml(backupDir)}</code>` +
      (summary.warnings.length ? `\n\nPeringatan:\n${escapeHtml(summary.warnings.join('\n'))}` : ''),
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('Gagal import database bot lain: ' + err.message);
    return ctx.reply(
      `Gagal import database bot lain: ${err.message}\n\n` +
      `Backup sebelum import tersimpan di: ${backupDir}`
    );
  }
});

bot.action(/restore_db_target_(sellvpn|ressel)/, async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk melakukan aksi ini.');
  }

  const target = ctx.match[1];
  userState[ctx.chat.id] = { step: 'restore_db_upload', target };

  await ctx.reply(
    'Upload file backup untuk ' + target + '.db dalam format document.\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});


bot.action('main_menu_settings', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendMainMenuSettings(ctx);
});

bot.action('main_menu_set_admin_telegram', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'main_menu_admin_telegram' };
  return ctx.reply('Kirim username Telegram admin untuk ditampilkan di menu utama.\nContoh: @myadmin\nKetik "batal" untuk membatalkan.');
});

bot.action(/main_menu_toggle_(group|channel)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const target = ctx.match[1];
  if (target === 'group') {
    if (!MAIN_MENU_GROUP_ENABLED && !MAIN_MENU_GROUP_URL) {
      userState[ctx.chat.id] = { step: 'main_menu_group_button' };
      return ctx.reply('Link grup belum diset. Kirim format:\nNama Tombol | https://t.me/username');
    }
    saveMainMenuRuntimeVars({ MAIN_MENU_GROUP_ENABLED: !MAIN_MENU_GROUP_ENABLED });
  } else {
    if (!MAIN_MENU_CHANNEL_ENABLED && !MAIN_MENU_CHANNEL_URL) {
      userState[ctx.chat.id] = { step: 'main_menu_channel_button' };
      return ctx.reply('Link channel belum diset. Kirim format:\nNama Tombol | https://t.me/username');
    }
    saveMainMenuRuntimeVars({ MAIN_MENU_CHANNEL_ENABLED: !MAIN_MENU_CHANNEL_ENABLED });
  }

  return sendMainMenuSettings(ctx);
});

bot.action('main_menu_toggle_tutorial', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  saveMainMenuRuntimeVars({ MAIN_MENU_TUTORIAL_ENABLED: !MAIN_MENU_TUTORIAL_ENABLED });
  return sendMainMenuSettings(ctx);
});

bot.action(/main_menu_set_(group|channel)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const target = ctx.match[1];
  userState[ctx.chat.id] = { step: `main_menu_${target}_button` };
  return ctx.reply(
    `Kirim nama tombol dan link ${target === 'group' ? 'grup' : 'channel'} dengan format:\n` +
    `Nama Tombol | https://t.me/username\n\n` +
    `Link juga boleh pakai @username. Ketik "batal" untuk membatalkan.`
  );
});

bot.action('admin_contact_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const wa = getAdminWhatsappNumber();
  const tg = getAdminTelegramUsername();
  const keyboard = [
    [{ text: 'Set Nomor WhatsApp', callback_data: 'admin_set_whatsapp' }],
    [{ text: 'Set Username Telegram', callback_data: 'admin_set_telegram' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(
    '*📞 PENGATURAN KONTAK ADMIN*\n\n' +
    'WhatsApp: ' + (wa || '-') + '\n' +
    'Telegram: `' + tg + '`',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
});

bot.action('admin_set_whatsapp', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'admin_contact_whatsapp' };
  await ctx.reply('Kirim nomor WhatsApp admin (format internasional, contoh: 6281234567890).\nKetik "batal" untuk membatalkan.');
});

bot.action('admin_set_telegram', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'admin_contact_telegram' };
  await ctx.reply('Kirim username Telegram admin (contoh: @myadmin atau myadmin).\nKetik "batal" untuk membatalkan.');
});
bot.action('toggle_topup_manual', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const current = loadTopupManualSetting();
  const next = saveTopupManualSetting(!current);
  const statusText = next ? '✅ TopUp manual diaktifkan.' : '🚫 TopUp manual dinonaktifkan.';
  await ctx.reply(statusText);
  return sendMainMenuSettings(ctx);
});

bot.action('toggle_topup_auto', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const current = loadTopupAutoSetting();
  const next = saveTopupAutoSetting(!current);
  const statusText = next ? '✅ TopUp otomatis diaktifkan.' : '🚫 TopUp otomatis dinonaktifkan.';
  await ctx.reply(statusText);
  return sendAdminSaldoMenu(ctx);
});

bot.action('toggle_sc_nexus_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const current = loadScNexusMenuSetting();
  const next = saveScNexusMenuSetting(!current);
  const statusText = next
    ? '✅ Menu SC 1FORCR NEXUS diaktifkan.'
    : '🚫 Menu SC 1FORCR NEXUS dinonaktifkan.';
  await ctx.reply(statusText);
  return sendMainMenuSettings(ctx);
});

bot.action('admin_menu_reseller', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminResellerMenu(ctx);
});

bot.action('admin_menu_tools', async (ctx) => {
  await ctx.answerCbQuery();
  delete userState[ctx.chat.id];
  await sendAdminToolsMenu(ctx);
});

bot.action('generator_api_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendGeneratorApiSettingsMenu(ctx);
});

bot.action('generator_api_set_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'generator_api_url_input' };
  return ctx.reply(
    'Kirim URL base API generator.\n' +
    `Contoh: \`${DEFAULT_GENERATOR_API_URL}\`\n` +
    'Ketik `-` untuk reset ke default.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('generator_api_set_key', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'generator_api_key_input' };
  return ctx.reply(
    'Kirim API key generator.\n' +
    'Key akan disimpan di `.vars.json` dan hanya ditampilkan dalam bentuk masked.\n' +
    'Ketik `hapus` untuk mengosongkan key.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('generator_api_set_timeout', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'generator_api_timeout_input' };
  return ctx.reply(
    'Kirim timeout request API generator dalam detik.\n' +
    'Contoh: `120`\n' +
    'Rentang: 10 sampai 300 detik.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('generator_api_test', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  try {
    const info = await getGeneratorInfo(getGeneratorApiConfig());
    const version = info?.version || info?.appVersion || '-';
    const service = info?.service || info?.name || 'Generator API';
    const key = info?.key || {};
    const scopes = Array.isArray(key.scopes) && key.scopes.length ? key.scopes.join(', ') : '-';
    return ctx.reply(
      '<b>✅ Generator API terhubung</b>\n\n' +
      `Service: <code>${escapeHtml(service)}</code>\n` +
      `Version: <code>${escapeHtml(version)}</code>\n` +
      `Key: <code>${escapeHtml(key.label || key.id || '-')}</code>\n` +
      `Scope: <code>${escapeHtml(scopes)}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Kembali ke Generator API', callback_data: 'generator_api_settings_menu' }]]
        }
      }
    );
  } catch (err) {
    return ctx.reply(
      '<b>❌ Generator API gagal dihubungi</b>\n\n' +
      `Detail: <code>${escapeHtml(err.message || 'unknown error')}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Kembali ke Generator API', callback_data: 'generator_api_settings_menu' }]]
        }
      }
    );
  }
});

bot.action('admin_download_config_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendAdminDownloadConfigMenu(ctx);
});

bot.action('admin_bulk_config_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendAdminBulkConfigMenu(ctx);
});

bot.action(/admin_bulk_config_(hc|dark)_(ssh|xray|vmess|vless|trojan)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan menu ini.');
  }

  const format = ctx.match[1];
  const method = ctx.match[2];
  if (format === 'hc' && !['ssh', 'xray'].includes(method)) {
    return ctx.reply('Metode bulk HC tidak valid.');
  }
  if (format === 'dark' && !['ssh', 'vmess', 'vless', 'trojan'].includes(method)) {
    return ctx.reply('Metode bulk Dark Tunnel tidak valid.');
  }

  return startAdminBulkConfigFlow(ctx, format, method);
});

bot.action('admin_hc_template_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendAdminHcTemplateMenu(ctx);
});

bot.action(/admin_hc_template_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendAdminHcTemplateMenu(ctx, Number(ctx.match[1]));
});

bot.action(/admin_hc_template_manage_(\d+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  return sendAdminHcTemplateActionMenu(
    ctx,
    Number(ctx.match[1]),
    Number(ctx.match[2])
  );
});

bot.action('admin_hc_template_upload', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk upload template HC.');
  }

  userState[ctx.chat.id] = { step: 'admin_hc_template_upload_document' };
  return ctx.reply(
    `Kirim file template HC sebagai document. Bisa kirim 1 sampai ${HC_TEMPLATE_UPLOAD_MAX_FILES} file sekaligus.\n` +
    'Jika kirim 1 file, bot akan meminta nama template.\n' +
    'Jika kirim lebih dari 1 file, nama template otomatis memakai nama file.\n' +
    'Bot akan memproses setelah semua file terkirim beberapa detik.\n' +
    'Disarankan kirim file .hc asli yang sudah valid di HTTP Custom. File akan diproses oleh API generator private saat user membuat config.\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_hc_note_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah note default HC.');
  }

  const current = loadHcDefaultNoteSetting();
  const hasNote = String(current.html || '').trim().length > 0;
  if (!current.enabled && !hasNote) {
    userState[ctx.chat.id] = { step: 'admin_hc_note_input' };
    return ctx.reply(
      'Note default masih kosong.\n\n' +
      'Kirim isi note HTML sekarang. Bot akan menyimpan dan mengaktifkannya.\n\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  }

  const next = saveHcDefaultNoteSetting({ enabled: !current.enabled });
  await ctx.reply(next.enabled ? 'Note default HC diaktifkan.' : 'Note default HC dinonaktifkan.');
  return sendAdminHcTemplateMenu(ctx);
});

bot.action('admin_hc_note_set', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah note default HC.');
  }

  userState[ctx.chat.id] = { step: 'admin_hc_note_input' };
  return ctx.reply(
    'Kirim isi note default HC dalam bentuk HTML.\n\n' +
    'Note ini akan dipakai saat Note Default aktif. Kirim "-" untuk mengosongkan note.\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_hc_note_clear', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menghapus note default HC.');
  }

  saveHcDefaultNoteSetting({ enabled: false, html: '' });
  await ctx.reply('Note default HC berhasil dihapus dan dinonaktifkan.');
  return sendAdminHcTemplateMenu(ctx);
});

bot.action(/admin_hc_template_rename_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah template HC.');
  }

  const templateId = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT id, name FROM hc_config_templates WHERE id = ?', [templateId]).catch(() => null);
  if (!row) {
    return ctx.reply('Template HC tidak ditemukan.');
  }

  userState[ctx.chat.id] = {
    step: 'admin_hc_template_rename_input',
    templateId: row.id,
    currentName: row.name || ''
  };

  return ctx.reply(
    `Nama saat ini: ${row.name || '-'}\n\n` +
    'Kirim nama template baru.\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/admin_hc_template_replace_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengganti template HC.');
  }

  const templateId = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT id, name FROM hc_config_templates WHERE id = ?', [templateId]).catch(() => null);
  if (!row) {
    return ctx.reply('Template HC tidak ditemukan.');
  }

  userState[ctx.chat.id] = {
    step: 'admin_hc_template_replace_document',
    templateId: row.id,
    currentName: row.name || ''
  };

  return ctx.reply(
    `Ganti file template untuk: ${row.name || `Template ${row.id}`}\n\n` +
    'Kirim file `.hc` asli dari HTTP Custom.\n' +
    'Nama template tetap sama; yang diganti hanya isi confignya.\n\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/admin_hc_template_delete_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menghapus template HC.');
  }

  const templateId = Number(ctx.match[1]);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return ctx.reply('ID template tidak valid.');
  }

  const result = await dbRunAsync('DELETE FROM hc_config_templates WHERE id = ?', [templateId]).catch((err) => {
    logger.error('Gagal menghapus template HC:', err.message);
    return null;
  });

  if (!result) {
    return ctx.reply('Gagal menghapus template HC.');
  }

  await ctx.reply(result.changes > 0 ? 'Template HC berhasil dihapus.' : 'Template HC tidak ditemukan.');
  return sendAdminHcTemplateMenu(ctx);
});

bot.action('admin_dark_template_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendAdminDarkTemplateMenu(ctx);
});

bot.action(/admin_dark_template_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  return sendAdminDarkTemplateMenu(ctx, Number(ctx.match[1]));
});

bot.action(/admin_dark_template_manage_(\d+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  return sendAdminDarkTemplateActionMenu(
    ctx,
    Number(ctx.match[1]),
    Number(ctx.match[2])
  );
});

bot.action('admin_dark_template_upload', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk upload template Dark Tunnel.');
  }

  userState[ctx.chat.id] = { step: 'admin_dark_template_upload_document' };
  return ctx.reply(
    `Kirim file template Dark Tunnel sebagai document. Bisa kirim 1 sampai ${DARK_TEMPLATE_UPLOAD_MAX_FILES} file sekaligus.\n` +
    'Atau paste 1 link config <code>darktunnel://...</code> sebagai teks.\n' +
    'Jika kirim 1 file, bot akan meminta nama template.\n' +
    'Jika kirim lebih dari 1 file, nama template otomatis memakai nama file.\n' +
    'Bot akan memproses setelah semua file terkirim beberapa detik.\n\n' +
    'Format yang diterima: .dark asli Dark Tunnel.\n\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'HTML' }
  );
});

bot.action('admin_dark_note_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah note default Dark Tunnel.');
  }
  saveDarkDefaultNoteSetting({ enabled: false });
  await ctx.reply('Note custom Dark Tunnel dinonaktifkan. Message file .dark akan mengikuti bawaan template agar tetap bisa di-import.');
  return sendAdminDarkTemplateMenu(ctx);
});

bot.action('admin_dark_note_set', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah note default Dark Tunnel.');
  }
  saveDarkDefaultNoteSetting({ enabled: false });
  return ctx.reply('Note custom Dark Tunnel belum dipakai karena membuat APK menolak config. Gunakan note bawaan template .dark.');
});

bot.action('admin_dark_note_clear', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menghapus note default Dark Tunnel.');
  }

  saveDarkDefaultNoteSetting({ enabled: false, html: '' });
  await ctx.reply('Note default Dark Tunnel berhasil dihapus dan dinonaktifkan.');
  return sendAdminDarkTemplateMenu(ctx);
});

bot.action(/admin_dark_template_rename_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah template Dark Tunnel.');
  }

  const templateId = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT id, name FROM dark_config_templates WHERE id = ?', [templateId]).catch(() => null);
  if (!row) {
    return ctx.reply('Template Dark Tunnel tidak ditemukan.');
  }

  userState[ctx.chat.id] = {
    step: 'admin_dark_template_rename_input',
    templateId: row.id,
    currentName: row.name || ''
  };

  return ctx.reply(
    `Nama saat ini: ${row.name || '-'}\n\n` +
    'Kirim nama template baru.\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/admin_dark_template_replace_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengganti template Dark Tunnel.');
  }

  const templateId = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT id, name FROM dark_config_templates WHERE id = ?', [templateId]).catch(() => null);
  if (!row) {
    return ctx.reply('Template Dark Tunnel tidak ditemukan.');
  }

  userState[ctx.chat.id] = {
    step: 'admin_dark_template_replace_document',
    templateId: row.id,
    currentName: row.name || ''
  };

  return ctx.reply(
    `Ganti file template untuk: ${row.name || `Template ${row.id}`}\n\n` +
    'Kirim file `.dark` asli dari Dark Tunnel, atau paste link `darktunnel://...`.\n' +
    'Nama template tetap sama; yang diganti hanya isi confignya.\n\n' +
    'Ketik "batal" untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/admin_dark_template_delete_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menghapus template Dark Tunnel.');
  }

  const templateId = Number(ctx.match[1]);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return ctx.reply('ID template tidak valid.');
  }

  const result = await dbRunAsync('DELETE FROM dark_config_templates WHERE id = ?', [templateId]).catch((err) => {
    logger.error('Gagal menghapus template Dark Tunnel:', err.message);
    return null;
  });

  if (!result) {
    return ctx.reply('Gagal menghapus template Dark Tunnel.');
  }

  await ctx.reply(result.changes > 0 ? 'Template Dark Tunnel berhasil dihapus.' : 'Template Dark Tunnel tidak ditemukan.');
  return sendAdminDarkTemplateMenu(ctx);
});

bot.action('admin_config_upload', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk upload config.');
  }

  userState[ctx.chat.id] = { step: 'admin_config_upload_document' };
  return ctx.reply(
    'Kirim file config sebagai document.\n' +
    'Setelah file diterima, bot akan meminta nama config.\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/admin_config_delete_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menghapus config.');
  }

  const configId = Number(ctx.match[1]);
  if (!Number.isInteger(configId) || configId <= 0) {
    return ctx.reply('ID config tidak valid.');
  }

  const result = await dbRunAsync('DELETE FROM download_configs WHERE id = ?', [configId]).catch((err) => {
    logger.error('Gagal menghapus download config:', err.message);
    return null;
  });

  if (!result) {
    return ctx.reply('Gagal menghapus config.');
  }

  await ctx.reply(result.changes > 0 ? 'Config berhasil dihapus.' : 'Config tidak ditemukan.');
  return sendAdminDownloadConfigMenu(ctx);
});

bot.action('maintenance_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  return sendMaintenanceMenu(ctx);
});

bot.action('maintenance_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  const current = loadMaintenanceSetting();
  const next = saveMaintenanceSetting({
    enabled: !current.enabled,
    estimate: current.estimate || ''
  });
  await ctx.reply(next.enabled ? '✅ Mode maintenance diaktifkan.' : '✅ Mode maintenance dinonaktifkan.');
  return sendMaintenanceMenu(ctx);
});

bot.action('maintenance_set_estimate', async (ctx) => {
  await ctx.answerCbQuery();
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'maintenance_estimate_input' };
  return ctx.reply('Masukkan estimasi maintenance. Contoh: 30 menit atau 2 jam.\nKetik "batal" untuk membatalkan.');
});

bot.action('helpadmin_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await sendHelpAdmin(ctx);
});


bot.action('admin_broadcast_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  userState[ctx.chat.id] = { step: 'admin_broadcast_message' };
  return ctx.reply('Masukkan pesan yang ingin disiarkan.\n\nKetik "batal" untuk membatalkan.');
});

bot.action('admin_broadcast_poll_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  userState[ctx.chat.id] = { step: 'admin_broadcast_poll_only_input' };
  return ctx.reply(
    'Masukkan polling dengan format:\n' +
    'Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n\n' +
    'Contoh:\n' +
    'Server favorit minggu ini? | SG1 | SG2 | ID1\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_broadcast_add_poll_yes', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id];
  if (!state || state.step !== 'admin_broadcast_choose_poll') {
    return ctx.reply('Sesi broadcast tidak ditemukan. Ulangi dari menu tools.');
  }

  state.step = 'admin_broadcast_poll_input';
  return ctx.reply(
    'Masukkan polling dengan format:\n' +
    'Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n\n' +
    'Contoh:\n' +
    'Server favorit minggu ini? | SG1 | SG2 | ID1\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_broadcast_add_poll_no', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id];
  if (!state || state.step !== 'admin_broadcast_choose_poll') {
    return ctx.reply('Sesi broadcast tidak ditemukan. Ulangi dari menu tools.');
  }

  const msg = String(state.message || '').trim();
  if (!msg) {
    delete userState[ctx.chat.id];
    return ctx.reply('Pesan broadcast kosong. Ulangi dari menu tools.');
  }

  const result = await broadcastMessageToAllUsers(msg, ctx.chat.id);
  delete userState[ctx.chat.id];

  await ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast pesan'));

  return sendAdminToolsMenu(ctx);
});
bot.action('reseller_terms_trigger', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menjalankan cek ini.');
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const periodLabel = start.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    await evaluateResellerTermsForPeriod(start.getTime(), end.getTime(), periodLabel);
    await ctx.reply(`✅ Cek syarat reseller untuk periode ${periodLabel} selesai.`);
  } catch (err) {
    logger.error('Error trigger cek syarat reseller:', err.message);
    await ctx.reply('❌ Gagal menjalankan cek syarat reseller.');
  }
});

bot.action('reseller_restore', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah reseller.');
  }

  userState[ctx.chat.id] = { step: 'reseller_restore_input' };
  await ctx.reply('Kirim ID Telegram reseller yang ingin diaktifkan kembali:');
});

bot.action('auto_backup_now', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menjalankan backup.');
  }

  const files = [
    runtimePath('sellvpn.db'),
    runtimePath('ressel.db')
  ];

  for (const filePath of files) {
    if (fs.existsSync(filePath)) {
      await sendAutoBackup(filePath, adminId);
    } else {
      logger.warn(`Backup manual dilewati, file tidak ditemukan: ${filePath}`);
    }
  }

  await ctx.reply('✅ Backup otomatis telah dikirim.');
});
bot.action('admin_sync_server_now', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menjalankan sinkronisasi server.');
  }

  try {
    await ctx.reply('Menjalankan sinkronisasi server...');
    const result = await syncServerUsageFromTunnel('manual_button', { force: true });

    const lines = [
      'Sync server selesai.',
      `Dicek: ${result.checked}`,
      `Berhasil: ${result.updated}`,
      `Gagal: ${result.failed}`,
      `Dilewati: ${result.skipped}`,
      '',
      `Total akun aktif: ${result.totals.used}`,
      `Total akun tersisa: ${result.totals.remaining}`,
      `Total kapasitas: ${result.totals.capacity}`
    ];

    if (result.errors.length > 0) {
      const preview = result.errors.slice(0, 5)
        .map((e) => `- ${e.serverName || e.serverId}: ${e.message}`)
        .join('\n');
      lines.push('', 'Detail gagal (maks 5):', preview);
    }

    await ctx.reply(lines.join('\n'));
  } catch (err) {
    logger.error('Gagal sync server dari tombol admin:', err.message);
    await ctx.reply('Gagal menjalankan sinkronisasi server.');
  }
});
bot.action('admin_sync_server_toggle_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengatur autosync server.');
  }
  await sendAdminSyncToggleMenu(ctx);
});

bot.action(/admin_sync_server_toggle_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengatur autosync server.');
  }

  const serverId = Number(ctx.match[1]);
  if (!Number.isFinite(serverId)) {
    return ctx.reply('ID server tidak valid.');
  }

  db.get('SELECT id, sync_enabled FROM Server WHERE id = ?', [serverId], (err, row) => {
    if (err) {
      logger.error('Gagal membaca status sync server:', err.message);
      return ctx.reply('Gagal membaca status autosync server.');
    }

    if (!row) {
      return ctx.reply('Server tidak ditemukan.');
    }

    const nextValue = Number(row.sync_enabled) === 1 ? 0 : 1;
    db.run('UPDATE Server SET sync_enabled = ? WHERE id = ?', [nextValue, serverId], async (updateErr) => {
      if (updateErr) {
        logger.error('Gagal mengubah status autosync server:', updateErr.message);
        return ctx.reply('Gagal mengubah status autosync server.');
      }

      await sendAdminSyncToggleMenu(ctx);
    });
  });
});


bot.action('reseller_terms_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const adminId = ctx.from.id;
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
    }

    const terms = loadResellerTerms();
    const message =
      '*SYARAT RESELLER*\n\n' +
      `Minimal top up jadi reseller: ${formatRupiah(terms.join_topup_min)}\n` +
      `Minimal top up per bulan: ${formatRupiah(terms.min_topup)}\n\n` +
      'Gunakan tombol di bawah untuk mengubah syarat.';

    const keyboard = [
      [{ text: 'Set Minimal TopUp Jadi Reseller', callback_data: 'reseller_terms_set_join' }],
      [{ text: 'Set Minimal TopUp Bulanan', callback_data: 'reseller_terms_set' }],
      [{ text: 'Kembali', callback_data: 'admin_menu' }]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply('Gagal membuka menu. Silakan coba lagi.');
    } else {
      logger.error('Error membuka menu syarat reseller:', error.message);
    }
  }
});

bot.action('reseller_terms_set', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah syarat.');
  }

  userState[ctx.chat.id] = { step: 'reseller_terms_input' };
  await ctx.reply(
    'Kirim format: <min_topup>\n' +
    'Contoh: 30000\n' +
    'Ketik \"batal\" untuk membatalkan.'
  );
});

bot.action('reseller_terms_set_join', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah syarat.');
  }

  userState[ctx.chat.id] = { step: 'reseller_join_topup_input' };
  await ctx.reply(
    'Kirim format: <minimal_topup_jadi_reseller>\n' +
    'Contoh: 18000\n' +
    'Ketik \"batal\" untuk membatalkan.'
  );
});

bot.command('addressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/addressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Baca file ressel.db jika ada, kalau tidak, buat file baru
    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    // Cek apakah ID sudah ada
    if (resellerList.includes(targetId)) {
      return ctx.reply(`⚠️ User dengan ID ${targetId} sudah menjadi reseller.`);
    }

    // Tambahkan ID ke file
    fs.appendFileSync(resselFilePath, `${targetId}\n`);
    ctx.reply(`✅ User dengan ID ${targetId} berhasil dijadikan reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /addressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

bot.command('delressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/delressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Cek apakah file ressel.db ada
    if (!fs.existsSync(resselFilePath)) {
      return ctx.reply('📁 File reseller belum dibuat.');
    }

    // Baca file dan filter ulang tanpa targetId
    const fileContent = fs.readFileSync(resselFilePath, 'utf8');
    const resellerList = fileContent.split('\n').filter(line => line.trim() !== '' && line.trim() !== targetId);

    // Tulis ulang file dengan data yang sudah difilter
    fs.writeFileSync(resselFilePath, resellerList.join('\n') + (resellerList.length ? '\n' : ''));

    ctx.reply(`✅ User dengan ID ${targetId} berhasil dihapus dari daftar reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /delressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

///////
// Saat admin mengirim foto QRIS
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId];
  if (!state || state.step !== 'upload_qris') return;

  const fileId = ctx.message.photo.pop().file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const filePath = runtimePath('qris.jpg');

  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));

  await ctx.reply('✅ Gambar QRIS berhasil diunggah!');
  logger.info('🖼️ QRIS image uploaded by admin');
  delete userState[adminId];
});

bot.on('document', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId] || userState[ctx.chat.id];
  if (!state) return;

  if (state.step === 'hc_unlock_upload_document') {
    const doc = ctx.message.document;
    const fileSize = Number(doc.file_size || 0);
    if (fileSize > 2 * 1024 * 1024) {
      return ctx.reply('File terlalu besar. Maksimal file HC 2 MB.');
    }

    let outputPath = '';
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const templateText = Buffer.from(response.data).toString('utf8');
      const method = normalizeHcMethod(state.method);
      const beforeInfo = inspectHcTemplateText(templateText);
      const unlockedBuffer = await unlockHcConfigViaApi(templateText, {
        method,
        filename: String(doc.file_name || 'locked.hc')
      }, getGeneratorApiConfig());
      const afterInfo = inspectHcTemplateText(unlockedBuffer.toString('utf8'));

      const outputDir = runtimePath('generated', 'hc');
      await fsPromises.mkdir(outputDir, { recursive: true });
      const originalBase = String(doc.file_name || 'config.hc').replace(/\.[^.]+$/, '');
      const filename = `${sanitizeHcFilePart(originalBase, 'config')}_unlocked.hc`;
      outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
      await fsPromises.writeFile(outputPath, unlockedBuffer);

      delete userState[adminId];
      const previewLines = [
        '<b>Config HC berhasil di-unlock</b>',
        `Metode: ${escapeHtml(getHcMethodLabel(method))}`,
        `File: <code>${escapeHtml(filename)}</code>`,
        `Lock all: <code>${escapeHtml(String(beforeInfo.lockAll || '-'))}</code> -> <code>${escapeHtml(String(afterInfo.lockAll || '-'))}</code>`,
        `Lock payload: <code>${escapeHtml(String(beforeInfo.lockPayload || '-'))}</code> -> <code>${escapeHtml(String(afterInfo.lockPayload || '-'))}</code>`,
        `Expired: <code>${escapeHtml(String(beforeInfo.expiryTime || '-'))}</code> -> <code>${escapeHtml(String(afterInfo.expiryTime || '-'))}</code>`,
        afterInfo.sni ? `SNI: <code>${escapeHtml(afterInfo.sni)}</code>` : '',
        afterInfo.sshField && method === 'ssh' ? `SSH: <code>${escapeHtml(afterInfo.sshField)}</code>` : '',
        afterInfo.xrayConfig && method === 'xray' ? `Xray: <code>${escapeHtml(String(afterInfo.xrayConfig.length))} karakter</code>` : ''
      ].filter(Boolean);

      await ctx.replyWithDocument(
        { source: outputPath, filename },
        {
          caption: previewLines.join('\n'),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Unlock Lagi', callback_data: 'hc_unlock_menu' }]]
          }
        }
      );
      return;
    } catch (err) {
      logger.error('Gagal unlock config HC:', err.message);
      return ctx.reply(formatGeneratorApiError(
        err,
        'Gagal unlock config HC. Pastikan API generator aktif, API key valid, dan file yang dikirim adalah .hc valid dari HTTP Custom.'
      ));
    } finally {
      if (outputPath) {
        fsPromises.unlink(outputPath).catch(() => {});
      }
    }
  }

  if (state.step === 'dark_unlock_upload_document') {
    const doc = ctx.message.document;
    const fileSize = Number(doc.file_size || 0);
    if (fileSize > 2 * 1024 * 1024) {
      return ctx.reply('File terlalu besar. Maksimal file Dark Tunnel 2 MB.');
    }

    let outputPath = '';
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const templateText = Buffer.from(response.data).toString('utf8').trim();
      const method = normalizeDarkMethod(state.method);
      const beforeInfo = inspectDarkTemplateText(templateText);
      const unlocked = await unlockDarkTunnelViaApi(templateText, {
        filename: String(doc.file_name || 'locked.dark')
      }, getGeneratorApiConfig());
      const afterInfo = inspectDarkTemplateText(unlocked.text);

      const outputDir = runtimePath('generated', 'dark');
      await fsPromises.mkdir(outputDir, { recursive: true });
      const originalBase = String(doc.file_name || 'config.dark').replace(/\.[^.]+$/, '');
      const filename = `${sanitizeHcFilePart(originalBase, 'config')}_unlocked.dark`;
      outputPath = path.join(outputDir, `${Date.now()}_${filename}`);
      await fsPromises.writeFile(outputPath, unlocked.text, 'utf8');

      delete userState[adminId];
      delete userState[ctx.chat.id];
      const previewLines = [
        unlocked.fullyUnlocked ? '<b>Config Dark Tunnel berhasil di-unlock</b>' : '<b>Config Dark Tunnel diproses</b>',
        `Metode: ${escapeHtml(getDarkMethodLabel(method))}`,
        `Type file: <code>${escapeHtml(beforeInfo.type)}</code>`,
        `File: <code>${escapeHtml(filename)}</code>`,
        `Status: <code>${escapeHtml(beforeInfo.lockLabel)}</code> -> <code>${escapeHtml(afterInfo.lockLabel)}</code>`,
        unlocked.warning ? `⚠️ ${escapeHtml(unlocked.warning)}` : ''
      ].filter(Boolean);

      await ctx.replyWithDocument(
        { source: outputPath, filename },
        {
          caption: previewLines.join('\n'),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Unlock Lagi', callback_data: 'dark_unlock_menu' }]]
          }
        }
      );
      return;
    } catch (err) {
      logger.error('Gagal unlock config Dark Tunnel:', err.message);
      return ctx.reply(formatGeneratorApiError(
        err,
        'Gagal unlock config Dark Tunnel. Pastikan API generator aktif, API key valid, dan file yang dikirim adalah .dark valid dari Dark Tunnel.'
      ));
    } finally {
      if (outputPath) {
        fsPromises.unlink(outputPath).catch(() => {});
      }
    }
  }

  if (state.step === 'admin_hc_template_upload_document') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk upload template HC.');
    }

    const doc = ctx.message.document;
    scheduleHcTemplateUploadBatch(ctx, doc);
    return;
  }

  if (state.step === 'admin_hc_template_replace_document') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk mengganti template HC.');
    }

    const templateId = Number(state.templateId || 0);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      delete userState[adminId];
      delete userState[ctx.chat.id];
      return ctx.reply('Sesi ganti template tidak valid. Ulangi dari menu admin.');
    }

    const doc = ctx.message.document;
    try {
      const parsed = await readHcTemplateDocument(ctx, doc);
      const result = await dbRunAsync(
        `UPDATE hc_config_templates
         SET source_file_name = ?, template_text = ?, uploaded_by = ?
         WHERE id = ?`,
        [
          String(doc.file_name || 'template-hc.txt'),
          parsed.storedTemplateText,
          adminId,
          templateId
        ]
      );

      delete userState[adminId];
      delete userState[ctx.chat.id];
      await ctx.reply(
        result.changes > 0
          ? `Template HC berhasil diganti.\nFormat: ${parsed.formatLabel}`
          : 'Template HC tidak ditemukan.'
      );
      return sendAdminHcTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal mengganti template HC:', err.message);
      return ctx.reply(
        'Template tidak valid. Kirim file .hc asli dari HTTP Custom.'
      );
    }
  }

  if (state.step === 'admin_dark_template_upload_document') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk upload template Dark Tunnel.');
    }

    const doc = ctx.message.document;
    scheduleDarkTemplateUploadBatch(ctx, doc);
    return;
  }

  if (state.step === 'admin_dark_template_replace_document') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk mengganti template Dark Tunnel.');
    }

    const templateId = Number(state.templateId || 0);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      delete userState[adminId];
      delete userState[ctx.chat.id];
      return ctx.reply('Sesi ganti template tidak valid. Ulangi dari menu admin.');
    }

    const doc = ctx.message.document;
    try {
      const parsed = await readDarkTemplateDocument(ctx, doc);
      const result = await dbRunAsync(
        `UPDATE dark_config_templates
         SET source_file_name = ?, template_text = ?, uploaded_by = ?
         WHERE id = ?`,
        [
          String(doc.file_name || 'template-dark.dark'),
          parsed.storedTemplateText,
          adminId,
          templateId
        ]
      );

      delete userState[adminId];
      delete userState[ctx.chat.id];
      await ctx.reply(
        result.changes > 0
          ? `Template Dark Tunnel berhasil diganti.\nFormat: ${parsed.formatLabel}`
          : 'Template Dark Tunnel tidak ditemukan.'
      );
      return sendAdminDarkTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal mengganti template Dark Tunnel:', err.message);
      return ctx.reply('Template tidak valid. Kirim file .dark asli dari Dark Tunnel.');
    }
  }

  if (state.step === 'admin_config_upload_document') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk upload config.');
    }

    const doc = ctx.message.document;
    userState[adminId] = {
      step: 'admin_config_name_input',
      doc: {
        file_id: doc.file_id,
        file_unique_id: doc.file_unique_id || '',
        file_name: String(doc.file_name || 'config'),
        mime_type: String(doc.mime_type || ''),
        file_size: Number(doc.file_size || 0)
      }
    };

    return ctx.reply(
      'File config diterima.\n' +
      'Sekarang kirim nama config yang akan tampil di menu user.\n\n' +
      'Contoh: Config ZIVPN SG 1\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  }

  if (state.step === 'restore_foreign_db_upload') {
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk import database.');
    }

    const doc = ctx.message.document;
    const fileSize = Number(doc.file_size || 0);
    if (fileSize <= 0 || fileSize > 50 * 1024 * 1024) {
      return ctx.reply('Ukuran file database harus lebih dari 0 dan maksimal 50 MB.');
    }

    const originalName = String(doc.file_name || 'foreign-backup.db');
    const uploadDir = runtimePath('backup', 'restore_uploads');
    await fsPromises.mkdir(uploadDir, { recursive: true });
    const tempPath = path.join(
      uploadDir,
      `${Date.now()}_foreign_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    );

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024
      });
      await fsPromises.writeFile(tempPath, Buffer.from(response.data));
      const inspection = await inspectForeignBotDatabase(tempPath);

      const nextState = {
        step: 'restore_foreign_db_preview',
        foreignDbTempPath: tempPath,
        foreignDbOriginalName: originalName,
        foreignDbFingerprint: inspection.fingerprint
      };
      userState[ctx.chat.id] = nextState;
      userState[ctx.from.id] = nextState;
      return ctx.reply(formatForeignDbPreview(inspection, originalName), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Import Aman', callback_data: 'foreign_db_import_keep' }],
            [{ text: 'Timpa Saldo dari Backup', callback_data: 'foreign_db_import_overwrite_warning' }],
            [{ text: 'Batal', callback_data: 'foreign_db_import_cancel' }]
          ]
        }
      });
    } catch (err) {
      await fsPromises.unlink(tempPath).catch(() => {});
      logger.error('Validasi DB bot lain gagal: ' + err.message);
      return ctx.reply(`Database tidak dapat diimport: ${err.message}`);
    }
  }

  if (state.step !== 'restore_db_upload') return;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk restore database.');
  }

  const target = state.target === 'sellvpn' ? 'sellvpn' : 'ressel';
  const doc = ctx.message.document;
  const originalName = String(doc.file_name || (target + '.db'));

  try {
    const uploadDir = runtimePath('backup', 'restore_uploads');
    fs.mkdirSync(uploadDir, { recursive: true });

    const tempName = Date.now() + '_' + originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(uploadDir, tempName);
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(tempPath, Buffer.from(response.data));

    const livePath = target === 'sellvpn'
      ? runtimePath('sellvpn.db')
      : runtimePath('ressel.db');

    const backupDir = runtimePath('backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, target + '.before_restore.' + Date.now() + '.db');

    if (fs.existsSync(livePath)) {
      fs.copyFileSync(livePath, backupPath);
    }

    if (target === 'sellvpn') {
      await new Promise((resolve) => {
        db.close(() => resolve());
      });
    }

    fs.copyFileSync(tempPath, livePath);
    fs.unlinkSync(tempPath);

    delete userState[adminId];

    if (target === 'sellvpn') {
      await ctx.reply('Restore sellvpn.db berhasil. Bot akan restart otomatis untuk memuat database baru.');
      setTimeout(() => process.exit(0), 1200);
      return;
    }

    return ctx.reply('Restore ressel.db berhasil.');
  } catch (err) {
    logger.error('Gagal restore database:', err.message);
    return ctx.reply('Gagal restore database. Pastikan file backup valid.');
  }
});

async function sendTopupWalletMenu(ctx) {
  if (!loadTopupAutoSetting()) {
    await ctx.reply(
      '❌ *TOP-UP OTOMATIS SEDANG NONAKTIF*\n\n' +
      'Silakan gunakan menu *TopUp Manual* untuk sementara.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  reloadRuntimePaymentConfig();
  const readiness = getPaymentGatewayReadiness();
  if (!hasReadyEnabledPaymentGateway(readiness)) {
    await ctx.reply(
      '❌ *TOP-UP OTOMATIS SEMENTARA TIDAK TERSEDIA*\n\n' +
      'Admin belum mengkonfigurasi sistem pembayaran.\n' +
      'Sistem tidak dapat memverifikasi pembayaran Anda.\n\n' +
      `📞 Hubungi admin: ${ADMIN_USERNAME}\n\n` +
      '🔧 *Admin bisa cek konfigurasi dengan:*\n' +
      '`/checkpaymentconfig`\n\n' +
      '_Admin sudah mendapatkan notifikasi untuk segera memperbaiki sistem._',
      { parse_mode: 'Markdown' }
    );
    logger.warn(`User ${ctx.from.id} mencoba topup tapi tidak ada payment gateway aktif yang siap: ${formatMissingGatewayConfig(readiness)}`);
    return;
  }

  const text =
    '💰 *PILIH TUJUAN TOP-UP*\n\n' +
    'Saldo VPN dipakai untuk beli akun VPN, renew, dan transaksi layanan VPN.\n' +
    'Saldo PPOB dipakai khusus untuk pembelian produk PPOB.\n\n' +
    'Pilih saldo yang ingin diisi:';
  const payload = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Saldo VPN', callback_data: 'topup_wallet_vpn' }],
        [{ text: '🛒 Saldo PPOB', callback_data: 'topup_wallet_ppob' }],
        [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
      ]
    }
  };

  return ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
}

async function startAutoTopupAmountFlow(ctx, walletType = 'vpn') {
  if (!loadTopupAutoSetting()) {
    await ctx.reply(
      '❌ *TOP-UP OTOMATIS SEDANG NONAKTIF*\n\n' +
      'Silakan gunakan menu *TopUp Manual* untuk sementara.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  reloadRuntimePaymentConfig();
  const readiness = getPaymentGatewayReadiness();
  if (!hasReadyEnabledPaymentGateway(readiness)) {
    await ctx.reply(
      '❌ *TOP-UP OTOMATIS SEMENTARA TIDAK TERSEDIA*\n\n' +
      'Admin belum mengkonfigurasi sistem pembayaran.\n' +
      'Sistem tidak dapat memverifikasi pembayaran Anda.\n\n' +
      `📞 Hubungi admin: ${ADMIN_USERNAME}\n\n` +
      '🔧 *Admin bisa cek konfigurasi dengan:*\n' +
      '`/checkpaymentconfig`',
      { parse_mode: 'Markdown' }
    );
    logger.warn(`User ${ctx.from.id} mencoba topup tapi tidak ada payment gateway aktif yang siap: ${formatMissingGatewayConfig(readiness)}`);
    return;
  }

  const userId = ctx.from.id;
  const normalizedWallet = normalizeWalletType(walletType);
  const walletLabel = getWalletLabel(normalizedWallet);

  if (!global.depositState) {
    global.depositState = {};
  }
  const minTopupForMode = getMinTopupByGatewayMode(PAYMENT_GATEWAY_MODE);
  global.depositState[userId] = {
    action: 'request_amount',
    amount: '',
    topupPurpose: 'regular',
    walletType: normalizedWallet,
    minAmount: minTopupForMode
  };

  const keyboard = keyboard_nomor();

  const bonusCfg = loadTopupBonusSetting();
  const bonusInfo = normalizedWallet === 'vpn' && bonusCfg.enabled
    ? (
      `🎁 *BONUS TOPUP OTOMATIS:*\n` +
      `• 10-49rb: ${bonusCfg.range_10_40}%\n` +
      `• 50-79rb: ${bonusCfg.range_50_70}%\n` +
      `• 80rb+: ${bonusCfg.range_70_100}%\n\n`
    )
    : '';
  const feeDisplay = getTopupFeeDisplay(PAYMENT_GATEWAY_MODE);

  const text =
    `💰 *TOP UP ${walletLabel.toUpperCase()} OTOMATIS*\n\n` +
    `🎯 *Tujuan:* ${walletLabel}\n` +
    `💳 *Minimal:* Rp ${minTopupForMode.toLocaleString('id-ID')}\n\n` +
    bonusInfo +
    feeDisplay.menuNotice +
    '⚠️ *PERHATIAN:*\n' +
    feeDisplay.transferNotice +
    'Silakan masukkan jumlah top-up:';
  const payload = {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: 'Markdown'
  };

  await ctx.editMessageText(text, payload).catch(() => ctx.reply(text, payload));
  logger.info(`User ${userId} memulai topup ${normalizedWallet} (credential valid)`);
}

// ✅ BUAT INI SATU SAJA (tempat yang sama dengan action lainnya)
bot.action('topup_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await sendTopupWalletMenu(ctx);
  } catch (error) {
    logger.error('❌ Error in topup_saldo handler:', error);
    await ctx.reply(
      '❌ Terjadi kesalahan sistem.\nSilakan coba lagi atau hubungi admin.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.action(/^topup_wallet_(vpn|ppob)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await startAutoTopupAmountFlow(ctx, ctx.match[1]);
  } catch (error) {
    logger.error('❌ Error in topup wallet handler:', error);
    await ctx.reply(
      '❌ Terjadi kesalahan sistem.\nSilakan coba lagi atau hubungi admin.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.action('download_config_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    return await sendDownloadConfigMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu download config:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu download config.');
  }
});

bot.action(/download_config_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const configId = Number(ctx.match[1]);
  if (!Number.isInteger(configId) || configId <= 0) {
    return ctx.reply('Config tidak valid.');
  }

  try {
    const row = await dbGetAsync(
      `SELECT id, name, file_id, file_name, file_size
       FROM download_configs
       WHERE id = ?`,
      [configId]
    );

    if (!row) {
      return ctx.reply('Config tidak ditemukan atau sudah dihapus.', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Kembali', callback_data: 'download_config_menu' }]]
        }
      });
    }

    const caption =
      `<b>${escapeHtml(row.name || row.file_name || 'Config')}</b>\n` +
      `File: <code>${escapeHtml(row.file_name || '-')}</code>`;

    return await ctx.telegram.sendDocument(ctx.chat.id, row.file_id, {
      caption,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: 'Kembali ke List Config', callback_data: 'download_config_menu' }]]
      }
    });
  } catch (err) {
    logger.error('Gagal mengirim download config:', err.message);
    return ctx.reply('Gagal mengirim config. Silakan coba lagi nanti.');
  }
});

bot.action('config_unlock_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    delete userState[ctx.chat.id];
    return await sendConfigUnlockMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu buat config dan unlock:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu Buat Config dan Unlock.');
  }
});

bot.action('hc_template_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    delete userState[ctx.chat.id];
    return await sendHcCreateMethodMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu template HC:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu template HC.');
  }
});

bot.action(/hc_template_method_(ssh|xray)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    return await sendHcTemplateUserMenu(ctx, ctx.match[1]);
  } catch (err) {
    logger.error('Gagal membuka list template HC:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka list template HC.');
  }
});

bot.action(/hc_template_page_(ssh|xray)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    return await sendHcTemplateUserMenu(ctx, ctx.match[1], Number(ctx.match[2]));
  } catch (err) {
    logger.error('Gagal membuka halaman template HC:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka halaman template HC.');
  }
});

bot.action('hc_unlock_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    delete userState[ctx.chat.id];
    const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
    if (!isReseller) {
      return ctx.reply(getHcUnlockResellerRequiredMessage());
    }
    return await sendHcUnlockMethodMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu unlock HC:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu unlock HC.');
  }
});

bot.action(/hc_unlock_method_(ssh|xray)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
  if (!isReseller) {
    delete userState[ctx.chat.id];
    return ctx.reply(getHcUnlockResellerRequiredMessage());
  }

  const method = normalizeHcMethod(ctx.match[1]);
  userState[ctx.chat.id] = {
    step: 'hc_unlock_upload_document',
    method
  };
  return ctx.reply(
    `Metode: *${getHcMethodLabel(method)}*\n\n` +
    'Kirim file `.hc` yang mau di-unlock sebagai document.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/hc_template_select_(?:(ssh|xray)_)?(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const method = normalizeHcMethod(ctx.match[1] || 'ssh');
  const templateId = Number(ctx.match[2]);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return ctx.reply('Template HC tidak valid.');
  }

  try {
    const row = await dbGetAsync(
      `SELECT id, name, slug
       FROM hc_config_templates
       WHERE id = ? AND enabled = 1`,
      [templateId]
    );

    if (!row) {
      return ctx.reply('Template HC tidak ditemukan atau sedang nonaktif.', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Kembali', callback_data: 'hc_template_menu' }]]
        }
      });
    }

    userState[ctx.chat.id] = {
      step: 'hc_template_account_input',
      method,
      templateId: row.id,
      templateName: row.name,
      templateSlug: row.slug
    };

    if (method === 'xray') {
      return ctx.reply(
        `Template: *${row.name}*\n` +
        `Metode: *Xray / V2Ray*\n\n` +
        'Kirim config Xray dengan salah satu format:\n' +
        '• JSON V2Ray mentah\n' +
        '• Link `vmess://...`, `vless://...`, atau `trojan://...`\n\n' +
        '• Ringkas VMess: `host.domain.com:UUID`\n' +
        '• Ringkas VLESS: `vless:host.domain.com:UUID`\n' +
        '• Ringkas Trojan: `trojan:host.domain.com:PASSWORD`\n\n' +
        'Domain Address otomatis memakai Remote Proxy/SNI jika template asalnya SSH.\n' +
        'Untuk menggantinya dengan bug custom, kirim bersama link seperti:\n' +
        '`Bug: bug.domain.com`\n\n' +
        'Ketik `batal` untuk membatalkan.',
        { parse_mode: 'Markdown' }
      );
    }

    return ctx.reply(
      `Template: *${row.name}*\n\n` +
      'Kirim akun SSH dengan format:\n' +
      '`host:port@username:password`\n\n' +
      'Atau kirim:\n' +
      '`Host: domain.com`\n' +
      '`Port: 443`\n' +
      '`Username: user`\n' +
      '`Password: pass`\n\n' +
      'Ketik `batal` untuk membatalkan.',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error('Gagal memilih template HC:', err.message);
    return ctx.reply('Gagal memilih template HC. Silakan coba lagi.');
  }
});

bot.action('hc_note_default', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getHcPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config HC tidak ditemukan. Ulangi dari menu Buat Config HC.');
  }
  return sendGeneratedHcTemplateConfig(ctx, state, state.account, loadHcDefaultNoteSetting());
});

bot.action('hc_note_skip', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getHcPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config HC tidak ditemukan. Ulangi dari menu Buat Config HC.');
  }
  return sendGeneratedHcTemplateConfig(ctx, state, state.account, { enabled: false, html: '' });
});

bot.action('hc_note_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getHcPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config HC tidak ditemukan. Ulangi dari menu Buat Config HC.');
  }

  userState[ctx.chat.id] = {
    ...state,
    step: 'hc_template_note_input'
  };

  return ctx.reply(
    'Kirim note config dalam bentuk HTML atau teks biasa.\n\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('dark_note_default', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getDarkPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config Dark Tunnel tidak ditemukan. Ulangi dari menu Buat Config Dark.');
  }
  return sendGeneratedDarkTemplateConfig(ctx, state, state.account, loadDarkDefaultNoteSetting());
});

bot.action('dark_note_skip', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getDarkPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config Dark Tunnel tidak ditemukan. Ulangi dari menu Buat Config Dark.');
  }
  return sendGeneratedDarkTemplateConfig(ctx, state, state.account, { enabled: false, html: '' });
});

bot.action('dark_note_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = getDarkPendingNoteState(ctx);
  if (!state) {
    return ctx.reply('Sesi pembuatan config Dark Tunnel tidak ditemukan. Ulangi dari menu Buat Config Dark.');
  }

  userState[ctx.chat.id] = {
    ...state,
    step: 'dark_template_note_input'
  };

  return ctx.reply(
    'Kirim message config Dark Tunnel dalam bentuk HTML atau teks biasa.\n\n' +
    'HTML akan diubah menjadi teks biasa. Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('dark_template_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    delete userState[ctx.chat.id];
    return await sendDarkCreateMethodMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu template Dark Tunnel:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu template Dark Tunnel.');
  }
});

bot.action(/dark_template_method_(ssh|vmess|vless|trojan)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    return await sendDarkTemplateUserMenu(ctx, ctx.match[1]);
  } catch (err) {
    logger.error('Gagal membuka list template Dark Tunnel:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka list template Dark Tunnel.');
  }
});

bot.action(/dark_template_page_(ssh|vmess|vless|trojan)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    return await sendDarkTemplateUserMenu(ctx, ctx.match[1], Number(ctx.match[2]));
  } catch (err) {
    logger.error('Gagal membuka halaman template Dark Tunnel:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka halaman template Dark Tunnel.');
  }
});

bot.action('dark_unlock_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    delete userState[ctx.chat.id];
    const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
    if (!isReseller) {
      return ctx.reply(getDarkUnlockResellerRequiredMessage());
    }
    return await sendDarkUnlockMethodMenu(ctx);
  } catch (err) {
    logger.error('Gagal membuka menu unlock Dark Tunnel:', err.message);
    return ctx.reply('Terjadi kesalahan saat membuka menu unlock Dark Tunnel.');
  }
});

bot.action(/dark_unlock_method_(ssh|vmess|vless|trojan)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
  if (!isReseller) {
    delete userState[ctx.chat.id];
    return ctx.reply(getDarkUnlockResellerRequiredMessage());
  }

  const method = normalizeDarkMethod(ctx.match[1]);
  userState[ctx.chat.id] = {
    step: 'dark_unlock_upload_document',
    method
  };
  return ctx.reply(
    `Metode: *${getDarkMethodLabel(method)}*\n\n` +
    'Kirim file `.dark` yang mau di-unlock sebagai document.\n' +
    'Atau paste link `darktunnel://...`, termasuk link yang masih lock.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/dark_template_select_(ssh|vmess|vless|trojan)(?:_(dark|hc))?_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const method = normalizeDarkMethod(ctx.match[1]);
  const templateSource = ctx.match[2] === 'hc' ? 'hc' : 'dark';
  const templateId = Number(ctx.match[3]);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    return ctx.reply('Template Dark Tunnel tidak valid.');
  }

  try {
    if (templateSource === 'hc') {
      return ctx.reply('Template HC sudah dipisahkan dari Dark Tunnel. Pilih template .dark khusus Dark Tunnel.');
    }

    const row = await getDarkTemplateRowBySource(templateSource, templateId);

    if (!row) {
      return ctx.reply('Template Dark Tunnel tidak ditemukan atau sedang nonaktif.', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Kembali', callback_data: 'dark_template_menu' }]]
        }
      });
    }

    const info = inspectDarkTemplateText(row.template_text);
    const expectedType = method === 'ssh' ? 'SSH' : method.toUpperCase();
    if (!isDarkTemplateCompatibleWithMethod(info.type, method)) {
      return ctx.reply(`Template ini bertipe ${info.type} dan tidak dapat dipakai untuk metode ${expectedType}.`);
    }

    userState[ctx.chat.id] = {
      step: 'dark_template_account_input',
      method,
      templateId: row.id,
      templateSource: row.templateSource,
      templateName: row.name,
      templateSlug: row.slug
    };

    if (method !== 'ssh') {
      const secretLabel = method === 'trojan' ? 'password' : 'uuid';
      const linkPrefix = method === 'trojan' ? 'trojan://' : (method === 'vless' ? 'vless://' : 'vmess://');
      return ctx.reply(
        `Template: *${row.name}*\n` +
        `Metode: *${getDarkMethodLabel(method)}*\n\n` +
        `Kirim akun ${getDarkMethodLabel(method)} dengan salah satu format:\n` +
        `• \`host:${secretLabel}\` — port/transport mengikuti template\n` +
        `• \`host:port@${secretLabel}\`\n` +
        `• link \`${linkPrefix}...\` saja\n` +
        `• baris \`Host\`, \`Port\`, \`${method === 'trojan' ? 'Password' : 'UUID'}\`, \`SNI\`, \`Path\`, \`Header Host\`\n\n` +
        'Jika template asalnya SSH, bug/Domain Address otomatis diambil dari Proxy/SNI template.\n' +
        'Override bug opsional: kirim `Bug: bug.domain.com` di baris berikutnya setelah link.\n\n' +
        'Ketik `batal` untuk membatalkan.',
        { parse_mode: 'Markdown' }
      );
    }

    return ctx.reply(
      `Template: *${row.name}*\n\n` +
      'Kirim akun SSH dengan format:\n' +
      '`host:port@username:password`\n\n' +
      'Atau kirim:\n' +
      '`Host: domain.com`\n' +
      '`Port: 443`\n' +
      '`Username: user`\n' +
      '`Password: pass`\n\n' +
      'Ketik `batal` untuk membatalkan.',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error('Gagal memilih template Dark Tunnel:', err.message);
    return ctx.reply('Gagal memilih template Dark Tunnel. Silakan coba lagi.');
  }
});

// === 📞 HUBUNGI ADMIN (WHATSAPP) ===
bot.action('hubungi_admin', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const userName = ctx.from.first_name || ctx.from.username || `User ${userId}`;

    const adminWhatsApp = getAdminWhatsappNumber();
    const adminWhatsappUrl = getAdminWhatsappUrl();
    if (!adminWhatsApp || !adminWhatsappUrl) {
      return ctx.reply(`⚠️ Kontak WhatsApp admin belum diset. Silakan hubungi ${getAdminTelegramUsername()} terlebih dahulu.`);
    }

    const autoMessage = encodeURIComponent(
      `Hallo min aku dari bot mau menyampaikan sesuatu\n\n` +
      `ID Telegram: ${userId}\n` +
      `Nama: ${userName}`
    );

    const whatsappUrl = `${adminWhatsappUrl}?text=${autoMessage}`;

    await ctx.reply(
      `📞 *HUBUNGI ADMIN*\n\n` +
      `Klik tombol di bawah untuk menghubungi admin via WhatsApp:\n\n` +
      `👤 Nama Anda: *${userName}*\n` +
      `🆔 ID Telegram: *${userId}*\n\n` +
      `ℹ️ *ID Telegram Anda sudah disertakan dalam pesan otomatis*\n\n` +
      `Pesan otomatis sudah disiapkan. Anda bisa mengeditnya sebelum mengirim.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📱 Buka WhatsApp (Pesan Otomatis)', url: whatsappUrl }],
            [{ text: '📝 Kirim Pesan Manual', url: adminWhatsappUrl }],
            [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );

    logger.info(`User ${userId} membuka menu hubungi admin`);
  } catch (error) {
    logger.error('❌ Error di tombol hubungi_admin:', error.message);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka WhatsApp. Silakan coba lagi.');
  }
});


bot.action('check_expiry_account', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;

  let isReseller = false;
  try {
    isReseller = await isUserReseller(userId);
  } catch (e) {
    logger.error('Error cek role reseller untuk cek masa aktif:', e.message);
  }

  db.all(
    `SELECT MIN(id) AS id,
            host AS server_name
     FROM (
       SELECT id,
              LOWER(TRIM(COALESCE(NULLIF(sync_host, ''), NULLIF(domain, ''), ''))) AS host
       FROM Server
       WHERE COALESCE(is_active, 1) = 1
         AND (COALESCE(is_reseller_only, 0) = 0 OR ? = 1)
     ) grouped
     WHERE host <> ''
     GROUP BY host
     ORDER BY host COLLATE NOCASE ASC`,
    [isReseller ? 1 : 0],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil daftar server cek masa aktif:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat daftar server.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Belum ada server tersedia untuk role akun kamu.');
      }

      const keyboard = rows.map((row) => ([{
        text: row.server_name,
        callback_data: `check_expiry_server_${row.id}`
      }]));

      keyboard.push([{ text: 'Kembali', callback_data: 'send_main_menu' }]);

      await ctx.reply(
        'Akun kamu ada di server mana? untuk melihatnya kamu bisa cek di informasi akun kamu\n\n'+
        'Pilih server untuk cek masa aktif akun:',
         {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});

bot.action(/check_expiry_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = Number(ctx.match[1]);

  db.get('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId], async (err, row) => {
    if (err) {
      logger.error('Error ambil server cek masa aktif:', err.message);
      return ctx.reply('Terjadi kesalahan saat mengambil data server.');
    }

    if (!row) {
      return ctx.reply('Server tidak ditemukan.');
    }

    userState[ctx.chat.id] = {
      step: 'check_expiry_username',
      serverId,
      serverName: row.nama_server || row.domain || ('ID ' + serverId)
    };

    await ctx.reply(
      'Masukkan username akun yang ingin dicek masa aktifnya.\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  });
});

db.run(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  username TEXT,
  password TEXT,
  server_id INTEGER,
  server_name TEXT,
  domain TEXT,
  link_tls TEXT,
  link_none TEXT,
  link_grpc TEXT,
  link_uptls TEXT,
  link_upntls TEXT,
  account_ip_package INTEGER DEFAULT 1,
  account_price_per_day INTEGER DEFAULT 0,
  created_at INTEGER,
  expires_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel accounts:', err.message);
  } else {
    logger.info('Accounts table created or already exists');
    migrateAccountServerByDomain()
      .then((res) => {
        if (res && res.updated > 0) {
          logger.info('Migrasi accounts server_id selesai: ' + res.updated + '/' + res.total + ' data diperbarui');
        }
      })
      .catch((e) => logger.error('Error migrasi accounts server_id:', e.message));
  }
});

db.all("PRAGMA table_info(accounts)", (err, rows) => {
  if (err) {
    logger.error('Error checking accounts schema:', err.message);
    return;
  }
  const cols = rows.map(r => r.name);
  if (!cols.includes('link_tls')) db.run("ALTER TABLE accounts ADD COLUMN link_tls TEXT");
  if (!cols.includes('link_none')) db.run("ALTER TABLE accounts ADD COLUMN link_none TEXT");
  if (!cols.includes('link_grpc')) db.run("ALTER TABLE accounts ADD COLUMN link_grpc TEXT");
  if (!cols.includes('link_uptls')) db.run("ALTER TABLE accounts ADD COLUMN link_uptls TEXT");
  if (!cols.includes('link_upntls')) db.run("ALTER TABLE accounts ADD COLUMN link_upntls TEXT");
  if (!cols.includes('account_ip_package')) db.run("ALTER TABLE accounts ADD COLUMN account_ip_package INTEGER DEFAULT 1");
  if (!cols.includes('account_price_per_day')) db.run("ALTER TABLE accounts ADD COLUMN account_price_per_day INTEGER DEFAULT 0");
});

bot.action('view_accounts', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();

  db.get(
    'SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)',
    [userId, now],
    async (err, row) => {
      if (err) {
        logger.error('❌ Error hitung akun aktif:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memuat akun.');
      }
      const total = row ? row.count : 0;
      const keyboard = [
        [{ text: '✅ Lihat Akun Aktif Saya', callback_data: 'view_accounts_active' }]
      ];
      if (total > 10) {
        keyboard.push([{ text: '📂 Lihat Semua Akun Saya', callback_data: 'view_accounts_active_all' }]);
      }
      keyboard.push([{ text: '⌛ Lihat Akun Expired', callback_data: 'view_accounts_expired' }]);
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]);

      await ctx.reply('📂 *Lihat Akun Saya*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});


const SELF_DELETE_TYPE_HANDLERS = {
  ssh: delssh,
  vmess: delvmess,
  vless: delvless,
  trojan: deltrojan,
  udp_http: deludphttp,
  zivpn: delzivpn
};

function calcRemainingDays(expiresAt) {
  if (!expiresAt) return 0;
  const diff = Number(expiresAt) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function getEffectiveServerPackagePrice(serverRow, isReseller, ipPackage) {
  const pkg = ipPackage === 2 ? '2ip' : '1ip';
  if (isReseller) {
    return pkg === '2ip'
      ? Number(serverRow?.harga_reseller_2ip || serverRow?.harga_reseller || 0)
      : Number(serverRow?.harga_reseller_1ip || serverRow?.harga_reseller || 0);
  }
  return pkg === '2ip'
    ? Number(serverRow?.harga_2ip || serverRow?.harga || 0)
    : Number(serverRow?.harga_1ip || serverRow?.harga || 0);
}

function isServerDailyPriceEnabled(serverRow) {
  return Number(serverRow?.harga_mode_harian_enabled ?? 1) !== 0;
}

function isServerMonthlyPriceEnabled(serverRow) {
  return Number(serverRow?.harga_mode_30hari_enabled ?? 0) === 1;
}

function getEffectiveServerMonthlyPackagePrice(serverRow, isReseller, ipPackage) {
  const pkg = ipPackage === 2 ? '2ip' : '1ip';
  const dailyFallback = getEffectiveServerPackagePrice(serverRow, isReseller, ipPackage) * 30;
  let rawPrice;

  if (isReseller) {
    rawPrice = pkg === '2ip'
      ? Number(serverRow?.harga_reseller_2ip_30hari || 0)
      : Number(serverRow?.harga_reseller_1ip_30hari || 0);
  } else {
    rawPrice = pkg === '2ip'
      ? Number(serverRow?.harga_2ip_30hari || 0)
      : Number(serverRow?.harga_1ip_30hari || 0);
  }

  return Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : dailyFallback;
}

function normalizeCreatePriceMode(rawMode) {
  return String(rawMode || '').toLowerCase() === '30hari' ? '30hari' : 'daily';
}

function formatCreatePriceMode(mode) {
  return normalizeCreatePriceMode(mode) === '30hari' ? '30 Hari' : 'Harian';
}

function getCreateBillingPrice(serverRow, isReseller, ipPackage, mode, expDays) {
  const normalizedMode = normalizeCreatePriceMode(mode);
  const days = Math.max(1, Number(expDays || 0));
  if (normalizedMode === '30hari') {
    return getEffectiveServerMonthlyPackagePrice(serverRow, isReseller, ipPackage);
  }
  return getEffectiveServerPackagePrice(serverRow, isReseller, ipPackage) * days;
}

function getStoredAccountPricePerDay(totalPrice, expDays, fallbackDailyPrice) {
  const total = Number(totalPrice || 0);
  const days = Number(expDays || 0);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(days) && days > 0) {
    return Math.max(0, Math.floor(total / days));
  }
  return Math.max(0, Number(fallbackDailyPrice || 0));
}

function getEffectiveServerPrice(serverRow, isReseller) {
  return getEffectiveServerPackagePrice(serverRow, isReseller, 1);
}

const SERVER_IPLIMIT_PROTOCOLS = [
  { key: 'ssh', label: 'SSH / OVPN' },
  { key: 'zivpn', label: 'ZIVPN' },
  { key: 'vmess', label: 'VMESS' },
  { key: 'vless', label: 'VLESS' },
  { key: 'trojan', label: 'TROJAN' },
  { key: 'shadowsocks', label: 'SHADOWSOCKS' },
  { key: 'udp_http', label: 'UDP HTTP' }
];

function normalizeIpLimitProtocol(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'ssh';
  if (value === 'udp' || value === 'udp_http' || value === 'udp-http' || value === 'udphc' || value === 'udp_http_custom') {
    return 'udp_http';
  }
  if (value === 'ovpn' || value === 'openvpn') {
    return 'ssh';
  }
  if (SERVER_IPLIMIT_PROTOCOLS.some((item) => item.key === value)) {
    return value;
  }
  return value;
}

function getDefaultServerIpLimit(protocol, ipPackage) {
  const pkg = Number(ipPackage || 1) === 2 ? 2 : 1;
  return normalizeIpLimitProtocol(protocol) === 'udp_http'
    ? (pkg === 2 ? 4 : 3)
    : (pkg === 2 ? 3 : 2);
}

async function getServerIpLimitRuleMap(serverId, protocol) {
  const normalizedProtocol = normalizeIpLimitProtocol(protocol);
  const rows = await dbAllAsync(
    'SELECT ip_package, iplimit FROM server_iplimit_rules WHERE server_id = ? AND protocol = ?',
    [serverId, normalizedProtocol]
  ).catch(() => []);

  const result = { 1: getDefaultServerIpLimit(normalizedProtocol, 1), 2: getDefaultServerIpLimit(normalizedProtocol, 2) };
  rows.forEach((row) => {
    const pkg = Number(row?.ip_package || 0) === 2 ? 2 : 1;
    const limit = Number(row?.iplimit);
    if (Number.isFinite(limit) && limit >= 0) {
      result[pkg] = limit;
    }
  });
  return result;
}

async function getServerIpLimitRule(serverId, protocol, ipPackage) {
  const normalizedProtocol = normalizeIpLimitProtocol(protocol);
  const pkg = Number(ipPackage || 1) === 2 ? 2 : 1;
  const row = await dbGetAsync(
    'SELECT iplimit FROM server_iplimit_rules WHERE server_id = ? AND protocol = ? AND ip_package = ?',
    [serverId, normalizedProtocol, pkg]
  ).catch(() => null);

  if (row) {
    const limit = Number(row.iplimit);
    if (Number.isFinite(limit) && limit >= 0) {
      return limit;
    }
  }
  return getDefaultServerIpLimit(normalizedProtocol, pkg);
}

async function saveServerIpLimitRule(serverId, protocol, ipPackage, iplimit) {
  const normalizedProtocol = normalizeIpLimitProtocol(protocol);
  const pkg = Number(ipPackage || 1) === 2 ? 2 : 1;
  const limit = Number(iplimit);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error('Limit IP harus angka 0 atau lebih.');
  }

  const now = Date.now();
  await dbRunAsync(
    `INSERT INTO server_iplimit_rules (server_id, protocol, ip_package, iplimit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, protocol, ip_package)
     DO UPDATE SET iplimit = excluded.iplimit, updated_at = excluded.updated_at`,
    [serverId, normalizedProtocol, pkg, limit, now, now]
  );
}

function normalizeCreateAccountMessageForDisplay(message, selectedPackage) {
  const pkg = Number(selectedPackage || 1) === 2 ? 2 : 1;
  const text = String(message || '');
  if (!text.trim()) return text;

  // Paksa info IP yang tampil ke user tetap 1IP/2IP (bukan limit internal server).
  // Line-based agar format markdown seperti "*IP Limit* : 3 device" tetap ter-handle.
  const lines = text.split('\n');
  const normalized = lines.map((line) => {
    if (!/ip\s*limit|limit\s*ip|max(?:imum)?\s*(?:login|ip)|login\s*maks/i.test(line)) {
      return line;
    }

    const replaced = line.replace(/([:=]\s*`?)(\d+)(\s*(?:`)?(?:\s*(?:ip|device|devices|pengguna))?)/i, `$1${pkg}$3`);
    if (replaced !== line) return replaced;

    return line.replace(/(\D)(\d+)(\D*)$/, `$1${pkg}$3`);
  });

  return normalized.join('\n');
}

function resolveAccountIpPackage(accountRow) {
  const storedPkg = Number(accountRow?.account_ip_package ?? accountRow?.accountIpPackage ?? 0);
  if (storedPkg === 2) return 2;
  if (storedPkg === 1) return 1;

  const type = accountRow?.type || accountRow?.service || '';
  const iplimitCandidate =
    accountRow?.accountIpLimit ??
    accountRow?.limitip ??
    accountRow?.iplimit ??
    accountRow?.server_iplimit ??
    0;
  return inferIpPackageByAccount(type, iplimitCandidate);
}

function resolveAccountPricePerDay(serverRow, isReseller, accountRow, preferStored = true) {
  const storedPrice = Number(accountRow?.account_price_per_day ?? accountRow?.accountPricePerDay ?? 0);
  if (preferStored && Number.isFinite(storedPrice) && storedPrice > 0) {
    return storedPrice;
  }
  const pkg = resolveAccountIpPackage(accountRow);
  return getEffectiveServerPackagePrice(serverRow, isReseller, pkg);
}

function isStrongCreateUsername(username) {
  const letterCount = (username.match(/[a-z]/g) || []).length;
  const digitCount = (username.match(/[0-9]/g) || []).length;
  return letterCount >= 4 && digitCount >= 4;
}

bot.action('delete_my_account_intro', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '⚠️ *Hapus Akun Saya*\n\n' +
    'Penghapusan hanya bisa jika sisa masa aktif minimal 2 hari.\n' +
    'Akun baru bisa dihapus setelah aktif minimal 24 jam.\n' +
    'Konversi saldo dihitung full sesuai sisa hari.\n\n' +
    'Lanjut pilih server akun yang ingin dihapus.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗂️ Pilih Server', callback_data: 'delete_my_account_select_server' }],
          [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
        ]
      }
    }
  );
});

bot.action('delete_my_account_select_server', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();

  let isReseller = false;
  try {
    isReseller = await isUserReseller(userId);
  } catch (e) {
    logger.error('Error cek role reseller:', e.message);
  }

  db.all(
    `SELECT s.id AS server_id,
            COALESCE(NULLIF(s.nama_server, ''), s.domain, 'Server') AS server_name,
            (
              SELECT COUNT(*)
              FROM accounts a
              WHERE a.user_id = ?
                AND (a.expires_at IS NULL OR a.expires_at > ?)
                AND (
                  a.server_id = s.id
                  OR (
                    TRIM(COALESCE(s.domain, '')) <> ''
                    AND LOWER(TRIM(COALESCE(a.domain, ''))) = LOWER(TRIM(COALESCE(s.domain, '')))
                    AND (
                      (UPPER(COALESCE(s.nama_server, '')) LIKE '%1IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%1IP%')
                      OR (UPPER(COALESCE(s.nama_server, '')) LIKE '%2IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%2IP%')
                      OR (
                        UPPER(COALESCE(s.nama_server, '')) NOT LIKE '%1IP%'
                        AND UPPER(COALESCE(s.nama_server, '')) NOT LIKE '%2IP%'
                        AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%1IP%'
                        AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%2IP%'
                      )
                    )
                  )
                )
            ) AS total_accounts
     FROM Server s
     WHERE COALESCE(s.is_active, 1) = 1
       AND (COALESCE(s.is_reseller_only, 0) = 0 OR ? = 1)
     ORDER BY server_name COLLATE NOCASE ASC`,
    [userId, now, isReseller ? 1 : 0],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil server akun user:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat daftar server akun.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Tidak ada akun aktif di server ini.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Pilih Server Lain', callback_data: 'delete_my_account_select_server' }],
              [{ text: 'Kembali', callback_data: 'send_main_menu' }]
            ]
          }
        });
      }

      const keyboard = rows.map((row) => ([{
        text: `${row.server_name} (${row.total_accounts} akun)`,
        callback_data: `delete_my_account_server_${row.server_id}`
      }]));
      keyboard.push([{ text: 'Kembali', callback_data: 'delete_my_account_intro' }]);

      await ctx.reply('Pilih server akun yang ingin dihapus:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});

async function renderRemoteDeleteAccountPage(ctx, page = 0) {
  const state = userState[ctx.chat.id]?.remote_delete_accounts;
  if (!state || !Array.isArray(state.rows) || state.rows.length === 0) {
    return ctx.reply('Tidak ada akun remote untuk ditampilkan.');
  }

  const pageSize = Number(state.pageSize || 10);
  const total = state.rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const rows = state.rows.slice(start, end);

  const keyboard = rows.map((row, idx) => {
    const absIndex = start + idx;
    const remainingDays = row.expires_at ? calcRemainingDays(row.expires_at) : calcRemainingDaysFromDateExp(row.date_exp);
    return [{
      text: `${row.username} (${String(row.type || '-').toUpperCase()}, ${remainingDays} hari)`,
      callback_data: `delete_my_account_remote_pick_${absIndex}`
    }];
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: 'Sebelumnya', callback_data: `delete_my_account_remote_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Selanjutnya', callback_data: `delete_my_account_remote_page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Pilih Server', callback_data: 'delete_my_account_select_server' }]);

  return ctx.reply(
    `Pilih akun yang ingin dihapus (data server):\nServer: ${state.serverName}\nHalaman ${safePage + 1}/${totalPages}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

bot.action(/delete_my_account_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();
  const serverId = Number(ctx.match[1]);

  db.all(
    `SELECT a.id, a.type, a.username, a.server_name, a.domain, a.expires_at,
            COALESCE(s.harga, 0) AS harga
     FROM accounts a
     LEFT JOIN Server s ON s.id = a.server_id
     LEFT JOIN Server ss ON ss.id = ?
     WHERE a.user_id = ?
       AND (
         a.server_id = ?
         OR (
           TRIM(COALESCE(ss.domain, '')) <> ''
           AND LOWER(TRIM(COALESCE(a.domain, ''))) = LOWER(TRIM(COALESCE(ss.domain, '')))
           AND (
             (UPPER(COALESCE(ss.nama_server, '')) LIKE '%1IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%1IP%')
             OR (UPPER(COALESCE(ss.nama_server, '')) LIKE '%2IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%2IP%')
             OR (
               UPPER(COALESCE(ss.nama_server, '')) NOT LIKE '%1IP%'
               AND UPPER(COALESCE(ss.nama_server, '')) NOT LIKE '%2IP%'
               AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%1IP%'
               AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%2IP%'
             )
           )
         )
       )
       AND (a.expires_at IS NULL OR a.expires_at > ?)
     ORDER BY a.expires_at ASC, a.id ASC`,
    [serverId, userId, serverId, now],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil akun berdasarkan server:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat akun server.');
      }

      if (!rows || rows.length === 0) {
        const serverRow = await dbGetAsync('SELECT id, nama_server, domain, sync_host, auth FROM Server WHERE id = ?', [serverId]).catch(() => null);
        if (!serverRow) {
          return ctx.reply('Server tidak ditemukan.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Pilih Server Lain', callback_data: 'delete_my_account_select_server' }],
                [{ text: 'Kembali', callback_data: 'send_main_menu' }]
              ]
            }
          });
        }

        const remoteRowsRaw = await fetchOwnedAccountsByTelegramFromServer(serverRow, userId);
        const remoteRows = remoteRowsRaw.filter((r) => !r.expires_at || r.expires_at > now);
        if (remoteRows.length === 0) {
          return ctx.reply('Tidak ada akun aktif yang terhubung ke server ini.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Pilih Server Lain', callback_data: 'delete_my_account_select_server' }],
                [{ text: 'Kembali', callback_data: 'send_main_menu' }]
              ]
            }
          });
        }

        userState[ctx.chat.id] = userState[ctx.chat.id] || {};
        userState[ctx.chat.id].remote_delete_accounts = {
          serverId,
          serverName: serverRow.nama_server || serverRow.domain || ('ID ' + serverId),
          rows: remoteRows,
          pageSize: 10
        };
        return renderRemoteDeleteAccountPage(ctx, 0);
      }

      const keyboard = rows.map((row) => {
        const remainingDays = calcRemainingDays(row.expires_at);
        return [{
          text: `${row.username} (${String(row.type || '-').toUpperCase()}, ${remainingDays} hari)`,
          callback_data: `delete_my_account_pick_${row.id}`
        }];
      });
      keyboard.push([{ text: 'Pilih Server', callback_data: 'delete_my_account_select_server' }]);

      await ctx.reply('Pilih akun yang ingin dihapus:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});

bot.action(/delete_my_account_remote_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number(ctx.match[1] || 0);
  await renderRemoteDeleteAccountPage(ctx, Number.isFinite(page) ? page : 0);
});

bot.action(/delete_my_account_remote_pick_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const idx = Number(ctx.match[1] || -1);
  const state = userState[ctx.chat.id]?.remote_delete_accounts;
  if (!state || !Array.isArray(state.rows) || idx < 0 || idx >= state.rows.length) {
    return ctx.reply('Data akun tidak ditemukan, silakan pilih ulang.');
  }

  const row = state.rows[idx];
  const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
  const remainingDays = row.expires_at ? calcRemainingDays(row.expires_at) : calcRemainingDaysFromDateExp(row.date_exp);
  const serverData = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [row.server_id]).catch(() => null);
  const accountPkg = resolveAccountIpPackage({
    type: row.type,
    account_ip_package: row.account_ip_package,
    limitip: row.limitip || row.iplimit
  });
  const pricePerDay = resolveAccountPricePerDay(serverData || {}, isReseller, {
    account_ip_package: accountPkg,
    account_price_per_day: row.account_price_per_day
  }, true);
  const refund = Math.max(0, remainingDays * pricePerDay);

  await ctx.reply(
    'Konfirmasi Hapus Akun\n\n' +
    `- <b>Username:</b> ${escapeHtml(row.username || '-')}\n` +
    `- <b>Layanan:</b> ${escapeHtml(String(row.type || '-').toUpperCase())}\n` +
    `- <b>Server:</b> ${escapeHtml(row.server_name || row.domain || '-')}\n` +
    `- <b>Sisa hari:</b> ${remainingDays} hari\n` +
    `- <b>Konversi saldo:</b> Rp ${Number(refund).toLocaleString('id-ID')}\n\n` +
    (remainingDays < 2 ? 'Akun ini belum bisa dihapus. Minimal sisa masa aktif 2 hari.' : 'Akun akan dihapus permanen dari server.'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...((remainingDays >= 2) ? [[{ text: 'Ya, Hapus Akun Ini', callback_data: `delete_my_account_remote_confirm_${idx}` }]] : []),
          [{ text: 'Batal', callback_data: 'delete_my_account_select_server' }]
        ]
      }
    }
  );
});

bot.action(/delete_my_account_remote_confirm_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const idx = Number(ctx.match[1] || -1);
  const state = userState[ctx.chat.id]?.remote_delete_accounts;
  if (!state || !Array.isArray(state.rows) || idx < 0 || idx >= state.rows.length) {
    return ctx.reply('Data akun tidak ditemukan, silakan pilih ulang.');
  }

  const row = state.rows[idx];
  const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
  const remainingDays = row.expires_at ? calcRemainingDays(row.expires_at) : calcRemainingDaysFromDateExp(row.date_exp);
  if (remainingDays < 2) {
    return ctx.reply('Akun belum bisa dihapus. Minimal sisa masa aktif 2 hari.');
  }

  const deleteFn = SELF_DELETE_TYPE_HANDLERS[row.type] || SELF_DELETE_TYPE_HANDLERS.ssh;
  const result = await deleteFn(row.username, 'none', 'none', 'none', row.server_id);
  const resultText = typeof result === 'string' ? result : JSON.stringify(result || {});
  if (/gagal|error|failed|tidak\s+ditemukan|not\s+found/i.test(resultText)) {
    return ctx.reply(`Gagal hapus akun dari server.\n\n${resultText}`);
  }

  const serverData = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [row.server_id]).catch(() => null);
  const accountPkg = resolveAccountIpPackage({
    type: row.type,
    account_ip_package: row.account_ip_package,
    limitip: row.limitip || row.iplimit
  });
  const pricePerDay = resolveAccountPricePerDay(serverData || {}, isReseller, {
    account_ip_package: accountPkg,
    account_price_per_day: row.account_price_per_day
  }, true);
  const refund = Math.max(0, remainingDays * pricePerDay);
  if (refund > 0) {
    await dbRunAsync('INSERT OR IGNORE INTO users (user_id, saldo) VALUES (?, 0)', [ctx.from.id]).catch(() => {});
    await dbRunAsync('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [refund, ctx.from.id]).catch(() => {});
    await dbRunAsync(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [ctx.from.id, refund, 'delete_refund', `delete_refund_remote_${Date.now()}`, Date.now()]
    ).catch(() => {});
  }

  state.rows.splice(idx, 1);
  await ctx.reply(
    `Akun berhasil dihapus.\n` +
    `- Username: ${row.username}\n` +
    `- Layanan: ${String(row.type || '-').toUpperCase()}\n` +
    `- Server: ${row.server_name || row.domain || '-'}\n` +
    `- Konversi ke saldo: Rp ${Number(refund).toLocaleString('id-ID')}`
  );
});

bot.action(/delete_my_account_pick_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const accountId = Number(ctx.match[1]);
  const isReseller = await isUserReseller(userId).catch(() => false);

  db.get(
    `SELECT a.*, COALESCE(s.harga, 0) AS harga, COALESCE(s.harga_reseller, 0) AS harga_reseller
     FROM accounts a
     LEFT JOIN Server s ON s.id = a.server_id
     WHERE a.id = ? AND a.user_id = ?`,
    [accountId, userId],
    async (err, row) => {
      if (err) {
        logger.error('❌ Error ambil detail akun untuk hapus mandiri:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memuat detail akun.');
      }
      if (!row) {
        return ctx.reply('❌ Akun tidak ditemukan atau bukan milik kamu.');
      }

      const remainingDays = calcRemainingDays(row.expires_at);
      const accountAgeMs = Date.now() - Number(row.created_at || 0);
      const lockDelete24h = !isReseller && (!Number.isFinite(accountAgeMs) || accountAgeMs < (24 * 60 * 60 * 1000));
      const pricePerDay = resolveAccountPricePerDay(row, isReseller, row, true);
      const refund = Math.max(0, remainingDays * pricePerDay);
      const serverLabel = row.server_name || row.domain || '-';

      await ctx.reply(
        'Konfirmasi Hapus Akun\n\n' +
        `- <b>Username:</b> ${escapeHtml(row.username || '-')}\n` +
        `- <b>Layanan:</b> ${escapeHtml(String(row.type || '-').toUpperCase())}\n` +
        `- <b>Server:</b> ${escapeHtml(serverLabel)}\n` +
        `- <b>Sisa hari:</b> ${remainingDays} hari\n` +
        `- <b>Konversi saldo:</b> Rp ${Number(refund).toLocaleString('id-ID')}\n\n` +
        ((remainingDays < 2 || lockDelete24h)
          ? `Akun ini belum bisa dihapus.${remainingDays < 2 ? ' Minimal sisa masa aktif 2 hari.' : ''}${lockDelete24h ? ' Akun harus aktif minimal 24 jam.' : ''}`
          : 'Akun akan dihapus permanen dari server.'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...((remainingDays >= 2 && !lockDelete24h) ? [[{ text: 'Ya, Hapus Akun Ini', callback_data: `delete_my_account_confirm_${row.id}` }]] : []),
              [{ text: 'Batal', callback_data: 'delete_my_account_select_server' }]
            ]
          }
        }
      );
    }
  );
});

bot.action(/delete_my_account_confirm_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const accountId = Number(ctx.match[1]);
  const isReseller = await isUserReseller(userId).catch(() => false);

  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

  try {
    const row = await dbGet(
      `SELECT a.*, COALESCE(s.harga, 0) AS harga, COALESCE(s.harga_reseller, 0) AS harga_reseller
       FROM accounts a
       LEFT JOIN Server s ON s.id = a.server_id
       WHERE a.id = ? AND a.user_id = ?`,
      [accountId, userId]
    );

    if (!row) {
      return ctx.reply('❌ Akun tidak ditemukan atau sudah terhapus.');
    }

    const deleteFn = SELF_DELETE_TYPE_HANDLERS[row.type];
    if (!deleteFn) {
      return ctx.reply(`❌ Layanan ${row.type} belum didukung untuk hapus mandiri.`);
    }

    const result = await deleteFn(row.username, 'none', 'none', 'none', row.server_id);
    const resultText = typeof result === 'string' ? result : JSON.stringify(result || {});
    if (/gagal|error|failed|tidak\s+ditemukan|not\s+found/i.test(resultText)) {
      logger.error(`❌ Gagal hapus akun mandiri ${row.username} (${row.type}): ${resultText}`);
      return ctx.reply(`❌ Gagal hapus akun dari server.\n\n${resultText}`);
    }

    const remainingDays = calcRemainingDays(row.expires_at);
    if (remainingDays < 2) {
      return ctx.reply('Akun belum bisa dihapus. Minimal sisa masa aktif 2 hari.');
    }
    const accountAgeMs = Date.now() - Number(row.created_at || 0);
    if (!isReseller && (!Number.isFinite(accountAgeMs) || accountAgeMs < (24 * 60 * 60 * 1000))) {
      return ctx.reply('Akun belum bisa dihapus. Akun harus aktif minimal 24 jam.');
    }
    const pricePerDay = resolveAccountPricePerDay(row, isReseller, row, true);
    const refund = Math.max(0, remainingDays * pricePerDay);

    await dbRun('DELETE FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);

    if (refund > 0) {
      await dbRun('INSERT OR IGNORE INTO users (user_id, saldo) VALUES (?, 0)', [userId]);
      await dbRun('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [refund, userId]);
      await dbRun(
        'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
        [userId, refund, 'delete_refund', `delete_refund_${accountId}_${Date.now()}`, Date.now()]
      );
    }

    await notifyGroupAccountDeleted({
      action: 'self_delete',
      actorId: ctx.from.id,
      actorUsername: ctx.from.username || '',
      targetUserId: userId,
      accountUsername: row.username,
      service: String(row.type || '-').toUpperCase(),
      serverName: row.server_name || row.domain || '-',
      refund,
      remainingDays,
      note: 'User hapus akun sendiri'
    });

    await ctx.reply(
      `✅ Akun berhasil dihapus.\n` +
      `• Username: ${row.username}\n` +
      `• Layanan: ${String(row.type || '-').toUpperCase()}\n` +
      `• Server: ${row.server_name || row.domain || '-'}\n` +
      `• Konversi ke saldo: Rp ${Number(refund).toLocaleString('id-ID')}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗂️ Hapus Akun Lain', callback_data: 'delete_my_account_select_server' }],
            [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );
  } catch (e) {
    logger.error('❌ Error konfirmasi hapus akun mandiri:', e.message);
    await ctx.reply('❌ Terjadi kesalahan saat menghapus akun.');
  }
});
async function renderRemoteOwnedAccountsPage(ctx, page = 0) {
  const state = userState[ctx.chat.id]?.remote_owned_accounts;
  if (!state || !Array.isArray(state.rows) || state.rows.length === 0) {
    return ctx.reply('Tidak ada akun remote untuk ditampilkan.');
  }

  const pageSize = Number(state.pageSize || 10);
  const total = state.rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const rows = state.rows.slice(start, end);

  const lines = rows.map((row, idx) => {
    const no = start + idx + 1;
    const expText = row.expires_at
      ? formatDateId(new Date(row.expires_at))
      : (row.date_exp || '-');
    return (
      `${no}. ${String(row.type || '-').toUpperCase()} - ${row.username}\n` +
      `   Server: ${row.server_name || row.domain || '-'}\n` +
      `   Expired: ${expText}`
    );
  });

  const keyboard = [];
  const nav = [];
  if (safePage > 0) nav.push({ text: 'Sebelumnya', callback_data: `view_accounts_remote_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Selanjutnya', callback_data: `view_accounts_remote_page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'view_accounts' }]);

  return ctx.reply(
    `Daftar akun dari server (halaman ${safePage + 1}/${totalPages})\n\n${lines.join('\n\n')}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function renderLocalOwnedAccountsPage(ctx, listType = 'active', page = 0) {
  const state = userState[ctx.chat.id]?.local_owned_accounts;
  if (!state || !Array.isArray(state.rows) || state.rows.length === 0) {
    return ctx.reply(listType === 'expired' ? '📭 Tidak ada akun expired.' : '📭 Tidak ada akun aktif.');
  }
  if (String(state.type || 'active') !== String(listType || 'active')) {
    return ctx.reply('⚠️ Daftar akun sudah berubah. Buka ulang dari menu "Lihat Akun Saya".');
  }

  const pageSize = Number(state.pageSize || 4);
  const total = state.rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const rows = state.rows.slice(start, end);

  const escapeHtmlLocal = (text) => {
    if (!text && text !== 0) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const blocks = rows.map((row, idx) => {
    const number = start + idx + 1;
    const expText = row.expires_at ? formatDateId(new Date(row.expires_at)) : '-';
    const linkLines = [];
    if (row.link_tls) linkLines.push(`- <b>Link TLS</b>: <code>${escapeHtmlLocal(row.link_tls)}</code>`);
    if (row.link_none) linkLines.push(`- <b>Link NTLS</b>: <code>${escapeHtmlLocal(row.link_none)}</code>`);
    if (row.link_grpc) linkLines.push(`- <b>Link GRPC</b>: <code>${escapeHtmlLocal(row.link_grpc)}</code>`);

    const isZivpn = String(row.type || '').toLowerCase() === 'zivpn';
    const accountLabel = isZivpn ? 'UDP Password' : 'Username';
    const passwordLine = (!isZivpn && row.password)
      ? `- <b>Password:</b> ${escapeHtmlLocal(row.password)}\n`
      : '';

    return (
      `#${number}\n` +
      `- <b>Layanan:</b> ${escapeHtmlLocal(row.type).toUpperCase()}\n` +
      `- <b>${accountLabel}:</b> ${escapeHtmlLocal(row.username)}\n` +
      passwordLine +
      `- <b>Server:</b> ${escapeHtmlLocal(row.server_name || row.domain || '-')}\n` +
      `- <b>Domain:</b> ${escapeHtmlLocal(row.domain || '-')}\n` +
      `- <b>Expired:</b> ${escapeHtmlLocal(expText)}` +
      (linkLines.length ? `\n${linkLines.join('\n')}` : '')
    );
  });

  const title = listType === 'expired' ? 'Akun Expired' : 'Akun Aktif';
  const text =
    `<b>${title}</b>\n` +
    `<i>Halaman ${safePage + 1}/${totalPages}</i>\n\n` +
    blocks.join('\n\n');

  const nav = [];
  if (safePage > 0) nav.push({ text: 'Sebelumnya', callback_data: `view_accounts_local_page_${listType}_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Selanjutnya', callback_data: `view_accounts_local_page_${listType}_${safePage + 1}` });
  const keyboard = [];
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: 'Kembali', callback_data: 'view_accounts' }]);

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function normalizeRenewAccountType(rawType) {
  const value = String(rawType || '').trim().toLowerCase();
  if (value === 'udp') return 'udp_http';
  if (value === 'ovpn') return 'ssh';
  return value;
}

function inferIpPackageByAccount(type, iplimit) {
  const normalizedType = normalizeRenewAccountType(type);
  const ip = Number(iplimit || 0);
  if (!Number.isFinite(ip) || ip <= 0) return 1;
  if (normalizedType === 'udp_http') {
    // Kompatibel dengan mapping lama (1IP=5,2IP=6) dan mapping baru (1IP=3,2IP=4)
    if (ip >= 6) return 2;
    if (ip === 5) return 1;
    return ip >= 4 ? 2 : 1;
  }
  // Untuk akun reguler: paket 1IP dikirim sebagai limit 2, paket 2IP sebagai limit 3.
  return ip >= 3 ? 2 : 1;
}

async function findRenewCandidatesByUsername(ctx, rawUsername) {
  const userId = ctx.from.id;
  const username = String(rawUsername || '').trim().toLowerCase();
  if (!username) return [];

  const localRows = await dbAllAsync(
    `SELECT a.*, s.iplimit AS server_iplimit, s.quota AS server_quota,
            COALESCE(NULLIF(s.nama_server, ''), s.domain, a.server_name, a.domain, '-') AS resolved_server_name,
            COALESCE(NULLIF(s.domain, ''), a.domain, '-') AS resolved_domain
     FROM accounts a
     LEFT JOIN Server s ON s.id = a.server_id
     WHERE a.user_id = ?
       AND LOWER(TRIM(COALESCE(a.username, ''))) = LOWER(TRIM(?))
     ORDER BY a.id DESC`,
    [userId, username]
  ).catch(() => []);

  const candidates = [];
  const seen = new Set();
  const now = Date.now();

  const pushCandidate = (item) => {
    const normalizedType = normalizeRenewAccountType(item.type);
    const supportedTypes = new Set(['vmess', 'vless', 'trojan', 'shadowsocks', 'ssh', 'zivpn', 'udp_http']);
    if (!supportedTypes.has(normalizedType)) return;
    if (!Number.isFinite(item.serverId) || item.serverId <= 0) return;

    const key = `${item.serverId}|${normalizedType}|${String(item.username || '').toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    const expiresAtNum = Number(item.expiresAt || 0);
    const remainingDays = expiresAtNum > 0
      ? calcRemainingDays(expiresAtNum)
      : calcRemainingDaysFromDateExp(item.dateExp || '');

    candidates.push({
      username: String(item.username || '').trim(),
      type: normalizedType,
      password: String(item.password || '').trim(),
      serverId: Number(item.serverId),
      serverName: String(item.serverName || '-').trim() || '-',
      domain: String(item.domain || '-').trim() || '-',
      iplimit: Number(item.iplimit || 0),
      quota: Number(item.quota || 0),
      expiresAt: expiresAtNum > 0 ? expiresAtNum : null,
      dateExp: String(item.dateExp || '').trim(),
      status: String(item.status || '').trim().toUpperCase(),
      source: String(item.source || 'local'),
      remainingDays,
      selectedIpPackage: Number(item.accountIpPackage || inferIpPackageByAccount(normalizedType, item.iplimit)) === 2 ? 2 : 1,
      accountPricePerDay: Math.max(0, Number(item.accountPricePerDay || 0))
    });
  };

  for (const row of localRows) {
    pushCandidate({
      username: row.username,
      type: row.type,
      password: row.password,
      serverId: Number(row.server_id || 0),
      serverName: row.resolved_server_name || row.server_name || row.domain || '-',
      domain: row.resolved_domain || row.domain || '-',
      iplimit: Number(row.server_iplimit || 0),
      quota: Number(row.server_quota || 0),
      accountIpPackage: Number(row.account_ip_package || 0),
      accountPricePerDay: Number(row.account_price_per_day || 0),
      expiresAt: Number(row.expires_at || 0) || null,
      dateExp: row.expires_at ? formatDateYmdLocal(new Date(Number(row.expires_at))) : '',
      status: (Number(row.expires_at || 0) > now) ? 'ACTIVE' : 'EXPIRED',
      source: 'local'
    });
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const isReseller = await isUserReseller(userId).catch(() => false);
  const servers = await dbAllAsync(
    `SELECT id, nama_server, domain, sync_host, auth
     FROM Server
     WHERE COALESCE(is_active, 1) = 1
       AND (COALESCE(is_reseller_only, 0) = 0 OR ? = 1)
     ORDER BY nama_server COLLATE NOCASE ASC`,
    [isReseller ? 1 : 0]
  ).catch(() => []);

  for (const server of servers) {
    const owned = await fetchOwnedAccountsByTelegramFromServer(server, userId);
    for (const row of owned) {
      if (String(row.username || '').trim().toLowerCase() !== username) continue;
      pushCandidate({
        username: row.username,
        type: row.type,
        password: row.password,
        serverId: Number(server.id || row.server_id || 0),
        serverName: server.nama_server || server.domain || row.server_name || '-',
        domain: server.domain || row.domain || '-',
        iplimit: Number(row.limitip || 0),
        quota: Number(row.quota || 0),
        accountIpPackage: inferIpPackageByAccount(row.type, row.limitip),
        expiresAt: Number(row.expires_at || 0) || null,
        dateExp: String(row.date_exp || '').trim(),
        status: row.status || ((Number(row.expires_at || 0) > now) ? 'ACTIVE' : 'EXPIRED'),
        source: 'remote'
      });
    }
  }

  return candidates;
}

async function renderRenewLookupList(ctx, page = 0) {
  const state = userState[ctx.chat.id]?.renew_lookup;
  if (!state || !Array.isArray(state.rows) || state.rows.length === 0) {
    return ctx.reply('Data akun tidak tersedia. Silakan mulai ulang perpanjang akun.');
  }

  const pageSize = Number(state.pageSize || 8);
  const total = state.rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = safePage * pageSize;
  const rows = state.rows.slice(start, start + pageSize);

  const keyboard = rows.map((row, idx) => {
    const absIndex = start + idx;
    return [{
      text: `${row.username} | ${String(row.type || '-').toUpperCase()} | ${row.serverName}`,
      callback_data: `renew_lookup_pick_${absIndex}`
    }];
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: 'Sebelumnya', callback_data: `renew_lookup_page_${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: 'Selanjutnya', callback_data: `renew_lookup_page_${safePage + 1}` });
  if (nav.length > 0) keyboard.push(nav);
  keyboard.push([{ text: 'Menu Utama', callback_data: 'send_main_menu' }]);

  return ctx.reply(
    `Ditemukan ${total} akun dengan username "${state.username}". Pilih akun yang ingin diperpanjang.\nHalaman ${safePage + 1}/${totalPages}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function sendRenewAccountDetail(ctx, rowIndex) {
  const state = userState[ctx.chat.id]?.renew_lookup;
  if (!state || !Array.isArray(state.rows) || rowIndex < 0 || rowIndex >= state.rows.length) {
    return ctx.reply('Data akun tidak ditemukan, silakan cari ulang.');
  }

  const row = state.rows[rowIndex];
  const expText = row.expiresAt
    ? formatDateId(new Date(row.expiresAt))
    : (row.dateExp || '-');
  const statusText = row.status || (row.remainingDays > 0 ? 'ACTIVE' : 'EXPIRED');
  const pkgText = Number(row.selectedIpPackage || 1) === 2 ? '2 IP' : '1 IP';
  const hargaPerHariText = Number(row.accountPricePerDay || 0) > 0
    ? `Rp ${Number(row.accountPricePerDay).toLocaleString('id-ID')}`
    : '-';

  const text =
    'Detail akun ditemukan:\n\n' +
    `- Username: ${row.username}\n` +
    `- Layanan: ${String(row.type || '-').toUpperCase()}\n` +
    `- Server: ${row.serverName || '-'}\n` +
    `- Domain: ${row.domain || '-'}\n` +
    `- Paket IP: ${pkgText}\n` +
    `- Limit IP: ${Number(row.iplimit || 0)}\n` +
    `- Quota Server/Hari: ${Number(row.quota || 0)} GB\n` +
    `- Harga/Hari Tersimpan: ${hargaPerHariText}\n` +
    `- Expired: ${expText}\n` +
    `- Sisa aktif: ${Number(row.remainingDays || 0)} hari\n` +
    `- Status: ${statusText}`;

  const keyboard = [
    [{ text: 'Perpanjang akun ini', callback_data: `renew_lookup_extend_${rowIndex}` }]
  ];
  if ((state.rows || []).length > 1) {
    keyboard.push([{ text: 'Pilih akun lain', callback_data: 'renew_lookup_page_0' }]);
  }
  keyboard.push([{ text: 'Menu Utama', callback_data: 'send_main_menu' }]);

  return ctx.reply(text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAccountList(ctx, isExpired, limit = 10) {
  const userId = ctx.from.id;
  const now = Date.now();
  const cutoff = now - (3 * 24 * 60 * 60 * 1000);
  if (isExpired) {
    cleanupExpiredAccounts();
    limit = 0;
  }

  const query = isExpired
    ? `SELECT * FROM accounts WHERE user_id = ? AND expires_at <= ? AND expires_at >= ? ORDER BY expires_at DESC${limit ? ' LIMIT ' + limit : ''}`
    : `SELECT * FROM accounts WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC${limit ? ' LIMIT ' + limit : ''}`;
  const params = isExpired ? [userId, now, cutoff] : [userId, now];

  db.all(query, params, async (err, rows) => {
    if (err) {
      const errMsg = err && err.message ? err.message : String(err);
      logger.error('❌ Error ambil akun:', errMsg);
      if (errMsg.includes('no such table')) {
        return ctx.reply('📭 Belum ada data akun. Silakan buat akun dulu.');
      }
      return ctx.reply('❌ Terjadi kesalahan saat mengambil data akun.');
    }
    if (!rows || rows.length === 0) {
      if (!isExpired) {
        const isReseller = await isUserReseller(userId).catch(() => false);
        const servers = await dbAllAsync(
          `SELECT id, nama_server, domain, sync_host, auth
           FROM Server
           WHERE COALESCE(is_active, 1) = 1
             AND (COALESCE(is_reseller_only, 0) = 0 OR ? = 1)
           ORDER BY nama_server COLLATE NOCASE ASC`,
          [isReseller ? 1 : 0]
        ).catch(() => []);

        const remoteRows = [];
        for (const server of servers) {
          const owned = await fetchOwnedAccountsByTelegramFromServer(server, userId);
          for (const item of owned) {
            if (item.expires_at && item.expires_at <= now) continue;
            remoteRows.push(item);
          }
        }

        const unique = [];
        const seen = new Set();
        for (const item of remoteRows) {
          const key = `${item.server_id}|${String(item.type || '').toLowerCase()}|${String(item.username || '').toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(item);
        }

        if (unique.length > 0) {
          userState[ctx.chat.id] = userState[ctx.chat.id] || {};
          userState[ctx.chat.id].remote_owned_accounts = { rows: unique, pageSize: 10 };
          return renderRemoteOwnedAccountsPage(ctx, 0);
        }
      }
      return ctx.reply(isExpired ? '📭 Tidak ada akun expired.' : '📭 Tidak ada akun aktif.');
    }

    userState[ctx.chat.id] = userState[ctx.chat.id] || {};
    userState[ctx.chat.id].local_owned_accounts = {
      type: isExpired ? 'expired' : 'active',
      rows,
      pageSize: 4
    };
    await renderLocalOwnedAccountsPage(ctx, isExpired ? 'expired' : 'active', 0);
  });
}

bot.action('view_accounts_active', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, false, 10);
});

bot.action('view_accounts_active_all', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, false, 0);
});

bot.action('view_accounts_expired', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, true, 0);
});

bot.action(/view_accounts_remote_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number(ctx.match[1] || 0);
  await renderRemoteOwnedAccountsPage(ctx, Number.isFinite(page) ? page : 0);
});

bot.action(/view_accounts_local_page_(active|expired)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const listType = String(ctx.match[1] || 'active');
  const page = Number(ctx.match[2] || 0);
  await renderLocalOwnedAccountsPage(ctx, listType, Number.isFinite(page) ? page : 0);
});

bot.action(/renew_lookup_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number(ctx.match[1] || 0);
  await renderRenewLookupList(ctx, Number.isFinite(page) ? page : 0);
});

bot.action(/renew_lookup_pick_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const rowIndex = Number(ctx.match[1] || -1);
  await sendRenewAccountDetail(ctx, rowIndex);
});

bot.action(/renew_lookup_extend_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const rowIndex = Number(ctx.match[1] || -1);
  const lookupState = userState[ctx.chat.id]?.renew_lookup;
  if (!lookupState || !Array.isArray(lookupState.rows) || rowIndex < 0 || rowIndex >= lookupState.rows.length) {
    return ctx.reply('Data akun tidak ditemukan, silakan mulai ulang proses perpanjang.');
  }

  const row = lookupState.rows[rowIndex];
  userState[ctx.chat.id] = {
    step: `exp_renew_${row.type}`,
    action: 'renew',
    type: row.type,
    username: row.username,
    password: row.password || '',
    serverId: row.serverId,
    selectedIpPackage: row.selectedIpPackage || 1,
    accountIpPackage: row.selectedIpPackage || 1,
    accountPricePerDay: Number(row.accountPricePerDay || 0),
    accountIpLimit: Number(row.iplimit || 0),
    accountQuota: Number(row.quota || 0),
    serverName: row.serverName || '',
    serverDomain: row.domain || ''
  };

  await ctx.reply(
    `Akun ${row.username} dipilih untuk diperpanjang.\n` +
    'Masukkan mau berapa hari perpanjangnya:',
    { parse_mode: 'Markdown' }
  );
});

async function sendGlobalStatsDetail(ctx) {
  const userId = ctx.from.id;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let today = 0;
  let week = 0;
  let month = 0;
  let allTime = 0;
  let breakdown = {};
  let myToday = 0;
  let myWeek = 0;
  let myMonth = 0;
  let myAllTime = 0;
  let myBreakdown = {};

  try {
    [
      today,
      week,
      month,
      allTime,
      breakdown,
      myToday,
      myWeek,
      myMonth,
      myAllTime,
      myBreakdown
    ] = await Promise.all([
      getAccountTransactionCount({ startTs: todayStart }),
      getAccountTransactionCount({ startTs: weekStart }),
      getAccountTransactionCount({ startTs: monthStart }),
      getAccountTransactionCount(),
      getAccountTypeBreakdown(),
      getAccountTransactionCount({ userId, startTs: todayStart }),
      getAccountTransactionCount({ userId, startTs: weekStart }),
      getAccountTransactionCount({ userId, startTs: monthStart }),
      getAccountTransactionCount({ userId }),
      getAccountTypeBreakdown({ userId })
    ]);
  } catch (err) {
    logger.error('Gagal mengambil statistik detail global:', err.message);
  }

  const detail = formatAccountBreakdownBlock(breakdown);
  const myDetail = formatAccountBreakdownBlock(myBreakdown);
  const text = [
    '<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>',
    '<b>    STATISTIK DETAIL</b>',
    '<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>',
    '',
    '<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>',
    '<b>    STATISTIK BOT</b>',
    '<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>',
    `📅 Hari ini   : ${today} akun`,
    `📆 Minggu ini : ${week} akun`,
    `🗓️ Bulan ini  : ${month} akun`,
    `📦 Total akun : ${allTime} akun`,
    '<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>',
    '',
    '<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>',
    '<b>    RINCIAN PROTOCOL BOT</b>',
    '<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>',
    `<code>${escapeHtml(detail)}</code>`,
    '<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>',
    '',
    '<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>',
    '<b>    STATISTIK SAYA</b>',
    '<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>',
    `📅 Hari ini   : ${myToday} akun`,
    `📆 Minggu ini : ${myWeek} akun`,
    `🗓️ Bulan ini  : ${myMonth} akun`,
    `📦 Total akun : ${myAllTime} akun`,
    '<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>',
    '',
    '<code>┏━━━━━━━━━━━━━━━━━━━━┓</code>',
    '<b>    RINCIAN PROTOCOL SAYA</b>',
    '<code>┣━━━━━━━━━━━━━━━━━━━━┫</code>',
    `<code>${escapeHtml(myDetail)}</code>`,
    '<code>┗━━━━━━━━━━━━━━━━━━━━┛</code>'
  ].join('\n');

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, options).catch(() => ctx.reply(text, options));
  }
  return ctx.reply(text, options);
}

bot.action('global_stats_detail', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendGlobalStatsDetail(ctx);
});

async function sendUserStatsMenu(ctx) {
  const userId = ctx.from.id;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let today = 0;
  let week = 0;
  let month = 0;
  let allTime = 0;
  let breakdown = {};

  try {
    [today, week, month, allTime, breakdown] = await Promise.all([
      getAccountTransactionCount({ userId, startTs: todayStart }),
      getAccountTransactionCount({ userId, startTs: weekStart }),
      getAccountTransactionCount({ userId, startTs: monthStart }),
      getAccountTransactionCount({ userId }),
      getAccountTypeBreakdown({ userId })
    ]);
  } catch (err) {
    logger.error('Gagal mengambil statistik user:', err.message);
  }

  const detail = formatAccountBreakdownBlock(breakdown);
  const text =
    '<b>📊 STATISTIK SAYA</b>\n\n' +
    `• 📅 <b>Hari Ini</b>   : ${today} akun\n` +
    `• 📆 <b>Minggu Ini</b> : ${week} akun\n` +
    `• 🗓️ <b>Bulan Ini</b>  : ${month} akun\n` +
    `• 📦 <b>Total Akun</b> : ${allTime} akun\n\n` +
    '<b>Rincian Protocol All Time</b>\n' +
    `<code>${escapeHtml(detail)}</code>`;

  const options = {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]]
    }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(text, options).catch(() => ctx.reply(text, options));
  }
  return ctx.reply(text, options);
}

bot.action('menu_user_stats', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendUserStatsMenu(ctx);
});

async function sendVpnMenu(ctx) {
  const isResellerUser = await isUserReseller(ctx.from.id).catch(() => false);
  const keyboard = [
    [
      { text: '➕ Buat Akun', callback_data: 'service_create' },
      { text: '⌛ Trial Akun', callback_data: 'service_trial' }
    ],
    [
      { text: '♻️ Perpanjang Akun', callback_data: 'service_renew' },
      { text: '🔍 Cek Masa Aktif', callback_data: 'check_expiry_account' }
    ],
    [
      { text: '🗑️ Hapus Akun Saya', callback_data: 'delete_my_account_intro' },
      { text: '📂 Lihat Akun Saya', callback_data: 'view_accounts' }
    ]
  ];

  if (isResellerUser) {
    keyboard.push([
      { text: '🗑️ Hapus Manual', callback_data: 'service_del' },
      { text: '🗝️ Kunci Akun', callback_data: 'service_lock' }
    ]);
    keyboard.push([{ text: '🔐 Buka Kunci Akun', callback_data: 'service_unlock' }]);
  }

  keyboard.push([{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]);

  const options = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText('*🌐 MENU VPN*', options).catch(() => ctx.reply('*🌐 MENU VPN*', options));
  }
  return ctx.reply('*🌐 MENU VPN*', options);
}

bot.action('menu_vpn', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendVpnMenu(ctx);
});

async function sendToolsMenu(ctx) {
  const keyboard = [
    [
      { text: '📶 Cek Server', callback_data: 'cek_server' }
    ],
    [
      { text: '🧩 Buat Config dan Unlock', callback_data: 'config_unlock_menu' }
    ],
    [
      { text: '🧩 Rubah Link Vmess, Vless dan Trojan To JSON', callback_data: 'hc_v2ray' }
    ],
    [
      { text: '💳 Riwayat TopUp', callback_data: 'topup_history' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
  ];

  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText('*🧰 MENU TOOLS*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await ctx.reply('*🧰 MENU TOOLS*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } catch (error) {
    logger.error('Error saat mengirim menu tools:', error);
  }
}

async function sendMainMenuSettings(ctx) {
  const groupStatus = MAIN_MENU_GROUP_ENABLED ? 'Aktif' : 'Nonaktif';
  const channelStatus = MAIN_MENU_CHANNEL_ENABLED ? 'Aktif' : 'Nonaktif';
  const tutorialStatus = MAIN_MENU_TUTORIAL_ENABLED ? 'Aktif' : 'Nonaktif';
  const topupManualEnabled = loadTopupManualSetting();
  const scNexusEnabled = loadScNexusMenuSetting();
  const topupManualStatus = topupManualEnabled ? 'Aktif' : 'Nonaktif';
  const scNexusStatus = scNexusEnabled ? 'Aktif' : 'Nonaktif';
  const message =
    '<b>🏠 SETTING HALAMAN UTAMA</b>\n\n' +
    `Admin: <code>${escapeHtml(getAdminTelegramUsername())}</code>\n\n` +
    '<b>Tombol Halaman Utama</b>\n' +
    `TopUp Manual QRIS: ${escapeHtml(topupManualStatus)}\n` +
    `SC 1FORCR NEXUS: ${escapeHtml(scNexusStatus)}\n` +
    `Tutorial: ${escapeHtml(tutorialStatus)}\n\n` +
    '<b>Info Grup</b>\n' +
    `Status: ${escapeHtml(groupStatus)}\n` +
    `Nama: ${escapeHtml(MAIN_MENU_GROUP_LABEL || '-')}\n` +
    `Link: ${escapeHtml(MAIN_MENU_GROUP_URL || '-')}\n\n` +
    '<b>Info Channel</b>\n' +
    `Status: ${escapeHtml(channelStatus)}\n` +
    `Nama: ${escapeHtml(MAIN_MENU_CHANNEL_LABEL || '-')}\n` +
    `Link: ${escapeHtml(MAIN_MENU_CHANNEL_URL || '-')}`;

  const keyboard = [
    [{ text: 'Set Admin Telegram', callback_data: 'main_menu_set_admin_telegram' }],
    [
      { text: topupManualEnabled ? 'Nonaktifkan TopUp Manual' : 'Aktifkan TopUp Manual', callback_data: 'toggle_topup_manual' },
      { text: scNexusEnabled ? 'Nonaktifkan SC Nexus' : 'Aktifkan SC Nexus', callback_data: 'toggle_sc_nexus_menu' }
    ],
    [{ text: MAIN_MENU_TUTORIAL_ENABLED ? 'Nonaktifkan Tutorial' : 'Aktifkan Tutorial', callback_data: 'main_menu_toggle_tutorial' }],
    [
      { text: MAIN_MENU_GROUP_ENABLED ? 'Nonaktifkan Grup' : 'Aktifkan Grup', callback_data: 'main_menu_toggle_group' },
      { text: 'Set Grup', callback_data: 'main_menu_set_group' }
    ],
    [
      { text: MAIN_MENU_CHANNEL_ENABLED ? 'Nonaktifkan Channel' : 'Aktifkan Channel', callback_data: 'main_menu_toggle_channel' },
      { text: 'Set Channel', callback_data: 'main_menu_set_channel' }
    ],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  const options = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  };

  if (ctx.updateType === 'callback_query') {
    return ctx.editMessageText(message, options).catch(() => ctx.reply(message, options));
  }
  return ctx.reply(message, options);
}

bot.action('menu_tools', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendToolsMenu(ctx);
});

bot.action('topup_history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  db.all(
    `SELECT amount, type, timestamp
     FROM transactions
     WHERE user_id = ? AND type IN ('deposit','deposit_bonus')
     ORDER BY timestamp DESC
     LIMIT 10`,
    [userId],
    async (err, rows) => {
      if (err) {
        logger.error('❌ Error ambil riwayat topup:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil riwayat topup.');
      }
      if (!rows || rows.length === 0) {
        return ctx.reply('📭 Belum ada riwayat topup.');
      }

      const blocks = rows.map((row, idx) => {
        const dateText = row.timestamp ? new Date(row.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-';
        const label = row.type === 'deposit_bonus' ? 'Bonus' : 'TopUp';
        return (
          `#${idx + 1}\n` +
          `• <b>Tipe:</b> ${escapeHtmlLocal(label)}\n` +
          `• <b>Nominal:</b> ${escapeHtmlLocal(formatRupiah(row.amount))}\n` +
          `• <b>Waktu:</b> ${escapeHtmlLocal(dateText)}`
        );
      });

      const title = '💳 <b>Riwayat TopUp (10 terakhir)</b>';
      const maxLen = 3800;
      let chunk = `${title}\n\n`;

      for (const block of blocks) {
        const next = chunk.length > title.length + 2 ? `${chunk}\n\n${block}` : `${chunk}${block}`;
        if (next.length > maxLen) {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
          chunk = `${title}\n\n${block}`;
        } else {
          chunk = next;
        }
      }

      if (chunk.trim()) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
      return;
    }
  );
});

function parseVmessLink(link) {
  const raw = link.replace(/^vmess:\/\//i, '').trim();
  const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  const data = JSON.parse(decoded);
  return {
    protocol: 'vmess',
    address: data.add || '',
    port: Number(data.port || 0),
    id: data.id || '',
    alterId: Number(data.aid || 0),
    security: data.scy || data.security || 'auto',
    network: data.net || 'ws',
    path: data.path || '/',
    host: data.host || data.sni || data.add || '',
    tls: data.tls || '',
    sni: data.sni || data.host || ''
  };
}

function parseVlessLink(link) {
  const url = new URL(link);
  return {
    protocol: 'vless',
    address: url.hostname,
    port: Number(url.port || 0),
    id: decodeURIComponent(url.username || ''),
    security: url.searchParams.get('security') || 'none',
    network: url.searchParams.get('type') || 'ws',
    path: url.searchParams.get('path') || '/',
    host: url.searchParams.get('host') || url.searchParams.get('sni') || url.hostname,
    sni: url.searchParams.get('sni') || ''
  };
}

function parseTrojanLink(link) {
  const url = new URL(link);
  return {
    protocol: 'trojan',
    address: url.hostname,
    port: Number(url.port || 0),
    password: decodeURIComponent(url.username || ''),
    security: url.searchParams.get('security') || 'none',
    network: url.searchParams.get('type') || 'ws',
    path: url.searchParams.get('path') || '/',
    host: url.searchParams.get('host') || url.searchParams.get('sni') || url.hostname,
    sni: url.searchParams.get('sni') || ''
  };
}

function buildHcJson(parsed, bugHost) {
  const isTls = parsed.security === 'tls' || parsed.tls === 'tls';
  const endpoint = parseHcEndpoint(bugHost) || { address: parsed.address, port: null };
  const address = endpoint.address;
  const port = endpoint.port || parsed.port || (isTls ? 443 : 80);
  const outbound = {
    mux: { enabled: false },
    protocol: parsed.protocol,
    settings: {},
    streamSettings: {
      network: parsed.network || 'ws',
      security: isTls ? 'tls' : 'none'
    },
    tag: parsed.protocol.toUpperCase()
  };

  if (parsed.protocol === 'vmess') {
    outbound.settings.vnext = [{
      address,
      port,
      users: [{
        alterId: parsed.alterId || 0,
        id: parsed.id || '',
        level: 8,
        security: parsed.security === 'tls' ? 'auto' : (parsed.security || 'auto')
      }]
    }];
  } else if (parsed.protocol === 'vless') {
    outbound.settings.vnext = [{
      address,
      port,
      users: [{
        id: parsed.id || '',
        encryption: 'none',
        level: 8
      }]
    }];
  } else if (parsed.protocol === 'trojan') {
    outbound.settings.servers = [{
      address,
      port,
      password: parsed.password || '',
      level: 8
    }];
  }

  if (parsed.network === 'grpc') {
    outbound.streamSettings.grpcSettings = {
      serviceName: (parsed.path || '').replace(/^\//, '') || parsed.protocol
    };
  } else if (parsed.network === 'httpupgrade') {
    outbound.streamSettings.httpupgradeSettings = {
      path: parsed.path || '/',
      host: parsed.host || parsed.sni || ''
    };
  } else {
    outbound.streamSettings.wsSettings = {
      headers: { Host: parsed.host || parsed.sni || '' },
      path: parsed.path || '/'
    };
  }

  if (isTls) {
    const serverName = parsed.sni || parsed.host || '';
    outbound.streamSettings.tlsSettings = { allowInsecure: true, serverName };
  }

  return {
    inbounds: [],
    outbounds: [outbound],
    policy: {
      levels: {
        8: {
          connIdle: 300,
          downlinkOnly: 1,
          handshake: 4,
          uplinkOnly: 1
        }
      }
    }
  };
}

bot.action('hc_v2ray', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState[ctx.chat.id] = { step: 'hc_link' };
  await ctx.reply(
    'Kirim link *VMESS/VLESS/TROJAN* (TLS/NTLS).\n' +
    'Contoh: `vmess://...`',
    { parse_mode: 'Markdown' }
  );
});

// =================== HANDLER CONFIRM HAPUS SALDO ===================
bot.action('confirm_hapus_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const adminId = ctx.from.id;
    const state = userState[adminId];
    
    if (!state || state.step !== 'hapus_saldo_confirm') {
      return ctx.reply('❌ Sesi sudah berakhir. Silakan ulangi dari awal.');
    }
    
    const targetUserId = state.targetUserId;
    const amount = state.amountToRemove;
    
    // Lakukan pengurangan saldo
    db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, targetUserId], function (err) {
      if (err) {
        logger.error('❌ Error hapus saldo via menu:', err.message);
        return ctx.reply('❌ Gagal menghapus saldo.');
      }
      
      // Ambil saldo terbaru
      db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err2, updatedRow) => {
        delete userState[adminId];
        
        if (err2) {
          ctx.reply(`✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.`);
        } else {
          ctx.reply(
            `✅ *SALDO BERHASIL DIHAPUS!*\n\n` +
            `👤 User ID: \`${targetUserId}\`\n` +
            `🗑️ Jumlah dihapus: *Rp ${amount.toLocaleString('id-ID')}*\n` +
            `💰 Saldo sekarang: *Rp ${updatedRow.saldo.toLocaleString('id-ID')}*`,
            { parse_mode: 'Markdown' }
          );
        }
        
        // Log ke transactions
        const referenceId = `remove_saldo_${targetUserId}_${Date.now()}`;
        db.run(
          'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
          [targetUserId, amount, 'saldo_removed', referenceId, Date.now()],
          (err3) => {
            if (err3) logger.error('Gagal log transaksi hapus saldo:', err3.message);
          }
        );
        
        // Log ke file
        logger.info(`Admin ${adminId} menghapus saldo Rp${amount} dari user ${targetUserId}. Saldo akhir: Rp${updatedRow ? updatedRow.saldo : 'N/A'}`);
        
        // Kirim notifikasi ke user yang saldonya dihapus
        try {
          bot.telegram.sendMessage(
            targetUserId,
            `⚠️ *PEMBERITAHUAN SALDO*\n\n` +
            `Saldo Anda dikurangi sebesar *Rp ${amount.toLocaleString('id-ID')}* oleh admin.\n` +
            `💰 Saldo sekarang: *Rp ${updatedRow ? updatedRow.saldo.toLocaleString('id-ID') : '0'}*\n\n` +
            `📅 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
            { parse_mode: 'Markdown' }
          ).catch(() => {
            // User mungkin memblokir bot, tidak apa-apa
          });
        } catch (notifErr) {
          logger.error('Gagal kirim notifikasi ke user:', notifErr.message);
        }
      });
    });
    
  } catch (error) {
    logger.error('❌ Error in confirm_hapus_saldo:', error);
    await ctx.reply('❌ Terjadi kesalahan saat menghapus saldo.');
  }
});

bot.action('cancel_hapus_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  delete userState[adminId];
  await ctx.reply('❌ Proses penghapusan saldo dibatalkan.');
});

// =================== HANDLER HAPUS SALDO ===================
bot.action('hapus_saldo', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  
  await ctx.answerCbQuery();
  userState[adminId] = { step: 'hapus_saldo_userid' };
  await ctx.reply('🗑️ *Masukkan ID Telegram user yang saldonya akan dihapus:*', { parse_mode: 'Markdown' });
});

//callback handller statistik reseller
async function handleResellerStats(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    
    // Cek reseller
    const isReseller = await isUserReseller(userId);
    if (!isReseller) {
      return ctx.reply('❌ Fitur ini hanya untuk reseller!');
    }
    
    // ✅ KIRIM PESAN LOADING DAN SIMPAN ID-NYA
    const loadingMsg = await ctx.reply('⏳ Mengambil data statistik...');
    const loadingMsgId = loadingMsg.message_id;
    
    // Ambil data
    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], async (err, user) => {
      if (err) {
        // ❌ HAPUS PESAN LOADING JIKA ERROR
        try {
          await ctx.deleteMessage(loadingMsgId);
        } catch (e) {}
        await ctx.reply('❌ Terjadi kesalahan saat mengambil data.');
        return;
      }
      
      const saldo = user ? user.saldo : 0;
      const now = new Date();
      const monthRange = getMonthRange(0);
      
      db.all(
        `SELECT type, COUNT(*) as count FROM transactions 
         WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
         AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
         AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')
         GROUP BY type`,
        [userId, monthRange.start, monthRange.end],
        async (err, rows) => {
          // ✅ HAPUS PESAN LOADING SETELAH DATA SIAP
          try {
            await ctx.deleteMessage(loadingMsgId);
          } catch (e) {
            logger.error('Gagal hapus pesan loading:', e.message);
          }
          
          if (err) {
            await ctx.reply('❌ Terjadi kesalahan saat mengambil data transaksi.');
            return;
          }

          const totalTopup = await new Promise((resolve) => {
            db.get(
              `SELECT SUM(amount) as total FROM transactions
               WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND type = 'deposit'`,
              [userId, monthRange.start, monthRange.end],
              (err2, row2) => resolve(!err2 && row2 && row2.total ? row2.total : 0)
            );
          });

          let allTimeAccounts = 0;
          let allTimeDetail = formatAccountBreakdownBlock({});
          try {
            const [accountCount, accountBreakdown] = await Promise.all([
              getAccountTransactionCount({ userId }),
              getAccountTypeBreakdown({ userId })
            ]);
            allTimeAccounts = accountCount;
            allTimeDetail = formatAccountBreakdownBlock(accountBreakdown);
          } catch (statErr) {
            logger.error('Gagal mengambil rincian all-time reseller:', statErr.message);
          }
          
          let totalAccounts = 0;
          const details = [];
          
          rows.forEach(row => {
            totalAccounts += row.count;
            const safeType = row.type.toUpperCase().replace(/_/g, '\\_');
            details.push(`• ${safeType}: ${row.count} akun`);
          });
          
          const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                            "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
          
          const statsMessage = 
            `📊 *STATISTIK SAYA*\n\n` +
            `💰 Saldo: Rp ${saldo.toLocaleString('id-ID')}\n` +
            `💳 Top Up Bulan Ini: Rp ${totalTopup.toLocaleString('id-ID')}\n` +
            `📅 Periode: ${monthNames[now.getMonth()]} ${now.getFullYear()}\n\n` +
            `📈 *Aktivitas Bulan Ini:*\n` +
            (details.length > 0 ? details.join('\n') : '• Belum ada transaksi') + `\n\n` +
            `📊 Total: *${totalAccounts} akun*\n\n` +
            `📦 *All Time:* ${allTimeAccounts} akun\n` +
            `🔎 *Rincian Protocol All Time:*\n` +
            `\`\`\`\n${allTimeDetail}\n\`\`\`\n\n` +
            `🔄 Update terakhir: ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
          
          // ✅ KIRIM PESAN BARU DENGAN DATA
          await ctx.reply(statsMessage, { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'reseller_stats_refresh' }],
                [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
              ]
            }
          });
        }
      );
    });
    
  } catch (error) {
    logger.error('Error di reseller_stats:', error);
    await ctx.reply('❌ Terjadi kesalahan.');
  }
}

bot.action('reseller_stats', handleResellerStats);

// Handler untuk refresh
bot.action('reseller_stats_refresh', async (ctx) => {
  await handleResellerStats(ctx);
});

//handler untuk add server reseller
bot.action('add_server_zivpn_reseller_cmd', async (ctx) => {
  await ctx.reply(
    'Silakan gunakan command berikut untuk menambahkan server ZIVPN reseller:\n\n' +
    '`/addserverzivpn_reseller <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>`\n\n' +
    'Contoh:\n' +
    '`/addserverzivpn_reseller sg-udp-01.example.com myauth123 5000 7000 4500 6500 SG-ZIVPN-RS-01 50 2 100`',
    { parse_mode: 'Markdown' }
  );
});

//handler addserver zivpn
bot.action('add_server_zivpn', async (ctx) => {
  userState[ctx.chat.id] = {
    step: 'add_server_domain',
    service: 'zivpn',
    data: {}
  };
  await ctx.reply('🌐 Masukkan domain server ZIVPN:', { parse_mode: 'Markdown' });
});

// Handler untuk info tools reseller
bot.action('reseller_tools_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        '🛡️ *TOOLS RESELLER*\n\n' +
        'Fitur khusus untuk reseller:\n' +
        '• ❌ Hapus Akun - Hapus akun pelanggan\n' +
        '• 🗝️ Kunci Akun - Nonaktifkan akun sementara\n' +
        '• 🔐 Buka Kunci Akun - Aktifkan kembali akun\n\n' +
        'Fitur ini membantu Anda mengelola akun pelanggan dengan lebih baik.',
        { parse_mode: 'Markdown' }
    );
});

// CEK SERVER - LIST SERVER
bot.action('cek_server', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, rows) => {
      if (err) {
        logger.error('Gagal mengambil data server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengambil data server.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Belum ada server yang ditambahkan.');
      }

      const todayYmd = formatDateYmdLocal(new Date());
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowYmd = formatDateYmdLocal(tomorrowDate);

      const groupMap = new Map();
      for (const srv of rows) {
        const key = normalizeSyncHost(srv.sync_host || srv.domain) || ('id-' + srv.id);
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(srv);
      }

      const forecastByGroup = new Map();
      for (const [key, groupServers] of groupMap.entries()) {
        const primary = groupServers[0];
        const syncAuth = String(groupServers.find((s) => String(s.auth || '').trim())?.auth || '').trim();
        const syncPort = Number(groupServers.find((s) => Number(s.sync_port) > 0)?.sync_port || primary.sync_port) || 8789;
        const syncEndpoint = normalizeSyncEndpoint(groupServers.find((s) => String(s.sync_endpoint || '').trim())?.sync_endpoint || primary.sync_endpoint);
        const requestServer = { ...primary, auth: syncAuth || primary.auth, sync_port: syncPort, sync_endpoint: syncEndpoint };

        try {
          const expiry = await fetchTunnelExpirySummaryByDate(requestServer, todayYmd);
          forecastByGroup.set(key, { ok: true, releaseTomorrow: Number(expiry.totalExpired || 0) });
        } catch (syncErr) {
          forecastByGroup.set(key, { ok: false, message: syncErr.message });
        }
      }

      let totalSisaSekarang = 0;
      let totalPrediksiBesok = 0;
      let totalKapasitas = 0;
      let totalTerpakai = 0;
      let serverUnlimited = 0;
      let serverPrediksiGagal = 0;

      const lines = [];
      const grouped = Array.from(groupMap.entries()).map(([groupKey, groupServers]) => ({
        groupKey,
        primary: groupServers[0],
        groupServers
      }));

      grouped.forEach((item, idx) => {
        const { groupKey, primary, groupServers } = item;
        const total = Number(primary.total_create_akun || 0);
        const positiveBatas = groupServers
          .map((s) => Number(s.batas_create_akun || 0))
          .filter((v) => Number.isFinite(v) && v > 0);
        const batasManual = positiveBatas.length > 0 ? Math.max(...positiveBatas) : 0;
        const bandwidthLimitTb = groupServers
          .map((s) => Number(s.bandwidth_limit_tb || 0))
          .filter((v) => Number.isFinite(v) && v > 0)
          .reduce((max, cur) => Math.max(max, cur), 0);
        const fallbackPerUserDailyGb = groupServers
          .map((s) => Number(s.bandwidth_user_daily_gb || 0))
          .filter((v) => Number.isFinite(v) && v > 0)
          .reduce((max, cur) => Math.max(max, cur), 8);
        const capacity = calculateServerEffectiveCapacity({
          usedAccounts: total,
          manualLimit: batasManual,
          bandwidthLimitTb,
          dailyBandwidthGb: Number(primary.bandwidth_daily_gb || 0),
          fallbackPerUserDailyGb,
          monthUsedTb: Number(primary.bandwidth_monthly_used_tb || 0)
        });
        const hasManualLimit = Number.isFinite(batasManual) && batasManual > 0;
        const batasManualText = hasManualLimit ? String(batasManual) : 'Unlimited';
        const sisaManual = hasManualLimit ? Math.max(0, batasManual - total) : 0;
        const status = hasManualLimit && total >= batasManual ? 'Penuh' : 'Tersedia';
        const forecast = forecastByGroup.get(groupKey);

        let prediksiBesok = '-';
        let prediksiBesokNum = null;

        if (!hasManualLimit) {
          prediksiBesok = 'Unlimited';
          serverUnlimited += 1;
        } else if (forecast?.ok) {
          prediksiBesokNum = Math.max(0, sisaManual + Number(forecast.releaseTomorrow || 0));
          prediksiBesok = String(prediksiBesokNum);
        } else {
          prediksiBesok = '- (gagal ambil data expiry)';
          serverPrediksiGagal += 1;
        }

        if (hasManualLimit) {
          totalSisaSekarang += sisaManual;
          totalKapasitas += batasManual;
          totalTerpakai += total;
          if (prediksiBesokNum !== null) totalPrediksiBesok += prediksiBesokNum;
        }

        lines.push(
          `${idx + 1}. ${primary.nama_server || '-'}`,
          `- Domain: ${normalizeSyncHost(primary.sync_host || primary.domain) || '-'}`,
          `- Akun Terpakai: ${total}/${batasManualText}`,
          `- Sisa Akun Saat Ini: ${hasManualLimit ? sisaManual : 'Unlimited'}`,
          `- Bandwidth Hari Ini (raw): ${Number(primary.bandwidth_daily_gb || 0).toFixed(2)} GB`,
          `- Bandwidth Hari Ini (efektif): ${Number(capacity.effectiveDailyBandwidthGb || 0).toFixed(2)} GB`,
          `- Bandwidth Bulan Ini: ${Number(primary.bandwidth_monthly_used_tb || 0).toFixed(2)}/${bandwidthLimitTb > 0 ? bandwidthLimitTb.toFixed(2) : '-'} TB`,
          `- Proyeksi BW 30 Hari: ${capacity.hasBandwidthLimit ? capacity.projectedMonthlyTbFromToday.toFixed(2) + ' TB' : '-'}`,
          `- Batas Aman User (BW): ${capacity.hasBandwidthLimit ? capacity.estimatedCapacityByBandwidth : '-'}`,
          `- Estimasi Pemakaian/User/Hari: ${capacity.hasBandwidthLimit ? capacity.estimatedPerUserDailyGb.toFixed(3) + ' GB' : '-'}`,
          `- Risiko Over BW: ${capacity.hasBandwidthLimit && capacity.projectedMonthlyTbFromToday > bandwidthLimitTb ? 'YA' : 'TIDAK'}`,
          `- Prediksi Tersedia Besok: ${prediksiBesok}`,
          `- Status: ${status}`,
          `- Group Server: ${groupServers.length} baris server`,
          ''
        );
      });

      let message =
        `DAFTAR SERVER TERSEDIA\n\n` +
        `Prediksi slot besok (${tomorrowYmd}) dihitung dari akun yang expired hari ini (${todayYmd}).\n\n` +
        `RINGKASAN TOTAL\n` +
        `- Total akun terpakai saat ini: ${totalTerpakai}/${totalKapasitas}\n` +
        `- Total sisa akun saat ini: ${totalSisaSekarang}\n` +
        `- Total prediksi tersedia besok: ${totalPrediksiBesok}` +
        `${serverUnlimited > 0 ? ` (+ ${serverUnlimited} server unlimited)` : ''}` +
        `\n` +
        `${serverPrediksiGagal > 0 ? `- Catatan: ${serverPrediksiGagal} server gagal ambil data expiry\n` : ''}` +
        `\n` +
        lines.join('\n');

      const maxLen = 3800;
      const chunks = [];
      let chunk = '';
      for (const line of message.trim().split('\n')) {
        const candidate = chunk ? `${chunk}\n${line}` : line;
        if (candidate.length > maxLen) {
          if (chunk) chunks.push(chunk);
          if (line.length > maxLen) {
            for (let i = 0; i < line.length; i += maxLen) {
              chunks.push(line.slice(i, i + maxLen));
            }
            chunk = '';
          } else {
            chunk = line;
          }
        } else {
          chunk = candidate;
        }
      }
      if (chunk) chunks.push(chunk);

      for (const part of chunks) {
        await ctx.reply(part);
      }
    });
  } catch (error) {
    logger.error('Error di cek_server:', error.message);
    return ctx.reply('Terjadi kesalahan.');
  }
});

// === TUTORIAL PENGGUNAAN BOT ===
bot.action('tutorial_bot', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await sendTutorialMenu(ctx);
  } catch (err) {
    logger.error('❌ Error di tombol tutorial_bot:', err.message);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka tutorial.');
  }
});

bot.action(/tutorial_view_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const id = Number(ctx.match[1]);
  const row = await dbGetAsync(
    'SELECT id, title, content, enabled FROM tutorial_items WHERE id = ? AND enabled = 1',
    [id]
  ).catch((err) => {
    logger.error('Gagal mengambil tutorial:', err.message);
    return null;
  });

  if (!row) {
    return ctx.reply('Tutorial tidak ditemukan atau sedang nonaktif.');
  }

  const text =
    `<b>📘 ${escapeHtml(row.title)}</b>\n\n` +
    `${escapeHtml(row.content)}`;

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'tutorial_bot' }]] }
  });
});

bot.action('admin_tutorial_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }
  delete userState[ctx.chat.id];
  return sendAdminTutorialMenu(ctx);
});

bot.action('admin_tutorial_add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menambah tutorial.');
  }
  userState[ctx.chat.id] = { step: 'admin_tutorial_add_input' };
  return ctx.reply(
    'Kirim tutorial dengan format:\n' +
    'Nama Tutorial | isi tutorial atau link\n\n' +
    'Contoh link:\n' +
    'Cara TopUp | https://youtu.be/xxxx\n\n' +
    'Contoh teks:\n' +
    'Cara Buat Akun | Pilih Menu VPN lalu pilih Buat Akun.\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action(/admin_tutorial_preview_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  const id = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT * FROM tutorial_items WHERE id = ?', [id]).catch(() => null);
  if (!row) return ctx.reply('Tutorial tidak ditemukan.');

  const status = Number(row.enabled || 0) === 1 ? 'Aktif' : 'Nonaktif';
  const link = normalizeTutorialLink(row.content);
  const contentLabel = link ? `Link: ${link}` : `Teks:\n${row.content}`;
  return ctx.reply(
    `<b>Detail Tutorial</b>\n\n` +
    `ID: <code>${row.id}</code>\n` +
    `Nama: <b>${escapeHtml(row.title)}</b>\n` +
    `Status: ${status}\n\n` +
    `<code>${escapeHtml(contentLabel)}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'admin_tutorial_menu' }]] }
    }
  );
});

bot.action(/admin_tutorial_toggle_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  const id = Number(ctx.match[1]);
  const row = await dbGetAsync('SELECT id, enabled FROM tutorial_items WHERE id = ?', [id]).catch(() => null);
  if (!row) return ctx.reply('Tutorial tidak ditemukan.');

  const nextEnabled = Number(row.enabled || 0) === 1 ? 0 : 1;
  await dbRunAsync(
    'UPDATE tutorial_items SET enabled = ?, updated_at = ? WHERE id = ?',
    [nextEnabled, Date.now(), id]
  );
  return sendAdminTutorialMenu(ctx);
});

bot.action(/admin_tutorial_delete_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  const id = Number(ctx.match[1]);
  await dbRunAsync('DELETE FROM tutorial_items WHERE id = ?', [id]).catch((err) => {
    logger.error('Gagal hapus tutorial:', err.message);
  });
  return sendAdminTutorialMenu(ctx);
});

// === 🖼️ UPLOAD GAMBAR QRIS ===
bot.action('upload_qris', async (ctx) => {
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Kamu tidak punya izin untuk ini.');
  }

  await ctx.reply('📸 Kirim gambar QRIS yang ingin digunakan:');
  userState[adminId] = { step: 'upload_qris' };
});

// Saat admin mengirim foto QRIS
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId];
  if (!state || state.step !== 'upload_qris') return;

  const fileId = ctx.message.photo.pop().file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const filePath = runtimePath('qris.jpg');

  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));

  await ctx.reply('✅ Gambar QRIS berhasil diunggah!');
  logger.info('🖼️ QRIS image uploaded by admin');
  delete userState[adminId];
});
///////////////////////
bot.action('topup_manual', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const qrisPath = runtimePath('qris.jpg');

    const captionText =
      `📲 *Top Up Saldo Manual via QRIS*\n\n` +
      `💬 Silakan transfer menggunakan QRIS di atas.\n\n` +
      `Setelah transfer, kirim bukti pembayaran ke admin:\n` +
      `hubungi via WhatsApp: [Klik di sini](${getAdminWhatsappUrl() || '#'})\n` +
      `atau Telegram: \`${getAdminTelegramUsername()}\`\n\n` +
      `📝 *Kirim bukti pembayaran dan sertakan format pesan seperti ini:*\n` +
      `\`\`\`\nSaya sudah top up via QRIS min dan ini ID Telegram saya ${ctx.from.id}\n\`\`\`\n\n` +
      `_Pastikan nominal sesuai dengan saldo yang ingin ditambahkan._`;

    if (fs.existsSync(qrisPath)) {
      await ctx.replyWithPhoto(
        { source: qrisPath },
        {
          caption: captionText,
          parse_mode: 'Markdown',
        }
      );
    } else {
      await ctx.reply(`⚠️ QRIS belum diunggah oleh admin. Silakan hubungi ${getAdminTelegramUsername()}.`);
    }
  } catch (err) {
    logger.error('❌ Error di topup_manual:', err.message);
    ctx.reply('❌ Terjadi kesalahan saat menampilkan QRIS.');
  }
});

/////

// === 🗂️ BACKUP DATABASE DAN KIRIM KE ADMIN ===
bot.action('backup_db', async (ctx) => {
  try {
    const adminId = ctx.from.id;

    // Hanya admin yang bisa pakai
    if (!adminIds.includes(adminId)) {
      return ctx.reply('🚫 Kamu tidak memiliki izin untuk melakukan tindakan ini.');
    }

    const dbPath = runtimePath('sellvpn.db');
    if (!fs.existsSync(dbPath)) {
      return ctx.reply('⚠️ File database tidak ditemukan.');
    }

    // Kirim file sellvpn.db ke admin
    await ctx.replyWithDocument({ source: dbPath, filename: 'sellvpn.db' }, { 
      caption: '📦 Backup database berhasil dikirim!',
    });

    logger.info(`📤 Backup database dikirim ke admin ${adminId}`);
  } catch (error) {
    logger.error('❌ Gagal mengirim file backup ke admin:', error);
    ctx.reply('❌ Terjadi kesalahan saat mengirim file backup.');
  }
});

// === 💳 CEK SALDO USER ===
bot.action('cek_saldo_user', async (ctx) => {
  const adminId = ctx.from.id;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  await ctx.answerCbQuery();
  await ctx.reply('🔍 Masukkan ID Telegram user yang ingin dicek saldonya:');
  userState[adminId] = { step: 'cek_saldo_userid' };
});
///////////////

bot.action('jadi_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const userId = ctx.from.id;
  const terms = loadResellerTerms();
  const waUrl = getAdminWhatsappUrl();
  const username = ctx.from.username ? '@' + ctx.from.username : '-';
  const fullName = (ctx.from.first_name || '') + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');

  const autoMessage = encodeURIComponent(
    'Halo Admin, saya ingin daftar reseller VPN.\n\n' +
    'ID Telegram: ' + userId + '\n' +
    'Username: ' + username + '\n' +
    'Nama: ' + (fullName || '-') + '\n' +
    'Siap top up awal: ' + formatRupiah(terms.join_topup_min) + '\n\n' +
    'Mohon info langkah lanjutnya.'
  );

  const waAutoUrl = waUrl ? (waUrl + '?text=' + autoMessage) : null;

  const message =
    '*PROGRAM RESELLER VPN*\n\n' +
    'Naik level jadi reseller dan dapat harga akun lebih hemat untuk jual ulang.\n\n' +
    '*Benefit Reseller:*\n' +
    '- Harga akun lebih murah\n' +
    '- Bisa buat akun kapan saja\n' +
    '- Dukungan langsung dari admin\n' +
    '- Akses promo dan bonus reseller\n\n' +
    '*Syarat Bergabung:*\n' +
    '> Top up jadi reseller: *' + formatRupiah(terms.join_topup_min) + '* (langsung masuk Saldo VPN)\n' +
    '> Minimal top up bulanan: *' + formatRupiah(terms.min_topup) + '*\n\n' +
    '*Jika Tidak Memenuhi Minimal Top Up Bulanan:*\n' +
    '- Status reseller akan otomatis dinonaktifkan di akhir periode bulanan\n' +
    '- Harga reseller tidak berlaku sampai status reseller diaktifkan kembali\n\n' +
    '*Data Anda:*\n' +
    '- ID: ' + userId + '\n' +
    '- Username: ' + username + '\n\n' +
    (waUrl
      ? 'Klik tombol di bawah untuk topup jadi reseller (manual) via WhatsApp admin.'
      : 'Nomor WhatsApp admin belum diset. Silakan hubungi admin untuk aktivasi kontak.');

  const inlineKeyboard = [];
  inlineKeyboard.push([{ text: 'Topup Jadi Reseller', callback_data: 'reseller_join_topup' }]);
  if (waAutoUrl) {
    inlineKeyboard.push([{ text: 'Topup jadi reseller manual', url: waAutoUrl }]);
  }

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
});

bot.action('reseller_join_topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const alreadyReseller = await isUserReseller(ctx.from.id).catch(() => false);
  if (alreadyReseller) {
    return ctx.reply('Status Anda sudah reseller.');
  }

  if (!loadTopupAutoSetting()) {
    return ctx.reply('Topup otomatis sedang nonaktif. Silakan hubungi admin.');
  }

  const terms = loadResellerTerms();
  const minJoinTopup = Math.max(2000, Number(terms.join_topup_min) || 18000);
  const userId = ctx.from.id;
  if (!global.depositState) global.depositState = {};
  global.depositState[userId] = {
    action: 'request_amount',
    amount: '',
    topupPurpose: 'reseller_join',
    walletType: 'vpn',
    minAmount: minJoinTopup
  };

  return ctx.reply(
    'Topup Jadi Reseller\n\n' +
      `Minimal topup: ${formatRupiah(minJoinTopup)}\n` +
      'Nominal topup harus sama atau lebih besar dari minimal tersebut.\n\n' +
      'Silakan masukkan jumlah topup:',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard_nomor() }
    }
  );
});

///////
bot.action('tambah_saldo', async (ctx) => {
  const adminId = ctx.from.id;

  // Pastikan hanya admin
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin untuk menggunakan menu ini.');
  }

  userState[adminId] = { step: 'addsaldo_userid' };
  await ctx.reply('🆔 Masukkan ID Telegram user yang ingin ditambah saldonya:');
});

////////

bot.action('sendMainMenu', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await sendMainMenu(ctx);
  } catch (error) {
    console.error('❌ Error saat kembali ke menu utama:', error);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka menu utama.');
  }
});

bot.action('addserver_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  userState[ctx.chat.id] = { step: 'addserver_reseller' };
  await ctx.reply(
    '🪄 Silakan kirim data server reseller dengan format:\n\n' +
    '/addserver_reseller <domain> <auth> <harga_user_1ip> <harga_user_2ip> <harga_reseller_1ip> <harga_reseller_2ip> <nama_server> <quota> <iplimit> <batas_create_akun>\n\n' +
    'Format lama (7 argumen) masih bisa, semua harga akan disamakan.'
  );
});

bot.action('service_trial', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'trial');
});

bot.action('service_create', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'create');
});

bot.action('service_renew', async (ctx) => {
  if (!ctx) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await ctx.answerCbQuery().catch(() => {});
  userState[ctx.chat.id] = userState[ctx.chat.id] || {};
  userState[ctx.chat.id].step = 'renew_lookup_username';
  await ctx.reply(
    'Masukkan username akun yang ingin diperpanjang.\n' +
    'Ketik `batal` untuk membatalkan.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('service_del', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'del');
});

bot.action('service_lock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'lock');
});

bot.action('service_unlock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  } 
  await handleServiceAction(ctx, 'unlock');
});

const { exec, execSync } = require('child_process');

bot.action('cek_service', async (ctx) => {
  try {
    const resselDbPath = './ressel.db';
    const idUser = ctx.from.id.toString().trim();

    // 🔍 Cek apakah user termasuk reseller
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        console.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }

      // ✅ Jika reseller, lanjut jalankan cek service
      const message = await ctx.reply('⏳ Sedang mengecek status server...');

      exec('chmod +x cek-port.sh && bash cek-port.sh', (error, stdout, stderr) => {
        if (error) {
          console.error(`Gagal menjalankan skrip: ${error.message}`);
          return ctx.reply('❌ Terjadi kesalahan saat menjalankan pengecekan.');
        }

        if (stderr) {
          console.error(`Error dari skrip: ${stderr}`);
          return ctx.reply('❌ Ada output error dari skrip pengecekan.');
        }

        // Bersihkan kode warna ANSI agar output rapi
        const cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, '');

        ctx.reply(`📡 *Hasil Cek Port:*\n\n\`\`\`\n${cleanOutput}\n\`\`\``, {
          parse_mode: 'Markdown'
        });
      });
    });
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Gagal menjalankan pengecekan server.');
  }
});

bot.action('send_main_menu', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await sendMainMenu(ctx);
});

bot.action('ppob_menu', async (ctx) => sendPpobMenu(ctx));
bot.action('ppob_refresh', async (ctx) => sendPpobMenu(ctx, { forceRefresh: true }));
bot.action('ppob_history', async (ctx) => sendPpobHistory(ctx));
bot.action(/^ppob_cat_page_(\d+)$/, async (ctx) => sendPpobMenu(ctx, { page: Number(ctx.match[1]) }));
bot.action(/^ppob_cat_(\d+)$/, async (ctx) => sendPpobBrands(ctx, ctx.match[1]));
bot.action(/^ppob_brand_page_(\d+)$/, async (ctx) => {
  const state = userState[ctx.chat.id] || {};
  const categoryIndex = state.ppobCatalog?.categories?.indexOf(state.ppobCategory);
  return sendPpobBrands(ctx, categoryIndex >= 0 ? categoryIndex : 0, Number(ctx.match[1]));
});
bot.action(/^ppob_brand_(\d+)$/, async (ctx) => sendPpobTypes(ctx, ctx.match[1]));
bot.action(/^ppob_type_page_(\d+)$/, async (ctx) => {
  const state = userState[ctx.chat.id] || {};
  const brandIndex = state.ppobBrands?.indexOf(state.ppobBrand);
  return sendPpobTypes(ctx, brandIndex >= 0 ? brandIndex : 0, Number(ctx.match[1]));
});
bot.action(/^ppob_type_(\d+)$/, async (ctx) => sendPpobProducts(ctx, ctx.match[1]));
bot.action(/^ppob_page_(\d+)$/, async (ctx) => sendPpobProducts(ctx, 'page', Number(ctx.match[1])));
bot.action(/^ppob_product_(\d+)$/, async (ctx) => sendPpobProductDetail(ctx, ctx.match[1]));
bot.action(/^ppob_no_(\d|del|clear|ok)$/, async (ctx) => {
  const state = userState[ctx.chat.id] || {};
  if (state.step !== 'ppob_customer_no' || !state.ppobSelectedProduct) {
    await ctx.answerCbQuery('Sesi PPOB tidak valid.').catch(() => {});
    return sendPpobMenu(ctx);
  }

  const action = ctx.match[1];
  let draft = String(state.ppobCustomerNoDraft || '');
  if (/^\d$/.test(action)) {
    if (draft.length >= 64) {
      await ctx.answerCbQuery('Nomor terlalu panjang.').catch(() => {});
      return;
    }
    draft += action;
  } else if (action === 'del') {
    draft = draft.slice(0, -1);
  } else if (action === 'clear') {
    draft = '';
  } else if (action === 'ok') {
    const customerNo = normalizePpobCustomerNo(draft, state.ppobSelectedProduct);
    if (!customerNo) {
      const invalidText = getPpobCustomerNoInvalidText(state.ppobSelectedProduct);
      await ctx.answerCbQuery(invalidText.slice(0, 180), { show_alert: true }).catch(() => {});
      return sendPpobCustomerNoInput(ctx, state.ppobSelectedProduct, draft, invalidText);
    }
    return sendPpobPurchaseConfirmation(ctx, customerNo);
  }

  userState[ctx.chat.id] = {
    ...state,
    ppobCustomerNoDraft: draft
  };
  return sendPpobCustomerNoInput(ctx, state.ppobSelectedProduct, draft);
});
bot.action('ppob_confirm', async (ctx) => {
  await ctx.answerCbQuery('Memproses...').catch(() => {});
  return confirmPpobPurchase(ctx);
});
bot.action('ppob_cancel', async (ctx) => {
  delete userState[ctx.chat.id];
  await ctx.answerCbQuery('Dibatalkan').catch(() => {});
  return sendPpobMenu(ctx);
});
bot.action(/^ppob_check_(\d+)$/, async (ctx) => checkPpobOrderStatus(ctx, ctx.match[1]));

bot.action('ppob_admin_menu', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  return sendPpobAdminMenu(ctx);
});

bot.action('ppob_admin_toggle_enabled', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  savePpobRuntimeVars({ PPOB_ENABLED: !PPOB_ENABLED });
  await ctx.answerCbQuery(PPOB_ENABLED ? 'PPOB diaktifkan.' : 'PPOB dinonaktifkan.').catch(() => {});
  return sendPpobAdminMenu(ctx);
});

bot.action('ppob_admin_set_username', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_username_input' };
  return ctx.reply('Kirim username Digiflazz.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_api_key', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_api_key_input' };
  return ctx.reply('Kirim API key Digiflazz.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_base_url', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_base_url_input' };
  return ctx.reply('Kirim base URL Digiflazz.\nDefault: https://api.digiflazz.com\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_fee', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_fee_input' };
  return ctx.reply('Kirim fee/markup PPOB dalam rupiah.\nContoh: 1000\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_notif_group', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_notif_group_input' };
  return ctx.reply('Kirim GROUP ID untuk notif umum transaksi/topup PPOB.\nContoh: -1001234567890\nKirim 0 untuk menghapus.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_admin_group', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_detail_group_input' };
  return ctx.reply('Kirim GROUP ID khusus admin untuk detail transaksi PPOB dan warning saldo Digiflazz.\nContoh: -1001234567890\nKirim 0 untuk menghapus.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_set_digi_threshold', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_digi_threshold_input' };
  return ctx.reply('Kirim batas warning saldo Digiflazz dalam rupiah.\nDefault: 100000\nKirim 0 untuk mematikan warning.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_toggle_cutoff', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  savePpobRuntimeVars({ PPOB_CUTOFF_ENABLED: !PPOB_CUTOFF_ENABLED });
  return sendPpobAdminMenu(ctx);
});

bot.action('ppob_admin_set_cutoff', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_cutoff_input' };
  return ctx.reply(
    [
      'Kirim jam cut off PPOB.',
      'Format: 23:30-01:15',
      '',
      'Ketik "batal" untuk membatalkan.'
    ].join('\n')
  );
});

bot.action('ppob_admin_toggle_autosync', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  savePpobRuntimeVars({ PPOB_AUTOSYNC_ENABLED: !PPOB_AUTOSYNC_ENABLED });
  return sendPpobAdminMenu(ctx);
});

bot.action('ppob_admin_set_autosync_time', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_autosync_time_input' };
  return ctx.reply(
    [
      'Kirim jam auto sync produk PPOB.',
      'Format 24 jam: 00:05',
      '',
      'Default: 00:05 WIB (12:05 malam).',
      'Ketik "batal" untuk membatalkan.'
    ].join('\n')
  );
});

bot.action('ppob_admin_check_digi_balance', async (ctx) => {
  await ctx.answerCbQuery('Cek saldo Digi...').catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const result = await getDigiflazzBalanceSafe();
  if (!result.ok) {
    return ctx.reply(`Gagal cek saldo Digiflazz: ${result.error}`);
  }
  const warningResult = await warnLowDigiflazzBalanceIfNeeded(result.balance, 'Cek manual admin');
  return ctx.reply(
    [
      '<b>SALDO DIGIFLAZZ</b>',
      '',
      'Provider: <b>Digiflazz Sendiri</b>',
      `Saldo: <b>${formatRupiah(result.balance)}</b>`,
      `Batas warning: <b>${formatRupiah(PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD)}</b>`,
      warningResult?.sent
        ? `Warning: <b>terkirim</b> ke <code>${escapeHtml(warningResult.groupId)}</code>`
        : `Warning: <b>tidak dikirim</b> (${escapeHtml(warningResult?.reason || '-')})`
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_menu' }]] } }
  );
});

bot.action('ppob_admin_balance_menu', async (ctx) => sendPpobAdminBalanceMenu(ctx));

bot.action('ppob_admin_balance_add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_balance_add_user' };
  return ctx.reply('Kirim ID Telegram user yang akan ditambah saldo PPOB.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_balance_remove', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_balance_remove_user' };
  return ctx.reply('Kirim ID Telegram user yang saldo PPOB-nya akan dihapus.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_balance_set', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_balance_set_user' };
  return ctx.reply('Kirim ID Telegram user yang saldo PPOB-nya akan diset.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_balance_check', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_balance_check_user' };
  return ctx.reply('Kirim ID Telegram user yang akan dicek saldo PPOB-nya.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_balance_history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  userState[ctx.chat.id] = { step: 'ppob_admin_balance_history_user' };
  return ctx.reply('Kirim ID Telegram user untuk melihat riwayat saldo/transaksi PPOB.\nKetik "batal" untuk membatalkan.');
});

bot.action('ppob_admin_refresh_catalog', async (ctx) => {
  await ctx.answerCbQuery('Sync produk...').catch(() => {});
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  try {
    const sync = await syncPpobProductsFromDigiflazz();
    const catalog = await ppobLoadCatalogFromDb();
    const visibleCatalog = ppobApplyVisibilityFilter(catalog);
    return ctx.reply(
      [
        '<b>SYNC PRODUK PPOB SELESAI</b>',
        '',
        `Produk diterima Digiflazz: <b>${sync.fetched}</b>`,
        `Produk aktif di DB: <b>${catalog.products.length}</b>`,
        `Produk tampil ke user: <b>${visibleCatalog.products.length}</b>`,
        `Produk lama dinonaktifkan: <b>${sync.deactivated}</b>`,
        `Kategori: <b>${catalog.categories.length}</b>`,
        `Brand: <b>${catalog.brands.length}</b>`,
        `Type: <b>${catalog.types.length}</b>`,
        `Waktu sync: <b>${escapeHtml(formatPpobLastSync(sync.syncedAt))}</b>`
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_menu' }]] }
      }
    );
  } catch (err) {
    logger.error('Gagal sync produk PPOB:', err.message);
    return ctx.reply(`Gagal sync produk PPOB: ${err.message}`);
  }
});

bot.action('ppob_admin_clear_filters', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  savePpobRuntimeVars({
    PPOB_DISABLED_CATEGORIES: [],
    PPOB_DISABLED_BRANDS: [],
    PPOB_DISABLED_TYPES: [],
    PPOB_DISABLED_SKUS: []
  });
  await ctx.answerCbQuery('Semua filter PPOB direset.').catch(() => {});
  return sendPpobAdminMenu(ctx);
});

bot.action(/^ppob_admin_list_(category|brand|type|sku)$/, async (ctx) => (
  sendPpobAdminDimensionMenu(ctx, ctx.match[1], 0)
));

bot.action(/^ppob_admin_page_(category|brand|type|sku)_(\d+)$/, async (ctx) => (
  sendPpobAdminDimensionMenu(ctx, ctx.match[1], Number(ctx.match[2]))
));

bot.action(/^ppob_admin_refresh_(category|brand|type|sku)_(\d+)$/, async (ctx) => (
  sendPpobAdminDimensionMenu(ctx, ctx.match[1], Number(ctx.match[2]), { forceRefresh: true })
));

bot.action(/^ppob_admin_toggle_(category|brand|type|sku)_(\d+)$/, async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Anda tidak memiliki izin.');
  const kind = ctx.match[1];
  const index = Number(ctx.match[2]);
  const state = userState[ctx.chat.id] || {};
  let items = state.ppobAdminKind === kind && Array.isArray(state.ppobAdminItems)
    ? state.ppobAdminItems
    : [];
  if (!items.length) {
    const catalog = await ppobLoadCatalogFromDb();
    items = getPpobAdminItems(catalog, kind);
  }
  const item = items[index];
  if (!item) {
    await ctx.answerCbQuery('Item tidak ditemukan.').catch(() => {});
    return sendPpobAdminDimensionMenu(ctx, kind, state.ppobAdminPage || 0);
  }
  const nowDisabled = togglePpobDisabledValue(kind, item.value);
  await ctx.answerCbQuery(nowDisabled ? 'Item dinonaktifkan.' : 'Item diaktifkan.').catch(() => {});
  return sendPpobAdminDimensionMenu(ctx, kind, state.ppobAdminPage || Math.floor(index / PPOB_ADMIN_PAGE_SIZE));
});

bot.action('trial_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vmess');
});

bot.action('trial_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vless');
});

bot.action('trial_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'trojan');
});

bot.action('trial_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'shadowsocks');
});

bot.action('trial_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'ssh');
});

bot.action('trial_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'udp_http');
});


bot.action('create_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vmess');
});

bot.action('create_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vless');
});

bot.action('create_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'trojan');
});

bot.action('create_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'shadowsocks');
});

bot.action('create_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'ssh');
});

bot.action('create_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'udp_http');
});

////
bot.action('create_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'create', 'zivpn');
});
///
bot.action('trial_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'trial', 'zivpn');
});
////
//DELETE SSH
bot.action('del_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'ssh');
});

bot.action('del_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'udp_http');
});

bot.action('del_zivpn', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'zivpn');
});

bot.action('del_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vmess');
});

bot.action('del_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vless');
});

bot.action('del_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'trojan');
});
//DELETE BREAK

//LOCK
bot.action('lock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'ssh');
});

bot.action('lock_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'udp_http');
});

bot.action('lock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vmess');
});

bot.action('lock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vless');
});

bot.action('lock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'trojan');
});
//LOCK BREAK
//UNLOCK
bot.action('unlock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'ssh');
});

bot.action('unlock_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'udp_http');
});

bot.action('unlock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vmess');
});

bot.action('unlock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vless');
});

bot.action('unlock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'trojan');
});
//UNLOCK BREAK

bot.action('renew_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vmess');
});

bot.action('renew_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vless');
});

bot.action('renew_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'trojan');
});

bot.action('renew_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'shadowsocks');
});

bot.action('renew_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'ssh');
});

bot.action('renew_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'udp_http');
});

bot.action('renew_zivpn', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'zivpn');
});
async function startSelectServer(ctx, action, type, page = 0) {

try {
  const isR = await isUserReseller(ctx.from.id);
  const filters = [];
  const params = [];

  filters.push('COALESCE(is_active, 1) = 1');
  const protocolSupport = getServerProtocolSupport(type);
  if (protocolSupport) {
    filters.push(`COALESCE(${protocolSupport.column}, ${protocolSupport.defaultEnabled}) = 1`);
  }
  if (!isR) {
    // user biasa hanya bisa lihat server publik/non-reseller
    filters.push('(is_reseller_only = 0 OR is_reseller_only IS NULL)');
  }

 
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const query = `SELECT * FROM Server ${whereClause} ORDER BY nama_server COLLATE NOCASE ASC`;

db.all(query, params, async (err, servers) => {
  if (err) {
    logger.error('⚠️ Error fetching servers:', err.message);
    return ctx.reply('⚠️ Tidak ada server yang tersedia saat ini.', { parse_mode: 'HTML' });
  }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server aktif yang tersedia saat ini.', { parse_mode: 'Markdown' });
    }
    // ==== mulai logika pagination di bawah ini ====
    const serversPerPage = 6;
    const totalPages = Math.ceil(servers.length / serversPerPage);
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const end = start + serversPerPage;
    const currentServers = servers.slice(start, end);

    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const server1 = currentServers[i];
      const server2 = currentServers[i + 1];
      row.push({ text: server1.nama_server, callback_data: `${action}_username_${type}_${server1.id}` });
      if (server2) {
        row.push({ text: server2.nama_server, callback_data: `${action}_username_${type}_${server2.id}` });
      }
      keyboard.push(row);
    }

    const navButtons = [];
    if (totalPages > 1) {
      if (currentPage > 0) {
        navButtons.push({ text: '⬅️ Back', callback_data: `navigate_${action}_${type}_${currentPage - 1}` });
      }
      if (currentPage < totalPages - 1) {
        navButtons.push({ text: 'Lihat server selanjutnya ➡️ Next', callback_data: `navigate_${action}_${type}_${currentPage + 1}` });
      }
    }
    if (navButtons.length > 0) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'sendMainMenu' }]);

const serverBlocks = currentServers.map(server => {
  const hargaPerHari1 = getEffectiveServerPackagePrice(server, isR, 1);
  const hargaPerHari2 = getEffectiveServerPackagePrice(server, isR, 2);
  const hargaPer30Hari1 = getEffectiveServerMonthlyPackagePrice(server, isR, 1);
  const hargaPer30Hari2 = getEffectiveServerMonthlyPackagePrice(server, isR, 2);
  const dailyEnabled = isServerDailyPriceEnabled(server);
  const monthlyEnabled = isServerMonthlyPriceEnabled(server);
  const priceLines = [];
  if (dailyEnabled) {
    priceLines.push(`💳 *Harga/Hari 1IP:* Rp${hargaPerHari1.toLocaleString('id-ID')}`);
    priceLines.push(`💳 *Harga/Hari 2IP:* Rp${hargaPerHari2.toLocaleString('id-ID')}`);
  }
  if (monthlyEnabled) {
    priceLines.push(`📆 *Harga/30 Hari 1IP:* Rp${hargaPer30Hari1.toLocaleString('id-ID')}`);
    priceLines.push(`📆 *Harga/30 Hari 2IP:* Rp${hargaPer30Hari2.toLocaleString('id-ID')}`);
  }
  if (!priceLines.length) {
    priceLines.push('💳 *Harga:* Nonaktif');
  }
  const capacity = calculateServerEffectiveCapacity({
    usedAccounts: server.total_create_akun,
    manualLimit: server.batas_create_akun,
    bandwidthLimitTb: server.bandwidth_limit_tb,
    dailyBandwidthGb: server.bandwidth_daily_gb,
    fallbackPerUserDailyGb: server.bandwidth_user_daily_gb,
    monthUsedTb: server.bandwidth_monthly_used_tb
  });
  const manualLimit = Number(server.batas_create_akun || 0);
  const isManualUnlimited = !(Number.isFinite(manualLimit) && manualLimit > 0);
  const akunLimitText = isManualUnlimited ? 'Unlimited' : String(manualLimit);
  const isFullByManualLimit = !isManualUnlimited && Number(server.total_create_akun || 0) >= manualLimit;

  return (
`╔══════════════════╗
*${server.nama_server.toUpperCase()}*
╚══════════════════╝
╔══════════════════╗
${priceLines.join('\n')}
╚══════════════════╝
🛜 *Domain:* \`${server.domain}\`
📡 *Quota/Hari:* ${server.quota} GB
👥 *Akun Terpakai:* ${server.total_create_akun}/${akunLimitText}
📌 *Status:* ${isFullByManualLimit ? "❌ Server Penuh" : "✅ Tersedia"}`
  );
});
    const title = `📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages})*`;
    const maxLen = 3800;
    const chunks = [];
    let chunk = `${title}\n\n`;
    for (const block of serverBlocks) {
      const next = chunk.length > title.length + 2 ? `${chunk}\n\n${block}` : `${chunk}${block}`;
      if (next.length > maxLen) {
        chunks.push(chunk);
        chunk = `${title}\n\n${block}`;
      } else {
        chunk = next;
      }
    }
    if (chunk.trim()) chunks.push(chunk);

    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(chunks[0], {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.reply(chunks[0], {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }

    if (chunks.length > 1) {
      for (let i = 1; i < chunks.length; i += 1) {
        await ctx.reply(chunks[i], { parse_mode: 'Markdown' });
      }
    }

    userState[ctx.chat.id] = { step: `${action}_username_${type}`, page: currentPage };
  });
} catch (error) {
  logger.error(`❌ Error saat memulai proses ${action} untuk ${type}:`, error);
  await ctx.reply(`❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan.`, { parse_mode: 'Markdown' });
}
}

bot.action(/navigate_([^_]+)_(.+)_(\d+)/, async (ctx) => {
  const [, action, type, page] = ctx.match;
  await startSelectServer(ctx, action, type, parseInt(page, 10));
});


bot.action(/(create|renew)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];
  userState[ctx.chat.id] = action === 'create'
    ? { step: 'select_create_package', serverId, type, action }
    : { step: `username_${action}_${type}`, serverId, type, action };

  db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('⚠️ Error fetching server details:', err.message);
      return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
    }

    if (!server) {
      return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    if (Number(server.is_active ?? 1) !== 1) {
      delete userState[ctx.chat.id];
      return ctx.reply('❌ *Server ini sedang nonaktif dan tidak bisa dipilih.*', { parse_mode: 'Markdown' });
    }
    if (!isServerProtocolEnabled(server, type)) {
      delete userState[ctx.chat.id];
      return ctx.reply(`❌ *Protocol ${type.toUpperCase()} sedang nonaktif untuk server ini.*`, { parse_mode: 'Markdown' });
    }

    const batasCreateAkun = Number(server.batas_create_akun || 0);
    const totalCreateAkun = Number(server.total_create_akun || 0);
    const hasManualLimit = Number.isFinite(batasCreateAkun) && batasCreateAkun > 0;
    if (action === 'create' && hasManualLimit && totalCreateAkun >= batasCreateAkun) {
      delete userState[ctx.chat.id];
      return ctx.reply('❌ *Server penuh. Tidak dapat membuat akun baru di server ini.*', { parse_mode: 'Markdown' });
    }

    if (action === 'create') {
      const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
      const harga1 = getEffectiveServerPackagePrice(server, isReseller, 1);
      const harga2 = getEffectiveServerPackagePrice(server, isReseller, 2);
      const harga30_1 = getEffectiveServerMonthlyPackagePrice(server, isReseller, 1);
      const harga30_2 = getEffectiveServerMonthlyPackagePrice(server, isReseller, 2);
      const dailyEnabled = isServerDailyPriceEnabled(server);
      const monthlyEnabled = isServerMonthlyPriceEnabled(server);

      if (!dailyEnabled && !monthlyEnabled) {
        return ctx.reply('❌ *Harga pembuatan akun di server ini sedang nonaktif.*', { parse_mode: 'Markdown' });
      }

      const packageLabel = (pkg, dailyPrice, monthlyPrice) => {
        const parts = [];
        if (dailyEnabled) parts.push(`Harian Rp ${dailyPrice.toLocaleString('id-ID')}`);
        if (monthlyEnabled) parts.push(`30H Rp ${monthlyPrice.toLocaleString('id-ID')}`);
        return `Paket ${pkg}IP - ${parts.join(' | ')}`;
      };

      const packageLines = [];
      packageLines.push(
        `- Paket 1IP: ${dailyEnabled ? `Harian Rp ${harga1.toLocaleString('id-ID')}` : ''}` +
        `${dailyEnabled && monthlyEnabled ? ' | ' : ''}` +
        `${monthlyEnabled ? `30 Hari Rp ${harga30_1.toLocaleString('id-ID')}` : ''}`
      );
      packageLines.push(
        `- Paket 2IP: ${dailyEnabled ? `Harian Rp ${harga2.toLocaleString('id-ID')}` : ''}` +
        `${dailyEnabled && monthlyEnabled ? ' | ' : ''}` +
        `${monthlyEnabled ? `30 Hari Rp ${harga30_2.toLocaleString('id-ID')}` : ''}`
      );

      const keyboard = [
        [{ text: packageLabel(1, harga1, harga30_1), callback_data: `create_pkg_${type}_${serverId}_1` }],
        [{ text: packageLabel(2, harga2, harga30_2), callback_data: `create_pkg_${type}_${serverId}_2` }],
        [{ text: '⬅️ Kembali', callback_data: 'sendMainMenu' }]
      ];

      await ctx.reply(
        `Pilih paket IP untuk server:\n`+
        `*${server.nama_server || server.domain}*:\n\n` +
        `${packageLines[0]}\n`+
        `Maksimal dipake 1 orang atau 1 device(hp), lebih dari itu akun akan *otomatis expired dan disconnect*!!\n\n` +
        `${packageLines[1]}\n`+
        `Maksimal dipake 2 orang atau 2 device(hp), lebih dari itu akun akan *otomatis expired dan disconnect*!!\n\n`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      );
    } else {
      await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
    }
  });
});

// Paket IP (create)
bot.action(/create_pkg_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(\d+)_(1|2)/, async (ctx) => {
  const type = ctx.match[1];
  const serverId = ctx.match[2];
  const ipPkg = parseInt(ctx.match[3], 10) === 2 ? 2 : 1;

  const server = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [serverId]).catch(() => null);
  if (!server) {
    return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
  }
  if (Number(server.is_active ?? 1) !== 1) {
    return ctx.reply('❌ *Server ini sedang nonaktif dan tidak bisa dipilih.*', { parse_mode: 'Markdown' });
  }
  if (!isServerProtocolEnabled(server, type)) {
    return ctx.reply(`❌ *Protocol ${type.toUpperCase()} sedang nonaktif untuk server ini.*`, { parse_mode: 'Markdown' });
  }

  const isReseller = await isUserReseller(ctx.from.id).catch(() => false);
  const dailyEnabled = isServerDailyPriceEnabled(server);
  const monthlyEnabled = isServerMonthlyPriceEnabled(server);

  if (!dailyEnabled && !monthlyEnabled) {
    return ctx.reply('❌ *Harga pembuatan akun di server ini sedang nonaktif.*', { parse_mode: 'Markdown' });
  }

  if (dailyEnabled && monthlyEnabled) {
    const dailyPrice = getEffectiveServerPackagePrice(server, isReseller, ipPkg);
    const monthlyPrice = getEffectiveServerMonthlyPackagePrice(server, isReseller, ipPkg);
    await ctx.reply(
      `Pilih masa aktif untuk paket ${ipPkg}IP:\n` +
      `- Harian: Rp ${dailyPrice.toLocaleString('id-ID')} / hari\n` +
      `- 30 Hari: Rp ${monthlyPrice.toLocaleString('id-ID')} / 30 hari`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `Harian - Rp ${dailyPrice.toLocaleString('id-ID')}/hari`, callback_data: `create_price_mode_${type}_${serverId}_${ipPkg}_daily` }],
            [{ text: `30 Hari - Rp ${monthlyPrice.toLocaleString('id-ID')}`, callback_data: `create_price_mode_${type}_${serverId}_${ipPkg}_30hari` }],
            [{ text: '⬅️ Kembali', callback_data: `create_${type}` }]
          ]
        }
      }
    );
    return;
  }

  const priceMode = monthlyEnabled ? '30hari' : 'daily';
  userState[ctx.chat.id] = {
    step: `username_create_${type}`,
    serverId,
    type,
    action: 'create',
    selectedIpPackage: ipPkg,
    priceMode
  };

  await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
});

bot.action(/create_price_mode_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(\d+)_(1|2)_(daily|30hari)/, async (ctx) => {
  const type = ctx.match[1];
  const serverId = ctx.match[2];
  const ipPkg = parseInt(ctx.match[3], 10) === 2 ? 2 : 1;
  const priceMode = normalizeCreatePriceMode(ctx.match[4]);

  const server = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [serverId]).catch(() => null);
  if (!server) {
    return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
  }
  if (Number(server.is_active ?? 1) !== 1) {
    return ctx.reply('❌ *Server ini sedang nonaktif dan tidak bisa dipilih.*', { parse_mode: 'Markdown' });
  }
  if (!isServerProtocolEnabled(server, type)) {
    return ctx.reply(`❌ *Protocol ${type.toUpperCase()} sedang nonaktif untuk server ini.*`, { parse_mode: 'Markdown' });
  }
  if (priceMode === 'daily' && !isServerDailyPriceEnabled(server)) {
    return ctx.reply('❌ *Harga harian sedang nonaktif untuk server ini.*', { parse_mode: 'Markdown' });
  }
  if (priceMode === '30hari' && !isServerMonthlyPriceEnabled(server)) {
    return ctx.reply('❌ *Harga 30 hari sedang nonaktif untuk server ini.*', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = {
    step: `username_create_${type}`,
    serverId,
    type,
    action: 'create',
    selectedIpPackage: ipPkg,
    priceMode
  };

  await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
});

// === ⚡️ KONFIRMASI TRIAL (semua tipe) ===
bot.action(/(trial)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(\d+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  // Ambil nama server dari database
  db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('❌ Gagal mengambil data server:', err.message);
      return ctx.reply('⚠️ Terjadi kesalahan saat mengambil data server.');
    }

    if (!server) {
      return ctx.reply('⚠️ Server tidak ditemukan di database.');
    }

    if (Number(server.is_active ?? 1) !== 1) {
      return ctx.reply('⚠️ Server ini sedang nonaktif dan tidak bisa dipilih.');
    }
    if (!isServerProtocolEnabled(server, type)) {
      return ctx.reply(`⚠️ Protocol ${type.toUpperCase()} sedang nonaktif untuk server ini.`);
    }

    // Simpan state seperti semula
    userState[ctx.chat.id] = {
      step: `username_${action}_${type}`,
      serverId, type, action,
      serverName: server.nama_server || server.domain
    };

    // Pesan konfirmasi seperti versi lama, tapi pakai nama server
    await ctx.reply(
      `⚠️ *PERHATIAN*\n\n` +
      `Anda sedang membuat akun *TRIAL ${type.toUpperCase()}* di server *${server.nama_server || server.domain}*.\n\n` +
      `Layanan trial aktif selama *${TRIAL_TIMELIMIT}* dan bandwidth dibatasi *${TRIAL_QUOTA_GB} GB* untuk semua user.\n\n` +
      `User biasa dibatasi *1x trial per hari*. Reseller tidak dibatasi jumlah pembuatan trial.\n\n` +
      `Lanjutkan hanya jika Anda sudah yakin.`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply(' *Konfirmasi (yes) hurufnya kecil semua:*', { parse_mode: 'Markdown' });
  });
});

bot.action(/(del)_username_(vmess|vless|trojan|ssh|udp_http|zivpn)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dihapus:*', { parse_mode: 'Markdown' });
});
bot.action(/(unlock)_username_(vmess|vless|trojan|shadowsocks|ssh|udp_http)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dibuka:*', { parse_mode: 'Markdown' });
});
bot.action(/(lock)_username_(vmess|vless|trojan|shadowsocks|ssh|udp_http)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dikunci:*', { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
  const textRaw = String(ctx.message?.text || '').trim();
  if (textRaw === ORDERKUOTA_CHECK_REPLY_TEXT) {
    const uniqueCode = findLatestPendingOrderKuotaCodeByUserId(ctx.from?.id);
    if (!uniqueCode) {
      return ctx.reply('⚠️ Tidak ada transaksi QRIS OrderKuota yang pending untuk dicek.');
    }
    await handleOrderKuotaPaymentCheck(ctx, uniqueCode);
    return;
  }

  const state = userState[ctx.chat.id];
  if (!state || !state.step) return;

  if (state.step === 'ppob_product_number' || state.step === 'ppob_product_select') {
    const text = String(ctx.message.text || '').trim();
    if (/^(batal|cancel)$/i.test(text)) {
      delete userState[ctx.chat.id];
      return ctx.reply('PPOB dibatalkan.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]] }
      });
    }

    const selectedNumber = Number(text);
    const pageProducts = Array.isArray(state.ppobPageProducts) ? state.ppobPageProducts : [];
    if (!pageProducts.length) {
      return ctx.reply('Tidak ada produk di halaman ini. Pilih type lain atau tekan tombol kembali.');
    }
    if (!Number.isInteger(selectedNumber) || selectedNumber < 1 || selectedNumber > pageProducts.length) {
      return ctx.reply('Pilih produk lewat tombol di bawah.');
    }

    return sendPpobProductDetailForProduct(ctx, pageProducts[selectedNumber - 1]);
  }

  if (state.step === 'ppob_customer_no') {
    const text = String(ctx.message.text || '').trim();
    if (/^(batal|cancel)$/i.test(text)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembelian PPOB dibatalkan.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 PPOB', callback_data: 'ppob_menu' }]] }
      });
    }

    const product = state.ppobSelectedProduct;
    if (!product) {
      delete userState[ctx.chat.id];
      return ctx.reply('Sesi PPOB tidak valid. Ulangi dari menu PPOB.');
    }
    const customerNo = normalizePpobCustomerNo(text, product);
    if (!customerNo) {
      userState[ctx.chat.id] = {
        ...state,
        ppobCustomerNoDraft: text
      };
      return sendPpobCustomerNoInput(ctx, product, text, getPpobCustomerNoInvalidText(product));
    }
    userState[ctx.chat.id] = {
      ...state,
      ppobCustomerNo: customerNo,
      ppobCustomerNoDraft: text
    };
    return sendPpobPurchaseConfirmation(ctx, customerNo);
  }

  if (state.step === 'ppob_admin_username_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    if (text.length < 2) return ctx.reply('Username Digiflazz terlalu pendek.');
    savePpobRuntimeVars({ DIGIFLAZZ_USERNAME: text });
    delete userState[ctx.chat.id];
    await ctx.reply('Username Digiflazz berhasil disimpan.');
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_api_key_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    if (text.length < 8) return ctx.reply('API key Digiflazz terlalu pendek.');
    savePpobRuntimeVars({ DIGIFLAZZ_API_KEY: text });
    delete userState[ctx.chat.id];
    await ctx.reply('API key Digiflazz berhasil disimpan.');
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_base_url_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    const normalized = normalizeHttpUrl(text);
    if (!normalized) return ctx.reply('Base URL tidak valid. Contoh: https://api.digiflazz.com');
    savePpobRuntimeVars({ DIGIFLAZZ_BASE_URL: normalized });
    delete userState[ctx.chat.id];
    await ctx.reply(`Base URL Digiflazz disimpan:\n${normalized}`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_fee_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    const amountText = text.replace(/[^\d]/g, '');
    if (!amountText) return ctx.reply('Fee PPOB harus angka 0 sampai 1.000.000.');
    const amount = Number(amountText);
    if (!Number.isInteger(amount) || amount < 0 || amount > 1000000) {
      return ctx.reply('Fee PPOB harus angka 0 sampai 1.000.000.');
    }
    savePpobRuntimeVars({ PPOB_MARKUP_FEE: amount });
    delete userState[ctx.chat.id];
    await ctx.reply(`Fee PPOB berhasil disimpan: ${formatRupiah(amount)}.`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_notif_group_input' || state.step === 'ppob_admin_detail_group_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan grup PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    const normalized = normalizeTelegramChatIdSetting(text);
    if (normalized === null) {
      return ctx.reply('Group ID tidak valid. Contoh: -1001234567890, atau kirim 0 untuk menghapus.');
    }
    const isAdminGroup = state.step === 'ppob_admin_detail_group_input';
    savePpobRuntimeVars(isAdminGroup
      ? { PPOB_ADMIN_GROUP_ID: normalized }
      : { PPOB_NOTIF_GROUP_ID: normalized });
    delete userState[ctx.chat.id];
    await ctx.reply(`${isAdminGroup ? 'Grup admin PPOB' : 'Grup notif PPOB'} berhasil disimpan: ${normalized || '-'}`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_digi_threshold_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan warning saldo Digiflazz dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }
    const amount = parsePpobAdminAmountInput(text, { allowZero: true });
    if (amount === null || amount > 1000000000) {
      return ctx.reply('Batas warning harus angka 0 sampai 1.000.000.000.');
    }
    savePpobRuntimeVars({ PPOB_DIGIFLAZZ_LOW_BALANCE_THRESHOLD: amount });
    delete userState[ctx.chat.id];
    await ctx.reply(`Batas warning saldo Digiflazz disimpan: ${formatRupiah(amount)}.`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_cutoff_input') {
    const text = String(ctx.message.text || '').trim();
    if (/^(batal|cancel)$/i.test(text)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan cut off PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }

    const match = text.match(/(\d{1,2}[:.]\d{2})\s*(?:-|sampai|sd|to)\s*(\d{1,2}[:.]\d{2})/i);
    if (!match) {
      return ctx.reply('Format jam cut off tidak valid. Contoh: 23:30-01:15');
    }
    const start = normalizePpobCutoffTime(match[1], '');
    const end = normalizePpobCutoffTime(match[2], '');
    if (!start || !end || start === end) {
      return ctx.reply('Jam cut off tidak valid. Start dan end harus format HH:mm dan tidak boleh sama.');
    }

    savePpobRuntimeVars({
      PPOB_CUTOFF_START: start,
      PPOB_CUTOFF_END: end,
      PPOB_CUTOFF_ENABLED: true
    });
    delete userState[ctx.chat.id];
    await ctx.reply(`Cut off PPOB disimpan: ${start}-${end} WIB.`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step === 'ppob_admin_autosync_time_input') {
    const text = String(ctx.message.text || '').trim();
    if (/^(batal|cancel)$/i.test(text)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan auto sync produk PPOB dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengatur PPOB.');
    }

    const time = normalizePpobCutoffTime(text, '');
    if (!time) {
      return ctx.reply('Jam auto sync tidak valid. Gunakan format HH:mm, contoh: 00:05');
    }

    savePpobRuntimeVars({
      PPOB_AUTOSYNC_TIME: time,
      PPOB_AUTOSYNC_ENABLED: true
    });
    delete userState[ctx.chat.id];
    await ctx.reply(`Auto sync produk PPOB disimpan: ${time} WIB.`);
    return sendPpobAdminMenu(ctx);
  }

  if (state.step && state.step.startsWith('ppob_admin_balance_')) {
    const text = String(ctx.message.text || '').trim();
    if (/^(batal|cancel)$/i.test(text)) {
      delete userState[ctx.chat.id];
      await ctx.reply('Pengelolaan saldo PPOB dibatalkan.');
      return sendPpobAdminBalanceMenu(ctx);
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengelola saldo PPOB.');
    }

    if ([
      'ppob_admin_balance_add_user',
      'ppob_admin_balance_remove_user',
      'ppob_admin_balance_set_user'
    ].includes(state.step)) {
      const targetUserId = normalizePpobAdminUserIdInput(text);
      if (!targetUserId) return ctx.reply('ID Telegram harus angka 5-20 digit. Kirim ulang ID user:');

      const mode = state.step.includes('_add_') ? 'add' : (state.step.includes('_remove_') ? 'remove' : 'set');
      const existing = await getPpobUserBalanceRow(targetUserId).catch(() => null);
      if (mode === 'remove' && !existing) {
        return ctx.reply(`User dengan ID ${targetUserId} belum terdaftar di database.`);
      }

      userState[ctx.chat.id] = {
        ...state,
        step: `ppob_admin_balance_${mode}_amount`,
        targetUserId,
        currentSaldoPpob: Number(existing?.saldo_ppob || 0)
      };

      const prompt = mode === 'set'
        ? 'Kirim nominal saldo PPOB baru. Contoh: 50000'
        : (mode === 'remove'
            ? `Saldo PPOB saat ini: ${formatRupiah(Number(existing?.saldo_ppob || 0))}\nKirim jumlah saldo PPOB yang akan dihapus.`
            : `Saldo PPOB saat ini: ${formatRupiah(Number(existing?.saldo_ppob || 0))}\nKirim jumlah saldo PPOB yang akan ditambahkan.`);
      return ctx.reply(`${prompt}\nKetik "batal" untuk membatalkan.`);
    }

    if ([
      'ppob_admin_balance_add_amount',
      'ppob_admin_balance_remove_amount',
      'ppob_admin_balance_set_amount'
    ].includes(state.step)) {
      const mode = state.step.includes('_add_') ? 'add' : (state.step.includes('_remove_') ? 'remove' : 'set');
      const amount = parsePpobAdminAmountInput(text, { allowZero: mode === 'set' });
      if (amount === null) {
        return ctx.reply(mode === 'set'
          ? 'Nominal harus angka 0 atau lebih. Contoh: 50000'
          : 'Nominal harus angka lebih dari 0. Contoh: 50000');
      }

      try {
        const result = await adjustPpobUserBalance({
          targetUserId: state.targetUserId,
          amount,
          mode,
          adminId: ctx.from.id
        });
        delete userState[ctx.chat.id];

        const title = mode === 'add'
          ? 'SALDO PPOB BERHASIL DITAMBAH'
          : (mode === 'remove' ? 'SALDO PPOB BERHASIL DIHAPUS' : 'SALDO PPOB BERHASIL DISET');
        await ctx.reply(formatPpobBalanceActionText({
          title,
          targetUserId: state.targetUserId,
          previous: result.previous,
          amount,
          next: result.next,
          mode
        }), {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_balance_menu' }]] }
        });

        const userNoticeTitle = mode === 'add'
          ? 'Saldo PPOB Anda ditambahkan admin.'
          : (mode === 'remove' ? 'Saldo PPOB Anda dikurangi admin.' : 'Saldo PPOB Anda disesuaikan admin.');
        bot.telegram.sendMessage(
          state.targetUserId,
          [
            `<b>${escapeHtml(userNoticeTitle)}</b>`,
            '',
            `Nominal: <b>${formatRupiah(amount)}</b>`,
            `Saldo sekarang: <b>${formatRupiah(result.next)}</b>`
          ].join('\n'),
          { parse_mode: 'HTML' }
        ).catch((notifyErr) => {
          logger.warn(`Gagal kirim notifikasi saldo PPOB ke ${state.targetUserId}: ${notifyErr.message}`);
        });
        return;
      } catch (err) {
        if (err.message === 'USER_NOT_FOUND') {
          return ctx.reply(`User dengan ID ${state.targetUserId} belum terdaftar di database.`);
        }
        if (err.message === 'INSUFFICIENT_PPOB_BALANCE') {
          return ctx.reply(`Saldo PPOB user tidak cukup. Saldo saat ini: ${formatRupiah(Number(state.currentSaldoPpob || 0))}`);
        }
        logger.error('Gagal mengelola saldo PPOB user:', err.message);
        return ctx.reply('Gagal mengelola saldo PPOB user. Cek log bot untuk detail.');
      }
    }

    if (state.step === 'ppob_admin_balance_check_user') {
      const targetUserId = normalizePpobAdminUserIdInput(text);
      if (!targetUserId) return ctx.reply('ID Telegram harus angka 5-20 digit. Kirim ulang ID user:');
      const row = await getPpobUserBalanceRow(targetUserId).catch(() => null);
      delete userState[ctx.chat.id];
      if (!row) {
        return ctx.reply(`User dengan ID ${targetUserId} belum terdaftar di database.`, {
          reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_balance_menu' }]] }
        });
      }
      return ctx.reply(
        [
          '<b>SALDO USER</b>',
          '',
          `User ID: <code>${escapeHtml(targetUserId)}</code>`,
          `Saldo VPN: <b>${formatRupiah(Number(row.saldo || 0))}</b>`,
          `Saldo PPOB: <b>${formatRupiah(Number(row.saldo_ppob || 0))}</b>`
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_balance_menu' }]] }
        }
      );
    }

    if (state.step === 'ppob_admin_balance_history_user') {
      const targetUserId = normalizePpobAdminUserIdInput(text);
      if (!targetUserId) return ctx.reply('ID Telegram harus angka 5-20 digit. Kirim ulang ID user:');
      const rows = await dbAllAsync(
        `SELECT amount, type, reference_id, timestamp
         FROM transactions
         WHERE user_id = ? AND LOWER(COALESCE(type, '')) LIKE '%ppob%'
         ORDER BY timestamp DESC
         LIMIT 15`,
        [targetUserId]
      ).catch(() => []);
      delete userState[ctx.chat.id];

      const lines = [
        '<b>RIWAYAT SALDO/TRANSAKSI PPOB</b>',
        '',
        `User ID: <code>${escapeHtml(targetUserId)}</code>`,
        ''
      ];
      if (!rows.length) {
        lines.push('Belum ada riwayat PPOB.');
      } else {
        rows.forEach((row, index) => {
          const date = new Date(Number(row.timestamp || 0)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          lines.push(`${index + 1}. <b>${escapeHtml(row.type || '-')}</b> ${formatRupiah(Number(row.amount || 0))}`);
          lines.push(`   ${escapeHtml(date)}`);
        });
      }

      return ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Kembali', callback_data: 'ppob_admin_balance_menu' }]] }
      });
    }
  }

  if (state.step === 'admin_config_upload_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload config dibatalkan.');
    }
    return ctx.reply('Silakan kirim file config sebagai document, atau ketik "batal".');
  }

  if (state.step === 'admin_hc_template_upload_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload template HC dibatalkan.');
    }
    return ctx.reply(`Silakan kirim 1 sampai ${HC_TEMPLATE_UPLOAD_MAX_FILES} file template HC sebagai document, atau ketik "batal".`);
  }

  if (state.step === 'admin_hc_template_replace_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Ganti file template HC dibatalkan.');
    }
    return ctx.reply('Silakan kirim file template HC sebagai document, atau ketik "batal".');
  }

  if (state.step === 'admin_dark_template_upload_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload template Dark Tunnel dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk upload template Dark Tunnel.');
    }
    if (extractDarkTunnelLinkFromText(text)) {
      return startDarkTemplateTextUpload(ctx, text);
    }
    return ctx.reply(`Silakan kirim 1 sampai ${DARK_TEMPLATE_UPLOAD_MAX_FILES} file template Dark Tunnel sebagai document, paste link darktunnel://..., atau ketik "batal".`);
  }

  if (state.step === 'admin_dark_template_replace_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Ganti file template Dark Tunnel dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengganti template Dark Tunnel.');
    }
    if (extractDarkTunnelLinkFromText(text)) {
      return replaceDarkTemplateWithText(ctx, state, text);
    }
    return ctx.reply('Silakan kirim file template Dark Tunnel sebagai document, paste link darktunnel://..., atau ketik "batal".');
  }

  if (state.step === 'admin_hc_note_input') {
    const rawText = String(ctx.message.text || '');
    const text = rawText.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Setting note default HC dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan note default HC.');
    }

    const noteHtml = text === '-' ? '' : rawText.trim();
    saveHcDefaultNoteSetting({
      enabled: noteHtml.length > 0,
      html: noteHtml
    });

    delete userState[ctx.chat.id];
    await ctx.reply(
      noteHtml
        ? `Note default HC berhasil disimpan dan diaktifkan.\nPanjang: ${noteHtml.length} karakter.`
        : 'Note default HC dikosongkan dan dinonaktifkan.'
    );
    return sendAdminHcTemplateMenu(ctx);
  }

  if (state.step === 'admin_dark_note_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Setting note default Dark Tunnel dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan note default Dark Tunnel.');
    }

    saveDarkDefaultNoteSetting({ enabled: false });
    delete userState[ctx.chat.id];
    await ctx.reply('Note custom Dark Tunnel tidak disimpan karena membuat file ditolak APK. Message akan mengikuti bawaan template.');
    return sendAdminDarkTemplateMenu(ctx);
  }

  if (state.step === 'admin_hc_template_rename_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit nama template HC dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengubah template HC.');
    }

    const templateName = sanitizeHcTemplateName(text);
    if (templateName.length < 2) {
      return ctx.reply('Nama template terlalu pendek. Minimal 2 karakter.');
    }

    const templateId = Number(state.templateId || 0);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      delete userState[ctx.chat.id];
      return ctx.reply('Sesi edit nama template tidak valid. Ulangi dari menu admin.');
    }

    try {
      const result = await dbRunAsync(
        'UPDATE hc_config_templates SET name = ?, slug = ? WHERE id = ?',
        [templateName, slugifyHcTemplateName(templateName), templateId]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(result.changes > 0 ? `Nama template HC diubah menjadi "${templateName}".` : 'Template HC tidak ditemukan.');
      return sendAdminHcTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal edit nama template HC:', err.message);
      return ctx.reply('Gagal mengubah nama template HC. Silakan coba lagi.');
    }
  }

  if (state.step === 'admin_dark_template_rename_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit nama template Dark Tunnel dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk mengubah template Dark Tunnel.');
    }

    const templateName = sanitizeHcTemplateName(text);
    if (templateName.length < 2) {
      return ctx.reply('Nama template terlalu pendek. Minimal 2 karakter.');
    }

    const templateId = Number(state.templateId || 0);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      delete userState[ctx.chat.id];
      return ctx.reply('Sesi edit nama template tidak valid. Ulangi dari menu admin.');
    }

    try {
      const result = await dbRunAsync(
        'UPDATE dark_config_templates SET name = ?, slug = ? WHERE id = ?',
        [templateName, slugifyHcTemplateName(templateName), templateId]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(result.changes > 0 ? `Nama template Dark Tunnel diubah menjadi "${templateName}".` : 'Template Dark Tunnel tidak ditemukan.');
      return sendAdminDarkTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal edit nama template Dark Tunnel:', err.message);
      return ctx.reply('Gagal mengubah nama template Dark Tunnel. Silakan coba lagi.');
    }
  }

  if (state.step === 'admin_tutorial_add_input') {
    const rawText = String(ctx.message.text || '');
    const text = rawText.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Tambah tutorial dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan tutorial.');
    }

    const separatorIndex = rawText.indexOf('|');
    if (separatorIndex < 0) {
      return ctx.reply('Format salah. Gunakan: Nama Tutorial | isi tutorial atau link');
    }

    const title = normalizeTutorialTitle(rawText.slice(0, separatorIndex));
    const contentInput = normalizeTutorialContent(rawText.slice(separatorIndex + 1));
    const normalizedLink = normalizeTutorialLink(contentInput);
    const content = normalizedLink || contentInput;

    if (title.length < 2) {
      return ctx.reply('Nama tutorial terlalu pendek. Minimal 2 karakter.');
    }
    if (content.length < 2) {
      return ctx.reply('Isi tutorial/link tidak boleh kosong.');
    }

    try {
      await dbRunAsync(
        `INSERT INTO tutorial_items
         (title, content, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
        [title, content, ctx.from.id, Date.now(), Date.now()]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(`Tutorial "${title}" berhasil disimpan.`);
      return sendAdminTutorialMenu(ctx);
    } catch (err) {
      logger.error('Gagal menyimpan tutorial:', err.message);
      return ctx.reply('Gagal menyimpan tutorial. Silakan coba lagi.');
    }
  }

  if (state.step === 'hc_unlock_upload_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Unlock config HC dibatalkan.');
    }
    return ctx.reply('Silakan kirim file .hc sebagai document, atau ketik "batal".');
  }

  if (state.step === 'dark_unlock_upload_document') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Unlock config Dark Tunnel dibatalkan.');
    }
    if (extractDarkTunnelLinkFromText(text)) {
      return sendUnlockedDarkConfigFromText(ctx, state, text);
    }
    return ctx.reply('Silakan kirim file .dark sebagai document, paste link darktunnel://..., atau ketik "batal".');
  }

  if (state.step === 'admin_config_name_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload config dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan config.');
    }

    const configName = sanitizeDownloadConfigName(text);
    if (configName.length < 2) {
      return ctx.reply('Nama config terlalu pendek. Minimal 2 karakter.');
    }

    const doc = state.doc || {};
    if (!doc.file_id) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data file tidak ditemukan. Ulangi upload config dari menu admin.');
    }

    try {
      await dbRunAsync(
        `INSERT INTO download_configs
         (name, file_id, file_unique_id, file_name, mime_type, file_size, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          configName,
          doc.file_id,
          doc.file_unique_id || '',
          doc.file_name || 'config',
          doc.mime_type || '',
          Number(doc.file_size || 0),
          ctx.from.id,
          Date.now()
        ]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(`Config "${configName}" berhasil disimpan dan sudah tampil di menu DOWNLOAD CONFIG.`);
      return sendAdminDownloadConfigMenu(ctx);
    } catch (err) {
      logger.error('Gagal menyimpan download config:', err.message);
      return ctx.reply('Gagal menyimpan config. Silakan coba lagi.');
    }
  }

  if (state.step === 'admin_hc_template_name_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload template HC dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan template HC.');
    }

    const templateName = sanitizeHcTemplateName(text === '-' ? state.suggestedTemplateName : text);
    if (templateName.length < 2) {
      return ctx.reply('Nama template terlalu pendek. Minimal 2 karakter.');
    }

    if (!state.templateText) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data template tidak ditemukan. Ulangi upload dari menu admin.');
    }

    try {
      await dbRunAsync(
        `INSERT INTO hc_config_templates
         (name, slug, source_file_name, template_text, enabled, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          templateName,
          slugifyHcTemplateName(templateName),
          state.sourceFileName || 'template-hc.txt',
          state.templateText,
          ctx.from.id,
          Date.now()
        ]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(`Template HC "${templateName}" berhasil disimpan.`);
      return sendAdminHcTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal menyimpan template HC:', err.message);
      return ctx.reply('Gagal menyimpan template HC. Silakan coba lagi.');
    }
  }

  if (state.step === 'admin_dark_template_name_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Upload template Dark Tunnel dibatalkan.');
    }

    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menyimpan template Dark Tunnel.');
    }

    const templateName = sanitizeHcTemplateName(text === '-' ? state.suggestedTemplateName : text);
    if (templateName.length < 2) {
      return ctx.reply('Nama template terlalu pendek. Minimal 2 karakter.');
    }

    if (!state.templateText) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data template tidak ditemukan. Ulangi upload dari menu admin.');
    }

    try {
      await dbRunAsync(
        `INSERT INTO dark_config_templates
         (name, slug, source_file_name, template_text, enabled, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          templateName,
          slugifyHcTemplateName(templateName),
          state.sourceFileName || 'template-dark.dark',
          state.templateText,
          ctx.from.id,
          Date.now()
        ]
      );

      delete userState[ctx.chat.id];
      await ctx.reply(`Template Dark Tunnel "${templateName}" berhasil disimpan.`);
      return sendAdminDarkTemplateMenu(ctx);
    } catch (err) {
      logger.error('Gagal menyimpan template Dark Tunnel:', err.message);
      return ctx.reply('Gagal menyimpan template Dark Tunnel. Silakan coba lagi.');
    }
  }

  if (state.step === 'admin_bulk_config_prefix_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Bulk generate config dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menggunakan menu ini.');
    }

    userState[ctx.chat.id] = {
      ...state,
      step: 'admin_bulk_config_account_input',
      prefix: normalizeBulkConfigPrefix(text)
    };
    return sendAdminBulkAccountPrompt(ctx, userState[ctx.chat.id]);
  }

  if (state.step === 'admin_bulk_config_account_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Bulk generate config dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('Anda tidak memiliki izin untuk menggunakan menu ini.');
    }

    const format = state.format === 'dark' ? 'dark' : 'hc';
    const method = format === 'hc' ? normalizeHcMethod(state.method) : normalizeDarkMethod(state.method);
    let account;
    try {
      if (format === 'hc') {
        account = method === 'xray'
          ? parseHcXrayConfigInput(text)
          : parseHcSshAccountInput(text);
      } else {
        account = method === 'ssh'
          ? parseDarkSshAccountInput(text)
          : parseDarkXrayAccountInput(text, method);
      }
    } catch (err) {
      if (method === 'ssh') {
        return ctx.reply(
          `${err.message}\n\n` +
          'Contoh:\n' +
          '`sg.example.com:443@user123:pass123`',
          { parse_mode: 'Markdown' }
        );
      }
      const linkPrefix = format === 'hc'
        ? 'vmess://, vless://, atau trojan://'
        : (method === 'trojan' ? 'trojan://' : (method === 'vless' ? 'vless://' : 'vmess://'));
      const compactExample = format === 'hc'
        ? '\n`server.com:UUID` atau `trojan:server.com:PASSWORD`'
        : '';
      return ctx.reply(
        `${err.message}\n\n` +
        'Contoh:\n' +
        `\`${linkPrefix}\`${compactExample}`,
        { parse_mode: 'Markdown' }
      );
    }

    return sendBulkGeneratedConfigs(ctx, state, account);
  }

  if (state.step === 'hc_template_account_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config HC dibatalkan.');
    }

    let account;
    const method = normalizeHcMethod(state.method);
    try {
      account = method === 'xray'
        ? parseHcXrayConfigInput(text)
        : parseHcSshAccountInput(text);
    } catch (err) {
      if (method === 'xray') {
        return ctx.reply(
          `${err.message}\n\n` +
          'Contoh:\n' +
          '`server.com:UUID` untuk VMess\n' +
          '`trojan:server.com:PASSWORD` untuk Trojan\n' +
          '`vless://uuid@server.com:443?security=tls&type=ws&host=bug.com&path=/`\n\n' +
          'Atau kirim JSON V2Ray mentah.',
          { parse_mode: 'Markdown' }
        );
      }
      return ctx.reply(
        `${err.message}\n\n` +
        'Contoh:\n' +
        '`sg.example.com:443@user123:pass123`',
        { parse_mode: 'Markdown' }
      );
    }

    userState[ctx.chat.id] = {
      ...state,
      step: 'hc_template_note_choice',
      account
    };

    return sendHcNoteChoiceMenu(ctx);
  }

  if (state.step === 'dark_template_account_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config Dark Tunnel dibatalkan.');
    }

    let account;
    const method = normalizeDarkMethod(state.method);
    try {
      account = method === 'ssh'
        ? parseDarkSshAccountInput(text)
        : parseDarkXrayAccountInput(text, method);
    } catch (err) {
      if (method !== 'ssh') {
        const secretLabel = method === 'trojan' ? 'password' : 'uuid';
        const linkPrefix = method === 'trojan' ? 'trojan://' : (method === 'vless' ? 'vless://' : 'vmess://');
        return ctx.reply(
          `${err.message}\n\n` +
          'Contoh:\n' +
          `\`sg.example.com:${secretLabel}\`\n` +
          `\`sg.example.com:443@${secretLabel}\`\n\n` +
          `Atau kirim link \`${linkPrefix}...\`.`,
          { parse_mode: 'Markdown' }
        );
      }
      return ctx.reply(
        `${err.message}\n\n` +
        'Contoh:\n' +
        '`sg.example.com:443@user123:pass123`',
        { parse_mode: 'Markdown' }
      );
    }

    userState[ctx.chat.id] = {
      ...state,
      step: 'dark_template_note_choice',
      account
    };

    return sendDarkNoteChoiceMenu(ctx);
  }

  if (state.step === 'dark_template_note_choice') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config Dark Tunnel dibatalkan.');
    }
    return ctx.reply('Silakan pilih tombol Default, Tambah Note, atau Skip.');
  }

  if (state.step === 'dark_template_note_input') {
    const rawText = String(ctx.message.text || '');
    const text = rawText.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config Dark Tunnel dibatalkan.');
    }

    if (!state.account) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data akun tidak ditemukan. Ulangi dari menu Buat Config Dark.');
    }

    const noteSetting = resolveDarkUserNoteSetting(rawText);
    return sendGeneratedDarkTemplateConfig(ctx, state, state.account, noteSetting);
  }

  if (state.step === 'hc_template_note_choice') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config HC dibatalkan.');
    }
    return ctx.reply('Silakan pilih tombol Default, Tambah Note, atau Skip.');
  }

  if (state.step === 'hc_template_note_input') {
    const rawText = String(ctx.message.text || '');
    const text = rawText.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pembuatan config HC dibatalkan.');
    }

    if (!state.account) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data akun tidak ditemukan. Ulangi dari menu Buat Config HC.');
    }

    const noteSetting = resolveHcUserNoteSetting(rawText);
    return sendGeneratedHcTemplateConfig(ctx, state, state.account, noteSetting);
  }

  if (state.step === 'hc_link') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Convert link Xray dibatalkan.');
    }

    let parsed;
    try {
      if (/^vmess:\/\//i.test(text)) {
        parsed = parseVmessLink(text);
      } else if (/^vless:\/\//i.test(text)) {
        parsed = parseVlessLink(text);
      } else if (/^trojan:\/\//i.test(text)) {
        parsed = parseTrojanLink(text);
      } else {
        return ctx.reply('Link tidak dikenal. Kirim link VMESS/VLESS/TROJAN yang valid.');
      }
    } catch (e) {
      return ctx.reply('Gagal membaca link. Pastikan link valid dan lengkap.');
    }

    userState[ctx.chat.id] = { step: 'hc_bug', parsed };
    return ctx.reply('Masukkan *BUG/Host* yang akan dipasang ke bagian address:', { parse_mode: 'Markdown' });
  }

  if (state.step === 'hc_bug') {
    const bug = String(ctx.message.text || '').trim();
    if (bug.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Convert link Xray dibatalkan.');
    }
    if (!bug) {
      return ctx.reply('BUG tidak boleh kosong. Masukkan BUG/Host.');
    }

    const json = buildHcJson(state.parsed, bug);
    const jsonText = JSON.stringify(json, null, 2);
    delete userState[ctx.chat.id];
    return ctx.reply(
      `Berikut JSON V2Ray Setting HC:\n<pre><code>${escapeHtmlLocal(jsonText)}</code></pre>`,
      { parse_mode: 'HTML' }
    );
  }

  if (state.step === 'global_price_duration_input') {
    const text = String(ctx.message.text || '').trim();
    return handleGlobalPriceDurationInput(ctx, state, text);
  }

  if (state.step === 'maintenance_estimate_input') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan estimasi maintenance dibatalkan.');
    }
    if (text.length < 2 || text.length > 60) {
      return ctx.reply('Estimasi tidak valid. Gunakan teks singkat, contoh: 30 menit atau 2 jam.');
    }

    const current = loadMaintenanceSetting();
    saveMaintenanceSetting({
      enabled: current.enabled,
      estimate: text
    });
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Estimasi maintenance disimpan: ${text}`);
    return ctx.reply('Buka kembali menu maintenance untuk cek status terbaru.', {
      reply_markup: { inline_keyboard: [[{ text: 'Buka Menu Maintenance', callback_data: 'maintenance_menu' }]] }
    });
  }

  if (state.step === 'server_iplimit_rule_1ip') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan limit IP paket dibatalkan.');
    }

    const limit = Number(text);
    if (!Number.isInteger(limit) || limit < 0) {
      return ctx.reply('Limit IP harus angka 0 atau lebih.');
    }

    state.rule1 = limit;
    state.step = 'server_iplimit_rule_2ip';
    userState[ctx.chat.id] = state;

    return ctx.reply(
      `Server: *${state.serverName || `ID ${state.serverId}`}*\n` +
      `Protocol: *${String(state.protocol || '').toUpperCase()}*\n` +
      `Limit paket *1IP* tersimpan: *${limit}*\n\n` +
      `Sekarang masukkan limit IP untuk paket *2IP*.\n` +
      `Ketik *batal* untuk membatalkan.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (state.step === 'server_iplimit_rule_2ip') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan limit IP paket dibatalkan.');
    }

    const limit = Number(text);
    if (!Number.isInteger(limit) || limit < 0) {
      return ctx.reply('Limit IP harus angka 0 atau lebih.');
    }

    const serverId = Number(state.serverId || 0);
    const protocol = normalizeIpLimitProtocol(state.protocol);
    const rule1 = Number(state.rule1);
    const rule2 = limit;

    try {
      await saveServerIpLimitRule(serverId, protocol, 1, rule1);
      await saveServerIpLimitRule(serverId, protocol, 2, rule2);
      delete userState[ctx.chat.id];

      await ctx.reply(
        `✅ Limit IP paket tersimpan.\n` +
        `Server: *${state.serverName || `ID ${serverId}`}*\n` +
        `Protocol: *${protocol.toUpperCase()}*\n` +
        `1IP -> ${rule1}\n` +
        `2IP -> ${rule2}`,
        { parse_mode: 'Markdown' }
      );

      return sendServerIpLimitProtocolMenu(ctx, serverId, state.serverName || `ID ${serverId}`);
    } catch (error) {
      logger.error('Error menyimpan limit IP paket:', error.message);
      return ctx.reply('Gagal menyimpan limit IP paket.');
    }
  }

  if (state.step === 'edit_domain_pick_server') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit domain dibatalkan.');
    }

    const serverId = Number(text);
    if (!Number.isFinite(serverId) || serverId <= 0) {
      return ctx.reply('ID server tidak valid. Masukkan angka ID server yang benar.');
    }

    return db.get('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId], async (err, row) => {
      if (err) {
        logger.error('Error ambil server untuk edit domain:', err.message);
        return ctx.reply('Terjadi kesalahan saat membaca data server.');
      }
      if (!row) {
        return ctx.reply('Server dengan ID tersebut tidak ditemukan. Coba lagi.');
      }

      userState[ctx.chat.id] = {
        step: 'edit_domain_input_value',
        serverId: row.id
      };

      return ctx.reply(
        'Server terpilih: ' + (row.nama_server || '-') + '\n' +
        'Domain saat ini: ' + (row.domain || '-') + '\n\n' +
        'Ketik domain baru untuk server ini.\n' +
        'Ketik batal untuk membatalkan.'
      );
    });
  }

  if (state.step === 'edit_domain_input_value') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit domain dibatalkan.');
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(text)) {
      return ctx.reply('Domain tidak valid. Gunakan hanya huruf, angka, titik, dan tanda minus.');
    }

    return db.run('UPDATE Server SET domain = ? WHERE id = ?', [text, state.serverId], function(err) {
      if (err) {
        logger.error('Error update domain server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengubah domain server.');
      }

      if (this.changes === 0) {
        return ctx.reply('Server tidak ditemukan atau domain tidak berubah.');
      }

      delete userState[ctx.chat.id];
      return ctx.reply('Domain server berhasil diubah menjadi: ' + text);
    });
  }

  if (state.step === 'admin_broadcast_poll_only_input') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast polling dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    const parts = text.split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) {
      return ctx.reply('Format salah. Gunakan: Pertanyaan | Opsi A | Opsi B');
    }

    const question = parts[0];
    const options = parts.slice(1, 11);

    if (question.length < 5) {
      return ctx.reply('Pertanyaan polling terlalu pendek. Minimal 5 karakter.');
    }

    if (options.length < 2) {
      return ctx.reply('Polling minimal punya 2 opsi.');
    }

    const pollResult = await broadcastPollToAllUsers(
      question,
      options,
      Number(ctx.from.id || 0),
      ctx.chat.id
    );

    delete userState[ctx.chat.id];

    await ctx.reply(formatBroadcastQueuedMessage(pollResult, `Broadcast polling #${pollResult.pollId}`));

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'admin_broadcast_message') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    if (text.length < 3) {
      return ctx.reply('Pesan terlalu pendek. Minimal 3 karakter.');
    }

    const result = await broadcastMessageToAllUsers(text, ctx.chat.id);
    delete userState[ctx.chat.id];

    await ctx.reply(formatBroadcastQueuedMessage(result, 'Broadcast pesan'));

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'admin_broadcast_poll_input') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    const parts = text.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) {
      return ctx.reply('Format salah. Gunakan: Pertanyaan | Opsi A | Opsi B');
    }

    const question = parts[0];
    const options = parts.slice(1, 11);

    if (question.length < 5) {
      return ctx.reply('Pertanyaan polling terlalu pendek. Minimal 5 karakter.');
    }

    if (options.length < 2) {
      return ctx.reply('Polling minimal punya 2 opsi.');
    }

    const message = String(state.message || '').trim();
    const msgResult = await broadcastMessageToAllUsers(message, ctx.chat.id);
    const pollResult = await broadcastPollToAllUsers(
      question,
      options,
      Number(ctx.from.id || 0),
      ctx.chat.id
    );

    delete userState[ctx.chat.id];

    await ctx.reply(
      formatBroadcastQueuedMessage(msgResult, 'Broadcast pesan') + '\n\n' +
      formatBroadcastQueuedMessage(pollResult, `Broadcast polling #${pollResult.pollId}`)
    );

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'restore_db_upload') {
    const text = (ctx.message.text || '').trim().toLowerCase();
    if (text === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Restore database dibatalkan.');
    }
    return ctx.reply('Silakan kirim file backup sebagai document, atau ketik "batal".');
  }

  if (
    state.step === 'restore_foreign_db_upload' ||
    state.step === 'restore_foreign_db_preview' ||
    state.step === 'restore_foreign_db_overwrite_confirm'
  ) {
    const text = (ctx.message.text || '').trim().toLowerCase();
    if (text === 'batal') {
      await cleanupForeignRestoreState(ctx);
      return ctx.reply('Import database bot lain dibatalkan.');
    }
    return ctx.reply(
      state.step === 'restore_foreign_db_upload'
        ? 'Silakan kirim file SQLite .db sebagai document, atau ketik "batal".'
        : 'Gunakan tombol konfirmasi pada preview, atau ketik "batal".'
    );
  }

  if (
    state.step === 'bonus_set_10_40' ||
    state.step === 'bonus_set_50_70' ||
    state.step === 'bonus_set_70_100'
  ) {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan bonus dibatalkan.');
    }

    const percent = Number(text.replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return ctx.reply('Persen tidak valid. Masukkan angka 0 sampai 100.');
    }

    const current = loadTopupBonusSetting();
    if (state.step === 'bonus_set_10_40') {
      current.range_10_40 = percent;
    } else if (state.step === 'bonus_set_50_70') {
      current.range_50_70 = percent;
    } else {
      current.range_70_100 = percent;
    }
    const saved = saveTopupBonusSetting(current);

    delete userState[ctx.chat.id];
    return ctx.reply(
      'Bonus topup berhasil diperbarui.\n\n' +
      '10-40rb: ' + saved.range_10_40 + '%\n' +
      '50-70rb: ' + saved.range_50_70 + '%\n' +
      '70-100rb+: ' + saved.range_70_100 + '%'
    );
  }

  if (state.step === 'check_expiry_username') {
    const input = ctx.message.text.trim();
    if (input.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Cek masa aktif dibatalkan.');
    }

    const username = input;
    const serverId = Number(state.serverId);

    db.get(
      'SELECT id, domain, auth, sync_host, sync_port, sync_endpoint, nama_server FROM Server WHERE id = ?',
      [serverId],
      async (err, serverRow) => {
        if (err) {
          logger.error('Error cek masa aktif ambil server:', err.message);
          return ctx.reply('Terjadi kesalahan saat mengambil server.');
        }
        if (!serverRow) {
          return ctx.reply('Server tidak ditemukan.');
        }

        const info = await fetchTunnelAccountExpiryByUsername(serverRow, username);
        if (!info.found) {
          return ctx.reply('Akun tidak ditemukan di server ini atau API tidak merespons.');
        }

        const remainingDays = calcRemainingDaysFromDateExp(info.dateExp);
        delete userState[ctx.chat.id];

        await ctx.reply(
          'HASIL CEK MASA AKTIF\n\n' +
          'Server: ' + (state.serverName || serverRow.nama_server || serverRow.domain || '-') + '\n' +
          'Username: ' + username + '\n' +
          'Layanan: ' + String(info.service || '-').toUpperCase() + '\n' +
          'Expired: ' + (info.dateExp || '-') + '\n' +
          'Sisa Masa Aktif: ' + remainingDays + ' hari',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Cek Lagi', callback_data: 'check_expiry_account' }],
                [{ text: 'Menu Utama', callback_data: 'send_main_menu' }]
              ]
            }
          }
        );
      }
    );
    return;
  }

  if (state.step === 'main_menu_admin_telegram') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan admin menu utama dibatalkan.');
    }

    const normalized = text.replace(/^@+/, '').trim();
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(normalized)) {
      return ctx.reply('Username Telegram tidak valid. Gunakan 5-32 karakter (huruf, angka, underscore).');
    }

    ADMIN_TELEGRAM = normalized;
    const nextVars = loadVars();
    nextVars.ADMIN_TELEGRAM = ADMIN_TELEGRAM;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply('✅ Admin menu utama tersimpan: @' + ADMIN_TELEGRAM);
    return sendMainMenuSettings(ctx);
  }

  if (state.step === 'main_menu_group_button' || state.step === 'main_menu_channel_button') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan tombol halaman utama dibatalkan.');
    }

    const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      return ctx.reply('Format salah. Gunakan: Nama Tombol | https://t.me/username');
    }

    const labelFallback = state.step === 'main_menu_group_button' ? 'Grup Telegram' : 'Channel Telegram';
    const label = normalizeMainMenuButtonLabel(parts[0], labelFallback);
    const url = normalizeMainMenuButtonUrl(parts.slice(1).join('|'));
    if (!url) {
      return ctx.reply('Link tidak valid. Contoh: https://t.me/username atau @username');
    }

    if (state.step === 'main_menu_group_button') {
      saveMainMenuRuntimeVars({
        MAIN_MENU_GROUP_LABEL: label,
        MAIN_MENU_GROUP_URL: url,
        MAIN_MENU_GROUP_ENABLED: true
      });
      await ctx.reply('✅ Tombol grup halaman utama tersimpan.');
    } else {
      saveMainMenuRuntimeVars({
        MAIN_MENU_CHANNEL_LABEL: label,
        MAIN_MENU_CHANNEL_URL: url,
        MAIN_MENU_CHANNEL_ENABLED: true
      });
      await ctx.reply('✅ Tombol channel halaman utama tersimpan.');
    }

    delete userState[ctx.chat.id];
    return sendMainMenuSettings(ctx);
  }

  if (state.step === 'notif_bot_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan token dibatalkan.');
    }
    NOTIF_BOT_TOKEN = text;
    const nextVars = loadVars();
    nextVars.NOTIF_BOT_TOKEN = NOTIF_BOT_TOKEN;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Token notifikasi tersimpan.');
    return sendAdminMenu(ctx);
  }

  if (state.step === 'notif_chat_id') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan chat id dibatalkan.');
    }
    NOTIF_CHAT_ID = text;
    const nextVars = loadVars();
    nextVars.NOTIF_CHAT_ID = NOTIF_CHAT_ID;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Chat ID notifikasi tersimpan.');
    return sendAdminMenu(ctx);
  }

  if (state.step === 'notif_global_create_group_id') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan group global create dibatalkan.');
    }
    if (!/^-?\d+$/.test(text)) {
      return ctx.reply('Group ID tidak valid. Contoh: `-1001234567890`', { parse_mode: 'Markdown' });
    }
    GLOBAL_CREATE_NOTIF_GROUP_ID = text;
    const nextVars = loadVars();
    nextVars.GLOBAL_CREATE_NOTIF_GROUP_ID = GLOBAL_CREATE_NOTIF_GROUP_ID;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Group global notif create tersimpan: ${GLOBAL_CREATE_NOTIF_GROUP_ID}`);
    return sendAdminMenu(ctx);
  }

  if (state.step === 'sc_webhook_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan token webhook dibatalkan.');
    }
    BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN = text;
    const nextVars = loadVars();
    nextVars.BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN = BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Token webhook SC tersimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'sc_webhook_url') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan URL webhook dibatalkan.');
    }
    const normalized = normalizeHttpUrl(text);
    if (!normalized) {
      return ctx.reply('URL tidak valid. Contoh: https://domain-bot/sc1forcr/events/multi-login');
    }
    SC_MULTI_LOGIN_WEBHOOK_URL = normalized;
    const nextVars = loadVars();
    nextVars.SC_MULTI_LOGIN_WEBHOOK_URL = SC_MULTI_LOGIN_WEBHOOK_URL;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ URL webhook SC tersimpan:\n${SC_MULTI_LOGIN_WEBHOOK_URL}`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'generator_api_url_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan Generator API dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
    }

    const nextUrl = text === '-'
      ? DEFAULT_GENERATOR_API_URL
      : normalizeGeneratorApiUrl(text);
    if (!nextUrl) {
      return ctx.reply(`URL Generator API tidak valid. Contoh: \`${DEFAULT_GENERATOR_API_URL}\``, { parse_mode: 'Markdown' });
    }

    const nextVars = loadVars();
    nextVars.GENERATOR_API_URL = nextUrl;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Generator API URL tersimpan:\n${nextUrl}`);
    return sendGeneratorApiSettingsMenu(ctx);
  }

  if (state.step === 'generator_api_key_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan Generator API dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
    }

    const nextKey = text.toLowerCase() === 'hapus' ? '' : text;
    if (nextKey && nextKey.length < 6) {
      return ctx.reply('API key terlalu pendek. Kirim key yang valid, atau ketik `hapus` untuk mengosongkan.', { parse_mode: 'Markdown' });
    }

    const nextVars = loadVars();
    nextVars.GENERATOR_API_KEY = nextKey;
    delete nextVars.GENERATOR_API_TOKEN;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(nextKey ? '✅ Generator API key tersimpan.' : '✅ Generator API key dikosongkan.');
    return sendGeneratorApiSettingsMenu(ctx);
  }

  if (state.step === 'generator_api_timeout_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan Generator API dibatalkan.');
    }
    if (!adminIds.includes(ctx.from.id)) {
      delete userState[ctx.chat.id];
      return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
    }

    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) {
      return ctx.reply('Timeout harus angka 10 sampai 300 detik.');
    }

    const nextVars = loadVars();
    nextVars.GENERATOR_API_TIMEOUT_MS = seconds * 1000;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Timeout Generator API tersimpan: ${seconds} detik.`);
    return sendGeneratorApiSettingsMenu(ctx);
  }

  if (state.step === 'nginx_webhook_host_input_generate') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Generate config Nginx dibatalkan.');
    }

    const host = sanitizeNginxHostInput(text);
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
      return ctx.reply('Domain/IP tidak valid. Contoh: 47.236.58.59 atau bot.domain.com');
    }

    const nginxConfig = buildNginxWebhookConfig(host, port);
    const confName = getNginxWebhookConfName(host);
    delete userState[ctx.chat.id];
    await ctx.reply(
      `*Config Nginx (copy ke \`/etc/nginx/sites-available/${confName}\`):*`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply('```nginx\n' + nginxConfig + '\n```', { parse_mode: 'Markdown' });
    await ctx.reply(
      'Lanjutkan di VPS:\n' +
      `1. \`ln -sf /etc/nginx/sites-available/${confName} /etc/nginx/sites-enabled/${confName}\`\n` +
      '2. `nginx -t`\n' +
      '3. `systemctl reload nginx`\n\n' +
      'Setelah itu, gunakan menu *Set URL Webhook dari Domain/IP*.',
      { parse_mode: 'Markdown' }
    );
    return sendNginxWebhookMenu(ctx);
  }

  if (state.step === 'nginx_webhook_host_input_auto') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Auto setup Nginx webhook dibatalkan.');
    }

    const host = sanitizeNginxHostInput(text);
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
      return ctx.reply('Domain/IP tidak valid. Contoh: 47.236.58.59 atau bot.domain.com');
    }

    await ctx.reply('⏳ Menjalankan auto setup Nginx + SSL... mohon tunggu.');
    const result = setupNginxWebhookAuto(host, port);
    if (!result.ok) {
      delete userState[ctx.chat.id];
      await ctx.reply(`❌ Auto setup gagal: ${result.message}`);
      return sendNginxWebhookMenu(ctx);
    }

    SC_MULTI_LOGIN_WEBHOOK_URL = result.url;
    const nextVars = loadVars();
    nextVars.SC_MULTI_LOGIN_WEBHOOK_URL = SC_MULTI_LOGIN_WEBHOOK_URL;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(
      `✅ Auto setup selesai.\n` +
      `Status: ${result.ssl ? 'HTTPS aktif' : 'HTTP aktif'}\n` +
      `Webhook URL: ${SC_MULTI_LOGIN_WEBHOOK_URL}\n\n` +
      `Webhook Token: ${BOT_ACCOUNT_EVENT_WEBHOOK_TOKEN || '(belum diisi)'}`
    );
    return sendNginxWebhookMenu(ctx);
  }

  if (state.step === 'nginx_webhook_host_input_seturl') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Set URL webhook dibatalkan.');
    }

    const host = sanitizeNginxHostInput(text);
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
      return ctx.reply('Domain/IP tidak valid. Contoh: 47.236.58.59 atau bot.domain.com');
    }

    SC_MULTI_LOGIN_WEBHOOK_URL = `http://${host}/sc1forcr/events/multi-login`;
    const nextVars = loadVars();
    nextVars.SC_MULTI_LOGIN_WEBHOOK_URL = SC_MULTI_LOGIN_WEBHOOK_URL;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ URL webhook SC diset otomatis:\n${SC_MULTI_LOGIN_WEBHOOK_URL}`);
    return sendNginxWebhookMenu(ctx);
  }

  if (state.step === 'bw_notif_group_id') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan group id notif bandwidth dibatalkan.');
    }
    if (!/^-?\d+$/.test(text)) {
      return ctx.reply('Group ID tidak valid. Contoh: -1001234567890');
    }

    BW_NOTIF_GROUP_ID_NUM = Number(text);
    const nextVars = loadVars();
    nextVars.BW_NOTIF_GROUP_ID = String(BW_NOTIF_GROUP_ID_NUM);
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Group ID notif bandwidth tersimpan: ${BW_NOTIF_GROUP_ID_NUM}`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'bw_notif_interval') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan interval notif bandwidth dibatalkan.');
    }

    const parsedMinutes = parseBandwidthIntervalInput(text);
    if (!Number.isFinite(parsedMinutes)) {
      return ctx.reply('Format tidak valid. Contoh: 180, 3 jam, atau 30 menit.');
    }
    if (parsedMinutes < 5 || parsedMinutes > 1440) {
      return ctx.reply('Interval harus antara 5 menit sampai 24 jam (1440 menit).');
    }

    BW_REPORT_INTERVAL_MINUTES = Math.floor(parsedMinutes);
    const nextVars = loadVars();
    nextVars.BW_REPORT_INTERVAL_MINUTES = BW_REPORT_INTERVAL_MINUTES;
    saveVars(nextVars);

    restartBandwidthReportScheduler();

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Interval notif bandwidth disimpan: ${formatBandwidthReportInterval(BW_REPORT_INTERVAL_MINUTES)}`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_url_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const normalized = normalizeHttpUrl(text);
    if (!normalized) {
      return ctx.reply('URL/domain tidak valid. Contoh: `provider.example.com/orderkuota/createpayment`', { parse_mode: 'Markdown' });
    }
    const nextVars = loadVars();
    nextVars.PAYMENT_GATEWAY_BASE_URL = normalized;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Gateway URL disimpan:\n\`${PAYMENT_GATEWAY_BASE_URL}\``, { parse_mode: 'Markdown' });
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_raja_api_key_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    if (text.length < 8) return ctx.reply('API key terlalu pendek.');
    const nextVars = loadVars();
    nextVars.RAJASERVER_API_KEY = text;
    nextVars.LOCAL_PAYMENT_API_KEY = text;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('✅ API Key payment berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_qris_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    if (text.length < 8) return ctx.reply('DATA_QRIS terlalu pendek.');
    let normalizedQris;
    try {
      normalizedQris = validateAndNormalizeQrisData(text);
    } catch (error) {
      return ctx.reply(
        `DATA_QRIS tidak valid: ${error.message}\n\n` +
        'Kirim teks hasil scan QRIS yang dimulai dengan `000201...`, bukan foto QRIS atau link gambar.',
        { parse_mode: 'Markdown' }
      );
    }
    const nextVars = loadVars();
    nextVars.DATA_QRIS = normalizedQris;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('✅ DATA_QRIS berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_dana_qris_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan QRIS DANA dibatalkan.');
    }
    let normalizedQris;
    try {
      normalizedQris = validateAndNormalizeQrisData(text);
    } catch (error) {
      return ctx.reply(
        `QRIS DANA tidak valid: ${error.message}\n\n` +
        'Kirim teks hasil scan QRIS yang dimulai dengan `000201...`.',
        { parse_mode: 'Markdown' }
      );
    }
    const nextVars = loadVars();
    nextVars.DANA_QRIS = normalizedQris;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('QRIS DANA Bisnis berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orkut_username_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    if (text.length < 3) return ctx.reply('ORKUT username terlalu pendek.');
    const nextVars = loadVars();
    nextVars.ORKUT_USERNAME = text;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ ORKUT username berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orkut_token_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    if (text.length < 8) return ctx.reply('ORKUT token terlalu pendek.');
    const nextVars = loadVars();
    nextVars.ORKUT_TOKEN = text;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ ORKUT token berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_merchant_id_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const nextVars = loadVars();
    nextVars.MERCHANT_ID = text;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Merchant ID berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_api_key_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const nextVars = loadVars();
    nextVars.API_KEY = text;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('✅ API Key legacy berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }


  if (state.step === 'payment_gateway_gopay_base_url_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const normalized = normalizeHttpUrl(text);
    if (!normalized) {
      return ctx.reply('URL GoPay tidak valid. Contoh: https://api-gopay.sawargipay.cloud');
    }
    const nextVars = loadVars();
    nextVars.GOPAY_API_BASE_URL = normalized;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('GoPay API Base URL berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_gopay_api_key_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    if (text.length < 8) return ctx.reply('GoPay API key terlalu pendek.');
    const nextVars = loadVars();
    nextVars.GOPAY_API_KEY = text;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('GoPay API Key berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_dana_secret_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan DANA Bridge dibatalkan.');
    }
    if (text.length < 32 || text.length > 256) {
      return ctx.reply('Shared Secret harus 32 sampai 256 karakter.');
    }
    const nextVars = loadVars();
    nextVars.DANA_BRIDGE_SECRET = text;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply('Shared Secret DANA berhasil disimpan.');
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_dana_expire_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan DANA Bridge dibatalkan.');
    }
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      return ctx.reply('Expired QRIS DANA harus angka 1 sampai 180 menit.');
    }
    const nextVars = loadVars();
    nextVars.DANA_BRIDGE_QR_EXPIRE_MINUTES = minutes;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`Expired QRIS DANA disimpan: ${minutes} menit.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_dana_min_topup_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan DANA Bridge dibatalkan.');
    }
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount < 10) {
      return ctx.reply('Minimal topup DANA harus angka dan minimal Rp 10.');
    }
    const nextVars = loadVars();
    nextVars.DANA_BRIDGE_MIN_TOPUP = amount;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`Minimal topup DANA disimpan: Rp ${amount.toLocaleString('id-ID')}.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_expire_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      return ctx.reply('Expired QRIS OrderKuota harus angka 1 sampai 180 menit.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_QR_EXPIRE_MINUTES = minutes;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Expired QRIS OrderKuota disimpan: ${minutes} menit.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_min_topup_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount < 1000) {
      return ctx.reply('Minimal topup OrderKuota harus angka dan minimal Rp 1.000.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_MIN_TOPUP = amount;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Minimal topup OrderKuota disimpan: Rp ${amount.toLocaleString('id-ID')}.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_gopay_expire_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      return ctx.reply('Expired QRIS GoPay harus angka 1 sampai 180 menit.');
    }
    const nextVars = loadVars();
    nextVars.GOPAY_QR_EXPIRE_MINUTES = minutes;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Expired QRIS GoPay disimpan: ${minutes} menit.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_all_qris_expire_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
      return ctx.reply('Masa aktif QRIS harus angka 1 sampai 180 menit.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_QR_EXPIRE_MINUTES = minutes;
    nextVars.GOPAY_QR_EXPIRE_MINUTES = minutes;
    nextVars.DANA_BRIDGE_QR_EXPIRE_MINUTES = minutes;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Masa aktif QRIS semua gateway disimpan: ${minutes} menit.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_gopay_min_topup_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const amount = Number(text);
    if (!Number.isInteger(amount) || amount < 1000) {
      return ctx.reply('Minimal topup GoPay harus angka dan minimal Rp 1.000.');
    }
    const nextVars = loadVars();
    nextVars.GOPAY_MIN_TOPUP = amount;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Minimal topup GoPay disimpan: Rp ${amount.toLocaleString('id-ID')}.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_poll_interval_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) {
      return ctx.reply('Interval polling harus angka 5 sampai 120 detik.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS = seconds;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Interval polling OrderKuota disimpan: ${seconds} detik.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_check_cooldown_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) {
      return ctx.reply('Cooldown tombol cek harus angka 10 sampai 600 detik.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS = seconds;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Cooldown tombol cek disimpan: ${seconds} detik.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_check_max_taps_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const maxTaps = Number(text);
    if (!Number.isInteger(maxTaps) || maxTaps < 1 || maxTaps > 20) {
      return ctx.reply('Maksimal tekan tombol harus angka 1 sampai 20 kali.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_CHECK_MAX_TAPS = maxTaps;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Maksimal tekan tombol disimpan: ${maxTaps}x per transaksi.`);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'payment_gateway_orderkuota_poll_window_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan payment gateway dibatalkan.');
    }
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
      return ctx.reply('Durasi stop polling harus angka 1 sampai 30 menit.');
    }
    const nextVars = loadVars();
    nextVars.ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES = minutes;
    saveVars(nextVars);
    reloadRuntimePaymentConfig();
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Durasi auto-stop polling disimpan: ${minutes} menit.`);
    return sendAdminToolsMenu(ctx);
  }


  if (state.step === 'delete_all_input_host') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Hapus semua akun dibatalkan.');
    }
    const host = normalizeSyncHost(text);
    if (!host) {
      return ctx.reply('Host tidak valid. Contoh: id1.prem-1forcr.shop');
    }
    state.host = host;
    state.step = 'delete_all_input_token';
    return ctx.reply('Masukkan key/token server tersebut.');
  }

  if (state.step === 'delete_all_input_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Hapus semua akun dibatalkan.');
    }
    if (text.length < 8) {
      return ctx.reply('Token tidak valid. Minimal 8 karakter.');
    }
    state.token = text;
    state.step = 'delete_all_input_type';
    return ctx.reply('Pilih tipe yang dihapus: ketik ssh atau zivpn.');
  }

  if (state.step === 'delete_all_input_type') {
    const text = String(ctx.message.text || '').trim().toLowerCase();
    if (text === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Hapus semua akun dibatalkan.');
    }
    if (text !== 'ssh' && text !== 'zivpn') {
      return ctx.reply('Tipe tidak valid. Ketik ssh atau zivpn.');
    }
    state.type = text;
    state.step = 'delete_all_confirm';
    return ctx.reply(
      'Konfirmasi hapus semua akun ' + text.toUpperCase() + ' di host ' + state.host + '\n' +
      'Ketik YA HAPUS SEMUA untuk lanjut.'
    );
  }

  if (state.step === 'delete_all_confirm') {
    const text = String(ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Hapus semua akun dibatalkan.');
    }
    if (text !== 'YA HAPUS SEMUA') {
      return ctx.reply('Konfirmasi salah. Ketik persis: YA HAPUS SEMUA atau batal.');
    }

    const requestServer = {
      domain: state.host,
      sync_host: state.host,
      sync_port: 8789,
      sync_endpoint: '/internal/account-summary',
      auth: state.token
    };
    const type = state.type;
    delete userState[ctx.chat.id];
    await ctx.reply('Memproses hapus semua akun...');
    try {
      const resDelete = await deleteAllTunnelAccounts(requestServer, type);
      return ctx.reply(
        'Selesai hapus semua ' + type.toUpperCase() + '.\n' +
        'Host: ' + requestServer.sync_host + '\n' +
        'Terhapus DB: ' + resDelete.deletedDb + '\n' +
        'Terhapus ZIVPN config: ' + resDelete.deletedZivpn
      );
    } catch (err) {
      return ctx.reply('Gagal hapus semua akun: ' + err.message);
    }
  }

  if (state.step === 'migrate_input_source_host') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Migrasi user dibatalkan.');
    }

    const sourceHost = normalizeSyncHost(text);
    if (!sourceHost) {
      return ctx.reply('Host sumber tidak valid. Contoh: id1.prem-1forcr.shop');
    }

    state.sourceHost = sourceHost;
    state.step = 'migrate_input_source_token';
    return ctx.reply(
      `Host sumber: ${sourceHost}\n` +
      'Sekarang masukkan token (`servers.key`) server sumber.\n' +
      'Ketik "batal" untuk membatalkan.',
      { parse_mode: 'Markdown' }
    );
  }

  if (state.step === 'migrate_input_source_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Migrasi user dibatalkan.');
    }

    const sourceToken = String(text || '').trim();
    if (sourceToken.length < 8) {
      return ctx.reply('Token sumber tidak valid. Minimal 8 karakter.');
    }

    state.sourceToken = sourceToken;
    state.step = 'migrate_input_target_host';
    return ctx.reply(
      'Masukkan host server tujuan (contoh: id2.prem-1forcr.shop).\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  }

  if (state.step === 'migrate_input_target_host') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Migrasi user dibatalkan.');
    }

    const targetHost = normalizeSyncHost(text);
    if (!targetHost) {
      return ctx.reply('Host tujuan tidak valid. Contoh: id2.prem-1forcr.shop');
    }

    state.targetHost = targetHost;
    state.step = 'migrate_input_target_token';
    return ctx.reply(
      `Host tujuan: ${targetHost}\n` +
      'Sekarang masukkan token (`servers.key`) server tujuan.\n' +
      'Ketik "batal" untuk membatalkan.',
      { parse_mode: 'Markdown' }
    );
  }

  if (state.step === 'migrate_input_target_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Migrasi user dibatalkan.');
    }

    const targetToken = String(text || '').trim();
    if (targetToken.length < 8) {
      return ctx.reply('Token tujuan tidak valid. Minimal 8 karakter.');
    }

    state.targetToken = targetToken;
    state.step = 'migrate_input_limit';
    return ctx.reply(
      'Masukkan jumlah user yang dipindahkan (1-500).\n' +
      'Data diambil dari urutan paling bawah (row terbaru).'
    );
  }

  if (state.step === 'migrate_input_limit') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Migrasi user dibatalkan.');
    }

    if (!/^\d+$/.test(text)) {
      return ctx.reply('Jumlah user harus angka. Contoh: 50');
    }

    const limit = Math.max(1, Math.min(500, Number(text)));
    const type = normalizeMigrationType(state.migrationType);
    if (!isSupportedMigrationType(type)) {
      delete userState[ctx.chat.id];
      return ctx.reply(
        `Migrasi ${String(type || '').toUpperCase()} belum didukung saat ini.\n` +
        'Saat ini migrasi yang tersedia: SSH dan UDP ZIVPN.'
      );
    }
    const sourceHost = normalizeSyncHost(state.sourceHost || '');
    const sourceToken = String(state.sourceToken || '').trim();
    const targetHost = normalizeSyncHost(state.targetHost || '');
    const targetToken = String(state.targetToken || '').trim();

    if (!type || !sourceHost || !sourceToken || !targetHost || !targetToken) {
      delete userState[ctx.chat.id];
      return ctx.reply('Data migrasi tidak valid. Ulangi dari menu admin.');
    }

    const sourceServer = {
      id: 0,
      nama_server: sourceHost,
      domain: sourceHost,
      sync_host: sourceHost,
      sync_port: 8789,
      sync_endpoint: '/internal/account-summary',
      auth: sourceToken
    };

    const targetServer = {
      id: 0,
      nama_server: targetHost,
      domain: targetHost,
      sync_host: targetHost,
      sync_port: 8789,
      sync_endpoint: '/internal/account-summary',
      auth: targetToken
    };

    await ctx.reply('Memproses migrasi user, mohon tunggu...');

    try {
      const result = await migrateTunnelAccountsBetweenServers(sourceServer, targetServer, type, limit);

      delete userState[ctx.chat.id];
      const header =
        'Migrasi selesai.\n\n' +
        `Jenis akun: ${result.type.toUpperCase()}\n` +
        `Server sumber: ${sourceHost}\n` +
        `Server tujuan: ${targetHost}\n` +
        `Diminta: ${limit}\n` +
        `Diambil: ${result.exported}\n` +
        `Berhasil import: ${result.imported}\n` +
        `Terlewat: ${result.skipped}\n` +
        `Terhapus dari sumber: ${result.deleted}`;

      const details = Array.isArray(result.migratedAccounts) ? result.migratedAccounts : [];
      if (details.length === 0) {
        return ctx.reply(header);
      }

      const detailLines = details.map((acc, i) => {
        const remainDays = acc.dateExp ? calcRemainingDaysFromDateExp(acc.dateExp) : Math.max(0, Number(acc.days || 0));
        const pass = acc.password || '-';
        const exp = acc.dateExp || '-';
        return `${i + 1}. ${acc.username || '-'} | pass: ${pass} | sisa aktif: ${remainDays} hari | exp: ${exp}`;
      });

      const fullMessage = `${header}\n\nDetail akun migrasi:\n${detailLines.join('\n')}`;
      if (fullMessage.length <= 3900) {
        return ctx.reply(fullMessage);
      }

      await ctx.reply(header);
      let chunk = 'Detail akun migrasi:\n';
      for (const line of detailLines) {
        const next = `${chunk}${line}\n`;
        if (next.length > 3600) {
          await ctx.reply(chunk.trimEnd());
          chunk = `${line}\n`;
        } else {
          chunk = next;
        }
      }
      if (chunk.trim()) {
        await ctx.reply(chunk.trimEnd());
      }
      return;
    } catch (migrateErr) {
      delete userState[ctx.chat.id];
      logger.error(`Migrasi user gagal: ${migrateErr.message}`);
      return ctx.reply(`Migrasi gagal: ${migrateErr.message}`);
    }
  }

  if (state.step === 'admin_contact_whatsapp') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan nomor WhatsApp dibatalkan.');
    }

    const normalized = text.replace(/\D/g, '');
    if (!/^\d{10,16}$/.test(normalized)) {
      return ctx.reply('Nomor tidak valid. Gunakan 10-16 digit angka, contoh: 6281234567890');
    }

    ADMIN_WHATSAPP = normalized;
    const nextVars = loadVars();
    nextVars.ADMIN_WHATSAPP = ADMIN_WHATSAPP;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply('✅ Nomor WhatsApp admin tersimpan: ' + ADMIN_WHATSAPP);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'admin_contact_telegram') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan username Telegram dibatalkan.');
    }

    const normalized = text.replace(/^@+/, '').trim();
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(normalized)) {
      return ctx.reply('Username Telegram tidak valid. Gunakan 5-32 karakter (huruf, angka, underscore).');
    }

    ADMIN_TELEGRAM = normalized;
    const nextVars = loadVars();
    nextVars.ADMIN_TELEGRAM = ADMIN_TELEGRAM;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply('✅ Username Telegram admin tersimpan: @' + ADMIN_TELEGRAM);
    return sendAdminToolsMenu(ctx);
  }
  if (state.step === 'reseller_terms_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan syarat reseller dibatalkan.');
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 1 || !/^\d+$/.test(parts[0])) {
      return ctx.reply('Format salah. Contoh: 30000');
    }

    const minTopup = parseInt(parts[0], 10);
    if (minTopup < 0) {
      return ctx.reply('Nilai tidak boleh negatif.');
    }

    const current = loadResellerTerms();
    const saved = saveResellerTerms({
      min_accounts: current.min_accounts,
      min_topup: minTopup,
      join_topup_min: current.join_topup_min
    });
    delete userState[ctx.chat.id];
    await ctx.reply(
      'Syarat reseller berhasil diperbarui:\n' +
      `Minimal top up per bulan: ${formatRupiah(saved.min_topup)}`
    );
    try {
      const resellers = listResellersSync();
      const notice =
        `📢 *INFO SYARAT RESELLER DIUBAH*\n\n` +
        `Minimal top up per bulan sekarang: ${formatRupiah(saved.min_topup)}\n\n` +
        `Cek total top up bulan ini via command /resellerstats.\n` +
        `Harap penuhi syarat agar status reseller tetap aktif.`;
      for (const resellerId of resellers) {
        await bot.telegram.sendMessage(resellerId, notice, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      logger.error('Gagal kirim notifikasi perubahan syarat reseller:', e.message);
    }
    return sendAdminMenu(ctx);
  }

  if (state.step === 'reseller_join_topup_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan minimal topup jadi reseller dibatalkan.');
    }

    if (!/^\d+$/.test(text)) {
      return ctx.reply('Format salah. Contoh: 18000');
    }

    const minJoinTopup = parseInt(text, 10);
    if (minJoinTopup < 0) {
      return ctx.reply('Nilai tidak boleh negatif.');
    }

    const current = loadResellerTerms();
    const saved = saveResellerTerms({
      min_accounts: current.min_accounts,
      min_topup: current.min_topup,
      join_topup_min: minJoinTopup
    });
    delete userState[ctx.chat.id];
    await ctx.reply(
      'Minimal topup jadi reseller berhasil diperbarui:\n' +
      `Topup jadi reseller: ${formatRupiah(saved.join_topup_min)}`
    );
    return sendAdminMenu(ctx);
  }

  if (state.step === 'edit_auth_by_text') {
    const input = ctx.message.text.trim();
    if (input.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit auth dibatalkan.');
    }

    const parts = input.split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) {
      return ctx.reply('Format salah. Gunakan: <id_server> <auth_baru>. Contoh: 12 myNewAuth123');
    }

    const serverId = parseInt(parts[0], 10);
    const authBaru = parts.slice(1).join(' ').trim();
    if (!authBaru) {
      return ctx.reply('Auth baru tidak boleh kosong.');
    }

    db.run('UPDATE Server SET auth = ? WHERE id = ?', [authBaru, serverId], function (err) {
      if (err) {
        logger.error('? Gagal update auth via text:', err.message);
        return ctx.reply('? Gagal mengupdate auth server.');
      }
      if (this.changes === 0) {
        return ctx.reply('Server tidak ditemukan. Cek lagi ID server.');
      }

      delete userState[ctx.chat.id];
      ctx.reply('? Auth server ID ' + serverId + ' berhasil diubah menjadi: ' + authBaru);
    });
    return;
  }

  if (state.step === 'edit_total_batas_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit total+batas dibatalkan.');
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      return ctx.reply('Format salah. Contoh: 10 50');
    }

    const total = parseInt(parts[0], 10);
    const batas = parseInt(parts[1], 10);
    if (total < 0 || batas < 0) {
      return ctx.reply('Nilai tidak boleh negatif.');
    }
    if (total > batas) {
      return ctx.reply('Total tidak boleh lebih besar dari batas.');
    }

    const serverId = state.serverId;
    db.run(
      'UPDATE Server SET total_create_akun = ?, batas_create_akun = ? WHERE id = ?',
      [total, batas, serverId],
      function (err) {
        if (err) {
          logger.error('❌ Gagal update total+batas:', err.message);
          return ctx.reply('❌ Gagal mengupdate total+batas.');
        }
        delete userState[ctx.chat.id];
        ctx.reply(`✅ Total & batas berhasil diupdate.\nTotal: ${total}\nBatas: ${batas}`);
      }
    );
    return;
  }

  if (state.step === 'edit_bw_limit_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Set limit bandwidth dibatalkan.');
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply('Format salah. Contoh: 25 8');
    }

    const limitTb = Number(parts[0]);
    const avgGb = Number(parts[1]);
    if (!Number.isFinite(limitTb) || limitTb < 0) {
      return ctx.reply('Limit TB harus angka >= 0.');
    }
    if (!Number.isFinite(avgGb) || avgGb <= 0) {
      return ctx.reply('Rata-rata GB/user/hari harus angka > 0.');
    }

    const serverId = state.serverId;
    db.run(
      'UPDATE Server SET bandwidth_limit_tb = ?, bandwidth_user_daily_gb = ? WHERE id = ?',
      [limitTb, avgGb, serverId],
      async function (err) {
        if (err) {
          logger.error('❌ Gagal update limit bandwidth:', err.message);
          return ctx.reply('❌ Gagal update limit bandwidth server.');
        }
        if (this.changes === 0) {
          delete userState[ctx.chat.id];
          return ctx.reply('Server tidak ditemukan.');
        }

        try {
          await syncServerUsageFromTunnel('edit_bw_limit_input', { serverId, force: true });
        } catch (syncErr) {
          logger.warn(`Sync setelah edit_bw_limit_input gagal: ${syncErr.message}`);
        }

        delete userState[ctx.chat.id];
        return ctx.reply(
          `✅ Limit bandwidth server berhasil diupdate.\n` +
          `- Limit bulanan: ${limitTb.toFixed(2)} TB\n` +
          `- Estimasi/user/hari: ${avgGb.toFixed(2)} GB`
        );
      }
    );
    return;
  }

  if (state.step === 'add_reseller_userid') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('ID harus angka. Masukkan ulang:');
    }

    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    if (resellerList.includes(targetId)) {
      delete userState[ctx.chat.id];
      await ctx.reply(`User dengan ID ${targetId} sudah menjadi reseller.`);
      return sendAdminResellerMenu(ctx);
    }

    fs.appendFileSync(resselFilePath, `${targetId}\n`);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ User dengan ID ${targetId} berhasil dijadikan reseller.`);
    return sendAdminResellerMenu(ctx);
  }

  if (state.step === 'del_reseller_userid') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('ID harus angka. Masukkan ulang:');
    }

    if (!fs.existsSync(resselFilePath)) {
      delete userState[ctx.chat.id];
      await ctx.reply('📁 File reseller belum dibuat.');
      return sendAdminResellerMenu(ctx);
    }

    const fileContent = fs.readFileSync(resselFilePath, 'utf8');
    const resellerList = fileContent.split('\n').filter(line => line.trim() !== '' && line.trim() !== targetId);
    fs.writeFileSync(resselFilePath, resellerList.join('\n') + (resellerList.length ? '\n' : ''));

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ User dengan ID ${targetId} berhasil dihapus dari daftar reseller.`);
    return sendAdminResellerMenu(ctx);
  }

  if (state.step === 'reseller_restore_input') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('❌ ID Telegram harus angka. Coba lagi.');
    }

    addReseller(targetId);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Reseller ${targetId} berhasil diaktifkan kembali.`);

    try {
      await bot.telegram.sendMessage(
        targetId,
        '✅ Status reseller Anda telah diaktifkan kembali oleh admin.'
      );
    } catch (e) {
      logger.warn(`Gagal kirim notif restore reseller ke ${targetId}:`, e.message);
    }

    return;
  }

  if (state.step === 'add_server_domain') {
  state.data.domain = ctx.message.text.trim();
  state.step = 'add_server_auth';
  return ctx.reply('🔑 Masukkan auth server:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_auth') {
  state.data.auth = ctx.message.text.trim();
  state.step = 'add_server_harga';
  return ctx.reply('💰 Masukkan harga server (angka):', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_harga') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Harga harus angka. Masukkan ulang:');
  }
  state.data.harga = parseInt(ctx.message.text);
  state.step = 'add_server_nama';
  return ctx.reply('📝 Masukkan nama server:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_nama') {
  state.data.nama_server = ctx.message.text.trim();
  state.step = 'add_server_quota';
  return ctx.reply('📊 Masukkan quota per hari (GB):', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_quota') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Quota harus angka. Masukkan ulang:');
  }
  state.data.quota = parseInt(ctx.message.text);
  state.step = 'add_server_iplimit';
  return ctx.reply('📶 Masukkan IP limit:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_iplimit') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ IP limit harus angka. Masukkan ulang:');
  }
  state.data.iplimit = parseInt(ctx.message.text);
  state.step = 'add_server_batas';
  return ctx.reply('🔢 Masukkan batas create akun:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_batas') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Batas create akun harus angka. Masukkan ulang:');
  }
  state.data.batas_create_akun = parseInt(ctx.message.text);

  // 🔥 INSERT DB (SATU-SATUNYA TEMPAT SIMPAN)
  const d = state.data;
  const service = state.service || 'ssh';

  db.run(
    "INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)",
    [
      d.domain,
      d.auth,
      d.harga,
      d.nama_server,
      d.quota,
      d.iplimit,
      d.batas_create_akun,
      service === 'zivpn' ? 1 : 0,
      'ssh'
    ],
    (err) => {
      if (err) {
        ctx.reply('❌ Gagal menyimpan server.');
      } else {
        ctx.reply(`✅ Server *${d.nama_server}* berhasil ditambahkan.`, {
          parse_mode: 'Markdown'
        });
      }
    }
  );

  delete userState[ctx.chat.id];
  return;
}

  if (!state) return; 
    const text = ctx.message.text.trim();

  // =================== HAPUS SALDO ===================
  if (state && state.step === 'hapus_saldo_userid') {
    const targetUserId = text;
    
    // Validasi input
    if (!/^\d+$/.test(targetUserId)) {
      return ctx.reply('❌ *ID Telegram harus angka!*\n\nMasukkan ulang ID user:', { parse_mode: 'Markdown' });
    }
    
    // Cek apakah user ada
    db.get('SELECT user_id, saldo FROM users WHERE user_id = ?', [targetUserId], (err, user) => {
      if (err) {
        logger.error('❌ Error cek user untuk hapus saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }
      
      if (!user) {
        return ctx.reply(`❌ *User dengan ID ${targetUserId} tidak ditemukan!*\n\nMasukkan ID user lain atau ketik "batal" untuk membatalkan.`, { 
          parse_mode: 'Markdown' 
        });
      }
      
      // Simpan ke state dan lanjut ke input jumlah
      state.targetUserId = targetUserId;
      state.currentSaldo = user.saldo;
      state.step = 'hapus_saldo_amount';
      
      ctx.reply(
        `👤 *User ditemukan:*\n` +
        `• ID: \`${targetUserId}\`\n` +
        `• Saldo saat ini: *Rp ${user.saldo.toLocaleString('id-ID')}*\n\n` +
        `💰 *Masukkan jumlah saldo yang akan dihapus:*\n` +
        `(atau ketik "semua" untuk hapus semua saldo)`,
        { parse_mode: 'Markdown' }
      );
    });
    return;
  }
  
  if (state && state.step === 'hapus_saldo_amount') {
    const adminId = ctx.from.id;
    const targetUserId = state.targetUserId;
    const currentSaldo = state.currentSaldo;
    let amount;
    
    // Cek jika input "semua" atau "all"
    if (text.toLowerCase() === 'semua' || text.toLowerCase() === 'all') {
      amount = currentSaldo;
    } else {
      // Validasi angka
      amount = parseInt(text, 10);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ *Jumlah harus angka positif lebih dari 0!*\n\nMasukkan ulang jumlah:');
      }
      
      // Cek apakah saldo mencukupi
      if (amount > currentSaldo) {
        return ctx.reply(
          `❌ *Jumlah melebihi saldo user!*\n\n` +
          `Saldo user: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
          `Jumlah hapus: Rp ${amount.toLocaleString('id-ID')}\n` +
          `Kekurangan: Rp ${(amount - currentSaldo).toLocaleString('id-ID')}\n\n` +
          `Masukkan jumlah yang lebih kecil atau ketik "semua" untuk hapus semua saldo.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
    
    // Konfirmasi
    state.amountToRemove = amount;
    state.step = 'hapus_saldo_confirm';
    
    await ctx.reply(
      `⚠️ *KONFIRMASI HAPUS SALDO*\n\n` +
      `👤 User ID: \`${targetUserId}\`\n` +
      `💰 Saldo saat ini: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
      `🗑️ Jumlah hapus: Rp ${amount.toLocaleString('id-ID')}\n` +
      `📉 Saldo setelahnya: Rp ${(currentSaldo - amount).toLocaleString('id-ID')}\n\n` +
      `Apakah Anda yakin ingin menghapus saldo ini?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Ya, Hapus Saldo', callback_data: 'confirm_hapus_saldo' }],
            [{ text: '❌ Batal', callback_data: 'cancel_hapus_saldo' }]
          ]
        }
      }
    );
    return;
  }
//////
  if (state && state.step === "edit_nama_input") {
    const serverId = state.serverId;
    const namaBaru = ctx.message.text.trim();

    db.run(
      "UPDATE Server SET nama_server = ? WHERE id = ?",
      [namaBaru, serverId],
      (err) => {
        if (err) {
          logger.error("❌ Gagal update nama server:", err.message);
          return ctx.reply("⚠️ Gagal mengupdate nama server.");
        }

        ctx.reply(
          `✅ *Nama server berhasil diperbarui!*\n\n` +
          `🆔 ID Server: ${serverId}\n` +
          `🏷️ Nama Baru: *${namaBaru}*`,
          { parse_mode: "Markdown" }
        );

        logger.info(`Nama server ID ${serverId} diubah menjadi ${namaBaru}`);

        delete userState[ctx.chat.id];
      }
    );

    return;
  }
//////
  if (state.step === 'cek_saldo_userid') {
    const targetId = ctx.message.text.trim();
    db.get('SELECT saldo, saldo_ppob FROM users WHERE user_id = ?', [targetId], (err, row) => {
      if (err) {
        logger.error('❌ Gagal mengambil saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil data saldo.');
      }

      if (!row) {
        return ctx.reply(`⚠️ User dengan ID ${targetId} belum terdaftar di database.`);
      }

      const saldoVpn = Number(row.saldo || 0);
      const saldoPpob = Number(row.saldo_ppob || 0);
      ctx.reply(
        `💰 Saldo user ${targetId}\n\n` +
        `Saldo VPN: Rp${saldoVpn.toLocaleString('id-ID')}\n` +
        `Saldo PPOB: Rp${saldoPpob.toLocaleString('id-ID')}`
      );
      logger.info(`Admin ${ctx.from.id} mengecek saldo user ${targetId}: VPN Rp${saldoVpn}, PPOB Rp${saldoPpob}`);
      delete userState[ctx.from.id];
    });
  }
///////
    if (state.step.startsWith('username_trial_')) {
  const username = text;

  // Validasi username
  if (!/^[a-z0-9]{3,20}$/.test(username)) {
    return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
  }
/////////

  let isRessel = false;
  try {
    isRessel = await isUserReseller(ctx.from.id);
  } catch (err) {
    logger.warn('Gagal cek reseller untuk trial, lanjut sebagai user biasa:', err.message);
    isRessel = false;
  }

  // Cek jika bukan reseller, maka periksa apakah sudah pernah trial hari ini
  if (!isRessel) {
    const sudahPakai = await checkTrialAccess(ctx.from.id);
    if (sudahPakai) {
      return ctx.reply('❌ *Anda sudah menggunakan fitur trial hari ini. Silakan coba lagi besok.*', { parse_mode: 'Markdown' });
    }
  }

    // Lanjut buat trial
// ===== EKSEKUSI SETELAH PILIH SERVER =====
const { action, type, serverId } = state;
delete userState[ctx.chat.id];

let msg;

// ===== TRIAL AKUN =====
if (action === 'trial') {

  // 🔹 generate data trial
  const username = `trial${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  const exp = '1';       // fallback untuk endpoint lama
  const quota = String(TRIAL_QUOTA_GB);
  const timelimit = TRIAL_TIMELIMIT;
  const iplimit = '1';  // 1 IP
  const telegramUserId = String(ctx.from?.id || '');
  const telegramChatId = String(ctx.chat?.id || '');

  let msg;

  if (type === 'ssh') {
    const password = '1';
    msg = await trialssh(username, password, exp, iplimit, serverId, telegramUserId, telegramChatId, quota, timelimit);

  } else if (type === 'vmess') {
    msg = await trialvmess(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId, timelimit);

  } else if (type === 'vless') {
    msg = await trialvless(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId, timelimit);

  } else if (type === 'trojan') {
    msg = await trialtrojan(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId, timelimit);

  } else if (type === 'zivpn') {
    msg = await trialzivpn(serverId, telegramUserId, telegramChatId, quota, timelimit);
  } else if (type === 'udp_http') {
    const password = '1';
    msg = await trialudphttp(username, password, exp, iplimit, serverId, telegramUserId, telegramChatId, quota, timelimit);
  }

  if (!isRessel) {
    await saveTrialAccess(ctx.from.id);
  }
  await ctx.reply(msg, { parse_mode: 'Markdown' });
  return;
}

  return;
}

    if (state.step.startsWith('username_unlock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: unlockvmess,
        vless: unlockvless,
        trojan: unlocktrojan,
        shadowsocks: unlockshadowsocks,
        ssh: unlockssh,
        udp_http: unlockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil unlock oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
    if (state.step.startsWith('username_lock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: lockvmess,
        vless: lockvless,
        trojan: locktrojan,
        shadowsocks: lockshadowsocks,
        ssh: lockssh,
        udp_http: lockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil di kunci oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step.startsWith('username_del_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: delvmess,
        vless: delvless,
        trojan: deltrojan,
        ssh: delssh,
        udp_http: deludphttp,
        zivpn: delzivpn
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });

      const delResultText = String(msg || '').toLowerCase();
      const deleteFailed = /gagal|error|failed|tidak\s+ditemukan|not\s+found/.test(delResultText);
      if (!deleteFailed) {
        const serverRow = await new Promise((resolve) => {
          db.get('SELECT nama_server, domain FROM Server WHERE id = ?', [serverId], (e, r) => {
            if (e) return resolve(null);
            resolve(r || null);
          });
        });

        await notifyGroupAccountDeleted({
          action: 'admin_or_reseller_delete',
          actorId: ctx.from.id,
          actorUsername: ctx.from.username || '',
          targetUserId: '-',
          accountUsername: username,
          service: String(type || '-').toUpperCase(),
          serverName: (serverRow && (serverRow.nama_server || serverRow.domain)) || ('ID ' + serverId),
          refund: 0,
          remainingDays: 0,
          note: 'Hapus akun via menu del reseller/admin'
        });
      }

      logger.info(`? Akun ${type} berhasil dihapus oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step === 'renew_lookup_username') {
    const input = ctx.message.text.trim();
    if (input.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Perpanjang akun dibatalkan.');
    }
    if (!/^[a-z0-9]{3,20}$/.test(input)) {
      return ctx.reply('❌ Username tidak valid. Gunakan huruf kecil dan angka (3-20 karakter).');
    }

    const candidates = await findRenewCandidatesByUsername(ctx, input);
    if (!candidates || candidates.length === 0) {
      return ctx.reply(
        `Akun dengan username "${input}" tidak ditemukan.\n` +
        'Kirim ulang username lain atau ketik `batal`.',
        { parse_mode: 'Markdown' }
      );
    }

    userState[ctx.chat.id] = userState[ctx.chat.id] || {};
    userState[ctx.chat.id].renew_lookup = {
      username: input,
      rows: candidates,
      pageSize: 8
    };

    if (candidates.length === 1) {
      return sendRenewAccountDetail(ctx, 0);
    }
    return renderRenewLookupList(ctx, 0);
  }
  if (state.step.startsWith('username_')) {
    state.username = text;

    if (!state.username) {
      return ctx.reply('❌ *Username tidak valid. Masukkan username yang valid| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (state.username.length < 4 || state.username.length > 20) {
      return ctx.reply('❌ *Username harus terdiri dari 4 hingga 20 karakter| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (/[A-Z]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh menggunakan huruf kapital. Gunakan huruf kecil saja| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (/[^a-z0-9]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh mengandung karakter khusus atau spasi. Gunakan huruf kecil dan angka saja| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    const { type, action } = state;
    if (action === 'create') {
      if (!isStrongCreateUsername(state.username)) {
        return ctx.reply(' *Username harus mengandung minimal 4 huruf dan 4 angka dengan huruf kecil semua.*', { parse_mode: 'Markdown' });
      }
      if (type === 'ssh' || type === 'udp_http') {
        state.step = `password_${state.action}_${state.type}`;
        await ctx.reply('🔑 *Masukkan password:*', { parse_mode: 'Markdown' });
      } else {
        state.step = `exp_${state.action}_${state.type}`;
        const expPrompt = normalizeCreatePriceMode(state.priceMode) === '30hari'
          ? '📆 *Paket 30 hari dipilih. Ketik 30 untuk melanjutkan:*'
          : '⏳ *Masukkan masa aktif (hari):*';
        await ctx.reply(expPrompt, { parse_mode: 'Markdown' });
      }
    } else if (action === 'renew') {
      state.step = `exp_${state.action}_${state.type}`;
      await ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }
  } else if (state.step.startsWith('password_')) {
    state.password = ctx.message.text.trim();
    if (!state.password) {
      return ctx.reply('❌ *Password tidak valid. Masukkan password yang valid| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    if (state.password.length < 3) {
      return ctx.reply('❌ *Password harus terdiri dari minimal 3 karakter| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    if (/[^a-zA-Z0-9]/.test(state.password)) {
      return ctx.reply('❌ *Password tidak boleh mengandung karakter khusus atau spasi| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    state.step = `exp_${state.action}_${state.type}`;
    const expPrompt = state.action === 'create' && normalizeCreatePriceMode(state.priceMode) === '30hari'
      ? '📆 *Paket 30 hari dipilih. Ketik 30 untuk melanjutkan:*'
      : '⏳ *Masukkan masa aktif (hari):*';
    await ctx.reply(expPrompt, { parse_mode: 'Markdown' });
  } else if (state.step.startsWith('exp_')) {
    const expInput = ctx.message.text.trim();
    if (!/^\d+$/.test(expInput)) {
      return ctx.reply('❌ *Masa aktif tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
// Cek hanya angka
if (!/^\d+$/.test(expInput)) {
  return ctx.reply('❌ *Masa aktif hanya boleh angka, contoh: 30*', { parse_mode: 'Markdown' });
}

const exp = parseInt(expInput, 10);

if (isNaN(exp) || exp <= 0) {
  return ctx.reply('❌ *Masa aktif tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
}

if (exp > 365) {
  return ctx.reply('❌ *Masa aktif tidak boleh lebih dari 365 hari.*', { parse_mode: 'Markdown' });
}
if (state.action === 'create' && normalizeCreatePriceMode(state.priceMode) === '30hari' && exp !== 30) {
  return ctx.reply('❌ *Paket 30 hari hanya bisa memakai masa aktif 30 hari.* Ketik 30 untuk melanjutkan.', { parse_mode: 'Markdown' });
}
    state.exp = exp;

    db.get('SELECT id, quota, iplimit, domain, nama_server FROM Server WHERE id = ?', [state.serverId], async (err, server) => {
      if (err) {
        logger.error('⚠️ Error fetching server details:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
      }

      if (!server) {
        return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      state.quotaPerDay = Number(server.quota || 0);
      state.quota = calculateDurationQuotaGb(state.quotaPerDay, exp);
      if (state.action === 'renew' && Number(state.accountIpLimit) > 0) {
        state.iplimit = Number(state.accountIpLimit);
      } else if (state.action === 'create') {
        const selectedPkg = Number(state.selectedIpPackage || 1);
        try {
          state.iplimit = await getServerIpLimitRule(Number(state.serverId), state.type, selectedPkg);
        } catch (limitErr) {
          logger.warn(`Gagal ambil limit IP rule server ${server.id}: ${limitErr.message}`);
          state.iplimit = getDefaultServerIpLimit(state.type, selectedPkg);
        }
      } else {
        state.iplimit = state.selectedIpPackage || server.iplimit;
      }
      state.serverDomain = server.domain || '';
      state.serverName = server.nama_server || server.domain || '';

      const { username, password, quota, iplimit, serverId, type, action } = state;
      let usedPassword = password || '';
      let msg;

      db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
        if (err) {
          logger.error('⚠️ Error fetching server price:', err.message);
          return ctx.reply('❌ *Terjadi kesalahan saat mengambil harga server.*', { parse_mode: 'Markdown' });
        }

        if (!server) {
          return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
        }
        if (Number(server.is_active ?? 1) !== 1) {
          return ctx.reply('❌ *Server ini sedang nonaktif dan tidak bisa dipilih.*', { parse_mode: 'Markdown' });
        }
        if (!isServerProtocolEnabled(server, type)) {
          return ctx.reply(`❌ *Protocol ${type.toUpperCase()} sedang nonaktif untuk server ini.*`, { parse_mode: 'Markdown' });
        }

        const isResellerUser = await isUserReseller(ctx.from.id).catch(() => false);
        const selectedPackage = (() => {
          if (state.action === 'renew') {
            const renewPkg = Number(
              state.accountIpPackage ||
              state.selectedIpPackage ||
              inferIpPackageByAccount(
                state.type,
                state.accountIpLimit || state.iplimit || server.iplimit
              )
            );
            return renewPkg === 2 ? 2 : 1;
          }
          return Number(state.selectedIpPackage || 1) === 2 ? 2 : 1;
        })();
        const createPriceMode = state.action === 'create' ? normalizeCreatePriceMode(state.priceMode) : 'daily';
        if (state.action === 'create' && createPriceMode === 'daily' && !isServerDailyPriceEnabled(server)) {
          return ctx.reply('❌ *Harga harian sedang nonaktif untuk server ini.*', { parse_mode: 'Markdown' });
        }
        if (state.action === 'create' && createPriceMode === '30hari' && !isServerMonthlyPriceEnabled(server)) {
          return ctx.reply('❌ *Harga 30 hari sedang nonaktif untuk server ini.*', { parse_mode: 'Markdown' });
        }
        if (state.action === 'create' && createPriceMode === '30hari' && Number(state.exp || 0) !== 30) {
          return ctx.reply('❌ *Paket 30 hari hanya bisa memakai masa aktif 30 hari.*', { parse_mode: 'Markdown' });
        }

        const hargaPerHari = getEffectiveServerPackagePrice(server, isResellerUser, selectedPackage);
        const totalHarga = state.action === 'create'
          ? getCreateBillingPrice(server, isResellerUser, selectedPackage, createPriceMode, state.exp)
          : hargaPerHari * state.exp;
        const harga = getStoredAccountPricePerDay(totalHarga, state.exp, hargaPerHari);
        db.get('SELECT saldo FROM users WHERE user_id = ?', [ctx.from.id], async (err, user) => {
          if (err) {
            logger.error('⚠️ Kesalahan saat mengambil saldo pengguna:', err.message);
            return ctx.reply('❌ *Terjadi kesalahan saat mengambil saldo pengguna.*', { parse_mode: 'Markdown' });
          }

          if (!user) {
            return ctx.reply('❌ *Pengguna tidak ditemukan.*', { parse_mode: 'Markdown' });
          }

          const saldo = user.saldo;
          if (saldo < totalHarga) {
            return ctx.reply('❌ *Saldo Anda tidak mencukupi untuk melakukan transaksi ini.*', { parse_mode: 'Markdown' });
          }

          const reserveResult = await reserveAccountChargeAtomic(ctx.from.id, totalHarga, type, action);
          if (!reserveResult.ok) {
            logger.error(`Gagal reserve saldo user ${ctx.from.id}, type: ${type}, server: ${serverId}, err: ${reserveResult.error}`);
            if (reserveResult.error === 'SALDO_NOT_ENOUGH_OR_USER_NOT_FOUND') {
              return ctx.reply('❌ *Saldo tidak cukup (kemungkinan sudah terpakai transaksi lain).* Silakan cek saldo Anda lalu coba lagi.', { parse_mode: 'Markdown' });
            }
            return ctx.reply('❌ *Terjadi kesalahan saat memproses saldo. Silakan coba lagi.*', { parse_mode: 'Markdown' });
          }

          if (action === 'create') {
            const telegramUserId = String(ctx.from?.id || '');
            const telegramChatId = String(ctx.chat?.id || '');
            if (type === 'vmess') {
              msg = await createvmess(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId);
            } else if (type === 'vless') {
              msg = await createvless(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId);
            } else if (type === 'trojan') {
              msg = await createtrojan(username, exp, quota, iplimit, serverId, telegramUserId, telegramChatId);
            } else if (type === 'shadowsocks') {
              msg = await createshadowsocks(username, exp, quota, iplimit, serverId);
            } else if (type === 'ssh') {
              msg = await createssh(username, password, exp, iplimit, serverId, telegramUserId, telegramChatId, quota);
            } else if (type === 'zivpn') {
              const randomPassword = Math.random().toString(36).slice(-8);
              usedPassword = randomPassword;
              msg = await createzivpn(username, randomPassword, exp, iplimit, serverId, telegramUserId, telegramChatId, selectedPackage, quota);
            } else if (type === 'udp_http') {
              msg = await createudphttp(username, password, exp, iplimit, serverId, telegramUserId, telegramChatId, quota);
            }

            logger.info(`Account created for user ${ctx.from.id}, type: ${type}`);
          } else if (action === 'renew') {
            if (type === 'vmess') {
              msg = await renewvmess(username, exp, quota, iplimit, serverId);
            } else if (type === 'vless') {
              msg = await renewvless(username, exp, quota, iplimit, serverId);
            } else if (type === 'trojan') {
              msg = await renewtrojan(username, exp, quota, iplimit, serverId);
            } else if (type === 'shadowsocks') {
              msg = await renewshadowsocks(username, exp, quota, iplimit, serverId);
            } else if (type === 'ssh') {
              msg = await renewssh(username, exp, quota, iplimit, serverId, password);
            }
            else if (type === 'udp_http') {
              msg = await renewudphttp(username, exp, quota, iplimit, serverId, password);
            }
            else if (type === 'zivpn') {
              msg = await renewzivpn(username, exp, quota, iplimit, serverId, password);
            }
            logger.info(`Account renewed for user ${ctx.from.id}, type: ${type}`);
          }
//SALDO DATABES
// setelah bikin akun (create/renew), kita cek hasilnya
const msgText = String(msg || '');
const msgLower = msgText.toLowerCase();
const isDuplicateUsername =
  action === 'create' &&
  (
    msgLower.includes('username sudah ada') ||
    msgLower.includes('username already exists') ||
    msgLower.includes('username exists') ||
    msgLower.includes('duplicate username') ||
    msgLower.includes('exists, try another name') ||
    (msgLower.includes('exists') && msgLower.includes('try another name'))
  );

if (isDuplicateUsername) {
  const cancelDup = await cancelReservedAccountCharge(ctx.from.id, totalHarga, reserveResult.referenceId);
  if (!cancelDup.ok) {
    logger.error(`Gagal refund reserve duplicate username user ${ctx.from.id}, ref: ${reserveResult.referenceId}, err: ${cancelDup.error}`);
  }
  state.step = `username_${action}_${type}`;
  delete state.username;
  delete state.exp;
  await ctx.reply(
    'Username yang kamu masukkan sudah dipakai di server.\n' +
    'Silakan gunakan username lain yang unik.\n\n' +
    'Masukkan username baru:',
    { parse_mode: 'Markdown' }
  );
  return;
}
const isErrorMsg = [
  'error',
  'gagal',
  'failed',
  'not found',
  'tidak ditemukan',
  'unauthorized',
  'forbidden',
  'invalid'
].some((needle) => msgLower.includes(needle));
const isRenewSuccessMsg =
  action === 'renew' &&
  (
    msgLower.includes('akun berhasil diperpanjang') ||
    msgLower.includes('renew ssh account success') ||
    msgLower.includes('renew udp http custom success') ||
    msgLower.includes('renew vmess account success') ||
    msgLower.includes('renew vless account success') ||
    msgLower.includes('renew trojan account success') ||
    msgLower.includes('renew shadowsocks premium') ||
    msgLower.includes('renew zivpn success')
  );
const shouldRollback = isErrorMsg || (action === 'renew' && !isRenewSuccessMsg);
if (shouldRollback) {
  const cancelErr = await cancelReservedAccountCharge(ctx.from.id, totalHarga, reserveResult.referenceId);
  if (!cancelErr.ok) {
    logger.error(`Gagal refund reserve error create/renew user ${ctx.from.id}, ref: ${reserveResult.referenceId}, err: ${cancelErr.error}`);
  }
  logger.error(`[TXN] Rollback saldo user ${ctx.from.id}, type: ${type}, server: ${serverId}, respon: ${msgText}`);
  return ctx.reply(msg, { parse_mode: 'Markdown' });
}
// kalau sampai sini artinya tidak ada error, lanjut finalisasi saldo + transaksi (atomic)
const finalizeResult = await finalizeReservedAccountCharge(reserveResult.referenceId, type);
if (!finalizeResult.ok) {
  logger.error(`Finalisasi transaksi gagal untuk user ${ctx.from.id}, type: ${type}, server: ${serverId}, ref: ${reserveResult.referenceId}, err: ${finalizeResult.error}`);
  await ctx.reply(
    '⚠️ *Akun berhasil dibuat, tapi finalisasi transaksi gagal tercatat.*\nSilakan hubungi admin agar dicek manual (log transaksi pending).',
    { parse_mode: 'Markdown' }
  );
}

logger.info(`? Transaksi sukses untuk user ${ctx.from.id}, type: ${type}, server: ${serverId}, ref: ${reserveResult.referenceId}`);

if (action === 'create') {
  db.run('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId], (err) => {
    if (err) {
      logger.error('Kesalahan saat menambahkan total_create_akun:', err.message);
    }
  });
}

const expDays = Number(exp) || 0;
let expiresAt = expDays > 0 ? (Date.now() + expDays * 24 * 60 * 60 * 1000) : null;

if (action === 'renew' && expDays > 0) {
  const existingExpiry = await getAccountExistingExpiry(ctx.from.id, type, username, serverId, state.serverDomain);
  const baseTs = Math.max(Date.now(), Number(existingExpiry || 0));
  expiresAt = baseTs + expDays * 24 * 60 * 60 * 1000;
}
const passwordToStore = (type === 'zivpn') ? usedPassword : password;
const linkPayload = (type === 'vmess' || type === 'vless' || type === 'trojan')
  ? extractAccountLinksFromMessage(msgText)
  : {};
upsertAccountRecord({
  userId: ctx.from.id,
  type,
  username,
  password: passwordToStore,
  serverId,
  serverName: state.serverName,
  domain: state.serverDomain,
  accountIpPackage: selectedPackage,
  accountPricePerDay: harga,
  expiresAt,
  ...linkPayload
});

if (action === 'create') {
  try {
    const isReseller = await isUserReseller(ctx.from.id);
    const expDate = new Date(Date.now() + exp * 24 * 60 * 60 * 1000);
    const creatorUsername = ctx.from.username ? `@${ctx.from.username}` : '-';
    const roleLabel = isReseller ? 'RESELLER' : 'USER';
    await sendGlobalCreateAccountNotification({
      creatorId: ctx.from.id,
      creatorUsername,
      serverName: state.serverName || state.serverDomain || '-',
      accountType: String(type || '-').toUpperCase(),
      role: roleLabel,
      remarks: buildCreateNotifRemarks(type, username),
      expDays: exp,
      expiredDate: formatDateId(expDate),
      payment: `VIA SALDO BOT - Rp ${Number(totalHarga || 0).toLocaleString('id-ID')} (${formatCreatePriceMode(createPriceMode)})`
    });

    if (!isReseller) {
      const creatorLabel = ctx.from.username
        ? `@${ctx.from.username}`
        : (ctx.from.first_name || 'User');
      await sendNonResellerCreateNotification({
        service: type.toUpperCase(),
        serverName: state.serverName,
        domain: state.serverDomain,
        accountUsername: username,
        accountPassword: usedPassword,
        expDays: exp,
        expiredDate: formatDateId(expDate),
        creatorLabel,
        creatorId: ctx.from.id
      });
    }
  } catch (e) {
    logger.error('❌ Gagal kirim notif create non-reseller:', e.message);
  }
} else if (action === 'renew') {
  try {
    const isReseller = await isUserReseller(ctx.from.id);
    const expiredDate = expiresAt
      ? formatDateId(new Date(expiresAt))
      : formatDateId(new Date(Date.now() + exp * 24 * 60 * 60 * 1000));
    const creatorUsername = ctx.from.username ? `@${ctx.from.username}` : '-';
    const roleLabel = isReseller ? 'RESELLER' : 'USER';

    await sendGlobalRenewAccountNotification({
      creatorId: ctx.from.id,
      creatorUsername,
      serverName: state.serverName || state.serverDomain || '-',
      accountType: String(type || '-').toUpperCase(),
      role: roleLabel,
      remarks: buildCreateNotifRemarks(type, username),
      expDays: exp,
      expiredDate,
      payment: `VIA SALDO BOT - Rp ${Number(totalHarga || 0).toLocaleString('id-ID')} (Renew)`
    });
  } catch (e) {
    logger.error('❌ Gagal kirim notif renew ke grup:', e.message);
  }
}

const msgToUser = action === 'create'
  ? normalizeCreateAccountMessageForDisplay(msg, selectedPackage)
  : msg;
await ctx.reply(msgToUser, { parse_mode: 'Markdown' });
delete userState[ctx.chat.id];
//SALDO DATABES
          });
        });
      });
    } 
  else if (state.step === 'addserver') {
    const domain = ctx.message.text.trim();
    if (!domain) {
      await ctx.reply('⚠️ *Domain tidak boleh kosong.* Silakan masukkan domain server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_auth';
    state.domain = domain;
    await ctx.reply('🔑 *Silakan masukkan auth server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_auth') {
    const auth = ctx.message.text.trim();
    if (!auth) {
      await ctx.reply('⚠️ *Auth tidak boleh kosong.* Silakan masukkan auth server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_nama_server';
    state.auth = auth;
    await ctx.reply('🏷️ *Silakan masukkan nama server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_nama_server') {
    const nama_server = ctx.message.text.trim();
    if (!nama_server) {
      await ctx.reply('⚠️ *Nama server tidak boleh kosong.* Silakan masukkan nama server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_quota';
    state.nama_server = nama_server;
    await ctx.reply('📊 *Silakan masukkan quota server per hari (GB):*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_quota') {
    const quota = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(quota)) {
      await ctx.reply('⚠️ *Quota tidak valid.* Silakan masukkan quota server per hari yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_batas_create_akun';
    state.quota = quota;
    await ctx.reply('🔢 *Silakan masukkan batas create akun server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_batas_create_akun') {
    const batas_create_akun = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(batas_create_akun)) {
      await ctx.reply('⚠️ *Batas create akun tidak valid.* Silakan masukkan batas create akun server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_harga_1ip';
    state.batas_create_akun = batas_create_akun;
    await ctx.reply('💳 Masukkan harga *User Paket 1IP*:', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_harga_1ip') {
    const harga_1ip = parseFloat(ctx.message.text.trim());
    if (isNaN(harga_1ip) || harga_1ip <= 0) {
      await ctx.reply('Harga User 1IP tidak valid. Masukkan angka yang benar.', { parse_mode: 'Markdown' });
      return;
    }
    state.harga_1ip = harga_1ip;
    state.step = 'addserver_harga_2ip';
    await ctx.reply('💳 Masukkan harga *User Paket 2IP*:', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_harga_2ip') {
    const harga_2ip = parseFloat(ctx.message.text.trim());
    if (isNaN(harga_2ip) || harga_2ip <= 0) {
      await ctx.reply('Harga User 2IP tidak valid. Masukkan angka yang benar.', { parse_mode: 'Markdown' });
      return;
    }
    state.harga_2ip = harga_2ip;
    state.step = 'addserver_harga_reseller_1ip';
    await ctx.reply('💳 Masukkan harga *Reseller Paket 1IP*:', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_harga_reseller_1ip') {
    const harga_reseller_1ip = parseFloat(ctx.message.text.trim());
    if (isNaN(harga_reseller_1ip) || harga_reseller_1ip <= 0) {
      await ctx.reply('Harga Reseller 1IP tidak valid. Masukkan angka yang benar.', { parse_mode: 'Markdown' });
      return;
    }
    state.harga_reseller_1ip = harga_reseller_1ip;
    state.step = 'addserver_harga_reseller_2ip';
    await ctx.reply('💳 Masukkan harga *Reseller Paket 2IP*:', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_harga_reseller_2ip') {
    const harga_reseller_2ip = parseFloat(ctx.message.text.trim());
    if (isNaN(harga_reseller_2ip) || harga_reseller_2ip <= 0) {
      await ctx.reply('Harga Reseller 2IP tidak valid. Masukkan angka yang benar.', { parse_mode: 'Markdown' });
      return;
    }

    state.harga_reseller_2ip = harga_reseller_2ip;

    const { domain, auth, nama_server, quota, batas_create_akun } = state;
    const iplimit = 0;

    try {
      const isResellerOnly = state.is_reseller_only ? 1 : 0;
      const supportZivpn = state.support_zivpn ? 1 : 0;
      const supportUdpHttp = state.support_udp_http ? 1 : 0;

      const hargaUser1 = state.harga_1ip || 0;
      const hargaUser2 = state.harga_2ip || 0;
      const hargaRes1 = state.harga_reseller_1ip || 0;
      const hargaRes2 = state.harga_reseller_2ip || 0;
      const hargaDasar = hargaUser1;
      const hargaResellerDasar = hargaRes1;

      db.run(
        'INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
        [
          domain,
          auth,
          nama_server,
          quota,
          iplimit,
          batas_create_akun,
          hargaDasar,
          hargaResellerDasar,
          hargaUser1,
          hargaUser2,
          hargaRes1,
          hargaRes2,
          isResellerOnly,
          supportZivpn,
          supportUdpHttp,
          'ssh'
        ],
        function (err) {
          if (err) {
            logger.error('Error saat menambahkan server:', err.message);
            ctx.reply('*Terjadi kesalahan saat menambahkan server baru.*', { parse_mode: 'Markdown' });
          } else {
            ctx.reply(
              '*Server baru berhasil ditambahkan.*\n\n' +
              `• Domain: \`${domain}\`\n` +
              `• Auth: \`${auth}\`\n` +
              `• Nama Server: ${nama_server}\n` +
              `• Quota/Hari: ${quota} GB\n` +
              `• Batas Create Akun: ${batas_create_akun}\n` +
              `• Harga User 1IP: Rp ${hargaUser1}\n` +
              `• Harga User 2IP: Rp ${hargaUser2}\n` +
              `• Harga Reseller 1IP: Rp ${hargaRes1}\n` +
              `• Harga Reseller 2IP: Rp ${hargaRes2}`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      );
    } catch (error) {
      logger.error('Error saat menambahkan server:', error);
      await ctx.reply('*Terjadi kesalahan saat menambahkan server baru.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
  }
// === 🏷️ TAMBAH SERVER UNTUK RESELLER ===
if (state && state.step === 'reseller_domain') {
  state.domain = text;
  state.step = 'reseller_auth';
  return ctx.reply('🔑 Masukkan auth server:');
}

if (state && state.step === 'reseller_auth') {
  state.auth = text;
  state.step = 'reseller_harga';
  return ctx.reply('💰 Masukkan harga server (angka):');
}

if (state && state.step === 'reseller_harga') {
  state.harga = text;
  state.step = 'reseller_nama';
  return ctx.reply('📝 Masukkan nama server:');
}

if (state && state.step === 'reseller_nama') {
  state.nama_server = text;
  state.step = 'reseller_quota';
  return ctx.reply('📊 Masukkan quota per hari (GB):');
}

if (state && state.step === 'reseller_quota') {
  state.quota = text;
  state.step = 'reseller_iplimit';
  return ctx.reply('📶 Masukkan IP limit:');
}

if (state && state.step === 'reseller_iplimit') {
  state.iplimit = text;
  state.step = 'reseller_batas';
  return ctx.reply('🔢 Masukkan batas create akun:');
}

if (state && state.step === 'reseller_batas') {
  state.batas_create_akun = text;

  db.run(
    `INSERT INTO Server (domain, auth, harga, harga_reseller, harga_1ip, harga_2ip, harga_reseller_1ip, harga_reseller_2ip, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 'ssh')`,
    [
      state.domain,
      state.auth,
      parseInt(state.harga),
      parseInt(state.harga),
      parseInt(state.harga),
      parseInt(state.harga),
      parseInt(state.harga),
      parseInt(state.harga),
      state.nama_server,
      parseInt(state.quota),
      parseInt(state.iplimit),
      parseInt(state.batas_create_akun),
    ],
    (err) => {
      if (err) {
        logger.error('❌ Gagal menambah server reseller:', err.message);
        ctx.reply('❌ Gagal menambah server reseller.');
      } else {
        ctx.reply(
          `✅ Server reseller *${state.nama_server}* berhasil ditambahkan!`,
          { parse_mode: 'Markdown' }
        );
      }
      delete userState[ctx.chat.id];
    }
  );
  return;
}
// === 💰 TAMBAH SALDO (LANGKAH 1: INPUT USER ID) ===
if (state && state.step === 'addsaldo_userid') {
  state.targetId = text.trim();
  state.step = 'addsaldo_amount';
  return ctx.reply('💰 Masukkan jumlah saldo yang ingin ditambahkan:');
}

// === 💰 TAMBAH SALDO (LANGKAH 1: INPUT USER ID) ===
if (state && state.step === 'addsaldo_userid') {
  state.targetId = text.trim();
  state.step = 'addsaldo_amount';
  return ctx.reply('💰 Masukkan jumlah saldo yang ingin ditambahkan:');
}

// === 💰 TAMBAH SALDO (LANGKAH 2: INPUT JUMLAH SALDO) ===
if (state && state.step === 'addsaldo_amount') {
  const amount = parseInt(text.trim());
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('⚠️ Jumlah saldo harus berupa angka dan lebih dari 0.');
  }

  const targetId = state.targetId;

// Tambahkan saldo
db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId], (err) => {
  if (err) {
    logger.error('❌ Gagal menambah saldo:', err.message);
    return ctx.reply('❌ Gagal menambah saldo ke user.');
  }

  // Ambil saldo terbaru
  db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], async (err2, updated) => {
    if (err2 || !updated) {
      await ctx.reply(`✅ Saldo sebesar Rp${amount} berhasil ditambahkan ke user ${targetId}.`);
      await bot.telegram.sendMessage(
        targetId,
        `✅ Saldo Anda berhasil ditambahkan admin.\n` +
        `💰 Nominal: Rp${amount.toLocaleString('id-ID')}`
      ).catch((notifyErr) => {
        logger.error(`Gagal kirim notifikasi tambah saldo ke ${targetId}: ${notifyErr.message}`);
      });
      logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId}.`);
    } else {
      await ctx.reply(`✅ Saldo sebesar Rp${amount} berhasil ditambahkan ke user ${targetId}.\n💳 Saldo sekarang: Rp${updated.saldo}`);
      await bot.telegram.sendMessage(
        targetId,
        `✅ Saldo Anda berhasil ditambahkan admin.\n` +
        `💰 Nominal: Rp${amount.toLocaleString('id-ID')}\n` +
        `🏦 Saldo sekarang: Rp${updated.saldo.toLocaleString('id-ID')}`
      ).catch((notifyErr) => {
        logger.error(`Gagal kirim notifikasi tambah saldo ke ${targetId}: ${notifyErr.message}`);
      });
      logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId} (Saldo akhir: Rp${updated.saldo}).`);
    }
  });

  delete userState[ctx.from.id];
});

  return;
}
});
////////
bot.action('addserver', async (ctx) => {
  try {
    logger.info('Proses tambah server dimulai');
    await ctx.answerCbQuery();

    userState[ctx.chat.id] = {
      step: 'addserver_support',
      data: {},
      is_reseller_only: 0
    };

    await ctx.reply('Pilih support server:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Support ZIVPN', callback_data: 'addserver_support_zivpn' }],
          [{ text: 'Support UDP HTTP', callback_data: 'addserver_support_udp_http' }],
          [{ text: 'Tanpa Support', callback_data: 'addserver_support_none' }],
          [{ text: 'Batal', callback_data: 'admin_menu' }]
        ]
      }
    });
  } catch (error) {
    logger.error('Kesalahan saat memulai proses tambah server:', error);
    await ctx.reply('Gagal memulai proses tambah server. Silakan coba lagi.');
  }
});

bot.action('addserver_role_reseller', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.is_reseller_only = 1;
  state.step = 'addserver_support';
  userState[ctx.chat.id] = state;
  await ctx.reply('Pilih support server:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Support ZIVPN', callback_data: 'addserver_support_zivpn' }],
        [{ text: 'Support UDP HTTP', callback_data: 'addserver_support_udp_http' }],
        [{ text: 'Tanpa Support', callback_data: 'addserver_support_none' }]
      ]
    }
  });
});

bot.action('addserver_role_user', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.is_reseller_only = 0;
  state.step = 'addserver_support';
  userState[ctx.chat.id] = state;
  await ctx.reply('Pilih support server:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Support ZIVPN', callback_data: 'addserver_support_zivpn' }],
        [{ text: 'Support UDP HTTP', callback_data: 'addserver_support_udp_http' }],
        [{ text: 'Tanpa Support', callback_data: 'addserver_support_none' }]
      ]
    }
  });
});

bot.action('addserver_support_zivpn', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 1;
  state.support_udp_http = 0;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});

bot.action('addserver_support_udp_http', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 0;
  state.support_udp_http = 1;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});

bot.action('addserver_support_none', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 0;
  state.support_udp_http = 0;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});
bot.action('detailserver', async (ctx) => {
  try {
    logger.info('📋 Proses detail server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    const buttons = [];
    for (let i = 0; i < servers.length; i += 2) {
      const row = [];
      const serverActive = Number(servers[i].is_active ?? 1) === 1;
      row.push({
        text: `${serverActive ? '[AKTIF]' : '[NONAKTIF]'} ${servers[i].nama_server}`,
        callback_data: `server_detail_${servers[i].id}`
      });
      if (i + 1 < servers.length) {
        const server2Active = Number(servers[i + 1].is_active ?? 1) === 1;
        row.push({
          text: `${server2Active ? '[AKTIF]' : '[NONAKTIF]'} ${servers[i + 1].nama_server}`,
          callback_data: `server_detail_${servers[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    await ctx.reply('📋 *Silakan pilih server untuk melihat detail:*', {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('listserver', async (ctx) => {
  try {
    logger.info('📜 Proses daftar server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    let serverList = '📜 *Daftar Server* 📜\n\n';
    servers.forEach((server, index) => {
      const status = Number(server.is_active ?? 1) === 1 ? 'AKTIF' : 'NONAKTIF';
      serverList += `🔹 ${index + 1}. ${server.domain} - ${status}\n`;
    });

    serverList += `\nTotal Jumlah Server: ${servers.length}`;

    await ctx.reply(serverList, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil daftar server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
  }
});
bot.action('resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('🚨 *PERHATIAN! Anda akan menghapus semua server yang tersedia. Apakah Anda yakin?*', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ya', callback_data: 'confirm_resetdb' }],
          [{ text: '❌ Tidak', callback_data: 'cancel_resetdb' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Error saat memulai proses reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('confirm_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM Server', (err) => {
        if (err) {
          logger.error('❌ Error saat mereset tabel Server:', err.message);
          return reject('❗️ *PERHATIAN! Terjadi KESALAHAN SERIUS saat mereset database. Harap segera hubungi administrator!*');
        }
        resolve();
      });
    });
    await ctx.reply('🚨 *PERHATIAN! Database telah DIRESET SEPENUHNYA. Semua server telah DIHAPUS TOTAL.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat mereset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('cancel_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('❌ *Proses reset database dibatalkan.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat membatalkan reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('deleteserver', async (ctx) => {
  try {
    logger.info('🗑️ Proses hapus server dimulai');
    await ctx.answerCbQuery();
    
    db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
      }

      if (servers.length === 0) {
        logger.info('⚠️ Tidak ada server yang tersedia');
        return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
      }

      const keyboard = servers.map(server => {
        return [{ text: server.nama_server, callback_data: `confirm_delete_server_${server.id}` }];
      });
      keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'kembali_ke_menu' }]);

      ctx.reply('🗑️ *Pilih server yang ingin dihapus:*', {
        reply_markup: {
          inline_keyboard: keyboard
        },
        parse_mode: 'Markdown'
      });
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses hapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});


const getUsernameById = async (userId) => {
  try {
    const telegramUser = await bot.telegram.getChat(userId);
    return telegramUser.username || telegramUser.first_name;
  } catch (err) {
    logger.error('❌ Kesalahan saat mengambil username dari Telegram:', err.message);
    throw new Error('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil username dari Telegram.*');
  }
};
/////////////
bot.action('tambah_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  userState[adminId] = { step: 'addsaldo_userid' };
  await ctx.reply('🔢 Masukkan ID Telegram user yang ingin ditambahkan saldo:');
});
//////
bot.action(/next_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    logger.info(`Next users process started for page ${currentPage + 1}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT user_id FROM users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const keyboard = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].user_id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].user_id}`
        });
      }
      keyboard.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...keyboard]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage + 1}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses next users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action(/prev_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = (currentPage - 1) * 20; 

  try {
    logger.info(`Previous users process started for page ${currentPage}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT user_id FROM users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const keyboard = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].user_id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].user_id}`
        });
      }
      keyboard.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...keyboard]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses previous users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

async function sendPriceDurationServerMenu(ctx, serverId) {
  const server = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [serverId]).catch(() => null);
  if (!server) {
    return ctx.reply('Server tidak ditemukan.');
  }

  const dailyEnabled = isServerDailyPriceEnabled(server);
  const monthlyEnabled = isServerMonthlyPriceEnabled(server);
  const userDaily1 = getEffectiveServerPackagePrice(server, false, 1);
  const userDaily2 = getEffectiveServerPackagePrice(server, false, 2);
  const resDaily1 = getEffectiveServerPackagePrice(server, true, 1);
  const resDaily2 = getEffectiveServerPackagePrice(server, true, 2);
  const userMonth1 = getEffectiveServerMonthlyPackagePrice(server, false, 1);
  const userMonth2 = getEffectiveServerMonthlyPackagePrice(server, false, 2);
  const resMonth1 = getEffectiveServerMonthlyPackagePrice(server, true, 1);
  const resMonth2 = getEffectiveServerMonthlyPackagePrice(server, true, 2);

  const text =
    '<b>Atur Harga Masa Aktif</b>\n\n' +
    `Server: <b>${escapeHtmlLocal(server.nama_server || server.domain || `ID ${serverId}`)}</b>\n` +
    `Harian: <b>${dailyEnabled ? 'AKTIF' : 'NONAKTIF'}</b>\n` +
    `30 Hari: <b>${monthlyEnabled ? 'AKTIF' : 'NONAKTIF'}</b>\n\n` +
    '<b>Harga Harian</b>\n' +
    `- User 1IP: ${formatRupiah(userDaily1)}\n` +
    `- User 2IP: ${formatRupiah(userDaily2)}\n` +
    `- Reseller 1IP: ${formatRupiah(resDaily1)}\n` +
    `- Reseller 2IP: ${formatRupiah(resDaily2)}\n\n` +
    '<b>Harga 30 Hari</b>\n' +
    `- User 1IP: ${formatRupiah(userMonth1)}\n` +
    `- User 2IP: ${formatRupiah(userMonth2)}\n` +
    `- Reseller 1IP: ${formatRupiah(resMonth1)}\n` +
    `- Reseller 2IP: ${formatRupiah(resMonth2)}`;

  const keyboard = [
    [
      { text: dailyEnabled ? 'Nonaktifkan Harian' : 'Aktifkan Harian', callback_data: `price_duration_toggle_daily_${serverId}` },
      { text: monthlyEnabled ? 'Nonaktifkan 30 Hari' : 'Aktifkan 30 Hari', callback_data: `price_duration_toggle_monthly_${serverId}` }
    ],
    [
      { text: 'Edit Harian User 1IP', callback_data: `edit_harga1_${serverId}` },
      { text: 'Edit Harian User 2IP', callback_data: `edit_harga2_${serverId}` }
    ],
    [
      { text: 'Edit Harian Reseller 1IP', callback_data: `edit_harga_res1_${serverId}` },
      { text: 'Edit Harian Reseller 2IP', callback_data: `edit_harga_res2_${serverId}` }
    ],
    [
      { text: 'Edit 30H User 1IP', callback_data: `edit_harga30_user1_${serverId}` },
      { text: 'Edit 30H User 2IP', callback_data: `edit_harga30_user2_${serverId}` }
    ],
    [
      { text: 'Edit 30H Reseller 1IP', callback_data: `edit_harga30_res1_${serverId}` },
      { text: 'Edit 30H Reseller 2IP', callback_data: `edit_harga30_res2_${serverId}` }
    ],
    [{ text: 'Pilih Server Lain', callback_data: 'editserver_price_duration' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_server' }]
  ];

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function buildGlobalPriceDurationPrompt(mode) {
  const label = mode === '30hari' ? '30 Hari' : 'Harian';
  return (
    `Edit Global Harga ${label}\n\n` +
    'Harga akan diterapkan ke semua server yang ada.\n\n' +
    'Kirim 4 angka dengan format:\n' +
    '<user_1ip> <user_2ip> <reseller_1ip> <reseller_2ip>\n\n' +
    'Contoh:\n' +
    '500 700 400 600\n\n' +
    'Ketik batal untuk membatalkan.'
  );
}

function parseGlobalPriceDurationInput(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return null;
  }

  const values = parts.map((part) => Number(part));
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }

  return {
    user1: values[0],
    user2: values[1],
    reseller1: values[2],
    reseller2: values[3]
  };
}

async function handleGlobalPriceDurationInput(ctx, state, text) {
  const mode = normalizeCreatePriceMode(state.priceMode);
  if (String(text || '').trim().toLowerCase() === 'batal') {
    delete userState[ctx.chat.id];
    return ctx.reply('Edit global harga masa aktif dibatalkan.');
  }

  const prices = parseGlobalPriceDurationInput(text);
  if (!prices) {
    return ctx.reply(
      'Format salah. Kirim 4 angka tanpa titik/koma.\n' +
      'Contoh: 500 700 400 600'
    );
  }

  const updateSql = mode === '30hari'
    ? `UPDATE Server
       SET harga_1ip_30hari = ?,
           harga_2ip_30hari = ?,
           harga_reseller_1ip_30hari = ?,
           harga_reseller_2ip_30hari = ?,
           harga_mode_30hari_enabled = 1`
    : `UPDATE Server
       SET harga = ?,
           harga_reseller = ?,
           harga_1ip = ?,
           harga_2ip = ?,
           harga_reseller_1ip = ?,
           harga_reseller_2ip = ?,
           harga_mode_harian_enabled = 1`;

  const params = mode === '30hari'
    ? [prices.user1, prices.user2, prices.reseller1, prices.reseller2]
    : [prices.user1, prices.reseller1, prices.user1, prices.user2, prices.reseller1, prices.reseller2];

  try {
    const result = await dbRunAsync(updateSql, params);
    delete userState[ctx.chat.id];
    const label = mode === '30hari' ? '30 Hari' : 'Harian';
    await ctx.reply(
      `✅ Harga global ${label} berhasil diupdate untuk ${Number(result?.changes || 0)} server.\n\n` +
      `- User 1IP: ${formatRupiah(prices.user1)}\n` +
      `- User 2IP: ${formatRupiah(prices.user2)}\n` +
      `- Reseller 1IP: ${formatRupiah(prices.reseller1)}\n` +
      `- Reseller 2IP: ${formatRupiah(prices.reseller2)}`
    );
    return ctx.reply('Buka menu harga masa aktif untuk cek atau edit per server.', {
      reply_markup: { inline_keyboard: [[{ text: 'Atur Harga Masa Aktif', callback_data: 'editserver_price_duration' }]] }
    });
  } catch (err) {
    logger.error('Gagal update global harga masa aktif:', err.message);
    return ctx.reply('Gagal mengupdate harga global masa aktif.');
  }
}

bot.action('editserver_price_duration', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const adminId = Number(ctx.from?.id || 0);
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
    }

    const servers = await dbAllAsync(
      'SELECT id, nama_server, domain FROM Server ORDER BY nama_server COLLATE NOCASE ASC',
      []
    ).catch(() => []);

    if (!servers.length) {
      return ctx.reply('Tidak ada server.');
    }

    const buttons = [
      [{ text: 'Edit Global Harian Semua Server', callback_data: 'price_duration_global_daily' }],
      [{ text: 'Edit Global 30 Hari Semua Server', callback_data: 'price_duration_global_30hari' }]
    ];

    buttons.push(...servers.map((server) => [{
      text: server.nama_server || server.domain || `ID ${server.id}`,
      callback_data: `price_duration_server_${server.id}`
    }]));
    buttons.push([{ text: 'Kembali', callback_data: 'admin_menu_server' }]);

    await ctx.reply('Pilih edit global atau pilih server untuk atur harga masa aktif:', {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    logger.error('Gagal membuka menu harga masa aktif:', err.message);
    await ctx.reply('Terjadi kesalahan saat membuka menu harga masa aktif.');
  }
});

bot.action(/price_duration_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const adminId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk membuka menu ini.');
  }
  return sendPriceDurationServerMenu(ctx, Number(ctx.match[1]));
});

bot.action(/price_duration_global_(daily|30hari)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const adminId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah harga global.');
  }

  const mode = normalizeCreatePriceMode(ctx.match[1]);
  userState[ctx.chat.id] = {
    step: 'global_price_duration_input',
    priceMode: mode
  };
  return ctx.reply(buildGlobalPriceDurationPrompt(mode));
});

bot.action(/price_duration_toggle_(daily|monthly)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const adminId = Number(ctx.from?.id || 0);
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah setting ini.');
  }

  const mode = ctx.match[1];
  const serverId = Number(ctx.match[2]);
  const server = await dbGetAsync('SELECT * FROM Server WHERE id = ?', [serverId]).catch(() => null);
  if (!server) {
    return ctx.reply('Server tidak ditemukan.');
  }

  const dailyEnabled = isServerDailyPriceEnabled(server);
  const monthlyEnabled = isServerMonthlyPriceEnabled(server);
  const nextDaily = mode === 'daily' ? !dailyEnabled : dailyEnabled;
  const nextMonthly = mode === 'monthly' ? !monthlyEnabled : monthlyEnabled;

  if (!nextDaily && !nextMonthly) {
    return ctx.reply('Minimal salah satu mode harga harus aktif.');
  }

  await dbRunAsync(
    `UPDATE Server
     SET harga_mode_harian_enabled = ?,
         harga_mode_30hari_enabled = ?,
         harga_1ip_30hari = COALESCE(NULLIF(harga_1ip_30hari, 0), COALESCE(harga_1ip, harga, 0) * 30),
         harga_2ip_30hari = COALESCE(NULLIF(harga_2ip_30hari, 0), COALESCE(harga_2ip, harga, 0) * 30),
         harga_reseller_1ip_30hari = COALESCE(NULLIF(harga_reseller_1ip_30hari, 0), COALESCE(harga_reseller_1ip, harga_reseller, harga_1ip, harga, 0) * 30),
         harga_reseller_2ip_30hari = COALESCE(NULLIF(harga_reseller_2ip_30hari, 0), COALESCE(harga_reseller_2ip, harga_reseller, harga_2ip, harga, 0) * 30)
     WHERE id = ?`,
    [nextDaily ? 1 : 0, nextMonthly ? 1 : 0, serverId]
  ).catch((err) => {
    logger.error('Gagal toggle harga masa aktif:', err.message);
    throw err;
  });

  await ctx.reply('Setting harga masa aktif berhasil diupdate.');
  return sendPriceDurationServerMenu(ctx, serverId);
});

bot.action('editserver_limit_ip', async (ctx) => {
  try {
    logger.info('Edit server limit IP process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_limit_ip_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit limit IP:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit limit IP server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_iplimit_rules', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const servers = await dbAllAsync(
      'SELECT id, nama_server, domain FROM Server ORDER BY nama_server COLLATE NOCASE ASC',
      []
    ).catch(() => []);

    if (!servers.length) {
      return ctx.reply('Tidak ada server yang tersedia.');
    }

    const buttons = servers.map((server) => [{
      text: server.nama_server || server.domain || `ID ${server.id}`,
      callback_data: `edit_server_iplimit_rules_server_${server.id}`
    }]);
    buttons.push([{ text: '🔙 Kembali', callback_data: 'admin_menu_server' }]);

    await ctx.reply('Pilih server untuk mengatur limit IP per protocol:', {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    logger.error('Error membuka menu limit IP paket:', error.message);
    await ctx.reply('Terjadi kesalahan saat membuka menu limit IP paket.');
  }
});
bot.action(/edit_server_iplimit_rules_server_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const serverId = Number(ctx.match[1]);
    const server = await dbGetAsync('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId]).catch(() => null);
    if (!server) {
      return ctx.reply('Server tidak ditemukan.');
    }

    await sendServerIpLimitProtocolMenu(ctx, serverId, server.nama_server || server.domain || `ID ${serverId}`);
  } catch (error) {
    logger.error('Error memilih server limit IP paket:', error.message);
    await ctx.reply('Terjadi kesalahan saat memilih server.');
  }
});
bot.action(/edit_server_iplimit_rules_protocol_(\d+)_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const serverId = Number(ctx.match[1]);
    const protocol = normalizeIpLimitProtocol(ctx.match[2]);
    const server = await dbGetAsync('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId]).catch(() => null);
    if (!server) {
      return ctx.reply('Server tidak ditemukan.');
    }

    const current = await getServerIpLimitRuleMap(serverId, protocol);
    userState[ctx.chat.id] = {
      step: 'server_iplimit_rule_1ip',
      serverId,
      protocol,
      serverName: server.nama_server || server.domain || `ID ${serverId}`,
      rule1: current[1],
      rule2: current[2]
    };

    await ctx.reply(
      `Server: *${server.nama_server || server.domain || `ID ${serverId}`}*\n` +
      `Protocol: *${protocol.toUpperCase()}*\n\n` +
      `Masukkan limit IP untuk paket *1IP*.\n` +
      `Ketik *batal* untuk membatalkan.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('Error memilih protocol limit IP paket:', error.message);
    await ctx.reply('Terjadi kesalahan saat memilih protocol.');
  }
});
bot.action('editserver_batas_create_akun', async (ctx) => {
  try {
    logger.info('Edit server batas create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_batas_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit batas create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit batas create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_total_create_akun', async (ctx) => {
  try {
    logger.info('Edit server total create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit total create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit total create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_quota', async (ctx) => {
  try {
    logger.info('Edit server quota process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_quota_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit quota per hari:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit quota harian server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_auth', async (ctx) => {
  try {
    logger.info('Edit server auth process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server, domain, auth FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('? Kesalahan saat mengambil daftar server:', err.message);
          return reject('*PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('*PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const listText = servers
      .map((server) => `? ID ${server.id} - ${server.nama_server} (${server.domain}) | auth saat ini: ${server.auth || '-'}`)
      .join('\n');

    userState[ctx.chat.id] = { step: 'edit_auth_by_text' };

    await ctx.reply(
      `*Edit Auth via Ketik Pesan*\n\n` +
      `${listText}\n\n` +
      `Kirim format:\n` +
      `\`<id_server> <auth_baru>\`\n` +
      `Contoh: \`12 myNewAuth123\`\n\n` +
      `Ketik *batal* untuk membatalkan.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('? Kesalahan saat memulai proses edit auth server:', error);
    await ctx.reply(`? *${error}*`, { parse_mode: 'Markdown' });
  }
});

// Harga User 1IP
bot.action('editserver_harga_1ip', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
    if (servers.length === 0) return ctx.reply('Tidak ada server.', { parse_mode: 'Markdown' });
    const buttons = servers.map(s => ({ text: s.nama_server, callback_data: `edit_harga1_${s.id}` }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) inlineKeyboard.push(buttons.slice(i, i + 2));
    await ctx.reply('Pilih server untuk edit harga User 1IP:', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    logger.error('Edit harga 1IP error:', err);
    await ctx.reply('Terjadi kesalahan.', { parse_mode: 'Markdown' });
  }
});

// Harga User 2IP
bot.action('editserver_harga_2ip', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
    if (servers.length === 0) return ctx.reply('Tidak ada server.', { parse_mode: 'Markdown' });
    const buttons = servers.map(s => ({ text: s.nama_server, callback_data: `edit_harga2_${s.id}` }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) inlineKeyboard.push(buttons.slice(i, i + 2));
    await ctx.reply('Pilih server untuk edit harga User 2IP:', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    logger.error('Edit harga 2IP error:', err);
    await ctx.reply('Terjadi kesalahan.', { parse_mode: 'Markdown' });
  }
});

// Harga Reseller 1IP
bot.action('editserver_harga_reseller_1ip', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
    if (servers.length === 0) return ctx.reply('Tidak ada server.', { parse_mode: 'Markdown' });
    const buttons = servers.map(s => ({ text: s.nama_server, callback_data: `edit_harga_res1_${s.id}` }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) inlineKeyboard.push(buttons.slice(i, i + 2));
    await ctx.reply('Pilih server untuk edit harga Reseller 1IP:', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    logger.error('Edit harga reseller 1IP error:', err);
    await ctx.reply('Terjadi kesalahan.', { parse_mode: 'Markdown' });
  }
});

// Harga Reseller 2IP
bot.action('editserver_harga_reseller_2ip', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
    if (servers.length === 0) return ctx.reply('Tidak ada server.', { parse_mode: 'Markdown' });
    const buttons = servers.map(s => ({ text: s.nama_server, callback_data: `edit_harga_res2_${s.id}` }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) inlineKeyboard.push(buttons.slice(i, i + 2));
    await ctx.reply('Pilih server untuk edit harga Reseller 2IP:', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (err) {
    logger.error('Edit harga reseller 2IP error:', err);
    await ctx.reply('Terjadi kesalahan.', { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_domain', async (ctx) => {
  try {
    logger.info('Edit server domain process started');
    await ctx.answerCbQuery();

    db.all('SELECT id, nama_server, domain FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
      if (err) {
        logger.error('Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengambil daftar server.');
      }

      if (!servers || servers.length === 0) {
        return ctx.reply('Tidak ada server yang tersedia untuk diedit.');
      }

      userState[ctx.chat.id] = {
        step: 'edit_domain_pick_server'
      };

      const listText = servers
        .map((server) => '- ID ' + server.id + ': ' + (server.nama_server || '-') + ' (' + (server.domain || '-') + ')')
        .join('\n');

      await ctx.reply(
        'Edit domain server.\n\n' +
        'Daftar server:\n' + listText + '\n\n' +
        'Ketik ID server yang ingin diedit.\n' +
        'Ketik batal untuk membatalkan.'
      );
    });
  } catch (error) {
    logger.error('Kesalahan saat memulai proses edit domain server:', error);
    await ctx.reply('Terjadi kesalahan saat memulai edit domain server.');
  }
});

bot.action('nama_server_edit', async (ctx) => {
  try {
    logger.info('Edit server nama process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_nama_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🏷️ *Silakan pilih server untuk mengedit nama:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit nama server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action(/edit_harga1_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih edit harga user 1IP server ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga_1ip', serverId };
  await ctx.reply('Masukkan harga User 1IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga2_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih edit harga user 2IP server ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga_2ip', serverId };
  await ctx.reply('Masukkan harga User 2IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga_res1_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih edit harga reseller 1IP server ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga_reseller_1ip', serverId };
  await ctx.reply('Masukkan harga Reseller 1IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga_res2_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih edit harga reseller 2IP server ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga_reseller_2ip', serverId };
  await ctx.reply('Masukkan harga Reseller 2IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga30_user1_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_harga_30hari_user_1ip', serverId };
  await ctx.reply('Masukkan harga 30 hari User 1IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga30_user2_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_harga_30hari_user_2ip', serverId };
  await ctx.reply('Masukkan harga 30 hari User 2IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga30_res1_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_harga_30hari_reseller_1ip', serverId };
  await ctx.reply('Masukkan harga 30 hari Reseller 1IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_harga30_res2_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_harga_30hari_reseller_2ip', serverId };
  await ctx.reply('Masukkan harga 30 hari Reseller 2IP:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_total_batas_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_total_batas_input', serverId };
  await ctx.reply(
    'Kirim format: <total_create_akun> <batas_create_akun>\nContoh: 10 50',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/set_server_full_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  db.get('SELECT batas_create_akun FROM Server WHERE id = ?', [serverId], (err, row) => {
    if (err || !row) {
      return ctx.reply('❌ Gagal mengambil data server.');
    }
    db.run(
      'UPDATE Server SET total_create_akun = ? WHERE id = ?',
      [row.batas_create_akun, serverId],
      function (err2) {
        if (err2) {
          logger.error('❌ Gagal set server penuh:', err2.message);
          return ctx.reply('❌ Gagal menjadikan server penuh.');
        }
        ctx.reply(`✅ Server berhasil dijadikan penuh (total = ${row.batas_create_akun}).`);
      }
    );
  });
});

bot.action(/activate_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_total_batas_input', serverId };
  await ctx.reply(
    'Kirim format: <total_create_akun> <batas_create_akun>\nContoh: 10 50',
    { parse_mode: 'Markdown' }
  );
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota harian server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru per hari (GB):*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_nama_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const serverId = ctx.match[1];

    // Simpan state agar menunggu input nama baru
    userState[ctx.chat.id] = {
      step: "edit_nama_input",
      serverId: serverId
    };

    logger.info(`Admin ${ctx.chat.id} memilih server ID ${serverId} untuk edit nama`);

    await ctx.reply(
      `✏️ *Silakan ketik nama baru untuk server ID ${serverId}:*`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    logger.error("❌ Error edit nama:", err);
    ctx.reply("⚠️ Terjadi kesalahan saat memproses permintaan.");
  }
});

bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});

bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota/Hari:* \`${server.quota} GB\`\n` +
      `📶 *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `🕹️ *Status List User:* \`${Number(server.is_active ?? 1) === 1 ? 'Aktif' : 'Nonaktif'}\`\n` +
      `🔌 *Support Protocol:* \`${formatServerProtocolStatusLine(server)}\`\n` +
      `💵 *Harga Harian User 1IP:* \`${formatRupiah(getEffectiveServerPackagePrice(server, false, 1))}\`\n` +
      `💵 *Harga Harian User 2IP:* \`${formatRupiah(getEffectiveServerPackagePrice(server, false, 2))}\`\n` +
      `📆 *Harga 30 Hari User 1IP:* \`${formatRupiah(getEffectiveServerMonthlyPackagePrice(server, false, 1))}\`\n` +
      `📆 *Harga 30 Hari User 2IP:* \`${formatRupiah(getEffectiveServerMonthlyPackagePrice(server, false, 2))}\`\n` +
      `⏱️ *Mode Harian:* \`${isServerDailyPriceEnabled(server) ? 'Aktif' : 'Nonaktif'}\`\n` +
      `📆 *Mode 30 Hari:* \`${isServerMonthlyPriceEnabled(server) ? 'Aktif' : 'Nonaktif'}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const userStateData = userState[ctx.chat.id];

  if (String(data || '').startsWith('check_orkut_payment_')) {
    const uniqueCode = String(data).replace(/^check_orkut_payment_/, '');
    await handleOrderKuotaPaymentCheck(ctx, uniqueCode);
    return;
  }

  if (global.depositState && global.depositState[userId] && global.depositState[userId].action === 'request_amount') {
    await handleDepositState(ctx, userId, data);
  } 
  // ✅ TAMBAHKAN HANDLER UNTUK confirm_final
  else if (data === 'confirm_final') {
    try {
      await ctx.answerCbQuery();
      
      if (global.depositState && global.depositState[userId]) {
        const amount = global.depositState[userId].amount;
        await processDeposit(ctx, amount, global.depositState[userId]);
      } else {
        await ctx.reply('❌ Sesi top-up sudah expired. Silakan mulai lagi.');
      }
    } catch (error) {
      logger.error('Error confirm_final:', error);
      await ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi.');
    }
    return;
  }
  else if (userStateData) {
    switch (userStateData.step) {
      // ❌ HAPUS/MODIFIKASI bagian addsaldo_userid dan addsaldo_amount 
      // karena itu seharusnya di text handler, tapi kalau sudah berjalan biarin saja
      
      // ✅ TAMBAHKAN CASE UNTUK CONFIRM FINAL DI STATE LAINNYA
      case 'confirm_final_topup':
        if (global.depositState && global.depositState[userId]) {
          const amount = global.depositState[userId].amount;
          await processDeposit(ctx, amount, global.depositState[userId]);
        }
        break;
        
      case 'edit_batas_create_akun':
        await handleEditBatasCreateAkun(ctx, userStateData, data);
        break;
      case 'edit_limit_ip':
        await handleEditiplimit(ctx, userStateData, data);
        break;
      case 'edit_quota':
        await handleEditQuota(ctx, userStateData, data);
        break;
      case 'edit_auth':
        await handleEditAuth(ctx, userStateData, data);
        break;
      case 'edit_domain':
        await handleEditDomain(ctx, userStateData, data);
        break;
      case 'edit_harga_1ip':
        await handleEditHarga1Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_2ip':
        await handleEditHarga2Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_reseller_1ip':
        await handleEditHargaReseller1Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_reseller_2ip':
        await handleEditHargaReseller2Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_30hari_user_1ip':
        await handleEditHarga30HariUser1Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_30hari_user_2ip':
        await handleEditHarga30HariUser2Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_30hari_reseller_1ip':
        await handleEditHarga30HariReseller1Ip(ctx, userStateData, data);
        break;
      case 'edit_harga_30hari_reseller_2ip':
        await handleEditHarga30HariReseller2Ip(ctx, userStateData, data);
        break;
      case 'edit_nama':
        await handleEditNama(ctx, userStateData, data);
        break;
      case 'edit_total_create_akun':
        await handleEditTotalCreateAkun(ctx, userStateData, data);
        break;
      default:
        await ctx.answerCbQuery();
        break;
    }
  } else {
    await ctx.answerCbQuery();
  }
});


async function handleDepositState(ctx, userId, data) {
  const state = global.depositState[userId] || {};
  let currentAmount = String(state.amount || '');
  const minAmount = Number(state.minAmount) > 0 ? Number(state.minAmount) : 2000;
  const topupPurpose = String(state.topupPurpose || 'regular');
  const walletType = normalizeWalletType(state.walletType || 'vpn');
  const walletLabel = getWalletLabel(walletType);

  if (data === 'send_main_menu' || data === 'sendMainMenu') {
    delete global.depositState[userId];
    await ctx.answerCbQuery().catch(() => {});
    return sendMainMenu(ctx);
  }

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return ctx.answerCbQuery('Jumlah tidak boleh kosong!', { show_alert: true });
    }

    const amountNum = parseInt(currentAmount, 10);
    if (!Number.isFinite(amountNum) || amountNum < minAmount) {
      return ctx.answerCbQuery(`Jumlah minimal Rp ${minAmount.toLocaleString('id-ID')}!`, { show_alert: true });
    }

    const bonusCfg = loadTopupBonusSetting();
    let bonusInfo = '';
    if (walletType === 'vpn' && bonusCfg.enabled && amountNum >= 10000) {
      let bonusPercent = 0;
      if (amountNum <= 49000) bonusPercent = bonusCfg.range_10_40;
      else if (amountNum <= 79000) bonusPercent = bonusCfg.range_50_70;
      else bonusPercent = bonusCfg.range_70_100;
      bonusInfo = `\nBonus: ${bonusPercent}% (ditambah ke ${walletLabel} jika pembayaran sukses)\n`;
    }

    const confirmTitle = topupPurpose === 'reseller_join'
      ? 'KONFIRMASI TOPUP JADI RESELLER'
      : 'KONFIRMASI TOPUP';

    const feeDisplay = getTopupFeeDisplay(PAYMENT_GATEWAY_MODE, amountNum);

    const confirmMessage =
`*${confirmTitle}*

Nominal Topup: Rp ${amountNum.toLocaleString('id-ID')}
Tujuan Saldo: ${walletLabel}
${bonusInfo}${feeDisplay.confirmFeeLine}
${feeDisplay.confirmTotalLine}

Penting:
- Total final ada di QRIS
- Transfer harus sesuai nominal QRIS
- Verifikasi otomatis 1-2 menit

Lanjutkan untuk melihat QRIS?`;

    await ctx.editMessageText(confirmMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Lanjut Bayar', callback_data: 'confirm_final' }],
          [{ text: 'Batal', callback_data: 'send_main_menu' }]
        ]
      }
    });

    global.depositState[userId].amount = currentAmount;
    global.depositState[userId].action = 'confirm_final';
    return ctx.answerCbQuery();
  } else {
    if (currentAmount.length >= 12) {
      return ctx.answerCbQuery('Jumlah maksimal 12 digit!', { show_alert: true });
    }
    currentAmount += data;
  }

  global.depositState[userId].amount = currentAmount;
  global.depositState[userId].walletType = walletType;
  const title = topupPurpose === 'reseller_join'
    ? `Masukkan nominal topup jadi reseller (minimal Rp ${minAmount.toLocaleString('id-ID')})`
    : `Masukkan jumlah ${walletLabel} yang ingin ditambahkan (minimal Rp ${minAmount.toLocaleString('id-ID')})`;
  const message = `*${title}*\n\nJumlah: *Rp ${currentAmount || '0'}*`;

  try {
    if (message !== ctx.callbackQuery.message.text) {
      await ctx.editMessageText(message, {
        reply_markup: { inline_keyboard: keyboard_nomor() },
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.answerCbQuery();
    }
  } catch (error) {
    await ctx.answerCbQuery();
    logger.error('Error editing message:', error.message);
  }
}
async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'backspace') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserBalance(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else if (data === 'cancel') {
    delete userState[ctx.chat.id];
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
  } else {
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_simple() },
      parse_mode: 'Markdown'
    });
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET limit_ip = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota per hari', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?', keyboard_full);
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?', keyboard_full);
}

async function handleEditHargaGeneric(ctx, userStateData, data, label, column) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('Jumlah tidak boleh kosong.', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply(`${label} tidak valid. Masukkan angka yang valid.`, { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, `UPDATE Server SET ${column} = ? WHERE id = ?`);
      ctx.reply(`${label} berhasil diupdate.\n\nDetail:\n- ${label}: Rp ${hargaBaru}`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`Terjadi kesalahan saat mengupdate ${label}.`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('Hanya angka yang diperbolehkan.', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('Jumlah maksimal adalah 12 digit.', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `${label}:\n\nJumlah saat ini: Rp ${currentAmount}`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_simple() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditHarga1Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga User 1IP', 'harga_1ip');
}

async function handleEditHarga2Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga User 2IP', 'harga_2ip');
}

async function handleEditHargaReseller1Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga Reseller 1IP', 'harga_reseller_1ip');
}

async function handleEditHargaReseller2Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga Reseller 2IP', 'harga_reseller_2ip');
}

async function handleEditHarga30HariUser1Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga 30 Hari User 1IP', 'harga_1ip_30hari');
}

async function handleEditHarga30HariUser2Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga 30 Hari User 2IP', 'harga_2ip_30hari');
}

async function handleEditHarga30HariReseller1Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga 30 Hari Reseller 1IP', 'harga_reseller_1ip_30hari');
}

async function handleEditHarga30HariReseller2Ip(ctx, userStateData, data) {
  return handleEditHargaGeneric(ctx, userStateData, data, 'Harga 30 Hari Reseller 2IP', 'harga_reseller_2ip_30hari');
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?', keyboard_full);
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query, keyboardBuilder) {
  let currentValue = userStateData[field] || '';

  if (data === 'delete') {
    currentValue = currentValue.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }
    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      ctx.reply(`✅ *${fieldName} server berhasil diupdate.*\n\n📄 *Detail Server:*\n- ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}: *${currentValue}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
    }
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} maksimal adalah 253 karakter!*`, { show_alert: true });
    }
  }

  userStateData[field] = currentValue;
  const newMessage = `📊 *Silakan masukkan ${fieldName} server baru:*\n\n${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: (keyboardBuilder ? keyboardBuilder() : keyboard_nomor_simple()) },
      parse_mode: 'Markdown'
    });
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        logger.error(`⚠️ Kesalahan saat mengupdate ${fieldName} server:`, err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

global.depositState = {};
global.pendingDeposits = {};
const danaAmountReservations = new Set();
let lastRequestTime = 0;
const requestInterval = 1000; 

function getPaymentQrExpireMs(provider) {
  const normalizedProvider = String(provider || '').toLowerCase();
  if (normalizedProvider === 'orderkuota') {
    return Math.max(1, Number(ORDERKUOTA_QR_EXPIRE_MINUTES || 10)) * 60 * 1000;
  }
  if (normalizedProvider === 'dana_notification') {
    return Math.max(1, Number(DANA_BRIDGE_QR_EXPIRE_MINUTES || 15)) * 60 * 1000;
  }
  return Math.max(1, Number(GOPAY_QR_EXPIRE_MINUTES || 15)) * 60 * 1000;
}

function getPaymentQrExpireMinutes(provider) {
  return Math.round(getPaymentQrExpireMs(provider) / 60000);
}

function getTopupFeeDisplay(mode, amount) {
  const normalizedMode = String(mode || PAYMENT_GATEWAY_MODE || 'orderkuota').toLowerCase();
  const amountNum = Math.max(0, Number(amount || 0));
  const formatAmount = (value) => Number(value || 0).toLocaleString('id-ID');

  if (normalizedMode === 'gopay') {
    return {
      menuNotice:
        '💳 *BIAYA ADMIN:*\n' +
        '• GoPay tanpa biaya admin\n' +
        '• Total bayar sama dengan nominal top-up\n\n',
      confirmFeeLine: 'Biaya Admin GoPay: Rp 0',
      confirmTotalLine: `Perkiraan Total: Rp ${formatAmount(amountNum)}`,
      transferNotice: 'Transfer sesuai nominal QRIS yang diberikan.\n\n'
    };
  }

  if (normalizedMode === 'dana_notification') {
    return {
      menuNotice:
        '💳 *PEMBAYARAN DANA BISNIS:*\n' +
        '• Tanpa biaya admin\n' +
        '• Total bayar sama dengan nominal top-up\n\n',
      confirmFeeLine: 'Biaya Admin DANA: Rp 0',
      confirmTotalLine: `Total Bayar: Rp ${formatAmount(amountNum)}`,
      transferNotice: 'Transfer sesuai nominal QRIS yang diberikan.\n\n'
    };
  }

  if (normalizedMode === 'both') {
    return {
      menuNotice:
        '🎲 *BIAYA ADMIN:*\n' +
        '• OrderKuota: random Rp 100-200\n' +
        '• GoPay: tanpa fee\n' +
        '• Total final mengikuti gateway yang membuat QRIS\n\n',
      confirmFeeLine: 'Biaya Admin: OrderKuota random Rp 100-200, GoPay Rp 0',
      confirmTotalLine: `Perkiraan Total: Rp ${formatAmount(amountNum)} - Rp ${formatAmount(amountNum + 200)}`,
      transferNotice: 'Transfer harus *TEPAT* sesuai nominal QRIS yang diberikan!\n\n'
    };
  }

  return {
    menuNotice:
      '🎲 *SISTEM KEAMANAN ORDERKUOTA:*\n' +
      '• Biaya admin OrderKuota *RANDOM 100-200*\n' +
      '• Setiap transaksi punya *nominal unik*\n' +
      '• Mencegah duplikasi pembayaran\n\n',
    confirmFeeLine: 'Biaya Admin OrderKuota: Rp 100 - Rp 200 (random)',
    confirmTotalLine: `Perkiraan Total: Rp ${formatAmount(amountNum + 100)} - Rp ${formatAmount(amountNum + 200)}`,
    transferNotice: 'Transfer harus *TEPAT* sesuai nominal unik yang diberikan!\n\n'
  };
}

db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
  if (err) {
    logger.error('Gagal load pending_deposits:', err.message);
    return;
  }
  rows.forEach(row => {
    const createdAt = row.timestamp || Date.now();
    const provider = String(row.gateway_provider || 'orderkuota');
    const expiresAt = row.expires_at || (createdAt + getPaymentQrExpireMs(provider));
    global.pendingDeposits[row.unique_code] = {
      amount: row.amount,
      originalAmount: row.original_amount,
      userId: row.user_id,
      timestamp: row.timestamp,
      status: row.status || 'pending',
      topupPurpose: row.topup_purpose || 'regular',
      walletType: normalizeWalletType(row.wallet_type || 'vpn'),
      qrMessageId: row.qr_message_id,
      referenceId: row.reference_id || row.unique_code,
      adminFee: Number(row.admin_fee || 0),
      gatewayProvider: provider,
      providerTxId: row.provider_tx_id || '',
      orderKuotaCheckActive: false,
      orderKuotaLastCheckAt: 0,
      orderKuotaCheckUntil: 0,
      orderKuotaTapCount: 0,
      orderKuotaLastTapAt: 0,
      createdAt,
      expiresAt
    };
  });
  logger.info('Pending deposit loaded:', Object.keys(global.pendingDeposits).length);
});

/*
    const qris = new QRISPayment({
    merchantId: MERCHANT_ID,
    apiKey: API_KEY,
    baseQrString: DATA_QRIS,
    logoPath: 'logo.png'
});
*/
function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const localQrisImageCache = new Map();
const LOCAL_QRIS_IMAGE_TTL_MS = 30 * 60 * 1000;

function sanitizeQrisString(raw) {
  let text = String(raw || '').trim();
  try {
    text = decodeURIComponent(text);
  } catch (_err) {
    // Biarkan apa adanya kalau bukan URI encoded.
  }

  text = text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\r\n\t]/g, '')
    .replace(/^["'`]+|["'`]+$/g, '');

  const start = text.indexOf('000201');
  if (start > 0) text = text.slice(start);
  return text;
}

function parseQrisTlv(raw) {
  const text = sanitizeQrisString(raw);
  if (!text) throw new Error('DATA_QRIS belum diisi.');
  if (!text.startsWith('000201')) {
    throw new Error('DATA_QRIS tidak valid: payload harus dimulai dengan 000201. Kirim hasil scan teks QRIS, bukan foto/link/base64.');
  }

  const fields = [];
  let offset = 0;

  while (offset < text.length) {
    if (offset + 4 > text.length) {
      throw new Error('DATA_QRIS tidak valid: TLV terpotong.');
    }

    const id = text.slice(offset, offset + 2);
    const lenText = text.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenText)) {
      const near = text.slice(Math.max(0, offset - 10), offset + 20);
      throw new Error(`DATA_QRIS tidak valid: format tag/length salah di offset ${offset}. Cek bagian: ${near}`);
    }

    const length = Number(lenText);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > text.length) {
      throw new Error(`DATA_QRIS tidak valid: value tag ${id} terpotong.`);
    }

    fields.push({ id, value: text.slice(valueStart, valueEnd) });
    offset = valueEnd;
    if (id === '63') break;
  }

  return fields;
}

function validateAndNormalizeQrisData(raw) {
  const normalized = sanitizeQrisString(raw);
  const fields = parseQrisTlv(normalized);
  const hasMerchantInfo = fields.some((field) => {
    const id = Number(field.id);
    return id >= 26 && id <= 51;
  });
  if (!hasMerchantInfo) {
    throw new Error('DATA_QRIS tidak valid: merchant account information tidak ditemukan.');
  }
  return formatQrisTlv(fields);
}

function formatQrisTlv(fields) {
  return fields.map((field) => {
    const value = String(field.value || '');
    const length = String(value.length).padStart(2, '0');
    if (length.length > 2) {
      throw new Error(`DATA_QRIS tidak valid: value tag ${field.id} terlalu panjang.`);
    }
    return `${field.id}${length}${value}`;
  }).join('');
}

function crc16CcittFalse(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildDynamicQrisString(qrisData, amount) {
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum < 1) {
    throw new Error('Nominal QRIS harus angka minimal Rp 1.');
  }

  const amountText = String(Math.round(amountNum));
  let fields = parseQrisTlv(qrisData).filter((field) => field.id !== '63');

  let hasPointOfInitiation = false;
  fields = fields
    .filter((field) => field.id !== '54')
    .map((field) => {
      if (field.id === '01') {
        hasPointOfInitiation = true;
        return { id: '01', value: '12' };
      }
      return field;
    });

  if (!hasPointOfInitiation) {
    const pointField = { id: '01', value: '12' };
    const tag00Index = fields.findIndex((field) => field.id === '00');
    if (tag00Index !== -1) {
      fields.splice(tag00Index + 1, 0, pointField);
    } else {
      const insertAt = fields.findIndex((field) => Number(field.id) > 1);
      if (insertAt === -1) fields.push(pointField);
      else fields.splice(insertAt, 0, pointField);
    }
  }

  const amountField = { id: '54', value: amountText };
  const amountInsertAt = fields.findIndex((field) => Number(field.id) > 54);
  if (amountInsertAt === -1) fields.push(amountField);
  else fields.splice(amountInsertAt, 0, amountField);

  const withoutCrc = formatQrisTlv(fields);
  const crcInput = `${withoutCrc}6304`;
  return `${crcInput}${crc16CcittFalse(crcInput)}`;
}

async function renderQrisPngBuffer(qrisString) {
  return QRCode.toBuffer(qrisString, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8
  });
}

async function createLocalOrderKuotaQr({ amount, qrisData, referenceId }) {
  const qrisString = buildDynamicQrisString(qrisData || DATA_QRIS, amount);
  const qrBuffer = await renderQrisPngBuffer(qrisString);
  return {
    reference: String(referenceId || `LOCAL-${Date.now()}`),
    amount: Number(amount),
    qrisString,
    qrBuffer
  };
}

function getLocalPaymentApiKey() {
  const key = String(LOCAL_PAYMENT_API_KEY || '').trim();
  return isPlaceholderSecret(key) ? '' : key;
}

function cacheLocalQrisImage(referenceId, qrBuffer, ttlMs = LOCAL_QRIS_IMAGE_TTL_MS) {
  const safeReference = String(referenceId || `LOCAL-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
  const expiresAt = Date.now() + ttlMs;
  localQrisImageCache.set(safeReference, { qrBuffer: Buffer.from(qrBuffer), expiresAt });

  for (const [key, item] of localQrisImageCache.entries()) {
    if (!item || item.expiresAt <= Date.now()) localQrisImageCache.delete(key);
  }

  return { reference: safeReference, expiresAt };
}

function publicBaseUrlFromRequest(req) {
  const host = req.get('host') || `127.0.0.1:${port}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`;
}

app.get('/orderkuota/qris-image/:reference.png', (req, res) => {
  const reference = String(req.params.reference || '');
  const cached = localQrisImageCache.get(reference);
  if (!cached || cached.expiresAt <= Date.now()) {
    localQrisImageCache.delete(reference);
    return res.status(404).json({ status: 'error', message: 'QRIS image expired atau tidak ditemukan.' });
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(cached.qrBuffer);
});

async function handleLocalOrderKuotaCreatePayment(req, res) {
  try {
    const requiredApiKey = getLocalPaymentApiKey();
    const givenApiKey = String(req.query.apikey || '').trim();
    if (requiredApiKey && givenApiKey !== requiredApiKey) {
      return res.status(401).json({ status: 'error', success: false, message: 'invalid apikey' });
    }

    const amount = Number(req.query.amount);
    const reference = String(req.query.reference || `LOCAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const qrisData = String(req.query.codeqr || DATA_QRIS || '');
    const result = await createLocalOrderKuotaQr({ amount, qrisData, referenceId: reference });
    const cached = cacheLocalQrisImage(result.reference, result.qrBuffer);
    const imageUrl = `${publicBaseUrlFromRequest(req)}/orderkuota/qris-image/${cached.reference}.png`;

    return res.json({
      status: 'success',
      success: true,
      result: {
        reference: result.reference,
        amount: result.amount,
        qris_string: result.qrisString,
        qr_url: imageUrl,
        imageqris: { url: imageUrl },
        expires_at: cached.expiresAt
      }
    });
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      success: false,
      message: error.message || 'gagal membuat QRIS'
    });
  }
}

app.get('/orderkuota/createpayment', handleLocalOrderKuotaCreatePayment);
app.get('/orderkuota/orderkuota/createpayment', handleLocalOrderKuotaCreatePayment);

function buildOrderKuotaCreateParams({ amount, qrisData, referenceId }) {
  const currentVars = loadVars();
  const username = String(currentVars.ORKUT_USERNAME || '').trim();
  const token = String(currentVars.ORKUT_TOKEN || '').trim();
  const params = {
    apikey: String(RAJASERVER_API_KEY || ''),
    amount: String(amount)
  };

  if (username) params.username = username;
  if (token) params.token = token;
  if (qrisData) params.codeqr = String(qrisData);
  if (referenceId) params.reference = String(referenceId);
  return params;
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function extractQrImageUrl(body) {
  return pickFirstString(
    body?.result?.imageqris?.url,
    body?.result?.image_qris?.url,
    body?.result?.qris?.url,
    body?.result?.qr?.url,
    body?.result?.qr_url,
    body?.result?.qrUrl,
    body?.result?.qrImageUrl,
    body?.result?.image_url,
    body?.data?.imageqris?.url,
    body?.data?.image_qris?.url,
    body?.data?.qris?.url,
    body?.data?.qr?.url,
    body?.data?.qr_url,
    body?.data?.qrUrl,
    body?.data?.qrImageUrl,
    body?.data?.image_url,
    body?.imageqris?.url,
    body?.qris?.url,
    body?.qr?.url,
    body?.qr_url,
    body?.qrUrl,
    body?.qrImageUrl,
    body?.image_url
  );
}

function extractProviderTxId(body, fallback) {
  return pickFirstString(
    body?.result?.reference,
    body?.result?.transaction_id,
    body?.result?.trx_id,
    body?.result?.id,
    body?.data?.reference,
    body?.data?.transaction_id,
    body?.data?.trx_id,
    body?.data?.id,
    body?.reference,
    body?.transaction_id,
    body?.trx_id,
    fallback
  );
}

function isExplicitGatewayFailure(body) {
  if (!body || typeof body !== 'object') return false;
  const status = String(body.status ?? '').trim().toLowerCase();
  const message = String(body.message || body.msg || '').trim();
  if (body.success === false || body.ok === false) return true;
  if (['false', 'failed', 'fail', 'error', 'gagal'].includes(status)) return true;
  return /invalid|salah|gagal|failed|error/i.test(message) && !extractQrImageUrl(body);
}

async function testOrderKuotaCreateEndpoint() {
  if (ORDERKUOTA_CREATE_MODE !== 'gateway') {
    try {
      if (!DATA_QRIS) {
        return { ok: false, message: 'Gagal: DATA_QRIS belum diisi.' };
      }
      const result = await createLocalOrderKuotaQr({
        amount: 1000,
        qrisData: DATA_QRIS,
        referenceId: 'BOTVPN-LOCAL-TEST'
      });
      return {
        ok: true,
        message: `Lokal OK, QRIS dinamis berhasil dibuat (${result.qrBuffer.length} bytes)`
      };
    } catch (error) {
      return { ok: false, message: `Lokal gagal: ${error.message || 'unknown error'}` };
    }
  }

  const gatewayBase = normalizeHttpUrl(PAYMENT_GATEWAY_BASE_URL) || 'https://api.rajaserver.web.id/orderkuota/createpayment';
  const testUrl = `${gatewayBase}?${new URLSearchParams({
    apikey: '__botvpn_test__',
    username: '__botvpn_test__',
    token: '__botvpn_test__',
    amount: '1000',
    codeqr: '__botvpn_test__',
    reference: 'BOTVPN-ENDPOINT-TEST'
  }).toString()}`;

  try {
    const response = await axios.get(testUrl, {
      timeout: 8000,
      validateStatus: () => true
    });
    const status = Number(response?.status || 0);
    const responseText = compactText(response?.data, 120);
    if (status === 404) {
      return { ok: false, message: `Gagal: HTTP 404 endpoint tidak ditemukan (${gatewayBase})` };
    }
    if (status >= 500) {
      return { ok: false, message: `Gagal: HTTP ${status} dari provider${responseText ? ` - ${responseText}` : ''}` };
    }
    return { ok: true, message: `Endpoint terdeteksi: HTTP ${status}${responseText ? ` - ${responseText}` : ''}` };
  } catch (error) {
    return { ok: false, message: formatGatewayAxiosError('OrderKuota', error, { gatewayBase }) };
  }
}

async function createOrderKuotaQr({ amount, qrisData, referenceId }) {
  if (ORDERKUOTA_CREATE_MODE !== 'gateway') {
    const localQr = await createLocalOrderKuotaQr({ amount, qrisData, referenceId });
    return {
      provider: 'orderkuota',
      qrImageUrl: '',
      qrBuffer: localQr.qrBuffer,
      qrisString: localQr.qrisString,
      providerTxId: localQr.reference
    };
  }

  if (isPlaceholderSecret(RAJASERVER_API_KEY)) {
    throw new Error('RAJASERVER_API_KEY belum diisi di .vars.json');
  }
  const gatewayBase = normalizeHttpUrl(PAYMENT_GATEWAY_BASE_URL) || 'https://api.rajaserver.web.id/orderkuota/createpayment';
  const gatewayUrl = `${gatewayBase}?${new URLSearchParams(
    buildOrderKuotaCreateParams({ amount, qrisData, referenceId })
  ).toString()}`;
  let bayar;
  try {
    bayar = await axios.get(gatewayUrl, { timeout: 15000 });
  } catch (error) {
    throw new Error(formatGatewayAxiosError('OrderKuota', error, { gatewayBase }));
  }

  if (isExplicitGatewayFailure(bayar.data)) {
    throw new Error('OrderKuota gagal create QR: ' + compactText(bayar.data, 240));
  }

  const qrImageUrl = extractQrImageUrl(bayar.data);
  if (!qrImageUrl || qrImageUrl.includes('undefined')) {
    throw new Error('OrderKuota mengembalikan URL QR tidak valid: ' + compactText(bayar.data, 240));
  }
  return {
    provider: 'orderkuota',
    qrImageUrl,
    providerTxId: extractProviderTxId(bayar.data, referenceId)
  };
}

async function createGoPayQr({ amount }) {
  if (!GOPAY_API_KEY) {
    throw new Error('GOPAY_API_KEY belum diisi di .vars.json');
  }
  const baseUrl = normalizeHttpUrl(GOPAY_API_BASE_URL) || 'https://api-gopay.sawargipay.cloud';
  const response = await axios.post(
    `${baseUrl}/qris/generate`,
    { amount: Number(amount) },
    {
      headers: {
        Authorization: `Bearer ${GOPAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );
  const body = response?.data || {};
  if (!body.success || !body?.data?.transaction_id || !body?.data?.qr_url) {
    throw new Error('GoPay gagal create QR: ' + JSON.stringify(body));
  }
  return {
    provider: 'gopay',
    qrImageUrl: String(body.data.qr_url),
    providerTxId: String(body.data.transaction_id),
    expiryTime: body.data.expiry_time || null
  };
}

async function createDanaNotificationQr({ amount, qrisData, referenceId }) {
  const readiness = getPaymentGatewayReadiness();
  if (!readiness.danaNotification.ready) {
    throw new Error('DANA Notification Bridge belum siap: ' + readiness.danaNotification.missing.join(', '));
  }
  const localQr = await createLocalOrderKuotaQr({ amount, qrisData: DANA_QRIS || qrisData, referenceId });
  return {
    provider: 'dana_notification',
    qrImageUrl: '',
    qrBuffer: localQr.qrBuffer,
    qrisString: localQr.qrisString,
    providerTxId: localQr.reference
  };
}

async function createPaymentQrByMode({ amountOrderKuota, amountGoPay, amountDana, qrisData, referenceId }) {
  const mode = String(PAYMENT_GATEWAY_MODE || 'orderkuota').toLowerCase();
  const readiness = getPaymentGatewayReadiness();
  if (mode === 'gopay') {
    if (!readiness.gopay.ready) {
      throw new Error('GoPay belum siap: ' + readiness.gopay.missing.join(', '));
    }
    return createGoPayQr({ amount: amountGoPay });
  }
  if (mode === 'dana_notification') {
    return createDanaNotificationQr({ amount: amountDana, qrisData, referenceId });
  }
  if (mode === 'both') {
    if (readiness.orderkuota.ready) {
      try {
        return await createOrderKuotaQr({ amount: amountOrderKuota, qrisData, referenceId });
      } catch (errOrderKuota) {
        logger.warn('OrderKuota gagal saat mode both, fallback ke GoPay: ' + errOrderKuota.message);
      }
    } else {
      logger.warn('OrderKuota dilewati saat mode both karena belum siap: ' + readiness.orderkuota.missing.join(', '));
    }

    if (readiness.gopay.ready) {
      return createGoPayQr({ amount: amountGoPay });
    }
    throw new Error('Tidak ada payment gateway fallback yang siap. ' + formatMissingGatewayConfig(readiness));
  }
  if (!readiness.orderkuota.ready) {
    throw new Error('OrderKuota belum siap: ' + readiness.orderkuota.missing.join(', '));
  }
  return createOrderKuotaQr({ amount: amountOrderKuota, qrisData, referenceId });
}

// Ganti fungsi processDeposit dengan versi yang lebih sederhana
async function processDeposit(ctx, amount, options = {}) {
  const currentTime = Date.now();
  
  if (currentTime - lastRequestTime < requestInterval) {
    await ctx.editMessageText('⚠️ *Terlalu banyak permintaan. Silakan tunggu sebentar sebelum mencoba lagi.*', { parse_mode: 'Markdown' });
    return;
  }

  lastRequestTime = currentTime;
  const userId = ctx.from.id;
  
  // CEK BATAS TRANSAKSI PENDING
  const userPendingCount = Object.values(global.pendingDeposits)
    .filter(d => d.userId === userId && d.status === 'pending').length;
  
  if (userPendingCount >= 1) {
    await ctx.editMessageText(
      '⚠️ *Anda masih memiliki transaksi pending yang belum dibayar.*\n\n' +
      'Silakan selesaikan pembayaran yang ada atau tunggu QRIS expired sebelum membuat top-up baru.',
      { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]] }
      }
    );
    delete global.depositState[userId];
    return;
  }

  const amountNum = Number(amount);
  const minAmount = Number(options?.minAmount) > 0 ? Number(options.minAmount) : 2000;
  const topupPurpose = String(options?.topupPurpose || 'regular');
  const walletType = normalizeWalletType(options?.walletType || 'vpn');
  const walletLabel = getWalletLabel(walletType);
  const retryTopupCallback = `topup_wallet_${walletType}`;

  if (amountNum < minAmount) {
    await ctx.editMessageText(
      `❌ *Minimal top-up Rp ${minAmount.toLocaleString('id-ID')}!*\n\nSilakan masukkan nominal yang valid.`,
      { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: retryTopupCallback }]] }
      }
    );
    delete global.depositState[userId];
    return;
  }

  const normalizedGatewayMode = String(PAYMENT_GATEWAY_MODE || 'orderkuota').toLowerCase();
  let reservedDanaAmount = null;
  if (normalizedGatewayMode === 'dana_notification') {
    const amountIsPending = Object.values(global.pendingDeposits || {}).some((deposit) => {
      return deposit &&
        deposit.status === 'pending' &&
        String(deposit.gatewayProvider || '').toLowerCase() === 'dana_notification' &&
        Number(deposit.amount || 0) === amountNum;
    });

    if (danaAmountReservations.has(amountNum) || amountIsPending) {
      await ctx.editMessageText(
        `⚠️ *Nominal Rp ${amountNum.toLocaleString('id-ID')} sedang dipakai transaksi DANA lain.*\n\n` +
        'Pilih nominal berbeda atau tunggu transaksi tersebut selesai/expired.',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Pilih Nominal Lain', callback_data: retryTopupCallback }]] }
        }
      );
      delete global.depositState[userId];
      return;
    }

    danaAmountReservations.add(amountNum);
    reservedDanaAmount = amountNum;
  }
  
  try {
    // DANA dan GoPay memakai nominal asli. Kode unik hanya dipakai OrderKuota.
    const feeResult = normalizedGatewayMode === 'gopay' || normalizedGatewayMode === 'dana_notification'
      ? { finalAmount: amountNum, adminFee: 0 }
      : await generateUniqueFee(amountNum, userId);
    const orderKuotaAmount = feeResult.finalAmount;
    
    // GENERATE REFERENCE
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const uniqueCode = `TOPUP-${userId}-${timestamp}-${randomSuffix}`;
    const referenceId = `REF-${timestamp}-${randomSuffix}`;

    // BUAT QRIS sesuai gateway aktif
    const urlQr = DATA_QRIS;
    const paymentResult = await createPaymentQrByMode({
      amountOrderKuota: orderKuotaAmount,
      amountGoPay: amountNum,
      amountDana: amountNum,
      qrisData: urlQr,
      referenceId
    });
    const gatewayProvider = String(paymentResult.provider || 'orderkuota').toLowerCase();
    const hasNoAdminFee = gatewayProvider === 'gopay' || gatewayProvider === 'dana_notification';
    const finalAmount = hasNoAdminFee ? amountNum : orderKuotaAmount;
    const adminFee = hasNoAdminFee ? 0 : Math.max(0, finalAmount - amountNum);
    const qrImageUrl = paymentResult.qrImageUrl;
    const providerTxId = String(paymentResult.providerTxId || '');
    const qrExpireMs = getPaymentQrExpireMs(gatewayProvider);
    const qrExpireMinutes = getPaymentQrExpireMinutes(gatewayProvider);
    const qrExpiresAt = Date.now() + qrExpireMs;
    const adminFeeCaptionLine = gatewayProvider === 'gopay'
      ? '💳 Biaya admin GoPay: Rp 0'
      : gatewayProvider === 'dana_notification'
        ? '💳 Biaya admin DANA: Rp 0'
        : `🎲 Biaya admin OrderKuota: Rp ${adminFee.toLocaleString('id-ID')}`;

    // DOWNLOAD QR, atau pakai Buffer langsung jika dibuat lokal.
    let qrBuffer;
    if (paymentResult.qrBuffer) {
      qrBuffer = Buffer.from(paymentResult.qrBuffer);
    } else {
      const qrResponse = await axios.get(qrImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      qrBuffer = Buffer.from(qrResponse.data);
    }

    // KIRIM KE USER DENGAN INSTRUKSI SIMPLE
    const purposeLine = topupPurpose === 'reseller_join'
      ? '\nTujuan: Aktivasi reseller otomatis setelah pembayaran sukses'
      : `\nTujuan: ${walletLabel}`;

    const paymentNotice = gatewayProvider === 'orderkuota'
      ? '⚠️ *PENTING: Setelah transfer, WAJIB tekan tombol "✅ Sudah Bayar, Cek Status" di bawah QRIS.*'
      : '✅ *Pembayaran akan diverifikasi otomatis setelah transfer diterima.*';
    const caption = 
`${paymentNotice}

💵 *Total Bayar:* *Rp ${finalAmount.toLocaleString('id-ID')}*
💰 Topup: Rp ${amountNum.toLocaleString('id-ID')}
🎯 Saldo: ${walletLabel}
${adminFeeCaptionLine}

🧾 *Langkah Singkat*
1. Scan QRIS
2. Bayar *tepat* Rp ${finalAmount.toLocaleString('id-ID')}
3. ${gatewayProvider === 'orderkuota' ? 'Tekan tombol *✅ Sudah Bayar, Cek Status*' : 'Tunggu verifikasi otomatis 1-2 menit'}

⏰ QRIS berlaku ${qrExpireMinutes} menit
${gatewayProvider === 'orderkuota' ? 'ℹ️ Saldo masuk setelah tombol ditekan lalu pembayaran terdeteksi sistem\n' : ''}🆔 Ref: \`${referenceId}\`${purposeLine}`;
    
    const paymentKeyboard = gatewayProvider === 'orderkuota'
      ? {
          inline_keyboard: [[
            { text: ORDERKUOTA_CHECK_REPLY_TEXT, callback_data: `check_orkut_payment_${uniqueCode}` }
          ]]
        }
      : undefined;

    const qrMessage = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption: caption,
        parse_mode: 'Markdown',
        ...(paymentKeyboard ? { reply_markup: paymentKeyboard } : {})
      }
    );

    // HAPUS PESAN SEBELUMNYA
    try { await ctx.deleteMessage(); } catch (e) { /* ignore */ }

    // SIMPAN KE MEMORY - SIMPLE STRUCTURE
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,           // Nominal yang harus ditransfer
      originalAmount: amountNum,     // Nominal top-up (tanpa admin fee)
      adminFee: adminFee,
      userId: userId,
      timestamp: Date.now(),         // Waktu pembuatan QR
      referenceId: referenceId,
      status: 'pending',
      topupPurpose: topupPurpose,
      walletType,
      qrMessageId: qrMessage.message_id,
      gatewayProvider,
      providerTxId,
      orderKuotaCheckActive: false,
      orderKuotaLastCheckAt: 0,
      orderKuotaCheckUntil: 0,
      orderKuotaTapCount: 0,
      orderKuotaLastTapAt: 0,
      createdAt: Date.now(),         // Untuk expired check
      expiresAt: qrExpiresAt
    };
    db.run(
  `INSERT INTO pending_deposits 
   (unique_code, user_id, amount, original_amount, timestamp, status, qr_message_id, gateway_provider, provider_tx_id, reference_id, admin_fee, topup_purpose, wallet_type, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    uniqueCode, 
    userId, 
    finalAmount, 
    amountNum, 
    Date.now(),     // timestamp
    'pending',      // status
    qrMessage.message_id,
    gatewayProvider,
    providerTxId,
    referenceId,
    adminFee,
    topupPurpose,
    walletType,
    qrExpiresAt
  ],
  (err) => { 
    if (err) logger.error('❌ Save error:', err.message);
    else logger.info(`✅ Saved: ${uniqueCode}`);
  }
);

    delete global.depositState[userId];
    logger.info(`✅ QR sent to ${userId}, amount: ${finalAmount}, ref: ${referenceId}`);

  } catch (error) {
    logger.error('❌ Deposit error: ' + (error?.stack || error?.message || error));
    const publicError = formatPaymentUserError(error);
    
    await ctx.editMessageText(
      '❌ <b>GAGAL MEMBUAT PEMBAYARAN</b>\n\n' + escapeHtmlLocal(publicError) + '\n\nSilakan coba lagi.',
      { 
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: retryTopupCallback }],
            [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );
    
    delete global.depositState[userId];
  } finally {
    if (reservedDanaAmount !== null) danaAmountReservations.delete(reservedDanaAmount);
  }
}

// =================== POLLING MUTASI BANK ===================
let lastOrderKuotaPollTime = 0;
let orderKuotaPollCooldownUntil = 0;
let lastPollErrorTime = 0;
const GOPAY_POLL_INTERVAL = 10000; // GoPay cek status tiap 10 detik
const ORDERKUOTA_POLL_INTERVAL = 60 * 1000; // OrderKuota hanya cek manual, maksimal 1 menit sekali
const ORDERKUOTA_RATE_LIMIT_COOLDOWN = 5 * 60 * 1000;
function getOrderKuotaTriggeredPollIntervalMs() {
  return Math.max(5, Number(ORDERKUOTA_TRIGGERED_POLL_INTERVAL_SECONDS || 10)) * 1000;
}

function getOrderKuotaTriggeredPollWindowMs() {
  return Math.max(1, Number(ORDERKUOTA_TRIGGERED_POLL_WINDOW_MINUTES || 3)) * 60 * 1000;
}

function getOrderKuotaCheckButtonCooldownMs() {
  return Math.max(10, Number(ORDERKUOTA_CHECK_BUTTON_COOLDOWN_SECONDS || 60)) * 1000;
}
const POLL_ERROR_INTERVAL = 60000; // log error maksimal 1 menit sekali

async function checkGoPayTransactionStatus(transactionId) {
  if (!transactionId) return { settled: false, pending: true };
  const baseUrl = normalizeHttpUrl(GOPAY_API_BASE_URL) || 'https://api-gopay.sawargipay.cloud';
  const response = await axios.post(
    `${baseUrl}/qris/status`,
    { transaction_id: transactionId },
    {
      headers: {
        Authorization: `Bearer ${GOPAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );
  const body = response?.data || {};
  const status = String(body?.data?.transaction_status || '').toLowerCase();
  return {
    settled: status === 'settlement' || status === 'paid' || status === 'success',
    pending: status === 'pending' || !status,
    status
  };
}

function isOrderKuotaRateLimitMessage(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return /terlalu sering|rate.?limit|5\s*menit/i.test(text);
}

function parseCurrencyNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : NaN;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return NaN;
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/\./g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed) : NaN;
}

function parseOrderKuotaMutations(responseData) {
  const mutations = [];
  const seen = new Set();

  const pushAmount = (amount, raw) => {
    const parsed = parseCurrencyNumber(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const key = `${parsed}:${String(raw || '').slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    mutations.push({ amount: parsed, raw: String(raw || '').slice(0, 200) });
  };

  const scanText = (text) => {
    const value = String(text || '');
    if (!value) return;

    const kreditRegex = /(?:Kredit|Credit|Masuk|Nominal|Amount|Jumlah|Total)\s*[:=]\s*(?:Rp\s*)?([\d.,]+)/gi;
    let match;
    while ((match = kreditRegex.exec(value)) !== null) {
      pushAmount(match[1], match[0]);
    }

    const blocks = value.split('------------------------').filter(Boolean);
    for (const block of blocks) {
      const kreditMatch = block.match(/Kredit\s*:\s*([\d.,]+)/i);
      if (kreditMatch) pushAmount(kreditMatch[1], block);
    }
  };

  const scanObject = (value) => {
    if (Array.isArray(value)) {
      value.forEach(scanObject);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const amountKeys = [
      'kredit', 'credit', 'amount', 'nominal', 'jumlah', 'total',
      'nilai', 'mutasi', 'saldo_masuk', 'debet_kredit'
    ];

    for (const [key, item] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (amountKeys.some(amountKey => lowerKey.includes(amountKey))) {
        pushAmount(item, JSON.stringify(value));
      }
      if (item && typeof item === 'object') {
        scanObject(item);
      } else if (typeof item === 'string' && /kredit|credit|nominal|amount|jumlah|masuk/i.test(item)) {
        scanText(item);
      }
    }
  };

  if (typeof responseData === 'string') {
    scanText(responseData);
    try {
      scanObject(JSON.parse(responseData));
    } catch (_err) {}
  } else {
    scanObject(responseData);
    scanText(JSON.stringify(responseData || {}));
  }

  return mutations;
}

function summarizeOrderKuotaResponse(responseData) {
  const text = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

async function fetchOrderKuotaMutationsOnce(options = {}) {
  const skipNormalCooldown = Boolean(options.skipNormalCooldown);
  const now = Date.now();
  const waitMs = Math.max(
    orderKuotaPollCooldownUntil - now,
    skipNormalCooldown ? 0 : ORDERKUOTA_POLL_INTERVAL - (now - lastOrderKuotaPollTime),
    0
  );

  if (waitMs > 0) {
    const waitSeconds = Math.ceil(waitMs / 1000);
    const error = new Error(`Cek histori OrderKuota masih cooldown ${waitSeconds} detik.`);
    error.cooldownSeconds = waitSeconds;
    throw error;
  }

  lastOrderKuotaPollTime = now;

  try {
    const data = buildPayload();
    const resultcek = await axios.post(API_URL, data, {
      headers,
      timeout: 10000
    });

    if (isOrderKuotaRateLimitMessage(resultcek.data)) {
      orderKuotaPollCooldownUntil = Date.now() + ORDERKUOTA_RATE_LIMIT_COOLDOWN;
      const error = new Error('OrderKuota rate limit, coba lagi 5 menit lagi.');
      error.cooldownSeconds = Math.ceil(ORDERKUOTA_RATE_LIMIT_COOLDOWN / 1000);
      throw error;
    }

    const mutations = parseOrderKuotaMutations(resultcek.data);
    logger.info(`OrderKuota manual check found ${mutations.length} mutations; response=${summarizeOrderKuotaResponse(resultcek.data)}`);
    return mutations;
  } catch (err) {
    if (isOrderKuotaRateLimitMessage(err?.response?.data || err.message)) {
      orderKuotaPollCooldownUntil = Date.now() + ORDERKUOTA_RATE_LIMIT_COOLDOWN;
      const error = new Error('OrderKuota rate limit, coba lagi 5 menit lagi.');
      error.cooldownSeconds = Math.ceil(ORDERKUOTA_RATE_LIMIT_COOLDOWN / 1000);
      throw error;
    }
    throw err;
  }
}

async function handleOrderKuotaPaymentCheck(ctx, uniqueCode) {
  uniqueCode = String(uniqueCode || '');
  const deposit = global.pendingDeposits?.[uniqueCode];
  logger.info(`Tombol cek OrderKuota ditekan user=${ctx.from?.id} uniqueCode=${uniqueCode}`);
  const canAnswerCallback = ctx.updateType === 'callback_query' && typeof ctx.answerCbQuery === 'function';

  try {
    if (!deposit || deposit.status !== 'pending') {
      if (canAnswerCallback) await ctx.answerCbQuery('Transaksi tidak ditemukan atau sudah diproses.', { show_alert: true });
      else await ctx.reply('⚠️ Transaksi tidak ditemukan atau sudah diproses.');
      return;
    }

    if (Number(deposit.userId) !== Number(ctx.from.id)) {
      if (canAnswerCallback) await ctx.answerCbQuery('Transaksi ini bukan milik akun Anda.', { show_alert: true });
      else await ctx.reply('⚠️ Transaksi ini bukan milik akun Anda.');
      return;
    }

    const provider = String(deposit.gatewayProvider || 'orderkuota').toLowerCase();
    if (provider === 'gopay') {
      if (canAnswerCallback) await ctx.answerCbQuery('Gateway GoPay dicek otomatis oleh sistem.', { show_alert: true });
      else await ctx.reply('ℹ️ Gateway GoPay dicek otomatis oleh sistem.');
      return;
    }

    const now = Date.now();
    const lastManualCheckTapAt = Number(deposit.orderKuotaLastTapAt || 0);
    const cooldownRemainingMs = (lastManualCheckTapAt + getOrderKuotaCheckButtonCooldownMs()) - now;
    if (cooldownRemainingMs > 0) {
      const waitSeconds = Math.ceil(cooldownRemainingMs / 1000);
      const msg = `Tunggu ${waitSeconds} detik sebelum cek lagi.`;
      if (canAnswerCallback) await ctx.answerCbQuery(msg, { show_alert: true });
      else await ctx.reply(`⏳ ${msg}`);
      return;
    }

    const expiresAt = deposit.expiresAt || (deposit.timestamp ? deposit.timestamp + getPaymentQrExpireMs(provider) : 0);
    if (expiresAt && now > expiresAt) {
      if (canAnswerCallback) await ctx.answerCbQuery('QRIS sudah expired.', { show_alert: true });
      else await ctx.reply('⚠️ QRIS sudah expired.');
      await handleExpiredDeposit(deposit, uniqueCode);
      return;
    }

    const currentTapCount = Number(deposit.orderKuotaTapCount || 0);
    if (currentTapCount >= Math.max(1, Number(ORDERKUOTA_CHECK_MAX_TAPS || 5))) {
      const msg = `Batas tekan tombol tercapai (${ORDERKUOTA_CHECK_MAX_TAPS}x) untuk transaksi ini.`;
      if (canAnswerCallback) await ctx.answerCbQuery(msg, { show_alert: true });
      else await ctx.reply(`⚠️ ${msg}`);
      return;
    }

    deposit.orderKuotaLastTapAt = now;
    deposit.orderKuotaTapCount = currentTapCount + 1;
    deposit.orderKuotaCheckActive = true;
    deposit.orderKuotaLastCheckAt = 0;
    deposit.orderKuotaCheckUntil = Math.min(
      Date.now() + getOrderKuotaTriggeredPollWindowMs(),
      expiresAt || Date.now() + getOrderKuotaTriggeredPollWindowMs()
    );

    if (canAnswerCallback) await ctx.answerCbQuery('Pengecekan pembayaran diaktifkan.', { show_alert: false });
    await ctx.reply(
      '✅ *Pengecekan pembayaran sudah jalan.*\n\n' +
      `Bot cek histori tiap ${Math.round(getOrderKuotaTriggeredPollIntervalMs() / 1000)} detik selama ${Math.round(getOrderKuotaTriggeredPollWindowMs() / 60000)} menit.\n` +
      `Jika saldo belum masuk setelah itu, tekan tombol *${ORDERKUOTA_CHECK_REPLY_TEXT}* lagi sebelum QRIS expired.`,
      { parse_mode: 'Markdown' }
    );

    pollBankMutations().catch((err) => {
      logger.warn(`Gagal menjalankan cek OrderKuota setelah tombol ditekan: ${err.message}`);
    });
  } catch (error) {
    const waitSeconds = Number(error.cooldownSeconds || 0);
    const waitText = waitSeconds > 0
      ? `Tunggu ${Math.ceil(waitSeconds / 60)} menit lalu coba lagi.`
      : 'Coba beberapa saat lagi.';
    logger.warn(`Gagal cek manual OrderKuota ${uniqueCode}: ${error.message}`);
    await ctx.reply(
      '⚠️ *Belum bisa cek pembayaran sekarang.*\n\n' +
      `${error.message}\n${waitText}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

function findLatestPendingOrderKuotaCodeByUserId(userId) {
  const entries = Object.entries(global.pendingDeposits || {})
    .filter(([_, deposit]) => {
      if (!deposit || deposit.status !== 'pending') return false;
      if (Number(deposit.userId) !== Number(userId)) return false;
      return String(deposit.gatewayProvider || 'orderkuota').toLowerCase() === 'orderkuota';
    })
    .sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
  return entries.length ? entries[0][0] : null;
}

bot.action(/check_orkut_payment_(.+)/, async (ctx) => {
  await handleOrderKuotaPaymentCheck(ctx, ctx.match?.[1]);
});

async function pollBankMutations() {
  const now = Date.now();

  if (!loadTopupAutoSetting()) {
    return;
  }

  try {
    const pendingDeposits = Object.entries(global.pendingDeposits)
      .filter(([_, deposit]) => deposit.status === 'pending');

    if (pendingDeposits.length === 0) {
      return;
    }

    const pendingGoPayCount = pendingDeposits.filter(([_, deposit]) => {
      const provider = String(deposit.gatewayProvider || 'orderkuota').toLowerCase();
      return provider === 'gopay';
    }).length;

    if (pendingGoPayCount > 0) {
      logger.info(`Polling ${pendingGoPayCount} pending GoPay deposits`);
    }

    const activeOrderKuotaDeposits = pendingDeposits.filter(([_, deposit]) => {
      const provider = String(deposit.gatewayProvider || 'orderkuota').toLowerCase();
      if (provider !== 'orderkuota' || deposit.orderKuotaCheckActive !== true) return false;
      const checkUntil = Number(deposit.orderKuotaCheckUntil || 0);
      if (checkUntil > 0 && now > checkUntil) {
        deposit.orderKuotaCheckActive = false;
        logger.info(`Polling histori OrderKuota berhenti setelah ${Math.round(getOrderKuotaTriggeredPollWindowMs() / 60000)} menit untuk deposit ${deposit.referenceId || deposit.userId}`);
        return false;
      }
      return true;
    });

    let orderKuotaMutations = null;
    if (activeOrderKuotaDeposits.length > 0) {
      const dueOrderKuotaDeposits = activeOrderKuotaDeposits.filter(([_, deposit]) => {
        const lastCheckAt = Number(deposit.orderKuotaLastCheckAt || 0);
        return now - lastCheckAt >= getOrderKuotaTriggeredPollIntervalMs();
      });

      if (dueOrderKuotaDeposits.length > 0) {
        try {
          dueOrderKuotaDeposits.forEach(([_, deposit]) => {
            deposit.orderKuotaLastCheckAt = now;
          });
          logger.info(`Polling histori OrderKuota dipicu tombol untuk ${dueOrderKuotaDeposits.length} deposit`);
          orderKuotaMutations = await fetchOrderKuotaMutationsOnce({ skipNormalCooldown: true });
        } catch (errOrderKuota) {
          logger.warn(`Polling histori OrderKuota gagal: ${errOrderKuota.message}`);
        }
      }
    }

    for (const [uniqueCode, deposit] of pendingDeposits) {
      try {
        const provider = String(deposit.gatewayProvider || 'orderkuota').toLowerCase();
        const expiresAt = deposit.expiresAt || (deposit.timestamp ? deposit.timestamp + getPaymentQrExpireMs(provider) : 0);
        if (expiresAt && now > expiresAt) {
          logger.info(`? Deposit expired: ${uniqueCode}`);
          await handleExpiredDeposit(deposit, uniqueCode);
          continue;
        }

        if (provider === 'gopay') {
          if (!GOPAY_API_KEY) {
            logger.warn('GoPay aktif pada pending deposit, tapi GOPAY_API_KEY belum diisi.');
            continue;
          }
          const status = await checkGoPayTransactionStatus(deposit.providerTxId);
          if (status.settled) {
            logger.info(`? GoPay settlement detected for ${uniqueCode}`);
            await processSuccessfulPayment(deposit, uniqueCode);
          } else if (!status.pending && (status.status === 'expire' || status.status === 'cancel')) {
            logger.info(`? GoPay transaction ${uniqueCode} ${status.status}, diperlakukan sebagai expired.`);
            await handleExpiredDeposit(deposit, uniqueCode);
          } else if (Math.random() < 0.1) {
            logger.debug(`? GoPay pending: ${uniqueCode}`);
          }
        } else if (provider === 'orderkuota') {
          if (deposit.orderKuotaCheckActive === true && Array.isArray(orderKuotaMutations)) {
            const matchingMutation = orderKuotaMutations.find((m) => m.amount === deposit.amount);
            if (matchingMutation) {
              logger.info(`OrderKuota triggered polling matched ${uniqueCode}: ${deposit.amount}`);
              await processSuccessfulPayment(deposit, uniqueCode);
            } else if (Math.random() < 0.25) {
              logger.info(`OrderKuota triggered polling belum cocok untuk ${uniqueCode}; amount=${deposit.amount}; mutations=${orderKuotaMutations.length}`);
            }
          } else if (deposit.orderKuotaCheckActive === true && Math.random() < 0.1) {
            logger.debug(`OrderKuota triggered polling menunggu jadwal berikutnya: ${uniqueCode}`);
          } else if (Math.random() < 0.1) {
            logger.debug(`OrderKuota pending menunggu cek manual: ${uniqueCode}, Amount: ${deposit.amount}`);
          }
        } else if (provider === 'dana_notification' && Math.random() < 0.1) {
          logger.debug(`DANA Notifikasi pending menunggu event HP: ${uniqueCode}, amount=${deposit.amount}`);
        }
      } catch (error) {
        logger.error(`? Error processing deposit ${uniqueCode}:`, error.message);
      }
    }
  } catch (error) {
    const errMsg = error && error.message ? error.message : String(error);
    const nowErr = Date.now();
    if (nowErr - lastPollErrorTime > POLL_ERROR_INTERVAL) {
      logger.error('? Polling error:', errMsg);
      lastPollErrorTime = nowErr;
    }
  }
}


// =================== FUNGSI BANTUAN ===================

async function processSuccessfulPayment(deposit, uniqueCode) {
  logger.info(`💰 Processing successful payment: ${uniqueCode}`);
  
  try {
    const bonusConfig = loadTopupBonusSetting();
    const amountBase = deposit.originalAmount;
    const walletType = normalizeWalletType(deposit.walletType || 'vpn');
    let bonusPercent = 0;
    if (walletType === 'vpn' && bonusConfig.enabled) {
      if (amountBase >= 10000 && amountBase <= 49000) {
        bonusPercent = bonusConfig.range_10_40;
      } else if (amountBase >= 50000 && amountBase <= 79000) {
        bonusPercent = bonusConfig.range_50_70;
      } else if (amountBase >= 80000) {
        bonusPercent = bonusConfig.range_70_100;
      }
    }
    const bonusAmount = Math.floor((amountBase * bonusPercent) / 100);
    const totalCredit = amountBase + bonusAmount;
    const walletColumn = getWalletColumn(walletType);
    const walletLabel = getWalletLabel(walletType);
    const transactionSuffix = getWalletTransactionSuffix(walletType);
    const depositType = transactionSuffix === 'ppob' ? 'deposit_ppob' : 'deposit';
    const bonusType = transactionSuffix === 'ppob' ? 'deposit_bonus_ppob' : 'deposit_bonus';

    // 1. UPDATE SALDO USER (HANYA NOMINAL ASLI + BONUS)
    db.run(`UPDATE users SET ${walletColumn} = ${walletColumn} + ? WHERE user_id = ?`,
      [totalCredit, deposit.userId],
      async (err) => {
        if (err) {
          logger.error('❌ Error update saldo:', err.message);
          return;
        }
        
        logger.info(`✅ Saldo updated: +${totalCredit} for user ${deposit.userId} (bonus ${bonusAmount})`);
        
        // 2. SIMPAN TRANSAKSI
        db.run(
          'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
          [deposit.userId, deposit.originalAmount, depositType, deposit.referenceId, Date.now()],
          (err) => {
            if (err) {
              logger.error('❌ Error save transaction:', err.message);
            } else {
              logger.info(`✅ Transaction saved: ${deposit.referenceId}`);
            }
          }
        );
        if (bonusAmount > 0) {
          const bonusRef = `${deposit.referenceId}-bonus`;
          db.run(
            'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
            [deposit.userId, bonusAmount, bonusType, bonusRef, Date.now()],
            (err) => {
              if (err) logger.error('❌ Error save bonus transaction:', err.message);
            }
          );
        }
        
        // 3. HAPUS DARI PENDING
        delete global.pendingDeposits[uniqueCode];
        db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
        
        // 4. AMBIL SALDO TERBARU
        db.get(`SELECT ${walletColumn} AS current_balance FROM users WHERE user_id = ?`, [deposit.userId], async (err, row) => {
          const currentBalance = row ? row.current_balance : totalCredit;
          const resellerTerms = loadResellerTerms();
          const joinMinTopup = Math.max(0, Number(resellerTerms.join_topup_min) || 0);
          const eligibleForReseller =
            walletType === 'vpn' &&
            String(deposit.topupPurpose || '') === 'reseller_join' &&
            Number(deposit.originalAmount || 0) >= joinMinTopup;
          const alreadyReseller = await isUserReseller(deposit.userId).catch(() => false);
          if (eligibleForReseller && !alreadyReseller) {
            addReseller(deposit.userId);
          }
          
          // 5. KIRIM NOTIFIKASI KE USER
          try {
            await bot.telegram.sendMessage(
              deposit.userId,
              `🎉 *PEMBAYARAN BERHASIL!*\n\n` +
              `💰 Top-up: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
              `🎯 Tujuan saldo: ${walletLabel}\n` +
              (bonusAmount > 0 ? `🎁 Bonus: Rp ${bonusAmount.toLocaleString('id-ID')}\n` : '') +
              `💵 Total bayar: Rp ${deposit.amount.toLocaleString('id-ID')}\n` +
              `🏦 ${walletLabel} sekarang: Rp ${currentBalance.toLocaleString('id-ID')}\n\n` +
              (eligibleForReseller
                ? '✅ Status reseller: aktif\n\n'
                : '') +
              `🆔 Referensi: \`${deposit.referenceId}\`\n` +
              `⏰ ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
              { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
            );
            
            // 6. HAPUS QR MESSAGE
            if (deposit.qrMessageId) {
              try {
                await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
              } catch (e) {
                // Pesan mungkin sudah dihapus
              }
            }
            
            // 7. NOTIFIKASI KE GRUP ADMIN
            if (GROUP_ID_NUM) {
              try {
                await bot.telegram.sendMessage(
                  GROUP_ID_NUM,
                  `💰 *TOP-UP BERHASIL*\n\n` +
                  `👤 User: \`${deposit.userId}\`\n` +
                  `💸 Amount: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
                  `🎯 Wallet: ${walletLabel}\n` +
                  (bonusAmount > 0 ? `🎁 Bonus: Rp ${bonusAmount.toLocaleString('id-ID')}\n` : '') +
                  `🏦 New Balance: Rp ${currentBalance.toLocaleString('id-ID')}\n` +
                  `🆔 Ref: ${deposit.referenceId.substring(0, 12)}...`,
                  { parse_mode: 'Markdown' }
                );
              } catch (e) {
                // Ignore group notification errors
                logger.warn(`⚠️ [DEBUG] Gagal kirim notif TOP-UP BERHASIL ke GROUP_ID_NUM (${GROUP_ID_NUM}): ${e.message}`);
              }
            } else {
              logger.warn('⚠️ [DEBUG] GROUP_ID_NUM kosong/null, notif TOP-UP BERHASIL di-skip.');
            }

            await notifyVpnTopupGroups(deposit, currentBalance, bonusAmount);
            await notifyPpobTopupGroups(deposit, currentBalance, bonusAmount);
            if (walletType === 'ppob') {
              const digiBalance = await getDigiflazzBalanceSafe();
              if (digiBalance.ok) {
                await warnLowDigiflazzBalanceIfNeeded(digiBalance.balance, `Topup saldo PPOB user ${deposit.userId}`);
              }
            }
            
            logger.info(`✅ Payment completed for ${uniqueCode}`);
            
          } catch (notifyError) {
            logger.error('❌ Notification error:', notifyError.message);
          }
        });
      }
    );
    
  } catch (error) {
    logger.error(`❌ Payment processing error for ${uniqueCode}:`, error.message);
  }
}

function timingSafeHexEqual(left, right) {
  const a = Buffer.from(String(left || '').toLowerCase(), 'utf8');
  const b = Buffer.from(String(right || '').toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function authenticateDanaBridgeRequest(req) {
  if (DANA_BRIDGE_SECRET.length < 32) {
    throw Object.assign(new Error('DANA Bridge belum dikonfigurasi.'), { statusCode: 503 });
  }

  const timestampHeader = String(req.headers['x-dana-timestamp'] || '').trim();
  const nonce = String(req.headers['x-dana-nonce'] || '').trim();
  const signature = String(req.headers['x-dana-signature'] || '').trim();
  const timestampNumber = Number(timestampHeader);
  const timestampMs = timestampNumber > 1e12 ? timestampNumber : timestampNumber * 1000;
  const maxSkewMs = Math.max(30, Number(DANA_BRIDGE_MAX_CLOCK_SKEW_SECONDS || 300)) * 1000;

  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    throw Object.assign(new Error('Timestamp request tidak valid atau terlalu lama.'), { statusCode: 401 });
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) {
    throw Object.assign(new Error('Nonce request tidak valid.'), { statusCode: 401 });
  }
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw Object.assign(new Error('Signature request tidak valid.'), { statusCode: 401 });
  }

  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const expected = crypto
    .createHmac('sha256', DANA_BRIDGE_SECRET)
    .update(`${timestampHeader}.${nonce}.`, 'utf8')
    .update(rawBody)
    .digest('hex');
  if (!timingSafeHexEqual(signature, expected)) {
    throw Object.assign(new Error('Signature request tidak cocok.'), { statusCode: 401 });
  }

  await dbRunAsync('DELETE FROM dana_bridge_requests WHERE received_at < ?', [Date.now() - 10 * 60 * 1000]);
  try {
    await dbRunAsync('INSERT INTO dana_bridge_requests (nonce, received_at) VALUES (?, ?)', [nonce, Date.now()]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error.message || ''))) {
      throw Object.assign(new Error('Request replay terdeteksi.'), { statusCode: 409 });
    }
    throw error;
  }
}

function parseDanaBusinessNotification(body) {
  const packageName = String(body?.package_name || '').trim();
  const title = String(body?.title || '').trim();
  const message = String(body?.message || body?.text || '').replace(/\s+/g, ' ').trim();
  const deviceId = String(body?.device_id || '').trim().slice(0, 128);
  const notificationKey = String(body?.notification_key || '').trim().slice(0, 256);
  const postedAt = Number(body?.posted_at || 0);

  if (packageName !== 'id.dana') throw new Error('Package notifikasi bukan id.dana.');
  if (!/^pembayaran masuk$/i.test(title)) throw new Error('Judul notifikasi bukan Pembayaran Masuk.');
  if (!deviceId) throw new Error('Device ID kosong.');
  if (!Number.isFinite(postedAt) || postedAt < Date.now() - 24 * 60 * 60 * 1000 || postedAt > Date.now() + 2 * 60 * 1000) {
    throw new Error('Waktu notifikasi tidak valid.');
  }

  const match = message.match(/^Rp\s*([\d.,]+)\s+dari\s+(.+?)\s+berhasil\s+diterima\s+DANA\s+Bisnis\.?$/i);
  if (!match) throw new Error('Format notifikasi pembayaran DANA tidak dikenali.');
  const amount = Number(String(match[1]).replace(/[^\d]/g, ''));
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Nominal notifikasi tidak valid.');

  const payerSource = String(match[2] || '').trim().slice(0, 80);
  const eventId = crypto
    .createHash('sha256')
    .update([deviceId, notificationKey, postedAt, title, message].join('|'), 'utf8')
    .digest('hex');
  if (body?.event_id && String(body.event_id).toLowerCase() !== eventId) {
    throw new Error('Event ID tidak cocok dengan isi notifikasi.');
  }

  return { eventId, deviceId, notificationKey, postedAt, title, message, amount, payerSource };
}

app.post('/payment/dana-notification/heartbeat', async (req, res) => {
  try {
    await authenticateDanaBridgeRequest(req);
    const deviceId = String(req.body?.device_id || '').trim().slice(0, 128);
    if (!deviceId) return res.status(400).json({ ok: false, message: 'device_id wajib diisi' });
    const status = saveDanaBridgeStatus({
      last_seen_at: Date.now(),
      device_id: deviceId,
      app_version: String(req.body?.app_version || '').trim().slice(0, 32),
      queue_size: Math.max(0, Number(req.body?.queue_size || 0))
    });
    return res.json({ ok: true, server_time: Date.now(), online: true, status });
  } catch (error) {
    return res.status(Number(error.statusCode || 400)).json({ ok: false, message: error.message });
  }
});

app.post('/payment/dana-notification', async (req, res) => {
  try {
    await authenticateDanaBridgeRequest(req);
    const event = parseDanaBusinessNotification(req.body || {});
    saveDanaBridgeStatus({
      last_seen_at: Date.now(),
      last_event_at: event.postedAt,
      device_id: event.deviceId,
      queue_size: Math.max(0, Number(req.body?.queue_size || 0))
    });

    try {
      await dbRunAsync(
        `INSERT INTO dana_bridge_events
         (event_id, device_id, amount, payer_source, notification_key, posted_at, received_at, title, message, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
        [event.eventId, event.deviceId, event.amount, event.payerSource, event.notificationKey, event.postedAt, Date.now(), event.title, event.message]
      );
    } catch (error) {
      if (/unique|constraint/i.test(String(error.message || ''))) {
        return res.json({ ok: true, duplicate: true, event_id: event.eventId });
      }
      throw error;
    }

    const candidates = Object.entries(global.pendingDeposits || {}).filter(([_, deposit]) => {
      if (!deposit || deposit.status !== 'pending') return false;
      if (String(deposit.gatewayProvider || '').toLowerCase() !== 'dana_notification') return false;
      if (Number(deposit.amount || 0) !== event.amount) return false;
      const createdAt = Number(deposit.createdAt || deposit.timestamp || 0);
      const expiresAt = Number(deposit.expiresAt || (createdAt + getPaymentQrExpireMs('dana_notification')));
      return event.postedAt >= createdAt - 2 * 60 * 1000 && event.postedAt <= expiresAt + 2 * 60 * 1000;
    });

    if (candidates.length !== 1) {
      const status = candidates.length > 1 ? 'ambiguous' : 'unmatched';
      await dbRunAsync('UPDATE dana_bridge_events SET status = ? WHERE event_id = ?', [status, event.eventId]);
      logger.warn(`DANA Bridge event ${event.eventId.slice(0, 12)} ${status}: amount=${event.amount}, candidates=${candidates.length}`);
      return res.status(202).json({ ok: true, matched: false, status, event_id: event.eventId });
    }

    const [uniqueCode, deposit] = candidates[0];
    deposit.status = 'processing';
    await dbRunAsync("UPDATE pending_deposits SET status = 'processing' WHERE unique_code = ? AND status = 'pending'", [uniqueCode]);
    await dbRunAsync(
      "UPDATE dana_bridge_events SET status = 'matched', matched_unique_code = ? WHERE event_id = ?",
      [uniqueCode, event.eventId]
    );
    logger.info(`DANA Bridge matched ${uniqueCode}: Rp ${event.amount} dari ${event.payerSource}`);
    await processSuccessfulPayment(deposit, uniqueCode);
    return res.json({ ok: true, matched: true, event_id: event.eventId, reference_id: deposit.referenceId });
  } catch (error) {
    logger.warn(`DANA Bridge request ditolak: ${error.message}`);
    return res.status(Number(error.statusCode || 400)).json({ ok: false, message: error.message });
  }
});

app.get('/payment/dana-notification/health', (_req, res) => {
  const status = loadDanaBridgeStatus();
  return res.json({
    ok: true,
    configured: DANA_BRIDGE_SECRET.length >= 32 && !!DANA_QRIS,
    online: isDanaBridgeOnline(),
    last_seen_at: Number(status.last_seen_at || 0),
    queue_size: Math.max(0, Number(status.queue_size || 0))
  });
});

let danaBridgeReconcileRunning = false;
async function reconcileUnmatchedDanaBridgeEvents() {
  if (danaBridgeReconcileRunning) return;
  danaBridgeReconcileRunning = true;
  try {
    const events = await dbAllAsync(
      `SELECT event_id, amount, posted_at
       FROM dana_bridge_events
       WHERE status IN ('unmatched', 'ambiguous') AND received_at >= ?
       ORDER BY received_at ASC LIMIT 50`,
      [Date.now() - 24 * 60 * 60 * 1000]
    );
    for (const event of events) {
      const candidates = Object.entries(global.pendingDeposits || {}).filter(([_, deposit]) => {
        if (!deposit || deposit.status !== 'pending') return false;
        if (String(deposit.gatewayProvider || '').toLowerCase() !== 'dana_notification') return false;
        if (Number(deposit.amount || 0) !== Number(event.amount || 0)) return false;
        const createdAt = Number(deposit.createdAt || deposit.timestamp || 0);
        const expiresAt = Number(deposit.expiresAt || (createdAt + getPaymentQrExpireMs('dana_notification')));
        return Number(event.posted_at) >= createdAt - 2 * 60 * 1000 && Number(event.posted_at) <= expiresAt + 2 * 60 * 1000;
      });
      if (candidates.length !== 1) continue;

      const [uniqueCode, deposit] = candidates[0];
      deposit.status = 'processing';
      await dbRunAsync("UPDATE pending_deposits SET status = 'processing' WHERE unique_code = ? AND status = 'pending'", [uniqueCode]);
      await dbRunAsync(
        "UPDATE dana_bridge_events SET status = 'matched', matched_unique_code = ? WHERE event_id = ?",
        [uniqueCode, event.event_id]
      );
      logger.info(`DANA Bridge reconciled ${uniqueCode}: Rp ${event.amount}`);
      await processSuccessfulPayment(deposit, uniqueCode);
    }
  } catch (error) {
    logger.warn(`Reconcile DANA Bridge gagal: ${error.message}`);
  } finally {
    danaBridgeReconcileRunning = false;
  }
}

const danaBridgeReconcileTimer = setInterval(reconcileUnmatchedDanaBridgeEvents, 15 * 1000);
if (typeof danaBridgeReconcileTimer.unref === 'function') danaBridgeReconcileTimer.unref();

// 🔧 SIMPLIFIKASI:
async function handleExpiredDeposit(deposit, uniqueCode) {
  try {
    const expireMinutes = getPaymentQrExpireMinutes(deposit.gatewayProvider || 'orderkuota');
    // 1. HAPUS QR DARI CHAT
    if (deposit.qrMessageId) {
      try {
        await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
      } catch (e) {}
    }
    
    // 2. KIRIM NOTIF EXPIRED
    await bot.telegram.sendMessage(
      deposit.userId,
      '❌ *QR CODE EXPIRED*\n\n' +
      `QR Code sudah tidak berlaku (${expireMinutes} menit).\n` +
      `💰 Nominal: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
      `🎯 Tujuan: ${getWalletLabel(deposit.walletType || 'vpn')}\n` +
      `💵 Total: Rp ${deposit.amount.toLocaleString('id-ID')}\n\n` +
      `Silakan buat permintaan top-up baru.`+
      `Jika sudah terlanjur bayar diatas ${expireMinutes} menit dan saldo ga masuk hubungi admin lewat WA: ${getAdminWhatsappNumber() || '-'} atau Telegram: ${getAdminTelegramUsername()}`,
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
    
    // 3. HAPUS DARI MEMORY & DB
    delete global.pendingDeposits[uniqueCode];
    db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
    
    logger.info(`🗑️ Expired cleaned: ${uniqueCode}`);
    
  } catch (error) {
    logger.error(`❌ Error expired:`, error.message);
  }
}

////////
function cleanupStuckDeposits() {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  
  Object.keys(global.pendingDeposits).forEach(uniqueCode => {
    const deposit = global.pendingDeposits[uniqueCode];
    
    // Jika deposit dibuat > 5 menit yang lalu dan masih "generating"
    if (deposit.createdAt && deposit.createdAt < fiveMinutesAgo && 
        deposit.status === 'generating') {
      logger.info(`🧹 Cleaning up stuck deposit: ${uniqueCode}`);
      delete global.pendingDeposits[uniqueCode];
      
      // Hapus dari database juga
      db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
    }
  });
}

// Tambahkan ke interval cleanup
setInterval(cleanupStuckDeposits, 60000); // Setiap 1 menit

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_nomor() {
  const buttons = [
    [{ text: '1', callback_data: '1' }, { text: '2', callback_data: '2' }, { text: '3', callback_data: '3' }],
    [{ text: '4', callback_data: '4' }, { text: '5', callback_data: '5' }, { text: '6', callback_data: '6' }],
    [{ text: '7', callback_data: '7' }, { text: '8', callback_data: '8' }, { text: '9', callback_data: '9' }],
    [{ text: '0', callback_data: '0' }, { text: '00', callback_data: '00' }],
    [{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }],
    [
      { text: '💰 5rb', callback_data: '5000' },
      { text: '💰 10rb', callback_data: '10000' },
      { text: '💰 20rb', callback_data: '20000' }
    ],
    [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
  ];
  return buttons;
}

function keyboard_nomor_simple() {
  const buttons = [
    [{ text: '1', callback_data: '1' }, { text: '2', callback_data: '2' }, { text: '3', callback_data: '3' }],
    [{ text: '4', callback_data: '4' }, { text: '5', callback_data: '5' }, { text: '6', callback_data: '6' }],
    [{ text: '7', callback_data: '7' }, { text: '8', callback_data: '8' }, { text: '9', callback_data: '9' }],
    [{ text: '0', callback_data: '0' }, { text: '00', callback_data: '00' }],
    [{ text: 'Hapus', callback_data: 'delete' }, { text: 'Konfirmasi', callback_data: 'confirm' }],
    [{ text: 'Kembali ke Menu', callback_data: 'send_main_menu' }]
  ];
  return buttons;
}

function keyboard_full() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId], function(err, row) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengambil saldo user:', err.message);
          reject(err);
      } else {
        resolve(row ? row.saldo : 0);
        }
    });
  });
}

// ✅ JALANKAN CLEANUP SETIAP 5 MENIT
setInterval(cleanupOldDeposits, 5 * 60 * 1000);
// Cleanup polling broadcast lama setiap 12 jam
setInterval(cleanupOldBroadcastPolls, 12 * 60 * 60 * 1000);


// ✅ FUNGSI CLEANUP PROCESSED TRANSACTIONS
function cleanupProcessedTransactions() {
  if (!global.processedTransactions || global.processedTransactions.size === 0) {
    return;
  }
  
  const oldSize = global.processedTransactions.size;
  
  // Hapus semua yang sudah lebih dari 24 jam
  // (Karena kita sudah set timeout di setiap add, ini backup saja)
  global.processedTransactions.clear();
  
  if (oldSize > 0) {
    logger.info(`🧹 Cleaned ${oldSize} processed transactions from cache`);
  }
}


function cleanupOldDeposits() {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  let cleanedCount = 0;
  
  Object.keys(global.pendingDeposits).forEach(uniqueCode => {
    const deposit = global.pendingDeposits[uniqueCode];
    
    // ✅ CEK: Deposit lebih dari 1 jam dan masih pending
    if (deposit.createdAt && deposit.createdAt < oneHourAgo && deposit.status === 'pending') {
      logger.info(`🧹 Cleaning up old deposit: ${uniqueCode}, Age: ${now - deposit.createdAt}ms`);
      
      // ✅ HAPUS PESAN QR CODE JIKA ADA
      if (deposit.qrMessageId) {
        try {
          bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId).catch(() => {});
        } catch (e) {
          // Ignore error jika pesan sudah dihapus
        }
      }
      
      // ✅ KIRIM NOTIFIKASI KE USER (OPSIONAL)
      try {
        bot.telegram.sendMessage(
          deposit.userId,
          '📝 *Pengingat*\n\n' +
          'Deposit Anda yang belum dibayar telah dihapus dari sistem.\n' +
          'Silakan buat deposit baru jika masih ingin top-up.',
          { parse_mode: 'Markdown' }
        ).catch(() => {}); // Ignore jika user block bot
      } catch (e) {
        // Ignore error
      }
      
      delete global.pendingDeposits[uniqueCode];
      cleanedCount++;
      
      // ✅ HAPUS DARI DATABASE
      db.run('DELETE FROM pending_deposits WHERE unique_code = ?', 
        [uniqueCode], 
        (err) => {
          if (err) logger.error('Error cleaning up old deposit:', err.message);
        }
      );
    }
  });
  
  if (cleanedCount > 0) {
    logger.info(`🧹 Cleaned ${cleanedCount} old pending deposits`);
  }
}

// =================== JALANKAN POLLING ===================

// Scheduler jalan tiap 10 detik untuk GoPay dan expiry; histori OrderKuota hanya dicek lewat tombol manual.
setInterval(pollBankMutations, GOPAY_POLL_INTERVAL);

// Jalankan cleanup setiap jam
setInterval(cleanupOldDeposits, 60 * 60 * 1000);

// Jalankan polling segera setelah startup
setTimeout(pollBankMutations, 5000);

// Jalankan setiap 6 jam
setInterval(cleanupProcessedTransactions, 6 * 60 * 60 * 1000);

// Jalankan cleanup setiap 5 menit
setInterval(cleanupOldDeposits, 5 * 60 * 1000);


// ✅ FUNGSI UNTUK GENERATE RANDOM FEE YANG UNIK
async function generateUniqueFee(baseAmount, userId, existingDeposits) {
  logger.info(`🎲 Generating unique fee for user ${userId}, base: ${baseAmount}`);
  
  // Ambil semua amount yang sedang pending (dalam 24 jam)
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentDeposits = existingDeposits
    .filter(d => d.createdAt > twentyFourHoursAgo && d.status === 'pending');
  
  const recentAmounts = recentDeposits.map(d => d.amount);
  
  logger.info(`   Found ${recentAmounts.length} recent pending amounts`);
  
  // Tampilkan amounts yang sudah ada untuk debugging
  if (recentAmounts.length > 0) {
    logger.info(`   Existing amounts: ${recentAmounts.join(', ')}`);
  }
  
  let attempts = 0;
  const maxAttempts = 20; // Naikkan dari 15 ke 20
  let adminFee, finalAmount;
  let foundUnique = false;
  
  // Coba generate amount unik
  while (attempts < maxAttempts && !foundUnique) {
    attempts++;
    
    // Generate random fee 100-200 dengan variasi lebih banyak
    adminFee = Math.floor(Math.random() * 101) + 100;
    
    // Tambahkan random adjustment kecil (0-99) untuk lebih unik
    const randomAdjustment = Math.floor(Math.random() * 100);
    finalAmount = baseAmount + adminFee + randomAdjustment;
    
    logger.info(`   Attempt ${attempts}: ${baseAmount} + ${adminFee} + ${randomAdjustment} = ${finalAmount}`);
    
    // Cek apakah amount ini unik
    if (!recentAmounts.includes(finalAmount)) {
      // Double check di database (pending deposits) dengan query lebih spesifik
      try {
        const dbCheck = await new Promise((resolve) => {
          db.get(
            `SELECT COUNT(*) as count FROM pending_deposits 
             WHERE amount = ? 
             AND created_at > ? 
             AND status = 'pending'`,
            [finalAmount, twentyFourHoursAgo],
            (err, row) => {
              if (err) {
                logger.error('❌ DB check error:', err.message);
                resolve(0);
              } else {
                resolve(row ? row.count : 0);
              }
            }
          );
        });
        
        if (dbCheck === 0) {
          foundUnique = true;
          logger.info(`   ✅ Found unique amount after ${attempts} attempts`);
          break;
        } else {
          logger.info(`   ❌ Amount ${finalAmount} exists in database, trying again...`);
        }
      } catch (dbError) {
        logger.error('❌ Error checking database:', dbError.message);
      }
    } else {
      logger.info(`   ❌ Amount ${finalAmount} exists in recent amounts, trying again...`);
    }
    
    // Tunggu sedikit sebelum coba lagi
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // JIKA MASIH TIDAK UNIK SETELAH MAX ATTEMPTS
  if (!foundUnique) {
    logger.warn(`⚠️ Could not find unique amount after ${maxAttempts} attempts`);
    
    // Gunakan algoritma fallback yang garansi unik
    // Gabungkan timestamp + user ID untuk garansi keunikan
    const timestampPart = Date.now() % 10000; // 0-9999
    const userIdPart = userId % 100; // 0-99
    const microAdjustment = (timestampPart + userIdPart) % 100; // 0-99
    
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee + microAdjustment;
    
    logger.info(`   🔄 Using guaranteed unique amount: ${baseAmount} + ${adminFee} + ${microAdjustment} = ${finalAmount}`);
    logger.info(`      Timestamp: ${timestampPart}, UserID: ${userIdPart}, Adjustment: ${microAdjustment}`);
  }
  
  // FINAL VALIDATION - PASTIKAN TIDAK ADA DUPLIKAT
  const finalCheck = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count FROM pending_deposits 
       WHERE amount = ? 
       AND created_at > ? 
       AND status = 'pending'`,
      [finalAmount, Date.now() - (24 * 60 * 60 * 1000)],
      (err, row) => {
        resolve(err ? 1 : (row ? row.count : 0));
      }
    );
  });
  
  if (finalCheck > 0) {
    logger.error(`❌ CRITICAL: Generated amount ${finalAmount} STILL EXISTS in database!`);
    
    // EMERGENCY FALLBACK - PASTI UNIK
    const emergencyAdjustment = Date.now() % 1000;
    finalAmount = baseAmount + 150 + emergencyAdjustment; // 150 sebagai fixed fee
    
    logger.info(`   🚨 EMERGENCY: Using emergency amount: ${finalAmount}`);
  }
  
  logger.info(`   🎯 Final generated: ${baseAmount} + ${adminFee} = ${finalAmount} (unique: ${foundUnique})`);
  
  return {
    adminFee: adminFee,
    finalAmount: finalAmount,
    isUnique: foundUnique || true, // Selalu return true untuk force continue
    attempts: attempts,
    note: foundUnique ? 'Random unique' : 'Guaranteed unique'
  };
}

//////

// ✅ FUNGSI UNTUK GENERATE RANDOM FEE YANG BENAR-BENAR UNIK
function generateUniqueFee(baseAmount, userId) {
  // Generate random fee 100-200
  let adminFee = Math.floor(Math.random() * 101) + 100;
  let finalAmount = baseAmount + adminFee;
  let attempts = 0;
  
  // Cek apakah amount ini sudah pernah dipakai (pending)
  const isAmountUsed = Object.values(global.pendingDeposits)
    .some(d => d.amount === finalAmount);
  
  // Jika sudah dipakai, coba generate ulang (max 5x)
  while (isAmountUsed && attempts < 5) {
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee;
    attempts++;
    
    const newCheck = Object.values(global.pendingDeposits)
      .some(d => d.amount === finalAmount);
    
    if (!newCheck) break;
  }
  
  // Jika masih tabrakan setelah 5x, tambahkan timestamp
  if (attempts >= 5) {
    const timestamp = Date.now() % 100; // 0-99
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee + timestamp;
    logger.warn(`⚠️ Using timestamp adjustment for unique amount`);
  }
  
  return {
    adminFee: adminFee,
    finalAmount: finalAmount,
    attempts: attempts
  };
}

// ✅ FUNGSI UNTUK VALIDATE PAYMENT SECURITY
function validatePaymentSecurity(deposit, matchingTransaction) {
  const securityChecks = [];
  
  // 1. Check timing
  const paymentDelay = matchingTransaction.timestamp - deposit.createdAt;
  securityChecks.push({
    name: 'Timing',
    passed: paymentDelay >= 15000 && paymentDelay <= 270000,
    details: `${Math.round(paymentDelay/1000)}s (15s-4.5m)`
  });
  
  // 2. Check amount match (EXACT)
  securityChecks.push({
    name: 'Amount Match',
    passed: matchingTransaction.kredit === deposit.amount,
    details: `Expected: ${deposit.amount}, Got: ${matchingTransaction.kredit}`
  });
  
  // 3. Check reference in description (optional)
  if (matchingTransaction.deskripsi && matchingTransaction.deskripsi.trim() !== '-') {
    const descLower = matchingTransaction.deskripsi.toLowerCase();
    const hasReference = descLower.includes(deposit.referenceId.toLowerCase()) ||
                        descLower.includes(String(deposit.userId));
    securityChecks.push({
      name: 'Reference Match',
      passed: hasReference,
      details: hasReference ? 'Reference found' : 'No reference found'
    });
  }
  
  // 4. Check if transaction already processed
  const transactionKey = `${matchingTransaction.timestamp}_${deposit.amount}_${deposit.userId}`;
  const alreadyProcessed = global.processedTransactions && 
                          global.processedTransactions.has(transactionKey);
  securityChecks.push({
    name: 'Duplicate Check',
    passed: !alreadyProcessed,
    details: alreadyProcessed ? 'Already processed' : 'New transaction'
  });
  
  // Log all security checks
  logger.info(`🔒 Payment Security Check:`);
  securityChecks.forEach(check => {
    const status = check.passed ? '✅' : '❌';
    logger.info(`   ${status} ${check.name}: ${check.details}`);
  });
  
  // Return true if all mandatory checks pass
  const mandatoryChecks = securityChecks.filter(c => 
    c.name !== 'Reference Match' // Reference match optional
  );
  
  return mandatoryChecks.every(c => c.passed);
}

// ✅ FUNGSI UNTUK SEND PAYMENT SUMMARY
async function sendPaymentSummary(deposit, transactionDetails) {
  try {
    const summary = `
📊 *PAYMENT SUMMARY*

👤 User: ${deposit.userId}
💰 Base Amount: ${deposit.originalAmount}
🎲 Admin Fee: ${deposit.amount - deposit.originalAmount}
💵 Total: ${deposit.amount}
🆔 Reference: ${deposit.referenceId}

⏰ Timing:
• QR Created: ${new Date(deposit.createdAt).toLocaleTimeString('id-ID')}
• Payment Time: ${new Date(transactionDetails.timestamp).toLocaleTimeString('id-ID')}
• Delay: ${Math.round((transactionDetails.timestamp - deposit.createdAt)/1000)}s

🔍 Transaction Details:
• Amount: ${transactionDetails.kredit}
• Time: ${new Date(transactionDetails.timestamp).toLocaleString('id-ID')}
• Description: ${transactionDetails.deskripsi?.substring(0, 50) || 'N/A'}...

✅ Status: VERIFIED & COMPLETED
    `.trim();
    
    // Kirim ke admin/log channel jika ada
    if (GROUP_ID_NUM) {
      await bot.telegram.sendMessage(GROUP_ID_NUM, summary, { parse_mode: 'Markdown' });
    }
    
    logger.info(`📋 Payment summary logged`);
  } catch (error) {
    logger.error('❌ Error sending payment summary:', error.message);
  }
}

async function recordAccountTransaction(userId, type, amount = 0, action = 'other') {
  return new Promise((resolve, reject) => {
    const referenceId = `account-${action}-${type}-${userId}-${Date.now()}`;
    db.run(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [userId, amount, type, referenceId, Date.now()],
      async (err) => {
        if (err) {
          logger.error('Error recording account transaction:', err.message);
          reject(err);
        } else {
          // ✅ TAMBAH: Notifikasi ke grup admin jika user adalah reseller
          try {
            const isReseller = await isUserReseller(userId);
            if (isReseller && GROUP_ID_NUM && action === 'create') {
              // Cek bulan ini sudah berapa akun
              const now = new Date();
              const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
              
              db.get(
                `SELECT COUNT(*) as count FROM transactions 
                 WHERE user_id = ? AND timestamp >= ? 
                 AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
                  AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`,
                [userId, firstDay.getTime()],
                (err, row) => {
                  if (!err && row) {
                    const totalThisMonth = row.count;
                    
                    // Ambil info user
                    bot.telegram.getChat(userId).then(userInfo => {
                      const username = userInfo.username ? `@${userInfo.username}` : 
                                     (userInfo.first_name || `User ${userId}`);
                      
                      bot.telegram.sendMessage(
                        GROUP_ID_NUM,
                        `🛍️ *RESELLER TRANSAKSI*\n\n` +
                        `👤 Reseller: ${username}\n` +
                        `📦 Tipe: ${type.toUpperCase()}\n` +
                        `📊 Total Bulan Ini: ${totalThisMonth} akun\n` +
                        `⏰ ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
                        { parse_mode: 'Markdown' }
                      ).catch(e => logger.error('Gagal kirim notif reseller:', e.message));
                    }).catch(() => {
                      // Skip jika tidak bisa dapatkan info user
                    });
                  }
                }
              );
            }
          } catch (e) {
            // Skip error notifikasi
          }
          
          resolve();
        }
      }
    );
  });
}

// =============================
// 📦 AUTO BACKUP DATABASE 24 JAM
// =============================

const schedule = require('node-schedule');

async function sendPpobAutoSyncReportToAdminGroup(text) {
  const groupId = getPpobAdminGroupId();
  if (!groupId) return;
  try {
    await bot.telegram.sendMessage(groupId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn(`Gagal kirim laporan auto sync PPOB: ${err.message}`);
  }
}

async function runPpobAutoSyncProducts(trigger = 'schedule') {
  try {
    const sync = await syncPpobProductsFromDigiflazz();
    const catalog = await ppobLoadCatalogFromDb();
    const visibleCatalog = ppobApplyVisibilityFilter(catalog);
    const report = [
      '<b>AUTO SYNC PRODUK PPOB SELESAI</b>',
      '',
      `Trigger: <code>${escapeHtml(trigger)}</code>`,
      `Produk diterima Digiflazz: <b>${sync.fetched}</b>`,
      `Produk aktif di DB: <b>${catalog.products.length}</b>`,
      `Produk tampil ke user: <b>${visibleCatalog.products.length}</b>`,
      `Produk lama dinonaktifkan: <b>${sync.deactivated}</b>`,
      `Waktu sync: <b>${escapeHtml(formatPpobLastSync(sync.syncedAt))}</b>`
    ].join('\n');
    logger.info(`[PPOB AutoSync:${trigger}] selesai. fetched=${sync.fetched}, active=${catalog.products.length}, visible=${visibleCatalog.products.length}, deactivated=${sync.deactivated}`);
    await sendPpobAutoSyncReportToAdminGroup(report);
  } catch (err) {
    logger.error(`[PPOB AutoSync:${trigger}] gagal: ${err.message}`);
    const existingCatalog = await ppobLoadCatalogFromDb().catch(() => ({ products: [] }));
    if (Array.isArray(existingCatalog.products) && existingCatalog.products.length > 0) {
      await sendPpobAutoSyncReportToAdminGroup(
        [
          '<b>AUTO SYNC PRODUK PPOB DILEWATI</b>',
          '',
          `Trigger: <code>${escapeHtml(trigger)}</code>`,
          `Alasan: <code>${escapeHtml(err.message || String(err))}</code>`,
          `Katalog DB lama tetap aktif: <b>${existingCatalog.products.length} produk</b>`,
          '',
          'Tidak ada produk yang dinonaktifkan.'
        ].join('\n')
      );
      return;
    }
    await sendPpobAutoSyncReportToAdminGroup(
      [
        '<b>AUTO SYNC PRODUK PPOB GAGAL</b>',
        '',
        `Trigger: <code>${escapeHtml(trigger)}</code>`,
        `Error: <code>${escapeHtml(err.message || String(err))}</code>`
      ].join('\n')
    );
  }
}

function restartPpobAutoSyncScheduler() {
  if (ppobAutoSyncJob) {
    ppobAutoSyncJob.cancel();
    ppobAutoSyncJob = null;
  }

  PPOB_AUTOSYNC_TIME = normalizePpobCutoffTime(PPOB_AUTOSYNC_TIME, '00:05');
  if (!PPOB_AUTOSYNC_ENABLED) {
    logger.info('[PPOB AutoSync] scheduler nonaktif');
    return;
  }

  const [hour, minute] = PPOB_AUTOSYNC_TIME.split(':').map(Number);
  const rule = new schedule.RecurrenceRule();
  rule.tz = 'Asia/Jakarta';
  rule.hour = hour;
  rule.minute = minute;

  ppobAutoSyncJob = schedule.scheduleJob('ppob_product_autosync_daily', rule, () => {
    runPpobAutoSyncProducts('daily_schedule');
  });
  logger.info(`[PPOB AutoSync] scheduler aktif setiap ${PPOB_AUTOSYNC_TIME} WIB`);
}

restartPpobAutoSyncScheduler();

const resellerRule = new schedule.RecurrenceRule();
resellerRule.tz = 'Asia/Jakarta';
resellerRule.dayOfMonth = 1;
resellerRule.hour = 0;
resellerRule.minute = 10;

schedule.scheduleJob('reseller_monthly_check', resellerRule, async () => {
  try {
    const now = new Date();
    if (now.getDate() !== 1) {
      logger.warn('Skip reseller check (bukan tanggal 1).');
      return;
    }
    const year = now.getFullYear();
    const month = now.getMonth();
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 1, 0, 0, 0, 0);
    const periodLabel = start.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    await evaluateResellerTermsForPeriod(start.getTime(), end.getTime(), periodLabel);
  } catch (err) {
    logger.error('Error menjalankan evaluasi syarat reseller:', err.message);
  }
});

const resellerWarningRule = new schedule.RecurrenceRule();
resellerWarningRule.tz = 'Asia/Jakarta';
resellerWarningRule.hour = 0;
resellerWarningRule.minute = 10;

schedule.scheduleJob('reseller_monthly_warning', resellerWarningRule, async () => {
  try {
    const now = new Date();
    const nextMonthFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUntilFirst = Math.ceil((nextMonthFirst - now) / msPerDay);

    if (daysUntilFirst !== 5) return;

    const terms = loadResellerTerms();
    const resellers = listResellersSync();
    if (resellers.length === 0) return;

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodLabel = monthStart.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    for (const resellerId of resellers) {
      const stats = await getResellerStatsForPeriod(resellerId, monthStart.getTime(), now.getTime());
      if (stats.topup >= terms.min_topup) continue;

      const remaining = Math.max(0, terms.min_topup - stats.topup);
      const message =
        `⏰ *PENGINGAT SYARAT RESELLER*\n\n` +
        `Periode: ${periodLabel}\n` +
        `Top up saat ini: ${formatRupiah(stats.topup)}\n` +
        `Minimal top up: ${formatRupiah(terms.min_topup)}\n` +
        `Sisa target: ${formatRupiah(remaining)}\n\n` +
        `Sisa waktu: 5 hari lagi menuju reset bulan.\n` +
        `Segera penuhi target agar status reseller tidak turun.`;

      try {
        await bot.telegram.sendMessage(resellerId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('Gagal kirim notifikasi pengingat reseller:', err.message);
      }
    }
  } catch (err) {
    logger.error('Error menjalankan pengingat reseller:', err.message);
  }
});

const serverSyncRule = new schedule.RecurrenceRule();
serverSyncRule.tz = 'Asia/Jakarta';
serverSyncRule.minute = [0, 10, 20, 30, 40, 50];

schedule.scheduleJob('server_usage_sync_10m', serverSyncRule, async () => {
  try {
    const result = await syncServerUsageFromTunnel('every_10m');
    logger.info(
      `[SyncServer:every_10m] selesai. dicek=${result.checked}, berhasil=${result.updated}, gagal=${result.failed}, dilewati=${result.skipped}`
    );
  } catch (err) {
    logger.error(`[SyncServer:every_10m] gagal: ${err.message}`);
  }
});

let bandwidthReportTimer = null;
async function runBandwidthReportTick(trigger = 'interval') {
  try {
    if (!Number(BW_NOTIF_GROUP_ID_NUM)) return;
    await syncServerUsageFromTunnel(`bw_report_${trigger}`, { force: true });
    await sendBandwidthReportToGroup(BW_NOTIF_GROUP_ID_NUM);
    logger.info(`[BWReport:${trigger}] laporan bandwidth terkirim ke ${BW_NOTIF_GROUP_ID_NUM}`);
  } catch (err) {
    logger.error(`[BWReport:${trigger}] gagal kirim laporan bandwidth: ${err.message}`);
  }
}

function restartBandwidthReportScheduler() {
  try {
    if (bandwidthReportTimer) {
      clearInterval(bandwidthReportTimer);
      bandwidthReportTimer = null;
    }

    const minutes = Number(BW_REPORT_INTERVAL_MINUTES || 0);
    if (!Number.isFinite(minutes) || minutes < 5) {
      logger.warn('[BWReport] scheduler dimatikan karena interval tidak valid');
      return;
    }

    bandwidthReportTimer = setInterval(() => {
      runBandwidthReportTick('dynamic').catch(() => {});
    }, minutes * 60 * 1000);

    logger.info(`[BWReport] scheduler aktif setiap ${minutes} menit`);
  } catch (err) {
    logger.error(`[BWReport] gagal restart scheduler: ${err.message}`);
  }
}

restartBandwidthReportScheduler();
const dbFile = runtimePath("sellvpn.db");
const autoBackupDir = runtimePath("auto_backup");

if (!fs.existsSync(autoBackupDir)) fs.mkdirSync(autoBackupDir);

// Fungsi kirim backup otomatis ke admin
function getNormalizedAdminIds() {
  if (Array.isArray(adminIds)) {
    return adminIds
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  if (typeof adminIds === 'string') {
    return adminIds
      .split(/[,\n\s]+/)
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  const single = Number(adminIds);
  return Number.isFinite(single) && single > 0 ? [single] : [];
}

async function sendAutoBackup(filePath, preferredAdminId = null) {
  try {
    const admins = getNormalizedAdminIds();
    if (admins.length === 0) {
      logger.error('Tidak ada admin ID valid yang dikonfigurasi');
      return;
    }

    const targetAdminId = Number(preferredAdminId) > 0 ? Number(preferredAdminId) : admins[0];

    await bot.telegram.sendDocument(
      targetAdminId,
      { source: filePath },
      { caption: 'Backup otomatis database (setiap 24 jam)' }
    );

    logger.info('Backup otomatis terkirim ke admin: ' + targetAdminId);
  } catch (err) {
    logger.error('Gagal kirim backup otomatis:', {
      error: err.message,
      adminId: Number(preferredAdminId) > 0 ? Number(preferredAdminId) : 'none',
      code: err.response?.error_code
    });
  }
}

// Tambahkan error handler untuk bot
bot.catch((err, ctx) => {
  logger.error(`❌ Bot error: ${err.message}`);
  // Jika ini callback query error, coba handle gracefully
  if (ctx && ctx.updateType === 'callback_query') {
    try {
      ctx.answerCbQuery('⚠️ Terjadi kesalahan, coba lagi').catch(() => {});
    } catch (e) {
      // Ignore jika sudah expired
    }
  }
});

app.listen(port, async () => {
  logger.info(`🚀 Server berjalan di port ${port}`);
  
  // =================== VALIDASI AWAL ===================
  try {
    logger.info('🔧 Memeriksa konfigurasi pembayaran...');
    
    reloadRuntimePaymentConfig();
    const readiness = getPaymentGatewayReadiness();

    if (!hasReadyEnabledPaymentGateway(readiness)) {
      logger.error('❌ ❌ ❌ PERINGATAN KRITIS! ❌ ❌ ❌');
      logger.error('Tidak ada payment gateway aktif yang siap: ' + formatMissingGatewayConfig(readiness));
      logger.error('User TIDAK BISA top-up otomatis!');

      // Kirim notifikasi ke admin
// Di app.listen() - bagian yang kirim notifikasi ke admin:
const adminMessage = 
  `🚨 *PERINGATAN SISTEM PEMBAYARAN* 🚨\n\n` +
  `Tidak ada payment gateway aktif yang siap.\n\n` +
  `Detail:\n\`\`\`\n${formatMissingGatewayConfig(readiness)}\n\`\`\`\n\n` +
  `User TIDAK BISA top-up otomatis.\n\n` +

  `📝 *Langkah Perbaikan:*\n` +
  `1. Tonton video tutorial\n` +
  `2. Buka menu admin: *Setting Payment Gateway*\n` +
  `3. Isi Gateway URL, API Key, dan QRIS\n` +
  `4. Update username & token jika perlu\n` +
  `5. Restart: \`pm2 restart app\`\n\n` +
  `🔧 Cek status: /checkpaymentconfig\n\n` +
  `⚠️ Fitur top-up otomatis dinonaktifkan sementara.`;      
      if (Array.isArray(adminIds)) {
        adminIds.forEach(adminId => {
          setTimeout(() => {
            bot.telegram.sendMessage(adminId, adminMessage, { 
              parse_mode: 'Markdown' 
            }).catch(() => {});
          }, 2000);
        });
      }
      
    } else {
      logger.info('✅ Validasi konfigurasi payment startup: OK');
    }
  } catch (error) {
    logger.error('❌ Gagal validasi payment config:', error.message);
  }
  // =================== END VALIDASI ===================
  
  // Fungsi untuk start bot dengan retry
  let isLaunchingBot = false;
  const startBot = async (retryCount = 0) => {
    if (isLaunchingBot) {
      logger.warn('⚠️ startBot dipanggil saat proses launch masih berjalan, skip.');
      return;
    }
    isLaunchingBot = true;
    try {
      logger.info('🔄 Memulai bot...');
      
      // Konfigurasi bot
      const botConfig = {
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query'],
      };
      
      logger.info('⏳ Menonaktifkan webhook (jika ada)...');
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

      logger.info('⏳ Menjalankan bot.launch...');
      // Start bot
      await bot.launch(botConfig);
      logger.info('✅ Bot berhasil dimulai (Polling Mode)');
      
      logger.info('⏳ Menjalankan setMyCommands...');
      // Set commands
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Mulai bot dan tampilkan menu utama' },
        { command: 'admin', description: 'Menu admin (khusus admin)' },
        { command: 'checkpaymentconfig', description: 'Cek status konfigurasi pembayaran' },
        { command: 'syncservernow', description: 'Sinkronisasi total akun server' }
      ]);
      logger.info('✅ Command menu berhasil diset.');
      
      // Enable graceful stop
      const stopBot = () => {
        logger.info('🛑 Stopping bot gracefully...');
        bot.stop();
        process.exit(0);
      };
      
      process.once('SIGINT', stopBot);
      process.once('SIGTERM', stopBot);
      
    } catch (error) {
      const startupErr = {
        message: error?.message || String(error),
        code: error?.code || null,
        description: error?.description || null,
        responseErrorCode: error?.response?.error_code || null,
        responseDescription: error?.response?.description || null,
        stack: error?.stack || null,
      };
      logger.error(`❌ Error saat memulai bot (Attempt ${retryCount + 1}): ${JSON.stringify(startupErr)}`);

      try {
        bot.stop('startup-retry');
      } catch (_) {}
      
      // Jika belum mencapai maksimal retry, coba lagi
      if (retryCount < 3) {
        const delay = Math.min(10000, 2000 * Math.pow(2, retryCount)); // Exponential backoff
        logger.info(`⏳ Akan mencoba lagi dalam ${delay/1000} detik...`);
        
        setTimeout(() => {
          startBot(retryCount + 1);
        }, delay);
      } else {
        logger.error('❌ Gagal memulai bot setelah 3 kali percobaan. Bot dimatikan.');
        process.exit(1);
      }
    } finally {
      isLaunchingBot = false;
    }
  };
  
  // Mulai bot
  startBot();
  
  // Jalankan cleanup awal
  setTimeout(() => {
    logger.info('🚀 Running initial cleanup...');
    cleanupOldDeposits();
    cleanupOldBroadcastPolls();
  }, 10000);
});

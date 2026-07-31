const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

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

function parseJsonFromCurlOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function splitCurlOutput(rawOut) {
  const raw = String(rawOut || '');
  const marker = '__HTTP_STATUS__:';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return { body: raw.trim(), statusCode: 0 };
  const body = raw.slice(0, idx).trim();
  const codeRaw = raw.slice(idx + marker.length).trim();
  const statusCode = Number.parseInt(codeRaw, 10);
  return { body, statusCode: Number.isFinite(statusCode) ? statusCode : 0 };
}

function normalizeAccountQuotaGb(quota) {
  const n = Number(quota);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.round(n));
}

function quotaText(quota) {
  const value = normalizeAccountQuotaGb(quota);
  return value === '0' ? 'Unlimited' : `${value} GB`;
}

async function createzivpn(username, password, exp, iplimit, serverId, telegramUserId = '', telegramChatId = '', selectedIpPackage = 1, quota = 0) {
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return 'Username hanya boleh huruf & angka (tanpa spasi)';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        return resolve('Server tidak ditemukan');
      }

      const baseUrl = normalizeApiBase(server.domain);
      const url = `${baseUrl}/vps/sshvpn`;
      const authToken = normalizeAuthToken(server.auth);
      const effectivePackage = Number(selectedIpPackage) === 2 ? 2 : 1;
      const resolvedQuota = normalizeAccountQuotaGb(quota);

      if (!authToken) {
        return resolve('Auth token server kosong/tidak valid');
      }

      db.get(
        'SELECT iplimit FROM server_iplimit_rules WHERE server_id = ? AND protocol = ? AND ip_package = ?',
        [serverId, 'zivpn', effectivePackage],
        (ruleErr, ruleRow) => {
          const configuredLimit = Number(ruleRow?.iplimit);
          const finalIpLimit = Number.isFinite(configuredLimit) && configuredLimit >= 0
            ? configuredLimit
            : Number(iplimit);
          const resolvedIpLimit = Number.isFinite(finalIpLimit) && finalIpLimit >= 0 ? finalIpLimit : Number(iplimit || 0);

          const runCreate = (authorizationHeader, done) => {
            const cmd = `curl -k -sS -L --connect-timeout 10 --max-time 30 -X POST "${url}" \
      -H "Authorization: ${authorizationHeader}" \
      -H "X-Telegram-User-Id: ${telegramUserId}" \
      -H "X-Telegram-Chat-Id: ${telegramChatId}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      -d '{"expired":${exp},"kuota":"${resolvedQuota}","limitip":"${resolvedIpLimit}","password":"${password}","username":"${username}","telegram_user_id":"${telegramUserId}","telegram_chat_id":"${telegramChatId}"}' \
      -w "\\n__HTTP_STATUS__:%{http_code}"`;

            exec(cmd, (errExec, stdout, stderr) => {
              const { body, statusCode } = splitCurlOutput(stdout);
              const res = parseJsonFromCurlOutput(body);
              done(errExec, stderr, body, res, statusCode);
            });
          };

          const tokenRaw = authToken;
          const tokenBearer = `Bearer ${authToken}`;

          runCreate(tokenRaw, (errExec1, stderr1, stdout1, res1, code1) => {
            const unauthorizedText1 = String(
              res1?.message || res1?.meta?.message || stdout1 || ''
            ).toLowerCase();
            const shouldRetryBearer = code1 === 401 || unauthorizedText1.includes('unauthorized');

            if (shouldRetryBearer) {
              return runCreate(tokenBearer, (errExec2, stderr2, stdout2, res2, code2) => {
                const finalErr = errExec2 || errExec1;
                const finalStderr = stderr2 || stderr1;
                const finalStdout = stdout2 || stdout1;
                const finalRes = res2 || res1;
                const finalCode = code2 || code1;
                return finalize(finalErr, finalStderr, finalStdout, finalRes, finalCode, resolve, resolvedIpLimit, resolvedQuota, username);
              });
            }

            return finalize(errExec1, stderr1, stdout1, res1, code1, resolve, resolvedIpLimit, resolvedQuota, username);
          });
        }
      );
    });
  });
}

function finalize(errExec, stderr, stdout, res, statusCode, resolve, resolvedIpLimit, resolvedQuota, username) {
  const isHttp2xx = statusCode >= 200 && statusCode < 300;
  if (!res && isHttp2xx) {
    return resolve(`
ZIVPN SSH ACCOUNT

- udp password : \`${username}\`
- Hostname : \`-\`
- Expired  : \`-\`
- Quota    : \`${quotaText(resolvedQuota)}\`
- IP Limit : ${resolvedIpLimit} device
`);
  }

  if (!res) {
    if (errExec) console.error('ZIVPN curl error:', errExec.message);
    if (stderr) console.error('ZIVPN curl stderr:', stderr);
    console.error('ZIVPN http status:', statusCode);
    console.error('ZIVPN raw output:', stdout);
    return resolve('Response server tidak valid');
  }

  const apiCode = Number(res?.meta?.code || 0);
  if (!isHttp2xx && apiCode !== 200) {
    const rawMessage = String(res?.message || res?.meta?.message || 'unknown error');
    const haystack = (rawMessage || JSON.stringify(res) || '').toLowerCase();
    if (
      (haystack.includes('username') || haystack.includes('client')) &&
      (haystack.includes('exist') || haystack.includes('exists') || haystack.includes('already') || haystack.includes('try another'))
    ) {
      return resolve('username sudah ada mohon ulangi dengan username yang unik');
    }
    return resolve(`Gagal membuat akun ZIVPN: ${rawMessage}`);
  }

  const s = res.data || {};
  const msg = `
ZIVPN SSH ACCOUNT

- udp password : \`${s.username || username}\`
- Hostname : \`${s.hostname || '-'}\`
- Expired  : \`${s.exp || s.expired || '-'}\`
- Quota    : \`${quotaText(resolvedQuota)}\`
- IP Limit : ${resolvedIpLimit} device
`;
  resolve(msg);
}

module.exports = { createzivpn };

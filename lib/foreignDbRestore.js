const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const LEGACY_SCHEMA = {
  users: ['user_id', 'balance', 'role'],
  servers: ['id', 'server_name', 'ip_address', 'price_per_day', 'account_limit', 'ip_limit'],
  accounts: ['id', 'user_id', 'server_id', 'username', 'expiry_date', 'protocol', 'price', 'created_at'],
  transactions: ['id', 'user_id', 'amount', 'type', 'date'],
  trial_logs: ['user_id', 'trial_date']
};

function openDatabase(filePath, mode) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, mode, (err) => {
      if (err) reject(err);
      else resolve(database);
    });
  });
}

function closeDatabase(database) {
  return new Promise((resolve) => database.close(() => resolve()));
}

function dbAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function dbGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
  });
}

function dbRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function quoteIdentifier(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

async function fileFingerprint(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function readTableMap(database) {
  const tables = await dbAll(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  const map = new Map();
  for (const row of tables) {
    const columns = await dbAll(database, `PRAGMA table_info(${quoteIdentifier(row.name)})`);
    map.set(String(row.name).toLowerCase(), {
      name: row.name,
      columns: new Set(columns.map((column) => String(column.name).toLowerCase()))
    });
  }
  return map;
}

function validateLegacySchema(tableMap) {
  const missing = [];
  for (const [tableName, requiredColumns] of Object.entries(LEGACY_SCHEMA)) {
    const table = tableMap.get(tableName);
    if (!table) {
      missing.push(`table ${tableName}`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!table.columns.has(column)) missing.push(`${tableName}.${column}`);
    }
  }
  if (missing.length) {
    const err = new Error(`Format database bot lain belum didukung. Field kurang: ${missing.join(', ')}`);
    err.code = 'UNSUPPORTED_FOREIGN_DB';
    throw err;
  }
}

async function inspectForeignBotDatabase(filePath) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fsPromises.stat(resolvedPath);
  if (!stat.isFile() || stat.size < 100) throw new Error('File database kosong atau tidak valid.');

  const source = await openDatabase(resolvedPath, sqlite3.OPEN_READONLY);
  try {
    const quickCheck = await dbGet(source, 'PRAGMA quick_check');
    if (!quickCheck || String(Object.values(quickCheck)[0] || '').toLowerCase() !== 'ok') {
      throw new Error('SQLite quick_check gagal. File mungkin rusak.');
    }
    validateLegacySchema(await readTableMap(source));

    const [users, servers, accounts, transactions, trials, protocols, roles, missingServers] = await Promise.all([
      dbGet(source, 'SELECT COUNT(*) AS count, COALESCE(SUM(balance), 0) AS total_balance FROM users'),
      dbGet(source, 'SELECT COUNT(*) AS count FROM servers'),
      dbGet(source, 'SELECT COUNT(*) AS count FROM accounts'),
      dbGet(source, 'SELECT COUNT(*) AS count FROM transactions'),
      dbGet(source, 'SELECT COUNT(*) AS count FROM trial_logs'),
      dbAll(source, "SELECT LOWER(TRIM(COALESCE(protocol, ''))) AS protocol, COUNT(*) AS count FROM accounts GROUP BY 1 ORDER BY 1"),
      dbAll(source, "SELECT LOWER(TRIM(COALESCE(role, 'member'))) AS role, COUNT(*) AS count FROM users GROUP BY 1 ORDER BY 1"),
      dbGet(source, 'SELECT COUNT(*) AS count FROM accounts a LEFT JOIN servers s ON s.id = a.server_id WHERE s.id IS NULL')
    ]);

    return {
      format: 'legacy-autobackup-v1',
      fingerprint: await fileFingerprint(resolvedPath),
      size: stat.size,
      counts: {
        users: Number(users?.count || 0),
        servers: Number(servers?.count || 0),
        accounts: Number(accounts?.count || 0),
        transactions: Number(transactions?.count || 0),
        trials: Number(trials?.count || 0),
        resellers: Number((roles || []).find((row) => row.role === 'reseller')?.count || 0),
        missingServerAccounts: Number(missingServers?.count || 0)
      },
      totalBalance: Number(users?.total_balance || 0),
      protocols: Object.fromEntries(protocols.map((row) => [row.protocol || 'unknown', Number(row.count || 0)])),
      roles: Object.fromEntries(roles.map((row) => [row.role || 'member', Number(row.count || 0)]))
    };
  } finally {
    await closeDatabase(source);
  }
}

function parseLegacyDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 100000000000 ? number * 1000 : number;
  }
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)
    ? `${text.replace(' ', 'T')}${text.includes('T') || text.includes(' ') ? '+07:00' : 'T00:00:00+07:00'}`
    : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
  if (protocol === 'sshvpn' || protocol === 'ovpn') return 'ssh';
  if (['ssh', 'vmess', 'vless', 'trojan', 'zivpn', 'udp_http', 'shadowsocks'].includes(protocol)) {
    return protocol;
  }
  return protocol || 'ssh';
}

async function insertDynamic(database, tableName, values, availableColumns) {
  const entries = Object.entries(values).filter(([key]) => availableColumns.has(key.toLowerCase()));
  if (!entries.length) throw new Error(`Tidak ada field yang kompatibel untuk table ${tableName}.`);
  const columns = entries.map(([key]) => quoteIdentifier(key));
  const placeholders = entries.map(() => '?');
  return dbRun(
    database,
    `INSERT INTO ${quoteIdentifier(tableName)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    entries.map(([, value]) => value)
  );
}

async function mergeResellerFile(filePath, resellerIds) {
  if (!filePath || !resellerIds.length) return 0;
  let existing = [];
  try {
    existing = (await fsPromises.readFile(filePath, 'utf8')).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const before = new Set(existing);
  resellerIds.forEach((id) => before.add(String(id)));
  const added = before.size - new Set(existing).size;
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${Array.from(before).join('\n')}${before.size ? '\n' : ''}`, 'utf8');
  return added;
}

async function mergeTrialFile(filePath, trialRows) {
  if (!filePath || !trialRows.length) return 0;
  let current = {};
  try {
    const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  let changed = 0;
  for (const row of trialRows) {
    const userId = String(row.user_id || '').trim();
    const date = String(row.trial_date || '').trim().slice(0, 10);
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!current[userId] || date > current[userId]) {
      current[userId] = date;
      changed += 1;
    }
  }
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return changed;
}

async function importForeignBotDatabase(options) {
  const {
    sourcePath,
    targetDb,
    sourceName = path.basename(sourcePath || 'foreign.db'),
    overwriteBalances = false,
    resellerFilePath = '',
    trialFilePath = ''
  } = options || {};
  if (!targetDb) throw new Error('Koneksi database tujuan tidak tersedia.');

  const inspection = await inspectForeignBotDatabase(sourcePath);
  const source = await openDatabase(path.resolve(sourcePath), sqlite3.OPEN_READONLY);
  let transactionOpen = false;
  const summary = {
    fingerprint: inspection.fingerprint,
    usersInserted: 0,
    usersUpdated: 0,
    usersKept: 0,
    serversInserted: 0,
    serversMatched: 0,
    accountsInserted: 0,
    accountsMerged: 0,
    transactionsInserted: 0,
    trialsMerged: 0,
    resellersAdded: 0,
    warnings: []
  };

  try {
    const [sourceUsers, sourceServers, sourceAccounts, sourceTransactions, sourceTrials] = await Promise.all([
      dbAll(source, 'SELECT * FROM users ORDER BY user_id'),
      dbAll(source, 'SELECT * FROM servers ORDER BY id'),
      dbAll(source, 'SELECT * FROM accounts ORDER BY id'),
      dbAll(source, 'SELECT * FROM transactions ORDER BY id'),
      dbAll(source, 'SELECT * FROM trial_logs ORDER BY trial_date, user_id')
    ]);

    const targetTables = await readTableMap(targetDb);
    for (const required of ['users', 'server', 'accounts', 'transactions']) {
      if (!targetTables.has(required)) throw new Error(`Database bot tujuan belum memiliki table ${required}.`);
    }
    const requiredTargetColumns = {
      users: ['user_id', 'saldo'],
      server: ['id', 'domain', 'auth', 'nama_server', 'is_active'],
      accounts: ['id', 'user_id', 'type', 'username', 'server_id', 'server_name', 'domain', 'created_at', 'expires_at'],
      transactions: ['id', 'user_id', 'amount', 'type', 'reference_id', 'timestamp']
    };
    for (const [tableName, columns] of Object.entries(requiredTargetColumns)) {
      const available = targetTables.get(tableName).columns;
      const missing = columns.filter((column) => !available.has(column));
      if (missing.length) {
        throw new Error(
          `Schema database tujuan belum siap (${tableName}: ${missing.join(', ')}). Restart bot agar migrasi schema selesai.`
        );
      }
    }

    await dbRun(targetDb, `CREATE TABLE IF NOT EXISTS foreign_db_imports (
      fingerprint TEXT PRIMARY KEY,
      source_name TEXT,
      imported_at INTEGER,
      mode TEXT,
      summary_json TEXT
    )`);
    const previous = await dbGet(
      targetDb,
      'SELECT fingerprint, imported_at FROM foreign_db_imports WHERE fingerprint = ?',
      [inspection.fingerprint]
    );
    if (previous) {
      const err = new Error('File database ini sudah pernah diimport. Import dibatalkan agar data tidak duplikat.');
      err.code = 'FOREIGN_DB_ALREADY_IMPORTED';
      throw err;
    }

    await dbRun(targetDb, 'BEGIN IMMEDIATE TRANSACTION');
    transactionOpen = true;

    for (const user of sourceUsers) {
      const userId = Number(user.user_id || 0);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      const existing = await dbGet(targetDb, 'SELECT user_id, saldo FROM users WHERE user_id = ?', [userId]);
      if (!existing) {
        await dbRun(targetDb, 'INSERT INTO users (user_id, saldo) VALUES (?, ?)', [userId, Number(user.balance || 0)]);
        summary.usersInserted += 1;
      } else if (overwriteBalances) {
        await dbRun(targetDb, 'UPDATE users SET saldo = ? WHERE user_id = ?', [Number(user.balance || 0), userId]);
        summary.usersUpdated += 1;
      } else {
        summary.usersKept += 1;
      }
    }

    const sourceServerById = new Map(sourceServers.map((server) => [Number(server.id), server]));
    const accountProtocolsByServer = new Map();
    for (const account of sourceAccounts) {
      const serverId = Number(account.server_id || 0);
      if (!accountProtocolsByServer.has(serverId)) accountProtocolsByServer.set(serverId, new Set());
      accountProtocolsByServer.get(serverId).add(normalizeProtocol(account.protocol));
    }

    const targetServerTable = targetTables.get('server');
    const targetServerIdBySourceId = new Map();
    for (const server of sourceServers) {
      const domain = String(server.ip_address || '').trim();
      const serverName = String(server.server_name || `Legacy Server #${server.id}`).trim();
      const existing = await dbGet(
        targetDb,
        `SELECT id FROM Server
         WHERE LOWER(TRIM(COALESCE(nama_server, ''))) = LOWER(TRIM(?))
           AND LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
         LIMIT 1`,
        [serverName, domain]
      );
      if (existing) {
        targetServerIdBySourceId.set(Number(server.id), Number(existing.id));
        summary.serversMatched += 1;
        continue;
      }

      const protocols = accountProtocolsByServer.get(Number(server.id)) || new Set();
      const accountCount = sourceAccounts.filter((account) => Number(account.server_id) === Number(server.id)).length;
      const price = Number(server.price_per_day || 0);
      const inserted = await insertDynamic(targetDb, targetServerTable.name, {
        domain,
        auth: '',
        harga: price,
        harga_reseller: price,
        harga_1ip: price,
        harga_2ip: price,
        harga_reseller_1ip: price,
        harga_reseller_2ip: price,
        nama_server: serverName,
        quota: 0,
        iplimit: Number(server.ip_limit || 0),
        batas_create_akun: Number(server.account_limit || 0),
        total_create_akun: accountCount,
        is_reseller_only: 0,
        support_ssh: protocols.has('ssh') ? 1 : 0,
        support_vmess: protocols.has('vmess') ? 1 : 0,
        support_vless: protocols.has('vless') ? 1 : 0,
        support_trojan: protocols.has('trojan') ? 1 : 0,
        support_shadowsocks: protocols.has('shadowsocks') ? 1 : 0,
        support_zivpn: protocols.has('zivpn') ? 1 : 0,
        support_udp_http: protocols.has('udp_http') ? 1 : 0,
        service: protocols.size === 1 && protocols.has('zivpn') ? 'zivpn' : 'ssh',
        sync_enabled: 0,
        is_active: 0,
        ssh_port: Number(server.ssh_port || 22),
        ssh_username: String(server.ssh_user || ''),
        ssh_password: String(server.ssh_password || ''),
        server_type: 'legacy_import'
      }, targetServerTable.columns);
      targetServerIdBySourceId.set(Number(server.id), Number(inserted.lastID));
      summary.serversInserted += 1;
    }

    for (const account of sourceAccounts) {
      const userId = Number(account.user_id || 0);
      const username = String(account.username || '').trim();
      if (!Number.isInteger(userId) || userId <= 0 || !username) continue;
      const type = normalizeProtocol(account.protocol);
      const sourceServer = sourceServerById.get(Number(account.server_id || 0));
      const targetServerId = targetServerIdBySourceId.get(Number(account.server_id || 0)) || null;
      const serverName = sourceServer
        ? String(sourceServer.server_name || `Legacy Server #${account.server_id}`)
        : `Legacy Server #${account.server_id || '?'}`;
      const domain = sourceServer ? String(sourceServer.ip_address || '') : '';
      const expiresAt = parseLegacyDate(account.expiry_date);
      const createdAt = parseLegacyDate(account.created_at) || Date.now();

      let existing = null;
      if (targetServerId) {
        existing = await dbGet(
          targetDb,
          `SELECT id, expires_at FROM accounts
           WHERE user_id = ? AND LOWER(COALESCE(type, '')) = ? AND LOWER(COALESCE(username, '')) = LOWER(?)
             AND server_id = ? LIMIT 1`,
          [userId, type, username, targetServerId]
        );
      } else {
        existing = await dbGet(
          targetDb,
          `SELECT id, expires_at FROM accounts
           WHERE user_id = ? AND LOWER(COALESCE(type, '')) = ? AND LOWER(COALESCE(username, '')) = LOWER(?)
             AND LOWER(COALESCE(server_name, '')) = LOWER(?) LIMIT 1`,
          [userId, type, username, serverName]
        );
      }

      if (existing) {
        const mergedExpiry = Math.max(Number(existing.expires_at || 0), Number(expiresAt || 0)) || null;
        await dbRun(
          targetDb,
          `UPDATE accounts
           SET expires_at = ?, server_name = COALESCE(NULLIF(server_name, ''), ?),
               domain = COALESCE(NULLIF(domain, ''), ?)
           WHERE id = ?`,
          [mergedExpiry, serverName, domain, existing.id]
        );
        summary.accountsMerged += 1;
      } else {
        await dbRun(
          targetDb,
          `INSERT INTO accounts
           (user_id, type, username, password, server_id, server_name, domain,
            account_ip_package, account_price_per_day, created_at, expires_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            type,
            username,
            targetServerId,
            serverName,
            domain,
            Number(sourceServer?.ip_limit || 1) === 2 ? 2 : 1,
            Number(account.price || 0),
            createdAt,
            expiresAt
          ]
        );
        summary.accountsInserted += 1;
      }
    }

    const fingerprintPrefix = inspection.fingerprint.slice(0, 20);
    for (const transaction of sourceTransactions) {
      const userId = Number(transaction.user_id || 0);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      const referenceId = `foreign:${fingerprintPrefix}:tx:${transaction.id}`;
      const exists = await dbGet(targetDb, 'SELECT id FROM transactions WHERE reference_id = ? LIMIT 1', [referenceId]);
      if (exists) continue;
      await dbRun(
        targetDb,
        'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
        [
          userId,
          Number(transaction.amount || 0),
          String(transaction.type || 'legacy_import'),
          referenceId,
          parseLegacyDate(transaction.date) || Date.now()
        ]
      );
      summary.transactionsInserted += 1;
    }

    await dbRun(
      targetDb,
      `INSERT INTO foreign_db_imports (fingerprint, source_name, imported_at, mode, summary_json)
       VALUES (?, ?, ?, ?, ?)`,
      [inspection.fingerprint, sourceName, Date.now(), overwriteBalances ? 'overwrite_balance' : 'keep_balance', JSON.stringify(summary)]
    );
    await dbRun(targetDb, 'COMMIT');
    transactionOpen = false;

    const resellerIds = sourceUsers
      .filter((user) => String(user.role || '').trim().toLowerCase() === 'reseller')
      .map((user) => Number(user.user_id || 0))
      .filter((id) => Number.isInteger(id) && id > 0);
    try {
      summary.resellersAdded = await mergeResellerFile(resellerFilePath, resellerIds);
    } catch (err) {
      summary.warnings.push(`Reseller gagal digabung: ${err.message}`);
    }
    try {
      summary.trialsMerged = await mergeTrialFile(trialFilePath, sourceTrials);
    } catch (err) {
      summary.warnings.push(`Log trial gagal digabung: ${err.message}`);
    }
    return { inspection, summary };
  } catch (err) {
    if (transactionOpen) await dbRun(targetDb, 'ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await closeDatabase(source);
  }
}

module.exports = {
  inspectForeignBotDatabase,
  importForeignBotDatabase,
  parseLegacyDate,
  normalizeProtocol
};

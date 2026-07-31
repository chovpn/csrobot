const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  inspectForeignBotDatabase,
  importForeignBotDatabase
} = require('../lib/foreignDbRestore');

function openDatabase(filePath) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (err) => err ? reject(err) : resolve(database));
  });
}

function closeDatabase(database) {
  return new Promise((resolve) => database.close(() => resolve()));
}

function exec(database, sql) {
  return new Promise((resolve, reject) => database.exec(sql, (err) => err ? reject(err) : resolve()));
}

function get(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

async function createSourceDatabase(filePath) {
  const database = await openDatabase(filePath);
  await exec(database, `
    CREATE TABLE users (user_id INTEGER PRIMARY KEY, balance INTEGER DEFAULT 0, role TEXT, discount INTEGER, last_qris_id INTEGER);
    CREATE TABLE servers (id INTEGER PRIMARY KEY, server_name TEXT, ip_address TEXT, ssh_user TEXT, ssh_password TEXT, price_per_day INTEGER, account_limit INTEGER, ssh_port INTEGER, ip_limit INTEGER);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER, server_id INTEGER, username TEXT, expiry_date TEXT, protocol TEXT, price INTEGER, created_at TEXT);
    CREATE TABLE transactions (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER, type TEXT, date TEXT);
    CREATE TABLE trial_logs (user_id INTEGER, trial_date TEXT);
    INSERT INTO users VALUES (1001, 100, 'member', 0, 0), (1002, 200, 'reseller', 10, 0);
    INSERT INTO servers VALUES (7, 'Legacy SG', '192.0.2.10', 'root', 'secret', 500, 20, 22, 2);
    INSERT INTO accounts VALUES (1, 1001, 7, 'alice', '2026-08-01 10:00:00', 'vmess', 500, '2026-07-01 10:00:00');
    INSERT INTO transactions VALUES (1, 1001, -500, 'order vmess', '2026-07-01 10:00:00');
    INSERT INTO trial_logs VALUES (1001, '2026-06-01'), (1001, '2026-06-02');
  `);
  await closeDatabase(database);
}

async function createTargetDatabase(filePath) {
  const database = await openDatabase(filePath);
  await exec(database, `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, saldo INTEGER DEFAULT 0);
    CREATE TABLE Server (
      id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT, auth TEXT, nama_server TEXT,
      harga INTEGER, harga_reseller INTEGER, harga_1ip INTEGER, harga_2ip INTEGER,
      harga_reseller_1ip INTEGER, harga_reseller_2ip INTEGER, quota INTEGER, iplimit INTEGER,
      batas_create_akun INTEGER, total_create_akun INTEGER, is_reseller_only INTEGER,
      support_ssh INTEGER, support_vmess INTEGER, support_vless INTEGER, support_trojan INTEGER,
      support_shadowsocks INTEGER, support_zivpn INTEGER, support_udp_http INTEGER,
      service TEXT, sync_enabled INTEGER, is_active INTEGER
    );
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, username TEXT,
      password TEXT, server_id INTEGER, server_name TEXT, domain TEXT,
      account_ip_package INTEGER, account_price_per_day INTEGER, created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER,
      type TEXT, reference_id TEXT, timestamp INTEGER
    );
    INSERT INTO users (user_id, saldo) VALUES (1001, 999);
  `);
  return database;
}

test('foreign DB preview and safe import convert legacy AutoBackup schema', async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'botvpn-foreign-test-'));
  const sourcePath = path.join(tempDir, 'AutoBackup.db');
  const targetPath = path.join(tempDir, 'sellvpn.db');
  const resellerPath = path.join(tempDir, 'ressel.db');
  const trialPath = path.join(tempDir, 'trial.db');
  let target;

  try {
    await createSourceDatabase(sourcePath);
    const preview = await inspectForeignBotDatabase(sourcePath);
    assert.equal(preview.counts.users, 2);
    assert.equal(preview.counts.resellers, 1);
    assert.equal(preview.counts.accounts, 1);

    target = await createTargetDatabase(targetPath);
    const result = await importForeignBotDatabase({
      sourcePath,
      targetDb: target,
      resellerFilePath: resellerPath,
      trialFilePath: trialPath
    });

    assert.equal(result.summary.usersInserted, 1);
    assert.equal(result.summary.usersKept, 1);
    assert.equal((await get(target, 'SELECT saldo FROM users WHERE user_id = 1001')).saldo, 999);
    assert.equal((await get(target, 'SELECT saldo FROM users WHERE user_id = 1002')).saldo, 200);
    assert.equal((await get(target, 'SELECT is_active FROM Server')).is_active, 0);
    assert.equal((await get(target, 'SELECT COUNT(*) AS count FROM accounts')).count, 1);
    assert.equal((await get(target, 'SELECT COUNT(*) AS count FROM transactions')).count, 1);
    assert.match(await fsPromises.readFile(resellerPath, 'utf8'), /1002/);
    assert.equal(JSON.parse(await fsPromises.readFile(trialPath, 'utf8'))['1001'], '2026-06-02');

    await assert.rejects(
      importForeignBotDatabase({ sourcePath, targetDb: target }),
      (err) => err && err.code === 'FOREIGN_DB_ALREADY_IMPORTED'
    );
  } finally {
    if (target) await closeDatabase(target);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

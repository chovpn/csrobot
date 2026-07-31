const fs = require('fs');
const path = require('path');
const fsPromises = require('fs/promises');

const runtimeDir = process.env.BOTVPN_RUNTIME_DIR
  ? path.resolve(process.env.BOTVPN_RUNTIME_DIR)
  : path.join(__dirname, '..');
const resselFilePath = path.join(runtimeDir, 'ressel.db');

/**
 * Check if a user is reseller by id.
 * @param {number|string} userId
 * @returns {Promise<boolean>}
 */
async function isUserReseller(userId) {
  try {
    const data = await fsPromises.readFile(resselFilePath, 'utf8');
    const list = data.split('\n').map(l => l.trim()).filter(Boolean);
    return list.includes(String(userId));
  } catch (err) {
    // file not found -> no reseller
    return false;
  }
}

/**
 * Add a reseller id to ressel.db (id as string/number)
 * creates file if not exist
 * @param {string|number} id
 */
function addReseller(id) {
  const line = `${String(id)}\n`;
  fs.appendFileSync(resselFilePath, line, { encoding: 'utf8' });
}

/**
 * Remove reseller id from file
 * @param {string|number} id
 */
function removeReseller(id) {
  if (!fs.existsSync(resselFilePath)) return false;
  const content = fs.readFileSync(resselFilePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const filtered = lines.filter(l => l !== String(id));
  fs.writeFileSync(resselFilePath, filtered.join('\n') + (filtered.length ? '\n' : ''), 'utf8');
  return true;
}

/**
 * Read all reseller ids (sync)
 * @returns {string[]}
 */
function listResellersSync() {
  if (!fs.existsSync(resselFilePath)) return [];
  const content = fs.readFileSync(resselFilePath, 'utf8');
  return content.split('\n').map(l => l.trim()).filter(Boolean);
}

module.exports = { resselFilePath, isUserReseller, addReseller, removeReseller, listResellersSync };

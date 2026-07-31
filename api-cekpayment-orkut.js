// api-cekpayment-orkut.js
const qs = require('qs');
const fs = require('fs');
const path = require('path');

function loadVars() {
  try {
    const varsPath = path.join(__dirname, '.vars.json');
    return JSON.parse(fs.readFileSync(varsPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

// Function agar tetap kompatibel dengan app.js
function buildPayload() {
  const vars = loadVars();
  return qs.stringify({
    'username': vars.ORKUT_USERNAME || 'yantoxxx',
    'token': vars.ORKUT_TOKEN || '1342xxxx:149:i3NBVaZqHjEYnvuImxWKACgxxxxx',
    'jenis': 'masuk'
  });
}

// Header tetap sama agar tidak error di app.js
const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'okhttp/4.12.0'
};

// URL baru sesuai curl-mu
const API_URL = 'https://orkutapi.andyyuda41.workers.dev/api/qris-history';

// Ekspor agar app.js tetap bisa require dengan struktur lama
module.exports = { buildPayload, headers, API_URL };

#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Jalankan installer sebagai root."
  exit 1
fi

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "${APP_DIR}"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  apt-get update
  apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
npm run build

if [[ ! -f .vars.json ]]; then
  read -r -p "Token bot dari BotFather: " bot_token
  read -r -p "ID Telegram admin: " admin_id
  read -r -p "Nama store: " store_name
  read -r -p "Port HTTP [6969]: " http_port
  read -r -p "Generator API URL [https://api.zivpn.site/api/config]: " generator_api_url
  read -r -p "Generator API key: " generator_api_key
  http_port="${http_port:-6969}"
  generator_api_url="${generator_api_url:-https://api.zivpn.site/api/config}"

  BOT_TOKEN="${bot_token}" ADMIN_ID="${admin_id}" STORE_NAME="${store_name}" HTTP_PORT="${http_port}" GENERATOR_API_URL="${generator_api_url}" GENERATOR_API_KEY="${generator_api_key}" node <<'NODE'
const fs = require('fs');
const crypto = require('crypto');

const adminId = Number(process.env.ADMIN_ID);
const port = Number(process.env.HTTP_PORT);
if (!process.env.BOT_TOKEN || !Number.isSafeInteger(adminId) || adminId <= 0) {
  throw new Error('Token bot atau ID admin tidak valid.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Port HTTP tidak valid.');
}

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  USER_ID: [adminId],
  NAMA_STORE: process.env.STORE_NAME || '@NAMA_STORE',
  PORT: port,
  GENERATOR_API_URL: process.env.GENERATOR_API_URL || 'https://api.zivpn.site/api/config',
  GENERATOR_API_KEY: process.env.GENERATOR_API_KEY || '',
  GENERATOR_API_TIMEOUT_MS: 120000,
  GROUP_ID: '',
  DATA_QRIS: '',
  LOCAL_PAYMENT_API_KEY: crypto.randomBytes(24).toString('hex'),
  PAYMENT_GATEWAY_MODE: 'orderkuota',
  ORDERKUOTA_CREATE_MODE: 'local',
  ORKUT_USERNAME: '',
  ORKUT_TOKEN: '',
  PPOB_ENABLED: false,
  DIGIFLAZZ_USERNAME: '',
  DIGIFLAZZ_API_KEY: '',
  DIGIFLAZZ_BASE_URL: 'https://api.digiflazz.com',
  PPOB_MARKUP_FEE: 0
};

fs.writeFileSync('.vars.json', `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
fi

pm2 startOrRestart ecosystem.config.js --update-env
pm2 save

echo "Bot standalone aktif. Cek dengan: pm2 status botvpn-standalone"

function getRuntimeStoreName() {
  const raw = process.env.BOTVPN_STORE_NAME || process.env.NAMA_STORE || '@ARI_VPN_STORE';
  const clean = String(raw || '').trim().replace(/^@+/, '');
  return clean || 'ARI_VPN_STORE';
}

function storeFooter(year = new Date().getFullYear(), copyright = false) {
  const prefix = copyright ? '\u00a9 ' : '';
  return `${prefix}Telegram Bots ${getRuntimeStoreName()} - ${year}`;
}

module.exports = {
  getRuntimeStoreName,
  storeFooter
};

function parseHcEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const bracketed = text.match(/^\[([^\]]+)](?::(\d{1,5}))?$/);
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) return null;
    return { address: bracketed[1], port };
  }

  const lastColon = text.lastIndexOf(':');
  if (lastColon > 0 && text.indexOf(':') === lastColon) {
    const portText = text.slice(lastColon + 1);
    if (/^\d{1,5}$/.test(portText)) {
      const port = Number(portText);
      if (port < 1 || port > 65535) return null;
      return { address: text.slice(0, lastColon), port };
    }
  }

  return { address: text, port: null };
}

function parseHcCompactXrayInput(text, keyed = {}) {
  let protocol = String(keyed.protocol || keyed.type || keyed.method || '').trim().toLowerCase();
  if (!['vmess', 'vless', 'trojan'].includes(protocol)) protocol = '';

  let host = String(keyed.server || keyed.domain || keyed.address || keyed.host || '').trim();
  let port = Number(keyed.port || 0);
  let credential = protocol === 'trojan'
    ? String(keyed.password || keyed.pass || keyed.token || '').trim()
    : String(keyed.uuid || keyed.id || '').trim();

  if (!host || !credential) {
    let compact = String(text || '').trim();
    const prefix = compact.match(/^(vmess|vless|trojan)\s*:\s*(.+)$/is);
    if (prefix) {
      protocol = prefix[1].toLowerCase();
      compact = prefix[2].trim();
    }
    if (!protocol) protocol = 'vmess';

    const atIndex = compact.indexOf('@');
    const endpoint = atIndex > 0 ? parseHcEndpoint(compact.slice(0, atIndex)) : null;
    if (endpoint && endpoint.port) {
      host = endpoint.address;
      port = endpoint.port;
      credential = compact.slice(atIndex + 1).trim();
    } else {
      const separator = compact.indexOf(':');
      if (separator > 0) {
        host = compact.slice(0, separator).trim();
        credential = compact.slice(separator + 1).trim();
      }
    }
  }

  if (!protocol) protocol = 'vmess';
  if (!host || /[\s/@]/.test(host) || !credential) {
    throw new Error(
      'Format Xray tidak dikenali. Pakai link, host:UUID untuk VMess, vless:host:UUID, atau trojan:host:PASSWORD.'
    );
  }
  if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Port Xray harus berupa angka 1-65535.');
  }

  const pathByProtocol = {
    vmess: '/vmess',
    vless: '/vless',
    trojan: '/trojan-ws'
  };
  return {
    protocol,
    address: host,
    port: port || 443,
    id: protocol === 'trojan' ? '' : credential,
    password: protocol === 'trojan' ? credential : '',
    alterId: 0,
    security: 'tls',
    tls: 'tls',
    network: 'ws',
    path: pathByProtocol[protocol],
    host,
    sni: host
  };
}

module.exports = { parseHcCompactXrayInput, parseHcEndpoint };

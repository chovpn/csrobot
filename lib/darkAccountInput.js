function parseHostPort(value, defaultPort) {
  const text = String(value || '').trim();
  const idx = text.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(text.slice(idx + 1))) {
    return {
      host: text.slice(0, idx),
      port: Number(text.slice(idx + 1))
    };
  }
  return { host: text, port: defaultPort };
}

function assertValidPort(port, label = 'Port') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} harus berupa angka 1-65535.`);
  }
}

function parseSshAccount(value) {
  if (typeof value === 'object' && value) {
    const host = String(value.host || value.server || value.hostname || '').trim();
    const port = Number(value.port || 22);
    const username = String(value.username || value.user || '').trim();
    const password = String(value.password || value.pass || '').trim();
    assertValidPort(port);
    if (!host || !username || !password) {
      throw new Error('Data SSH harus berisi host, username, dan password.');
    }
    return {
      host,
      port,
      username,
      password,
      rawAccount: `${host}:${port}@${username}:${password}`
    };
  }

  const text = String(value || '').trim();
  const atIdx = text.indexOf('@');
  if (atIdx === -1) throw new Error('Format SSH harus host:port@user:pass.');
  const target = parseHostPort(text.slice(0, atIdx), 22);
  assertValidPort(target.port);
  const credential = text.slice(atIdx + 1);
  const sepIdx = credential.indexOf(':');
  if (sepIdx === -1) throw new Error('Format SSH harus host:port@user:pass.');
  const username = credential.slice(0, sepIdx).trim();
  const password = credential.slice(sepIdx + 1).trim();
  if (!target.host || !username || !password) throw new Error('Format SSH harus host:port@user:pass.');
  return {
    host: target.host,
    port: target.port,
    username,
    password,
    rawAccount: `${target.host}:${target.port}@${username}:${password}`
  };
}

function parseVmessLink(link) {
  const decoded = JSON.parse(Buffer.from(String(link).slice('vmess://'.length), 'base64').toString('utf8'));
  const host = String(decoded.add || '').trim();
  const port = Number(decoded.port || 80);
  const uuid = String(decoded.id || '').trim();
  assertValidPort(port);
  if (!host || !uuid) throw new Error('Link VMess tidak lengkap.');
  return {
    host,
    port,
    uuid,
    tls: decoded.tls === 'tls' || decoded.security === 'tls' || decoded.tls === true,
    serverNameIndication: decoded.sni || decoded.host || decoded.add,
    wsPath: decoded.path || '',
    wsHeaderHost: decoded.host || decoded.add,
    transportNetwork: decoded.net || decoded.type || 'ws',
    rawAccount: link.trim()
  };
}

function parseUrlAccount(link, type) {
  const url = new URL(link);
  const security = url.searchParams.get('security') || '';
  const defaultPort = security === 'tls' ? 443 : 80;
  const host = String(url.hostname || '').trim();
  const port = Number(url.port || defaultPort);
  const secret = decodeURIComponent(url.username || '').trim();
  assertValidPort(port);
  if (!host || !secret) throw new Error(`Link ${type} tidak lengkap.`);
  return {
    host,
    port,
    uuid: secret,
    password: type === 'trojan' ? secret : '',
    tls: security === 'tls',
    serverNameIndication: url.searchParams.get('sni') || url.searchParams.get('host') || host,
    wsPath: url.searchParams.get('path') || '',
    wsHeaderHost: url.searchParams.get('host') || host,
    grpcServiceName: url.searchParams.get('serviceName') || '',
    transportNetwork: url.searchParams.get('type') || 'ws',
    rawAccount: link.trim()
  };
}

function parseVmessAccount(value) {
  if (typeof value === 'object' && value) {
    const host = String(value.host || value.server || value.hostname || '').trim();
    const inheritTemplateTransport = Boolean(value.inheritTemplateTransport);
    const port = value.port === undefined || value.port === null || value.port === ''
      ? undefined
      : Number(value.port);
    const uuid = String(value.uuid || value.id || '').trim();
    const hasTls = Object.prototype.hasOwnProperty.call(value, 'tls') &&
      value.tls !== undefined && value.tls !== null;
    if (port !== undefined) assertValidPort(port);
    if (!host || !uuid) throw new Error('Data VMess harus berisi host dan uuid.');
    return {
      host,
      port,
      uuid,
      domainAddress: String(value.domainAddress || value.addressOverride || value.bugHost || value.bug || value.customHost || value.addr || '').trim(),
      tls: hasTls ? Boolean(value.tls) : undefined,
      serverNameIndication: value.serverNameIndication || value.sni || '',
      wsPath: value.wsPath || value.path,
      wsHeaderHost: value.wsHeaderHost || value.hostHeader || value.headerHost || '',
      grpcServiceName: value.grpcServiceName || value.serviceName || '',
      mux: Boolean(value.mux),
      transportNetwork: value.transportNetwork || value.network || '',
      inheritTemplateTransport,
      rawAccount: port ? `${host}:${port}@${uuid}` : `${host}:${uuid}`
    };
  }

  const text = String(value || '').trim();
  if (/^vmess:\/\//i.test(text)) return parseVmessLink(text);

  const atIdx = text.indexOf('@');
  const targetPart = atIdx > 0 ? text.slice(0, atIdx) : '';
  if (targetPart && /:\d{1,5}$/.test(targetPart)) {
    const target = parseHostPort(targetPart, 80);
    assertValidPort(target.port);
    const uuid = text.slice(atIdx + 1).trim();
    if (!target.host || !uuid) throw new Error('Format VMess harus host:uuid atau host:port@uuid.');
    return {
      host: target.host,
      port: target.port,
      uuid,
      rawAccount: `${target.host}:${target.port}@${uuid}`
    };
  }

  const separator = text.indexOf(':');
  if (separator > 0) {
    const host = text.slice(0, separator).trim();
    const uuid = text.slice(separator + 1).trim();
    if (!host || !uuid) throw new Error('Format VMess harus host:uuid atau host:port@uuid.');
    return parseVmessAccount({ host, uuid, inheritTemplateTransport: true });
  }
  throw new Error('Format VMess harus host:uuid atau host:port@uuid.');
}

function parseXrayAccount(value, method = 'VMESS') {
  const type = String(method || 'VMESS').toUpperCase();
  if (type === 'VMESS') return parseVmessAccount(value);

  if (typeof value === 'object' && value) {
    const host = String(value.host || value.server || value.hostname || '').trim();
    const inheritTemplateTransport = Boolean(value.inheritTemplateTransport);
    const port = value.port === undefined || value.port === null || value.port === ''
      ? undefined
      : Number(value.port);
    const secret = String(value.uuid || value.id || value.password || value.pass || '').trim();
    const hasTls = Object.prototype.hasOwnProperty.call(value, 'tls') &&
      value.tls !== undefined && value.tls !== null;
    if (port !== undefined) assertValidPort(port);
    if (!host || !secret) {
      throw new Error(`Data ${type} harus berisi host dan ${type === 'TROJAN' ? 'password' : 'uuid'}.`);
    }
    return {
      host,
      port,
      uuid: secret,
      password: type === 'TROJAN' ? secret : '',
      domainAddress: String(value.domainAddress || value.addressOverride || value.bugHost || value.bug || value.customHost || value.addr || '').trim(),
      tls: hasTls ? Boolean(value.tls) : undefined,
      serverNameIndication: value.serverNameIndication || value.sni || '',
      wsPath: value.wsPath || value.path,
      wsHeaderHost: value.wsHeaderHost || value.hostHeader || value.headerHost || '',
      grpcServiceName: value.grpcServiceName || value.serviceName || '',
      mux: Boolean(value.mux),
      transportNetwork: value.transportNetwork || value.network || '',
      inheritTemplateTransport,
      rawAccount: port ? `${host}:${port}@${secret}` : `${host}:${secret}`
    };
  }

  const text = String(value || '').trim();
  if (type === 'VLESS' && /^vless:\/\//i.test(text)) return parseUrlAccount(text, 'vless');
  if (type === 'TROJAN' && /^trojan:\/\//i.test(text)) return parseUrlAccount(text, 'trojan');

  const atIdx = text.indexOf('@');
  const targetPart = atIdx > 0 ? text.slice(0, atIdx) : '';
  if (targetPart && /:\d{1,5}$/.test(targetPart)) {
    const target = parseHostPort(targetPart, type === 'TROJAN' ? 443 : 80);
    assertValidPort(target.port);
    const secret = text.slice(atIdx + 1).trim();
    if (!target.host || !secret) {
      throw new Error(`Format ${type} harus host:${type === 'TROJAN' ? 'password' : 'uuid'} atau host:port@${type === 'TROJAN' ? 'password' : 'uuid'}.`);
    }
    return {
      host: target.host,
      port: target.port,
      uuid: secret,
      password: type === 'TROJAN' ? secret : '',
      rawAccount: `${target.host}:${target.port}@${secret}`
    };
  }

  const separator = text.indexOf(':');
  if (separator > 0) {
    const host = text.slice(0, separator).trim();
    const secret = text.slice(separator + 1).trim();
    if (!host || !secret) {
      throw new Error(`Format ${type} harus host:${type === 'TROJAN' ? 'password' : 'uuid'} atau host:port@${type === 'TROJAN' ? 'password' : 'uuid'}.`);
    }
    return parseXrayAccount({
      host,
      uuid: secret,
      password: type === 'TROJAN' ? secret : '',
      inheritTemplateTransport: true
    }, type);
  }
  throw new Error(
    `Format ${type} harus host:${type === 'TROJAN' ? 'password' : 'uuid'} atau ` +
    `host:port@${type === 'TROJAN' ? 'password' : 'uuid'}.`
  );
}

module.exports = {
  parseSshAccount,
  parseVmessAccount,
  parseXrayAccount
};

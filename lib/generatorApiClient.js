const axios = require('axios');

const DEFAULT_GENERATOR_API_URL = 'https://api.zivpn.site/api/config';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

class GeneratorApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GeneratorApiError';
    this.status = Number(details.status || 0);
    this.code = String(details.code || '');
    this.requestId = String(details.requestId || '');
    this.isConfigError = Boolean(details.isConfigError);
  }
}

function normalizeBaseUrl(raw) {
  let text = String(raw || DEFAULT_GENERATOR_API_URL).trim();
  if (!text) text = DEFAULT_GENERATOR_API_URL;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;

  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return '';
    url.search = '';
    url.hash = '';

    let pathname = url.pathname.replace(/\/+$/, '');
    if (/\/docs$/i.test(pathname)) pathname = pathname.replace(/\/docs$/i, '');
    if (!/\/api\/config$/i.test(pathname)) pathname = `${pathname}/api/config`;
    url.pathname = pathname.replace(/\/{2,}/g, '/');
    return url.toString().replace(/\/+$/, '');
  } catch (_err) {
    return '';
  }
}

function resolveGeneratorApiConfig(config = {}) {
  const baseUrl = normalizeBaseUrl(
    config.baseUrl ||
    config.GENERATOR_API_URL ||
    process.env.GENERATOR_API_URL ||
    process.env.BOTGENERATOR_API_URL ||
    DEFAULT_GENERATOR_API_URL
  );
  const apiKey = String(
    config.apiKey ||
    config.GENERATOR_API_KEY ||
    config.GENERATOR_API_TOKEN ||
    process.env.GENERATOR_API_KEY ||
    process.env.BOTGENERATOR_API_KEY ||
    ''
  ).trim();
  const timeoutMs = Number(config.timeoutMs || config.GENERATOR_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    baseUrl,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function assertGeneratorApiConfigured(config) {
  const resolved = resolveGeneratorApiConfig(config);
  if (!resolved.baseUrl) {
    throw new GeneratorApiError(
      'URL API generator tidak valid. Isi GENERATOR_API_URL dengan domain atau URL /api/config.',
      { isConfigError: true, code: 'INVALID_GENERATOR_API_URL' }
    );
  }
  if (!resolved.apiKey) {
    throw new GeneratorApiError(
      'API key generator belum dikonfigurasi. Isi GENERATOR_API_KEY di .vars.json.',
      { isConfigError: true, code: 'MISSING_GENERATOR_API_KEY' }
    );
  }
  return resolved;
}

function responseDataToText(data) {
  if (data === undefined || data === null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch (_err) {
    return String(data);
  }
}

function parseJsonPayload(data) {
  if (data && typeof data === 'object' && !Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
    return data;
  }
  const text = responseDataToText(data).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return { success: false, message: text.slice(0, 360) };
  }
}

function apiErrorFromResponse(response, payload) {
  const status = Number(response?.status || 0);
  const errorValue = payload?.error;
  const code = typeof errorValue === 'string'
    ? errorValue
    : String(errorValue?.code || payload?.code || '');
  const message = String(
    payload?.message ||
    errorValue?.message ||
    (status ? `API generator gagal dengan HTTP ${status}.` : 'API generator gagal memproses request.')
  );
  return new GeneratorApiError(message, {
    status,
    code,
    requestId: payload?.requestId || payload?.request_id || response?.headers?.['x-request-id'] || ''
  });
}

async function requestJson(endpoint, options, config) {
  const resolved = assertGeneratorApiConfigured(config);
  const method = String(options?.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json'
  };
  if (options?.authenticated !== false) {
    headers.Authorization = `Bearer ${resolved.apiKey}`;
  }
  if (options && Object.prototype.hasOwnProperty.call(options, 'body')) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await axios.request({
      method,
      url: `${resolved.baseUrl}${endpoint}`,
      headers,
      data: options?.body,
      timeout: resolved.timeoutMs,
      maxBodyLength: MAX_RESPONSE_BYTES,
      maxContentLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true
    });
    const payload = parseJsonPayload(response.data);
    if (response.status < 200 || response.status >= 300 || payload.success !== true) {
      throw apiErrorFromResponse(response, payload);
    }
    return payload.data === undefined ? payload : payload.data;
  } catch (err) {
    if (err instanceof GeneratorApiError) throw err;
    throw new GeneratorApiError(
      `Tidak bisa menghubungi API generator: ${err?.message || 'network error'}`,
      { code: err?.code || 'GENERATOR_API_NETWORK_ERROR' }
    );
  }
}

function toTemplateBuffer(templateInput) {
  if (Buffer.isBuffer(templateInput)) return templateInput;
  if (templateInput instanceof ArrayBuffer) return Buffer.from(templateInput);
  if (ArrayBuffer.isView(templateInput)) {
    return Buffer.from(templateInput.buffer, templateInput.byteOffset, templateInput.byteLength);
  }
  return Buffer.from(String(templateInput || ''), 'utf8');
}

function templateToRequest(templateInput) {
  if (templateInput && typeof templateInput === 'object' &&
      !Buffer.isBuffer(templateInput) && !(templateInput instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(templateInput)) {
    return { templateObject: templateInput };
  }
  const templateBuffer = toTemplateBuffer(templateInput);
  if (!templateBuffer.length) {
    throw new GeneratorApiError('Template kosong.', { code: 'EMPTY_TEMPLATE' });
  }
  return { templateBase64: templateBuffer.toString('base64') };
}

function normalizeNoteSetting(noteSetting) {
  if (!noteSetting) return { enabled: false, html: '' };
  if (typeof noteSetting === 'string') {
    const html = noteSetting.trim();
    return { enabled: Boolean(html), html };
  }
  const html = String(noteSetting.html || noteSetting.text || noteSetting.note || '').trim();
  return {
    enabled: noteSetting.enabled === undefined ? Boolean(html) : Boolean(noteSetting.enabled),
    html
  };
}

function isDetailedXrayAccountObject(account) {
  if (!account || typeof account !== 'object') return false;
  if (account.username) return false;
  const keys = [
    'uuid', 'id', 'password', 'pass',
    'domainAddress', 'addressOverride', 'bugHost', 'bug', 'customHost', 'addr',
    'tls', 'serverNameIndication', 'sni',
    'wsPath', 'path', 'wsHeaderHost', 'hostHeader', 'headerHost',
    'grpcServiceName', 'serviceName', 'mux',
    'transportNetwork', 'network', 'inheritTemplateTransport'
  ];
  return keys.some((key) => Object.prototype.hasOwnProperty.call(account, key));
}

function accountToApiValue(account) {
  if (typeof account === 'string') return account.trim();
  if (!account || typeof account !== 'object') return '';
  if (account.xrayConfig) {
    if (account.preserveXrayEndpoint || account.compactXrayInput) {
      return JSON.stringify({
        protocol: account.protocol || 'json',
        xrayConfig: String(account.xrayConfig).trim(),
        preserveXrayEndpoint: Boolean(account.preserveXrayEndpoint),
        compactXrayInput: Boolean(account.compactXrayInput)
      });
    }
    return String(account.xrayConfig).trim();
  }
  if (account.sshField) return String(account.sshField).trim();
  if (isDetailedXrayAccountObject(account)) return JSON.stringify(account);
  if (account.rawAccount) return String(account.rawAccount).trim();
  if (account.host && account.port && account.username && account.password) {
    return `${account.host}:${account.port}@${account.username}:${account.password}`;
  }
  if (account.host && (account.uuid || account.id || account.password || account.pass)) {
    const secret = account.uuid || account.id || account.password || account.pass;
    if (account.port) return `${account.host}:${account.port}@${secret}`;
    return `${account.host}:${secret}`;
  }
  try {
    return JSON.stringify(account);
  } catch (_err) {
    return String(account);
  }
}

function hcAccountRequestFields(account, method) {
  if (typeof account === 'string') {
    const accountText = account.trim();
    return accountText ? { accountText } : {};
  }
  if (!account || typeof account !== 'object') return {};

  if (method === 'xray') {
    if (account.xrayConfig) {
      return {
        account: {
          ...account,
          xrayConfig: account.xrayConfig
        }
      };
    }
    if (account.rawAccount) return { accountText: String(account.rawAccount).trim() };
    return { accountText: accountToApiValue(account) };
  }

  const sshField = account.sshField || account.rawAccount ||
    (account.host && account.port && account.username && account.password
      ? `${account.host}:${account.port}@${account.username}:${account.password}`
      : '');
  return sshField ? { account: { sshField: String(sshField).trim() } } : {};
}

function darkAccountRequestValue(account) {
  if (typeof account === 'string') return account.trim();
  if (!account || typeof account !== 'object') return '';
  return { ...account };
}

function contentBufferFromResponse(data, operation) {
  if (data?.contentBase64) {
    const buffer = Buffer.from(String(data.contentBase64), 'base64');
    if (buffer.length) return buffer;
  }
  if (data?.content !== undefined && data?.content !== null) {
    return Buffer.from(String(data.content), 'utf8');
  }
  throw new GeneratorApiError(`Response ${operation} tidak berisi hasil config.`, {
    code: 'INVALID_GENERATOR_API_RESPONSE'
  });
}

async function getGeneratorInfo(config) {
  const health = await requestJson('/health', { authenticated: false }, config);
  const me = await requestJson('/me', {}, config);
  return {
    service: health.service || health.name || 'botvpn-config-generator-api',
    version: health.version || health.appVersion || '',
    endpoints: health.endpoints || [],
    key: me.key || null
  };
}

async function generateHcConfigViaApi(templateInput, options = {}, config) {
  const method = String(options.method || 'ssh').toLowerCase() === 'xray' ? 'xray' : 'ssh';
  const accountFields = hcAccountRequestFields(options.account, method);
  if (!accountFields.account && !accountFields.accountText) {
    throw new GeneratorApiError('Data akun kosong.', { code: 'EMPTY_ACCOUNT' });
  }
  const note = normalizeNoteSetting(options.noteSetting || {
    enabled: options.noteEnabled,
    html: options.noteHtml
  });
  const body = {
    ...templateToRequest(templateInput),
    method,
    ...accountFields,
    name: options.name || options.templateName || '',
    templateName: options.templateName || options.name || '',
    noteHtml: note.enabled ? note.html : ''
  };
  for (const field of ['payload', 'proxy', 'sni']) {
    if (options[field] !== undefined) body[field] = options[field];
  }
  const data = await requestJson('/hc/generate', { method: 'POST', body }, config);
  return contentBufferFromResponse(data, 'generate HC');
}

async function unlockHcConfigViaApi(templateInput, options = {}, config) {
  const body = {
    ...templateToRequest(templateInput),
    options: options.apiOptions || {}
  };
  const data = await requestJson('/hc/unlock', { method: 'POST', body }, config);
  return contentBufferFromResponse(data, 'unlock HC');
}

async function inspectHcConfigViaApi(templateInput, config) {
  return requestJson('/hc/inspect', {
    method: 'POST',
    body: templateToRequest(templateInput)
  }, config);
}

async function generateDarkTunnelViaApi(templateInput, options = {}, config) {
  const method = String(options.method || 'ssh').trim().toLowerCase();
  const account = darkAccountRequestValue(options.account);
  if (!account || (typeof account === 'string' && !account)) {
    throw new GeneratorApiError('Data akun kosong.', { code: 'EMPTY_ACCOUNT' });
  }
  const body = {
    ...templateToRequest(templateInput),
    method,
    account,
    name: options.name || '',
    noteSetting: normalizeNoteSetting(options.noteSetting)
  };
  const data = await requestJson('/dark/generate', { method: 'POST', body }, config);
  if (!data?.content) {
    throw new GeneratorApiError('Response generate Dark Tunnel tidak berisi hasil config.', {
      code: 'INVALID_GENERATOR_API_RESPONSE'
    });
  }
  const text = String(data.content);
  return { ...data, text, buffer: Buffer.from(text, 'utf8') };
}

async function unlockDarkTunnelViaApi(templateInput, _options = {}, config) {
  const data = await requestJson('/dark/unlock', {
    method: 'POST',
    body: templateToRequest(templateInput)
  }, config);
  if (!data?.content) {
    throw new GeneratorApiError('Response unlock Dark Tunnel tidak berisi hasil config.', {
      code: 'INVALID_GENERATOR_API_RESPONSE'
    });
  }
  const text = String(data.content);
  return {
    ...data,
    text,
    buffer: Buffer.from(text, 'utf8'),
    fullyUnlocked: Boolean(data.fullyUnlocked),
    warning: String(data.warning || '')
  };
}

function formatGeneratorApiError(error, fallbackMessage) {
  if (error instanceof GeneratorApiError || error?.name === 'GeneratorApiError') {
    const errorCode = error.code ? `\nKode: ${error.code}` : '';
    const requestId = error.requestId ? `\nRequest ID: ${error.requestId}` : '';
    return `${fallbackMessage}\n\nDetail: ${error.message}${errorCode}${requestId}`;
  }
  return fallbackMessage;
}

module.exports = {
  DEFAULT_GENERATOR_API_URL,
  GeneratorApiError,
  normalizeBaseUrl,
  resolveGeneratorApiConfig,
  assertGeneratorApiConfigured,
  getGeneratorInfo,
  generateHcConfigViaApi,
  unlockHcConfigViaApi,
  inspectHcConfigViaApi,
  generateDarkTunnelViaApi,
  unlockDarkTunnelViaApi,
  formatGeneratorApiError,
  accountToApiValue
};

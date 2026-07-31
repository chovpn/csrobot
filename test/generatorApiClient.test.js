const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  GeneratorApiError,
  normalizeBaseUrl,
  getGeneratorInfo,
  generateHcConfigViaApi,
  unlockHcConfigViaApi,
  inspectHcConfigViaApi,
  generateDarkTunnelViaApi,
  unlockDarkTunnelViaApi
} = require('../lib/generatorApiClient');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function withApiServer(handler, callback) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'test_error', message: error.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    GENERATOR_API_URL: `http://127.0.0.1:${server.address().port}`,
    GENERATOR_API_KEY: 'btg_test_secret',
    GENERATOR_API_TIMEOUT_MS: 5000
  };
  try {
    return await callback(config);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

test('normalizes domain and documentation URL to the new /api/config base path', () => {
  assert.equal(
    normalizeBaseUrl('https://generator.example.com'),
    'https://generator.example.com/api/config'
  );
  assert.equal(
    normalizeBaseUrl('https://generator.example.com/docs/'),
    'https://generator.example.com/api/config'
  );
  assert.equal(
    normalizeBaseUrl('https://generator.example.com/api/config/'),
    'https://generator.example.com/api/config'
  );
});

test('checks health and API key through /health and /me', async () => {
  const paths = [];
  await withApiServer(async (req, res) => {
    paths.push(req.url);
    if (req.url === '/api/config/health') {
      assert.equal(req.headers.authorization, undefined);
      return sendJson(res, { success: true, service: 'botvpn-config-generator-api', endpoints: [] });
    }
    assert.equal(req.url, '/api/config/me');
    assert.equal(req.headers.authorization, 'Bearer btg_test_secret');
    return sendJson(res, {
      success: true,
      data: { key: { id: 'abc123', label: 'Standalone', scopes: ['generate', 'unlock'] } }
    });
  }, async (config) => {
    const info = await getGeneratorInfo(config);
    assert.equal(info.service, 'botvpn-config-generator-api');
    assert.equal(info.key.label, 'Standalone');
  });
  assert.deepEqual(paths, ['/api/config/health', '/api/config/me']);
});

test('HC requests use JSON Base64 and decode contentBase64 responses', async () => {
  const received = [];
  await withApiServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer btg_test_secret');
    assert.match(String(req.headers['content-type']), /^application\/json/);
    const body = await readJson(req);
    received.push({ path: req.url, body });

    if (req.url === '/api/config/hc/generate') {
      return sendJson(res, {
        success: true,
        data: { contentBase64: Buffer.from('HC LOCKED').toString('base64') }
      });
    }
    if (req.url === '/api/config/hc/unlock') {
      return sendJson(res, {
        success: true,
        data: { contentBase64: Buffer.from('HC UNLOCKED').toString('base64') }
      });
    }
    return sendJson(res, {
      success: true,
      data: { format: 'hc', info: { name: 'TEST' } }
    });
  }, async (config) => {
    const generated = await generateHcConfigViaApi(Buffer.from('TEMPLATE HC'), {
      method: 'ssh',
      account: { sshField: 'server.example.com:443@user:pass' },
      name: 'SSH TEST',
      noteEnabled: true,
      noteHtml: 'Catatan'
    }, config);
    assert.equal(generated.toString(), 'HC LOCKED');

    const unlocked = await unlockHcConfigViaApi(generated, {}, config);
    assert.equal(unlocked.toString(), 'HC UNLOCKED');

    const inspected = await inspectHcConfigViaApi(unlocked, config);
    assert.equal(inspected.info.name, 'TEST');
  });

  assert.deepEqual(received.map((item) => item.path), [
    '/api/config/hc/generate',
    '/api/config/hc/unlock',
    '/api/config/hc/inspect'
  ]);
  assert.equal(received[0].body.templateBase64, Buffer.from('TEMPLATE HC').toString('base64'));
  assert.deepEqual(received[0].body.account, { sshField: 'server.example.com:443@user:pass' });
  assert.equal(received[0].body.noteHtml, 'Catatan');
  assert.equal(received[1].body.templateBase64, Buffer.from('HC LOCKED').toString('base64'));
});

test('HC Xray request sends xrayConfig as an account object', async () => {
  let receivedBody;
  await withApiServer(async (req, res) => {
    receivedBody = await readJson(req);
    return sendJson(res, {
      success: true,
      data: { contentBase64: Buffer.from('HC XRAY').toString('base64') }
    });
  }, async (config) => {
    await generateHcConfigViaApi('TEMPLATE', {
      method: 'xray',
      account: {
        protocol: 'vless',
        username: 'vless',
        xrayConfig: '{"outbounds":[]}',
        preserveXrayEndpoint: true,
        compactXrayInput: false
      }
    }, config);
  });

  assert.equal(receivedBody.method, 'xray');
  assert.equal(receivedBody.account.xrayConfig, '{"outbounds":[]}');
  assert.equal(receivedBody.account.preserveXrayEndpoint, true);
  assert.equal(receivedBody.accountText, undefined);
});

test('Dark Tunnel requests preserve account object and unlock status', async () => {
  const received = [];
  await withApiServer(async (req, res) => {
    const body = await readJson(req);
    received.push({ path: req.url, body });
    if (req.url === '/api/config/dark/generate') {
      return sendJson(res, {
        success: true,
        data: { format: 'dark', variant: 'locked', content: 'darktunnel://LOCKED' }
      });
    }
    return sendJson(res, {
      success: true,
      data: {
        format: 'dark',
        variant: 'unlocked',
        content: 'darktunnel://UNLOCKED',
        fullyUnlocked: false,
        warning: 'Payload lock tidak kompatibel'
      }
    });
  }, async (config) => {
    const generated = await generateDarkTunnelViaApi('darktunnel://TEMPLATE', {
      method: 'VLESS',
      account: {
        host: 'server.example.com',
        port: 443,
        uuid: '11111111-1111-4111-8111-111111111111',
        domainAddress: 'bug.example.com'
      },
      name: 'VLESS TEST',
      noteSetting: { enabled: true, html: 'Dilarang berbagi' }
    }, config);
    assert.equal(generated.text, 'darktunnel://LOCKED');

    const unlocked = await unlockDarkTunnelViaApi(generated.text, {}, config);
    assert.equal(unlocked.text, 'darktunnel://UNLOCKED');
    assert.equal(unlocked.fullyUnlocked, false);
    assert.equal(unlocked.warning, 'Payload lock tidak kompatibel');
  });

  assert.equal(received[0].path, '/api/config/dark/generate');
  assert.equal(received[0].body.method, 'vless');
  assert.equal(received[0].body.account.domainAddress, 'bug.example.com');
  assert.deepEqual(received[0].body.noteSetting, { enabled: true, html: 'Dilarang berbagi' });
  assert.equal(received[1].path, '/api/config/dark/unlock');
});

test('preserves documented API error code and HTTP status', async () => {
  await withApiServer((_req, res) => {
    sendJson(res, {
      success: false,
      error: 'daily_quota_exceeded',
      message: 'Quota harian habis.'
    }, 429);
  }, async (config) => {
    await assert.rejects(
      () => unlockHcConfigViaApi('locked hc', {}, config),
      (error) => {
        assert.ok(error instanceof GeneratorApiError);
        assert.equal(error.status, 429);
        assert.equal(error.code, 'daily_quota_exceeded');
        assert.equal(error.message, 'Quota harian habis.');
        return true;
      }
    );
  });
});

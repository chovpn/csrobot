const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSshAccount,
  parseXrayAccount
} = require('../lib/darkAccountInput');
const { accountToApiValue } = require('../lib/generatorApiClient');

function vmessLink(overrides = {}) {
  const payload = {
    v: '2',
    ps: 'test',
    add: 'akun-vmess.example.com',
    port: '443',
    id: '11111111-1111-4111-8111-111111111111',
    aid: '0',
    net: 'ws',
    type: 'none',
    host: 'host-header.example.com',
    path: '/vmess',
    tls: 'tls',
    sni: 'sni.example.com',
    ...overrides
  };
  return `vmess://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

test('Dark xray account object preserves Domain Address override for API payload', () => {
  const parsed = parseXrayAccount({
    host: 'akun-vmess.example.com',
    uuid: '11111111-1111-4111-8111-111111111111',
    domainAddress: 'bug.template.example.com',
    inheritTemplateTransport: true
  }, 'VMESS');

  assert.equal(parsed.domainAddress, 'bug.template.example.com');
  assert.equal(parsed.inheritTemplateTransport, true);
  assert.equal(parsed.port, undefined);

  const apiValue = accountToApiValue(parsed);
  assert.doesNotMatch(apiValue, /^akun-vmess\.example\.com:/);
  const sent = JSON.parse(apiValue);
  assert.equal(sent.domainAddress, 'bug.template.example.com');
  assert.equal(sent.host, 'akun-vmess.example.com');
});

test('Dark vmess link keeps transport fields when serialized to generator API', () => {
  const parsed = parseXrayAccount(vmessLink(), 'VMESS');
  const sent = JSON.parse(accountToApiValue(parsed));

  assert.equal(sent.host, 'akun-vmess.example.com');
  assert.equal(sent.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(sent.tls, true);
  assert.equal(sent.serverNameIndication, 'sni.example.com');
  assert.equal(sent.wsHeaderHost, 'host-header.example.com');
  assert.equal(sent.wsPath, '/vmess');
});

test('SSH account still serializes as compact raw account', () => {
  const parsed = parseSshAccount('ssh.example.com:22@user:pass');

  assert.equal(accountToApiValue(parsed), 'ssh.example.com:22@user:pass');
});

test('HC xray payload keeps preserve endpoint flag for generator API', () => {
  const apiValue = accountToApiValue({
    protocol: 'vmess',
    xrayConfig: JSON.stringify({ outbounds: [] }),
    preserveXrayEndpoint: true,
    compactXrayInput: false
  });
  const sent = JSON.parse(apiValue);

  assert.equal(sent.protocol, 'vmess');
  assert.equal(sent.preserveXrayEndpoint, true);
  assert.equal(sent.compactXrayInput, false);
  assert.equal(sent.xrayConfig, '{"outbounds":[]}');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHcCompactXrayInput } = require('../lib/hcXrayInput');

test('host:UUID defaults to VMess', () => {
  const parsed = parseHcCompactXrayInput(
    'server.example.com:11111111-1111-1111-1111-111111111111'
  );

  assert.equal(parsed.protocol, 'vmess');
  assert.equal(parsed.address, 'server.example.com');
  assert.equal(parsed.port, 443);
  assert.equal(parsed.id, '11111111-1111-1111-1111-111111111111');
});

test('VLESS compact prefix uses a UUID', () => {
  const parsed = parseHcCompactXrayInput(
    'vless:server.example.com:22222222-2222-2222-2222-222222222222'
  );

  assert.equal(parsed.protocol, 'vless');
  assert.equal(parsed.id, '22222222-2222-2222-2222-222222222222');
});

test('Trojan compact prefix uses a password', () => {
  const parsed = parseHcCompactXrayInput('trojan:server.example.com:secret:with@symbols');

  assert.equal(parsed.protocol, 'trojan');
  assert.equal(parsed.password, 'secret:with@symbols');
  assert.equal(parsed.id, '');
});

test('compact input accepts an explicit server port', () => {
  const parsed = parseHcCompactXrayInput(
    'server.example.com:8443@33333333-3333-3333-3333-333333333333'
  );

  assert.equal(parsed.address, 'server.example.com');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.id, '33333333-3333-3333-3333-333333333333');
});

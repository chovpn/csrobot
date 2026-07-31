const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const forbiddenFiles = [
  'saas-bot.js',
  'saas.config.json',
  'saas.config.example.json',
  'ecosystem.saas.config.js',
  path.join('lib', 'saasPpobHub.js'),
  path.join('lib', 'saasSecrets.js'),
  path.join('lib', 'saasTenantManager.js'),
  path.join('lib', 'hcGenerator.js'),
  path.join('lib', 'darktunnelGenerator.js')
];

const forbiddenAppTokens = [
  "require('./lib/saasPpobHub')",
  "require('./lib/saasSecrets')",
  "require('./lib/hcGenerator')",
  "require('./lib/darktunnelGenerator')",
  'TENANT_ID',
  'TENANTS_ROOT',
  'tenantConfigPath',
  'PPOB_PROVIDER_MODE',
  'HC_CONFIG_ENCRYPTION_KEY',
  's3cr3T_k3Y_ePr0_3NcRypT',
  'generateHcConfigFromEncryptedTemplate',
  'generateDarkTunnelFromTemplate'
];

const errors = [];
for (const relativePath of forbiddenFiles) {
  if (fs.existsSync(path.join(root, relativePath))) {
    errors.push(`File khusus master tidak boleh ada: ${relativePath}`);
  }
}

const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
for (const token of forbiddenAppTokens) {
  if (appSource.includes(token)) {
    errors.push(`app.js masih bergantung pada mode master: ${token}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.scripts?.['start:saas']) {
  errors.push('Script start:saas tidak boleh ada.');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log('Verifikasi standalone lulus: tidak ada runtime bot admin master atau source generator lokal.');

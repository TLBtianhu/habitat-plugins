// 构建独立应用插件包与索引；只包含该应用所需的最小文件集合。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.argv[2] || path.join(ROOT, 'plugins');
const DIST = path.join(ROOT, 'dist');
const APPS = {
  qq: {
    version: '0.1.2',
    dependencies: { ws: '^8.18.0' },
    files: [
      'adapters/qq/manifest.json', 'adapters/qq/provider.mjs',
      'clients/onebot.mjs', 'clients/onebot-supervisor.mjs',
      'agent/residence-policy.mjs', 'agent/durable-outbox.mjs',
      'agent/after-action.mjs', 'agent/residence-memory-store.mjs',
      'config/residence-policy.example.json',
    ],
  },
  bilibili: {
    version: '0.1.1',
    dependencies: { ws: '^8.18.0' },
    files: [
      'adapters/bilibili/manifest.json', 'adapters/bilibili/provider.mjs', 'adapters/bilibili/server.mjs',
      'clients/bilibili-danmaku.mjs', 'clients/bilibili-supervisor.mjs',
      'clients/bilibili-wbi.mjs', 'clients/bilibili.mjs',
    ],
  },
  mc: {
    version: '0.1.1',
    dependencies: {},
    files: [
      'adapters/mc/manifest.json', 'adapters/mc/provider.mjs',
      'clients/mc-native.mjs', 'clients/mcpfabric-token.mjs',
      'agent/durable-outbox.mjs',
    ],
  },
  hls: {
    version: '0.1.0',
    dependencies: {},
    files: [
      'adapters/hls/manifest.json',
      'tools/wsl-pipeline-up.sh', 'tools/pipeline.mjs',
    ],
  },
};

function copyApp(id, def) {
  const appDir = path.join(DIST, 'app', id);
  fs.mkdirSync(appDir, { recursive: true });
  for (const rel of def.files) {
    const src = path.join(SOURCE, rel);
    if (!fs.existsSync(src)) throw new Error(`missing ${id} source: ${rel}`);
    const dst = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: `@habitat/app-${id}`,
    version: def.version,
    private: true,
    type: 'module',
    dependencies: def.dependencies,
  }, null, 2) + '\n');
  const npm = process.platform === 'win32' ? (process.env.comspec || 'cmd.exe') : 'npm';
  const npmArgs = (args) => process.platform === 'win32' ? ['/c', 'npm', ...args] : args;
  execFileSync(npm, npmArgs(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']), { cwd: appDir, stdio: 'inherit' });
  execFileSync(npm, npmArgs(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']), { cwd: appDir, stdio: 'inherit' });
  const zip = path.join(DIST, `app-${id}.zip`);
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'zip',
    process.platform === 'win32' ? ['-a', '-c', '-f', zip, '-C', appDir, '.'] : ['-qr', zip, '.'],
    { cwd: appDir, stdio: 'inherit' });
  if (fs.readFileSync(zip).subarray(0, 2).toString() !== 'PK') throw new Error('not a zip: ' + zip);
  return zip;
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
const entries = [];
for (const [id, def] of Object.entries(APPS)) {
  const zip = copyApp(id, def);
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'app', id, `adapters/${id}/manifest.json`), 'utf8'));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  entries.push({
    id,
    version: def.version,
    kind: manifest.kind,
    apiRange: '^1.0.0',
    entry: `adapters/${id}/manifest.json`,
    lifecycle: manifest.lifecycle,
    capabilities: manifest.capabilities,
    scopes: manifest.scopes,
    permissions: manifest.permissions,
    license: 'MIT',
    artifact: {
      file: `dist/app-${id}.zip`,
      url: `https://github.com/TLBtianhu/habitat-plugins/releases/download/plugins-v0.1.3/app-${id}.zip`,
      sha256: hash,
    },
    revoked: false,
  });
}
const index = {
  schemaVersion: 1,
  channel: 'stable',
  apiRange: '^1.0.0',
  signature: { algorithm: 'Ed25519', file: 'index.sig.json', publicKey: 'release-public-key.pem' },
  revocations: 'revocations.json',
  plugins: entries,
};
fs.writeFileSync(path.join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'revocations.json'), JSON.stringify({ schemaVersion: 1, revoked: [] }, null, 2) + '\n');
console.log('built app packages:', entries.map((e) => e.id).join(', '));

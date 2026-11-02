// 验证插件索引签名、制品哈希、权限字段和撤销状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
if (index.schemaVersion !== 1 || !index.channel || !index.apiRange || !Array.isArray(index.plugins)) throw new Error('invalid plugin index');
for (const plugin of index.plugins) {
  for (const field of ['id', 'version', 'entry', 'lifecycle', 'license']) {
    if (!plugin[field]) throw new Error(`plugin ${plugin.id}: missing ${field}`);
  }
  if (!plugin.artifact?.file || !plugin.artifact.url || !plugin.artifact.sha256) throw new Error(`plugin ${plugin.id}: artifact required`);
  if (plugin.artifact.file.includes('..') || !/^https:\/\//.test(plugin.artifact.url)) throw new Error(`plugin ${plugin.id}: unsafe artifact`);
  const file = path.join(ROOT, plugin.artifact.file);
  if (!fs.existsSync(file)) throw new Error('missing artifact: ' + plugin.artifact.file);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== plugin.artifact.sha256) throw new Error(`artifact hash mismatch: ${plugin.id}`);
  if (plugin.revoked) throw new Error(`plugin revoked: ${plugin.id}`);
}
const canonical = JSON.stringify(index, null, 2) + '\n';
const sig = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.sig.json'), 'utf8'));
const publicKey = fs.readFileSync(path.join(ROOT, 'release-public-key.pem'), 'utf8');
if (!crypto.verify(null, canonical, publicKey, Buffer.from(sig.signature, 'base64'))) throw new Error('plugin index signature invalid');
const revocations = JSON.parse(fs.readFileSync(path.join(ROOT, 'revocations.json'), 'utf8'));
if (!Array.isArray(revocations.revoked)) throw new Error('invalid revocations');
const revocationSig = JSON.parse(fs.readFileSync(path.join(ROOT, 'revocations.sig.json'), 'utf8'));
if (!crypto.verify(null, JSON.stringify(revocations, null, 2) + '\n', publicKey, Buffer.from(revocationSig.signature, 'base64'))) {
  throw new Error('revocations signature invalid');
}
console.log(`ok: ${index.plugins.length} app plugins · signatures, hashes and permissions valid`);

// 为插件索引签名；私钥只存在受保护的本地配置，仓库只保存公钥。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privatePath = process.env.HABITAT_RELEASE_SIGNING_PRIVATE || '/etc/habitat/release-signing-private.pem';
const publicPath = path.join(ROOT, 'release-public-key.pem');
let privateKey;
let publicKey;
if (fs.existsSync(privatePath)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath, 'utf8'));
  publicKey = crypto.createPublicKey(privateKey);
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}
fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
const indexPath = path.join(ROOT, 'index.json');
const canonical = JSON.stringify(JSON.parse(fs.readFileSync(indexPath, 'utf8')), null, 2) + '\n';
const signature = crypto.sign(null, canonical, privateKey).toString('base64');
fs.writeFileSync(path.join(ROOT, 'index.sig.json'), JSON.stringify({ algorithm: 'Ed25519', signature, publicKey: 'release-public-key.pem' }, null, 2) + '\n');
console.log('plugin index signed');

// 验证应用包能独立解包并加载最小 provider，不依赖 Habitat 主仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const id of ['qq', 'bilibili', 'mc']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `habitat-app-${id}-`));
  const zip = path.join(ROOT, 'dist', `app-${id}.zip`);
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const code = `import zipfile; zipfile.ZipFile(${JSON.stringify(zip)}).extractall(${JSON.stringify(dir)})`;
  execFileSync(python, process.platform === 'win32' ? ['-3', '-c', code] : ['-c', code], { stdio: 'inherit' });
  if (id === 'qq') {
    const { createHandlers } = await import(pathToFileURL(path.join(dir, 'adapters/qq/provider.mjs')).href);
    if (typeof createHandlers !== 'function') throw new Error('qq provider export missing');
    const handlers = createHandlers({ onebotClient: {}, policy: {}, getResidenceContext: () => null });
    if (typeof handlers.reply !== 'function') throw new Error('qq.reply handler missing');
  } else if (id === 'bilibili') {
    const { BiliDanmakuClient } = await import(pathToFileURL(path.join(dir, 'clients/bilibili-danmaku.mjs')).href);
    const client = new BiliDanmakuClient({ roomId: 1, cookie: '' });
    if (client.roomId !== 1) throw new Error('bilibili client failed to initialize');
  } else {
    const { createHandlers } = await import(pathToFileURL(path.join(dir, 'adapters/mc/provider.mjs')).href);
    const handlers = createHandlers({ client: { obs: async () => ({ mode: 'play' }) } });
    const obs = await handlers.obs();
    if (obs.mode !== 'play') throw new Error('mc provider obs failed');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok: qq/bilibili/mc 独立解包与最小 provider 加载');

// 验证应用包能独立解包并加载最小 provider，不依赖 Habitat 主仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const id of ['qq', 'bilibili', 'mc', 'hls']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `habitat-app-${id}-`));
  const zip = path.join(ROOT, 'dist', `app-${id}.zip`);
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const code = `import zipfile; zipfile.ZipFile(${JSON.stringify(zip)}).extractall(${JSON.stringify(dir)})`;
  execFileSync(python, process.platform === 'win32' ? ['-3', '-c', code] : ['-c', code], { stdio: 'inherit' });
  if (id === 'qq') {
    const { createHandlers, createRuntime } = await import(pathToFileURL(path.join(dir, 'adapters/qq/provider.mjs')).href);
    const runtime = createRuntime({ env: {}, onebotClientFactory: () => ({}) });
    const handlers = createHandlers({ runtime, policy: {}, getResidenceContext: () => null });
    if (typeof handlers.reply !== 'function') throw new Error('qq.reply handler missing');
    await runtime.start();
    if (runtime.status().state !== 'disabled') throw new Error('unconfigured QQ runtime must stay disabled');
    await runtime.stop();
  } else if (id === 'bilibili') {
    const { createRuntime } = await import(pathToFileURL(path.join(dir, 'adapters/bilibili/provider.mjs')).href);
    const runtime = createRuntime({ env: {} });
    await runtime.start();
    if (runtime.status().state !== 'disabled') throw new Error('unconfigured Bilibili runtime must stay disabled');
    await runtime.stop();
  } else if (id === 'hls') {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'adapters/hls/manifest.json'), 'utf8'));
    if (manifest.lifecycle !== 'outlet' || !manifest.requires.includes('desktop.capture') || !manifest.requires.includes('audio.capture')) {
      throw new Error('hls runtime dependencies missing');
    }
    const entry = path.resolve(path.dirname(path.join(dir, 'adapters/hls/manifest.json')), manifest.entry);
    if (!fs.existsSync(entry) || !fs.existsSync(path.join(dir, 'tools/pipeline.mjs'))) throw new Error('hls outlet files missing');
    const script = fs.readFileSync(entry, 'utf8');
    if (script.includes('/opt/habitat/app')) throw new Error('hls outlet must not hardcode the development app path');
    if (!script.includes('HABITAT_NODE')) throw new Error('hls outlet must inherit the Supervisor Node runtime');
  } else {
    const { createHandlers, createRuntime } = await import(pathToFileURL(path.join(dir, 'adapters/mc/provider.mjs')).href);
    const runtime = createRuntime({ mcClientFactory: () => ({ obs: async () => ({ mode: 'play' }), act: async () => ({ ok: true }) }) });
    const handlers = createHandlers({ runtime });
    await runtime.start();
    const obs = await handlers.obs();
    if (obs.mode !== 'play') throw new Error('mc provider obs failed');
    await runtime.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ok: qq/bilibili/mc/hls 独立解包与最小 runtime/entry 验收');

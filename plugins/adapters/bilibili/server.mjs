// B站独立 Adapter 进程：登录与弹幕都在本进程内，不依赖 Core 的实现
import http from 'node:http';
import fs from 'node:fs';
import { BiliDanmakuClient } from '../../clients/bilibili-danmaku.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const events = [];
let client = null;
const cookie = fs.existsSync('/etc/habitat/bilibili-cookies.txt')
  ? fs.readFileSync('/etc/habitat/bilibili-cookies.txt', 'utf8').trim()
  : `SESSDATA=${JSON.parse(fs.readFileSync('/etc/habitat/bilibili.json', 'utf8')).sessdata}`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return json(200, { name: manifest.name, version: manifest.version, sdk: manifest.sdkRange, status: 'ok' });
  if (url.pathname === '/events') return json(200, events.slice(-50));

  if (url.pathname === '/danmaku/connect' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { roomId } = JSON.parse(body || '{}');
    if (client) return json(409, { error: 'already connected' });
    client = new BiliDanmakuClient({ roomId, cookie, onEvent: (e) => { events.push(e); if (events.length > 200) events.shift(); } });
    await client.connect();
    return json(200, { connected: true, roomId });
  }
  if (url.pathname === '/danmaku/stop' && req.method === 'POST') {
    client?.close(); client = null;
    return json(200, { stopped: true });
  }
  json(404, { error: 'not found' });
}).listen(9250, '127.0.0.1', () => console.log('[bilibili-adapter] 127.0.0.1:9250 v' + manifest.version));

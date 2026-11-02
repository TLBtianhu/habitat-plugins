// B站应用运行时：只读弹幕连接与重连监督，不创建公网推送。
import fs from 'node:fs';
import { BiliConnectionSupervisor } from '../../clients/bilibili-supervisor.mjs';

function loadCookie(env) {
  if (env.HABITAT_BILIBILI_COOKIE) return env.HABITAT_BILIBILI_COOKIE;
  if (fs.existsSync('/etc/habitat/bilibili-cookies.txt')) return fs.readFileSync('/etc/habitat/bilibili-cookies.txt', 'utf8').trim();
  if (fs.existsSync('/etc/habitat/bilibili.json')) {
    return `SESSDATA=${JSON.parse(fs.readFileSync('/etc/habitat/bilibili.json', 'utf8')).sessdata}`;
  }
  return '';
}

export function createRuntime({ env = process.env, bilibiliSupervisorFactory = null } = {}) {
  const roomId = Number(env.HABITAT_BILIBILI_ROOM_ID || 0);
  const listeners = new Set();
  const supervisor = roomId
    ? (bilibiliSupervisorFactory || ((options) => new BiliConnectionSupervisor(options)))({
      roomId,
      cookie: loadCookie(env),
      onEvent: (event) => { for (const listener of listeners) listener(event); },
    })
    : null;
  return {
    async start() { await supervisor?.start(); },
    async stop() { await supervisor?.stop(); },
    status() { return supervisor ? { ...supervisor.status(), enabled: true } : { state: 'disabled', enabled: false, roomId: 0, lastError: null }; },
    obs() { return supervisor?.obs() || { available: false, state: 'disabled', recent: [], new: [] }; },
    complete(ids) { supervisor?.complete(ids); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    roomId,
  };
}

export function createHandlers() { return {}; }

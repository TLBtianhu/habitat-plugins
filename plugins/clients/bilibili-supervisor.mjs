// B站弹幕 ConnectionSupervisor：连接健康、心跳、重连、有限窗口去重与状态诊断。
import crypto from 'node:crypto';
import { BiliDanmakuClient } from './bilibili-danmaku.mjs';

export class BiliConnectionSupervisor {
  constructor({ roomId, cookie, onEvent = () => {}, clientFactory = null, idleTimeoutMs = 90000, connectTimeoutMs = 12000 }) {
    if (!Number(roomId)) throw new Error('roomId required');
    this.roomId = Number(roomId);
    this.cookie = cookie;
    this.onEvent = onEvent;
    this.clientFactory = clientFactory || ((opts) => new BiliDanmakuClient(opts));
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.client = null;
    this.state = 'stopped';
    this.attempt = 0;
    this.nextRetryAt = 0;
    this.lastOpenAt = 0;
    this.lastMessageAt = 0;
    this.lastError = null;
    this.connectionId = 0;
    this.connectStartedAt = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.watchdog = null;
    this.recent = [];
    this.pending = [];
    this.seen = new Map();
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this._connect();
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkHealth(), 1000);
  }

  async stop() {
    this.stopped = true;
    this.state = 'stopped';
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = 0;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.pending = [];
    this.client?.close();
    this.client = null;
  }

  async _connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    this.connectStartedAt = Date.now();
    try {
      this.client = this.clientFactory({
        roomId: this.roomId,
        cookie: this.cookie,
        onEvent: (event) => this._event(event),
      });
      await this.client.connect();
    } catch (e) {
      this.lastError = String(e.message || e);
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    if (this.stopped || this.nextRetryAt) return;
    this.attempt += 1;
    const base = Math.min(30000, 1000 * 2 ** (this.attempt - 1));
    const delay = Math.round(base * (1 + Math.random() * 0.25));
    this.nextRetryAt = Date.now() + delay;
    this.state = 'degraded';
    this.retryTimer = setTimeout(() => {
      this.nextRetryAt = 0;
      this._connect();
    }, delay);
  }

  _event(event) {
    if (this.stopped) return;
    if (event.type === 'activity') {
      this.lastMessageAt = Date.now();
      return;
    }
    if (event.type === 'open') {
      this.state = 'ready';
      this.attempt = 0;
      this.nextRetryAt = 0;
      this.lastOpenAt = Date.now();
      this.lastMessageAt = Date.now();
      this.lastError = null;
      this.connectionId += 1;
      return;
    }
    if (event.type === 'close') {
      this.lastError = 'connection closed';
      this._scheduleRetry();
      return;
    }
    if (event.type === 'error') {
      this.lastError = String(event.error || 'unknown');
      this._scheduleRetry();
      return;
    }
    if (!['danmaku', 'gift', 'enter'].includes(event.type)) return;
    this.lastMessageAt = Date.now();
    const now = Date.now();
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      type: event.type,
      user: event.user,
      text: event.text || event.name,
      second: Math.floor(now / 1000),
    })).digest('hex').slice(0, 24);
    if (this.seen.has(fingerprint) && now - this.seen.get(fingerprint) < 5000) return;
    this.seen.set(fingerprint, now);
    for (const [key, at] of this.seen) if (now - at > 5000) this.seen.delete(key);
    const normalized = {
      id: fingerprint,
      source: 'bilibili',
      type: 'app.bilibili.danmaku',
      residenceId: `bilibili.room.${this.roomId}`,
      peerId: String(this.roomId),
      kind: 'room',
      speakerRole: 'viewer',
      trust: 'viewer',
      addressed: false,
      kind: event.type,
      roomId: this.roomId,
      user: event.user || 'unknown',
      text: String(event.text || event.name || ''),
      at: now,
      connectionId: this.connectionId,
    };
    this.recent.push(normalized);
    this.pending.push(normalized);
    this.recent = this.recent.slice(-50);
    this.pending = this.pending.slice(-50);
    this.onEvent(normalized);
  }

  checkHealth() {
    if (this.stopped) return;
    const now = Date.now();
    if (this.state === 'connecting' && now - this.connectStartedAt > this.connectTimeoutMs) {
      this.lastError = 'connect timeout';
      this.client?.close();
      this._scheduleRetry();
      return;
    }
    if (this.state === 'ready' && now - this.lastMessageAt > this.idleTimeoutMs) {
      this.lastError = 'heartbeat timeout';
      this.client?.close();
      this._scheduleRetry();
    }
  }

  obs() {
    return {
      available: this.state === 'ready',
      state: this.state,
      recent: this.recent.map((e) => ({ ...e })),
      new: this.pending.map((e) => ({ ...e })),
    };
  }

  complete(ids) {
    const done = new Set(ids);
    this.pending = this.pending.filter((e) => !done.has(e.id));
  }

  status() {
    return {
      roomId: this.roomId,
      state: this.state,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      lastOpenAt: this.lastOpenAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      connectionId: this.connectionId,
      pending: this.pending.length,
    };
  }
}

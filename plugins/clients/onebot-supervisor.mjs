// OneBot ConnectionSupervisor：WS 心跳、重连、消息去重、背压与正常关闭。
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { ChannelPolicy } from '../agent/residence-policy.mjs';

export class OneBotConnectionSupervisor {
  constructor({ wsUrl, accessToken = '', onEvent = () => {}, clientFactory = null, idleTimeoutMs = 90000, connectTimeoutMs = 10000, maxQueue = 50, policy = null }) {
    if (!wsUrl) throw new Error('wsUrl required');
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.onEvent = onEvent;
    this.clientFactory = clientFactory || (({ url, headers }) => new WebSocket(url, { headers }));
    this.policy = policy || new ChannelPolicy();
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxQueue = maxQueue;
    this.ws = null;
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
    this.deadLetter = [];
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
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
      setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
    }
  }

  async _connect() {
    if (this.stopped) return;
    this.state = 'connecting';
    this.connectStartedAt = Date.now();
    try {
      const headers = this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {};
      this.ws = this.clientFactory({ url: this.wsUrl, headers });
      this.ws.on('open', () => this._open());
      this.ws.on('message', (data) => this._message(data));
      this.ws.on('close', (code, reason) => this._close(code, reason));
      this.ws.on('error', (error) => this._error(error));
    } catch (error) {
      this._error(error);
    }
  }

  _open() {
    if (this.stopped) return;
    this.state = 'ready';
    this.attempt = 0;
    this.nextRetryAt = 0;
    this.lastOpenAt = Date.now();
    this.lastMessageAt = Date.now();
    this.lastError = null;
    this.connectionId += 1;
  }

  _close(code, reason) {
    if (this.stopped) return;
    const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
    if (code === 1008 || /auth|token|unauthor/i.test(text)) {
      this.state = 'auth_required';
      this.lastError = `authentication required (${code || 'closed'})`;
      return;
    }
    this.lastError = `connection closed (${code || 'unknown'})`;
    this._scheduleRetry();
  }

  _error(error) {
    if (this.stopped) return;
    this.lastError = String(error?.message || error);
    this._scheduleRetry();
    try { this.ws?.terminate(); } catch {}
  }

  _scheduleRetry() {
    if (this.stopped || this.nextRetryAt || this.state === 'auth_required') return;
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

  _message(data) {
    if (this.stopped) return;
    this.lastMessageAt = Date.now();
    let event;
    try { event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
    if (event.post_type === 'meta_event' || event.meta_event_type === 'heartbeat') return;
    if (event.post_type !== 'message') return;
    const at = Number(event.time) ? Number(event.time) * 1000 : Date.now();
    const text = String(event.raw_message || (Array.isArray(event.message)
      ? event.message.map((segment) => segment?.data?.text || '').join('')
      : event.message) || '');
    const id = event.message_id != null
      ? `qq:${event.self_id}:${event.message_id}`
      : 'qq:' + crypto.createHash('sha256').update(JSON.stringify({
          group: event.group_id, user: event.user_id, text, at,
        })).digest('hex').slice(0, 24);
    if (this.seen.has(id)) return;
    this.seen.set(id, Date.now());
    for (const [key, timestamp] of this.seen) if (Date.now() - timestamp > 300000) this.seen.delete(key);
    const normalized = {
      id,
      source: 'qq',
      type: 'app.qq.message',
      messageType: event.message_type || 'unknown',
      groupId: event.group_id || null,
      userId: event.user_id || null,
      selfId: event.self_id || null,
      from: event.user_id === event.self_id ? 'dafeiyu' : 'viewer',
      text,
      at,
      connectionId: this.connectionId,
    };
    const context = this.policy.fromOneBot(event, this.connectionId);
    const decision = this.policy.evaluateInput(context);
    Object.assign(normalized, context, {
      allowedToRespond: decision.shouldRespond,
      decisionReason: decision.reason,
      memoryScope: decision.memoryScope,
    });
    this.recent.push(normalized);
    this.recent = this.recent.slice(-50);
    if (normalized.from === 'dafeiyu') return;
    if (this.pending.length >= this.maxQueue) {
      this.deadLetter.push({ event: normalized, reason: 'queue_full', at: Date.now() });
      this.deadLetter = this.deadLetter.slice(-50);
      return;
    }
    this.pending.push(normalized);
    this.onEvent(normalized);
  }

  checkHealth() {
    if (this.stopped) return;
    const now = Date.now();
    if (this.state === 'connecting' && now - this.connectStartedAt > this.connectTimeoutMs) {
      this.lastError = 'connect timeout';
      try { this.ws?.terminate(); } catch {}
      this._scheduleRetry();
      return;
    }
    if (this.state === 'ready' && now - this.lastMessageAt > this.idleTimeoutMs) {
      this.lastError = 'heartbeat timeout';
      try { this.ws?.terminate(); } catch {}
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
      state: this.state,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      lastOpenAt: this.lastOpenAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      connectionId: this.connectionId,
      pending: this.pending.length,
      deadLetter: this.deadLetter.length,
    };
  }
}

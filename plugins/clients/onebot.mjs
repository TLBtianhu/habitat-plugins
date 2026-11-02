// OneBot 客户端：独立协议后端，不注入、不开 QQ 窗口
import WebSocket from 'ws';

export class OneBotClient {
  constructor({ httpUrl, accessToken = '', onEvent = null } = {}) {
    this.httpUrl = httpUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.onEvent = onEvent;
    this.ws = null;
  }

  async _get(path) {
    const r = await fetch(this.httpUrl + path, {
      headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (data.status !== 'ok' && data.retcode !== 0) throw new Error(data.message || 'OneBot error');
    return data.data;
  }

  async _post(path, body) {
    const r = await fetch(this.httpUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (data.status !== 'ok' && data.retcode !== 0) throw new Error(data.message || 'OneBot error');
    return data.data;
  }

  getLoginInfo() { return this._get('/get_login_info'); }
  getMsg(messageId) { return this._get('/get_msg?message_id=' + encodeURIComponent(Number(messageId))); }
  getGroupMsgHistory(groupId, count = 50) { return this._post('/get_group_msg_history', { group_id: groupId, count }); }
  sendGroupMsg(groupId, text) { return this._post('/send_group_msg', { group_id: groupId, message: text }); }
  sendPrivateMsg(userId, text) { return this._post('/send_private_msg', { user_id: userId, message: text }); }

  connectEventWs(wsUrl) {
    this.ws = new WebSocket(wsUrl, {
      headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
    });
    this.ws.addEventListener('message', (ev) => {
      try { this.onEvent?.(JSON.parse(ev.data)); } catch {}
    });
    return this.ws;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try { ws.close(); } catch {}
    setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
  }
}

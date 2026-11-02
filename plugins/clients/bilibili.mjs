// B 站 API 客户端：公开接口读取视频/直播间信息，弹幕走 WebSocket
export class BilibiliClient {
  constructor({ sessdata = '', cookie = '', onDanmaku = null, apiBase = 'https://api.bilibili.com', liveApiBase = 'https://api.live.bilibili.com' } = {}) {
    this.sessdata = sessdata;
    this.cookie = cookie;
    this.onDanmaku = onDanmaku;
    this.apiBase = apiBase;
    this.liveApiBase = liveApiBase;
    this.ws = null;
  }

  async _get(url) {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        referer: 'https://live.bilibili.com/',
        origin: 'https://live.bilibili.com',
        cookie: this.cookie || (this.sessdata ? `SESSDATA=${this.sessdata}` : 'buvid3=habitat-demo'),
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    if (data.code !== 0) throw new Error(data.message || 'Bilibili API error');
    return data.data;
  }

  getVideoInfo(bvid) { return this._get(`${this.apiBase}/x/web-interface/view?bvid=${bvid}`); }
  getRoomInfo(roomId) { return this._get(`${this.liveApiBase}/room/v1/Room/get_info?room_id=${roomId}`); }
  getDanmuInfo(roomId) { return this._get(`${this.liveApiBase}/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0`); }

  connectDanmaku(roomId) {
    // 弹幕协议交给独立实现；这里只负责事件出口，不把直播画面当感知
    const url = `wss://broadcastlv.chat.bilibili.com:443/sub`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      // 真实实现需发送进房包；此处保持协议适配边界
      this.onDanmaku?.({ type: 'open', roomId });
    });
    this.ws.addEventListener('message', (ev) => {
      try { this.onDanmaku?.(JSON.parse(ev.data)); } catch {}
    });
    this.ws.addEventListener('close', () => this.onDanmaku?.({ type: 'close', roomId }));
    return this.ws;
  }

  close() { this.ws?.close(); }
}

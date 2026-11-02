// B站直播弹幕协议客户端：WBI 签名 + 官方 WebSocket + brotli 解包
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { getWbiKeys, signWbi } from './bilibili-wbi.mjs';

export class BiliDanmakuClient {
  constructor({ roomId, cookie, onEvent = () => {} }) {
    this.roomId = Number(roomId);
    this.cookie = cookie;
    this.onEvent = onEvent;
    this.ws = null;
    this.heartbeat = null;
  }

  async connect() {
    const mixin = await getWbiKeys(this.cookie);
    const params = signWbi({ id: this.roomId, type: 0, web_location: '444.8' }, mixin);
    const qs = new URLSearchParams(params).toString();
    const conf = await (await fetch('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' + qs, {
      headers: {
        cookie: this.cookie,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        referer: `https://live.bilibili.com/${this.roomId}`,
      },
    })).json();
    if (conf.code !== 0) throw new Error(conf.message || 'getDanmuInfo failed');
    const host = conf.data.host_list[0];
    const uid = Number(/DedeUserID=(\d+)/.exec(this.cookie)?.[1] || 0);
    const buvid = /buvid3=([^;]+)/.exec(this.cookie)?.[1] || '';
    this.ws = new WebSocket(`wss://${host.host}:${host.wss_port || 443}/sub`);
    this.ws.addEventListener('open', () => {
      this.ws.send(this.packet({ uid, roomid: this.roomId, protover: 3, platform: 'web', type: 2, key: conf.data.token, buvid }));
    });
    this.ws.addEventListener('message', async (ev) => {
      this.onEvent({ type: 'activity', at: Date.now() });
      const buf = Buffer.from(ev.data);
      this.decode(buf);
    });
    this.ws.addEventListener('close', () => {
      clearInterval(this.heartbeat);
      this.onEvent({ type: 'close', roomId: this.roomId });
    });
    this.ws.addEventListener('error', (e) => this.onEvent({ type: 'error', error: String(e) }));
  }

  packet(obj, op = 7, ver = 1) {
    const body = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(16);
    h.writeUInt32BE(16 + body.length, 0);
    h.writeUInt16BE(16, 4);
    h.writeUInt16BE(ver, 6);
    h.writeUInt32BE(op, 8);
    h.writeUInt32BE(1, 12);
    return Buffer.concat([h, body]);
  }

  decode(buf) {
    const ver = buf.readUInt16BE(6);
    const op = buf.readUInt32BE(8);
    if (op === 8) {
      try {
        const j = JSON.parse(buf.subarray(16).toString('utf8'));
        if (j.code === 0) {
          this.onEvent({ type: 'open', roomId: this.roomId });
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (this.ws?.readyState === 1) this.ws.send(this.packet({}, 2, 1));
          }, 30000);
        }
      } catch {}
      return;
    }
    if (op !== 5) return;
    let out = buf.subarray(16);
    if (ver === 3) {
      try { out = zlib.brotliDecompressSync(out); } catch { return; }
    } else if (ver === 2) {
      try { out = zlib.inflateSync(out); } catch { return; }
    }
    let off = 0;
    while (off + 16 <= out.length) {
      const len = out.readUInt32BE(off);
      const hop = out.readUInt16BE(off + 4);
      const nop = out.readUInt32BE(off + 8);
      if (len < 16 || off + len > out.length) break;
      const body = out.subarray(off + hop, off + len);
      if (nop === 5) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          if (j.cmd?.includes('DANMU_MSG')) this.onEvent({ type: 'danmaku', text: j.info?.[1], user: j.info?.[2]?.[1] });
          else if (j.cmd === 'SEND_GIFT') this.onEvent({ type: 'gift', name: j.data?.giftName, user: j.data?.uname });
          else if (j.cmd === 'INTERACT_WORD_V2') this.onEvent({ type: 'enter', user: j.data?.uname });
        } catch {}
      }
      off += len;
    }
  }

  close() {
    clearInterval(this.heartbeat);
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(); } catch {}
    // 关闭握手有界等待；异常网络下也必须真正释放进程。
    setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
  }
}

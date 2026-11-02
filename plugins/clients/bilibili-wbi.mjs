// B站 WBI 签名：从 nav 取 img_key/sub_key，按官方混排表生成 w_rid
import crypto from 'node:crypto';

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

export async function getWbiKeys(cookie) {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { cookie, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
  });
  const d = await r.json();
  const img = d.data?.wbi_img?.img_url || '';
  const sub = d.data?.wbi_img?.sub_url || '';
  const key = (u) => u.split('/').pop().split('.')[0];
  const orig = key(img) + key(sub);
  const mixin = MIXIN.map((i) => orig[i] || '').join('').slice(0, 32);
  return mixin;
}

export function signWbi(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all).sort().map((k) => {
    const v = String(all[k]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...all, w_rid };
}

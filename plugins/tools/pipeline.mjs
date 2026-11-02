// HLS/RTMP Outlet：只订阅 Desktop Compositor 的合成帧并编码，不再渲染桌面。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DESKTOP = process.env.FB_DESKTOP_URL || 'http://127.0.0.1:9260';
const AUDIO = process.env.FB_AUDIO_URL || '';
const AGENT_TOKEN = process.env.HABITAT_AGENT_TOKEN || (() => {
  try { return fs.readFileSync(process.env.HABITAT_AGENT_TOKEN_FILE || '/etc/habitat/agent.token', 'utf8').trim(); } catch { return ''; }
})();
const OUT = process.env.FB_OUT || '/var/lib/habitat/artifacts/live.mp4';
const RTMP = process.env.FB_RTMP || '';
const HLS = process.env.FB_HLS === '1';
const HLS_DIR = process.env.FB_HLS_DIR || '/var/lib/habitat/hls';
const FPS = Number(process.env.FB_FPS || 5);
const ART = process.env.FB_ART || '/var/lib/habitat/artifacts';
const STATUS = path.join(ART, 'pipeline.json');
if (HLS) fs.mkdirSync(HLS_DIR, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), '[outlet]', ...a);
function redactSecret(text) {
  // FFmpeg 网络错误可能带完整推流地址；日志里一律去掉 RTMP URL。
  return String(text).replace(/rtmps?:\/\/\S+/gi, '[rtmp-target]');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let captureId = null;
let captureToken = null;
let connecting = false;
let latest = null;
let latestSeq = 0;
let latestAt = 0;
let framesOut = 0;
let shuttingDown = false;

async function openCapture() {
  if (captureId || connecting || shuttingDown) return;
  connecting = true;
  try {
    const r = await fetch(`${DESKTOP}/capture/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({
        schemaVersion: 1,
        consumer: RTMP ? 'rtmp' : (HLS ? 'hls' : 'file'),
        consumerApp: 'live',
        source: { kind: 'display', id: 'main' },
        excludeSurfaces: ['live'],
        fps: FPS,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    captureId = data.id;
    captureToken = data.captureToken;
    latest = null;
    latestSeq = 0;
    latestAt = 0;
    log('capture open', captureId);
  } catch (e) {
    log('capture open failed', e.message);
    await sleep(2000);
  } finally {
    connecting = false;
  }
}

async function closeCapture() {
  if (!captureId) return;
  const id = captureId;
  const token = captureToken;
  captureId = null;
  captureToken = null;
  try {
    await fetch(`${DESKTOP}/capture/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

async function pollFrame() {
  if (!captureId || shuttingDown) { await openCapture(); return; }
  try {
    const r = await fetch(`${DESKTOP}/capture/frame?id=${encodeURIComponent(captureId)}`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${captureToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (r.status === 202) return;
    if ([403, 404, 410].includes(r.status)) { captureId = null; captureToken = null; latest = null; return; }
    if (r.status === 409) { latest = null; latestAt = 0; return; }
    if (!r.ok) throw new Error(`frame HTTP ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    const seq = Number(r.headers.get('x-frame-seq') || latestSeq + 1);
    if (seq < latestSeq) return;
    latestSeq = seq;
    latestAt = Number(r.headers.get('x-frame-at') || Date.now());
    latest = data;
  } catch (e) {
    log('frame pull failed', e.message);
    await sleep(500);
  }
}

let audioCaptureId = null;
async function openAudioCapture() {
  if (!AUDIO) return;
  for (let attempt = 0; attempt < 10 && !shuttingDown; attempt++) {
    try {
      const r = await fetch(`${AUDIO}/capture/open`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      audioCaptureId = data.id;
      log('audio capture open', audioCaptureId);
      return;
    } catch (e) {
      log('audio capture open failed', e.message);
      await sleep(1000);
    }
  }
}
await openAudioCapture();
async function closeAudioCapture() {
  if (!audioCaptureId) return;
  const id = audioCaptureId;
  audioCaptureId = null;
  try {
    await fetch(`${AUDIO}/capture/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

const ffVideoCodec = process.env.FB_GPU_ENCODER === 'nvenc'
  ? 'h264_nvenc'
  : process.env.FB_GPU_ENCODER === 'vaapi'
  ? 'h264_vaapi'
  : 'libx264';
const ffPreset = ffVideoCodec === 'libx264' ? ['-preset', 'veryfast'] : [];
const ffTune = ffVideoCodec === 'libx264' ? ['-tune', 'zerolatency'] : [];
const input = ['-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(FPS), '-i', '-'];
const audioInput = audioCaptureId
  ? ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', `${AUDIO}/capture/pcm?id=${encodeURIComponent(audioCaptureId)}`]
  : [];
const inputs = [...input, ...audioInput];
const maps = ['-map', '0:v:0', ...(audioCaptureId ? ['-map', '1:a:0'] : [])];
const audioCodec = audioCaptureId ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : [];
const ffArgs = RTMP
  ? ['-y', '-loglevel', 'error', ...inputs,
     '-c:v', ffVideoCodec, ...ffPreset, ...ffTune, ...maps, ...audioCodec, '-pix_fmt', 'yuv420p',
     '-g', String(Math.max(2, Math.round(FPS * 2))), '-b:v', process.env.FB_BITRATE || '3500k', '-f', 'flv', RTMP]
  : HLS
  ? ['-y', '-loglevel', 'error', ...inputs,
     '-c:v', ffVideoCodec, ...ffPreset, ...ffTune, ...maps, ...audioCodec, '-pix_fmt', 'yuv420p',
     '-g', String(Math.max(2, Math.round(FPS * 2))), '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
     '-hls_flags', 'delete_segments', path.join(HLS_DIR, 'live.m3u8')]
  : ['-y', '-loglevel', 'error', ...inputs,
     '-c:v', ffVideoCodec, ...ffPreset, ...ffTune, ...maps, ...audioCodec, '-pix_fmt', 'yuv420p', '-crf', '26',
     '-movflags', '+faststart', OUT];

const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
let ffErrorTail = '';
ff.stderr.on('data', (chunk) => {
  const lines = (ffErrorTail + chunk.toString()).split(/\r?\n/);
  ffErrorTail = lines.pop() || '';
  for (const line of lines) if (line.trim()) console.error(new Date().toISOString(), '[ffmpeg]', redactSecret(line));
});
ff.stdin.on('error', () => {});
ff.on('exit', (code) => { if (!shuttingDown) { log('ffmpeg exited', code); shutdown(1); } });

setInterval(() => {
  if (!ff.stdin.writable || !latest) return;
  if (Date.now() - latestAt > 3000) return;
  try { ff.stdin.write(latest); framesOut += 1; } catch {}
}, Math.round(1000 / FPS));
setInterval(pollFrame, Math.max(50, Math.round(1000 / FPS)));
setInterval(() => {
  fs.writeFileSync(STATUS, JSON.stringify({
    at: Date.now(),
    out: RTMP ? 'rtmp' : (HLS ? 'hls:' + path.join(HLS_DIR, 'live.m3u8') : OUT),
    captureId,
    audioCaptureId,
    fpsTarget: FPS,
    framesOut,
    frameSeq: latestSeq,
    frameAgeMs: latestAt ? Date.now() - latestAt : null,
  }, null, 2));
}, 1000);

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeCapture();
  await closeAudioCapture();
  try { ff.stdin.end(); } catch {}
  setTimeout(() => process.exit(exitCode), 300).unref();
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
log('outlet up; waiting for desktop capture');
openCapture();

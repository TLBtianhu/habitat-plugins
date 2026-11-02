#!/usr/bin/env bash
# HLS Outlet 插件：从 Core Desktop/Audio 拉取合成内容，不拥有桌面或语音实现。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ROOT="${HABITAT_RUNTIME_ROOT:-/opt/habitat/runtime}"
DATA_ROOT="${HABITAT_DATA_DIR:-/var/lib/habitat}"
export PATH="$RUNTIME_ROOT/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}"
export FB_GPU_ENCODER="${FB_GPU_ENCODER:-cpu}"
export FB_DESKTOP_URL="${FB_DESKTOP_URL:-http://127.0.0.1:9260}"
export FB_AUDIO_URL="${FB_AUDIO_URL:-http://127.0.0.1:9271}"
export FB_ART="$DATA_ROOT/artifacts"
export FB_HLS=1
export FB_HLS_DIR="$DATA_ROOT/hls"
mkdir -p "$FB_ART" "$FB_HLS_DIR" "$DATA_ROOT/logs"
# HLS 是本次播出的运行时产物；启动前清掉上次残留，绝不回放旧直播。
rm -f -- "$FB_HLS_DIR/live.m3u8" "$FB_HLS_DIR"/live*.ts
cd "$APP_ROOT"
exec node tools/pipeline.mjs >>"$DATA_ROOT/logs/pipeline.log" 2>&1

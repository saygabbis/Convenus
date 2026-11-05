#!/usr/bin/env bash
# Instala tudo que o GabbisConvert precisa, sem mexer na rede do sistema.
#   - ffmpeg (apt, precisa de sudo)
#   - yt-dlp, wgcf e wireproxy em ~/.local/bin
#   - bgutil PO token provider em ./pot-provider + plugin do yt-dlp
#   - conta Cloudflare WARP grátis em ./warp (proxy SOCKS só pro yt-dlp)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BIN=$HOME/.local/bin
mkdir -p "$BIN"

latest_asset() { # repo, trecho do nome
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" |
    python3 -c "import sys,json;print([a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if '$2' in a['name']][0])"
}

command -v ffmpeg >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg

if [ ! -x "$BIN/yt-dlp" ]; then
  curl -fsSL -o "$BIN/yt-dlp" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  chmod +x "$BIN/yt-dlp"
fi
[ -x "$BIN/wgcf" ] || { curl -fsSL -o "$BIN/wgcf" "$(latest_asset ViRb3/wgcf linux_amd64)"; chmod +x "$BIN/wgcf"; }
[ -x "$BIN/wireproxy" ] || curl -fsSL "$(latest_asset windtf/wireproxy linux_amd64)" | tar xz -C "$BIN" wireproxy

# PO token provider (ajuda o YouTube a não pedir "confirme que não é um robô")
if [ ! -d pot-provider ]; then
  git clone -q --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git pot-provider
fi
(cd pot-provider/server && npm ci --silent && npx tsc)
mkdir -p "$HOME/.config/yt-dlp/plugins/bgutil"
rm -rf "$HOME/.config/yt-dlp/plugins/bgutil/yt_dlp_plugins"
cp -r pot-provider/plugin/yt_dlp_plugins "$HOME/.config/yt-dlp/plugins/bgutil/"

# WARP: o IP da VPS é de datacenter e o YouTube bloqueia; pelo WARP passa.
mkdir -p warp && chmod 700 warp
if [ ! -f warp/wireproxy.conf ]; then
  (cd warp && "$BIN/wgcf" register --accept-tos && "$BIN/wgcf" generate)
  { cat warp/wgcf-profile.conf; printf '\n[Socks5]\nBindAddress = 127.0.0.1:40000\n'; } > warp/wireproxy.conf
  chmod 600 warp/*
fi

echo "Pronto. Rode: npm run start:vps"

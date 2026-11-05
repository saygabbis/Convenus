#!/usr/bin/env bash
# Sobe WARP (SOCKS 127.0.0.1:40000), PO token provider (127.0.0.1:4416) e o site (127.0.0.1:5180).
# Cada um reinicia sozinho se cair. Ctrl+C derruba tudo.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BIN=$HOME/.local/bin
mkdir -p logs

supervise() { # nome, comando...
  local name=$1; shift
  while true; do
    echo "[$(date -u +%FT%TZ)] iniciando $name" >> "logs/$name.log"
    "$@" >> "logs/$name.log" 2>&1
    echo "[$(date -u +%FT%TZ)] $name saiu ($?), reiniciando em 3s" >> "logs/$name.log"
    sleep 3
  done
}

pids=()
cleanup() {
  for p in "${pids[@]}"; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done
  exit 0
}
trap cleanup INT TERM

echo "Atualizando yt-dlp…"
"$BIN/yt-dlp" -U 2>&1 | tail -1

supervise warp "$BIN/wireproxy" -c warp/wireproxy.conf & pids+=($!)
supervise pot node pot-provider/server/build/main.js & pids+=($!)

# Atualiza o yt-dlp a cada 12h (o YouTube muda direto e quebra ele).
( while true; do sleep 43200; "$BIN/yt-dlp" -U >> logs/update.log 2>&1; done ) & pids+=($!)

while true; do
  node server.js 2>&1 | tee -a logs/site.log
  echo "site saiu, reiniciando em 3s"
  sleep 3
done &
pids+=($!)
wait

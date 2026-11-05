#!/usr/bin/env bash
# Modo "screen" (o de sempre): sobe WARP (SOCKS 127.0.0.1:40000), PO token provider (127.0.0.1:4416)
# e o site (127.0.0.1:5180). Cada um reinicia sozinho se cair. Ctrl+C derruba tudo de forma
# graciosa: o site devolve as tarefas em andamento pra fila e elas continuam no próximo start.
#
# Quando os serviços systemd estiverem instalados (deploy/systemd), use eles no lugar deste script.
set -uo pipefail
cd "$(dirname "$0")/.."
BIN=$HOME/.local/bin
export PATH="$BIN:$PATH"
mkdir -p logs

# Rotação simples: passou de 10 MB, guarda um .1 e começa de novo.
rotate() {
  local f="logs/$1.log"
  if [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 10485760 ]; then mv -f "$f" "$f.1"; fi
}

supervise() { # nome, comando...
  local name=$1; shift
  local fails=0
  while true; do
    rotate "$name"
    echo "[$(date -u +%FT%TZ)] iniciando $name" >> "logs/$name.log"
    local started=$SECONDS
    "$@" >> "logs/$name.log" 2>&1
    local code=$?
    # Caiu logo de cara várias vezes: espera mais pra não ficar em loop apertado.
    if (( SECONDS - started < 30 )); then fails=$((fails + 1)); else fails=0; fi
    local wait=$(( fails > 5 ? 60 : 3 ))
    echo "[$(date -u +%FT%TZ)] $name saiu ($code), reiniciando em ${wait}s" >> "logs/$name.log"
    sleep "$wait"
  done
}

pids=()
site_pid=
stopping=0
cleanup() {
  stopping=1
  # O site primeiro, com SIGTERM: ele salva as tarefas e encerra os downloads em ordem.
  if [ -n "$site_pid" ] && kill -0 "$site_pid" 2>/dev/null; then
    kill -TERM "$site_pid" 2>/dev/null
    for _ in $(seq 1 15); do kill -0 "$site_pid" 2>/dev/null || break; sleep 1; done
  fi
  for p in "${pids[@]}"; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done
  exit 0
}
trap cleanup INT TERM

# -s: sem o log DEBUG de cada pacote (crescia ~150 KB por dia).
supervise warp "$BIN/wireproxy" -s -c warp/wireproxy.conf & pids+=($!)
supervise pot node pot-provider/server/build/main.js & pids+=($!)

# yt-dlp: atualização segura (testa antes, espera a fila, volta a anterior se falhar), a cada 12 h.
( while true; do bash scripts/update-ytdlp.sh >> logs/update.log 2>&1; sleep 43200; done ) & pids+=($!)

while [ $stopping = 0 ]; do
  rotate site
  node --disable-warning=ExperimentalWarning server.js >> logs/site.log 2>&1 &
  site_pid=$!
  wait "$site_pid"
  [ $stopping = 1 ] && break
  echo "[$(date -u +%FT%TZ)] site saiu, reiniciando em 3s" >> logs/site.log
  sleep 3
done

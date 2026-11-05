#!/usr/bin/env bash
# Atualização segura do yt-dlp (substitui o "yt-dlp -U" direto em produção):
#   1. vê se tem versão nova;
#   2. baixa pra um arquivo à parte e testa (versão + extração simples, SEM cookies);
#   3. só troca quando não há tarefa rodando; guarda a anterior em yt-dlp.prev;
#   4. troca de forma atômica (mv) e testa de novo; se falhar, volta a anterior.
# Tarefas em andamento não são afetadas: o processo que já rodava continua com o arquivo antigo.
#
# Uso: scripts/update-ytdlp.sh [--check] [--force]
#   --check  só diz se tem atualização
#   --force  não espera a fila esvaziar
set -uo pipefail

BIN=${YTDLP:-$HOME/.local/bin/yt-dlp}
PORT=${PORT:-5180}
CHECK=0
FORCE=0
for a in "$@"; do
  case $a in --check) CHECK=1 ;; --force) FORCE=1 ;; esac
done
# Link público e estável (sem cookies, sem login) pra provar que a extração funciona.
TEST_URL=${YTDLP_TEST_URL:-https://soundcloud.com/forss/flickermood}

log() { echo "[$(date -u +%FT%TZ)] $*"; }

smoke() { # binário
  "$1" --version >/dev/null 2>&1 || return 1
  timeout 90 "$1" --no-warnings --no-playlist --simulate --print title -- "$TEST_URL" >/dev/null 2>&1
}

current=$("$BIN" --version 2>/dev/null || echo "nenhuma")
latest=$(curl -fsSL --max-time 20 https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null) || {
  log "não consegui ver a última versão (GitHub fora?)"
  exit 1
}
if [ "$current" = "$latest" ]; then
  log "yt-dlp já está na última versão ($current)"
  exit 0
fi
log "yt-dlp: instalada $current, disponível $latest"
[ $CHECK = 1 ] && exit 0

new="$BIN.new"
curl -fsSL --max-time 120 -o "$new" "https://github.com/yt-dlp/yt-dlp/releases/download/$latest/yt-dlp" || {
  log "download falhou"
  rm -f "$new"
  exit 1
}
chmod +x "$new"
if [ "$("$new" --version 2>/dev/null)" != "$latest" ] || ! smoke "$new"; then
  log "a versão nova não passou no teste; mantendo $current"
  rm -f "$new"
  exit 1
fi

# Espera a fila esvaziar (até 30 min). A checagem detalhada do /health só responde pra localhost.
if [ $FORCE = 0 ]; then
  for _ in $(seq 1 60); do
    busy=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null \
      | python3 -c 'import sys,json; q=json.load(sys.stdin).get("queue",{}); print(q.get("running",0)+q.get("queued",0))' 2>/dev/null || echo 0)
    [ "$busy" = "0" ] && break
    log "esperando $busy tarefa(s) terminarem…"
    sleep 30
  done
fi

[ -x "$BIN" ] && cp -p "$BIN" "$BIN.prev"
mv -f "$new" "$BIN"
if smoke "$BIN"; then
  log "atualizado: $current → $latest (anterior guardada em $BIN.prev)"
  exit 0
fi
log "a versão nova falhou depois da troca; voltando pra $current"
[ -x "$BIN.prev" ] && mv -f "$BIN.prev" "$BIN"
exit 1

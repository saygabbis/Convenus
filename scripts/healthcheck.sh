#!/usr/bin/env bash
# Verifica o site local. Se falhar 3 vezes seguidas, reinicia o serviço systemd.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${ROOT}/data"
mkdir -p "$STATE_DIR" "$ROOT/logs"
FAIL_FILE="$STATE_DIR/health.fails"
LOG="$ROOT/logs/healthcheck.log"
URL="${CONVENUS_HEALTH_URL:-http://127.0.0.1:5180/health}"

ts() { date -u +%FT%TZ; }

code=$(curl -fsS -o /tmp/convenus-health.json -w '%{http_code}' --max-time 5 "$URL" || echo 000)
ok=0
if [ "$code" = "200" ] && grep -q '"ok":true' /tmp/convenus-health.json 2>/dev/null; then
  ok=1
fi

if [ "$ok" = "1" ]; then
  echo 0 > "$FAIL_FILE"
  exit 0
fi

fails=0
[ -f "$FAIL_FILE" ] && fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$FAIL_FILE"
echo "[$(ts)] health falhou (http=$code) tentativa=$fails" >> "$LOG"

if [ "$fails" -ge 3 ]; then
  echo "[$(ts)] reiniciando convenus.service após $fails falhas" >> "$LOG"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart convenus.service >> "$LOG" 2>&1 || true
  fi
  echo 0 > "$FAIL_FILE"
fi
exit 1

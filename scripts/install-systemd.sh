#!/usr/bin/env bash
# Instala os serviços systemd do Convenus (troca o modo "screen" por serviços que sobem sozinhos
# quando a VPS liga). Precisa de sudo. Rode a partir da pasta do projeto:
#   bash scripts/install-systemd.sh          instala e liga
#   bash scripts/install-systemd.sh --remove desliga e remove (volta pro modo screen)
set -euo pipefail
cd "$(dirname "$0")/.."
UNITS=(convenus-warp.service convenus-pot.service convenus.service convenus-ytdlp-update.service convenus-ytdlp-update.timer)

if [ "${1:-}" = "--remove" ]; then
  sudo systemctl disable --now convenus.service convenus-ytdlp-update.timer convenus-pot.service convenus-warp.service || true
  for u in "${UNITS[@]}"; do sudo rm -f "/etc/systemd/system/$u"; done
  sudo systemctl daemon-reload
  echo "Serviços removidos. Pra voltar ao modo screen: screen -dmS Convert bash -c 'npm run start:vps; exec bash'"
  exit 0
fi

if screen -ls 2>/dev/null | grep -q '\.Convert\s'; then
  echo "A screen 'Convert' ainda está rodando (mesma porta). Pare ela antes:"
  echo "  screen -S Convert -X stuff \$'\\003'   # Ctrl+C gracioso; espere sair e então:"
  echo "  screen -S Convert -X quit"
  exit 1
fi

for u in "${UNITS[@]}"; do sudo install -m 644 "deploy/systemd/$u" "/etc/systemd/system/$u"; done
sudo systemctl daemon-reload
sudo systemctl enable --now convenus-warp.service convenus-pot.service convenus.service convenus-ytdlp-update.timer
sleep 3
systemctl --no-pager --lines=0 status convenus-warp convenus-pot convenus || true
curl -fsS http://127.0.0.1:5180/health >/dev/null && echo "Convenus no ar." || echo "O site ainda não respondeu: veja 'journalctl -u convenus -n 50'."

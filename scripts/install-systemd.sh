#!/usr/bin/env bash
# Instala unidades systemd do Convenus. Rode na VPS com o path real do projeto.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
UNIT_DIR=/etc/systemd/system

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash scripts/install-systemd.sh"
  exit 1
fi

mkdir -p "$ROOT/logs" "$ROOT/data"
chmod 700 "$ROOT/data"
chmod +x "$ROOT/scripts/healthcheck.sh"

for f in convenus.service convenus-warp.service convenus-pot.service \
         convenus-ytdlp-update.service convenus-ytdlp-update.timer \
         convenus-healthcheck.service convenus-healthcheck.timer; do
  sed -e "s|/opt/convenus|$ROOT|g" -e "s|/home/USER|$HOME_DIR|g" \
    "$ROOT/scripts/systemd/$f" > "$UNIT_DIR/$f"
done

# Usuário do serviço = dono do projeto (não root).
for svc in convenus convenus-warp convenus-pot; do
  if ! grep -q '^User=' "$UNIT_DIR/$svc.service"; then
    sed -i "/^\[Service\]/a User=$USER_NAME\nGroup=$USER_NAME" "$UNIT_DIR/$svc.service"
  fi
done

systemctl daemon-reload
systemctl enable --now convenus-warp.service convenus-pot.service convenus.service
systemctl enable --now convenus-ytdlp-update.timer convenus-healthcheck.timer

echo "Systemd instalado."
echo "Status: systemctl status convenus convenus-warp convenus-pot --no-pager"
echo "Health: curl -s http://127.0.0.1:5180/health"
echo
echo "IMPORTANTE: se ainda usa 'npm run start:vps' em screen/tmux, pare esse processo"
echo "antes de deixar só o systemd no ar (evita dois sites na mesma porta)."

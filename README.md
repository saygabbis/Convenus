# Convenus

YouTube, YouTube Music, Spotify, Deezer, Apple Music, X/Twitter, Instagram, TikTok, Bluesky, Facebook, SoundCloud, Twitch, Vimeo, Pinterest, Tumblr e outros sites que o yt-dlp suporta → **MP4** (até 4K), **MP3** (128–320 kbps) e **WAV**, além de **fotos de posts**, **capas**, **avatares** e **banners**. Sem propaganda, sem pop-up.

Rodando em https://convert.saygabbis.cloud

## Arquitetura

| Camada | Responsável por | Independente do usuário? |
|--------|-----------------|--------------------------|
| Site + API (`server.js`) | Conversões, fila, health | Sim |
| systemd (WARP, PO token, site, timers) | 24/7, restart, healthcheck | Sim |
| PWA (`public/sw.js`) | App no celular / share target | N/A (cliente) |
| Extensão `extension/` | Monitoramento + auth admin + renovação consentida | **Não** sobe o site |

A extensão **não** mantém o site no ar. Quedas recorrentes vinham de processo sem supervisor forte, cookies do YouTube expirando e dependências (yt-dlp / WARP / PO token).

## Como funciona

- `server.js`: Node sem dependências npm; chama yt-dlp + ffmpeg; fila; timeouts de job; logs JSON; auth admin por dispositivo.
- `lib/`: logger, retry com backoff, auth (access/refresh/rotação/revogação), health profundo.
- `providers.js`: metadados por APIs públicas (X, Bluesky, Instagram, TikTok, etc.).
- `public/`: site + PWA + `/renovar` (admin mobile-friendly).
- `extension/`: extensão privada Chromium MV3.
- `scripts/systemd/`: unidades para VPS Ubuntu 24.04.

## Rodar

```bash
npm run setup           # ffmpeg, yt-dlp, wireproxy, WARP, PO token
npm start               # só o site (dev)
npm run start:vps       # supervisor shell (legado)
sudo npm run install:systemd   # recomendado na VPS (restart + boot + health)
npm test
```

Health: `curl http://127.0.0.1:5180/health`  
Health admin (Bearer): `GET /api/admin/health` ou `GET /health?deep=1`

Cookies: `cookies.txt` (Netscape, conta Google **descartável**) na raiz, `chmod 600`. Nunca vai pro git.

Variáveis: `PORT` (5180), `HOST`, `SITE_ORIGIN`, `YTDLP_COOKIES`, `YTDLP_PROXY` (vazio = sem proxy), `MAX_RUNNING`, `JOB_TTL_MIN`, `JOB_TIMEOUT_MIN` (45), `INFO_TIMEOUT_SEC` (90), `ADMIN_ACCESS_TTL_MIN`, `ADMIN_REFRESH_TTL_DAYS`.

## Autenticação administrativa

1. Segredo de enrollment: arquivo `admin.token` no servidor (gerado na 1ª subida; só SSH).
2. `POST /api/admin/login` com esse código → access token (curto) + refresh token (rotativo).
3. Dispositivos em `data/devices.json`; revogação imediata via `POST /api/admin/revoke`.
4. `/api/cookies` aceita `Authorization: Bearer …` **ou** o bootstrap `admin.token` (emergência).
5. UI: `/renovar` (PWA/mobile) e extensão desktop.

**Nunca** coloque `admin.token`, refresh tokens ou `data/auth.secret` no frontend versionado ou no git.

## Extensão

Veja [extension/README.md](extension/README.md).

## Mobile / PWA

- Manifest + ícones + `share_target` já existiam.
- Service worker `sw.js`: shell offline, APIs sempre na rede.
- No Android/iOS: instalar o site como app e usar `/renovar` para admin — **sem** extensão.

## nginx

Proxy de `convert.saygabbis.cloud` → `127.0.0.1:5180` com HTTPS, `proxy_buffering off` e `proxy_read_timeout` alto.

## Deploy na VPS (resumo)

```bash
cd /caminho/do/convenus
git pull
# pare o start-vps antigo (screen/tmux) se ainda estiver rodando
sudo bash scripts/install-systemd.sh
systemctl status convenus convenus-warp convenus-pot --no-pager
curl -s http://127.0.0.1:5180/health
```

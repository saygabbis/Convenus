# GabbisConvert

YouTube → **MP4** (144p até 4K), **MP3** (128–320 kbps) e **WAV**. Sem propaganda, sem pop-up.

Rodando em https://convert.saygabbis.cloud

## Como funciona

- `server.js`: servidor Node sem dependências que chama o [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg, com fila (2 conversões por vez) e progresso.
- `public/`: a página (dá pra instalar como app no celular e usar o "Compartilhar" do YouTube).
- Os arquivos convertidos são apagados depois de 1 hora.
- O YouTube bloqueia IP de datacenter, então o yt-dlp sai pelo **Cloudflare WARP** (via `wireproxy`, um proxy SOCKS local que não mexe na rede do sistema) e usa o [bgutil PO token provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider).

## Rodar

```bash
npm run setup      # instala ffmpeg, yt-dlp, wireproxy, WARP e o PO token provider
npm run start:vps  # sobe tudo (WARP + PO token + site em 127.0.0.1:5180)
```

Logs em `logs/`. Health check: `curl http://127.0.0.1:5180/health`.

Cookies: coloque um `cookies.txt` (formato Netscape, de uma conta Google **descartável**) na raiz do projeto, com `chmod 600`. Ele nunca vai pro git.

Variáveis opcionais: `PORT` (5180), `YTDLP_COOKIES` (`./cookies.txt`), `YTDLP_PROXY` (`socks5://127.0.0.1:40000`; vazio = sem proxy), `MAX_RUNNING` (2), `JOB_TTL_MIN` (60).

## nginx

Proxy de `convert.saygabbis.cloud` → `127.0.0.1:5180` com `proxy_buffering off` e `proxy_read_timeout` alto (arquivos grandes).

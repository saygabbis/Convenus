# Convenus

Baixador privado: YouTube, YouTube Music, Spotify, Deezer, Apple Music, X/Twitter, Instagram, TikTok, Bluesky, Facebook, SoundCloud, Twitch, Vimeo, Pinterest, Tumblr e outros sites que o yt-dlp suporta → **MP4** (até 4K), **MP3** (128–320 kbps), **WAV**, **legendas (.srt ou dentro do MP4)**, **fotos de posts**, **capas**, **avatares** e **banners**. Sem propaganda, sem pop-up.

Rodando em https://convert.saygabbis.cloud (acesso só com código).

## Como funciona

- `server.js`: servidor Node sem dependências externas. Chama o [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg, com fila (2 conversões por vez), progresso e histórico.
- `lib/proc.js`: processos externos com timeout total e de inatividade, saída limitada, kill do grupo inteiro e término único.
- `lib/store.js`: tarefas e histórico em SQLite (`node:sqlite`, embutido no Node 22). Tudo sobrevive a reinícios.
- `lib/auth.js`: acesso privado. Entra com o código do `admin.token` e recebe uma sessão assinada num cookie `HttpOnly`.
- `lib/cookies.js`: cookies do YouTube. A renovação valida num arquivo temporário antes de trocar (de forma atômica) e guarda a versão anterior.
- `lib/health.js`: estado do yt-dlp, ffmpeg, WARP, PO token e disco (`/api/status`).
- `providers.js`: posts e perfis com o arquivo original, por APIs e páginas públicas (X via FxTwitter, Bluesky, Instagram embed, TikTok via TikWM, Vimeo, Pinterest, Tumblr). Spotify, Deezer e Apple Music viram lista de faixas, e o áudio vem da mesma música no YouTube Music.
- `public/`: a página (instalável como app; aceita o "Compartilhar" do celular).

O YouTube bloqueia IP de datacenter. Com a conta logada (`cookies.txt`), o yt-dlp sai direto pelo IP da VPS. Sem login, sai pelo **Cloudflare WARP** (`wireproxy`, proxy SOCKS local) e **sem cookie nenhum**. O [bgutil PO token provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) roda junto.

## Rodar

```bash
npm run setup      # instala ffmpeg, yt-dlp, wireproxy, WARP e o PO token provider
npm run start:vps  # modo screen: WARP + PO token + site em 127.0.0.1:5180
npm test           # testes (unidade + integração com yt-dlp falso, sem rede)
```

Em produção, o recomendado são os serviços systemd de `deploy/systemd/` (veja `docs/IMPLANTACAO.md`).

- **Acesso:** o site é aberto. Só a administração (`/renovar` e `/api/cookies`) pede o código, que fica em `admin.token` (`cat ~/Bots/Convert/admin.token`). Pra trocar o código e deslogar todos os aparelhos: `printf 'novo' > admin.token` e reinicie o site.
- **Histórico por aparelho:** cada navegador ganha um id aleatório no cookie `cv_dev` (HttpOnly) e só vê, baixa e apaga as próprias conversões. Conversão de outro aparelho responde 404.
- **Cookies do YouTube:** pela página `/renovar`, no site. Eles nunca vão pro git.
- **Velocidade:** a busca fica guardada 30 min e o download parte dela (`--load-info-json`, sem cookies), então não extrai tudo de novo nem espera a vez no YouTube. Se o link salvo for recusado, refaz do jeito completo sozinho. Cada busca registra o tempo no log (`[busca] YouTube em X s`). As buscas usam um yt-dlp sempre aberto (`lib/ytdlp_worker.py`, ~1,4 s a menos por busca): um pedido por vez, cookies lidos e gravados a cada pedido como no normal; ocupado, travado ou sem Python, cai pro yt-dlp normal, e recicla sozinho quando o yt-dlp é atualizado. `YTDLP_WORKER=0` desliga.
- **Arquivos:** tudo some 1 h depois de pronto (`JOB_TTL_MIN`): o arquivo em `downloads/` e a linha do histórico. "Limpar" no site apaga na hora. O start **não** apaga nada antes do prazo; a limpeza roda a cada 2 min e nunca toca tarefa ativa.

### Variáveis opcionais

| Variável | Padrão | O que é |
|---|---|---|
| `PORT` / `HOST` | `5180` / `127.0.0.1` | onde o site escuta |
| `DATA_DIR` | pasta do projeto | banco, `admin.token`, cookies, `downloads/` |
| `YTDLP` | `~/.local/bin/yt-dlp` | binário do yt-dlp |
| `YTDLP_PROXY` | `socks5://127.0.0.1:40000` | WARP (vazio = sem proxy) |
| `POT_URL` | `http://127.0.0.1:4416` | PO token provider (só pro status) |
| `MAX_RUNNING` | `2` | conversões ao mesmo tempo |
| `JOB_TTL_MIN` | `60` | minutos até o arquivo pronto e o histórico serem apagados |
| `JOB_TIMEOUT_MIN` / `JOB_IDLE_MIN` | `240` / `10` | tempo máximo de uma tarefa / sem progresso = travada |
| `INFO_TIMEOUT_SEC` | `120` | tempo máximo de uma busca |
| `MIN_FREE_GB` | `2` | abaixo disso, recusa tarefas novas |

### Rotas

Todas são abertas, menos `/renovar` e `/api/cookies` (pedem o código de acesso). `/api/status` sem login só diz `{ok, youtube, admin}`. O `/health` público só diz `{"ok":true}`; o detalhe só aparece pra pedidos feitos de dentro da VPS. Pedidos que mudam estado vindos de outro site (cabeçalho `Origin` diferente) são recusados.

| Rota | O que faz |
|---|---|
| `POST /api/login` / `POST /api/logout` | entra (com limite de tentativas) / sai |
| `POST /api/info` | busca um link (`{url, page}`; playlists vêm em páginas de 200) |
| `GET /api/jobs` | histórico deste aparelho, só da última hora |
| `POST /api/jobs` | cria uma tarefa (`mp4`, `mp3`, `wav`, `srt`; legenda em `subs: {lang, embed}`) |
| `GET /api/jobs/:id`, `DELETE`, `/file` | acompanha, cancela (ativa) ou apaga de vez (terminada), baixa |
| `GET /api/media` | baixa foto/vídeo direto de CDNs permitidos |
| `GET /api/status` | saúde completa pra admin (yt-dlp, ffmpeg, WARP, PO token, disco, fila, login do YouTube) |
| `POST /api/cookies` | renova os cookies do YouTube (valida antes de trocar) |

## yt-dlp

`scripts/update-ytdlp.sh` atualiza com segurança, em vez do `yt-dlp -U` direto em produção:
1. baixa a versão nova à parte e testa num link público, sem cookies;
2. espera a fila esvaziar;
3. guarda a anterior em `yt-dlp.prev` e troca de forma atômica;
4. testa de novo e, se falhar, volta a anterior.

Ele roda a cada 12 h, pelo timer do systemd ou pelo `start-vps.sh`.

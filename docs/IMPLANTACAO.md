# Implantação da versão 1.1 (estabilidade)

Branch: `manutencao-estabilidade`. Nada aqui foi aplicado em produção: este é o passo a passo.

## O que muda pra quem usa

- **Login:** o site passa a pedir o **código de acesso** uma vez por aparelho (o código do `admin.token`). Sem ele, ninguém usa o site, a API nem o proxy de mídia.
- **Arquivos:** prontos ficam **24 h** (antes 1 h) e **não somem mais em reinícios**.
- **Histórico:** vem do servidor, então vale em qualquer aparelho.
- **Legendas:** escolha do idioma, opção de colocar dentro do MP4 ou baixar só a legenda (.srt).
- **Playlists:** não param mais em 200 itens; o botão "Carregar mais" traz de 200 em 200.
- **Página `/renovar`:** não pede mais o código (já precisa estar logada) e **só troca os cookies depois de testar**.

## Antes de começar

1. Confira que não tem conversão rodando (`/api/status` → `queue.running` = 0).
2. Anote o código atual: `cat ~/Bots/Convert/admin.token`. Ele continua valendo, agora como código de login.
3. Requisito: Node **22.5 ou mais novo** (a VPS tem 22.22, ok).

## Passo 1: atualizar o código (mantém o modo screen)

```bash
cd ~/Bots/Convert
git fetch origin
git checkout main
git merge --ff-only origin/manutencao-estabilidade   # ou depois do merge do PR
npm test                                             # tem que dar "fail 0"
```

Reiniciar a screen (graceful: as tarefas em andamento voltam pra fila e continuam depois):

```bash
screen -S Convert -X stuff $'\003'      # Ctrl+C; o site salva as tarefas e sai
# espere uns 15 s e confira que não sobrou: pgrep -af "node.*server.js"
screen -S Convert -X stuff $'npm run start:vps\r'
curl -s http://127.0.0.1:5180/health    # detalhe completo (só de dentro da VPS)
```

O banco `convenus.db` é criado sozinho no primeiro start. Não há migração manual: as tarefas da versão antiga ficavam só na memória e somem no reinício, como sempre aconteceu.

## Passo 2 (recomendado): trocar a screen por serviços systemd

Os serviços sobem sozinhos quando a VPS liga, reiniciam se caírem, mandam os logs pro journald e fazem o encerramento gracioso.

```bash
cd ~/Bots/Convert
screen -S Convert -X stuff $'\003'      # para a screen (Ctrl+C gracioso)
screen -S Convert -X quit
bash scripts/install-systemd.sh         # pede sudo
```

Serviços: `convenus-warp`, `convenus-pot`, `convenus` (site) e o timer `convenus-ytdlp-update`.

```bash
systemctl status convenus convenus-warp convenus-pot
journalctl -u convenus -f               # log do site
systemctl list-timers convenus-ytdlp-update.timer
sudo systemctl restart convenus         # reinício gracioso
```

Configurações opcionais (porta, prazos) vão em `~/Bots/Convert/convenus.env`, no formato `CHAVE=valor`, uma por linha.

Pra voltar ao modo screen: `bash scripts/install-systemd.sh --remove`.

## Rollback do código

```bash
cd ~/Bots/Convert
git checkout <commit anterior>          # ex.: 3212603
# reinicie (screen ou systemctl restart convenus)
```

O `convenus.db` pode ficar: a versão antiga simplesmente ignora o arquivo.

## Pontos que precisam de você

- **Cloudflare/outra autenticação externa:** não há Cloudflare Access configurado (o DNS é da Hostinger e o nginx aponta direto pro Node). O login do próprio Convenus é a proteção. Se um dia colocar o Cloudflare na frente, confirme que ele repassa o `X-Forwarded-Proto: https` (o cookie usa `Secure` com base nisso).
- **nginx:** já manda `X-Real-IP` e o `X-Forwarded-Proto` (que o certbot configura). O limite de tentativas usa o `X-Real-IP`.
- **Cookies do YouTube:** com IP de datacenter, o Google costuma derrubar a sessão em menos de 1 hora; isso não depende do código. A página avisa quando cai.
- **Atualização do yt-dlp:** o script baixa do GitHub. Sem acesso ao GitHub, ele só registra o erro em `logs/update.log` (ou no journald) e mantém a versão atual.

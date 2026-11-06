# Extensão Convenus (privada)

Sincroniza **automaticamente** os cookies do YouTube/Google de quem tiver a extensão instalada → servidor Convenus.

## Conta principal + descartável (Opera GX / Chrome)

**Não existe login isolado dentro da extensão.** No Chromium os cookies do YouTube são do *perfil do navegador*. Se a extensão estiver no mesmo perfil da sua conta pessoal, ela vai sincronizar a conta pessoal.

Setup recomendado no Opera GX:

1. Clique no ícone de **perfil** → **Adicionar** / novo perfil → nomeie `Convenus`.
2. Nesse perfil novo: carregue a pasta `extension/` em `opera://extensions`.
3. Abra o YouTube **só nesse perfil** e entre na **conta descartável**.
4. No perfil normal (conta principal): **não** instale a extensão (ou deixe desligada).

Assim você navega normal no GX principal e o perfil `Convenus` (pode ficar aberto em segundo plano) segura o sync.

## Como usar (você / amg / dev)

1. Copie o config (já existe `config.local.json` na sua máquina; amgs recebem o zip pronto):

```bash
cp extension/config.example.json extension/config.local.json
# edite adminToken = conteúdo de admin.token do servidor
```

2. Chrome/Edge → `chrome://extensions` → Modo desenvolvedor → **Carregar sem compactação** → pasta `extension/`.
3. No **mesmo perfil do navegador**, entre no YouTube com a **conta descartável** (todos devem usar a **mesma** conta).
4. Pronto: a cada ~2 min (e quando o cookie muda) ela manda pro servidor. Sem login na UI.

## Celular

| Plataforma | Como |
|------------|------|
| **Android** | Instale [Kiwi Browser](https://kiwibrowser.com/) → carregue a mesma pasta `extension/` → logue a conta descartável no YouTube do Kiwi. |
| **iPhone** | Safari/Chrome **não** aceitam essa extensão. Use só o site; o PC (ou Kiwi) segura os cookies. |
| **Qualquer um** | O conversor em https://convert.saygabbis.cloud **não pede login** — é público pra usar. |

## Importante

- Repo privado ≠ site privado: **não** coloque `admin.token` no HTML público do site (qualquer visitante baixaria).
- O token fica só em `config.local.json` (gitignored), dentro do zip da extensão que você passa pra amg.
- Várias pessoas com a extensão: todas na **mesma** conta YouTube descartável, senão uma sobrescreve a sessão da outra.
- Extensão **não** evita crash do Node — isso é systemd na VPS. Ela evita o YouTube “cair” por cookie expirado.

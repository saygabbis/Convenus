"""yt-dlp sempre aberto: carrega o yt-dlp uma vez e atende pedidos de busca pelo stdin.

Protocolo (uma linha JSON por mensagem):
  ao subir:   {"ready": true, "version": "..."}  ou  {"ready": false, "error": "..."}
  pedido:     {"id": 1, "argv": ["-J", "--", "https://..."]}
  resposta:   {"id": 1, "code": 0, "stdout": "...", "stderr": "..."}

Cada pedido roda o yt-dlp exatamente como a linha de comando (yt_dlp.main), então cookies,
proxy e o resto se comportam igual: os cookies são lidos no começo e gravados no fim de cada
pedido, como num processo novo. Só se economiza a abertura do Python e o carregamento do yt-dlp.

Uso: python3 ytdlp_worker.py /caminho/do/yt-dlp
"""

import contextlib
import io
import json
import os
import sys
import traceback

# O canal de respostas é uma cópia do stdout original; o fd 1 passa a apontar pro nada, pra
# nenhum processo filho (node do desafio do YouTube, ffmpeg) escrever no meio do protocolo.
proto = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(os.open(os.devnull, os.O_WRONLY), 1)


def send(obj):
    proto.write(json.dumps(obj, ensure_ascii=False) + '\n')
    proto.flush()


try:
    sys.path.insert(0, sys.argv[1])  # o yt-dlp instalado é um zipapp: importa direto dele
    import yt_dlp
    from yt_dlp.version import __version__
except Exception as e:  # noqa: BLE001 - qualquer falha aqui = o servidor usa o modo antigo
    send({'ready': False, 'error': repr(e)})
    sys.exit(1)

send({'ready': True, 'version': __version__})

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            yt_dlp.main(req['argv'])
        except SystemExit as e:
            if e.code is None:
                code = 0
            elif isinstance(e.code, int):
                code = e.code
            else:  # yt-dlp sai com a mensagem de erro como texto
                print(e.code, file=sys.stderr)
                code = 1
        except BaseException:  # noqa: BLE001 - erro inesperado volta como stderr, o processo segue
            traceback.print_exc()
            code = 1
    send({'id': req.get('id'), 'code': code, 'stdout': out.getvalue(), 'stderr': err.getvalue()[-20000:]})

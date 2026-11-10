"""yt-dlp de mentira pros testes do yt-dlp sempre aberto (lib/ytworker.js)."""
import json
import os
import sys
import time


def main(argv):
    if 'boom' in argv:
        sys.exit('ERROR: [fake] falhou de propósito')
    if 'sleep' in argv:
        time.sleep(30)
    if 'crash' in argv:
        os._exit(3)
    print(json.dumps({'argv': argv, 'pid': os.getpid()}))
    sys.exit(0)

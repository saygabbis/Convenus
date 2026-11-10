'use strict';

// yt-dlp sempre aberto (lib/ytdlp_worker.py) pras buscas: economiza a abertura do Python a cada
// chamada. Um pedido por vez; ocupado, travado ou sem Python = quem chamou usa o yt-dlp normal.
// Reinicia sozinho quando o arquivo do yt-dlp muda (atualização) ou depois de muitos pedidos.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'ytdlp_worker.py');

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch { /* já morreu */ }
  }
}

class YtWorker {
  constructor({ ytdlp, python = process.env.PYTHON || 'python3', maxRequests = 300, log = console } = {}) {
    this.ytdlp = ytdlp;
    this.python = python;
    this.maxRequests = maxRequests;
    this.log = log;
    this.child = null;
    this.ready = false;
    this.busy = false;
    this.served = 0;
    this.failures = 0;
    this.nextId = 1;
    this.pending = null;
    this.stopped = false;
  }

  mtime() {
    try {
      return fs.statSync(this.ytdlp).mtimeMs;
    } catch {
      return 0;
    }
  }

  start() {
    if (this.stopped || this.child) return;
    this.ready = false;
    this.served = 0;
    this.binTime = this.mtime();
    let child;
    try {
      // Grupo próprio: matar o grupo leva junto o node do desafio do YouTube que o yt-dlp abriu.
      child = spawn(this.python, ['-u', SCRIPT, this.ytdlp], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch {
      return;
    }
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    child.stderr.on('data', () => {}); // avisos do Python: ignorados (o stderr do yt-dlp vem no protocolo)
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.busy = false;
      this.finish({ code: 1, stdout: '', stderr: '', crashed: true });
      // Caiu: tenta de novo com espera crescente (Python ausente = desiste depois de algumas vezes).
      this.failures++;
      if (!this.stopped && this.failures < 5) setTimeout(() => this.start(), 2000 * this.failures).unref();
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if ('ready' in msg) {
      this.ready = Boolean(msg.ready);
      if (this.ready) {
        this.failures = 0;
        this.log.log(`[yt-dlp] sempre aberto pronto (versão ${msg.version})`);
      } else {
        this.log.error(`[yt-dlp] sempre aberto não subiu: ${msg.error}`);
        this.failures = 99; // não adianta insistir: fica no modo normal
      }
      return;
    }
    if (this.pending && msg.id === this.pending.id) this.finish({ code: msg.code, stdout: msg.stdout || '', stderr: msg.stderr || '' });
  }

  finish(result) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    this.busy = false;
    p.resolve(result);
  }

  /** Livre pra um pedido agora? (Se o yt-dlp foi atualizado, recicla e responde não.) */
  available() {
    if (!this.ready || this.busy || !this.child) return false;
    if (this.mtime() !== this.binTime || this.served >= this.maxRequests) {
      this.restart();
      return false;
    }
    return true;
  }

  /** Roda o yt-dlp com esses argumentos. Mesmo formato de resposta que o proc.run usa. */
  run(argv, { timeoutMs = 120_000 } = {}) {
    this.busy = true;
    this.served++;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Travou: mata o processo (o próximo sobe sozinho) e responde como timeout.
        const p = this.pending;
        this.pending = null;
        this.busy = false;
        this.restart();
        if (p) p.resolve({ code: null, stdout: '', stderr: '', timedOut: true });
      }, timeoutMs);
      this.pending = { id, resolve, timer };
      this.child.stdin.write(`${JSON.stringify({ id, argv })}\n`);
    });
  }

  restart() {
    const c = this.child;
    this.child = null;
    this.ready = false;
    this.failures = 0;
    if (c) {
      c.removeAllListeners('exit');
      c.on('exit', () => {});
      killGroup(c);
    }
    if (!this.stopped) setImmediate(() => this.start());
  }

  stop() {
    this.stopped = true;
    if (this.child) killGroup(this.child);
    this.child = null;
  }
}

module.exports = { YtWorker };

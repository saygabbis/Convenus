'use strict';

// Processos externos (yt-dlp, ffmpeg) com: erro de spawn tratado, término único (idempotente),
// saída limitada, timeout total e de inatividade, e kill do grupo inteiro (o yt-dlp abre ffmpeg
// como filho; matar só o pai deixava o ffmpeg órfão rodando).

const { spawn } = require('node:child_process');

const active = new Set();
const KILL_GRACE_MS = 5_000;

function killGroup(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal); // grupo (detached: true)
  } catch {
    try {
      child.kill(signal);
    } catch { /* já morreu */ }
  }
}

/**
 * Roda um comando e devolve { child, done }.
 * done resolve UMA vez com { code, signal, stdout, stderr, timedOut, idle, overflow, error }.
 * Nunca rejeita: quem chama decide o que é falha.
 */
function run(cmd, args, opts = {}) {
  const {
    timeoutMs = 0, // tempo total máximo (0 = sem limite)
    idleMs = 0, // sem nenhuma saída por esse tempo = travado
    maxStdout = 1024 * 1024, // bytes guardados de stdout (além disso: overflow)
    keepStderr = 20_000, // guarda só o fim do stderr
    killOnOverflow = false,
    onStdout = null, // recebe cada pedaço, antes do limite
    onStderr = null,
    env,
  } = opts;

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let idle = false;
  let overflow = false;
  let settled = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  let child;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env });
  } catch (error) {
    resolveDone({ code: -1, signal: null, stdout, stderr, timedOut, idle, overflow, error });
    return { child: null, done };
  }
  active.add(child);

  let killTimer = null;
  const stop = () => {
    killGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    killTimer.unref();
  };

  const total = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
  total?.unref();
  let idleTimer = null;
  const bump = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; stop(); }, idleMs);
    idleTimer.unref();
  };
  bump();

  child.stdout.on('data', (d) => {
    bump();
    onStdout?.(d);
    if (stdout.length < maxStdout) stdout += d;
    if (stdout.length >= maxStdout && !overflow) {
      overflow = true;
      if (killOnOverflow) stop();
    }
  });
  child.stderr.on('data', (d) => {
    bump();
    onStderr?.(d);
    stderr += d;
    if (stderr.length > keepStderr) stderr = stderr.slice(-keepStderr);
  });

  const settle = (extra) => {
    if (settled) return;
    settled = true;
    clearTimeout(total);
    clearTimeout(idleTimer);
    clearTimeout(killTimer);
    active.delete(child);
    resolveDone({ stdout, stderr, timedOut, idle, overflow, ...extra });
  };
  child.on('error', (error) => settle({ code: -1, signal: null, error }));
  child.on('close', (code, signal) => settle({ code, signal, error: null }));

  return { child, done, stop };
}

/** Encerra todos os processos ativos (SIGTERM, depois SIGKILL) e espera até `graceMs`. */
async function killAll(graceMs = KILL_GRACE_MS) {
  const list = [...active];
  for (const c of list) killGroup(c, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const c of active) killGroup(c, 'SIGKILL');
}

module.exports = { run, killAll, killGroup, active };

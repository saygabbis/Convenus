'use strict';

// Checagens de saúde baratas (cache de 30 s): nada de baixar vídeo pra testar.

const fs = require('node:fs');
const net = require('node:net');
const { run } = require('./proc');

const CACHE_MS = 30_000;
let cache = null;

async function version(cmd, args, re) {
  const r = await run(cmd, args, { timeoutMs: 10_000, maxStdout: 4096 }).done;
  if (r.code !== 0) return { ok: false, error: r.error ? r.error.code || r.error.message : `saiu com ${r.code}` };
  const v = (r.stdout.match(re) || [])[1] || r.stdout.trim().split('\n')[0];
  return { ok: true, version: v };
}

function tcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (ok, error) => { s.destroy(); resolve(ok ? { ok: true } : { ok: false, error }); };
    s.setTimeout(timeoutMs, () => end(false, 'timeout'));
    s.once('connect', () => end(true));
    s.once('error', (e) => end(false, e.code || e.message));
  });
}

async function http(url, timeoutMs = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.name };
  }
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize;
    return { ok: free > 2 * 1024 ** 3, freeBytes: free, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return { ok: false, error: e.code };
  }
}

/** Partes "de sistema" do status. `proxy` é a URL socks5 do WARP (ou vazia). */
async function systemChecks({ ytdlp, downloadDir, proxy, potUrl }) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const warpAddr = proxy && proxy.match(/^socks5h?:\/\/([^:/]+):(\d+)/);
  const [yt, ff, warp, pot] = await Promise.all([
    version(ytdlp, ['--version'], /^(\S+)/),
    version('ffmpeg', ['-version'], /ffmpeg version (\S+)/),
    warpAddr ? tcp(warpAddr[1], Number(warpAddr[2])) : Promise.resolve({ ok: false, error: 'desligado' }),
    potUrl ? http(`${potUrl}/ping`) : Promise.resolve({ ok: false, error: 'desligado' }),
  ]);
  const value = { ytdlp: yt, ffmpeg: ff, warp, pot, disk: disk(downloadDir) };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { systemChecks, disk };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

function checkPort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function runQuiet(cmd, args, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, error: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
    });
  });
}

function diskFree(dir) {
  try {
    // Node 18.15+ / 20: statfsSync
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      const total = Number(s.blocks) * Number(s.bsize);
      return { free, total, usedPct: total ? Math.round(((total - free) / total) * 100) : null };
    }
  } catch {}
  return null;
}

async function collectHealth({
  ytdlpPath,
  cookiesPath,
  proxyUrl,
  potHost = '127.0.0.1',
  potPort = 4416,
  ytHealthy,
  running,
  queued,
  startedAt,
}) {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const disk = diskFree(process.cwd());

  let proxyHost = null;
  let proxyPort = null;
  try {
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      proxyHost = u.hostname;
      proxyPort = Number(u.port || 0) || null;
    }
  } catch {}

  const [ytdlp, ffmpeg, warp, pot] = await Promise.all([
    runQuiet(ytdlpPath, ['--version']),
    runQuiet('ffmpeg', ['-version']),
    proxyHost && proxyPort ? checkPort(proxyHost, proxyPort) : Promise.resolve(null),
    checkPort(potHost, potPort),
  ]);

  const cookiesOk = (() => {
    try {
      return /\t(LOGIN_INFO|SID)\t/.test(fs.readFileSync(cookiesPath, 'utf8'));
    } catch {
      return false;
    }
  })();

  const depsOk = Boolean(ytdlp.ok && ffmpeg.ok);
  const youtubeOk = typeof ytHealthy === 'function' ? ytHealthy() : Boolean(ytHealthy);
  const ok = depsOk && (warp !== false); // warp null = sem proxy configurado

  return {
    ok,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    process: {
      pid: process.pid,
      node: process.version,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      load1: load[0],
      disk,
    },
    queue: { running, queued },
    deps: {
      ytdlp: { ok: ytdlp.ok, version: ytdlp.out.split('\n')[0] || null, error: ytdlp.ok ? null : ytdlp.error || ytdlp.err || `exit ${ytdlp.code}` },
      ffmpeg: { ok: ffmpeg.ok, version: (ffmpeg.out.split('\n')[0] || '').replace(/^ffmpeg version /i, '').split(' ')[0] || null, error: ffmpeg.ok ? null : ffmpeg.error || `exit ${ffmpeg.code}` },
      warpProxy: warp === null ? { ok: null, note: 'proxy desligado' } : { ok: warp, host: proxyHost, port: proxyPort },
      potProvider: { ok: pot, host: potHost, port: potPort },
    },
    youtube: {
      cookiesPresent: cookiesOk,
      healthy: youtubeOk,
    },
    alerts: [
      !ytdlp.ok && 'yt-dlp indisponível',
      !ffmpeg.ok && 'ffmpeg indisponível',
      warp === false && 'proxy WARP fora do ar',
      !pot && 'PO token provider fora do ar',
      cookiesOk && !youtubeOk && 'login YouTube degradado (bot/sessão)',
      !cookiesOk && 'cookies YouTube ausentes ou sem login',
      disk && disk.usedPct >= 90 && `disco em ${disk.usedPct}%`,
      mem.rss > 1.5 * 1024 * 1024 * 1024 && 'RSS acima de 1.5 GB',
    ].filter(Boolean),
  };
}

module.exports = { collectHealth, checkPort, runQuiet };

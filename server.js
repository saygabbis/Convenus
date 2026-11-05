'use strict';

// Convenus: YouTube, X, Instagram, Bluesky e outros -> MP4 / MP3 / WAV / imagens, via yt-dlp + ffmpeg.
// Sem dependências: só Node (>= 20), yt-dlp e ffmpeg no PATH.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const providers = require('./providers');

const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const YTDLP = process.env.YTDLP || path.join(process.env.HOME || '', '.local/bin/yt-dlp');
const PROXY = process.env.YTDLP_PROXY ?? 'socks5://127.0.0.1:40000';
// cookies.txt (formato Netscape) de uma conta descartável: o YouTube pede login pra IP de datacenter.
const COOKIES = path.resolve(process.env.YTDLP_COOKIES || path.join(__dirname, 'cookies.txt'));
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 2);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MIN || 60) * 60_000;
const INFO_TTL_MS = 10 * 60_000;

const MP3_BITRATES = ['128', '192', '256', '320'];
const THUMBS = [
  { file: 'maxresdefault', label: 'Máxima', size: '1280×720' },
  { file: 'sddefault', label: 'SD', size: '640×480' },
  { file: 'hqdefault', label: 'HQ', size: '480×360' },
  { file: 'mqdefault', label: 'MQ', size: '320×180' },
];
// Só baixa imagem/vídeo direto desses CDNs (evita usar o servidor como proxy aberto).
const MEDIA_HOSTS = [
  'ytimg.com', 'ggpht.com', 'googleusercontent.com', 'twimg.com', 'cdninstagram.com', 'fbcdn.net', 'redd.it',
  'redditmedia.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibyteimg.com', 'muscdn.com', 'vimeocdn.com',
  'sndcdn.com', 'pinimg.com', 'bsky.app', 'jtvnw.net', 'dmcdn.net', 'hdslb.com', 'tumblr.com', 'bcbits.com',
];
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
// Outras plataformas (o yt-dlp suporta todas). Lista fechada pra não virar proxy aberto.
const OTHER_HOSTS = [
  'twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'instagram.com', 'reddit.com', 'redd.it', 'tiktok.com', 'facebook.com', 'fb.watch',
  'vimeo.com', 'twitch.tv', 'soundcloud.com', 'pinterest.com', 'pin.it', 'bsky.app', 'threads.net', 'threads.com',
  'dailymotion.com', 'dai.ly', 'kick.com', 'bilibili.com', 'b23.tv', 'streamable.com', 'tumblr.com', 'bandcamp.com',
];
const PLATFORM_NAMES = { 'x.com': 'X', 'twitter.com': 'X', 'fxtwitter.com': 'X', 'vxtwitter.com': 'X', 'fixupx.com': 'X', 'fixvx.com': 'X', 'redd.it': 'Reddit', 'fb.watch': 'Facebook', 'pin.it': 'Pinterest', 'dai.ly': 'Dailymotion', 'b23.tv': 'Bilibili', 'bsky.app': 'Bluesky', 'threads.com': 'Threads', 'tiktok.com': 'TikTok', 'soundcloud.com': 'SoundCloud', 'twitch.tv': 'Twitch', 'bilibili.com': 'Bilibili' };
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

const jobs = new Map();
const infoCache = new Map();
const queue = [];
let running = 0;

fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ---------- yt-dlp ----------

const isYouTube = (url) => YT_HOSTS.test(new URL(url).hostname);

// O yt-dlp regrava o cookies.txt; quando o Google desloga a conta, SID/LOGIN_INFO somem dele.
function ytLoggedIn() {
  try {
    return /\t(LOGIN_INFO|SID)\t/.test(fs.readFileSync(COOKIES, 'utf8'));
  } catch {
    return false;
  }
}

function platformOf(url) {
  const host = new URL(url).hostname.replace(/^(www|m|mobile|old|vm|vt)\./, '');
  if (YT_HOSTS.test(new URL(url).hostname)) return 'YouTube';
  const d = OTHER_HOSTS.find((x) => host === x || host.endsWith(`.${x}`));
  return PLATFORM_NAMES[d] || (d ? d.split('.')[0].replace(/^./, (c) => c.toUpperCase()) : 'Link');
}

function baseArgs(url) {
  const args = ['--js-runtimes', 'node', '--no-playlist', '--no-warnings', '--no-color'];
  // Logado, o YouTube aceita a VPS direto, e um IP fixo segura a sessão por mais tempo
  // (o IP do WARP muda e o Google acaba deslogando). O WARP fica de reserva pra quando não há login.
  if (PROXY && isYouTube(url) && !ytLoggedIn()) args.push('--proxy', PROXY);
  if (fs.existsSync(COOKIES)) args.push('--cookies', COOKIES);
  return args;
}

function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!YT_HOSTS.test(u.hostname) && !hostIn(u.hostname.toLowerCase(), OTHER_HOSTS)) return null;
  return u.toString();
}

function friendlyError(stderr) {
  const s = String(stderr || '');
  if (/confirm you.re not a bot|Sign in to confirm/i.test(s)) {
    return ytLoggedIn()
      ? 'O YouTube bloqueou a VPS ("confirme que não é um robô"). Tenta de novo daqui a pouco.'
      : 'O login da conta do YouTube caiu. Precisa exportar cookies novos da conta descartável.';
  }
  if (/authentication is required|logged-in|login required|log in|requires? login|cookies-from-browser/i.test(s)) return 'Essa plataforma pediu login pra baixar daqui. Dá pra resolver com cookies de uma conta descartável.';
  if (/HTTP Error 403|HTTP Error 429|Blocked|rate.?limit/i.test(s)) return 'A plataforma bloqueou ou limitou a VPS. Tenta de novo daqui a pouco.';
  if (/No video could be found|There is no video|No video formats found/i.test(s)) return 'Esse post não tem vídeo.';
  if (/Unsupported URL/i.test(s)) return 'Esse link não é suportado.';
  if (/Private video/i.test(s)) return 'Esse vídeo é privado.';
  if (/age|inappropriate/i.test(s) && /sign in/i.test(s)) return 'Esse vídeo tem restrição de idade e precisa de login.';
  if (/Video unavailable|This video is unavailable/i.test(s)) return 'Vídeo indisponível.';
  if (/live event will begin|is not a valid URL|Premieres in/i.test(s)) return 'Essa live/estreia ainda não começou.';
  if (/Requested format is not available/i.test(s)) return 'Essa qualidade não está disponível pra esse vídeo.';
  const last = s.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop();
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : 'Deu erro na conversão.';
}

function runCapture(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(friendlyError(err)))));
  });
}

function isChannelUrl(url) {
  const { hostname, pathname } = new URL(url);
  return YT_HOSTS.test(hostname) && !/youtu\.be$/i.test(hostname)
    && /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/[^/]*)?\/?$/.test(pathname);
}

const isProfileUrl = (url) => isChannelUrl(url) || Boolean(providers.match(url)?.profile);

// Fora do YouTube não há tamanhos fixos de capa: oferece a maior que a plataforma tiver.
function bestThumb(j) {
  const area = (t) => (t.width || 0) * (t.height || 0);
  const best = (j.thumbnails || []).filter((t) => /^https:/.test(t.url || ''))
    .sort((a, b) => area(b) - area(a) || (b.preference || 0) - (a.preference || 0))[0]
    || (j.thumbnail ? { url: j.thumbnail } : null);
  return best ? [{ label: 'Original', size: best.width ? `${best.width}×${best.height}` : '', url: best.url }] : [];
}

async function thumbOptions(id) {
  const checks = await Promise.all(THUMBS.map(async (t) => {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${t.file}.jpg`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return r.ok ? t : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean).map((t) => ({ ...t, url: `https://i.ytimg.com/vi/${id}/${t.file}.jpg` }));
}

async function getChannel(url) {
  const raw = await runCapture([...baseArgs(url), '-J', '--flat-playlist', '--playlist-items', '0', '--', url]);
  const j = JSON.parse(raw);
  const thumbs = j.thumbnails || [];
  const pick = (id, fallback) => (thumbs.find((t) => t.id === id) || fallback() || {}).url || null;
  const widest = (filter) => thumbs.filter(filter).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return {
    type: 'profile',
    platform: 'YouTube',
    title: j.channel || j.title || j.uploader_id,
    handle: j.uploader_id || '',
    followers: j.channel_follower_count || 0,
    avatar: pick('avatar_uncropped', () => widest((t) => t.width && t.width === t.height)),
    banner: pick('banner_uncropped', () => widest((t) => t.width && t.width > t.height)),
  };
}

async function getInfo(url) {
  const hit = infoCache.get(url);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;

  const info = await resolveInfo(url);
  infoCache.set(url, { at: Date.now(), info });
  return info;
}

// yt-dlp -J → um item "nativo" por vídeo/áudio (playlist = vários, com o índice pro --playlist-items).
async function ytdlpItems(url) {
  const j = JSON.parse(await runCapture([...baseArgs(url), '-J', '--', url]));
  const entries = j._type === 'playlist' && Array.isArray(j.entries) ? j.entries.filter(Boolean) : [j];
  if (!entries.length) throw new Error('Não achei nenhum vídeo nesse link.');
  const items = entries.map((e, i) => {
    const formats = e.formats || [];
    const heights = [...new Set(formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))].sort((a, b) => b - a);
    // Alguns sites (Facebook…) não dizem codec nem altura: é vídeo, só sem resoluções conhecidas (0 = melhor).
    const videoish = heights.length > 0 || formats.some((f) => f.vcodec !== 'none' && /^(mp4|webm|mov|mkv|flv|m3u8)$/.test(f.ext || ''));
    return {
      kind: videoish ? 'video' : 'audio',
      native: true,
      index: entries.length > 1 ? i + 1 : null,
      heights: heights.length ? heights : videoish ? [0] : [],
      // Sem acodec informado (X, Bluesky…) assume que tem som.
      hasAudio: formats.length === 0 || formats.some((f) => f.acodec !== 'none'),
      thumb: e.thumbnail || null,
      duration: e.duration || 0,
      width: e.width || 0,
      height: e.height || 0,
      isLive: Boolean(e.is_live),
    };
  });
  const first = entries[0];
  return {
    id: j.id || first.id,
    title: j.title || first.title || '',
    uploader: first.uploader || first.channel || first.uploader_id || j.uploader || '',
    thumbnail: first.thumbnail || j.thumbnail || null,
    duration: first.duration || 0,
    items,
    thumbs: isYouTube(url) ? await thumbOptions(first.id) : bestThumb(first),
  };
}

async function resolveInfo(url) {
  if (isChannelUrl(url)) return getChannel(url);

  const extra = providers.match(url);
  if (extra?.profile) return { type: 'profile', platform: extra.platform, ...(await extra.profile()) };

  const base = { type: 'post', platform: extra?.platform || platformOf(url), avatar: null, thumbs: [], duration: 0 };

  // A API da plataforma manda: traz fotos, todos os vídeos e o arquivo original.
  if (extra?.post) {
    let post = null;
    try {
      post = await extra.post();
    } catch (e) {
      if (extra.platform === 'X') throw new Error(`Não consegui abrir esse post do X (${e.message}).`);
    }
    if (post && !post.items.length) throw new Error('Esse post não tem foto nem vídeo.');
    if (post) {
      // Item que só o yt-dlp baixa (ex.: vídeo HLS do Bluesky): completa com as resoluções.
      if (post.items.some((it) => it.native)) {
        const yd = await ytdlpItems(url).catch(() => null);
        post.items = post.items.flatMap((it) => (it.native ? (yd ? [{ ...yd.items[0], thumb: it.thumb || yd.items[0].thumb }] : []) : [it]));
        if (!post.items.length) throw new Error('Não consegui baixar o vídeo desse post.');
      }
      return { ...base, ...post, items: post.items.map((it) => ({ hasAudio: it.kind !== 'image' && !it.gif, ...it })) };
    }
    // Sem a API (fora do ar, post privado…): tenta pelo yt-dlp.
  }

  return { ...base, ...(await ytdlpItems(url)) };
}

function jobArgs(job) {
  const args = [
    ...baseArgs(job.url),
    '--newline',
    '--progress-template', 'download:@@P %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:@@F %(filepath)s',
    '--windows-filenames',
    '-P', job.dir,
    '-o', '%(title).150B.%(ext)s',
  ];

  if (job.kind === 'mp4') {
    const h = job.quality;
    // Prefere H.264/AAC (toca em tudo); acima de 1080p o YouTube só tem VP9/AV1. 0 = a melhor que tiver.
    args.push(
      '-f', h ? `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b` : 'bv*+ba/b',
      '-S', h ? `res:${h},vcodec:h264,acodec:m4a` : 'vcodec:h264,acodec:m4a',
      '--merge-output-format', 'mp4',
      '--embed-metadata',
    );
  } else if (job.kind === 'mp3') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', `${job.quality}K`,
      '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'wav');
  }

  if (job.index) args.push('--playlist-items', String(job.index));
  args.push('--', job.url);
  return args;
}

// ---------- fila de jobs ----------

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    quality: job.quality,
    title: job.title,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    filename: job.file ? path.basename(job.file) : null,
    size: job.size || 0,
  };
}

function pump() {
  while (running < MAX_RUNNING && queue.length) startJob(queue.shift());
}

function finishJob(job, code, stderr) {
  running--;
  job.proc = null;
  if (job.status === 'canceled') {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } else if (code === 0 && job.file && fs.existsSync(job.file)) {
    job.status = 'done';
    job.phase = 'Pronto';
    job.percent = 100;
    job.size = fs.statSync(job.file).size;
  } else {
    job.status = 'error';
    job.error = friendlyError(stderr);
    fs.rmSync(job.dir, { recursive: true, force: true });
    console.error(`[job ${job.id}] falhou (code ${code}):\n${stderr.trim().split('\n').slice(-5).join('\n')}`);
  }
  job.finishedAt = Date.now();
  pump();
}

// Vídeo/áudio direto (X, Instagram, TikTok…): o ffmpeg lê o arquivo original e converte o áudio.
function startDirectJob(job) {
  const ext = job.kind === 'mp3' ? 'mp3' : 'wav';
  job.file = path.join(job.dir, `${safeName(job.title)}.${ext}`);
  job.phase = `Convertendo pra ${ext.toUpperCase()}`;
  const codec = job.kind === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${job.quality}k`] : ['-c:a', 'pcm_s16le'];
  const p = spawn('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-user_agent', 'Convenus/1.0', '-i', job.url,
    '-vn', '-map_metadata', '-1', '-metadata', `title=${job.title}`, ...codec,
    '-progress', 'pipe:1', '-nostats', job.file,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = p;
  let stderr = '';
  p.stdout.on('data', (d) => {
    const m = String(d).match(/out_time_us=(\d+)/g);
    if (m && job.duration) job.percent = Math.min(99, (Number(m.pop().split('=')[1]) / 1e6 / job.duration) * 100);
  });
  p.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });
  p.on('error', (e) => finishJob(job, 1, String(e)));
  p.on('close', (code) => finishJob(job, code, stderr));
}

function startJob(job) {
  running++;
  job.status = 'running';
  job.phase = 'Baixando';
  fs.mkdirSync(job.dir, { recursive: true });
  if (job.mode === 'direct') return startDirectJob(job);

  const p = spawn(YTDLP, jobArgs(job), { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = p;
  let stderr = '';
  let streams = 0;

  const onLine = (line) => {
    if (line.startsWith('@@P ')) {
      const [pct, speed, eta] = line.slice(4).split('|').map((s) => s.trim());
      const n = parseFloat(pct);
      if (!Number.isNaN(n)) {
        if (n < job.lastPct - 50) streams++;
        job.lastPct = n;
        job.percent = n;
      }
      job.speed = speed && speed !== 'NA' && speed !== 'Unknown' ? speed : '';
      job.eta = eta && eta !== 'NA' && eta !== 'Unknown' ? eta : '';
      job.phase = job.kind === 'mp4' ? (streams === 0 ? 'Baixando vídeo' : 'Baixando áudio') : 'Baixando áudio';
    } else if (line.startsWith('@@F ')) {
      job.file = line.slice(4).trim();
    } else if (/^\[Merger\]/.test(line)) {
      job.phase = 'Juntando vídeo e áudio';
      job.percent = 100;
    } else if (/^\[ExtractAudio\]/.test(line)) {
      job.phase = `Convertendo pra ${job.kind.toUpperCase()}`;
      job.percent = 100;
    } else if (/^\[(EmbedThumbnail|Metadata)\]/.test(line)) {
      job.phase = 'Finalizando';
    }
  };

  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r/g, ''));
      buf = buf.slice(i + 1);
    }
  });
  p.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  p.on('close', (code) => finishJob(job, code, stderr));
}

function createJob({ mode = 'native', url, index = null, duration = 0, kind, quality, title }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, mode, url, index, duration, kind, quality, title: String(title || '').slice(0, 300),
    dir: path.join(DOWNLOAD_DIR, id),
    status: 'queued', phase: 'Na fila', percent: 0, lastPct: 0, speed: '', eta: '',
    error: null, file: null, size: 0, createdAt: Date.now(), finishedAt: 0, proc: null,
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      fs.rmSync(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
  for (const [url, hit] of infoCache) if (now - hit.at > INFO_TTL_MS) infoCache.delete(url);
}, 60_000).unref();

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function serveFile(req, res, job) {
  const stat = fs.statSync(job.file);
  const name = path.basename(job.file);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  });
  fs.createReadStream(job.file).pipe(res);
}

function safeName(s) {
  return String(s || 'imagem').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 150) || 'imagem';
}

const MEDIA_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
};

// Repassa (em streaming) uma imagem ou vídeo direto de um CDN permitido, já com nome de arquivo.
async function serveMedia(req, res, params) {
  let u;
  try {
    u = new URL(params.get('u') || '');
  } catch {
    return sendJson(res, 400, { error: 'Link inválido.' });
  }
  if (u.protocol !== 'https:' || !hostIn(u.hostname.toLowerCase(), MEDIA_HOSTS)) return sendJson(res, 400, { error: 'Host não permitido.' });

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const r = await fetch(u, { signal: ac.signal, headers: { 'user-agent': 'Convenus/1.0' } }).catch(() => null);
  const type = (r?.headers.get('content-type') || '').split(';')[0].trim();
  const len = Number(r?.headers.get('content-length') || 0);
  if (!r || !r.ok || !/^(image|video|audio)\//.test(type) || !r.body) return sendJson(res, 502, { error: 'Não consegui baixar esse arquivo.' });
  if (len > MEDIA_MAX_BYTES) return sendJson(res, 502, { error: 'Arquivo grande demais.' });

  const name = `${safeName(params.get('name'))}.${MEDIA_EXT[type] || type.split('/')[1].replace(/\W/g, '') || 'bin'}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'content-type': type,
    ...(len ? { 'content-length': len } : {}),
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  });
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');

  try {
    if (pathname === '/health') return sendJson(res, 200, { ok: true, running, queued: queue.length });

    if ((pathname === '/api/media' || pathname === '/api/image') && req.method === 'GET') return serveMedia(req, res, searchParams);

    if (pathname === '/api/info' && req.method === 'POST') {
      const url = normalizeUrl((await readJson(req)).url);
      if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
      try {
        const info = await getInfo(url);
        if (info.items?.some((it) => it.isLive)) return sendJson(res, 400, { error: 'Lives ao vivo não dá pra converter.' });
        return sendJson(res, 200, info);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      const url = normalizeUrl(body.url);
      if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
      if (isProfileUrl(url)) return sendJson(res, 400, { error: 'Link de perfil não tem vídeo pra converter.' });
      const kind = ['mp4', 'mp3', 'wav'].includes(body.kind) ? body.kind : null;
      if (!kind) return sendJson(res, 400, { error: 'Formato inválido.' });
      // O item vem da busca que o servidor fez: nunca baixa um link arbitrário mandado pelo navegador.
      let info;
      try {
        info = await getInfo(url);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
      const idx = Number.isInteger(body.item) ? body.item : 0;
      const item = info.items?.[idx];
      if (!item || item.kind === 'image') return sendJson(res, 400, { error: 'Esse item não dá pra converter.' });
      if (kind === 'mp4' && !item.native) return sendJson(res, 400, { error: 'Esse vídeo já vem em MP4: é só baixar.' });
      let quality = null;
      if (kind === 'mp4') {
        quality = parseInt(body.quality, 10);
        if (!(quality === 0 || (quality >= 100 && quality <= 4320))) return sendJson(res, 400, { error: 'Qualidade inválida.' });
      } else if (kind === 'mp3') {
        quality = MP3_BITRATES.includes(String(body.quality)) ? String(body.quality) : '320';
      }
      const title = String(body.title || info.title || 'arquivo');
      return sendJson(res, 201, publicJob(createJob(item.native
        ? { mode: 'native', url, index: item.index, kind, quality, title }
        : { mode: 'direct', url: item.url, duration: item.duration, kind, quality, title })));
    }

    const m = pathname.match(/^\/api\/jobs\/([0-9a-f]{16})(\/file)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'Esse arquivo já expirou.' });
      if (m[2]) {
        if (job.status !== 'done' || !fs.existsSync(job.file)) return sendJson(res, 404, { error: 'Arquivo não está pronto.' });
        return serveFile(req, res, job);
      }
      if (req.method === 'DELETE') {
        if (job.status === 'queued') {
          queue.splice(queue.indexOf(job), 1);
          job.status = 'canceled';
          job.finishedAt = Date.now();
        } else if (job.status === 'running' && job.proc) {
          job.status = 'canceled';
          job.proc.kill('SIGTERM');
        }
        return sendJson(res, 200, publicJob(job));
      }
      return sendJson(res, 200, publicJob(job));
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Convenus em http://${HOST}:${PORT} (proxy: ${PROXY || 'nenhum'})`);
});

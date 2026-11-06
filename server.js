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
const log = require('./lib/logger');
const { withRetry, isTransient } = require('./lib/retry');
const { createAuth } = require('./lib/auth');
const { collectHealth } = require('./lib/health');

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
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MIN || 45) * 60_000;
const INFO_TTL_MS = 10 * 60_000;
const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_SEC || 90) * 1000;
const STARTED_AT = Date.now();
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://convert.saygabbis.cloud';
const ACCESS_CLEAN_MS = 2 * 60 * 60_000;

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
  'scdn.co', 'spotifycdn.com', 'dzcdn.net', 'mzstatic.com', 'vimeo.com',
];
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
// Outras plataformas (o yt-dlp suporta todas). Lista fechada pra não virar proxy aberto.
const OTHER_HOSTS = [
  'twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'instagram.com', 'reddit.com', 'redd.it', 'tiktok.com', 'facebook.com', 'fb.watch',
  'vimeo.com', 'twitch.tv', 'soundcloud.com', 'pinterest.com', 'pin.it', 'bsky.app', 'threads.net', 'threads.com',
  'dailymotion.com', 'dai.ly', 'kick.com', 'bilibili.com', 'b23.tv', 'streamable.com', 'tumblr.com', 'bandcamp.com',
  'open.spotify.com', 'deezer.com', 'music.apple.com',
];
const PLATFORM_NAMES = { 'x.com': 'X', 'twitter.com': 'X', 'fxtwitter.com': 'X', 'vxtwitter.com': 'X', 'fixupx.com': 'X', 'fixvx.com': 'X', 'redd.it': 'Reddit', 'fb.watch': 'Facebook', 'pin.it': 'Pinterest', 'dai.ly': 'Dailymotion', 'b23.tv': 'Bilibili', 'bsky.app': 'Bluesky', 'threads.com': 'Threads', 'tiktok.com': 'TikTok', 'soundcloud.com': 'SoundCloud', 'twitch.tv': 'Twitch', 'bilibili.com': 'Bilibili', 'open.spotify.com': 'Spotify', 'deezer.com': 'Deezer', 'music.apple.com': 'Apple Music' };
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

const jobs = new Map();
const infoCache = new Map();
const queue = [];
let running = 0;

// Limpa órfãos de runs anteriores; jobs vivem só em memória.
fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });

process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection', { error: String(err?.stack || err) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: String(err?.stack || err) });
  // Não encerra na hora: o supervisor (systemd/start-vps) reinicia se o processo ficar inconsistente.
});

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

// Saúde do login: o arquivo pode ainda ter SID e mesmo assim o Google ter derrubado a sessão,
// então também conta o último "confirme que não é um robô" depois do último sucesso.
const ytState = { lastOkAt: 0, lastBotAt: 0 };
const ytHealthy = () => ytLoggedIn() && !(ytState.lastBotAt > ytState.lastOkAt);

// Uma sessão do YouTube por vez: dois yt-dlp com o mesmo cookies.txt regravam tokens um por cima
// do outro, o Google vê token reaproveitado e desloga a conta.
const ytLock = { busy: false, waiters: [] };
const ytAcquire = () => new Promise((r) => { if (!ytLock.busy) { ytLock.busy = true; r(); } else ytLock.waiters.push(r); });
function ytRelease() {
  const next = ytLock.waiters.shift();
  if (next) next();
  else ytLock.busy = false;
}
// O cookies.txt é sempre o único estado da sessão: o Google troca os tokens a cada uso e o
// yt-dlp grava os novos no arquivo. Nunca volta uma cópia antiga: token já trocado chegando de
// novo é sinal de sessão roubada pro Google, e ele derruba o login da conta inteira.
let loginWasOk = ytLoggedIn();
function noteLogin() {
  const ok = ytLoggedIn();
  if (loginWasOk && !ok) console.log(`[cookies] o Google encerrou a sessão do YouTube (${new Date().toISOString()}); renove pela /renovar`);
  loginWasOk = ok;
}

async function withYt(url, fn) {
  if (!isYouTube(url)) return fn();
  await ytAcquire();
  try {
    return await fn();
  } finally {
    noteLogin();
    ytRelease();
  }
}
const isYouTubeJob = (job) => job.mode === 'search' || isYouTube(job.url);

// Segredo de enrollment (bootstrap): gerado uma vez, só legível no servidor (SSH). Nunca no git.
const ADMIN_TOKEN_FILE = path.join(__dirname, 'admin.token');
if (!fs.existsSync(ADMIN_TOKEN_FILE)) fs.writeFileSync(ADMIN_TOKEN_FILE, `${crypto.randomBytes(18).toString('base64url')}\n`, { mode: 0o600 });
const ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
const auth = createAuth({ rootDir: __dirname, adminToken: ADMIN_TOKEN });
const renewTries = new Map(); // ip -> [timestamps]
const loginTries = new Map();
const usedJti = new Map(); // anti-replay curto para jti de access já vistos em logout

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '';
}

function rateLimit(map, key, { limit = 5, windowMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  const tries = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (tries.length >= limit) return false;
  tries.push(now);
  map.set(key, tries);
  return true;
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function requireAdmin(req, res, scope) {
  const token = bearer(req);
  if (!token) {
    sendJson(res, 401, { error: 'Autenticação necessária.' });
    return null;
  }
  const session = auth.verifyAccess(token);
  if (!session) {
    sendJson(res, 401, { error: 'Sessão inválida ou expirada.' });
    return null;
  }
  if (scope && !auth.hasScope(session, scope)) {
    sendJson(res, 403, { error: 'Sem permissão para esta ação.' });
    return null;
  }
  if (session.payload?.jti && usedJti.has(session.payload.jti)) {
    sendJson(res, 401, { error: 'Token já utilizado/revogado.' });
    return null;
  }
  auth.touch(session.device.id);
  return session;
}

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-resource-policy', 'same-site');
}

function platformOf(url) {
  const host = new URL(url).hostname.replace(/^(www|m|mobile|old|vm|vt)\./, '');
  if (/^music\.youtube\.com$/i.test(new URL(url).hostname)) return 'YouTube Music';
  if (YT_HOSTS.test(new URL(url).hostname)) return 'YouTube';
  const d = OTHER_HOSTS.find((x) => host === x || host.endsWith(`.${x}`));
  return PLATFORM_NAMES[d] || (d ? d.split('.')[0].replace(/^./, (c) => c.toUpperCase()) : 'Link');
}

function baseArgs(url) {
  const args = ['--js-runtimes', 'node', '--no-playlist', '--no-warnings', '--no-color'];
  // Logado, o YouTube aceita a VPS direto, e um IP fixo segura a sessão por mais tempo
  // (o IP do WARP muda e o Google acaba deslogando). O WARP fica de reserva pra quando não há login.
  const logged = isYouTube(url) && ytLoggedIn();
  if (PROXY && isYouTube(url) && !logged) args.push('--proxy', PROXY);
  // Os cookies só vão pro YouTube: o yt-dlp regrava o arquivo no fim, e qualquer outro processo
  // escrevendo nele faria o Google ver token velho e derrubar a sessão.
  // Sem login, nada de cookie: um pedaço de sessão saindo pelo IP do WARP parece sessão roubada pro Google.
  if (logged) args.push('--cookies', COOKIES);
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
  if (/confirm you.re not a bot/i.test(s)) {
    ytState.lastBotAt = Date.now();
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

function runCapture(args, timeoutMs = INFO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('A consulta demorou demais e foi cancelada.'));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(friendlyError(err)));
    });
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
  const raw = await withYt(url, () => runCapture([...baseArgs(url), '-J', '--flat-playlist', '--playlist-items', '0', '--', url]));
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
  const j = JSON.parse(await withYt(url, () => runCapture([...baseArgs(url), '-J', '--', url])));
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
  if (isYouTube(url)) ytState.lastOkAt = Date.now();
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

// Playlist do YouTube/YouTube Music ou set do SoundCloud: lista leve (sem consultar vídeo por vídeo).
function isPlaylistUrl(url) {
  const u = new URL(url);
  if (YT_HOSTS.test(u.hostname)) return u.pathname === '/playlist' || (u.searchParams.has('list') && !u.searchParams.has('v') && !/youtu\.be$/i.test(u.hostname));
  return /(^|\.)soundcloud\.com$/i.test(u.hostname) && /\/sets\//.test(u.pathname);
}

async function flatPlaylist(url) {
  const raw = await withYt(url, () => runCapture([...baseArgs(url), '-J', '--flat-playlist', '--playlist-end', '200', '--', url]));
  const j = JSON.parse(raw);
  const audio = /soundcloud\.com/i.test(url);
  const items = (j.entries || []).filter((e) => e && (e.url || e.id)).map((e) => {
    const thumb = (e.thumbnails || []).filter((t) => t.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url
      || (e.id && !audio ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : null);
    return {
      kind: audio ? 'audio' : 'video',
      native: true,
      entryUrl: e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      // Sem consultar cada vídeo não dá pra saber as resoluções: oferece as comuns (0 = melhor).
      heights: audio ? [] : [0, 1080, 720, 480, 360],
      hasAudio: true,
      thumb,
      duration: e.duration || 0,
      label: clean(e.title || slugTitle(e.url) || 'Sem título', 120),
    };
  });
  if (!items.length) throw new Error('Essa playlist tá vazia ou é privada.');
  if (isYouTube(url)) ytState.lastOkAt = Date.now();
  return {
    id: j.id,
    title: j.title || 'Playlist',
    uploader: j.channel || j.uploader || '',
    thumbnail: items[0].thumb,
    playlist: true,
    total: j.playlist_count || items.length,
    items,
    thumbs: [],
  };
}

// "https://soundcloud.com/forss/city-ports" -> "City ports"
function slugTitle(u) {
  const slug = String(u || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  const t = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

const clean = (s, n) => Array.from(String(s || '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

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
        // O k-ésimo item nativo do post corresponde ao k-ésimo vídeo que o yt-dlp achou.
        let k = 0;
        post.items = post.items.flatMap((it) => {
          if (!it.native) return [it];
          const y = yd?.items[Math.min(k++, yd.items.length - 1)];
          return y ? [{ ...y, thumb: it.thumb || y.thumb, width: it.width || y.width, height: it.height || y.height }] : [];
        });
        if (!post.items.length) throw new Error('Não consegui baixar o vídeo desse post.');
      }
      return { ...base, ...post, items: post.items.map((it) => ({ hasAudio: it.kind !== 'image' && !it.gif, ...it })) };
    }
    // Sem a API (fora do ar, post privado…): tenta pelo yt-dlp.
  }

  if (isPlaylistUrl(url)) return { ...base, ...(await flatPlaylist(url)) };

  const info = { ...base, ...(await ytdlpItems(url)) };
  // Vídeo aberto dentro de uma playlist: oferece abrir a playlist inteira.
  const list = isYouTube(url) && new URL(url).searchParams.get('list');
  if (list && !/^(RD|UL)/.test(list)) info.playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  return info;
}

function jobArgs(job) {
  const args = [
    ...baseArgs(job.url),
    '--newline',
    '--progress-template', 'download:@@P %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:@@F %(filepath)s',
    '--windows-filenames',
    '-P', job.dir,
    '-o', job.mode === 'search' || job.named ? `${safeName(job.title)}.%(ext)s` : '%(title).150B.%(ext)s',
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

  if (job.mode === 'search') args.push('--playlist-items', '1');
  else if (job.index) args.push('--playlist-items', String(job.index));
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
  if (job.timeout) {
    clearTimeout(job.timeout);
    job.timeout = null;
  }
  job.proc = null;
  if (job.ytLocked) {
    job.ytLocked = false;
    noteLogin();
    ytRelease();
  }
  if (job.status === 'canceled') {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } else if (code === 0 && job.file && fs.existsSync(job.file)) {
    job.status = 'done';
    if (isYouTubeJob(job)) ytState.lastOkAt = Date.now();
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
  const ext = job.kind;
  job.file = path.join(job.dir, `${safeName(job.title)}.${ext}`);
  job.phase = ext === 'mp4' ? 'Baixando vídeo' : `Convertendo pra ${ext.toUpperCase()}`;
  const codec = ext === 'mp4' ? ['-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart']
    : ['-vn', ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${job.quality}k`] : ['-c:a', 'pcm_s16le'])];
  const p = spawn('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-user_agent', 'Convenus/1.0', '-i', job.url,
    '-map_metadata', '-1', '-metadata', `title=${job.title}`, ...codec,
    '-progress', 'pipe:1', '-nostats', job.file,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = p;
  job.timeout = setTimeout(() => {
    if (job.status !== 'running' || !job.proc) return;
    log.warn('job.timeout', { id: job.id, mode: 'direct' });
    job.error = 'A conversão passou do tempo limite e foi cancelada.';
    job.status = 'canceled';
    job.proc.kill('SIGTERM');
  }, JOB_TIMEOUT_MS);
  if (job.timeout.unref) job.timeout.unref();
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

async function startJob(job) {
  running++;
  job.status = 'running';
  job.phase = 'Baixando';
  fs.mkdirSync(job.dir, { recursive: true });
  if (job.mode === 'direct') return startDirectJob(job);
  if (isYouTubeJob(job)) {
    job.phase = 'Esperando a vez no YouTube';
    await ytAcquire();
    job.ytLocked = true;
    if (job.status === 'canceled') return finishJob(job, 1, '');
    job.phase = 'Baixando';
  }
  runYtdlpJob(job);
}

function runYtdlpJob(job) {
  const p = spawn(YTDLP, jobArgs(job), { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = p;
  let stderr = '';
  let streams = 0;
  job.timeout = setTimeout(() => {
    if (job.status !== 'running' || !job.proc) return;
    log.warn('job.timeout', { id: job.id, timeoutMs: JOB_TIMEOUT_MS });
    job.error = 'A conversão passou do tempo limite e foi cancelada.';
    job.status = 'canceled';
    job.proc.kill(job.ytLocked ? 'SIGINT' : 'SIGTERM');
    setTimeout(() => { try { job.proc?.kill('SIGKILL'); } catch {} }, 8_000).unref();
  }, JOB_TIMEOUT_MS);
  if (job.timeout.unref) job.timeout.unref();

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

function createJob({ mode = 'native', url, index = null, named = false, duration = 0, kind, quality, title }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, mode, url, index, named, duration, kind, quality, title: String(title || '').slice(0, 300),
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

function readJson(req, max = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) req.destroy();
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
  const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (rel === 'sw.js') headers['service-worker-allowed'] = '/';
  if (/\.(html|webmanifest|js)$/.test(rel) || rel === 'sw.js') headers['cache-control'] = 'no-cache';
  res.writeHead(200, headers);
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

// Troca o cookies.txt do YouTube pela página /renovar (ou extensão) e testa na hora.
async function renewCookies(req, res) {
  const ip = clientIp(req);

  let body;
  try {
    body = await readJson(req, 400_000);
  } catch {
    return sendJson(res, 400, { error: 'Arquivo inválido ou grande demais.' });
  }

  // Preferência: Bearer de dispositivo autorizado. Fallback: admin.token (enrollment / SSH).
  const session = (() => {
    const t = bearer(req);
    return t ? auth.verifyAccess(t) : null;
  })();
  const okBearer = session && auth.hasScope(session, 'cookies:write');
  const okBootstrap = auth.checkBootstrap(String(body.token || '').trim());
  if (!okBearer && !okBootstrap) return sendJson(res, 403, { error: 'Código errado ou sessão sem permissão.' });
  // Extensão autenticada sincroniza com frequência: rate limit só no bootstrap / anônimo.
  if (!okBearer && !rateLimit(renewTries, ip, { limit: 5, windowMs: 15 * 60_000 })) {
    return sendJson(res, 429, { error: 'Muitas tentativas. Espera uns 15 minutos.' });
  }
  if (okBearer) auth.touch(session.device.id);

  // Só youtube.com — nunca google.com (evita gravar sessão da conta de trabalho/Gmail).
  const lines = String(body.content || '').split(/\r?\n/).filter((l) => /^#(?!HttpOnly_)|^\s*$/.test(l)
    || /^(#HttpOnly_)?\.?youtube\.com\t/.test(l));
  const text = lines.join('\n');
  if (!/\t(LOGIN_INFO|SID)\t/.test(text) || !/youtube\.com\t/.test(text)) {
    return sendJson(res, 400, { error: 'Esse arquivo não tem o login do YouTube. Entre em youtube.com com a conta descartável.' });
  }
  const content = `# Netscape HTTP Cookie File\n${text.replace(/^# Netscape HTTP Cookie File\n?/, '')}\n`;
  // Espera a vez no YouTube: trocar o arquivo com um yt-dlp rodando faria ele gravar a sessão velha por cima.
  await ytAcquire();
  try {
    fs.writeFileSync(COOKIES, content, { mode: 0o600 });
  } finally {
    ytRelease();
  }
  loginWasOk = true;
  ytState.lastBotAt = 0;
  infoCache.clear();
  log.audit('cookies.renew', { ip, deviceId: session?.device?.id || null, via: okBearer ? 'device' : 'bootstrap' });

  try {
    await withRetry(
      () => withYt('https://www.youtube.com/', () => runCapture([...baseArgs('https://www.youtube.com/'), '--simulate', '--print', 'title', '--', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'])),
      { retries: 2, baseMs: 800, shouldRetry: isTransient, onRetry: (e, n) => log.warn('cookies.test.retry', { n, error: e.message }) },
    );
    ytState.lastOkAt = Date.now();
    renewTries.delete(ip);
    log.info('cookies.renew.ok', { ip });
    return sendJson(res, 200, { ok: true, message: 'Login renovado e testado. O YouTube voltou a funcionar!' });
  } catch (e) {
    return sendJson(res, 200, { ok: false, message: `Salvei os cookies, mas o teste falhou: ${e.message}` });
  }
}

async function adminLogin(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(loginTries, ip, { limit: 8, windowMs: 15 * 60_000 })) {
    return sendJson(res, 429, { error: 'Muitas tentativas. Espera uns 15 minutos.' });
  }
  let body;
  try {
    body = await readJson(req, 4_000);
  } catch {
    return sendJson(res, 400, { error: 'JSON inválido.' });
  }
  try {
    const out = auth.enroll({
      adminSecret: String(body.token || '').trim(),
      name: body.deviceName || body.name || 'Dispositivo',
      userAgent: req.headers['user-agent'],
      ip,
    });
    loginTries.delete(ip);
    return sendJson(res, 200, { ok: true, ...out });
  } catch (e) {
    return sendJson(res, e.status || 403, { error: e.message || 'Falha no login.' });
  }
}

async function adminRefresh(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(loginTries, `refresh:${ip}`, { limit: 30, windowMs: 15 * 60_000 })) {
    return sendJson(res, 429, { error: 'Muitas tentativas.' });
  }
  let body;
  try {
    body = await readJson(req, 4_000);
  } catch {
    return sendJson(res, 400, { error: 'JSON inválido.' });
  }
  try {
    const out = auth.refresh({ refreshToken: String(body.refreshToken || '').trim(), ip });
    return sendJson(res, 200, { ok: true, ...out });
  } catch (e) {
    return sendJson(res, e.status || 401, { error: e.message || 'Falha ao renovar sessão.' });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  setSecurityHeaders(res);

  // Extensão privada (chrome-extension://) e PWA no mesmo domínio.
  const origin = String(req.headers.origin || '');
  if (origin === SITE_ORIGIN || /^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-max-age', '600');
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname === '/health') {
      const deep = searchParams.get('deep') === '1';
      if (!deep) return sendJson(res, 200, { ok: true, running, queued: queue.length, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000) });
      const session = requireAdmin(req, res, 'health:read');
      if (!session) return undefined;
      const report = await collectHealth({
        ytdlpPath: YTDLP,
        cookiesPath: COOKIES,
        proxyUrl: PROXY,
        ytHealthy,
        running,
        queued: queue.length,
        startedAt: STARTED_AT,
      });
      return sendJson(res, report.ok ? 200 : 503, report);
    }

    if (pathname === '/api/status') {
      return sendJson(res, 200, {
        youtube: ytHealthy(),
        cookies: ytLoggedIn(),
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        running,
        queued: queue.length,
      });
    }

    if (pathname === '/api/admin/login' && req.method === 'POST') return adminLogin(req, res);
    if (pathname === '/api/admin/refresh' && req.method === 'POST') return adminRefresh(req, res);

    if (pathname === '/api/admin/session' && req.method === 'GET') {
      const session = requireAdmin(req, res, 'status:read');
      if (!session) return undefined;
      return sendJson(res, 200, { ok: true, device: auth.publicDevice(session.device), scopes: session.scopes });
    }

    if (pathname === '/api/admin/devices' && req.method === 'GET') {
      const session = requireAdmin(req, res, 'devices:read');
      if (!session) return undefined;
      return sendJson(res, 200, { ok: true, devices: auth.listDevices() });
    }

    if (pathname === '/api/admin/revoke' && req.method === 'POST') {
      const session = requireAdmin(req, res, 'devices:revoke');
      if (!session) return undefined;
      let body = {};
      try { body = await readJson(req, 4_000); } catch { return sendJson(res, 400, { error: 'JSON inválido.' }); }
      const target = String(body.deviceId || session.device.id);
      const all = Boolean(body.all);
      if (session.payload?.jti) {
        usedJti.set(session.payload.jti, Date.now());
        setTimeout(() => usedJti.delete(session.payload.jti), ACCESS_CLEAN_MS).unref();
      }
      return sendJson(res, 200, auth.revoke({ deviceId: all ? null : target, byDeviceId: session.device.id, all }));
    }

    if (pathname === '/api/admin/health' && req.method === 'GET') {
      const session = requireAdmin(req, res, 'health:read');
      if (!session) return undefined;
      const report = await collectHealth({
        ytdlpPath: YTDLP,
        cookiesPath: COOKIES,
        proxyUrl: PROXY,
        ytHealthy,
        running,
        queued: queue.length,
        startedAt: STARTED_AT,
      });
      return sendJson(res, report.ok ? 200 : 503, report);
    }

    if (pathname === '/renovar' || pathname === '/admin') return serveStatic(req, res, '/renovar.html');

    if (pathname === '/api/cookies' && req.method === 'POST') return renewCookies(req, res);

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
      if (kind === 'mp4' && !item.native && !item.hls) return sendJson(res, 400, { error: 'Esse vídeo já vem em MP4: é só baixar.' });
      if (kind === 'mp4' && item.kind === 'audio') return sendJson(res, 400, { error: 'Isso é só áudio.' });
      let quality = null;
      if (kind === 'mp4' && !item.native) {
        quality = 0; // HLS direto (Vimeo): uma versão só, copiada sem reencode
      } else if (kind === 'mp4') {
        quality = parseInt(body.quality, 10);
        if (!(quality === 0 || (quality >= 100 && quality <= 4320))) return sendJson(res, 400, { error: 'Qualidade inválida.' });
      } else if (kind === 'mp3') {
        quality = MP3_BITRATES.includes(String(body.quality)) ? String(body.quality) : '320';
      }
      const title = String(body.title || info.title || 'arquivo');
      const spec = item.search
        // Música (Spotify, Deezer, Apple Music): baixa a mesma faixa da aba de músicas do YouTube Music.
        ? { mode: 'search', url: `https://music.youtube.com/search?q=${encodeURIComponent(item.search)}#songs`, kind, quality, title }
        : item.native
          ? { mode: 'native', url: item.entryUrl || url, index: item.entryUrl ? null : item.index, named: Boolean(item.entryUrl), kind, quality, title }
          : { mode: 'direct', url: item.url, duration: item.duration, kind, quality, title };
      return sendJson(res, 201, publicJob(createJob(spec)));
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
          // SIGINT: o yt-dlp sai salvando os cookies que o Google acabou de trocar. Com SIGTERM ele
          // morria sem salvar, e o próximo download mandava token velho e derrubava o login.
          job.proc.kill(job.ytLocked ? 'SIGINT' : 'SIGTERM');
        } else if (job.status === 'running') {
          job.status = 'canceled'; // ainda esperando a vez: o startJob encerra quando chegar
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
  log.info('listen', { host: HOST, port: PORT, proxy: PROXY || null });
});

process.on('SIGTERM', () => {
  log.info('shutdown', { signal: 'SIGTERM' });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
});

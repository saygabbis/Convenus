'use strict';

// Convenus: YouTube, X, Instagram, Bluesky e outros -> MP4 / MP3 / WAV / imagens, via yt-dlp + ffmpeg.
// Sem dependências: só Node (>= 20), yt-dlp e ffmpeg no PATH.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const providers = require('./providers');
const proc = require('./lib/proc');
const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const cookieFiles = require('./lib/cookies');
const { systemChecks, disk } = require('./lib/health');

const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const YTDLP = process.env.YTDLP || path.join(process.env.HOME || '', '.local/bin/yt-dlp');
const PROXY = process.env.YTDLP_PROXY ?? 'socks5://127.0.0.1:40000';
// Pasta dos dados locais (banco, código de acesso, cookies). Nada disso vai pro git.
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
// cookies.txt (formato Netscape) de uma conta descartável: o YouTube pede login pra IP de datacenter.
const COOKIES = path.resolve(process.env.YTDLP_COOKIES || path.join(DATA_DIR, 'cookies.txt'));
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(DATA_DIR, 'downloads'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'convenus.db'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const POT_URL = process.env.POT_URL ?? 'http://127.0.0.1:4416';
const MAX_RUNNING = Number(process.env.MAX_RUNNING || 2);
// Arquivos prontos ficam disponíveis por 24 h (antes: 1 h e apagados em todo reinício).
const JOB_TTL_MS = Number(process.env.JOB_TTL_MIN || 1440) * 60_000;
const HISTORY_MS = Number(process.env.HISTORY_DAYS || 30) * 86_400_000;
const INFO_TTL_MS = 10 * 60_000;
const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_SEC || 120) * 1000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MIN || 240) * 60_000;
const JOB_IDLE_MS = Number(process.env.JOB_IDLE_MIN || 10) * 60_000;
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_GB || 2) * 1024 ** 3;
const MAX_ATTEMPTS = 3; // reinícios no meio de uma tarefa antes de desistir dela
const PLAYLIST_PAGE = 200;

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
const infoPending = new Map(); // mesma busca ao mesmo tempo = uma extração só
const queue = [];
let running = 0;
let shuttingDown = false;

// Nunca apaga a pasta inteira no start: arquivos prontos sobrevivem a reinícios.
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const store = new Store(DB_FILE);
const auth = new Auth(process.env.ADMIN_TOKEN_FILE || path.join(DATA_DIR, 'admin.token'));

// ---------- yt-dlp ----------

const isYouTube = (url) => YT_HOSTS.test(new URL(url).hostname);

// O yt-dlp regrava o cookies.txt; quando o Google desloga a conta, SID/LOGIN_INFO somem dele.
const ytLoggedIn = () => cookieFiles.hasLogin(COOKIES);

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
// Cópia boa dos cookies: atualizada depois de cada uso do YouTube que deu certo e restaurada
// sozinha quando o arquivo perde o login (o yt-dlp às vezes regrava o arquivo sem ele, mesmo
// com a sessão ainda válida no Google). Só existe um arquivo ativo por vez, então não há duas
// cópias girando tokens em paralelo.
const COOKIES_MASTER = path.join(path.dirname(COOKIES), 'cookies.master.txt');
const COOKIES_PREV = path.join(path.dirname(COOKIES), 'cookies.prev.txt');
const RESTORE_COOLDOWN_MS = 10 * 60_000;
let lastRestoreAt = 0;
const { hasLogin } = cookieFiles;
function backupCookies() {
  if (hasLogin(COOKIES)) cookieFiles.copyPrivate(COOKIES, COOKIES_MASTER);
}
function restoreCookies() {
  if (Date.now() - lastRestoreAt < RESTORE_COOLDOWN_MS || !hasLogin(COOKIES_MASTER)) return false;
  lastRestoreAt = Date.now();
  cookieFiles.copyPrivate(COOKIES_MASTER, COOKIES);
  ytState.lastBotAt = 0;
  console.log(`[cookies] login sumiu do arquivo; restaurei a cópia boa (${new Date().toISOString()})`);
  return true;
}
const loginTrouble = (text) => /confirm you.re not a bot|Sign in to confirm|login da conta|não é um robô/i.test(String(text || ''));

async function withYt(url, fn) {
  if (!isYouTube(url)) return fn();
  await ytAcquire();
  try {
    if (!ytLoggedIn()) restoreCookies();
    try {
      const out = await fn();
      backupCookies();
      return out;
    } catch (e) {
      // Uma nova tentativa com a cópia boa; se falhar de novo, o erro segue pro usuário.
      if (!loginTrouble(e.message) || !restoreCookies()) throw e;
      const out = await fn();
      backupCookies();
      return out;
    }
  } finally {
    ytRelease();
  }
}
const isYouTubeJob = (job) => job.mode === 'search' || isYouTube(job.url);


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
  if (/confirm you.re not a bot|Sign in to confirm/i.test(s)) {
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

// Tira de mensagens de log o que pode ser segredo: query strings (URLs assinadas), cookies, tokens.
function redact(text) {
  return String(text || '')
    .replace(/(https?:\/\/[^\s?'"]+)\?[^\s'"]*/g, '$1?…')
    .replace(/(cookie|token|sid|sapisid|authorization)([=:]\s*)[^\s;,'"]+/gi, '$1$2…');
}

// yt-dlp que devolve texto (busca de informações). Nunca fica pendurado: timeout e limite de saída.
async function runCapture(args, { timeoutMs = INFO_TIMEOUT_MS, maxStdout = 64 * 1024 * 1024 } = {}) {
  const r = await proc.run(YTDLP, args, { timeoutMs, maxStdout, killOnOverflow: true }).done;
  if (r.code === 0 && !r.overflow) return r.stdout;
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'O yt-dlp não está instalado no servidor.' : 'Não consegui rodar o yt-dlp.');
  if (r.timedOut) throw new Error('A plataforma demorou demais pra responder. Tenta de novo.');
  if (r.overflow) throw new Error('Resposta grande demais (playlist enorme?).');
  throw new Error(friendlyError(r.stderr));
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

async function getInfo(url, page = 0) {
  const key = `${url}#${page}`;
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
  if (infoPending.has(key)) return infoPending.get(key);

  const p = resolveInfo(url, page)
    .then((info) => {
      infoCache.set(key, { at: Date.now(), info });
      return info;
    })
    .finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}

// Legendas que o yt-dlp achou: as enviadas pelo autor primeiro; das automáticas, só a do idioma
// original (o YouTube oferece tradução automática pra ~150 línguas, inútil na lista).
function subsList(e) {
  const out = [];
  for (const [lang, tracks] of Object.entries(e.subtitles || {})) {
    if (lang === 'live_chat' || !tracks?.length) continue;
    out.push({ lang, name: tracks[0].name || lang, auto: false });
  }
  const orig = Object.keys(e.automatic_captions || {}).filter((l) => l.endsWith('-orig') || l === e.language);
  for (const lang of orig) {
    if (out.some((x) => x.lang === lang.replace(/-orig$/, ''))) continue;
    out.push({ lang, name: `${(e.automatic_captions[lang][0]?.name || lang).replace(/\s*\(.*\)$/, '')} (automática)`, auto: true });
  }
  return out.slice(0, 40);
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
      subs: subsList(e),
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

// Playlists grandes vêm em páginas de 200: nunca carrega milhares de itens de uma vez na memória.
async function flatPlaylist(url, page = 0) {
  const start = page * PLAYLIST_PAGE + 1;
  const end = start + PLAYLIST_PAGE - 1;
  const raw = await withYt(url, () => runCapture([...baseArgs(url), '-J', '--flat-playlist', '--playlist-start', String(start), '--playlist-end', String(end), '--', url]));
  const j = JSON.parse(raw);
  const audio = /soundcloud\.com/i.test(url);
  const items = (j.entries || []).filter((e) => e && (e.url || e.id)).map((e, pidx) => {
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
      page,
      pidx,
      gidx: start - 1 + pidx,
    };
  });
  if (!items.length) throw new Error(page ? 'Não tem mais itens nessa playlist.' : 'Essa playlist tá vazia ou é privada.');
  const total = j.playlist_count || 0;
  if (isYouTube(url)) ytState.lastOkAt = Date.now();
  return {
    id: j.id,
    title: j.title || 'Playlist',
    uploader: j.channel || j.uploader || '',
    thumbnail: items[0].thumb,
    playlist: true,
    page,
    total: total || items.length,
    hasMore: total ? end < total : items.length === PLAYLIST_PAGE,
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

async function resolveInfo(url, page = 0) {
  if (page && !isPlaylistUrl(url)) throw new Error('Esse link não tem páginas.');
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

  if (isPlaylistUrl(url)) return { ...base, ...(await flatPlaylist(url, page)) };

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
  const subs = job.opts?.subs;
  const subArgs = subs ? [subs.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', subs.lang] : [];

  if (job.kind === 'srt') {
    // Só a legenda, em .srt (o after_move não roda sem download: o arquivo é achado no fim).
    args.push('--skip-download', ...subArgs, '--convert-subs', 'srt');
  } else if (job.kind === 'mp4') {
    const h = job.quality;
    // Prefere H.264/AAC (toca em tudo); acima de 1080p o YouTube só tem VP9/AV1. 0 = a melhor que tiver.
    args.push(
      '-f', h ? `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b` : 'bv*+ba/b',
      '-S', h ? `res:${h},vcodec:h264,acodec:m4a` : 'vcodec:h264,acodec:m4a',
      '--merge-output-format', 'mp4',
      '--embed-metadata',
    );
    if (subs?.embed) args.push(...subArgs, '--embed-subs');
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

const ACTIVE = new Set(['queued', 'running']);

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    quality: job.quality,
    title: job.title,
    platform: job.platform || '',
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    speed: job.speed || '',
    eta: job.eta || '',
    error: job.error,
    filename: job.file && job.status === 'done' ? path.basename(job.file) : null,
    size: job.size || 0,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || 0,
  };
}

// Grava no banco; progresso no máximo a cada 3 s (o resto grava na hora).
function persist(job, { progress = false } = {}) {
  const now = Date.now();
  if (progress && now - (job.savedAt || 0) < 3000) return;
  job.savedAt = now;
  try {
    store.save(job);
  } catch (e) {
    console.error(`[db] não consegui salvar o job ${job.id}: ${e.message}`);
  }
}

function pump() {
  if (shuttingDown) return;
  while (running < MAX_RUNNING && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    startJob(job).catch((e) => {
      console.error(`[job ${job.id}] erro inesperado: ${redact(e.stack || e.message)}`);
      finishJob(job, { code: 1, stderr: '' });
    });
  }
}

function releaseYt(job) {
  if (!job.ytLocked) return;
  job.ytLocked = false;
  ytRelease();
}

// Fim de UMA execução da tarefa. Idempotente: chamado de novo pra mesma execução, não faz nada.
function finishJob(job, r) {
  if (job.finished) return;
  job.finished = true;
  running = Math.max(0, running - 1);
  job.proc = null;
  job.stop = null;
  releaseYt(job);

  if (shuttingDown && ACTIVE.has(job.status)) {
    // Reinício do servidor: não é erro. A tarefa volta pra fila e continua no próximo start
    // (o yt-dlp retoma o .part que ficou na pasta).
    job.status = 'queued';
    job.phase = 'Vai continuar depois do reinício';
    persist(job);
    return;
  }

  if (job.kind === 'srt' && r.code === 0 && !job.file) {
    const sub = fs.existsSync(job.dir) && fs.readdirSync(job.dir).find((f) => /\.(srt|vtt|ass)$/i.test(f));
    if (sub) job.file = path.join(job.dir, sub);
  }

  if (job.status === 'canceled') {
    fs.rmSync(job.dir, { recursive: true, force: true });
    job.phase = 'Cancelado';
  } else if (r.code === 0 && job.file && fs.existsSync(job.file)) {
    job.status = 'done';
    if (isYouTubeJob(job)) ytState.lastOkAt = Date.now();
    job.phase = 'Pronto';
    job.percent = 100;
    job.size = fs.statSync(job.file).size;
  } else {
    job.status = 'error';
    job.error = r.error ? 'Não consegui iniciar o programa de download no servidor.'
      : r.timedOut ? 'Demorou demais e foi interrompido.'
        : r.idle ? 'Travou sem progresso e foi interrompido.'
          : job.kind === 'srt' && r.code === 0 ? 'Esse vídeo não tem legenda nesse idioma.'
            : friendlyError(r.stderr);
    fs.rmSync(job.dir, { recursive: true, force: true });
    console.error(`[job ${job.id}] falhou (code ${r.code}${r.timedOut ? ', timeout' : ''}${r.idle ? ', travado' : ''}):\n${redact(String(r.stderr || r.error?.message || '').trim().split('\n').slice(-5).join('\n'))}`);
  }
  job.speed = '';
  job.eta = '';
  job.finishedAt = Date.now();
  persist(job);
  pump();
}

const runOpts = (onStdout) => ({ timeoutMs: JOB_TIMEOUT_MS, idleMs: JOB_IDLE_MS, maxStdout: 256 * 1024, onStdout });

// Vídeo/áudio direto (X, Instagram, TikTok…): o ffmpeg lê o arquivo original e converte o áudio.
function startDirectJob(job) {
  const ext = job.kind;
  job.file = path.join(job.dir, `${safeName(job.title)}.${ext}`);
  job.phase = ext === 'mp4' ? 'Baixando vídeo' : `Convertendo pra ${ext.toUpperCase()}`;
  const codec = ext === 'mp4' ? ['-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart']
    : ['-vn', ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${job.quality}k`] : ['-c:a', 'pcm_s16le'])];
  const h = proc.run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-user_agent', 'Convenus/1.0', '-i', job.url,
    '-map_metadata', '-1', '-metadata', `title=${job.title}`, ...codec,
    '-progress', 'pipe:1', '-nostats', job.file,
  ], runOpts((d) => {
    const m = String(d).match(/out_time_us=(\d+)/g);
    if (m && job.duration) {
      job.percent = Math.min(99, (Number(m.pop().split('=')[1]) / 1e6 / job.duration) * 100);
      persist(job, { progress: true });
    }
  }));
  job.proc = h.child;
  job.stop = h.stop;
  h.done.then((r) => finishJob(job, r));
}

async function startJob(job) {
  running++;
  job.finished = false;
  job.status = 'running';
  job.phase = 'Baixando';
  job.startedAt = Date.now();
  job.attempts = (job.attempts || 0) + 1;
  fs.mkdirSync(job.dir, { recursive: true });
  persist(job);
  if (job.mode === 'direct') return startDirectJob(job);
  if (isYouTubeJob(job)) {
    job.phase = 'Esperando a vez no YouTube';
    await ytAcquire();
    job.ytLocked = true;
    if (job.status === 'canceled' || shuttingDown) return finishJob(job, { code: 1, stderr: '' });
    if (!ytLoggedIn()) restoreCookies();
    job.phase = 'Baixando';
  }
  runYtdlpJob(job);
}

function runYtdlpJob(job) {
  let streams = 0;
  const onLine = (line) => {
    if (line.startsWith('@@P ')) {
      const [pct, speed, eta] = line.slice(4).split('|').map((x) => x.trim());
      const n = parseFloat(pct);
      if (!Number.isNaN(n)) {
        if (n < job.lastPct - 50) streams++;
        job.lastPct = n;
        job.percent = n;
      }
      job.speed = speed && speed !== 'NA' && speed !== 'Unknown' ? speed : '';
      job.eta = eta && eta !== 'NA' && eta !== 'Unknown' ? eta : '';
      job.phase = job.kind === 'mp4' ? (streams === 0 ? 'Baixando vídeo' : 'Baixando áudio') : 'Baixando áudio';
      persist(job, { progress: true });
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
    } else if (/^\[EmbedSubtitle\]/.test(line)) {
      job.phase = 'Colocando a legenda';
    } else if (/^\[info\] Writing video subtitles/.test(line)) {
      job.phase = 'Baixando a legenda';
    }
  };

  let buf = '';
  const h = proc.run(YTDLP, jobArgs(job), runOpts((d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r/g, ''));
      buf = buf.slice(i + 1);
    }
  }));
  job.proc = h.child;
  job.stop = h.stop;

  h.done.then((r) => {
    // Login sumiu no meio: restaura a cópia boa e tenta de novo uma vez, ainda segurando a vez no YouTube.
    if (r.code !== 0 && !shuttingDown && job.status !== 'canceled' && job.ytLocked && !job.retried && loginTrouble(r.stderr) && restoreCookies()) {
      job.retried = true;
      job.phase = 'Reconectando no YouTube';
      job.percent = 0;
      job.lastPct = 0;
      return runYtdlpJob(job);
    }
    if (r.code === 0 && job.ytLocked) backupCookies();
    finishJob(job, r);
  });
}

function createJob({ mode = 'native', url, index = null, named = false, duration = 0, kind, quality, title, opts = {}, platform = '' }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, mode, url, index, named, duration, kind, quality, title: String(title || '').slice(0, 300), opts, platform,
    dir: path.join(DOWNLOAD_DIR, id),
    status: 'queued', phase: 'Na fila', percent: 0, lastPct: 0, speed: '', eta: '',
    error: null, file: null, size: 0, attempts: 0, createdAt: Date.now(), startedAt: 0, finishedAt: 0, proc: null,
  };
  jobs.set(id, job);
  persist(job);
  queue.push(job);
  pump();
  return job;
}

function cancelJob(job) {
  if (job.status === 'queued') {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    job.status = 'canceled';
    job.phase = 'Cancelado';
    job.finishedAt = Date.now();
    fs.rmSync(job.dir, { recursive: true, force: true });
    persist(job);
  } else if (job.status === 'running') {
    job.status = 'canceled'; // esperando a vez: o startJob encerra quando chegar
    job.stop?.();
  }
}

// Recupera tarefas do banco depois de um reinício: prontas continuam baixáveis, as que estavam
// na fila ou no meio voltam pra fila (até MAX_ATTEMPTS).
function recoverJobs() {
  let requeued = 0;
  for (const j of store.load(JOB_TTL_MS)) {
    const job = { ...j, dir: path.join(DOWNLOAD_DIR, j.id), lastPct: 0, speed: '', eta: '', proc: null };
    if (job.status === 'done' && !(job.file && fs.existsSync(job.file))) {
      job.status = 'expired';
      job.phase = 'Expirou';
      persist(job);
      continue;
    }
    if (ACTIVE.has(job.status)) {
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status = 'error';
        job.error = 'Foi interrompida várias vezes por reinícios do servidor.';
        job.finishedAt = Date.now();
      } else {
        job.status = 'queued';
        job.phase = 'Retomando depois do reinício';
        job.percent = 0;
        queue.push(job);
        requeued++;
      }
      persist(job);
    }
    jobs.set(job.id, job);
  }
  return requeued;
}

// Limpeza seletiva: só o que passou do prazo, nunca tarefa ativa.
function cleanup(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (ACTIVE.has(job.status) || !job.finishedAt || now - job.finishedAt <= JOB_TTL_MS) continue;
    fs.rmSync(job.dir, { recursive: true, force: true });
    if (job.status === 'done') {
      job.status = 'expired';
      job.phase = 'Expirou';
      persist(job);
    }
    jobs.delete(id);
  }
  // Pastas órfãs (de versões antigas ou tarefas apagadas do banco) mais velhas que o prazo.
  for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
    const job = jobs.get(name);
    if (job && ACTIVE.has(job.status)) continue;
    const dir = path.join(DOWNLOAD_DIR, name);
    try {
      if (!job && now - fs.statSync(dir).mtimeMs > JOB_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* sumiu no meio */ }
  }
  store.prune(now - HISTORY_MS);
  for (const [key, hit] of infoCache) if (now - hit.at > INFO_TTL_MS) infoCache.delete(key);
}

setInterval(() => {
  try {
    cleanup();
  } catch (e) {
    console.error(`[limpeza] ${e.message}`);
  }
}, 10 * 60_000).unref();

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

// Lê JSON com limite. Corpo grande demais rejeita na hora (antes ficava pendurado pra sempre).
function readJson(req, max = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      data += c;
      if (data.length > max) {
        failed = true;
        reject(new Error('Corpo grande demais'));
        req.resume();
      }
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, SECURITY_HEADERS).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
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
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(job.file).on('error', () => res.destroy()).pipe(res);
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
  const r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { 'user-agent': 'Convenus/1.0' } }).catch(() => null);
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
    ...SECURITY_HEADERS,
  });
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}

const clientIp = (req) => req.headers['x-real-ip'] || req.socket.remoteAddress;

// Troca o cookies.txt do YouTube pela página /renovar: valida ANTES de trocar.
async function renewCookies(req, res) {
  if (!auth.allowAttempt(`renew:${clientIp(req)}`, 5)) return sendJson(res, 429, { error: 'Muitas tentativas. Espera uns 15 minutos.' });
  let body;
  try {
    body = await readJson(req, 400_000);
  } catch {
    return sendJson(res, 400, { error: 'Arquivo inválido ou grande demais.' });
  }

  // Segura a vez no YouTube: nenhum outro yt-dlp usa cookies enquanto troca.
  await ytAcquire();
  try {
    await cookieFiles.renew({
      file: COOKIES,
      backupFile: COOKIES_PREV,
      masterFile: COOKIES_MASTER,
      raw: body.content,
      // Testa com o arquivo NOVO (sessão diferente da atual, então não há token reaproveitado).
      validate: (temp) => runCapture(['--js-runtimes', 'node', '--no-playlist', '--no-warnings', '--cookies', temp,
        '--simulate', '--print', 'title', '--', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], { timeoutMs: 90_000 }),
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, message: `Não troquei os cookies: ${e.message} Os que estavam em uso continuam lá.` });
  } finally {
    ytRelease();
  }
  lastRestoreAt = 0;
  ytState.lastOkAt = Date.now();
  ytState.lastBotAt = 0;
  infoCache.clear();
  auth.clearAttempts(`renew:${clientIp(req)}`);
  console.log('[cookies] renovados pela página /renovar: validados antes da troca');
  return sendJson(res, 200, { ok: true, message: 'Login renovado e testado. O YouTube voltou a funcionar!' });
}

async function statusPayload() {
  const sys = await systemChecks({ ytdlp: YTDLP, downloadDir: DOWNLOAD_DIR, proxy: PROXY, potUrl: POT_URL });
  const active = [...jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
  return {
    ok: sys.ytdlp.ok && sys.ffmpeg.ok && sys.disk.ok,
    youtube: ytHealthy(), // usado pelo banner da página
    youtubeLogin: ytLoggedIn(),
    node: { version: process.version, uptimeSec: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    queue: { running, queued: queue.length, active, ytWaiting: ytLock.waiters.length, maxRunning: MAX_RUNNING },
    ...sys,
  };
}

// Rotas abertas sem login: a tela de entrada, os ícones do app e o /health mínimo.
const PUBLIC_PATHS = new Set(['/entrar', '/api/login', '/health', '/manifest.webmanifest', '/icon.svg', '/icon-192.png',
  '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png', '/icon-maskable.svg', '/apple-touch-icon.png', '/favicon.ico']);
const isLocal = (req) => !req.headers['x-real-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://x');

  // CSRF: pedido que muda estado vindo de outro site é recusado (o cookie já é SameSite=Lax).
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
    let host = '';
    try {
      host = new URL(req.headers.origin).host;
    } catch { /* origin inválido */ }
    if (host !== req.headers.host) return sendJson(res, 403, { error: 'Origem não permitida.' });
  }

  if (pathname === '/health') {
    // Público: só "tá vivo". Detalhe só pra quem está na própria VPS (script de update, checagens).
    if (isLocal(req)) return sendJson(res, 200, await statusPayload());
    return sendJson(res, 200, { ok: !shuttingDown });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (!auth.allowAttempt(`login:${clientIp(req)}`)) return sendJson(res, 429, { error: 'Muitas tentativas. Espera uns 15 minutos.' });
    const body = await readJson(req).catch(() => ({}));
    if (!auth.checkToken(body.token)) return sendJson(res, 403, { error: 'Código errado.' });
    auth.clearAttempts(`login:${clientIp(req)}`);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(auth.newSession(), req) });
  }
  if (pathname === '/entrar') return serveStatic(req, res, '/entrar.html');

  if (!PUBLIC_PATHS.has(pathname) && !auth.sessionFrom(req)) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Entra com o código de acesso primeiro.' });
    res.writeHead(302, { location: `/entrar?next=${encodeURIComponent(req.url)}`, 'cache-control': 'no-store' });
    return res.end();
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', req, 0) });
  }

  if (pathname === '/api/status') return sendJson(res, 200, await statusPayload());

  if (pathname === '/renovar') return serveStatic(req, res, '/renovar.html');

  if (pathname === '/api/cookies' && req.method === 'POST') return renewCookies(req, res);

  if ((pathname === '/api/media' || pathname === '/api/image') && req.method === 'GET') return serveMedia(req, res, searchParams);

  if (pathname === '/api/info' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const url = normalizeUrl(body.url);
    if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
    const page = Math.min(Math.max(parseInt(body.page, 10) || 0, 0), 500);
    try {
      const info = await getInfo(url, page);
      if (info.items?.some((it) => it.isLive)) return sendJson(res, 400, { error: 'Lives ao vivo não dá pra converter.' });
      return sendJson(res, 200, info);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (pathname === '/api/jobs' && req.method === 'GET') {
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit'), 10) || 50, 1), 200);
    const list = store.history(limit).map((j) => {
      const live = jobs.get(j.id);
      return publicJob(live || j);
    });
    return sendJson(res, 200, { jobs: list });
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    if (shuttingDown) return sendJson(res, 503, { error: 'O servidor está reiniciando. Tenta de novo em alguns segundos.' });
    const body = await readJson(req).catch(() => ({}));
    const url = normalizeUrl(body.url);
    if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
    if (isProfileUrl(url)) return sendJson(res, 400, { error: 'Link de perfil não tem vídeo pra converter.' });
    const kind = ['mp4', 'mp3', 'wav', 'srt'].includes(body.kind) ? body.kind : null;
    if (!kind) return sendJson(res, 400, { error: 'Formato inválido.' });
    if (disk(DOWNLOAD_DIR).freeBytes < MIN_FREE_BYTES) return sendJson(res, 507, { error: 'O servidor está sem espaço em disco agora.' });
    // O item vem da busca que o servidor fez: nunca baixa um link arbitrário mandado pelo navegador.
    const page = Math.min(Math.max(parseInt(body.page, 10) || 0, 0), 500);
    let info;
    try {
      info = await getInfo(url, page);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
    const idx = Number.isInteger(body.item) ? body.item : 0;
    const item = info.items?.[idx];
    if (!item || item.kind === 'image') return sendJson(res, 400, { error: 'Esse item não dá pra converter.' });
    if (kind === 'mp4' && !item.native && !item.hls) return sendJson(res, 400, { error: 'Esse vídeo já vem em MP4: é só baixar.' });
    if (kind === 'mp4' && item.kind === 'audio') return sendJson(res, 400, { error: 'Isso é só áudio.' });

    // Legendas: só idiomas que a busca achou, e só em itens que o yt-dlp baixa.
    let subs = null;
    if (body.subs?.lang || kind === 'srt') {
      const found = (item.subs || []).find((x) => x.lang === body.subs?.lang);
      if (!item.native || item.search || !found) return sendJson(res, 400, { error: 'Essa legenda não está disponível pra esse vídeo.' });
      subs = { lang: found.lang, auto: found.auto, embed: kind === 'mp4' && body.subs.embed !== false };
    }

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
    const common = { kind, quality, title, opts: subs ? { subs } : {}, platform: info.platform || '' };
    const spec = item.search
      // Música (Spotify, Deezer, Apple Music): baixa a mesma faixa da aba de músicas do YouTube Music.
      ? { ...common, mode: 'search', url: `https://music.youtube.com/search?q=${encodeURIComponent(item.search)}#songs` }
      : item.native
        ? { ...common, mode: 'native', url: item.entryUrl || url, index: item.entryUrl ? null : item.index, named: Boolean(item.entryUrl) }
        : { ...common, mode: 'direct', url: item.url, duration: item.duration };
    return sendJson(res, 201, publicJob(createJob(spec)));
  }

  const m = pathname.match(/^\/api\/jobs\/([0-9a-f]{16})(\/file)?$/);
  if (m) {
    const job = jobs.get(m[1]) || store.get(m[1]);
    if (!job) return sendJson(res, 404, { error: 'Esse arquivo já expirou.' });
    if (m[2]) {
      if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return sendJson(res, 404, { error: 'Arquivo não está pronto.' });
      return serveFile(req, res, job);
    }
    if (req.method === 'DELETE') {
      if (jobs.has(job.id)) cancelJob(job);
      return sendJson(res, 200, publicJob(job));
    }
    return sendJson(res, 200, publicJob(job));
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  res.writeHead(405, SECURITY_HEADERS).end();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(redact(e.stack || e.message));
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno.' });
    else res.destroy();
  });
});

// Encerramento gracioso: para de aceitar, devolve tarefas em andamento pra fila (continuam no
// próximo start), mata os processos filhos e fecha o banco.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] encerrando: ${running} tarefa(s) em andamento voltam pra fila`);
  server.close();
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'queued';
      job.phase = 'Vai continuar depois do reinício';
      persist(job);
    }
  }
  // Se a tarefa ainda estava esperando a vez no YouTube, o startJob vê shuttingDown e sai.
  for (const job of jobs.values()) if (job.stop) job.stop();
  await proc.killAll(8000);
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  const requeued = recoverJobs();
  try {
    cleanup();
  } catch (e) {
    console.error(`[limpeza] ${e.message}`);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Convenus em http://${HOST}:${PORT} (proxy: ${PROXY ? 'WARP' : 'nenhum'}; ${requeued} tarefa(s) retomada(s))`);
    pump();
  });
}

module.exports = { jobArgs, subsList, redact, normalizeUrl, isPlaylistUrl, server };

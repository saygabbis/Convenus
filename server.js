'use strict';

// Convenus: YouTube, X, Instagram, Bluesky e outros -> MP4 / MP3 / WAV / imagens, via yt-dlp + ffmpeg.
// Sem dependências: só Node (>= 20), yt-dlp e ffmpeg no PATH.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const providers = require('./providers');
const proc = require('./lib/proc');
const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const cookieFiles = require('./lib/cookies');
const { systemChecks, disk } = require('./lib/health');
const { YtWorker } = require('./lib/ytworker');
const convert = require('./lib/convert');
const compressor = require('./lib/compress');
const gallery = require('./lib/gallery');
const clipper = require('./lib/clip');
const vod = require('./lib/vod');

// Tudo que o servidor cria (downloads, envios, banco) fica só pro dono do processo (tem outro
// usuário na VPS).
if (require.main === module) process.umask(0o077);

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
// Tudo some 1 h depois de pronto: o arquivo e a linha do histórico (sobrevive a reinícios até lá).
const JOB_TTL_MS = Number(process.env.JOB_TTL_MIN || 60) * 60_000;
const HISTORY_MS = JOB_TTL_MS;
// Cada navegador recebe um id aleatório (cookie HttpOnly) e só vê as próprias conversões.
const DEVICE_COOKIE = 'cv_dev';
const DEVICE_RE = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([A-Za-z0-9_-]{22,64})`);
// Busca fica guardada 30 min: o mesmo link de novo é na hora, e o download reaproveita a busca
// (os links de download do YouTube valem umas 6 h).
const INFO_TTL_MS = 30 * 60_000;
const INFO_TIMEOUT_MS = Number(process.env.INFO_TIMEOUT_SEC || 120) * 1000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MIN || 240) * 60_000;
const JOB_IDLE_MS = Number(process.env.JOB_IDLE_MIN || 10) * 60_000;
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_GB || 2) * 1024 ** 3;
const MAX_ATTEMPTS = 3; // reinícios no meio de uma tarefa antes de desistir dela
const PLAYLIST_PAGE = 200;
// Conversor de arquivos: tamanho máximo de cada envio.
const UPLOAD_MAX = Number(process.env.UPLOAD_MAX_MB || 4096) * 1024 ** 2;
const UPLOAD_ID_RE = /^u[0-9a-f]{16}$/;
// Buscas no yt-dlp ao mesmo tempo (o resto espera a vez): segura abuso sem travar o uso normal.
const MAX_INFO = Number(process.env.MAX_INFO || 4);
const INFO_CACHE_MAX = 400;
const MAX_ACTIVE_PER_IP = 300; // "baixar todas" de uma playlist de 200 cabe
const MAX_QUEUE = 1000;

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
  ...gallery.MEDIA_HOSTS,
];
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
// Outras plataformas (o yt-dlp suporta todas). Lista fechada pra não virar proxy aberto.
const OTHER_HOSTS = [
  'twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'instagram.com', 'reddit.com', 'redd.it', 'tiktok.com', 'facebook.com', 'fb.watch',
  'vimeo.com', 'twitch.tv', 'soundcloud.com', 'pinterest.com', 'pin.it', 'bsky.app', 'threads.net', 'threads.com',
  'dailymotion.com', 'dai.ly', 'kick.com', 'bilibili.com', 'b23.tv', 'streamable.com', 'tumblr.com', 'bandcamp.com',
  'open.spotify.com', 'deezer.com', 'music.apple.com',
  ...gallery.HOSTS,
];
const PLATFORM_NAMES = { 'x.com': 'X', 'twitter.com': 'X', 'fxtwitter.com': 'X', 'vxtwitter.com': 'X', 'fixupx.com': 'X', 'fixvx.com': 'X', 'redd.it': 'Reddit', 'fb.watch': 'Facebook', 'pin.it': 'Pinterest', 'dai.ly': 'Dailymotion', 'b23.tv': 'Bilibili', 'bsky.app': 'Bluesky', 'threads.com': 'Threads', 'tiktok.com': 'TikTok', 'soundcloud.com': 'SoundCloud', 'twitch.tv': 'Twitch', 'bilibili.com': 'Bilibili', 'open.spotify.com': 'Spotify', 'deezer.com': 'Deezer', 'music.apple.com': 'Apple Music' };
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

const jobs = new Map();
const infoCache = new Map();
const infoPending = new Map(); // mesma busca ao mesmo tempo = uma extração só
const uploads = new Map(); // id -> { id, device, name, size, at, src } (também em meta.json na pasta)
const uploadingNow = new Map(); // aparelho -> envios em andamento
// JSON completo do yt-dlp de cada vídeo buscado (url -> { at, raw, proxied }): o download usa
// ele com --load-info-json e não precisa extrair tudo de novo (~10 s a menos por download).
const rawInfo = new Map();
const queue = [];
let running = 0;
let shuttingDown = false;

// Nunca apaga a pasta inteira no start: arquivos prontos sobrevivem a reinícios.
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const store = new Store(DB_FILE);
const auth = new Auth(process.env.ADMIN_TOKEN_FILE || path.join(DATA_DIR, 'admin.token'));

// ---------- yt-dlp ----------

const isYouTube = (url) => YT_HOSTS.test(new URL(url).hostname);

// yt-dlp sempre aberto pras buscas (YTDLP_WORKER=0 desliga).
const ytWorker = new YtWorker({ ytdlp: YTDLP });
if (process.env.YTDLP_WORKER !== '0' && require.main === module) ytWorker.start();

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
// Instagram e X (conta descartável, enviada pela página /renovar): só o gallery-dl usa, pra listar perfis.
const SOCIAL_COOKIES = { Instagram: path.join(path.dirname(COOKIES), 'cookies-instagram.txt'), X: path.join(path.dirname(COOKIES), 'cookies-x.txt') };
const SOCIAL_DOMAINS = { Instagram: /^(#HttpOnly_)?\.?(www\.)?instagram\.com\t/, X: /^(#HttpOnly_)?\.?(www\.)?(x|twitter)\.com\t/ };
const SOCIAL_LOGIN = { Instagram: /\tsessionid\t/, X: /\tauth_token\t/ };
gallery.setSocialCookies((platform) => (SOCIAL_COOKIES[platform] && fs.existsSync(SOCIAL_COOKIES[platform]) ? SOCIAL_COOKIES[platform] : ''));
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
  const gal = gallery.match(url);
  if (gal) return gal.platform;
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

// Caracteres invisíveis que o celular põe ao copiar/compartilhar (espaço zero, marcas de direção).
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

// Aceita o link sozinho ou no meio de um texto ("Olha esse post: https://x.com/... via @fulano"),
// e link sem https:// ("x.com/fulano/status/123").
function extractUrl(raw) {
  const s = String(raw || '').replace(INVISIBLE, '').trim();
  let found = (s.match(/https?:\/\/[^\s<>"'“”‘’]+/i) || [])[0];
  if (!found) {
    const bare = (s.match(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'“”‘’]*)/i) || [])[1];
    if (bare) found = `https://${bare}`;
  }
  return (found || s).replace(/[)\].,;:!?…»]+$/, '');
}

function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(extractUrl(raw));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return null;
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
  return last ? redact(last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')).replace(/(?:\/(?:home|tmp|root|var|etc|usr)\/|[A-Z]:\\)[^\s'"]*/g, '…').slice(0, 300) : 'Deu erro na conversão.';
}

// Tira de mensagens de log o que pode ser segredo: query strings (URLs assinadas), cookies, tokens.
function redact(text) {
  return String(text || '')
    .replace(/(https?:\/\/[^\s?'"]+)\?[^\s'"]*/g, '$1?…')
    .replace(/(cookie|token|sid|sapisid|authorization)([=:]\s*)[^\s;,'"]+/gi, '$1$2…');
}

// yt-dlp que devolve texto (busca de informações). Nunca fica pendurado: timeout e limite de saída.
// Usa o yt-dlp sempre aberto quando ele está livre; senão (ou se ele cair no meio), o normal.
async function runCapture(args, { timeoutMs = INFO_TIMEOUT_MS, maxStdout = 64 * 1024 * 1024 } = {}) {
  let r = ytWorker.available() ? await ytWorker.run(args, { timeoutMs }) : null;
  if (r && r.stdout.length > maxStdout) r.overflow = true;
  if (!r || r.crashed) r = await proc.run(YTDLP, args, { timeoutMs, maxStdout, killOnOverflow: true }).done;
  if (r.code === 0 && !r.overflow) return r.stdout;
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'O yt-dlp não está instalado no servidor.' : 'Não consegui rodar o yt-dlp.');
  if (r.timedOut) throw new Error('A plataforma demorou demais pra responder. Tenta de novo.');
  if (r.overflow) throw new Error('Resposta grande demais (playlist enorme?).');
  throw new Error(friendlyError(r.stderr));
}

function isChannelUrl(url) {
  const { hostname, pathname } = new URL(url);
  return YT_HOSTS.test(hostname) && !/youtu\.be$/i.test(hostname)
    && /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/(featured|about|community|posts))?\/?$/.test(pathname);
}

// Categoria de perfil (aba de vídeos, faixas…) é lista de itens, não perfil.
const isProfileUrl = (url) => !sectionKind(url) && (Boolean(gallery.match(url)?.profile) || isChannelUrl(url) || Boolean(sectionsFor(url)) || Boolean(providers.match(url)?.profile));

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

function cachedInfo(url, page = 0, mix = false) {
  const hit = infoCache.get(`${url}#${mix ? 'mix' : ''}${page}`);
  return hit && Date.now() - hit.at < INFO_TTL_MS ? hit.info : null;
}

// mix = a lista "Mix" do YouTube que acompanha um vídeo (watch?v=…&list=RD…).
async function getInfo(url, page = 0, mix = false) {
  const key = `${url}#${mix ? 'mix' : ''}${page}`;
  const hit = cachedInfo(url, page, mix);
  if (hit) return hit;
  if (infoPending.has(key)) return infoPending.get(key);

  const p = withInfoSlot(() => (mix ? mixList(url, page) : resolveInfo(url, page)))
    .then((info) => {
      infoCache.set(key, { at: Date.now(), info });
      while (infoCache.size > INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
      return info;
    })
    .finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}

// Vagas de busca: no máximo MAX_INFO yt-dlp buscando ao mesmo tempo; fila de espera limitada.
const infoSlots = { free: MAX_INFO, waiters: [] };
async function withInfoSlot(fn) {
  if (infoSlots.free > 0) infoSlots.free--;
  else {
    if (infoSlots.waiters.length >= 60) throw new Error('O servidor está muito ocupado agora. Tenta de novo em um minuto.');
    await new Promise((r) => infoSlots.waiters.push(r));
  }
  try {
    return await fn();
  } finally {
    const next = infoSlots.waiters.shift();
    if (next) next();
    else infoSlots.free++;
  }
}

// Legendas que o yt-dlp achou: as enviadas pelo autor primeiro; das automáticas, só a do idioma
// original (o YouTube oferece tradução automática pra ~150 línguas, inútil na lista).
function subsList(e) {
  const out = [];
  for (const [lang, tracks] of Object.entries(e.subtitles || {})) {
    if (lang === 'live_chat' || !tracks?.length) continue;
    out.push({ lang, name: tracks[0].name || lang, auto: false });
  }
  // O YouTube manda o idioma original duas vezes ("en-orig" e "en"): fica só com o "-orig".
  const autos = Object.keys(e.automatic_captions || {});
  const origs = autos.filter((l) => l.endsWith('-orig'));
  const orig = origs.length ? origs : autos.filter((l) => l === e.language);
  for (const lang of orig) {
    if (out.some((x) => x.lang === lang.replace(/-orig$/, ''))) continue;
    out.push({ lang, name: `${(e.automatic_captions[lang][0]?.name || lang).replace(/\s*\(.*\)$/, '')} (automática)`, auto: true });
  }
  return out.slice(0, 40);
}

// yt-dlp -J → um item "nativo" por vídeo/áudio (playlist = vários, com o índice pro --playlist-items).
// Id do vídeo do YouTube direto do link (pra conferir as capas enquanto o yt-dlp trabalha).
function ytVideoId(url) {
  const u = new URL(url);
  if (!YT_HOSTS.test(u.hostname)) return null;
  const id = /youtu\.be$/i.test(u.hostname) ? u.pathname.slice(1).split('/')[0]
    : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/) || [])[1];
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

async function ytdlpItems(url) {
  const guessId = ytVideoId(url);
  const thumbsEarly = guessId ? thumbOptions(guessId) : null; // em paralelo com o yt-dlp
  const t0 = Date.now();
  let proxied = false;
  const raw = await withYt(url, () => {
    const args = baseArgs(url);
    proxied = args.includes('--proxy');
    return runCapture([...args, '-J', '--', url]);
  });
  const j = JSON.parse(raw);
  console.log(`[busca] ${platformOf(url)} em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const entries = j._type === 'playlist' && Array.isArray(j.entries) ? j.entries.filter(Boolean) : [j];
  if (j._type !== 'playlist' && j.formats?.length) rawInfo.set(url, { at: Date.now(), raw, proxied });
  while (rawInfo.size > 40) rawInfo.delete(rawInfo.keys().next().value); // teto de memória
  if (!entries.length) throw new Error('Não achei nenhum vídeo nesse link.');
  const items = entries.map((e, i) => {
    const formats = e.formats || [];
    // Codec não informado (Twitch e outros) também conta; "portrait" é o recorte vertical da Twitch, não o vídeo.
    const heights = [...new Set(formats.filter((f) => f.vcodec !== 'none' && f.height && !/portrait/i.test(f.format_id || '')).map((f) => f.height))].sort((a, b) => b - a);
    // Alguns sites (Facebook…) não dizem codec nem altura: é vídeo, só sem resoluções conhecidas (0 = melhor).
    const videoish = heights.length > 0 || formats.some((f) => f.vcodec !== 'none' && /^(mp4|webm|mov|mkv|flv|m3u8)$/.test(f.ext || ''));
    // VOD da Twitch de uma live que ainda está rolando: o yt-dlp marca como "ao vivo", mas o que já
    // foi gravado dá pra baixar (lib/vod.js). Guarda as versões (playlist de cada qualidade).
    const growing = Boolean(e.is_live) && /^TwitchVod$/i.test(e.extractor_key || '');
    const variants = growing
      ? formats.filter((f) => /m3u8/.test(f.protocol || '') && f.url && !/portrait/i.test(f.format_id || ''))
        .map((f) => ({ h: f.vcodec === 'none' || /audio/i.test(f.format_id || '') ? 0 : f.height || 0, url: f.url }))
      : null;
    return {
      ...(growing ? { growing: true, liveVariants: variants } : {}),
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
      isLive: Boolean(e.is_live) && !growing,
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
    thumbs: isYouTube(url) ? await (guessId === first.id ? thumbsEarly : thumbOptions(first.id)) : bestThumb(first),
  };
}

// Playlist do YouTube/YouTube Music ou set do SoundCloud: lista leve (sem consultar vídeo por vídeo).
function isPlaylistUrl(url) {
  if (sectionKind(url) || gallery.match(url)?.section) return true;
  const u = new URL(url);
  if (YT_HOSTS.test(u.hostname)) return u.pathname === '/playlist' || (u.searchParams.has('list') && !u.searchParams.has('v') && !/youtu\.be$/i.test(u.hostname));
  return /(^|\.)soundcloud\.com$/i.test(u.hostname) && /\/sets\//.test(u.pathname);
}

// ---------- perfil por categorias (vídeos, shorts, lives, playlists, faixas, clipes…) ----------
// Cada categoria é um link de "aba" que o yt-dlp lista como playlist; o site carrega uma por vez.

const YT_TABS = [['videos', 'Vídeos', 'video'], ['shorts', 'Shorts', 'video'], ['streams', 'Lives', 'video'], ['playlists', 'Playlists', 'list'], ['releases', 'Álbuns', 'list'], ['podcasts', 'Podcasts', 'list']];
const SC_TABS = [['tracks', 'Faixas', 'audio'], ['popular-tracks', 'Populares', 'audio'], ['albums', 'Álbuns', 'list'], ['sets', 'Playlists', 'list'], ['reposts', 'Reposts', 'audio']];
const SC_RESERVED = new Set(['discover', 'search', 'you', 'stream', 'charts', 'upload', 'pages', 'settings', 'messages', 'notifications', 'terms-of-use', 'pro', 'mobile', 'people', 'tags']);
const TW_RESERVED = new Set(['directory', 'videos', 'search', 'settings', 'subscriptions', 'inventory', 'wallet', 'downloads', 'p', 'jobs', 'turbo', 'prime']);

/** Se o link é de uma categoria de perfil, o tipo dos itens dela: 'video' | 'audio' | 'list' | 'post'. */
function sectionKind(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (YT_HOSTS.test(host) && !/youtu\.be$/i.test(host)) {
    const m = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/([a-z]+)\/?$/.exec(u.pathname);
    return m ? (YT_TABS.find((t) => t[0] === m[1]) || [])[2] || null : null;
  }
  if (/(^|\.)soundcloud\.com$/.test(host) && parts.length === 2 && !SC_RESERVED.has(parts[0])) return (SC_TABS.find((t) => t[0] === parts[1]) || [])[2] || null;
  if (/(^|\.)twitch\.tv$/.test(host) && parts.length === 2 && !TW_RESERVED.has(parts[0]) && ['videos', 'clips'].includes(parts[1])) return 'video';
  if (/(^|\.)tiktok\.com$/.test(host) && parts.length === 1 && /^@[\w.-]+$/.test(parts[0]) && u.hash === '#videos') return 'video';
  if (/(^|\.)bsky\.app$/.test(host) && parts[0] === 'profile' && parts.length === 2 && u.hash === '#midia') return 'post';
  return null;
}

/** Categorias de um link de perfil (ou null se não for perfil com categorias). */
function sectionsFor(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const mk = (list, base) => list.map(([id, label, kind]) => ({ id, label, kind, url: `${base}/${id}` }));
  if (isChannelUrl(url)) {
    const seg = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.exec(u.pathname)[1];
    return { platform: 'YouTube', sections: mk(YT_TABS, `https://www.youtube.com/${seg}`) };
  }
  if (/(^|\.)soundcloud\.com$/.test(host) && parts.length === 1 && !SC_RESERVED.has(parts[0])) {
    return { platform: 'SoundCloud', sections: mk(SC_TABS, `https://soundcloud.com/${parts[0]}`) };
  }
  if (/(^|\.)twitch\.tv$/.test(host) && parts.length === 1 && !TW_RESERVED.has(parts[0])) {
    return { platform: 'Twitch', sections: [
      { id: 'videos', label: 'Vídeos', kind: 'video', url: `https://www.twitch.tv/${parts[0]}/videos` },
      { id: 'clips', label: 'Clipes', kind: 'video', url: `https://www.twitch.tv/${parts[0]}/clips` },
    ] };
  }
  if (/(^|\.)tiktok\.com$/.test(host) && parts.length === 1 && /^@[\w.-]+$/.test(parts[0]) && !u.hash) {
    return { platform: 'TikTok', sections: [{ id: 'videos', label: 'Vídeos', kind: 'video', url: `https://www.tiktok.com/${parts[0]}#videos` }] };
  }
  if (/(^|\.)bsky\.app$/.test(host) && parts[0] === 'profile' && parts.length === 2 && !u.hash) {
    return { platform: 'Bluesky', sections: [{ id: 'midia', label: 'Fotos e vídeos', kind: 'post', url: `https://bsky.app/profile/${parts[1]}#midia` }] };
  }
  return null;
}

// Por que não tem categorias (plataformas que só mostram a lista de posts pra quem tá logado).
const NO_SECTIONS = {
  Instagram: 'O Instagram só mostra a lista de posts pra quem tá logado. Cola o link de cada post pra baixar.',
  X: 'O X só mostra a lista de posts pra quem tá logado. Cola o link de cada post pra baixar.',
};

// Bluesky: posts com foto/vídeo do perfil, 40 por página (a API pagina por cursor).
const bskyCursors = new Map(); // `${ator}:${página}` -> cursor da página
async function bskyMedia(url, page) {
  const actor = new URL(url).pathname.split('/').filter(Boolean)[1];
  const cursor = page ? bskyCursors.get(`${actor}:${page}`) : '';
  if (page && !cursor) throw new Error('Não tem mais posts.');
  const q = new URLSearchParams({ actor, filter: 'posts_with_media', limit: '40', ...(cursor ? { cursor } : {}) });
  const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${q}`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Convenus/1.0' } });
  if (!r.ok) throw new Error('O Bluesky não respondeu. Tenta de novo.');
  const j = await r.json();
  const items = [];
  for (const { post } of j.feed || []) {
    const e = post?.embed?.media || post?.embed;
    const imgs = e?.images || [];
    const thumb = imgs[0]?.thumb || e?.thumbnail || null;
    if (!thumb) continue;
    const rkey = String(post.uri || '').split('/').pop();
    items.push({
      kind: 'post',
      entryUrl: `https://bsky.app/profile/${post.author?.handle || actor}/post/${rkey}`,
      thumb,
      label: clean(post.record?.text || '', 120) || (e?.thumbnail ? 'Vídeo' : imgs.length > 1 ? `${imgs.length} fotos` : 'Foto'),
      badge: e?.thumbnail ? 'Vídeo' : imgs.length > 1 ? `${imgs.length} fotos` : 'Foto',
      page,
      pidx: items.length,
    });
  }
  if (j.cursor) bskyCursors.set(`${actor}:${page + 1}`, j.cursor);
  while (bskyCursors.size > 2000) bskyCursors.delete(bskyCursors.keys().next().value);
  if (!items.length && !page) throw new Error('Esse perfil não tem fotos nem vídeos.');
  return { type: 'post', platform: 'Bluesky', title: 'Fotos e vídeos', uploader: actor, playlist: true, section: true, page, total: 0, hasMore: Boolean(j.cursor) && items.length > 0, items, thumbs: [], avatar: null, duration: 0 };
}

// Playlists grandes vêm em páginas de 200: nunca carrega milhares de itens de uma vez na memória.
async function flatPlaylist(url, page = 0, { size = PLAYLIST_PAGE, mix = false } = {}) {
  const start = page * size + 1;
  const end = start + size - 1;
  // Mix: o link é de um vídeo (watch?v=…&list=RD…), então pede a lista em vez do vídeo sozinho.
  const args = mix ? [...baseArgs(url).filter((a) => a !== '--no-playlist'), '--yes-playlist'] : baseArgs(url);
  // O "#videos" do TikTok é só nosso (separa a categoria do perfil): o yt-dlp recebe o link limpo.
  const ytUrl = /(^|\.)tiktok\.com$/i.test(new URL(url).hostname) ? url.replace(/#.*$/, '') : url;
  const raw = await withYt(url, () => runCapture([...args, '-J', '--flat-playlist', '--playlist-start', String(start), '--playlist-end', String(end), '--', ytUrl]));
  const j = JSON.parse(raw);
  const sk = sectionKind(url);
  const audio = sk === 'audio' || (!sk && /soundcloud\.com/i.test(url));
  const yt = isYouTube(url);
  const items = (j.entries || []).filter((e) => e && (e.url || e.id)).map((e, pidx) => {
    // Categoria de playlists/álbuns: cada item é uma lista (abre em vez de baixar).
    const isList = sk === 'list' || e._type === 'playlist' || /[?&]list=|\/sets\/|\/albums?\//.test(e.url || '');
    const thumb = (e.thumbnails || []).filter((t) => t.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url
      || (/^https:/.test(e.thumbnail || '') ? e.thumbnail : null)
      || (e.id && yt && !isList ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : null);
    return {
      kind: isList ? 'list' : audio ? 'audio' : 'video',
      native: true,
      entryUrl: e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      ...(isList && e.playlist_count ? { count: e.playlist_count } : {}),
      ...(e.view_count ? { views: e.view_count } : {}),
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
  if (!items.length) throw new Error(page ? 'Não tem mais itens aqui.' : sk ? 'Não tem nada nessa categoria.' : 'Essa playlist tá vazia ou é privada.');
  const total = j.playlist_count || 0;
  if (isYouTube(url)) ytState.lastOkAt = Date.now();
  return {
    id: j.id,
    title: j.title || 'Playlist',
    uploader: j.channel || j.uploader || '',
    thumbnail: items[0].thumb,
    playlist: true,
    ...(sk ? { section: true } : {}),
    page,
    total: mix ? 0 : total || items.length,
    hasMore: !mix && total ? end < total : items.length === size,
    items,
    thumbs: [],
  };
}

// O resto da Mix de um vídeo, em páginas de 25 (cada página leva ~2 s; a Mix chega a centenas).
const MIX_PAGE = 25;
function mixId(url) {
  const u = new URL(url);
  const list = YT_HOSTS.test(u.hostname) && u.searchParams.get('v') ? u.searchParams.get('list') || '' : '';
  return /^RD[\w-]+$/.test(list) ? list : null;
}
async function mixList(url, page = 0) {
  if (!mixId(url)) throw new Error('Esse link não tem Mix.');
  if (page > 7) throw new Error('Não tem mais itens nessa Mix.');
  const u = new URL(url);
  // Só o vídeo e a lista: index/start_radio mudariam onde a Mix começa.
  const link = `https://${u.hostname}/watch?v=${encodeURIComponent(u.searchParams.get('v'))}&list=${encodeURIComponent(mixId(url))}`;
  const info = await flatPlaylist(link, page, { size: MIX_PAGE, mix: true });
  return { type: 'post', platform: platformOf(url), avatar: null, duration: 0, ...info, mix: true };
}

// Vídeo aberto dentro de uma playlist: oferece abrir a playlist inteira; dentro de uma Mix, mostrar o resto dela.
function listOffers(url, info) {
  const list = isYouTube(url) && new URL(url).searchParams.get('list');
  if (!list) return info;
  if (mixId(url)) info.mix = true;
  else if (!/^(RD|UL)/.test(list)) info.playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  return info;
}

// Card rápido de um vídeo do YouTube (~0,4 s): título e canal pelo oEmbed, capas pelo i.ytimg.
// A busca completa (resoluções, legendas) continua por trás e o download parte dela.
async function quickYt(url, id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const [o, thumbs] = await Promise.all([
    fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    thumbOptions(id),
  ]);
  if (!o?.title) return null;
  const thumb = thumbs[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return listOffers(url, {
    type: 'post', platform: platformOf(url), avatar: null, partial: true,
    id, title: clean(o.title, 300), uploader: clean(o.author_name, 120), thumbnail: thumb, duration: 0, thumbs,
    items: [{ kind: 'video', native: true, index: null, heights: [0, 1080, 720, 480, 360], hasAudio: true, thumb, duration: 0, width: 0, height: 0, isLive: false, subs: [] }],
  });
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
  // Sites de arte (Pixiv, DeviantArt, ArtStation, Patreon...): lib/gallery.js.
  const gal = gallery.match(url);
  if (gal) {
    if (gal.section) return gal.section(page);
    return gal.profile ? gal.profile() : gal.post();
  }
  const sk = sectionKind(url);
  if (sk === 'post') return bskyMedia(url, page);
  if (sk) {
    const list = await flatPlaylist(url, page).catch(async (e) => {
      // TikTok: o yt-dlp às vezes não lista o perfil; o gallery-dl acha os vídeos.
      const tt = /(^|\.)tiktok\.com$/i.test(new URL(url).hostname) && new URL(url).pathname.match(/^\/@([\w.-]+)/);
      if (!tt) throw e;
      return gallery.tiktokList(tt[1], page);
    });
    return { type: 'post', platform: platformOf(url), avatar: null, thumbs: [], duration: 0, ...list };
  }
  const secs = sectionsFor(url);
  if (isChannelUrl(url)) return { ...(await getChannel(url)), sections: secs.sections };

  const extra = providers.match(url);
  if (extra?.profile && !(secs && extra.platform === 'TikTok')) {
    const social = gallery.socialSections(extra.platform, new URL(url).pathname.split('/').filter(Boolean)[0]);
    return { type: 'profile', platform: extra.platform, ...(await extra.profile()), sections: secs?.sections || social || [], sectionsNote: social ? '' : NO_SECTIONS[extra.platform] || '' };
  }
  // Perfil sem API própria (SoundCloud, Twitch, TikTok): o cabeçalho sai da primeira categoria.
  if (secs) {
    // Busca direto (já está dentro de uma vaga de busca) e guarda: o site pede essa categoria logo em seguida.
    const sec0 = secs.sections[0].url;
    const first = await flatPlaylist(sec0).then((info) => {
      const full = { type: 'post', platform: secs.platform, avatar: null, thumbs: [], duration: 0, ...info };
      infoCache.set(`${sec0}#0`, { at: Date.now(), info: full });
      return full;
    }).catch((e) => ({ error: e.message }));
    // Nome e foto: o oEmbed público da plataforma (SoundCloud e TikTok têm), senão o que a lista trouxe.
    const oembed = { SoundCloud: 'https://soundcloud.com/oembed?format=json&url=', TikTok: 'https://www.tiktok.com/oembed?url=' }[secs.platform];
    const oe = oembed ? await fetch(oembed + encodeURIComponent(url.replace(/#.*$/, '')), { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Convenus/1.0' } })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) : {};
    const handle = new URL(url).pathname.split('/').filter(Boolean)[0];
    const avatar = /^https:\/\//.test(oe.thumbnail_url || '') && hostIn(new URL(oe.thumbnail_url).hostname, MEDIA_HOSTS) ? oe.thumbnail_url : null;
    return {
      type: 'profile', platform: secs.platform,
      title: clean(oe.author_name || first.uploader || String(first.title || '').replace(/\s*\((tracks|videos|clips)\)$/i, '') || handle, 120),
      handle, followers: 0, avatar, banner: null, sections: secs.sections,
    };
  }

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

  return listOffers(url, { ...base, ...(await ytdlpItems(url)) });
}

// Download a partir da busca salva: sem cookies (os links já vêm prontos e assinados), então não
// mexe no login e não precisa esperar a vez no YouTube. Mesmo caminho de rede da busca (os links
// do YouTube valem só pro IP que buscou).
function loadedArgs(job) {
  return ['--js-runtimes', 'node', '--no-warnings', '--no-color', ...(job.loaded.proxied && PROXY ? ['--proxy', PROXY] : [])];
}

function jobArgs(job) {
  const args = [
    ...(job.loaded ? loadedArgs(job) : baseArgs(job.url)),
    // Pedaços de 10 MB: o YouTube limita a velocidade de downloads longos de uma vez só.
    '--http-chunk-size', '10M', '--concurrent-fragments', '4',
    // --print deixa o yt-dlp em modo silencioso: sem --progress ele nem mostra o progresso (a fila ficava em 0%).
    '--newline', '--progress',
    '--progress-template', 'download:@@P %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:@@F %(filepath)s',
    '--windows-filenames',
    '-P', job.dir,
    // % no título seria lido como campo do yt-dlp (%(http_headers)s etc.): vira %% (um % literal).
    '-o', job.mode === 'search' || job.named ? `${safeName(job.title).replace(/%/g, '%%')}.%(ext)s` : '%(title).150B.%(ext)s',
  ];
  const subs = job.opts?.subs;
  const subArgs = subs ? [subs.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', subs.lang] : [];

  if (job.kind === 'srt') {
    // Só a legenda, em .srt (o after_move não roda sem download: o arquivo é achado no fim).
    args.push('--skip-download', ...subArgs, '--convert-subs', 'srt');
  } else if (job.kind === 'mp4' || job.kind === 'gif') {
    // GIF: baixa o vídeo (até 720p, que é mais do que o GIF usa) e o ffmpeg faz o resto no fim.
    const h = job.kind === 'gif' ? 720 : job.quality;
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
  if (job.kind !== 'srt') {
    // Progresso de verdade também na conversão/junção: o ffmpeg grava quanto já fez num arquivo
    // (out_time_us), e a duração vem do @@D. Sem isso a barra parava cheia piscando.
    const prog = `-progress "${path.join(job.dir, PROGRESS_FILE)}"`;
    args.push('--print', 'before_dl:@@D %(duration)s',
      '--postprocessor-args', `ExtractAudio+ffmpeg_o:${prog}`, '--postprocessor-args', `Merger+ffmpeg_o:${prog}`);
  }

  // Cortar: baixa só o trecho escolhido.
  if (job.kind !== 'srt') args.push(...clipper.ytdlpSection(job.opts?.clip));

  if (job.loaded) {
    args.push('--load-info-json', job.loaded.file);
    return args;
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
    expiresAt: job.status === 'done' ? expiryOf(job) : 0,
    ...(job.opts?.clip ? { clip: { start: job.opts.clip.start, end: job.opts.clip.end, crop: Boolean(job.opts.clip.crop) } } : {}),
    // Conversão de arquivo: de que formato veio e se o resultado é imagem (botão de copiar).
    ...(job.mode === 'file' ? {
      from: job.opts?.src?.from || job.opts?.src?.ext || '',
      image: Boolean(job.file) && convert.IMAGE_OUT.has(path.extname(job.file).slice(1).toLowerCase()),
      ...(job.kind === 'compress' ? { target: job.opts?.compress?.mb || 0, note: job.opts?.note || '', missed: Boolean(job.opts?.missed), ext: job.file ? path.extname(job.file).slice(1).toLowerCase() : '' } : {}),
    } : {}),
  };
}

// Arquivo dentro da pasta da tarefa (nunca um caminho que escapou dela).
const inside = (file, dir) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);

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
  // Recorte do quadro / GIF: depois do download, mais uma passada no ffmpeg (a vaga continua ocupada).
  if (r.code === 0 && !job.posted && job.status !== 'canceled' && !shuttingDown && job.mode !== 'direct' && job.mode !== 'vod' && job.mode !== 'file'
    && clipper.needsPost(job.opts?.clip, job.kind) && job.file && inside(job.file, job.dir) && fs.existsSync(job.file)) {
    job.posted = true;
    return postProcess(job);
  }
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

  if (job.kind === 'srt' && job.mode !== 'file' && r.code === 0 && !job.file) {
    const sub = fs.existsSync(job.dir) && fs.readdirSync(job.dir).find((f) => /\.(srt|vtt|ass)$/i.test(f));
    if (sub) job.file = path.join(job.dir, sub);
  }

  if (job.status === 'canceled') {
    fs.rmSync(job.dir, { recursive: true, force: true });
    job.phase = 'Cancelado';
  } else if (r.code === 0 && job.file && inside(job.file, job.dir) && fs.existsSync(job.file) && fs.statSync(job.file).isFile()) {
    job.status = 'done';
    if (isYouTubeJob(job)) ytState.lastOkAt = Date.now();
    job.phase = 'Pronto';
    job.percent = 100;
    job.size = fs.statSync(job.file).size;
  } else {
    job.status = 'error';
    job.error = r.error ? 'Não consegui iniciar o programa de download no servidor.'
      : job.mode === 'file' && !r.timedOut && !r.idle ? convert.friendly(r.stderr)
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
  if (job.status === 'done') capPile(job.finishedAt);
  persist(job);
  pump();
}

const runOpts = (onStdout) => ({ timeoutMs: JOB_TIMEOUT_MS, idleMs: JOB_IDLE_MS, maxStdout: 256 * 1024, onStdout });

// Barra de progresso do ffmpeg (out_time_us em pipe:1) dentro da faixa [from, 100).
const ffProgress = (job, total, from = 0) => (d) => {
  const m = String(d).match(/out_time_us=(\d+)/g);
  if (m && total) {
    job.percent = Math.max(job.percent, Math.min(99, from + (100 - from) * (Number(m.pop().split('=')[1]) / 1e6 / total)));
    persist(job, { progress: true });
  }
};

// GIF ou recorte do quadro a partir do vídeo que o yt-dlp baixou.
function postProcess(job) {
  const c = job.opts.clip;
  const input = job.file;
  const output = path.join(job.dir, `${safeName(job.title)}${job.kind === 'gif' ? '.gif' : ' (recorte).mp4'}`);
  job.phase = job.kind === 'gif' ? 'Fazendo o GIF' : 'Recortando o vídeo';
  job.speed = '';
  job.eta = '';
  persist(job);
  const h = proc.run('ffmpeg', clipper.postArgs(c, job.kind, input, output, 'pipe:1'), runOpts(ffProgress(job, clipper.clipLen(c, job.duration), job.percent)));
  job.proc = h.child;
  job.stop = h.stop;
  h.done.then((r) => {
    if (r.code === 0 && fs.existsSync(output)) {
      if (input !== output) fs.rmSync(input, { force: true });
      job.file = output;
    }
    finishJob(job, r);
  });
}

// Vídeo/áudio direto (X, Instagram, TikTok…): o ffmpeg lê o arquivo original e converte o áudio.
// live: { input, offset, len } quando vem de uma live da Twitch ainda gravando (playlist montada aqui).
function startDirectJob(job, live = null) {
  const ext = job.kind;
  const c = job.opts?.clip;
  job.file = path.join(job.dir, `${safeName(job.title)}.${ext}`);
  job.phase = ext === 'gif' ? 'Fazendo o GIF' : c && ext === 'mp4' ? 'Cortando o vídeo' : ext === 'mp4' ? 'Baixando vídeo' : `Convertendo pra ${ext.toUpperCase()}`;
  // Trecho: o ffmpeg pula direto pro início (-ss antes do -i) e para no fim.
  // Na live a playlist já começa no trecho: só o deslocamento dentro do 1º pedaço (depois do -i).
  const seek = live ? [] : c ? [...(c.start > 0 ? ['-ss', String(c.start)] : []), ...(c.end ? ['-to', String(c.end)] : [])] : [];
  const after = live ? ['-ss', String(live.offset), '-t', String(live.len)] : [];
  const input = live ? ['-protocol_whitelist', 'file,http,https,tcp,tls', '-i', live.input] : ['-i', job.url];
  let codec;
  if (ext === 'gif') codec = ['-filter_complex', clipper.gifFilter(c), '-loop', '0', '-an'];
  else if (ext === 'mp4' && live && !c?.crop) codec = ['-c', 'copy', '-movflags', '+faststart'];
  else if (ext === 'mp4' && c) {
    // Cortado (e talvez recortado no quadro): recodifica pra cortar no quadro exato.
    codec = [...(c.crop ? ['-vf', clipper.cropFilter(c.crop)] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  } else if (ext === 'mp4') codec = ['-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'];
  else codec = ['-vn', ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${job.quality}k`] : ['-c:a', 'pcm_s16le'])];
  const h = proc.run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', ...(live ? [] : ['-user_agent', 'Convenus/1.0']), ...seek, ...input, ...after,
    '-map_metadata', '-1', ...(ext === 'gif' ? [] : ['-metadata', `title=${job.title}`]), ...codec,
    '-progress', 'pipe:1', '-nostats', job.file,
  ], runOpts(ffProgress(job, live ? live.len : c ? clipper.clipLen(c, job.duration) : job.duration)));
  job.proc = h.child;
  job.stop = h.stop;
  h.done.then((r) => finishJob(job, r));
}

const fmtHours = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`; };

// Live da Twitch ainda rolando: lê a playlist agora, monta uma fechada só com o trecho e baixa.
async function startVodJob(job) {
  job.phase = 'Lendo a live';
  persist(job);
  const c = job.opts?.clip;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    const r = await fetch(job.url, { signal: ac.signal, headers: { 'user-agent': gallery.BROWSER_UA } }).finally(() => clearTimeout(timer));
    if (!r.ok) throw new Error(`A Twitch recusou a live (HTTP ${r.status}).`);
    const s = vod.subset(await r.text(), job.url, c?.start || 0, c?.end || 0);
    if (s.len > vod.MAX_SEC + 1) throw new Error(`Esse trecho tem ${Math.round(s.len / 3600)} h: escolhe até ${vod.MAX_SEC / 3600} h no Cortar.`);
    const input = path.join(job.dir, 'trecho.m3u8');
    fs.writeFileSync(input, s.text, { mode: 0o600 });
    job.duration = s.len;
    startDirectJob(job, { input, offset: s.offset, len: s.len });
  } catch (e) {
    finishJob(job, { code: 1, stderr: `ERRO: ${e.name === 'AbortError' ? 'A Twitch demorou demais pra responder.' : e.message}` });
  }
}

// Arquivo enviado: converte com o programa certo (lib/convert.js).
function startFileJob(job) {
  const id = job.opts?.upload;
  const input = UPLOAD_ID_RE.test(id || '') ? path.join(DOWNLOAD_DIR, id, 'in') : '';
  if (!input || !fs.existsSync(input)) return finishJob(job, { code: 1, stderr: 'ERRO: O arquivo enviado já expirou. Envia de novo.' });
  job.phase = 'Convertendo';
  persist(job);
  const h = convert.run({
    info: job.opts.src, to: job.kind, input, dir: job.dir, base: safeName(job.title), name: job.opts.name || 'arquivo', opts: job.opts,
    onProgress: (p) => {
      job.percent = p;
      persist(job, { progress: true });
    },
  });
  job.stop = h.stop;
  h.done.then((r) => {
    if (r.file) job.file = r.file;
    // Compressão: quanto ficou (ou o aviso de que não deu pra chegar no alvo).
    if (r.note) job.opts = { ...job.opts, note: r.note, missed: Boolean(r.missed) };
    finishJob(job, r);
  });
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
  if (job.mode === 'vod') return startVodJob(job);
  if (job.mode === 'file') return startFileJob(job);
  // Tem a busca guardada: baixa direto dela, sem esperar a vez no YouTube.
  if (job.preload) {
    const file = path.join(job.dir, '.busca.info.json');
    fs.writeFileSync(file, job.preload.raw, { mode: 0o600 });
    job.loaded = { file, proxied: job.preload.proxied };
    job.preload = null;
    job.phase = 'Preparando o download';
    return runYtdlpJob(job);
  }
  if (isYouTubeJob(job)) {
    job.phase = 'Esperando a vez no YouTube';
    await ytAcquire();
    job.ytLocked = true;
    if (job.status === 'canceled' || shuttingDown) return finishJob(job, { code: 1, stderr: '' });
    if (!ytLoggedIn()) restoreCookies();
    job.phase = 'Preparando o download';
  }
  runYtdlpJob(job);
}

// Quanto do total é download (o resto é o ffmpeg): juntar MP4 é cópia rápida; MP3/WAV recodificam.
const DL_SHARE = { mp4: 0.9, mp3: 0.55, wav: 0.6, gif: 0.6 };
const PROGRESS_FILE = '.progresso';

// Último out_time_us do arquivo de progresso do ffmpeg (lê só o fim: ele cresce a conversão toda).
function lastOutTime(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len);
    const m = b.toString('latin1').match(/out_time_us=(\d+)/g);
    return m ? Number(m.pop().split('=')[1]) : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const fmtEta = (s) => {
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function runYtdlpJob(job) {
  let streams = 0;
  let mediaDur = 0;
  let ppTimer = null;
  let ppStart = 0;
  // Uma barra só, do começo ao fim: download (vídeo e áudio) + conversão/junção no ffmpeg.
  const dlShare = DL_SHARE[job.kind] || 1;
  const overall = (dl, pp) => Math.min(99.5, 100 * (dlShare * dl + (1 - dlShare) * pp));
  // As linhas [Merger]/[ExtractAudio] não aparecem (o --print silencia o yt-dlp): quem diz que a
  // conversão começou é o próprio arquivo de progresso do ffmpeg, olhado desde o início do download.
  const watchPP = () => {
    if (ppTimer || !mediaDur) return;
    const file = path.join(job.dir, PROGRESS_FILE);
    ppTimer = setInterval(() => {
      const us = lastOutTime(file);
      if (!us) return;
      if (!ppStart) {
        ppStart = Date.now();
        job.phase = job.kind === 'mp4' ? 'Juntando vídeo e áudio' : `Convertendo pra ${job.kind.toUpperCase()}`;
        job.speed = '';
      }
      const frac = Math.min(1, us / 1e6 / mediaDur);
      job.percent = Math.max(job.percent, overall(1, frac));
      const left = frac > 0.02 && frac < 1 ? ((Date.now() - ppStart) / 1000) * (1 - frac) / frac : 0;
      job.eta = left >= 1 ? fmtEta(left) : '';
      persist(job, { progress: true });
    }, 700);
  };
  const onLine = (line) => {
    if (line.startsWith('@@P ')) {
      const [pct, speed, eta] = line.slice(4).split('|').map((x) => x.trim());
      const n = parseFloat(pct);
      if (!Number.isNaN(n)) {
        if (n < job.lastPct - 50) streams++;
        job.lastPct = n;
        // MP4: vídeo e depois áudio (o áudio é bem menor). MP3/WAV: um só.
        const dl = job.kind === 'mp4' ? (streams === 0 ? 0.85 * n / 100 : 0.85 + 0.15 * n / 100) : n / 100;
        if (!ppStart) job.percent = overall(Math.min(1, dl), 0);
      }
      if (ppStart) return;
      job.speed = speed && speed !== 'NA' && speed !== 'Unknown' ? speed : '';
      job.eta = eta && eta !== 'NA' && eta !== 'Unknown' ? eta : '';
      job.phase = job.kind === 'mp4' ? (streams === 0 ? 'Baixando vídeo' : 'Baixando áudio') : 'Baixando áudio';
      persist(job, { progress: true });
    } else if (line.startsWith('@@D ')) {
      mediaDur = parseFloat(line.slice(4)) || 0;
      watchPP();
    } else if (line.startsWith('@@F ')) {
      job.file = line.slice(4).trim();
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

  h.done.then(async (r) => {
    clearInterval(ppTimer);
    fs.rmSync(path.join(job.dir, PROGRESS_FILE), { force: true });
    if (job.loaded) {
      fs.rmSync(job.loaded.file, { force: true });
      // Link da busca vencido ou recusado: refaz do jeito completo (busca nova, com a vez no YouTube).
      if (r.code !== 0 && !shuttingDown && job.status !== 'canceled') {
        console.log(`[job ${job.id}] download pela busca salva falhou; refazendo do zero`);
        job.loaded = null;
        job.phase = 'Tentando de novo';
        job.percent = 0;
        job.lastPct = 0;
        if (isYouTubeJob(job)) {
          job.phase = 'Esperando a vez no YouTube';
          await ytAcquire();
          job.ytLocked = true;
          if (job.status === 'canceled' || shuttingDown) return finishJob(job, { code: 1, stderr: '' });
          if (!ytLoggedIn()) restoreCookies();
          job.phase = 'Preparando o download';
        }
        return runYtdlpJob(job);
      }
      job.loaded = null;
    }
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

function createJob({ mode = 'native', url, index = null, named = false, duration = 0, kind, quality, title, opts = {}, platform = '', device = null, preload = null, ip = '' }) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, mode, url, index, named, duration, kind, quality, title: String(title || '').slice(0, 300), opts, platform, device, preload, ip,
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

// "Limpar" no site: tarefa terminada some de vez (arquivo e histórico), sem esperar a 1 h.
function forgetJob(job) {
  fs.rmSync(path.join(DOWNLOAD_DIR, job.id), { recursive: true, force: true });
  jobs.delete(job.id);
  store.delete(job.id);
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

// Arquivo grande ocupa o disco à toa: com mais de 1 GB fica só 10 min (em vez de 1 h). E se os
// prontos somarem 1 GB ou mais, todos passam a ter no máximo 10 min a partir daí.
const BIG_BYTES = Number(process.env.BIG_FILE_GB || 1) * 1024 ** 3;
const PILE_BYTES = Number(process.env.PILE_GB || 1) * 1024 ** 3;
const SHORT_TTL_MS = Number(process.env.SHORT_TTL_MIN || 10) * 60_000;
function expiryOf(job) {
  if (!job.finishedAt) return 0;
  const base = job.finishedAt + (job.size > BIG_BYTES ? SHORT_TTL_MS : JOB_TTL_MS);
  return job.expiresAt ? Math.min(job.expiresAt, base) : base;
}
function capPile(now = Date.now()) {
  let total = 0;
  const done = [];
  for (const job of jobs.values()) {
    if (job.status !== 'done' || !job.finishedAt) continue;
    total += job.size || 0;
    done.push(job);
  }
  if (total < PILE_BYTES) return;
  for (const job of done) job.expiresAt = Math.min(expiryOf(job), now + SHORT_TTL_MS);
}

// Limpeza seletiva: só o que passou do prazo, nunca tarefa ativa.
function cleanup(now = Date.now()) {
  capPile(now);
  for (const [id, job] of jobs) {
    if (ACTIVE.has(job.status) || !job.finishedAt || now <= expiryOf(job)) continue;
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
  for (const [key, hit] of rawInfo) if (now - hit.at > INFO_TTL_MS) rawInfo.delete(key);
  for (const [id, u] of uploads) if (now - u.at > JOB_TTL_MS) uploads.delete(id);
}

setInterval(() => {
  try {
    cleanup();
  } catch (e) {
    console.error(`[limpeza] ${e.message}`);
  }
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

// Cabeçalhos de proteção em TODA resposta. HSTS: navegador só fala HTTPS com o site.
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), browsing-topics=()',
  'x-permitted-cross-domain-policies': 'none',
};
// Respostas que não são página (JSON, arquivos): nada roda nem se aninha nelas.
const SECURITY_HEADERS = { ...BASE_HEADERS, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox" };

// Páginas: só os scripts escritos nelas rodam (hash de cada <script>), nada de script de fora.
const pageCache = new Map();
function htmlPage(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = pageCache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const body = fs.readFileSync(file);
  const hashes = [...body.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  const csp = [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const page = { mtime, body, csp };
  pageCache.set(file, page);
  return page;
}

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

// Páginas de administração só pelos caminhos delas (/entrar, /renovar), nunca pelo .html direto.
const PRIVATE_PAGES = new Set(['entrar.html', 'renovar.html']);

function shareFallback(req, res) {
  const len = Number(req.headers['content-length']) || 0;
  const go = (q) => res.writeHead(303, { location: q ? `/?${q}` : '/', ...SECURITY_HEADERS }).end();
  if (!len || len > 256 * 1024) { req.resume(); return go(''); }
  const chunks = [];
  let got = 0;
  req.on('data', (c) => { got += c.length; if (got <= 256 * 1024) chunks.push(c); });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const q = new URLSearchParams();
    for (const k of ['url', 'text', 'title']) {
      const m = body.match(new RegExp(`name="${k}"\\r?\\n(?:[^\\r\\n]+\\r?\\n)*\\r?\\n([^\\r\\n]{1,4000})`));
      if (m && m[1].trim()) q.set(k, m[1].trim());
    }
    go(q.toString());
  });
}

function serveStatic(req, res, pathname, { page = null } = {}) {
  let rel = page;
  if (!rel) {
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      rel = '';
    }
  }
  const file = path.join(PUBLIC_DIR, rel);
  const hidden = !page && (PRIVATE_PAGES.has(rel) || rel.split(/[\\/]/).some((x) => x.startsWith('.')) || rel.includes('\0'));
  if (hidden || !rel || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
    return;
  }
  const ext = path.extname(file);
  // Página e manifesto: sempre confere se mudou (o app instalado no celular atualiza sozinho).
  const cache = ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=86400';
  if (ext === '.html') {
    const p = htmlPage(file);
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': cache, ...BASE_HEADERS, 'content-security-policy': p.csp });
    return res.end(req.method === 'HEAD' ? undefined : p.body);
  }
  // Service worker: sempre o mais novo, e sem o "sandbox" do CSP dos arquivos (worker não roda sandboxed).
  if (rel === 'sw.js') {
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-cache', ...BASE_HEADERS, 'content-security-policy': "default-src 'none'" });
    return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache, ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function serveFile(req, res, job) {
  if (!inside(job.file, path.join(DOWNLOAD_DIR, job.id))) return sendJson(res, 404, { error: 'Arquivo não está pronto.' });
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
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hostIn(u.hostname.toLowerCase(), MEDIA_HOSTS)) return sendJson(res, 400, { error: 'Host não permitido.' });

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  // CDNs de arte: navegador comum, e o Referer que alguns exigem (o Pixiv recusa sem).
  const art = hostIn(u.hostname.toLowerCase(), gallery.MEDIA_HOSTS);
  const referer = gallery.refererFor(u.hostname.toLowerCase());
  const r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { 'user-agent': art ? gallery.BROWSER_UA : 'Convenus/1.0', ...(referer ? { referer } : {}) } }).catch(() => null);
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

// Prévia do cortador: o vídeo (baixa qualidade) de um item JÁ buscado, repassado com Range pra poder pular.
// Só serve o que a busca do servidor achou: nunca um link mandado pelo navegador.
async function servePreview(req, res, params) {
  const url = normalizeUrl(params.get('u'));
  const i = Math.max(0, parseInt(params.get('i'), 10) || 0);
  const info = url && cachedInfo(url, 0);
  const item = info?.items?.[i];
  if (!item || item.kind === 'image') return sendJson(res, 404, { error: 'Busca o link de novo.' });
  let src = '';
  let headers = { 'user-agent': 'Convenus/1.0' };
  if (item.url && !item.native) {
    try {
      if (hostIn(new URL(item.url).hostname.toLowerCase(), MEDIA_HOSTS)) src = item.url;
    } catch { /* link estranho: sem prévia */ }
  } else if (item.native) {
    const saved = rawInfo.get(item.entryUrl || url);
    // Busca que passou pelo WARP: o link só vale pro IP do WARP, e o fetch não fala SOCKS.
    if (saved && !saved.proxied) {
      const pf = clipper.previewFormat(JSON.parse(saved.raw).formats, item.kind === 'audio');
      if (pf) {
        src = pf.f.url;
        headers = { ...(pf.f.http_headers || {}) };
      }
    }
  }
  if (!src) return sendJson(res, 404, { error: 'Esse vídeo não tem prévia, mas dá pra cortar pelos tempos.' });

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const range = /^bytes=\d*-\d*$/.test(req.headers.range || '') ? req.headers.range : 'bytes=0-';
  const r = await fetch(src, { signal: ac.signal, headers: { ...headers, range } }).catch(() => null);
  const type = (r?.headers.get('content-type') || '').split(';')[0].trim();
  if (!r || !(r.status === 200 || r.status === 206) || !r.body || !/^(video|audio)\/|octet-stream/.test(type)) return sendJson(res, 502, { error: 'Não consegui carregar a prévia.' });
  const out = { 'content-type': /octet-stream/.test(type) ? (item.kind === 'audio' ? 'audio/mp4' : 'video/mp4') : type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...SECURITY_HEADERS };
  for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) out[h] = r.headers.get(h);
  res.writeHead(r.status, out);
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}

const clientIp = (req) => req.headers['x-real-ip'] || req.socket.remoteAddress;

// Limite de pedidos por IP (janela fixa). Barato e suficiente contra robô martelando a API.
const hits = new Map();
function tooMany(req, res, name, max, windowMs) {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  let e = hits.get(key);
  if (!e || now >= e.reset) {
    e = { n: 0, reset: now + windowMs };
    hits.set(key, e);
  }
  if (++e.n <= max) return false;
  sendJson(res, 429, { error: 'Muitos pedidos seguidos. Espera um pouquinho e tenta de novo.' }, { 'retry-after': String(Math.ceil((e.reset - now) / 1000)), connection: 'close' });
  req.resume();
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of hits) if (now >= e.reset) hits.delete(k);
}, 60_000).unref();

// ---------- envio de arquivos (conversor) ----------

function cleanFileName(raw) {
  let n = String(raw || '');
  try {
    n = decodeURIComponent(n);
  } catch { /* nome sem codificação: usa como veio */ }
  n = n.replace(INVISIBLE, '').split(/[\\/]/).pop() || '';
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*%]/g, '_').replace(/^[.\s]+/, '').trim();
  if (n.length > 120) n = n.slice(0, 100) + n.slice(-20);
  return n || 'arquivo';
}

const uploadView = (m) => ({
  id: m.id, name: m.name, size: m.size, kind: m.src.from === 'svg' ? 'image' : m.src.kind, ext: m.src.from || m.src.ext,
  desc: convert.describe(m.src), targets: convert.targets(m.src),
  // Pra rodinha de compressão estimar o resultado (resolução, bitrate) e o mínimo possível.
  media: {
    duration: m.src.duration || 0, width: m.src.width || 0, height: m.src.height || 0, hasAudio: Boolean(m.src.hasAudio),
    animated: Boolean(m.src.animated), min: compressor.minimumBytes(m.src),
  },
});

function uploadOf(id, device) {
  if (!UPLOAD_ID_RE.test(String(id || ''))) return null;
  let m = uploads.get(id);
  if (!m) {
    try {
      m = JSON.parse(fs.readFileSync(path.join(DOWNLOAD_DIR, id, 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
    if (m.id !== id) return null;
    uploads.set(id, m);
  }
  if (!device || m.device !== device || Date.now() - m.at > JOB_TTL_MS || !fs.existsSync(path.join(DOWNLOAD_DIR, id, 'in'))) return null;
  return m;
}

// Recebe o arquivo em streaming direto pro disco (nunca inteiro na memória), com limite de tamanho.
async function receiveUpload(req, res, device) {
  const bail = (status, error) => {
    sendJson(res, status, { error }, { connection: 'close' });
    req.resume();
  };
  if (shuttingDown) return bail(503, 'O servidor está reiniciando. Tenta de novo em alguns segundos.');
  const len = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(len) || len <= 0) return bail(411, 'Não consegui ler o tamanho do arquivo. Tenta de novo.');
  if (len > UPLOAD_MAX) return bail(413, `Arquivo grande demais: o máximo é ${UPLOAD_MAX >= 1024 ** 3 ? `${+(UPLOAD_MAX / 1024 ** 3).toFixed(1)} GB`.replace('.', ',') : `${Math.round(UPLOAD_MAX / 1024 ** 2)} MB`}.`);
  if (disk(DOWNLOAD_DIR).freeBytes < MIN_FREE_BYTES + len * 3) return bail(507, 'O servidor está sem espaço agora. Tenta mais tarde.');
  if ((uploadingNow.get(device) || 0) >= 3) return bail(429, 'Espera os envios que já estão indo terminarem.');
  let recent = 0;
  for (const u of uploads.values()) if (u.device === device && Date.now() - u.at < JOB_TTL_MS) recent++;
  if (recent >= 80) return bail(429, 'Muitos arquivos nessa última hora. Espera um pouco.');

  const name = cleanFileName(req.headers['x-file-name']);
  const id = `u${crypto.randomBytes(8).toString('hex')}`;
  const dir = path.join(DOWNLOAD_DIR, id);
  const file = path.join(dir, 'in');
  fs.mkdirSync(dir, { mode: 0o700 });
  uploadingNow.set(device, (uploadingNow.get(device) || 0) + 1);
  let got = 0;
  try {
    const count = new Transform({
      transform(c, _e, cb) {
        got += c.length;
        cb(got > len ? new Error('maior que o anunciado') : null, c);
      },
    });
    await pipeline(req, count, fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }));
    if (got !== len) throw new Error('incompleto');
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent && !res.destroyed) bail(400, 'O envio foi interrompido. Tenta de novo.');
    return undefined;
  } finally {
    const n = (uploadingNow.get(device) || 1) - 1;
    if (n > 0) uploadingNow.set(device, n);
    else uploadingNow.delete(device);
  }

  let src;
  try {
    src = await convert.detect(file, name, { hint: req.headers['x-source-format'] === 'svg' ? 'svg' : '' });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return sendJson(res, 400, { error: 'Não consegui ler esse arquivo.' });
  }
  const meta = { id, device, name, size: got, at: Date.now(), src };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
  uploads.set(id, meta);
  return sendJson(res, 201, uploadView(meta));
}

// Troca o cookies.txt do YouTube pela página /renovar: valida ANTES de trocar.
async function renewCookies(req, res) {
  if (!auth.allowAttempt(`renew:${clientIp(req)}`, 5)) return sendJson(res, 429, { error: 'Muitas tentativas. Espera uns 15 minutos.' });
  let body;
  try {
    body = await readJson(req, 400_000);
  } catch {
    return sendJson(res, 400, { error: 'Arquivo inválido ou grande demais.' });
  }

  // Instagram/X no mesmo arquivo (ou sozinhos): guarda as linhas de cada um à parte.
  const lines = String(body.content || '').split(/\r?\n/);
  const saved = [];
  for (const [name, re] of Object.entries(SOCIAL_DOMAINS)) {
    const mine = [...new Set(lines.filter((l) => re.test(l)))];
    if (!mine.length) continue;
    if (!mine.some((l) => SOCIAL_LOGIN[name].test(l))) return sendJson(res, 200, { ok: false, message: `Os cookies do ${name} não têm o login. Entra na conta descartável e exporta de novo.` });
    cookieFiles.writePrivate(SOCIAL_COOKIES[name], `# Netscape HTTP Cookie File\n${mine.join('\n')}\n`);
    saved.push(name);
  }
  if (saved.length) {
    infoCache.clear();
    console.log(`[cookies] ${saved.join(' e ')} atualizados pela página /renovar`);
  }
  if (!lines.some((l) => /^(#HttpOnly_)?\.?youtube\.com\t/.test(l))) {
    if (saved.length) return sendJson(res, 200, { ok: true, message: `Login do ${saved.join(' e do ')} salvo! Os perfis já mostram as categorias.` });
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
  rawInfo.clear();
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
    ytdlpWorker: { ready: ytWorker.ready, busy: ytWorker.busy, served: ytWorker.served },
    ...sys,
  };
}

// O site é aberto. Só a parte de administração (trocar o login do YouTube) pede o código de acesso.
const ADMIN_PATHS = new Set(['/renovar', '/api/cookies']);
const isLocal = (req) => !req.headers['x-real-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// Id do aparelho: lê o cookie ou cria um novo (e já manda o Set-Cookie nessa resposta).
function deviceOf(req, res) {
  const m = DEVICE_RE.exec(String(req.headers.cookie || ''));
  if (m) return m[1];
  const id = crypto.randomBytes(18).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  res.setHeader('set-cookie', `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
  return id;
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://x');

  // CSRF: pedido que muda estado vindo de outro site é recusado (o cookie já é SameSite=Lax).
  // Extensão Chromium (chrome-extension://) e Firefox (moz-extension://) são permitidas.
  // Bearer com admin.token também libera (sync da extensão privada).
  // "Compartilhar" do celular (POST do share_target). Quem cuida é o service worker (/sw.js), que
  // guarda os arquivos no aparelho. Se ele ainda não estiver ativo, o pedido chega aqui: o link
  // compartilhado vira ?url= e o resto é ignorado. Só redireciona, então não passa pela checagem de origem.
  if (pathname === '/compartilhar' && req.method === 'POST') return shareFallback(req, res);

  const bearer = (() => {
    const m = /^Bearer\s+(\S+)/i.exec(String(req.headers.authorization || ''));
    return m ? m[1].trim() : '';
  })();
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
    let ok = false;
    try {
      const u = new URL(req.headers.origin);
      ok = u.protocol === 'chrome-extension:' || u.protocol === 'moz-extension:' || u.host === req.headers.host;
    } catch { /* origin inválido */ }
    if (!ok && auth.checkToken(bearer)) ok = true;
    if (!ok) return sendJson(res, 403, { error: 'Origem não permitida.' });
  }

  // Limites por IP (o nginx também limita; aqui é a segunda camada).
  if (pathname.startsWith('/api/')) {
    if (tooMany(req, res, 'api', 1200, 60_000)) return undefined;
    if (pathname === '/api/info' && tooMany(req, res, 'info', 40, 60_000)) return undefined;
    if (pathname === '/api/jobs' && req.method === 'POST' && tooMany(req, res, 'jobs', 240, 60_000)) return undefined;
    if (pathname === '/api/upload' && req.method === 'POST' && tooMany(req, res, 'upload', 60, 10 * 60_000)) return undefined;
    if ((pathname === '/api/media' || pathname === '/api/image') && tooMany(req, res, 'media', 300, 60_000)) return undefined;
    if (pathname === '/api/preview' && tooMany(req, res, 'preview', 900, 60_000)) return undefined;
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
  if (pathname === '/entrar') return serveStatic(req, res, pathname, { page: 'entrar.html' });

  const admin = Boolean(auth.sessionFrom(req)) || auth.checkToken(bearer);
  if (ADMIN_PATHS.has(pathname) && !admin) {
    if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Entra com o código de acesso primeiro.' });
    res.writeHead(302, { location: `/entrar?next=${encodeURIComponent(req.url)}`, 'cache-control': 'no-store' });
    return res.end();
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', req, 0) });
  }

  // Detalhe da VPS só pra admin; o site só precisa saber se o YouTube está no ar.
  if (pathname === '/api/status') {
    if (admin) return sendJson(res, 200, { ...(await statusPayload()), admin: true });
    return sendJson(res, 200, { ok: !shuttingDown, youtube: ytHealthy(), admin: false });
  }

  // A página já sai com o id do aparelho, antes de qualquer conversão.
  const device = pathname === '/' || pathname.startsWith('/api/jobs') || pathname.startsWith('/api/upload') ? deviceOf(req, res) : null;

  if (pathname === '/renovar') return serveStatic(req, res, pathname, { page: 'renovar.html' });

  if (pathname === '/api/cookies' && req.method === 'POST') return renewCookies(req, res);

  if ((pathname === '/api/media' || pathname === '/api/image') && req.method === 'GET') return serveMedia(req, res, searchParams);
  if (pathname === '/api/preview' && req.method === 'GET') return servePreview(req, res, searchParams);

  if (pathname === '/api/info' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const url = normalizeUrl(body.url);
    if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
    const page = Math.min(Math.max(parseInt(body.page, 10) || 0, 0), 500);
    const mix = body.mix === true;
    try {
      let info;
      // Vídeo do YouTube ainda não buscado: responde com o card rápido se ele chegar antes da busca
      // completa, que segue por trás (o navegador pede de novo com full: true pra pegar o resto).
      const quickId = !page && !mix && body.full !== true && isYouTube(url) && !isPlaylistUrl(url) && !cachedInfo(url) ? ytVideoId(url) : null;
      if (quickId) {
        const full = getInfo(url);
        full.catch(() => {});
        info = await Promise.race([full, quickYt(url, quickId).catch(() => null).then((q) => q || full)]);
      } else info = await getInfo(url, page, mix);
      if (info.items?.some((it) => it.isLive)) return sendJson(res, 400, { error: 'Lives ao vivo não dá pra converter.' });
      return sendJson(res, 200, info);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (pathname === '/api/jobs' && req.method === 'GET') {
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit'), 10) || 50, 1), 200);
    const list = store.history(device, Date.now() - JOB_TTL_MS, limit).map((j) => {
      const live = jobs.get(j.id);
      return publicJob(live || j);
    });
    return sendJson(res, 200, { jobs: list });
  }

  if (pathname === '/api/upload' && req.method === 'POST') return receiveUpload(req, res, device);
  const up = pathname.match(/^\/api\/upload\/(u[0-9a-f]{16})$/);
  if (up && req.method === 'DELETE') {
    const meta = uploadOf(up[1], device);
    // Só apaga o original enviado; conversões já feitas dele continuam na lista.
    if (meta && ![...jobs.values()].some((j) => j.opts?.upload === meta.id && ACTIVE.has(j.status))) {
      fs.rmSync(path.join(DOWNLOAD_DIR, meta.id), { recursive: true, force: true });
      uploads.delete(meta.id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    if (shuttingDown) return sendJson(res, 503, { error: 'O servidor está reiniciando. Tenta de novo em alguns segundos.' });
    const body = await readJson(req).catch(() => ({}));
    const ip = clientIp(req);
    let mine = 0;
    for (const j of jobs.values()) if (ACTIVE.has(j.status) && j.ip === ip) mine++;
    if (mine >= MAX_ACTIVE_PER_IP || queue.length >= MAX_QUEUE) return sendJson(res, 429, { error: 'Tem coisa demais na fila agora. Espera algumas terminarem.' });

    // Conversão de arquivo enviado.
    if (body.upload !== undefined) {
      const meta = uploadOf(body.upload, device);
      if (!meta) return sendJson(res, 404, { error: 'Esse arquivo não está mais no servidor. Envia de novo.' });
      const to = String(body.to || '');
      if (!convert.targets(meta.src).some((t) => t.to === to)) return sendJson(res, 400, { error: 'Essa conversão não existe pra esse arquivo.' });
      if (disk(DOWNLOAD_DIR).freeBytes < MIN_FREE_BYTES) return sendJson(res, 507, { error: 'O servidor está sem espaço em disco agora.' });
      const title = meta.name.replace(/\.[^.]+$/, '').replace(/ \(comprimido\)$/, '') || 'arquivo';
      let compress;
      if (to === 'compress') {
        compress = compressor.cleanOpts(body.compress);
        if (!compress.mb) return sendJson(res, 400, { error: 'Escolhe de quantos MB quer que fique.' });
      }
      return sendJson(res, 201, publicJob(createJob({
        mode: 'file', url: `arquivo:${meta.id}`, kind: to, quality: null, title, opts: { upload: meta.id, src: meta.src, name: meta.name, ...(compress ? { compress } : {}) }, platform: 'Arquivo', device, ip,
      })));
    }

    const url = normalizeUrl(body.url);
    if (!url) return sendJson(res, 400, { error: 'Esse site ainda não é suportado.' });
    if (isProfileUrl(url)) return sendJson(res, 400, { error: 'Link de perfil não tem vídeo pra converter.' });
    const kind = ['mp4', 'mp3', 'wav', 'srt', 'gif'].includes(body.kind) ? body.kind : null;
    if (!kind) return sendJson(res, 400, { error: 'Formato inválido.' });
    if (disk(DOWNLOAD_DIR).freeBytes < MIN_FREE_BYTES) return sendJson(res, 507, { error: 'O servidor está sem espaço em disco agora.' });
    // O item vem da busca que o servidor fez: nunca baixa um link arbitrário mandado pelo navegador.
    const page = Math.min(Math.max(parseInt(body.page, 10) || 0, 0), 500);
    let info;
    try {
      info = await getInfo(url, page, body.mix === true);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
    const idx = Number.isInteger(body.item) ? body.item : 0;
    const item = info.items?.[idx];
    if (!item || ['image', 'list', 'post'].includes(item.kind)) return sendJson(res, 400, { error: 'Esse item não dá pra converter.' });
    if ((kind === 'mp4' || kind === 'gif') && item.kind === 'audio') return sendJson(res, 400, { error: 'Isso é só áudio.' });
    if (kind === 'gif' && item.search) return sendJson(res, 400, { error: 'Música não vira GIF.' });
    // Cortar trecho / recortar o quadro / GIF (lib/clip.js).
    let clip = null;
    if (kind !== 'srt' && (body.clip || kind === 'gif')) {
      const c = clipper.cleanClip(body.clip, { duration: item.duration || info.duration || 0, kind });
      if (c.error) return sendJson(res, 400, { error: c.error });
      clip = c.clip;
      if (clip?.crop && (kind === 'mp3' || kind === 'wav')) clip.crop = null;
    }
    if (kind === 'mp4' && !clip && !item.native && !item.hls) return sendJson(res, 400, { error: 'Esse vídeo já vem em MP4: é só baixar.' });

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
    // Live da Twitch ainda rolando: baixa o que já foi gravado (lib/vod.js), sem o yt-dlp.
    if (item.growing) {
      if (kind === 'srt') return sendJson(res, 400, { error: 'Live em andamento não tem legenda.' });
      const len = (clip?.end || item.duration || 0) - (clip?.start || 0);
      if (len > vod.MAX_SEC + 1) return sendJson(res, 400, { error: `A live já tem ${fmtHours(item.duration)}: escolhe um trecho de até ${vod.MAX_SEC / 3600} h no Cortar.` });
      const v = vod.pickVariant(item.liveVariants, kind, quality);
      if (!v) return sendJson(res, 400, { error: 'A Twitch não mandou as versões dessa live. Tenta de novo.' });
      return sendJson(res, 201, publicJob(createJob({
        kind, quality, title, duration: len, opts: clip ? { clip } : {}, platform: info.platform || '', device, ip, mode: 'vod', url: v.url,
      })));
    }
    const common = { kind, quality, title, duration: item.duration || info.duration || 0, opts: { ...(subs ? { subs } : {}), ...(clip ? { clip } : {}) }, platform: info.platform || '', device, ip };
    const spec = item.search
      // Música (Spotify, Deezer, Apple Music): baixa a mesma faixa da aba de músicas do YouTube Music.
      ? { ...common, mode: 'search', url: `https://music.youtube.com/search?q=${encodeURIComponent(item.search)}#songs` }
      : item.native
        ? { ...common, mode: 'native', url: item.entryUrl || url, index: item.entryUrl ? null : item.index, named: Boolean(item.entryUrl) }
        : { ...common, mode: 'direct', url: item.url, duration: item.duration };
    // Vídeo único que acabou de ser buscado: o download parte dessa busca.
    const saved = rawInfo.get(url);
    if (spec.mode === 'native' && !spec.index && spec.url === url && saved && Date.now() - saved.at < INFO_TTL_MS) spec.preload = saved;
    return sendJson(res, 201, publicJob(createJob(spec)));
  }

  // "Comprimir/converter de novo": o resultado pronto vira um envio novo, sem baixar e mandar de volta.
  const again = pathname.match(/^\/api\/jobs\/([0-9a-f]{16})\/reuse$/);
  if (again && req.method === 'POST') {
    const job = jobs.get(again[1]) || store.get(again[1]);
    if (!job || job.device !== device || job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return sendJson(res, 404, { error: 'Esse arquivo já expirou.' });
    const size = fs.statSync(job.file).size;
    if (disk(DOWNLOAD_DIR).freeBytes < MIN_FREE_BYTES + size * 3) return sendJson(res, 507, { error: 'O servidor está sem espaço agora. Tenta mais tarde.' });
    const id = `u${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(DOWNLOAD_DIR, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, 'in');
    fs.copyFileSync(job.file, file);
    const name = cleanFileName(path.basename(job.file));
    let src;
    try {
      src = await convert.detect(file, name);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      return sendJson(res, 400, { error: 'Não consegui ler esse arquivo.' });
    }
    const meta = { id, device, name, size, at: Date.now(), src };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    uploads.set(id, meta);
    return sendJson(res, 201, uploadView(meta));
  }

  const m = pathname.match(/^\/api\/jobs\/([0-9a-f]{16})(\/file)?$/);
  if (m) {
    const job = jobs.get(m[1]) || store.get(m[1]);
    // Conversão de outro aparelho responde igual a uma que não existe.
    if (!job || job.device !== device) return sendJson(res, 404, { error: 'Esse arquivo já expirou.' });
    if (m[2]) {
      if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return sendJson(res, 404, { error: 'Arquivo não está pronto.' });
      return serveFile(req, res, job);
    }
    if (req.method === 'DELETE') {
      if (ACTIVE.has(job.status)) {
        if (jobs.has(job.id)) cancelJob(job);
        return sendJson(res, 200, publicJob(job));
      }
      forgetJob(job);
      return sendJson(res, 200, { ok: true });
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
// Envio grande pode levar um tempo (celular devagar); cabeçalho tem que chegar rápido.
server.requestTimeout = 2 * 3600_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 10_000;
server.maxHeadersCount = 100;

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
  ytWorker.stop();
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

module.exports = { jobArgs, subsList, redact, normalizeUrl, extractUrl, isPlaylistUrl, mixId, listOffers, cleanFileName, server };

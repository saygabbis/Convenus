'use strict';

// Sites de arte: Pixiv (API pública do site), DeviantArt (RSS/oEmbed oficiais, pelo WARP) e o resto
// pelo gallery-dl (ArtStation, Patreon, boorus, Tumblr...). Tudo sai no mesmo formato do resto:
//   perfil    -> { type: 'profile', title, avatar, sections: [{ id, label, kind: 'post', url }] }
//   categoria -> { type: 'post', section: true, items: [{ kind: 'post', entryUrl, thumb, ... }], hasMore }
//   post      -> { type: 'post', title, uploader, items: [{ kind: 'image'|'video', url, thumb, ... }] }
// A categoria é o link do perfil com #aba (ex.: https://www.pixiv.net/users/11#manga).

const path = require('node:path');
const proc = require('./proc');

const GDL = process.env.GALLERYDL || path.join(process.env.HOME || '', '.local/bin/gallery-dl');
const PROXY = process.env.YTDLP_PROXY ?? 'socks5://127.0.0.1:40000';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE = 24;

// CDNs de onde o servidor pode repassar arquivo (somam com os do server.js) e o Referer que cada um exige.
const MEDIA_HOSTS = [
  'pximg.net', 'artstation.com', 'wixmp.com', 'deviantart.net', 'patreonusercontent.com', 'patreon.com', 'donmai.us',
  'e621.net', 'e926.net', 'imgur.com', 'staticflickr.com', 'behance.net', 'itaku.ee', 'fanbox.cc',
  'safebooru.org', 'yande.re', 'konachan.com', 'konachan.net', 'metapix.net', 'weasyl.com', 'media.tumblr.com',
  'cdninstagram.com', 'fbcdn.net', 'twimg.com',
];
const REFERERS = { 'pximg.net': 'https://www.pixiv.net/', 'fanbox.cc': 'https://www.fanbox.cc/' };
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));
const refererFor = (host) => Object.entries(REFERERS).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1] || '';
// Miniatura que o navegador não consegue mostrar sozinho (o CDN exige Referer): passa pelo servidor.
const viaServer = (u) => (u && refererFor(new URL(u).hostname) ? `/api/image?u=${encodeURIComponent(u)}&name=capa` : u || null);

const clean = (s, n = 140) => Array.from(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n).join('');
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
const VID_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const extOf = (u) => (String(u).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase();

// Cache curto: abrir a aba de novo / clicar "carregar mais" não refaz tudo.
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  while (cache.size > 300) cache.delete(cache.keys().next().value);
  return val;
}

async function getJson(url, { referer = '', timeout = 15_000 } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json', ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// O fetch do Node não fala SOCKS: o curl passa pelo WARP (o DeviantArt bloqueia o IP da VPS).
async function curlText(url) {
  const args = ['-sS', '-L', '--max-time', '20', '-A', BROWSER_UA, ...(PROXY ? ['--proxy', PROXY.replace(/^socks5:/, 'socks5h:')] : []), url];
  const r = await proc.run('curl', args, { timeoutMs: 25_000, maxStdout: 8 * 1024 * 1024 }).done;
  if (r.code !== 0) throw new Error('O site não respondeu. Tenta de novo.');
  return r.stdout;
}

// ---------- Pixiv ----------

const PX = 'https://www.pixiv.net/ajax';
const pxGet = async (p) => {
  const j = await getJson(`${PX}${p}${p.includes('?') ? '&' : '?'}lang=en`, { referer: 'https://www.pixiv.net/' });
  if (j.error) throw new Error(j.message || 'O Pixiv recusou.');
  return j.body;
};

async function pixivProfile(uid) {
  const [u, all] = await Promise.all([
    cached(`px:u:${uid}`, 30 * 60_000, () => pxGet(`/user/${uid}?full=1`)),
    pixivIds(uid),
  ]);
  const sections = [];
  if (all.illusts.length) sections.push({ id: 'illusts', label: 'Ilustrações', kind: 'post', url: `https://www.pixiv.net/users/${uid}#illusts`, count: all.illusts.length });
  if (all.manga.length) sections.push({ id: 'manga', label: 'Mangá', kind: 'post', url: `https://www.pixiv.net/users/${uid}#manga`, count: all.manga.length });
  return {
    type: 'profile', platform: 'Pixiv', title: u.name, handle: `pixiv · ${uid}`, followers: 0,
    avatar: viaServer(u.imageBig || u.image), avatarUrl: u.imageBig || u.image || null, banner: null, sections,
    sectionsNote: sections.length ? '' : 'Esse perfil não tem obras públicas.',
  };
}

function pixivIds(uid) {
  return cached(`px:all:${uid}`, 10 * 60_000, async () => {
    const b = await pxGet(`/user/${uid}/profile/all`);
    const ids = (o) => Object.keys(o || {}).map(Number).sort((a, b2) => b2 - a).map(String);
    return { illusts: ids(b.illusts), manga: ids(b.manga) };
  });
}

async function pixivSection(uid, tab, page) {
  const all = await pixivIds(uid);
  const ids = all[tab] || [];
  const slice = ids.slice(page * PAGE, (page + 1) * PAGE);
  if (!slice.length) throw new Error(page ? 'Não tem mais obras.' : 'Não tem nada nessa categoria.');
  const q = `${slice.map((id) => `ids[]=${id}`).join('&')}&work_category=${tab === 'manga' ? 'manga' : 'illust'}&is_first_page=0`;
  const b = await pxGet(`/user/${uid}/profile/illusts?${q}`);
  const items = slice.map((id) => b.works?.[id]).filter(Boolean).map((w, pidx) => ({
    kind: 'post',
    entryUrl: `https://www.pixiv.net/artworks/${w.id}`,
    thumb: viaServer(w.url),
    label: clean(w.title, 120) || 'Sem título',
    badge: w.xRestrict ? 'R-18' : w.illustType === 2 ? 'Animação' : w.pageCount > 1 ? `${w.pageCount} páginas` : '',
    page, pidx,
  }));
  return section('Pixiv', tab === 'manga' ? 'Mangá' : 'Ilustrações', b.works?.[slice[0]]?.userName || '', page, items, (page + 1) * PAGE < ids.length, ids.length);
}

async function pixivPost(id) {
  const [w, pages] = await Promise.all([pxGet(`/illust/${id}`), pxGet(`/illust/${id}/pages`).catch(() => [])]);
  if (!pages.length || !pages[0]?.urls?.original) throw new Error(w.xRestrict ? 'Obra +18: o Pixiv só mostra pra quem está logado.' : 'Não consegui abrir essa obra.');
  const items = pages.map((p) => ({ kind: 'image', url: p.urls.original, thumb: viaServer(p.urls.small || p.urls.regular), width: p.width || 0, height: p.height || 0 }));
  return {
    type: 'post', platform: 'Pixiv', id: String(id), title: clean(w.title) || 'Obra do Pixiv', uploader: w.userName || '',
    avatar: null, thumbnail: items[0].thumb, thumbs: [], duration: 0,
    ...(w.illustType === 2 ? { note: 'É uma animação (ugoira): aqui vem o primeiro quadro.' } : {}),
    items,
  };
}

// ---------- DeviantArt ----------

const DA_RESERVED = new Set(['search', 'tag', 'topic', 'popular', 'watch', 'notifications', 'settings', 'core-membership', 'about', 'daily-deviations', 'shop', 'groups', 'team', 'developers', 'join', 'users', 'submit']);

function rssItems(xml) {
  const out = [];
  for (const block of xml.split('<item>').slice(1)) {
    const tag = (t) => (block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const attr = (t, a) => [...block.matchAll(new RegExp(`<${t}\\b[^>]*\\b${a}="([^"]+)"[^>]*>`, 'g'))].map((m) => m[0]);
    const content = attr('media:content', 'url').find((m) => /medium="image"/.test(m)) || '';
    const thumbs = attr('media:thumbnail', 'url').map((m) => ({ url: m.match(/url="([^"]+)"/)[1], w: Number(m.match(/width="(\d+)"/)?.[1] || 0) }));
    const unent = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    out.push({
      title: unent(tag('title').replace(/^<!\[CDATA\[|\]\]>$/g, '')),
      link: unent(tag('link')),
      full: content ? unent(content.match(/url="([^"]+)"/)[1]) : '',
      width: Number(content.match(/width="(\d+)"/)?.[1] || 0),
      height: Number(content.match(/height="(\d+)"/)?.[1] || 0),
      thumb: unent((thumbs.find((t) => t.w >= 250) || thumbs.at(-1) || {}).url || ''),
      author: unent(tag('media:credit').replace(/^<!\[CDATA\[|\]\]>$/g, '')),
    });
  }
  return out;
}

// A imagem "pre" do RSS é reduzida: o token do link deixa pedir até o tamanho original.
function daBig(u) {
  try {
    const tok = new URL(u).searchParams.get('token');
    const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    const lim = claims.obj?.[0]?.[0] || {};
    const w = Number(String(lim.width || '').replace(/\D/g, '')), h = Number(String(lim.height || '').replace(/\D/g, ''));
    if (!w || !h) return u;
    return u.replace(/\/v1\/(fill|fit)\/w_\d+,h_\d+,q_\d+[^/]*\//, `/v1/fit/w_${w},h_${h},q_100/`);
  } catch {
    return u;
  }
}

const DA_TABS = { gallery: ['Galeria', 'gallery'], scraps: ['Rascunhos', 'scraps'], favs: ['Favoritos', 'favby'] };

async function daSection(user, tab, page) {
  const [label, q] = DA_TABS[tab] || DA_TABS.gallery;
  const xml = await curlText(`https://backend.deviantart.com/rss.xml?type=deviation&q=${q}%3A${encodeURIComponent(user)}&offset=${page * 60}`);
  if (!/<rss/.test(xml)) throw new Error('O DeviantArt não respondeu. Tenta de novo.');
  const list = rssItems(xml).filter((x) => x.link);
  if (!list.length) throw new Error(page ? 'Não tem mais obras.' : 'Não tem nada nessa categoria.');
  const items = list.map((x, pidx) => ({ kind: 'post', entryUrl: x.link, thumb: x.thumb || x.full, label: clean(x.title, 120) || 'Sem título', badge: '', page, pidx }));
  return section('DeviantArt', label, user, page, items, /<atom:link[^>]+rel="next"/.test(xml));
}

async function daProfile(user) {
  // O nome e a foto saem do primeiro post da galeria (o RSS não traz o avatar).
  const first = await daSection(user, 'gallery', 0).catch(() => null);
  return {
    type: 'profile', platform: 'DeviantArt', title: user, handle: `@${user}`, followers: 0, avatar: null, banner: null,
    sections: Object.entries(DA_TABS).map(([id, [label]]) => ({ id, label, kind: 'post', url: `https://www.deviantart.com/${user}#${id}` })),
    ...(first ? {} : { sectionsNote: 'O DeviantArt não respondeu agora. Tenta de novo daqui a pouco.' }),
  };
}

async function daPost(url) {
  const j = JSON.parse(await curlText(`https://backend.deviantart.com/oembed?url=${encodeURIComponent(url)}`).catch(() => '{}') || '{}');
  if (!j.url && !j.thumbnail_url) throw new Error('Não consegui abrir essa obra do DeviantArt.');
  const full = j.type === 'photo' && j.url ? daBig(j.url) : j.thumbnail_url;
  return {
    type: 'post', platform: 'DeviantArt', id: url.split('-').pop(), title: clean(j.title) || 'Obra do DeviantArt', uploader: j.author_name || '',
    avatar: null, thumbnail: j.thumbnail_url || full, thumbs: [], duration: 0,
    items: [{ kind: 'image', url: full, thumb: j.thumbnail_url || full, width: Number(j.width) || 0, height: Number(j.height) || 0 }],
  };
}

// ---------- gallery-dl (ArtStation, Patreon, boorus, Tumblr, Imgur, Flickr...) ----------

async function gdl(url, range, { posts = true, cookies = '' } = {}) {
  const args = ['--config-ignore', '-q', '-j', posts ? '--post-range' : '--range', range,
    ...(cookies ? ['--cookies', cookies, '-o', 'cookies-update=false'] : []), url];
  const r = await proc.run(GDL, args, { timeoutMs: 90_000, maxStdout: 96 * 1024 * 1024 }).done;
  if (r.error?.code === 'ENOENT') throw new Error('O gallery-dl não está instalado no servidor.');
  let msgs;
  try {
    msgs = JSON.parse(r.stdout || '[]');
  } catch {
    throw new Error('O site não respondeu direito. Tenta de novo.');
  }
  const err = msgs.find((m) => m[0] === -1);
  if (err && msgs.length === 1) {
    const e = err[1] || {};
    if (/Auth|login|cookie|api-key/i.test(`${e.error} ${e.message}`)) throw new Error('Esse conteúdo só aparece pra quem está logado no site.');
    if (/NotFound|404/i.test(`${e.error} ${e.message}`)) throw new Error('Não achei nada nesse link.');
    throw new Error('O site bloqueou ou não respondeu. Tenta de novo.');
  }
  return msgs;
}

const pick = (o, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    if (v != null && v !== '') return v;
  }
  return null;
};

// Junta as mensagens do gallery-dl por post: [{ key, meta, files: [{ url, meta }] }].
function groupPosts(msgs) {
  const posts = new Map();
  for (const m of msgs) {
    if (m[0] !== 3 && m[0] !== 2) continue;
    const meta = m[m.length - 1] || {};
    const key = String(pick(meta, 'tweet_id', 'post_shortcode', 'post_id', 'hash_id', 'id', 'md5') ?? posts.size);
    if (!posts.has(key)) posts.set(key, { key, meta, files: [], seen: new Set() });
    const p = posts.get(key);
    if (m[0] === 3 && typeof m[1] === 'string' && !p.seen.has(m[1])) {
      p.seen.add(m[1]);
      p.files.push({ url: m[1], meta });
    }
  }
  return [...posts.values()];
}

function fileItem(f) {
  const u = f.url;
  if (!/^https:\/\//.test(u)) return null;
  let host;
  try { host = new URL(u).hostname.toLowerCase(); } catch { return null; }
  // Patreon: /media-u/... é a imagem em si, sem extensão no link.
  const ext = String(f.meta.extension || extOf(u) || (/patreon\.com$/.test(host) && /^\/media-u\//.test(new URL(u).pathname) ? 'jpg' : '')).toLowerCase();
  const kind = VID_EXT.has(ext) ? 'video' : IMG_EXT.has(ext) ? 'image' : null;
  if (!kind || !hostIn(host, MEDIA_HOSTS)) return null;
  const m = f.meta;
  let thumb = pick(m, 'preview_file_url', 'large_file_url', 'sample_url', 'preview_url', 'preview.url', 'sample.url', 'thumbnail');
  if (!thumb && /artstation\.com/.test(host)) thumb = u.replace(/\/(8k|4k|large|original)\//, '/medium/');
  if (thumb && !/^https:\/\//.test(thumb)) thumb = null;
  return {
    kind, url: u, thumb: viaServer(kind === 'image' ? thumb || u : thumb),
    width: Number(pick(m, 'width', 'image_width', 'asset.width')) || 0,
    height: Number(pick(m, 'height', 'image_height', 'asset.height')) || 0,
    ...(ext === 'gif' ? { gif: true } : {}),
  };
}

function postLink(site, p, fallback) {
  const m = p.meta;
  if (site === 'ArtStation' && m.hash_id) return `https://www.artstation.com/artwork/${m.hash_id}`;
  if (site === 'Danbooru' && m.id) return `https://danbooru.donmai.us/posts/${m.id}`;
  if (site === 'e621' && m.id) return `https://e621.net/posts/${m.id}`;
  if (site === 'X' && m.tweet_id) return `https://x.com/${m.author?.name || 'i'}/status/${m.tweet_id}`;
  if (site === 'Instagram' && m.post_shortcode) return `https://www.instagram.com/p/${m.post_shortcode}/`;
  const u = pick(m, 'post_url', 'permalink', 'url', 'link', 'short_url');
  return /^https:\/\//.test(u || '') && !/\.(jpe?g|png|gif|webp|mp4)(\?|$)/i.test(u) ? u : fallback;
}

const who = (m) => pick(m, 'user.full_name', 'user.username', 'campaign.name', 'creator.full_name', 'author.name', 'author.username', 'blog.title', 'blog.name', 'artist', 'tag_string_artist', 'username', 'uploader', 'owner.username');
const avatarOf = (m) => pick(m, 'user.medium_avatar_url', 'user.large_avatar_url', 'campaign.avatar_photo_url', 'campaign.avatar_photo_image_urls.default', 'creator.image_url', 'author.usericon', 'blog.avatar.0.url');

async function gdlSection(site, url, label, page, { cookies = '' } = {}) {
  const msgs = await gdl(url, `${page * PAGE + 1}-${(page + 1) * PAGE}`, { cookies });
  const posts = groupPosts(msgs);
  const items = posts.map((p, pidx) => {
    const files = p.files.map(fileItem).filter(Boolean);
    const first = files[0];
    const cover = pick(p.meta, 'cover_url', 'cover.url', 'image.large_url', 'image.url', 'preview_file_url');
    const thumb = (first?.thumb) || viaServer(/^https:\/\//.test(cover || '') ? cover : null);
    if (!thumb && !files.length) return null;
    const vids = files.filter((f) => f.kind === 'video').length;
    return {
      kind: 'post', entryUrl: postLink(site, p, url), thumb,
      label: clean(pick(p.meta, 'title', 'description', 'content', 'tag_string_character', 'summary') || '', 120) || (vids ? 'Vídeo' : 'Sem título'),
      badge: vids ? (files.length > 1 ? `${files.length} arquivos` : 'Vídeo') : files.length > 1 ? `${files.length} imagens` : '',
      page, pidx,
    };
  }).filter(Boolean).map((x, pidx) => ({ ...x, pidx }));
  if (!items.length) throw new Error(page ? 'Não tem mais posts.' : 'Não achei imagens públicas aqui.');
  const res = section(site, label, who(posts[0]?.meta || {}) || '', page, items, posts.length >= PAGE);
  res.headAvatar = avatarOf(posts[0]?.meta || {});
  return res;
}

async function gdlPost(site, url) {
  const msgs = await gdl(url, '1-200', { posts: false });
  const posts = groupPosts(msgs);
  const items = posts.flatMap((p) => p.files.map(fileItem).filter(Boolean));
  if (!items.length) {
    const locked = posts.some((p) => p.meta.current_user_can_view === false || p.meta.is_locked);
    throw new Error(locked ? 'Esse post é só pra apoiadores.' : 'Esse post não tem imagem nem vídeo público.');
  }
  const m = posts[0].meta;
  return {
    type: 'post', platform: site, id: String(pick(m, 'hash_id', 'id') || ''), title: clean(pick(m, 'title', 'description', 'summary')) || `Post do ${site}`,
    uploader: who(m) || '', avatar: viaServer(avatarOf(m)), thumbnail: items[0].thumb, thumbs: [], duration: 0, items,
  };
}

function section(platform, title, uploader, page, items, hasMore, total = 0) {
  return { type: 'post', platform, title, uploader, playlist: true, section: true, page, total, hasMore, items, thumbs: [], avatar: null, duration: 0 };
}

// Perfil pelo gallery-dl: o cabeçalho vem do primeiro post da primeira categoria.
async function gdlProfile(site, handle, sections) {
  const first = await gdlSection(site, sections[0].url.replace(/#.*$/, ''), sections[0].label, 0).catch((e) => ({ err: e.message }));
  return {
    type: 'profile', platform: site, title: first.uploader || handle, handle: `@${handle}`, followers: 0,
    avatar: viaServer(first.headAvatar), banner: null, sections,
    ...(first.err ? { sectionsNote: first.err } : {}),
  };
}

// ---------- Instagram e X com a conta descartável (cookies enviados pela página /renovar) ----------

let socialCookies = () => '';
const setSocialCookies = (fn) => { socialCookies = fn; };
const SOCIAL_TABS = {
  Instagram: [['posts', 'Posts', (u) => `https://www.instagram.com/${u}/posts/`], ['reels', 'Reels', (u) => `https://www.instagram.com/${u}/reels/`], ['tagged', 'Marcados', (u) => `https://www.instagram.com/${u}/tagged/`]],
  X: [['media', 'Mídia', (u) => `https://x.com/${u}/media`], ['tweets', 'Posts', (u) => `https://x.com/${u}/tweets`]],
};
const SOCIAL_BASE = { Instagram: (u) => `https://www.instagram.com/${u}/`, X: (u) => `https://x.com/${u}` };

// Categorias do perfil, só quando há cookies daquela rede.
function socialSections(platform, user) {
  if (!SOCIAL_TABS[platform] || !socialCookies(platform)) return null;
  return SOCIAL_TABS[platform].map(([id, label]) => ({ id, label, kind: 'post', url: `${SOCIAL_BASE[platform](user)}#${id}` }));
}

// ---------- TikTok: a lista de vídeos quando o yt-dlp não consegue ----------
// O gallery-dl acha os links dos vídeos (só falha ao abrir cada um); capa e título vêm do oEmbed público.
async function tiktokList(user, page) {
  // O --post-range não segura a lista do TikTok (os posts falham antes de contar): corta aqui.
  const r = await proc.run(GDL, ['--config-ignore', '-j', '--post-range', `1-${(page + 1) * PAGE}`, `https://www.tiktok.com/@${user}/posts`],
    { timeoutMs: 120_000, maxStdout: 32 * 1024 * 1024 }).done;
  const found = [...new Set(`${r.stdout}\n${r.stderr}`.match(/https:\/\/www\.tiktok\.com\/@[\w.-]+\/(?:video|photo)\/\d+/g) || [])];
  const links = found.slice(page * PAGE, (page + 1) * PAGE);
  if (!links.length) throw new Error(page ? 'Não tem mais vídeos.' : 'O TikTok não mostrou os vídeos desse perfil agora.');
  const items = await Promise.all(links.map(async (entryUrl, pidx) => {
    const oe = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(entryUrl)}`, { timeout: 10_000 }).catch(() => ({}));
    return { kind: 'video', native: true, entryUrl, thumb: /^https:/.test(oe.thumbnail_url || '') ? oe.thumbnail_url : null, label: clean(oe.title, 120) || (/\/photo\//.test(entryUrl) ? 'Fotos' : 'Vídeo'), page, pidx };
  }));
  return section('TikTok', 'Vídeos', `@${user}`, page, items, found.length > (page + 1) * PAGE);
}

// ---------- reconhecer o link ----------

const GDL_SITES = [
  [/(^|\.)artstation\.com$/, 'ArtStation'], [/(^|\.)patreon\.com$/, 'Patreon'], [/(^|\.)danbooru\.donmai\.us$/, 'Danbooru'],
  [/(^|\.)e621\.net$/, 'e621'], [/(^|\.)e926\.net$/, 'e621'], [/(^|\.)imgur\.com$/, 'Imgur'], [/(^|\.)flickr\.com$/, 'Flickr'],
  [/(^|\.)behance\.net$/, 'Behance'], [/(^|\.)itaku\.ee$/, 'Itaku'], [/(^|\.)fanbox\.cc$/, 'Fanbox'], [/(^|\.)safebooru\.org$/, 'Safebooru'],
  [/(^|\.)yande\.re$/, 'yande.re'], [/(^|\.)konachan\.(com|net)$/, 'Konachan'], [/(^|\.)weasyl\.com$/, 'Weasyl'], [/(^|\.)inkbunny\.net$/, 'Inkbunny'],
];
const HOSTS = ['pixiv.net', 'deviantart.com', 'artstation.com', 'patreon.com', 'danbooru.donmai.us', 'e621.net', 'e926.net', 'imgur.com', 'flickr.com',
  'behance.net', 'itaku.ee', 'fanbox.cc', 'safebooru.org', 'yande.re', 'konachan.com', 'konachan.net', 'weasyl.com', 'inkbunny.net'];
const AS_RESERVED = new Set(['artwork', 'artworks', 'learning', 'marketplace', 'jobs', 'blogs', 'search', 'prints', 'challenges', 'guides', 'about', 'contests', 'community', 'channels', 'studios', 'users', 'sign_in', 'sign_up']);
const PT_RESERVED = new Set(['posts', 'login', 'signup', 'search', 'home', 'explore', 'messages', 'notifications', 'settings', 'membership', 'policy', 'about', 'apps', 'pricing', 'file', 'join', 'checkout', 'collection']);

function match(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const tab = u.hash.slice(1);

  if (/(^|\.)pixiv\.net$/.test(host)) {
    const p = parts[0]?.length === 2 && /^[a-z]{2}$/.test(parts[0]) ? parts.slice(1) : parts; // /en/...
    if (p[0] === 'artworks' && /^\d+$/.test(p[1] || '')) return { platform: 'Pixiv', post: () => pixivPost(p[1]) };
    if (p[0] === 'users' && /^\d+$/.test(p[1] || '')) {
      if (tab === 'illusts' || tab === 'manga') return { platform: 'Pixiv', section: (page) => pixivSection(p[1], tab, page) };
      if (p[2] === 'manga') return { platform: 'Pixiv', section: (page) => pixivSection(p[1], 'manga', page) };
      return { platform: 'Pixiv', profile: () => pixivProfile(p[1]) };
    }
    return null;
  }

  // Instagram/X: só as categorias (#posts, #media...) com cookies; o resto continua no providers.js.
  const social = /(^|\.)instagram\.com$/.test(host) ? 'Instagram' : /^(www\.|mobile\.)?(x|twitter)\.com$/.test(host) ? 'X' : null;
  if (social) {
    const t = SOCIAL_TABS[social].find(([id]) => id === tab);
    const user = parts[0];
    if (!t || !user || parts.length !== 1) return null;
    return {
      platform: social,
      section: async (page) => {
        const cookies = socialCookies(social);
        if (!cookies) throw new Error(`Falta mandar os cookies da conta descartável do ${social} na página /renovar.`);
        return gdlSection(social, t[2](user), t[1], page, { cookies });
      },
    };
  }

  if (/(^|\.)deviantart\.com$/.test(host)) {
    // Subdomínio antigo: fulano.deviantart.com
    const sub = host.replace(/\.?deviantart\.com$/, '').replace(/^www$/, '');
    const user = sub || parts[0];
    if (!user || DA_RESERVED.has(user)) return null;
    const rest = sub ? parts : parts.slice(1);
    if (rest[0] === 'art' && rest[1]) return { platform: 'DeviantArt', post: () => daPost(`https://www.deviantart.com/${user}/art/${rest[1]}`) };
    if (DA_TABS[tab]) return { platform: 'DeviantArt', section: (page) => daSection(user, tab, page) };
    if (!rest.length || ['gallery', 'favourites'].includes(rest[0])) return { platform: 'DeviantArt', profile: () => daProfile(user) };
    return null;
  }

  const site = GDL_SITES.find(([re]) => re.test(host))?.[1];
  if (!site) return null;
  const clean0 = `${u.origin}${u.pathname}${u.search}`;

  if (site === 'ArtStation') {
    const user = /^[\w-]+$/.test(parts[0] || '') && !AS_RESERVED.has(parts[0]) && (parts.length === 1 || (parts.length === 2 && parts[1] === 'likes')) ? parts[0] : null;
    if (user) {
      const secs = [
        { id: 'works', label: 'Trabalhos', kind: 'post', url: `https://www.artstation.com/${user}#works` },
      ];
      const s = secs.find((x) => x.id === (tab || (parts[1] === 'likes' ? 'likes' : '')));
      if (s) return { platform: site, section: (page) => gdlSection(site, `https://www.artstation.com/${user}${s.id === 'likes' ? '/likes' : ''}`, s.label, page) };
      return { platform: site, profile: () => gdlProfile(site, user, secs) };
    }
    if (parts[0] === 'artwork' && parts[1]) return { platform: site, post: () => gdlPost(site, `https://www.artstation.com/artwork/${parts[1]}`) };
    return { platform: site, post: () => gdlPost(site, clean0) };
  }

  if (site === 'Patreon') {
    const pi = parts.indexOf('posts');
    if (pi >= 0 && pi <= 2 && parts[pi + 1]) return { platform: site, post: () => gdlPost(site, clean0) };
    const user = ['c', 'cw'].includes(parts[0]) ? parts[1] : parts[0];
    if (user && /^[\w.-]+$/.test(user) && !PT_RESERVED.has(user)) {
      const secs = [{ id: 'posts', label: 'Posts', kind: 'post', url: `https://www.patreon.com/c/${user}/posts#posts` }];
      if (tab === 'posts') return { platform: site, section: (page) => gdlSection(site, `https://www.patreon.com/c/${user}/posts`, 'Posts', page) };
      return { platform: site, profile: () => gdlProfile(site, user, secs) };
    }
    return null;
  }

  // Busca por tags num booru: lista de posts direto (sem cabeçalho de perfil).
  const listing = (site === 'Danbooru' || site === 'e621') ? parts[0] === 'posts' && !parts[1]
    : ['Safebooru', 'yande.re', 'Konachan'].includes(site) ? /s=list|\/post$|\/post\?/.test(clean0) : false;
  if (listing) {
    const tags = u.searchParams.get('tags') || '';
    return { platform: site, section: (page) => gdlSection(site, clean0, tags ? `#${tags}` : 'Posts', page), title: tags };
  }
  return { platform: site, post: () => gdlPost(site, clean0) };
}

module.exports = { match, MEDIA_HOSTS, HOSTS, BROWSER_UA, refererFor, viaServer, socialSections, setSocialCookies, tiktokList };

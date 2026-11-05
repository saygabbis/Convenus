'use strict';

// Posts e perfis por plataforma via APIs/embeds públicos, sempre com o arquivo original.
// Cada post vira { title, uploader, avatar, thumbnail, items[] }, e cada item é
//   { kind: 'image'|'video'|'audio', url?, thumb, width, height, duration, native? }.
// `url` é o arquivo direto (baixa e converte com ffmpeg); `native: true` = só o yt-dlp
// consegue baixar (ex.: vídeo HLS do Bluesky).

const UA = 'Convenus/1.0 (+https://convert.saygabbis.cloud)';

async function get(url, as = 'json') {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === 'json' ? r.json() : r.text();
}

// Corta no fim de uma palavra, com reticências, sem partir emoji ao meio.
function clean(s, n = 140) {
  const chars = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  if (chars.length <= n) return chars.join('');
  const cut = chars.slice(0, n).join('');
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s.,;:!?-]+$/, '')}…`;
}

// ---------- X / Twitter (FxTwitter) ----------

const X_HOST = /^(?:www\.|mobile\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)$/i;
const X_RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'notifications', 'messages', 'intent', 'share', 'hashtag', 'compose']);

// Variantes mp4 do vídeo, da melhor pra pior: [{ height, url }].
function xVariants(m) {
  const seen = new Set();
  return (m.variants || m.formats || [])
    .filter((v) => /mp4/.test(v.content_type || ''))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
    .map((v) => {
      const [w, h] = (v.url.match(/\/(\d+)x(\d+)\//) || []).slice(1).map(Number);
      return { height: Math.min(w || 0, h || 0) || h || 0, url: v.url };
    })
    .filter((v) => v.height && !seen.has(v.height) && seen.add(v.height));
}

async function xPost(id) {
  const { tweet: t } = await get(`https://api.fxtwitter.com/status/${id}`);
  if (!t) throw new Error('Post não encontrado.');
  const items = (t.media?.all || []).map((m) => (m.type === 'photo'
    ? { kind: 'image', url: m.url, thumb: m.url.replace('name=orig', 'name=small'), width: m.width, height: m.height }
    : (() => {
      const variants = xVariants(m);
      return { kind: 'video', url: variants[0]?.url || m.url, variants, thumb: m.thumbnail_url, width: Number(m.width) || 0, height: Number(m.height) || 0, duration: Number(m.duration) || 0, gif: m.type === 'gif' };
    })()));
  return {
    id,
    title: clean(t.text) || `Post de @${t.author.screen_name}`,
    uploader: `@${t.author.screen_name}`,
    avatar: t.author.avatar_url ? t.author.avatar_url.replace(/_normal(\.\w+)$/, '$1') : null,
    thumbnail: items[0]?.thumb || null,
    items,
  };
}

async function xProfile(user) {
  const { user: u } = await get(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(user)}`);
  if (!u) throw new Error('Perfil não encontrado.');
  return {
    title: u.name,
    handle: `@${u.screen_name}`,
    followers: u.followers || 0,
    // _normal é a versão 48px; sem o sufixo vem o original.
    avatar: u.avatar_url ? u.avatar_url.replace(/_normal(\.\w+)$/, '$1') : null,
    banner: u.banner_url ? `${u.banner_url.replace(/\/\d+x\d+$/, '')}/1500x500` : null,
  };
}

// ---------- Bluesky (API pública oficial) ----------

const BSKY = 'https://public.api.bsky.app/xrpc';

async function bskyPost(handle, rkey) {
  const uri = `at://${handle}/app.bsky.feed.post/${rkey}`;
  const { thread } = await get(`${BSKY}/app.bsky.feed.getPostThread?depth=0&uri=${encodeURIComponent(uri)}`);
  const p = thread?.post;
  if (!p) throw new Error('Post não encontrado.');
  const e = p.embed?.media || p.embed || {};
  const items = (e.images || []).map((i) => ({ kind: 'image', url: i.fullsize, thumb: i.thumb, width: i.aspectRatio?.width || 0, height: i.aspectRatio?.height || 0 }));
  if (e.playlist) items.push({ kind: 'video', native: true, thumb: e.thumbnail, width: e.aspectRatio?.width || 0, height: e.aspectRatio?.height || 0 });
  return {
    id: rkey,
    title: clean(p.record?.text) || `Post de @${p.author.handle}`,
    uploader: `@${p.author.handle}`,
    avatar: p.author.avatar || null,
    thumbnail: items[0]?.thumb || null,
    items,
  };
}

async function bskyProfile(handle) {
  const p = await get(`${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  return { title: p.displayName || p.handle, handle: `@${p.handle}`, followers: p.followersCount || 0, avatar: p.avatar || null, banner: p.banner || null };
}

// ---------- Instagram (página de embed pública) ----------

const IG_HOST = /^(?:www\.|m\.)?instagram\.com$/i;
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'legal', 'developer']);

async function igContext(path) {
  const html = await get(`https://www.instagram.com/${path}/embed/captioned/`, 'text');
  const m = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
  if (!m) throw new Error('O Instagram não mostrou esse post (pode ser privado).');
  return JSON.parse(JSON.parse(`"${m[1]}"`));
}

function igItem(n) {
  const d = n.dimensions || {};
  return n.is_video && n.video_url
    ? { kind: 'video', url: n.video_url, thumb: n.display_url, width: d.width || 0, height: d.height || 0, duration: n.video_duration || 0 }
    : { kind: 'image', url: n.display_url, thumb: n.display_url, width: d.width || 0, height: d.height || 0 };
}

async function igPost(code) {
  const ctx = await igContext(`p/${code}`);
  const sm = ctx.gql_data?.shortcode_media;
  if (!sm) throw new Error('O Instagram não mostrou esse post (pode ser privado).');
  const kids = sm.edge_sidecar_to_children?.edges?.map((e) => e.node) || [sm];
  const caption = sm.edge_media_to_caption?.edges?.[0]?.node?.text;
  return {
    id: code,
    title: clean(caption) || `Post de @${sm.owner?.username}`,
    uploader: sm.owner?.username ? `@${sm.owner.username}` : '',
    avatar: sm.owner?.profile_pic_url || null,
    thumbnail: sm.display_url || null,
    items: kids.map(igItem),
  };
}

async function igProfile(user) {
  const html = await get(`https://www.instagram.com/${encodeURIComponent(user)}/embed/`, 'text');
  const m = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/);
  const c = m ? JSON.parse(JSON.parse(`"${m[1]}"`)).context || {} : {};
  if (!c.username) throw new Error('Perfil não encontrado (ou é privado).');
  return { title: c.full_name || c.username, handle: `@${c.username}`, followers: Number(c.followers_count) || 0, avatar: c.profile_pic_url || null, banner: null };
}

// ---------- TikTok (TikWM: vídeo sem marca d'água) ----------

const TT_HOST = /(^|\.)tiktok\.com$/i;

async function ttPost(url) {
  const r = await get(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(url)}`);
  const d = r?.data;
  if (r?.code !== 0 || !d) throw new Error(r?.msg || 'O TikTok não respondeu.');
  const items = Array.isArray(d.images) && d.images.length
    ? d.images.map((u) => ({ kind: 'image', url: u, thumb: u }))
    : [{
      kind: 'video',
      url: d.hdplay || d.play,
      // TikWM não diz a resolução; HD e SD são as duas versões sem marca d'água.
      variants: [d.hdplay && { label: 'HD', url: d.hdplay }, d.play && d.play !== d.hdplay && { label: 'SD', url: d.play }].filter(Boolean),
      thumb: d.origin_cover || d.cover,
      duration: d.duration || 0,
    }];
  if (d.music) items.push({ kind: 'audio', url: d.music, thumb: d.music_info?.cover || d.cover, duration: d.music_info?.duration || d.duration || 0, label: clean(d.music_info?.title, 60) });
  return {
    id: d.id,
    title: clean(d.title) || `TikTok de @${d.author?.unique_id}`,
    uploader: d.author?.unique_id ? `@${d.author.unique_id}` : '',
    avatar: d.author?.avatar || null,
    thumbnail: d.origin_cover || d.cover || null,
    items,
  };
}

// ---------- roteamento ----------

/** { platform, post?, profile? } com a função que resolve o link, ou null se a plataforma não tiver API própria aqui. */
function match(rawUrl) {
  const u = new URL(rawUrl);
  const parts = u.pathname.split('/').filter(Boolean);

  if (X_HOST.test(u.hostname)) {
    const i = parts.indexOf('status');
    if (i >= 0 && /^\d+$/.test(parts[i + 1] || '')) return { platform: 'X', post: () => xPost(parts[i + 1]) };
    if (parts.length >= 1 && parts.length <= 2 && /^\w{1,15}$/.test(parts[0]) && !X_RESERVED.has(parts[0].toLowerCase())) {
      return { platform: 'X', profile: () => xProfile(parts[0]) };
    }
  }

  if (/^(?:www\.)?bsky\.app$/i.test(u.hostname) && parts[0] === 'profile' && parts[1]) {
    if (parts[2] === 'post' && parts[3]) return { platform: 'Bluesky', post: () => bskyPost(parts[1], parts[3]) };
    if (parts.length === 2) return { platform: 'Bluesky', profile: () => bskyProfile(parts[1]) };
  }

  if (IG_HOST.test(u.hostname)) {
    const i = parts.findIndex((p) => ['p', 'reel', 'reels', 'tv'].includes(p));
    if (i >= 0 && parts[i + 1]) return { platform: 'Instagram', post: () => igPost(parts[i + 1]) };
    if (parts.length === 1 && /^[\w.]{1,30}$/.test(parts[0]) && !IG_RESERVED.has(parts[0])) return { platform: 'Instagram', profile: () => igProfile(parts[0]) };
  }

  if (TT_HOST.test(u.hostname) && (/\/(video|photo)\/\d+/.test(u.pathname) || /^(vm|vt)\./i.test(u.hostname) || parts[0] === 't')) {
    return { platform: 'TikTok', post: () => ttPost(rawUrl) };
  }
  if (TT_HOST.test(u.hostname) && parts.length === 1 && parts[0].startsWith('@')) {
    return {
      platform: 'TikTok',
      profile: async () => { throw new Error('Perfil do TikTok direto não rola: cola o link de um vídeo da pessoa, que aparece o botão de baixar a foto de perfil.'); },
    };
  }

  return null;
}

module.exports = { match };

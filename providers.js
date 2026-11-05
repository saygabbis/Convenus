'use strict';

// Extras por plataforma (fotos de posts e perfis) via APIs públicas.
// Vídeo e áudio continuam com o yt-dlp; aqui só entra o que ele não cobre.

const UA = 'Convenus/1.0 (+https://convert.saygabbis.cloud)';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- X / Twitter (FxTwitter) ----------

const X_HOST = /^(?:www\.|mobile\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/i;
const X_RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'notifications', 'messages', 'intent', 'share', 'hashtag']);

async function xPost(id) {
  const { tweet: t } = await getJson(`https://api.fxtwitter.com/status/${id}`);
  if (!t) throw new Error('Post não encontrado.');
  const all = t.media?.all || [];
  return {
    title: t.text ? t.text.slice(0, 140) : `Post de @${t.author.screen_name}`,
    uploader: `@${t.author.screen_name}`,
    thumbnail: all.find((m) => m.type === 'photo')?.url || all[0]?.thumbnail_url || t.author.avatar_url,
    media: all.map((m) => m.type === 'photo'
      ? { kind: 'image', url: m.url, thumb: m.url.replace('name=orig', 'name=small'), width: m.width, height: m.height }
      : { kind: 'video', url: m.url, thumb: m.thumbnail_url, width: Number(m.width) || 0, height: Number(m.height) || 0 }),
  };
}

async function xProfile(user) {
  const { user: u } = await getJson(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(user)}`);
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
  const { thread } = await getJson(`${BSKY}/app.bsky.feed.getPostThread?depth=0&uri=${encodeURIComponent(uri)}`);
  const p = thread?.post;
  if (!p) throw new Error('Post não encontrado.');
  const e = p.embed || {};
  const images = e.images || e.media?.images || [];
  return {
    title: (p.record?.text || '').slice(0, 140) || `Post de @${p.author.handle}`,
    uploader: `@${p.author.handle}`,
    thumbnail: images[0]?.thumb || e.thumbnail || e.media?.thumbnail || p.author.avatar,
    media: images.map((i) => ({ kind: 'image', url: i.fullsize, thumb: i.thumb, width: i.aspectRatio?.width || 0, height: i.aspectRatio?.height || 0 })),
  };
}

async function bskyProfile(handle) {
  const p = await getJson(`${BSKY}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  return { title: p.displayName || p.handle, handle: `@${p.handle}`, followers: p.followersCount || 0, avatar: p.avatar || null, banner: p.banner || null };
}

// ---------- roteamento ----------

/** Devolve { post } ou { profile } com a função que resolve o link, ou null se não houver extra pra ele. */
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

  return null;
}

module.exports = { match };

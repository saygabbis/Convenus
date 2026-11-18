'use strict';

// VOD da Twitch de uma live que ainda está rolando ("assistir desde o começo").
// A playlist (index-dvr.m3u8) só cresce e não tem fim (#EXT-X-ENDLIST), então o yt-dlp e o ffmpeg
// tratam como ao vivo: ficam esperando o fim ou se perdem no -ss. Aqui a gente tira uma foto da
// playlist agora, pega só os pedaços do trecho escolhido e fecha a lista: vira um vídeo comum.

const MAX_SEC = 4 * 3600; // sem corte (ou corte maior): mais que isso é arquivo gigante

/** Lê a playlist e devolve os segmentos com o tempo de cada um. */
function parse(text, url) {
  const head = [];
  const segs = [];
  let t = 0;
  let dur = null;
  for (const ln of String(text).split(/\r?\n/)) {
    if (ln.startsWith('#EXTINF:')) dur = parseFloat(ln.slice(8));
    else if (ln.startsWith('#EXT-X-MAP:')) head.push(ln.replace(/URI="([^"]+)"/, (_, u) => `URI="${new URL(u, url).href}"`));
    else if (/^#EXT-X-(TARGETDURATION|VERSION)/.test(ln)) head.push(ln);
    else if (ln && !ln.startsWith('#') && dur != null) {
      segs.push({ start: t, dur, url: new URL(ln, url).href });
      t += dur;
      dur = null;
    }
  }
  return { head, segs, total: t };
}

/**
 * Playlist fechada com os segmentos que cobrem [start, end] (end 0 = até agora).
 * Devolve { text, offset (onde o trecho começa dentro do primeiro segmento), len, total }.
 */
function subset(text, url, start = 0, end = 0) {
  const { head, segs, total } = parse(text, url);
  if (!segs.length) throw new Error('A Twitch não mandou nenhum pedaço dessa live ainda.');
  const s = Math.max(0, Math.min(start, total - 1));
  const e = end > 0 ? Math.min(end, total) : total;
  if (e - s < 0.2) throw new Error('Esse trecho ainda não foi transmitido.');
  const pick = segs.filter((g) => g.start + g.dur > s && g.start < e);
  const lines = ['#EXTM3U', ...head, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (const g of pick) lines.push(`#EXTINF:${g.dur.toFixed(3)},`, g.url);
  lines.push('#EXT-X-ENDLIST', '');
  return { text: lines.join('\n'), offset: Math.round((s - pick[0].start) * 1000) / 1000, len: Math.round((e - s) * 1000) / 1000, total };
}

/** Escolhe a versão: áudio (mp3/wav) ou a maior altura até a qualidade pedida (0 = a melhor). */
function pickVariant(variants, kind, quality) {
  const vs = (variants || []).filter((v) => /^https:\/\//.test(v.url));
  if (!vs.length) return null;
  const video = vs.filter((v) => v.h > 0).sort((a, b) => b.h - a.h);
  if (kind === 'mp3' || kind === 'wav') return vs.find((v) => v.h === 0) || video.at(-1);
  const cap = kind === 'gif' ? 720 : quality || Infinity;
  return video.find((v) => v.h <= cap) || video.at(-1) || vs[0];
}

module.exports = { parse, subset, pickVariant, MAX_SEC };

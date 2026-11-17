'use strict';

// Cortar trecho (início/fim), recortar o quadro (crop) e GIF.
// O clip chega do navegador como { start, end, crop: { x, y, w, h } (frações 0–1), gif: { fps, width } }.

const GIF_MAX_SEC = 60; // GIF de mais de 1 minuto vira arquivo gigante: corta antes
const GIF_FPS = [10, 12, 15, 20, 24, 30];
const GIF_WIDTHS = [240, 320, 480, 640, 720];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Valida o pedido. duration = duração do item (0 = desconhecida).
 * Devolve { clip } (ou clip null quando não há nada pra cortar) ou { error }.
 */
function cleanClip(raw, { duration = 0, kind }) {
  const c = raw && typeof raw === 'object' ? raw : {};
  let start = num(c.start);
  let end = num(c.end);
  if (!(start >= 0)) start = 0;
  if (!(end > 0)) end = duration || 0;
  if (duration) end = Math.min(end, duration);
  if (end && end - start < 0.2) return { error: 'O trecho ficou curto demais.' };

  let crop = null;
  if (c.crop && typeof c.crop === 'object') {
    const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((k) => num(c.crop[k]));
    if ([x, y, w, h].every((v) => v >= 0 && v <= 1) && w >= 0.05 && h >= 0.05 && x + w <= 1.0001 && y + h <= 1.0001) {
      if (w < 0.999 || h < 0.999) crop = { x: r3(x), y: r3(y), w: r3(Math.min(w, 1 - x)), h: r3(Math.min(h, 1 - y)) };
    }
  }

  let gif = null;
  if (kind === 'gif') {
    const len = (end || 0) - start;
    if (!end) return { error: 'Pra fazer GIF, escolhe o trecho no Cortar (até 60 s).' };
    if (len > GIF_MAX_SEC + 0.05) return { error: `GIF só até ${GIF_MAX_SEC} s. Escolhe um trecho menor no Cortar.` };
    const fps = GIF_FPS.includes(Number(c.gif?.fps)) ? Number(c.gif.fps) : 15;
    const width = GIF_WIDTHS.includes(Number(c.gif?.width)) ? Number(c.gif.width) : 480;
    gif = { fps, width };
  }

  const cut = start > 0.05 || (end && duration && end < duration - 0.05) || (end && !duration);
  if (!cut && !crop && !gif) return { clip: null };
  return { clip: { start: r3(start), end: end ? r3(end) : 0, crop, gif } };
}

const clipLen = (clip, duration = 0) => Math.max(0, (clip.end || duration) - clip.start);

// Filtro de recorte do quadro (sempre com lados pares, que o H.264 exige).
const cropFilter = (c) => `crop=trunc(iw*${c.w}/2)*2:trunc(ih*${c.h}/2)*2:trunc(iw*${c.x}):trunc(ih*${c.y})`;

function gifFilter(clip) {
  const pre = [clip.crop ? cropFilter(clip.crop) : null, `fps=${clip.gif.fps}`, `scale=${clip.gif.width}:-1:flags=lanczos`].filter(Boolean).join(',');
  return `${pre},split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
}

/** Argumentos do ffmpeg que transforma o arquivo baixado (já cortado no tempo) no resultado final. */
function postArgs(clip, kind, input, output, progress) {
  const base = ['-hide_banner', '-nostdin', '-y', '-i', input];
  const tail = ['-progress', progress, '-nostats', output];
  if (kind === 'gif') return [...base, '-filter_complex', gifFilter(clip), '-loop', '0', '-an', ...tail];
  // MP4 recortado no quadro.
  return [...base, '-vf', cropFilter(clip.crop), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', ...tail];
}

const needsPost = (clip, kind) => Boolean(clip && (kind === 'gif' || (kind === 'mp4' && clip.crop)));

// yt-dlp: baixa só o trecho (com corte exato nos quadros-chave).
function ytdlpSection(clip) {
  if (!clip || !(clip.start > 0.05 || clip.end)) return [];
  const end = clip.end ? clip.end : 'inf';
  return ['--download-sections', `*${clip.start}-${end}`, '--force-keyframes-at-cuts'];
}

// Pré-visualização: melhor formato que o navegador toca direto (MP4 com som, até 480p; senão só vídeo; senão áudio).
function previewFormat(formats, audioOnly = false) {
  const ok = (f) => f.url && /^https:/.test(f.url) && !/m3u8|dash|f4m|ism/i.test(`${f.protocol} ${f.ext}`) && !f.has_drm;
  // Versões "portrait" (recorte vertical que a Twitch gera) não são o vídeo original.
  const fs = (formats || []).filter(ok).filter((f) => !/portrait/i.test(f.format_id || ''));
  // Codec não informado (Twitch, vários sites): MP4 comum, com vídeo e áudio juntos.
  const av = (f) => f.vcodec !== 'none' && f.acodec !== 'none' && ((f.vcodec && f.acodec) || (!f.vcodec && !f.acodec && f.ext === 'mp4'));
  const vOnly = (f) => f.vcodec && f.vcodec !== 'none';
  const h264 = (f) => /avc1|h264/i.test(f.vcodec || '') || f.ext === 'mp4';
  const byH = (a, b) => (b.height || 0) - (a.height || 0);
  if (!audioOnly) {
    const both = fs.filter((f) => av(f) && h264(f) && (f.height || 0) <= 480).sort(byH)[0] || fs.filter((f) => av(f) && h264(f)).sort((a, b) => (a.height || 0) - (b.height || 0))[0];
    if (both) return { f: both, audio: true };
    const vid = fs.filter((f) => vOnly(f) && f.acodec === 'none' && h264(f) && (f.height || 0) <= 480 && (f.height || 0) >= 240).sort(byH)[0];
    if (vid) return { f: vid, audio: false };
  }
  const aud = fs.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && /m4a|mp4|mp3|webm|ogg|opus/.test(f.ext || ''))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  return aud ? { f: aud, audio: true } : null;
}

module.exports = { cleanClip, clipLen, postArgs, needsPost, ytdlpSection, cropFilter, gifFilter, previewFormat, GIF_MAX_SEC, GIF_FPS, GIF_WIDTHS };

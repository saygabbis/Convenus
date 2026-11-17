'use strict';

// Comprimir pra um tamanho-alvo ("quero que fique com 7 MB"). Cada tipo tem o seu jeito:
//  - vídeo: calcula o bitrate que cabe no alvo, escolhe a resolução que ainda fica bonita nesse
//    bitrate e codifica em duas passadas (o tamanho final sai bem perto do alvo); se passar,
//    refaz um pouco menor;
//  - áudio: bitrate exato pro alvo (MP3 ou, bem pequeno, Opus);
//  - imagem: procura a maior qualidade que cabe (busca binária) e só diminui a imagem se precisar;
//  - GIF animado: diminui tamanho/quadros por segundo até caber;
//  - PDF: Ghostscript reduzindo a resolução das imagens de dentro;
//  - o resto: ZIP com compressão máxima (sem perda nenhuma).
// O resultado nunca passa do alvo; quando não dá pra chegar, entrega o menor possível e avisa.

const fs = require('node:fs');
const path = require('node:path');

const MB = 1024 * 1024;
const fmtMB = (b) => `${(b / MB).toFixed(b < 10 * MB ? 2 : 1).replace('.', ',')} MB`;

const HEIGHTS = [2160, 1440, 1080, 720, 540, 480, 360, 240, 144];
// Bits por pixel por quadro que ainda dão uma imagem boa em cada codec (abaixo disso fica
// "quadriculado": melhor diminuir a resolução).
const BPP = { h264: 0.06, h265: 0.04, av1: 0.032, vp9: 0.045 };
const SPEED = {
  h264: { fast: 'veryfast', balanced: 'medium', best: 'slow' },
  h265: { fast: 'veryfast', balanced: 'medium', best: 'slow' },
  vp9: { fast: '4', balanced: '2', best: '1' },
  av1: { fast: '10', balanced: '7', best: '5' },
};

/** Opções que vêm do site, já validadas (qualquer coisa estranha vira o padrão). */
function cleanOpts(raw = {}) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const mb = Number(o.mb);
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  return {
    mb: Number.isFinite(mb) && mb >= 0.05 && mb <= 4096 ? Math.round(mb * 100) / 100 : 0,
    vcodec: pick(o.vcodec, ['h264', 'h265', 'av1', 'vp9'], 'h264'),
    maxHeight: pick(Number(o.maxHeight), [0, ...HEIGHTS], 0),
    fps: pick(Number(o.fps), [0, 60, 30, 24, 15], 0),
    audio: pick(String(o.audio ?? 'auto'), ['auto', 'none', '32', '48', '64', '96', '128', '160', '192'], 'auto'),
    speed: pick(o.speed, ['fast', 'balanced', 'best'], 'balanced'),
    image: pick(o.image, ['auto', 'jpg', 'webp', 'avif', 'png'], 'auto'),
    keepMeta: o.keepMeta === true,
  };
}

/** Dá pra comprimir esse arquivo pro alvo? Quanto é o mínimo? (pro site avisar antes). */
function minimumBytes(info) {
  if ((info.kind === 'video' || info.kind === 'audio') && info.duration) {
    const kbps = info.kind === 'video' ? 40 + (info.hasAudio ? 24 : 0) : 6;
    return Math.ceil((info.duration * kbps * 1000) / 8 / 0.95);
  }
  return 0;
}

function outExt(info, o) {
  if (info.kind === 'video') return o.vcodec === 'vp9' ? 'webm' : 'mp4';
  if (info.kind === 'image' && !info.animated) {
    if (o.image !== 'auto') return o.image;
    return ['jpg', 'heic', 'bmp', 'tiff', 'psd'].includes(info.ext) && info.from !== 'svg' ? 'jpg' : info.ext === 'avif' ? 'avif' : 'webp';
  }
  if (info.animated) return 'gif';
  if (info.kind === 'pdf') return 'pdf';
  return null; // áudio decide pelo bitrate; o resto vira ZIP
}

async function compress(ctx) {
  const { info, input, dir, base, o } = ctx;
  const target = Math.floor(o.mb * MB);
  if (!target) return { code: 1, stderr: 'ERRO: Escolhe de quantos MB quer que fique.' };
  const size = fs.statSync(input).size;
  ctx.size = size;
  const name = (ext) => path.join(dir, `${base} (comprimido).${ext}`);

  // Já cabe: não estraga o arquivo à toa.
  if (size <= target && !ctx.force) {
    const ext = path.extname(ctx.name || '').slice(1).toLowerCase() || info.realExt || info.ext || 'bin';
    const out = name(ext);
    fs.copyFileSync(input, out);
    return { code: 0, file: out, note: `Já tinha ${fmtMB(size)}, abaixo de ${fmtMB(target)}: foi do jeito que estava, sem perder nada.` };
  }

  if (info.kind === 'video') return video(ctx, target, name);
  if (info.kind === 'audio') return audio(ctx, target, name);
  if (info.kind === 'image' && info.animated) return gif(ctx, target, name);
  if (info.kind === 'image') return image(ctx, target, name);
  if (info.kind === 'pdf') return pdf(ctx, target, name);
  return lossless(ctx, target, name);
}

// ---------- vídeo ----------

function chooseShape(info, o, videoK) {
  const srcH = info.height || 1080;
  const srcW = info.width || Math.round(srcH * 16 / 9);
  const aspect = srcW / srcH;
  const cap = o.maxHeight ? Math.min(o.maxHeight, srcH) : srcH;
  const fpsList = o.fps ? [o.fps] : [30, 24, 15];
  const bpp = BPP[o.vcodec];
  const heights = [cap, ...HEIGHTS.filter((h) => h < cap)];
  // Maior resolução que ainda fica bonita; se nem 144p fica, reduz os quadros por segundo.
  for (const fps of fpsList) {
    for (const h of heights) {
      const w = Math.round(h * aspect);
      if ((videoK * 1000) / (w * h * fps) >= bpp) return { h, fps: o.fps || (fps === 30 ? 0 : fps) };
    }
  }
  return { h: heights.at(-1), fps: o.fps || fpsList.at(-1) };
}

async function video(ctx, target, name) {
  const { info, input, dir, o, exec, onProgress } = ctx;
  const dur = info.duration;
  if (!dur) return { code: 1, stderr: 'ERRO: Não consegui ler a duração desse vídeo pra calcular o tamanho.' };
  const ext = o.vcodec === 'vp9' ? 'webm' : 'mp4';
  const out = name(ext);
  const totalK = (target * 8 * 0.96) / dur / 1000; // ~4% pro contêiner
  let audioK = 0;
  if (info.hasAudio && o.audio !== 'none') {
    audioK = o.audio === 'auto'
      ? [160, 128, 96, 64, 48, 32].find((k) => k <= totalK * 0.14) || 24
      : Number(o.audio);
    if (ext === 'mp4' && audioK < 32) audioK = 32;
  }
  let videoK = Math.floor(totalK - audioK);
  // Alvo minúsculo: faz mesmo assim, no menor que dá (sem som se for automático, bitrate mínimo, quadro pequeno).
  if (videoK < 40) {
    if (o.audio === 'auto') audioK = 0;
    videoK = Math.max(8, Math.floor(totalK - audioK));
  }

  const aArgs = audioK ? (ext === 'webm' ? ['-c:a', 'libopus', '-b:a', `${audioK}k`] : ['-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', audioK < 64 ? '1' : '2']) : ['-an'];
  const meta = o.keepMeta ? [] : ['-map_metadata', '-1', '-map_chapters', '-1'];
  const log = path.join(dir, 'passlog');
  let last = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const { h, fps } = chooseShape(info, o, videoK);
    const vf = [`scale=-2:'min(${h},ih)':flags=lanczos`, ...(fps ? [`fps=${fps}`] : []), 'format=yuv420p'].join(',');
    const sp = SPEED[o.vcodec][o.speed];
    const vcodec = {
      h264: ['-c:v', 'libx264', '-preset', sp, '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.6)}k`, '-bufsize', `${videoK * 2}k`],
      h265: ['-c:v', 'libx265', '-preset', sp, '-b:v', `${videoK}k`, '-tag:v', 'hvc1'],
      vp9: ['-c:v', 'libvpx-vp9', '-b:v', `${videoK}k`, '-cpu-used', sp, '-row-mt', '1', '-deadline', 'good'],
      av1: ['-c:v', 'libsvtav1', '-preset', sp, '-b:v', `${videoK}k`],
    }[o.vcodec];
    const common = ['-hide_banner', '-nostdin', '-y', ...ctx.avIn, '-i', `file:${input}`, '-map', '0:v:0', ...(audioK ? ['-map', '0:a:0?'] : []), '-vf', vf, ...vcodec];
    const twoPass = o.vcodec !== 'av1';
    const prog = (from, span) => (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && onProgress) onProgress(Math.min(99, from + (Number(m.pop().split('=')[1]) / 1e6 / dur) * span));
    };
    const span = 99 / (attempt + 1);
    if (twoPass) {
      const passArgs = (n) => (o.vcodec === 'h265' ? ['-x265-params', `pass=${n}:stats=${log}.x265:log-level=error`] : ['-pass', String(n), '-passlogfile', log]);
      const p1 = await exec('ffmpeg', [...common, ...passArgs(1), '-an', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'], { onStdout: prog(0, span * 0.45) });
      if (ctx.stopped() || p1.code !== 0) return p1;
      last = await exec('ffmpeg', [...common, ...passArgs(2), ...aArgs, ...meta, ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), '-progress', 'pipe:1', '-nostats', `file:${out}`], { onStdout: prog(span * 0.45, span * 0.55) });
    } else {
      last = await exec('ffmpeg', [...common, ...aArgs, ...meta, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', `file:${out}`], { onStdout: prog(0, span) });
    }
    if (ctx.stopped() || last.code !== 0) return last;
    const got = fs.statSync(out).size;
    if (got <= target) {
      cleanPass(dir);
      return { code: 0, file: out, note: noteFor(ctx.size, got, target, h < (info.height || h) ? `${h}p` : '') };
    }
    videoK = Math.floor(videoK * (target / got) * 0.97);
    if (videoK < 30) break;
  }
  cleanPass(dir);
  return { code: 1, stderr: `ERRO: Não consegui deixar abaixo de ${fmtMB(target)}. Tenta um alvo um pouco maior.` };
}

function cleanPass(dir) {
  for (const f of fs.readdirSync(dir)) if (f.startsWith('passlog')) fs.rmSync(path.join(dir, f), { force: true });
}

// ---------- áudio ----------

async function audio(ctx, target, name) {
  const { info, input, o, exec, onProgress } = ctx;
  const dur = info.duration;
  if (!dur) return { code: 1, stderr: 'ERRO: Não consegui ler a duração desse áudio pra calcular o tamanho.' };
  let k = Math.floor((target * 8 * 0.97) / dur / 1000);
  if (k < 6) return { code: 1, stderr: `ERRO: ${fmtMB(target)} é pouco demais pra ${Math.round(dur)} s de áudio. O mínimo que dá é uns ${fmtMB(minimumBytes(info))}.` };
  const meta = o.keepMeta ? [] : ['-map_metadata', '-1'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const mp3 = k >= 64;
    const kk = mp3 ? Math.min(320, k) : Math.max(6, k);
    const out = name(mp3 ? 'mp3' : 'ogg');
    const codec = mp3 ? ['-c:a', 'libmp3lame', '-b:a', `${kk}k`, ...(kk < 96 ? ['-ac', '1'] : [])] : ['-c:a', 'libopus', '-b:a', `${kk}k`, '-vbr', 'constrained', ...(kk < 32 ? ['-ac', '1'] : [])];
    const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...ctx.avIn, '-i', `file:${input}`, '-vn', '-map', '0:a:0', ...codec, ...meta, '-progress', 'pipe:1', '-nostats', `file:${out}`], {
      onStdout: (d) => {
        const m = String(d).match(/out_time_us=(\d+)/g);
        if (m && onProgress) onProgress(Math.min(99, (Number(m.pop().split('=')[1]) / 1e6 / dur) * 100));
      },
    });
    if (ctx.stopped() || r.code !== 0) return r;
    const got = fs.statSync(out).size;
    if (got <= target) return { code: 0, file: out, note: noteFor(ctx.size, got, target, `${kk} kbps`) };
    fs.rmSync(out, { force: true });
    k = Math.floor(kk * (target / got) * 0.97);
    if (k < 6) break;
  }
  return { code: 1, stderr: `ERRO: Não consegui deixar abaixo de ${fmtMB(target)}.` };
}

// ---------- imagem ----------

async function image(ctx, target, name) {
  const { info, input, o, exec, onProgress } = ctx;
  const ext = outExt(info, o);
  const out = name(ext);
  const coder = { jpg: 'jpeg', webp: 'webp', avif: 'avif', png: 'png' }[ext];
  const src = `${ctx.imgCoder}:${input}[0]`;
  const meta = o.keepMeta ? [] : ['-strip'];
  const flat = ext === 'jpg' ? ['-background', 'white', '-alpha', 'remove', '-alpha', 'off'] : [];
  let tries = 0;
  const attempt = async (q, scale) => {
    tries++;
    if (onProgress) onProgress(Math.min(95, tries * 7));
    const resize = scale < 1 ? ['-resize', `${(scale * 100).toFixed(2)}%`] : [];
    const qual = ext === 'png' ? ['-define', 'png:compression-level=9', ...(q < 100 ? ['-colors', String(Math.max(16, Math.round(q * 2.56)))] : [])] : ['-quality', String(q)];
    const r = await exec('convert', [...ctx.imLimits, src, '-auto-orient', ...resize, ...meta, ...flat, ...qual, `${coder}:${out}`], { mem: 3 * 1024 ** 3 });
    if (r.code !== 0) return { r };
    return { r, size: fs.statSync(out).size };
  };

  let scale = 1;
  let best = null; // { q, scale, size }
  for (let round = 0; round < 6 && !ctx.stopped(); round++) {
    // Maior qualidade que cabe nessa escala (a qualidade importa mais que pixels a mais).
    let lo = ext === 'png' ? 8 : 35;
    let hi = ext === 'png' ? 100 : 92;
    let fit = null;
    const top = await attempt(hi, scale);
    if (!top.size) return top.r;
    if (top.size <= target) fit = { q: hi, scale, size: top.size };
    else {
      const bottom = await attempt(lo, scale);
      if (!bottom.size) return bottom.r;
      if (bottom.size <= target) {
        fit = { q: lo, scale, size: bottom.size };
        while (hi - lo > 3) {
          const mid = Math.round((lo + hi) / 2);
          const m = await attempt(mid, scale);
          if (!m.size) return m.r;
          if (m.size <= target) { lo = mid; fit = { q: mid, scale, size: m.size }; } else hi = mid;
        }
      } else {
        // Nem a qualidade mínima cabe: diminui a imagem na proporção e tenta de novo.
        scale *= Math.sqrt(target / bottom.size) * 0.92;
        if (scale < 0.05) break;
        continue;
      }
    }
    best = fit;
    break;
  }
  if (!best) return { code: 1, stderr: `ERRO: Não consegui deixar essa imagem abaixo de ${fmtMB(target)}.` };
  const done = await attempt(best.q, best.scale); // grava a melhor de novo (a última tentativa pode ter sido outra)
  if (!done.size) return done.r;
  const dims = best.scale < 1 && info.width ? `${Math.round(info.width * best.scale)}×${Math.round(info.height * best.scale)}` : '';
  return { code: 0, file: out, note: noteFor(ctx.size, done.size, target, [ext.toUpperCase(), ext === 'png' ? '' : `qualidade ${best.q}`, dims].filter(Boolean).join(' · ')) };
}

// ---------- GIF animado ----------

async function gif(ctx, target, name) {
  const { info, input, exec, onProgress } = ctx;
  const out = name('gif');
  const w = info.width || 480;
  const steps = [];
  for (const k of [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25]) for (const fps of [0, 15, 10]) steps.push({ width: Math.max(32, Math.round((w * k) / 2) * 2), fps });
  let n = 0;
  for (const s of steps) {
    if (ctx.stopped()) return { code: 1, stderr: '' };
    if (onProgress) onProgress(Math.min(95, (++n / steps.length) * 100));
    const vf = `${s.fps ? `fps=${s.fps},` : ''}scale=${s.width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=${n > 6 ? 128 : 256}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...ctx.avIn, '-i', `file:${input}`, '-an', '-vf', vf, '-loop', '0', `file:${out}`]);
    if (r.code !== 0) return r;
    const got = fs.statSync(out).size;
    if (got <= target) return { code: 0, file: out, note: noteFor(ctx.size, got, target, `${s.width}px${s.fps ? ` · ${s.fps} fps` : ''}`) };
  }
  return { code: 1, stderr: `ERRO: Esse GIF não cabe em ${fmtMB(target)} nem bem pequeno. Converte ele pra MP4 (fica muito menor) e comprime o vídeo.` };
}

// ---------- PDF ----------

async function pdf(ctx, target, name) {
  const { input, dir, exec, onProgress } = ctx;
  const out = name('pdf');
  let smallest = null;
  const res = [220, 150, 110, 80, 60, 45];
  for (const [i, dpi] of res.entries()) {
    if (ctx.stopped()) return { code: 1, stderr: '' };
    if (onProgress) onProgress(((i + 1) / res.length) * 95);
    const tmp = path.join(dir, `.pdf${dpi}.pdf`);
    const r = await exec('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5',
      '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
      '-dDownsampleColorImages=true', '-dColorImageDownsampleType=/Bicubic', `-dColorImageResolution=${dpi}`,
      '-dDownsampleGrayImages=true', '-dGrayImageDownsampleType=/Bicubic', `-dGrayImageResolution=${dpi}`,
      '-dDownsampleMonoImages=true', `-dMonoImageResolution=${Math.max(150, dpi * 2)}`,
      `-sOutputFile=${tmp}`, '-f', input], { mem: 2 * 1024 ** 3 });
    if (r.code !== 0) return r;
    const got = fs.statSync(tmp).size;
    if (!smallest || got < smallest.size) {
      if (smallest) fs.rmSync(smallest.file, { force: true });
      smallest = { file: tmp, size: got, dpi };
    } else fs.rmSync(tmp, { force: true });
    if (got <= target) break;
  }
  fs.renameSync(smallest.file, out);
  if (smallest.size <= target) return { code: 0, file: out, note: noteFor(ctx.size, smallest.size, target, `imagens a ${smallest.dpi} dpi`) };
  return { code: 0, file: out, note: `Não deu pra chegar em ${fmtMB(target)} sem estragar o texto: o menor possível foi ${fmtMB(smallest.size)}.`, missed: true };
}

// ---------- o resto: sem perda ----------

async function lossless(ctx, target, name) {
  const { input, exec } = ctx;
  const ext = ctx.name && path.extname(ctx.name) ? '' : `.${ctx.info.realExt || ctx.info.ext || 'bin'}`;
  const out = name('zip');
  const r = await exec(process.execPath, [ctx.fileconv, 'zipmax', input, out, `${path.basename(ctx.name || 'arquivo')}${ext}`], { mem: 2 * 1024 ** 3 });
  if (r.code !== 0) return r;
  const got = fs.statSync(out).size;
  if (got <= target) return { code: 0, file: out, note: noteFor(ctx.size, got, target, 'ZIP sem perda') };
  return { code: 0, file: out, note: `Esse tipo de arquivo só dá pra comprimir sem perda: o menor possível foi ${fmtMB(got)} (o alvo era ${fmtMB(target)}).`, missed: true };
}

function noteFor(before, after, target, detail) {
  const pct = before ? Math.round((1 - after / before) * 100) : 0;
  return `${fmtMB(before)} → ${fmtMB(after)}${pct > 0 ? ` (−${pct}%)` : ''} · alvo ${fmtMB(target)}${detail ? ` · ${detail}` : ''}`;
}

module.exports = { compress, cleanOpts, minimumBytes, outExt, chooseShape, fmtMB };

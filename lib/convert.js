'use strict';

// Conversor de arquivos enviados: descobre o que o arquivo É pelos bytes (nunca pelo nome) e
// converte com ffmpeg (vídeo/áudio/GIF), ImageMagick (imagens), Ghostscript (PDF) ou
// lib/fileconv.js (dados, documentos, legendas, compactar).
//
// Segurança (o arquivo vem de qualquer pessoa):
//  - o tipo vem dos bytes; o leitor de cada programa é forçado (sem "adivinhar" formato);
//  - ffmpeg só abre arquivo local e só com leitores da lista (nada de playlist HLS/concat que
//    leria outros arquivos do servidor);
//  - ImageMagick com o leitor certo na frente do nome (png:..., jpeg:...) e limites de memória/
//    tamanho/tempo; Ghostscript com -dSAFER;
//  - todo programa roda com prioridade baixa e limite de CPU, tamanho de arquivo e memória.

const fs = require('node:fs');
const path = require('node:path');
const proc = require('./proc');
const { zipNames } = require('./fileconv');

const FILECONV = path.join(__dirname, 'fileconv.js');
const HAS_PRLIMIT = process.platform === 'linux' && fs.existsSync('/usr/bin/prlimit');
const GB = 1024 ** 3;

// Leitores do ffmpeg permitidos (contêineres de áudio/vídeo comuns). Fora da lista: hls, concat,
// image2, tty, lavfi e qualquer coisa que abra outro arquivo.
const AV_FORMATS = 'mov,matroska,avi,flv,mpegts,mpeg,mpegvideo,m4v,h264,hevc,mp3,wav,w64,ogg,flac,aac,aiff,asf,amr,caf,ape,wv,au,ac3,eac3,dts,truehd,tta,nut,rm,dv,mxf,gif';
const AV_IN = ['-protocol_whitelist', 'file', '-format_whitelist', AV_FORMATS];

const IMG_CODER = { png: 'png', jpg: 'jpeg', gif: 'gif', webp: 'webp', bmp: 'bmp', tiff: 'tiff', ico: 'ico', heic: 'heic', avif: 'avif', psd: 'psd' };
const IM_LIMITS = ['-limit', 'memory', '512MiB', '-limit', 'map', '1GiB', '-limit', 'disk', '2GiB', '-limit', 'area', '128MP',
  '-limit', 'width', '16KP', '-limit', 'height', '16KP', '-limit', 'time', '180', '-limit', 'thread', '2'];

const LABEL = {
  mp4: 'MP4', webm: 'WEBM', mkv: 'MKV', mov: 'MOV', avi: 'AVI', gif: 'GIF', mp3: 'MP3', m4a: 'M4A', wav: 'WAV', ogg: 'OGG', opus: 'OPUS',
  flac: 'FLAC', aac: 'AAC', aiff: 'AIFF', png: 'PNG', jpg: 'JPG', webp: 'WEBP', avif: 'AVIF', bmp: 'BMP', tiff: 'TIFF', ico: 'ICO',
  pdf: 'PDF', txt: 'TXT', md: 'Markdown', html: 'HTML', csv: 'CSV', tsv: 'TSV', json: 'JSON', yaml: 'YAML', srt: 'SRT', vtt: 'VTT',
  zip: 'ZIP', gz: 'GZ', b64: 'Base64', unpack: 'Descompactar', docx: 'Word', odt: 'ODT', pptx: 'PowerPoint', xlsx: 'Excel', heic: 'HEIC',
  psd: 'PSD', svg: 'SVG', bin: 'Arquivo',
};
const KIND_LABEL = { video: 'Vídeo', audio: 'Áudio', image: 'Imagem', pdf: 'PDF', doc: 'Documento', data: 'Dados', sub: 'Legenda', text: 'Texto', archive: 'Compactado', other: 'Arquivo' };
const IMAGE_OUT = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'avif']); // dá pra copiar no navegador

const MAX_INLINE = 20 * 1024 * 1024; // texto/dados maiores que isso: só compactar

// ---------- descobrir o tipo ----------

function head(file, n = 65_536) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
  } finally {
    fs.closeSync(fd);
  }
}

function sniff(b) {
  const at = (o, s) => b.length >= o + s.length && b.toString('latin1', o, o + s.length) === s;
  if (at(0, '%PDF-')) return { kind: 'pdf', ext: 'pdf' };
  if (at(0, '\x89PNG\r\n\x1a\n')) return { kind: 'image', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { kind: 'image', ext: 'gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { kind: 'image', ext: 'webp' };
  if (at(0, 'BM') && b.length > 26 && [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))) return { kind: 'image', ext: 'bmp' };
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return { kind: 'image', ext: 'tiff' };
  if (b.length > 6 && b.readUInt32BE(0) === 0x00000100 && b.readUInt16LE(4) > 0 && b.readUInt16LE(4) < 256) return { kind: 'image', ext: 'ico' };
  if (at(0, '8BPS')) return { kind: 'image', ext: 'psd' };
  if (at(4, 'ftyp')) {
    const size = Math.min(b.length, b.readUInt32BE(0));
    const brands = [];
    for (let o = 8; o + 4 <= size; o += 4) brands.push(b.toString('latin1', o, o + 4));
    if (brands[0] === 'avif' || brands[0] === 'avis' || (brands[0] === 'mif1' && brands.includes('avif'))) return { kind: 'image', ext: 'avif' };
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brands[0])) return { kind: 'image', ext: 'heic' };
    return null; // MP4/MOV/M4A: o ffprobe diz
  }
  if (at(0, 'PK\x03\x04')) return { kind: 'archive', ext: 'zip' };
  if (b[0] === 0x1f && b[1] === 0x8b) return { kind: 'archive', ext: 'gz' };
  return null;
}

function textOf(b) {
  if (!b.length || b.includes(0)) return null;
  let n = b.length;
  if (n === 65_536) while (n > 0 && (b[n - 1] & 0xc0) === 0x80) n--; // não corta um acento no meio
  if (n === 65_536 && b[n - 1] >= 0xc0) n--;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n));
  } catch {
    // Texto antigo do Windows (ANSI): aceita se quase tudo for imprimível.
    let bad = 0;
    for (const x of b) if (x < 9 || (x > 13 && x < 32) || x === 127) bad++;
    return bad / b.length < 0.01 ? b.toString('latin1') : null;
  }
}

const extOf = (name) => (path.extname(String(name || '')).slice(1).toLowerCase());

async function probe(file) {
  const r = await proc.run('ffprobe', ['-v', 'error', ...AV_IN, '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic', '-of', 'json', `file:${file}`],
  { timeoutMs: 30_000, maxStdout: 2 * 1024 * 1024 }).done;
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * O que é o arquivo e pra onde ele pode ir.
 * `hint` = formato original que o navegador já converteu (SVG vira PNG no navegador).
 */
async function detect(file, name, { hint = '' } = {}) {
  const size = fs.statSync(file).size;
  const b = head(file);
  const ext = extOf(name);
  let info = sniff(b);

  if (info?.ext === 'zip') {
    let names = [];
    try {
      names = zipNames(file);
    } catch { /* ZIP estranho: fica como compactado */ }
    if (names.includes('word/document.xml')) info = { kind: 'doc', ext: 'docx' };
    else if (names.includes('xl/workbook.xml')) info = { kind: 'data', ext: 'xlsx' };
    else if (names.includes('ppt/presentation.xml')) info = { kind: 'doc', ext: 'pptx' };
    else if (names.includes('content.xml') && head(file, 120).toString('latin1').includes('opendocument.text')) info = { kind: 'doc', ext: 'odt' };
  }

  if (!info || info.ext === 'gif') {
    const p = await probe(file);
    const streams = p?.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = streams.find((s) => s.codec_type === 'audio');
    const duration = Number(p?.format?.duration) || 0;
    if (info?.ext === 'gif') {
      if (duration > 0.15) info = { ...info, animated: true, duration, width: video?.width || 0, height: video?.height || 0 };
    } else if (video || audio) {
      info = {
        kind: video ? 'video' : 'audio',
        ext: video ? ({ webm: 'webm', mkv: 'mkv', mov: 'mov', avi: 'avi', flv: 'flv', mp4: 'mp4', m4v: 'mp4', wmv: 'wmv', ts: 'ts', mpg: 'mpg' }[ext] || 'mp4')
          : ({ mp3: 'mp3', m4a: 'm4a', wav: 'wav', ogg: 'ogg', opus: 'opus', flac: 'flac', aac: 'aac', aiff: 'aiff', aif: 'aiff', wma: 'wma', amr: 'amr' }[ext] || 'audio'),
        duration,
        vcodec: video?.codec_name || '',
        acodec: audio?.codec_name || '',
        width: video?.width || 0,
        height: video?.height || 0,
        hasAudio: Boolean(audio),
      };
    }
  }

  if (!info) {
    const text = textOf(b);
    if (text != null) {
      const t = text.replace(/^\uFEFF/, '').trimStart();
      if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(t)) info = { kind: 'image', ext: 'svg' };
      else if (ext === 'json' || ((ext === '' || ext === 'txt') && /^[[{]/.test(t))) info = { kind: 'data', ext: 'json' };
      else if (ext === 'csv' || ext === 'tsv') info = { kind: 'data', ext };
      else if (ext === 'srt' || /^\d+\s*\n\d\d:\d\d:\d\d,\d{3}\s*-->/.test(t)) info = { kind: 'sub', ext: 'srt' };
      else if (ext === 'vtt' || /^WEBVTT/.test(t)) info = { kind: 'sub', ext: 'vtt' };
      else if (ext === 'md' || ext === 'markdown') info = { kind: 'text', ext: 'md' };
      else if (ext === 'html' || ext === 'htm' || /^<!doctype html|^<html[\s>]/i.test(t)) info = { kind: 'text', ext: 'html' };
      else info = { kind: 'text', ext: 'txt', realExt: ext || 'txt' };
    }
  }

  info = info || { kind: 'other', ext: 'bin', realExt: ext };
  if (hint === 'svg' && info.ext === 'png') info.from = 'svg';
  info.size = size;
  return info;
}

// ---------- pra onde pode ir ----------

function groups(info) {
  const k = info.kind;
  const g = [];
  const big = info.size > MAX_INLINE;
  if (k === 'video') {
    g.push(['Vídeo', ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif']]);
    if (info.hasAudio) g.push(['Áudio', ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac']]);
  } else if (k === 'audio') g.push(['Áudio', ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'aiff']]);
  else if (k === 'image' && info.ext !== 'svg') {
    g.push(['Imagem', ['png', 'jpg', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico']]);
    if (info.animated) g.push(['Vídeo', ['mp4', 'webm']]);
    g.push(['Documento', ['pdf']]);
  } else if (k === 'pdf') {
    g.push(['Imagem', ['png', 'jpg']], ['Documento', ['txt']]);
  } else if (info.ext === 'docx' || info.ext === 'odt') g.push(['Documento', ['pdf', 'txt', 'md', 'html']]);
  else if (info.ext === 'pptx') g.push(['Documento', ['pdf', 'txt', 'md']]);
  else if (info.ext === 'xlsx') g.push(['Dados', ['csv', 'tsv', 'json', 'yaml']], ['Documento', ['pdf', 'html']]);
  else if (k === 'data' && !big) g.push(['Dados', ['json', 'csv', 'tsv', 'yaml']], ['Documento', ['pdf', 'html', 'txt']]);
  else if (k === 'sub' && !big) g.push(['Legenda', ['srt', 'vtt', 'txt']]);
  else if (k === 'text' && !big) g.push(['Documento', info.ext === 'md' ? ['html', 'pdf', 'txt'] : info.ext === 'html' ? ['txt', 'md', 'pdf'] : ['pdf', 'html']]);
  if (info.ext === 'gz') g.push(['Compactado', ['unpack']]);
  const pack = ['zip', 'gz', 'b64'].filter((x) => !(x === 'zip' && info.ext === 'zip') && !(x === 'gz' && info.ext === 'gz'));
  g.push(['Compactar', pack]);
  const self = info.from ? null : info.ext;
  return g.map(([name, list]) => [name, list.filter((t) => t !== self && !(t === 'md' && info.ext === 'md'))]).filter(([, l]) => l.length);
}

/** Lista pro site: [{ to, label, group }]. */
function targets(info) {
  return groups(info).flatMap(([group, list]) => list.map((to) => ({ to, label: LABEL[to] || to.toUpperCase(), group })));
}

function describe(info) {
  const fmt = LABEL[info.from || info.ext] || String(info.realExt || info.ext || '').toUpperCase() || 'Arquivo';
  const kind = info.from === 'svg' ? 'Imagem' : KIND_LABEL[info.kind] || 'Arquivo';
  const bits = [info.ext === 'bin' || info.ext === 'audio' || kind === fmt ? kind : `${kind} ${fmt}`];
  if (info.animated) bits[0] = 'GIF animado';
  if (info.width && info.height) bits.push(`${info.width}×${info.height}`);
  if (info.duration && info.kind !== 'image') bits.push(fmtDur(info.duration));
  return bits.join(' · ');
}
function fmtDur(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------- converter ----------

function limited(cmd, args, { mem = 0 } = {}) {
  if (!HAS_PRLIMIT) return [cmd, args];
  return ['prlimit', ['--cpu=10800', `--fsize=${16 * GB}`, '--nofile=256', ...(mem ? [`--as=${mem}`] : []), '--', 'nice', '-n', '10', cmd, ...args]];
}

function outName(base, to, info, name) {
  if (to === 'b64') return `${base}.${info.realExt || info.ext}.base64.txt`;
  if (to === 'gz') return `${path.basename(name)}.gz`;
  if (to === 'unpack') return path.basename(name).replace(/\.t?gz$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')) || `${base}`;
  return `${base}.${to}`;
}

const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
function avArgs(info, to) {
  const v = info.vcodec;
  const a = info.acodec;
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', even];
  const aac = ['-c:a', 'aac', '-b:a', '192k'];
  switch (to) {
    case 'mp4':
      if (v === 'h264' && (!a || ['aac', 'mp3'].includes(a))) return ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart'];
      return ['-map', '0:v:0', '-map', '0:a:0?', ...x264, ...aac, '-movflags', '+faststart'];
    case 'webm':
      if (['vp8', 'vp9', 'av1'].includes(v) && (!a || ['opus', 'vorbis'].includes(a))) return ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy'];
      return ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '33', '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k'];
    case 'mkv':
      return ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy'];
    case 'mov':
      if (['h264', 'hevc', 'prores', 'mjpeg'].includes(v) && (!a || ['aac', 'alac', 'pcm_s16le', 'mp3'].includes(a))) return ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart'];
      return ['-map', '0:v:0', '-map', '0:a:0?', ...x264, ...aac, '-movflags', '+faststart'];
    case 'avi':
      return ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'mpeg4', '-q:v', '3', '-vtag', 'xvid', '-c:a', 'libmp3lame', '-q:a', '2'];
    case 'gif':
      return ['-t', '30', '-an', '-vf', "fps=12,scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", '-loop', '0'];
    case 'mp3': return ['-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '320k'];
    case 'm4a': return ['-vn', '-map', '0:a:0', ...(a === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']), '-movflags', '+faststart'];
    case 'wav': return ['-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le'];
    case 'ogg': return ['-vn', '-map', '0:a:0', '-c:a', 'libvorbis', '-q:a', '6'];
    case 'opus': return ['-vn', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', '160k'];
    case 'flac': return ['-vn', '-map', '0:a:0', '-c:a', 'flac'];
    case 'aac': return ['-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k', '-f', 'adts'];
    case 'aiff': return ['-vn', '-map', '0:a:0', '-c:a', 'pcm_s16be', '-f', 'aiff'];
    default: return null;
  }
}

function imArgs(info, to, input, out) {
  const keepFrames = to === 'gif' && info.ext === 'gif';
  const src = `${IMG_CODER[info.ext]}:${input}${keepFrames ? '' : '[0]'}`;
  const flat = ['-background', 'white', '-alpha', 'remove', '-alpha', 'off'];
  const tail = {
    png: [`png:${out}`],
    jpg: [...flat, '-quality', '90', `jpeg:${out}`],
    webp: ['-quality', '90', `webp:${out}`],
    avif: ['-quality', '70', `avif:${out}`],
    gif: [`gif:${out}`],
    bmp: [`bmp:${out}`],
    tiff: ['-compress', 'lzw', `tiff:${out}`],
    ico: ['-background', 'none', '-resize', '256x256>', '-define', 'icon:auto-resize=256,128,64,48,32,16', `ico:${out}`],
    pdf: [...flat, `pdf:${out}`],
  }[to];
  return tail ? [...IM_LIMITS, src, '-auto-orient', ...tail] : null;
}

/**
 * Converte. Devolve { done, stop }; done resolve com { code, stderr, file?, timedOut?, ... }.
 * onProgress(percent) pra vídeo/áudio (quando a duração é conhecida).
 */
function run({ info, to, input, dir, base, name, onProgress, timeoutMs = 60 * 60_000 }) {
  let current = null;
  let stopped = false;
  const exec = (cmd, args, opts = {}) => {
    const [c, a] = limited(cmd, args, opts);
    const h = proc.run(c, a, {
      // Ambiente mínimo: nenhum segredo do servidor chega no programa que lê o arquivo.
      timeoutMs, idleMs: 10 * 60_000, maxStdout: 64 * 1024, env: { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8', MAGICK_TEMPORARY_PATH: dir, TMPDIR: dir }, ...opts,
    });
    current = h;
    return h.done;
  };
  const out = path.join(dir, outName(base, to, info, name));

  const work = (async () => {
    // Vídeo / áudio / GIF animado -> vídeo/áudio
    const av = (info.kind === 'video' || info.kind === 'audio' || (info.animated && ['mp4', 'webm'].includes(to))) && avArgs(info, to);
    if (av) {
      const r = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...AV_IN, '-i', `file:${input}`, ...av, '-progress', 'pipe:1', '-nostats', `file:${out}`], {
        onStdout: (d) => {
          const m = String(d).match(/out_time_us=(\d+)/g);
          if (m && info.duration && onProgress) onProgress(Math.min(99, (Number(m.pop().split('=')[1]) / 1e6 / Math.min(info.duration, to === 'gif' ? 30 : Infinity)) * 100));
        },
      });
      // Cópia sem reconverter falhou (contêiner exigente): tenta reconvertendo.
      if (r.code !== 0 && !stopped && av.includes('copy') && ['mp4', 'mov', 'mkv', 'webm'].includes(to)) {
        return exec('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...AV_IN, '-i', `file:${input}`, ...avArgs({ ...info, vcodec: 'x', acodec: 'x' }, to === 'mkv' ? 'mp4' : to).filter((x) => x !== '+faststart' && x !== '-movflags'), '-progress', 'pipe:1', '-nostats', `file:${out}`]).then((r2) => ({ ...r2, file: out }));
      }
      return { ...r, file: out };
    }

    // Imagens
    if (info.kind === 'image' && IMG_CODER[info.ext]) {
      const args = imArgs(info, to, input, out);
      if (args) return { ...(await exec('convert', args, { mem: 3 * GB })), file: out };
    }

    // PDF -> imagens (uma por página; várias páginas = ZIP) ou texto
    if (info.kind === 'pdf') {
      if (to === 'txt') {
        const r = await exec('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=txtwrite', `-sOutputFile=${out}`, '-f', input], { mem: 2 * GB });
        if (r.code === 0 && !stopped && !(fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim())) return { code: 1, stderr: 'ERRO: Esse PDF não tem texto (as páginas são imagens). Converte pra PNG ou JPG.' };
        return { ...r, file: out };
      }
      const pages = path.join(dir, '.paginas');
      fs.mkdirSync(pages, { recursive: true, mode: 0o700 });
      const r = await exec('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dFirstPage=1', '-dLastPage=200', '-r150',
        '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', ...(to === 'jpg' ? ['-sDEVICE=jpeg', '-dJPEGQ=90'] : ['-sDEVICE=png16m']),
        `-sOutputFile=${path.join(pages, `p%03d.${to}`)}`, '-f', input], { mem: 2 * GB });
      if (r.code !== 0 || stopped) return r;
      const files = fs.readdirSync(pages).sort();
      if (!files.length) return { code: 1, stderr: 'ERRO: Esse PDF não tem páginas.' };
      if (files.length === 1) {
        fs.renameSync(path.join(pages, files[0]), out);
        fs.rmSync(pages, { recursive: true, force: true });
        return { ...r, file: out };
      }
      for (const f of files) fs.renameSync(path.join(pages, f), path.join(pages, `${base} - página ${f.slice(1, 4)}.${to}`));
      const zip = path.join(dir, `${base} (${files.length} páginas ${LABEL[to]}).zip`);
      const z = await exec(process.execPath, [FILECONV, 'zipdir', pages, zip], { mem: 2 * GB });
      fs.rmSync(pages, { recursive: true, force: true });
      return { ...z, file: zip };
    }

    // O resto: Node puro, em processo separado.
    const from = info.ext;
    const r = await exec(process.execPath, [FILECONV, from, to, input, out, name], { mem: 3 * GB });
    return { ...r, file: out };
  })().catch((e) => ({ code: 1, stderr: `ERRO: ${e.message}` }));

  return {
    done: work,
    stop: () => {
      stopped = true;
      current?.stop?.();
    },
    get child() { return current?.child || null; },
  };
}

/** Mensagem amigável a partir do stderr da conversão. */
function friendly(stderr) {
  const s = String(stderr || '');
  const mine = s.split('\n').find((l) => l.startsWith('ERRO: '));
  if (mine) return mine.slice(6).trim();
  if (/width or height exceeds limit|area exceeds limit|cache resources exhausted|memory allocation failed/i.test(s)) return 'Imagem grande demais pra converter.';
  if (/Invalid data found|could not find codec|corrupt|Truncated|premature end|not a JPEG|improper image header|insufficient image data/i.test(s)) return 'Esse arquivo parece estar corrompido.';
  if (/password|encrypted/i.test(s)) return 'Esse arquivo tem senha.';
  if (/No space left/i.test(s)) return 'O servidor ficou sem espaço. Tenta de novo mais tarde.';
  return 'Não consegui converter esse arquivo.';
}

module.exports = { detect, targets, describe, run, friendly, sniff, IMAGE_OUT, LABEL, AV_FORMATS };

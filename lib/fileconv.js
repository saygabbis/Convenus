'use strict';

// Conversões feitas em Node puro, sem programa externo: dados (JSON/CSV/TSV/YAML), texto
// (TXT/MD/HTML -> PDF/HTML/TXT), legendas (SRT/VTT), Word/ODT/PowerPoint/Excel (texto e tabelas)
// e compactar (ZIP/GZ/Base64) ou descompactar GZ.
//
// Roda SEMPRE como processo separado (com limite de CPU, memória e tempo), nunca dentro do
// servidor: um arquivo malicioso derruba no máximo esse processo.
//   node lib/fileconv.js <de> <para> <entrada> <saída> [nome-original]
//   node lib/fileconv.js zipdir <pasta> <saída.zip>
// Erro: uma linha "ERRO: mensagem" no stderr e código 1.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, Writable } = require('node:stream');

const MAX_TEXT = 20 * 1024 * 1024; // texto/dados lidos inteiros na memória
const MAX_DOC = 60 * 1024 * 1024; // .docx/.xlsx/.pptx inteiros na memória
const MAX_ENTRY = 64 * 1024 * 1024; // cada parte descompactada de um .docx/.xlsx (contra "zip bomb")
const MAX_GUNZIP = 2 * 1024 ** 3; // .gz descompactado
const MAX_ROWS = 300_000;

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ---------- CRC32 / ZIP ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, prev = 0) {
  if (zlib.crc32) return zlib.crc32(buf, prev);
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ZIP em streaming (deflate ou guardado), com "data descriptor": não precisa ler o arquivo duas vezes.
class ZipWriter {
  constructor(out) {
    this.out = fs.createWriteStream(out, { mode: 0o600 });
    this.offset = 0;
    this.entries = [];
  }

  write(buf) {
    this.offset += buf.length;
    return new Promise((resolve, reject) => this.out.write(buf, (e) => (e ? reject(e) : resolve())));
  }

  async addFile(name, file, { store = false } = {}) {
    const nameBuf = Buffer.from(name, 'utf8');
    const start = this.offset;
    const { time, date } = dosTime();
    const method = store ? 0 : 8;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // bit 3: tamanhos no fim; bit 11: nome em UTF-8
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    await this.write(h);
    await this.write(nameBuf);
    let crc = 0;
    let size = 0;
    let csize = 0;
    const count = new Transform({ transform(c, _e, cb) { crc = crc32(c, crc); size += c.length; cb(null, c); } });
    const sink = new Writable({ write: (c, _e, cb) => { csize += c.length; this.write(c).then(() => cb(), cb); } });
    await pipeline(fs.createReadStream(file), count, ...(store ? [] : [zlib.createDeflateRaw({ level: 6 })]), sink);
    if (size >= 0xffffffff || csize >= 0xffffffff || this.offset >= 0xffffffff) fail('Ficou grande demais pra um ZIP.');
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(csize, 8);
    dd.writeUInt32LE(size, 12);
    await this.write(dd);
    this.entries.push({ nameBuf, crc, size, csize, start, method, time, date });
  }

  async close() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.start, 42);
      await this.write(c);
      await this.write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    await new Promise((resolve, reject) => this.out.end((e) => (e ? reject(e) : resolve())));
  }
}

// Diretório central de um ZIP (só leitura, com limites). `buf` = arquivo inteiro ou o fim dele.
function zipDirectory(buf, fileSize = buf.length, base = 0) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('Esse ZIP está corrompido.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > fileSize) fail('Esse ZIP está corrompido.');
  return { count: Math.min(count, 20_000), cdOff, cdSize };
}

function parseCentral(cd, count) {
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) fail('Esse ZIP está corrompido.');
    const nlen = cd.readUInt16LE(p + 28);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, {
      method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), off: cd.readUInt32LE(p + 42),
    });
    p += 46 + nlen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  return entries;
}

/** Nomes dentro de um ZIP, lendo só o fim do arquivo (pra descobrir se é .docx, .xlsx…). */
function zipNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const { count, cdOff, cdSize } = zipDirectory(tail, size);
    if (cdSize > 8 * 1024 * 1024) fail('ZIP com arquivos demais.');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    return [...parseCentral(cd, count).keys()];
  } finally {
    fs.closeSync(fd);
  }
}

function readZip(buf) {
  const { count, cdOff, cdSize } = zipDirectory(buf);
  const entries = parseCentral(buf.subarray(cdOff, cdOff + cdSize), count);
  const get = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.off + 30 > buf.length || buf.readUInt32LE(e.off) !== 0x04034b50) fail('Esse arquivo está corrompido.');
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) fail('Esse arquivo usa uma compressão que não dá pra ler.');
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    } catch {
      return fail('Esse arquivo está corrompido ou grande demais por dentro.');
    }
  };
  return { names: [...entries.keys()], get, text: (n) => get(n)?.toString('utf8') ?? null };
}

// ---------- texto ----------

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1'); // arquivo antigo do Windows (ANSI)
  }
}

function readText(file) {
  if (fs.statSync(file).size > MAX_TEXT) fail('Arquivo de texto grande demais pra converter (máximo 20 MB).');
  return decodeText(fs.readFileSync(file)).replace(/\r\n?/g, '\n');
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Documento em blocos: { type: 'h'|'p'|'li'|'code'|'quote'|'hr', level?, text }
function blocksToText(blocks) {
  return blocks.map((b) => (b.type === 'li' ? `• ${b.text}` : b.type === 'hr' ? '' : b.text)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function blocksToMd(blocks) {
  return blocks.map((b) => {
    if (b.type === 'h') return `${'#'.repeat(Math.min(b.level || 1, 6))} ${b.text}`;
    if (b.type === 'li') return `- ${b.text}`;
    if (b.type === 'code') return `\`\`\`\n${b.text}\n\`\`\``;
    if (b.type === 'quote') return b.text.split('\n').map((l) => `> ${l}`).join('\n');
    if (b.type === 'hr') return '---';
    return b.text;
  }).join('\n\n').replace(/^- (.*)\n\n(?=- )/gm, '- $1\n') + '\n';
}

function inlineMd(s) {
  return escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    // Links só http(s)/mailto: nada de javascript: no HTML gerado.
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function blocksToHtml(blocks, title, { md = false } = {}) {
  const inl = md ? inlineMd : escHtml;
  let body = '';
  let inList = false;
  for (const b of blocks) {
    if (b.type !== 'li' && inList) { body += '</ul>\n'; inList = false; }
    if (b.type === 'li') {
      if (!inList) { body += '<ul>\n'; inList = true; }
      body += `<li>${inl(b.text)}</li>\n`;
    } else if (b.type === 'h') body += `<h${Math.min(b.level || 1, 6)}>${inl(b.text)}</h${Math.min(b.level || 1, 6)}>\n`;
    else if (b.type === 'code') body += `<pre><code>${escHtml(b.text)}</code></pre>\n`;
    else if (b.type === 'quote') body += `<blockquote>${inl(b.text).replace(/\n/g, '<br>')}</blockquote>\n`;
    else if (b.type === 'hr') body += '<hr>\n';
    else body += `<p>${inl(b.text).replace(/\n/g, '<br>')}</p>\n`;
  }
  if (inList) body += '</ul>\n';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; color: #2b2f36; }
  h1, h2, h3 { line-height: 1.3; } pre { background: #f2f4f7; padding: 14px; border-radius: 10px; overflow-x: auto; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: .92em; } blockquote { margin: 0; padding-left: 16px; border-left: 3px solid #d0d5dd; color: #555; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d0d5dd; padding: 6px 10px; }
</style>
</head>
<body>
${body}</body>
</html>
`;
}

function textBlocks(text) {
  return text.split(/\n{2,}/).map((t) => t.replace(/\s+$/g, '')).filter((t) => t.trim()).map((t) => ({ type: 'p', text: t }));
}

function mdBlocks(text) {
  const out = [];
  const lines = text.split('\n');
  let para = [];
  const flush = () => { if (para.length) out.push({ type: 'p', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push({ type: 'code', text: code.join('\n') });
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); out.push({ type: 'h', level: m[1].length, text: m[2].replace(/\s+#+\s*$/, '') }); }
    else if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l))) { flush(); out.push({ type: 'li', text: m[1] }); }
    else if ((m = /^>\s?(.*)$/.exec(l))) { flush(); out.push({ type: 'quote', text: m[1] }); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push({ type: 'hr', text: '' }); }
    else if (!l.trim()) flush();
    else para.push(l);
  }
  flush();
  return out;
}
const stripMd = (s) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

function htmlBlocks(html) {
  const t = html
    .replace(/<(script|style|head|template|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<(h[1-6]|p|li|pre|blockquote|div|tr|br)\b[^>]*>([\s\S]*?)(?=<\/?(?:h[1-6]|p|li|pre|blockquote|div|tr|ul|ol|table|body)\b|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const tag = m[1].toLowerCase();
    const text = decodeEntities(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (!text) continue;
    out.push(tag[0] === 'h' && tag !== 'hr' ? { type: 'h', level: Number(tag[1]) || 1, text } : tag === 'li' ? { type: 'li', text } : tag === 'pre' ? { type: 'code', text } : { type: 'p', text });
  }
  if (!out.length) {
    const plain = decodeEntities(t.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
    return textBlocks(plain);
  }
  return out;
}

// ---------- Word / ODT / PowerPoint / Excel ----------

function xmlText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ''));
}

function docxBlocks(zip) {
  const xml = zip.text('word/document.xml');
  if (xml == null) fail('Esse Word está corrompido.');
  const out = [];
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const p = m[1];
    const style = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || '';
    const text = [...p.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br[^>]*\/>/g, '<w:t>\n</w:t>').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
      .map((x) => decodeEntities(x[1])).join('');
    if (!text.trim()) continue;
    const h = /^(?:Heading|Ttulo|Titulo|Título)(\d)$/i.exec(style) || (/^Title$/i.test(style) ? [0, '1'] : null);
    if (h) out.push({ type: 'h', level: Number(h[1]), text: text.trim() });
    else if (/<w:numPr[\s>/]/.test(p) || /List/i.test(style)) out.push({ type: 'li', text: text.trim() });
    else out.push({ type: 'p', text });
  }
  return out;
}

function odtBlocks(zip) {
  const xml = zip.text('content.xml');
  if (xml == null) fail('Esse documento está corrompido.');
  const out = [];
  const prep = xml.replace(/<text:s(?:\s+text:c="(\d+)")?\/>/g, (_m, n) => ' '.repeat(Number(n) || 1))
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n');
  for (const m of prep.matchAll(/<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1>/g)) {
    const text = xmlText(m[3]);
    if (!text.trim()) continue;
    const level = Number((/text:outline-level="(\d)"/.exec(m[2]) || [])[1] || 1);
    out.push(m[1] === 'h' ? { type: 'h', level, text: text.trim() } : { type: 'p', text });
  }
  return out;
}

function pptxBlocks(zip) {
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!slides.length) fail('Essa apresentação não tem slides.');
  const out = [];
  slides.forEach((s, i) => {
    out.push({ type: 'h', level: 2, text: `Slide ${i + 1}` });
    for (const m of zip.text(s).matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const text = [...m[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => decodeEntities(x[1])).join('');
      if (text.trim()) out.push({ type: 'p', text });
    }
  });
  return out;
}

function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '')?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxRows(zip) {
  const shared = [];
  const ss = zip.text('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => decodeEntities(x[1])).join(''));
  const sheet = zip.names.includes('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml'
    : zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheet) fail('Essa planilha não tem abas.');
  const rows = [];
  for (const r of zip.text(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) break;
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
      const inner = c[2] || '';
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => decodeEntities(x[1])).join('');
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v != null ? decodeEntities(v) : '';
      const idx = ref ? colIndex(ref) : row.length;
      if (idx < 0 || idx > 16_384) continue;
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    rows.push(row);
  }
  while (rows.length && rows.at(-1).every((x) => x === '')) rows.pop();
  return rows;
}

// ---------- dados ----------

function detectSep(text, fallback) {
  const first = text.split('\n', 1)[0];
  const count = (ch) => first.split(ch).length - 1;
  const cands = [[',', count(',')], [';', count(';')], ['\t', count('\t')], ['|', count('|')]].sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : fallback;
}

function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field);
      rows.push(row);
      if (rows.length > MAX_ROWS) fail('Planilha com linhas demais.');
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toDelimited(rows, sep) {
  const cell = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h, i) => String(h || '').trim() || `coluna${i + 1}`);
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, typeof r[i] === 'string' ? autoType(r[i]) : r[i] ?? ''])));
}
function autoType(s) {
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'TRUE') return true;
  if (s === 'false' || s === 'FALSE') return false;
  return s;
}

function jsonToRows(data) {
  if (Array.isArray(data)) {
    if (data.every((x) => Array.isArray(x))) return data;
    if (data.every((x) => x && typeof x === 'object')) {
      const keys = [...new Set(data.flatMap((x) => Object.keys(x)))];
      return [keys, ...data.map((x) => keys.map((k) => x[k]))];
    }
    return [['valor'], ...data.map((x) => [x])];
  }
  if (data && typeof data === 'object') {
    // { "lista": [ {...}, ... ] } -> a lista vira a tabela
    const arr = Object.values(data).find((v) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object'));
    if (arr && Object.keys(data).length === 1) return jsonToRows(arr);
    return [['chave', 'valor'], ...Object.entries(data)];
  }
  return [['valor'], [data]];
}

function yScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const plain = /^[A-Za-zÀ-ÿ_][\w À-ÿ./()-]*$/.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s);
  return plain ? s : JSON.stringify(s);
}
const isBlock = (v) => v && typeof v === 'object' && Object.keys(v).length > 0;
const yInline = (v) => (Array.isArray(v) ? '[]' : v && typeof v === 'object' ? '{}' : yScalar(v));
function toYaml(v, ind = 0) {
  const pad = ' '.repeat(ind);
  if (!isBlock(v)) return `${pad}${yInline(v)}`;
  if (Array.isArray(v)) return v.map((x) => (isBlock(x) ? `${pad}-\n${toYaml(x, ind + 2)}` : `${pad}- ${yInline(x)}`)).join('\n');
  return Object.entries(v).map(([k, x]) => (isBlock(x) ? `${pad}${yScalar(k)}:\n${toYaml(x, ind + 2)}` : `${pad}${yScalar(k)}: ${yInline(x)}`)).join('\n');
}

function readData(from, file) {
  const text = readText(file);
  if (from === 'json') {
    try {
      return { data: JSON.parse(text) };
    } catch {
      return fail('Esse JSON tem erro de sintaxe.');
    }
  }
  const rows = parseDelimited(text, detectSep(text, from === 'tsv' ? '\t' : ','));
  return { rows };
}

// ---------- legendas ----------

function parseSubs(text) {
  const cues = [];
  for (const block of text.replace(/^﻿?WEBVTT[^\n]*\n/, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
    if (!m) continue;
    cues.push({ start: subTime(m[1]), end: subTime(m[2]), text: lines.slice(i + 1).join('\n') });
  }
  if (!cues.length) fail('Não achei nenhuma fala nessa legenda.');
  return cues;
}
function subTime(s) {
  const parts = s.replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}
function fmtSubTime(t, sep) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

// ---------- PDF (texto) ----------

// WinAnsi (Windows-1252): cobre português e o resto do latim; o que não couber vira "?".
const WIN = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
function winAnsi(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9) out.push(32, 32, 32, 32);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (WIN[ch]) out.push(WIN[ch]);
    else if (c >= 32) out.push(63);
  }
  return Buffer.from(out);
}
function pdfString(buf) {
  let s = '';
  for (const b of buf) s += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
  return `(${s})`;
}
// Largura aproximada na Helvetica (em milésimos do tamanho da fonte), pra quebrar linha sem estourar.
function charW(ch) {
  if ('il.,:;\'|!`'.includes(ch)) return 280;
  if ('fjrtI()[]{} '.includes(ch)) return 330;
  if ('mwMW'.includes(ch)) return 860;
  if (ch >= 'A' && ch <= 'Z') return 690;
  return 560;
}
function wrap(text, maxW, size) {
  const lines = [];
  for (const raw of text.split('\n')) {
    let line = '';
    let w = 0;
    for (const word of raw.split(/(\s+)/)) {
      const ww = [...word].reduce((a, ch) => a + charW(ch), 0) * size / 1000;
      if (w + ww > maxW && line.trim()) {
        lines.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
        w = [...line].reduce((a, ch) => a + charW(ch), 0) * size / 1000;
        // Palavra maior que a linha inteira: corta.
        while (w > maxW) {
          const cut = Math.max(1, Math.floor(line.length * maxW / w));
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
          w = [...line].reduce((a, ch) => a + charW(ch), 0) * size / 1000;
        }
      } else {
        line += word;
        w += ww;
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

function blocksToPdf(blocks) {
  const W = 595;
  const H = 842;
  const M = 56;
  const pages = [];
  let ops = [];
  let y = H - M;
  const newPage = () => { if (ops.length) pages.push(ops.join('\n')); ops = []; y = H - M; };
  const emit = (text, { size = 11, bold = false, gap = 6, indent = 0, mono = false } = {}) => {
    const lead = size * 1.42;
    const font = mono ? 'F3' : bold ? 'F2' : 'F1';
    for (const l of wrap(text, W - 2 * M - indent, mono ? size * 1.07 : size)) {
      if (y - lead < M) newPage();
      y -= lead;
      if (l) ops.push(`BT /${font} ${size} Tf ${M + indent} ${y.toFixed(2)} Td ${pdfString(winAnsi(l))} Tj ET`);
    }
    y -= gap;
  };
  for (const b of blocks) {
    if (b.type === 'h') emit(b.text, { size: [0, 20, 16, 14, 12.5, 12, 11][Math.min(b.level || 1, 6)], bold: true, gap: 8 });
    else if (b.type === 'li') emit(`•  ${b.text}`, { indent: 12, gap: 3 });
    else if (b.type === 'code') emit(b.text, { size: 9.5, mono: true });
    else if (b.type === 'hr') y -= 12;
    else emit(b.text);
  }
  newPage();
  if (!pages.length) pages.push('');

  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const content of pages) {
    const data = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const stream = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let off = parts[0].length;
  const xref = [];
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n')]);
    xref.push(off);
    off += b.length;
    parts.push(b);
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${xref.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${off}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// ---------- compactar ----------

async function toBase64(input, out) {
  let rest = Buffer.alloc(0);
  const enc = new Transform({
    transform(chunk, _e, cb) {
      const buf = Buffer.concat([rest, chunk]);
      const n = buf.length - (buf.length % 3);
      rest = buf.subarray(n);
      cb(null, buf.subarray(0, n).toString('base64'));
    },
    flush(cb) { cb(null, rest.toString('base64')); },
  });
  await pipeline(fs.createReadStream(input), enc, fs.createWriteStream(out, { mode: 0o600 }));
}

async function gunzip(input, out) {
  let total = 0;
  const cap = new Transform({
    transform(c, _e, cb) {
      total += c.length;
      if (total > MAX_GUNZIP) return cb(new UserError('Descompactado fica grande demais (mais de 2 GB).'));
      return cb(null, c);
    },
  });
  try {
    await pipeline(fs.createReadStream(input), zlib.createGunzip(), cap, fs.createWriteStream(out, { mode: 0o600 }));
  } catch (e) {
    if (e instanceof UserError) throw e;
    fail('Esse .gz está corrompido.');
  }
}

const STORED = /\.(png|jpe?g|webp|avif|gif|mp4|mkv|webm|mp3|m4a|ogg|opus|zip|gz|7z|rar|docx|xlsx|pptx|heic)$/i;

async function zipDir(dir, out) {
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile()).sort();
  if (!files.length) fail('Nada pra compactar.');
  const z = new ZipWriter(out);
  for (const f of files) await z.addFile(f, path.join(dir, f), { store: STORED.test(f) });
  await z.close();
}

// ---------- conversão ----------

async function convert(from, to, input, out, name = 'arquivo') {
  const base = path.basename(name).replace(/\.[^.]+$/, '') || 'arquivo';
  const write = (data) => fs.writeFileSync(out, data, { mode: 0o600 });

  if (to === 'zip') {
    const z = new ZipWriter(out);
    await z.addFile(path.basename(name) || 'arquivo', input, { store: STORED.test(name) });
    return z.close();
  }
  if (to === 'gz') return pipeline(fs.createReadStream(input), zlib.createGzip({ level: 6 }), fs.createWriteStream(out, { mode: 0o600 }));
  if (to === 'b64') return toBase64(input, out);
  if (from === 'gz' && to === 'unpack') return gunzip(input, out);

  // Documentos de escritório: tudo vira blocos de texto.
  let blocks = null;
  let rows = null;
  let data;
  let md = false;
  if (['docx', 'odt', 'pptx', 'xlsx'].includes(from)) {
    if (fs.statSync(input).size > MAX_DOC) fail('Documento grande demais pra converter (máximo 60 MB).');
    const zip = readZip(fs.readFileSync(input));
    if (from === 'xlsx') rows = xlsxRows(zip);
    else blocks = from === 'docx' ? docxBlocks(zip) : from === 'odt' ? odtBlocks(zip) : pptxBlocks(zip);
  } else if (['json', 'csv', 'tsv'].includes(from)) {
    ({ rows, data } = readData(from, input));
  } else if (['srt', 'vtt'].includes(from)) {
    const cues = parseSubs(readText(input));
    if (to === 'srt') return write(cues.map((c, i) => `${i + 1}\n${fmtSubTime(c.start, ',')} --> ${fmtSubTime(c.end, ',')}\n${c.text}\n`).join('\n'));
    if (to === 'vtt') return write(`WEBVTT\n\n${cues.map((c) => `${fmtSubTime(c.start, '.')} --> ${fmtSubTime(c.end, '.')}\n${c.text}\n`).join('\n')}`);
    if (to === 'txt') {
      const lines = cues.map((c) => c.text.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim()).filter(Boolean);
      return write(`${lines.filter((l, i) => l !== lines[i - 1]).join('\n')}\n`);
    }
  } else if (from === 'md') {
    md = true;
    blocks = mdBlocks(readText(input));
  } else if (from === 'html') {
    blocks = htmlBlocks(readText(input));
  } else if (from === 'txt') {
    blocks = textBlocks(readText(input));
  }

  // Tabelas
  if (rows || data !== undefined) {
    if (to === 'json') return write(`${JSON.stringify(data !== undefined ? data : rowsToObjects(rows), null, 2)}\n`);
    if (to === 'yaml') return write(`${toYaml(data !== undefined ? data : rowsToObjects(rows))}\n`);
    const table = rows || jsonToRows(data);
    if (to === 'csv') return write(`﻿${toDelimited(table, ',')}`);
    if (to === 'tsv') return write(toDelimited(table, '\t'));
    if (to === 'txt' || to === 'pdf' || to === 'html') blocks = [{ type: 'code', text: toDelimited(table, '\t') }];
  }

  if (blocks) {
    if (!blocks.length) fail('Não achei texto nenhum nesse arquivo.');
    if (to === 'txt') return write(blocksToText(md ? blocks.map((b) => ({ ...b, text: stripMd(b.text) })) : blocks));
    if (to === 'md') return write(blocksToMd(blocks));
    if (to === 'html') return write(blocksToHtml(blocks, base, { md }));
    if (to === 'pdf') return write(blocksToPdf(md ? blocks.map((b) => ({ ...b, text: stripMd(b.text) })) : blocks));
  }
  return fail('Essa conversão não existe.');
}

async function main(argv) {
  try {
    if (argv[0] === 'zipdir') await zipDir(argv[1], argv[2]);
    else await convert(argv[0], argv[1], argv[2], argv[3], argv[4]);
  } catch (e) {
    process.stderr.write(`ERRO: ${e instanceof UserError ? e.message : 'Não consegui converter esse arquivo.'}\n`);
    if (!(e instanceof UserError)) process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  convert, zipNames, readZip, ZipWriter, zipDir, parseDelimited, toDelimited, jsonToRows, toYaml, parseSubs, blocksToPdf, mdBlocks, htmlBlocks, decodeText, crc32,
};

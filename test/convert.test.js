'use strict';

// Conversor de arquivos (partes em Node puro) e as proteções novas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('../lib/fileconv');
const convert = require('../lib/convert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-conv-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const tmp = (name, data) => {
  const f = path.join(TMP, name);
  if (data !== undefined) fs.writeFileSync(f, data);
  return f;
};

test('CSV com aspas, ; e acentos vira JSON com números', async () => {
  const inp = tmp('a.csv', 'nome;idade\nAna;30\n"Bê; Jr";41\n');
  await fc.convert('csv', 'json', inp, tmp('a.json'), 'a.csv');
  assert.deepEqual(JSON.parse(fs.readFileSync(tmp('a.json'), 'utf8')), [{ nome: 'Ana', idade: 30 }, { nome: 'Bê; Jr', idade: 41 }]);
});

test('JSON (lista de objetos) vira CSV com todas as colunas', async () => {
  await fc.convert('json', 'csv', tmp('b.json', '{"itens":[{"a":1,"b":"x,y"},{"a":2,"c":true}]}'), tmp('b.csv'), 'b.json');
  assert.equal(fs.readFileSync(tmp('b.csv'), 'utf8'), '﻿a,b,c\r\n1,"x,y",\r\n2,,true\r\n');
});

test('JSON vira YAML legível', async () => {
  await fc.convert('json', 'yaml', tmp('c.json', '{"nome":"Ana","tags":["x","true"],"sub":{"num":1}}'), tmp('c.yaml'), 'c.json');
  assert.equal(fs.readFileSync(tmp('c.yaml'), 'utf8'), 'nome: Ana\ntags:\n  - x\n  - "true"\nsub:\n  num: 1\n');
});

test('SRT <-> VTT mantém os tempos', async () => {
  await fc.convert('srt', 'vtt', tmp('s.srt', '1\n00:00:01,000 --> 00:00:02,500\nOlá\n\n2\n00:01:03,040 --> 00:01:04,000\nTchau\n'), tmp('s.vtt'), 's.srt');
  const vtt = fs.readFileSync(tmp('s.vtt'), 'utf8');
  assert.match(vtt, /^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.500\nOlá\n/);
  await fc.convert('vtt', 'srt', tmp('s.vtt'), tmp('s2.srt'), 's.vtt');
  assert.match(fs.readFileSync(tmp('s2.srt'), 'utf8'), /2\n00:01:03,040 --> 00:01:04,000\nTchau/);
});

test('Markdown vira HTML sem deixar passar javascript: nem HTML cru', async () => {
  await fc.convert('md', 'html', tmp('m.md', '# Oi\n\n<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b) **forte**\n\n- um\n- dois\n'), tmp('m.html'), 'm.md');
  const html = fs.readFileSync(tmp('m.html'), 'utf8');
  assert.match(html, /<h1>Oi<\/h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/a\.b">ok<\/a>/);
  assert.match(html, /<ul>\n<li>um<\/li>\n<li>dois<\/li>\n<\/ul>/);
});

test('texto vira PDF válido (com acentos)', async () => {
  await fc.convert('txt', 'pdf', tmp('t.txt', 'Olá, ação e €.\n\n'.repeat(200)), tmp('t.pdf'), 't.txt');
  const pdf = fs.readFileSync(tmp('t.pdf'));
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.subarray(-6).toString(), /%%EOF/);
  assert.match(pdf.toString('latin1'), /\/Count [2-9]/); // várias páginas
});

test('ZIP gerado abre (ida e volta) e o .gz descompacta', async () => {
  const data = Buffer.from('conteúdo '.repeat(1000));
  await fc.convert('txt', 'zip', tmp('z.txt', data), tmp('z.zip'), 'meu arquivo.txt');
  const z = fc.readZip(fs.readFileSync(tmp('z.zip')));
  assert.deepEqual(z.names, ['meu arquivo.txt']);
  assert.deepEqual(z.get('meu arquivo.txt'), data);
  await fc.convert('txt', 'gz', tmp('z.txt'), tmp('z.txt.gz'), 'z.txt');
  await fc.convert('gz', 'unpack', tmp('z.txt.gz'), tmp('z2.txt'), 'z.txt.gz');
  assert.deepEqual(fs.readFileSync(tmp('z2.txt')), data);
  await fc.convert('txt', 'b64', tmp('z.txt'), tmp('z.b64'), 'z.txt');
  assert.deepEqual(Buffer.from(fs.readFileSync(tmp('z.b64'), 'utf8'), 'base64'), data);
});

test('Word (.docx) vira texto e Markdown com títulos e listas', async () => {
  // .docx mínimo montado com o próprio ZipWriter.
  const dir = path.join(TMP, 'docx', 'word');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'document.xml'), '<w:document><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Relatório</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Texto &amp; mais</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item</w:t></w:r></w:p></w:body></w:document>');
  const z = new fc.ZipWriter(tmp('d.docx'));
  await z.addFile('word/document.xml', path.join(dir, 'document.xml'));
  await z.close();
  assert.deepEqual(fc.zipNames(tmp('d.docx')), ['word/document.xml']);
  await fc.convert('docx', 'md', tmp('d.docx'), tmp('d.md'), 'd.docx');
  assert.equal(fs.readFileSync(tmp('d.md'), 'utf8'), '# Relatório\n\nTexto & mais\n\n- item\n');
});

test('bomba de zip dentro do .docx é recusada', async () => {
  const big = path.join(TMP, 'big.xml');
  fs.writeFileSync(big, Buffer.alloc(80 * 1024 * 1024, 32));
  const z = new fc.ZipWriter(tmp('bomb.docx'));
  await z.addFile('word/document.xml', big);
  await z.close();
  await assert.rejects(fc.convert('docx', 'txt', tmp('bomb.docx'), tmp('bomb.txt'), 'bomb.docx'), /grande demais por dentro/);
});

test('tipo vem dos bytes, não do nome: playlist e MVG disfarçados viram texto', async () => {
  const hls = await convert.detect(tmp('v.mp4', '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n'), 'video.mp4');
  assert.equal(hls.kind, 'text');
  const mvg = await convert.detect(tmp('f.png', 'push graphic-context\nimage over 0,0 0,0 "text:/etc/passwd"\n'), 'foto.png');
  assert.equal(mvg.kind, 'text');
  assert.ok(!convert.targets(mvg).some((t) => ['png', 'jpg'].includes(t.to)));
  const png = await convert.detect(tmp('x.dat', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), 'x.dat');
  assert.deepEqual([png.kind, png.ext], ['image', 'png']);
  const svg = await convert.detect(tmp('i.svg', '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'i.svg');
  assert.deepEqual([svg.kind, svg.ext], ['image', 'svg']);
  assert.deepEqual(convert.targets(svg).map((t) => t.to), ['zip', 'gz', 'b64']); // SVG só vira imagem no navegador
});

test('erro amigável vem da linha ERRO:, e o genérico não vaza detalhe', () => {
  assert.equal(convert.friendly('lixo\nERRO: Esse JSON tem erro de sintaxe.\nstack'), 'Esse JSON tem erro de sintaxe.');
  assert.equal(convert.friendly('/home/x/segredo: Segmentation fault'), 'Não consegui converter esse arquivo.');
});

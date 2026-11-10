'use strict';

// Funções de proteção do server.js (carregado sem subir a porta, com dados numa pasta temporária).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-sec-'));
process.env.DATA_DIR = TMP;
process.env.YTDLP_PROXY = '';
const { jobArgs, normalizeUrl, cleanFileName } = require('../server.js');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('link no meio de texto compartilhado, com caracteres invisíveis ou sem https://', () => {
  const x = 'https://x.com/EdZone350/status/2118792332837335364?a=w6SpB5iI2ZRAkqtuCDk&s=20';
  assert.equal(normalizeUrl(`Olha esse post ${x} via app`), x);
  assert.equal(normalizeUrl(`\u2066${x}\u2069`), x);
  assert.equal(normalizeUrl(`${x}.`), x);
  assert.equal(normalizeUrl('x.com/fulano/status/1'), 'https://x.com/fulano/status/1');
});

test('links perigosos ou de fora da lista são recusados', () => {
  for (const bad of ['javascript:alert(1)', 'https://user:senha@x.com/a', 'https://x.com:8080/a', 'https://evil.com/x.com', 'https://x.com.evil.com/a', 'file:///etc/passwd']) {
    assert.equal(normalizeUrl(bad), null, bad);
  }
});

test('% no título não vira campo do yt-dlp (vazaria cabeçalhos/cookies no nome do arquivo)', () => {
  const args = jobArgs({ mode: 'search', url: 'https://music.youtube.com/search?q=a', kind: 'mp3', quality: '320', title: 'a %(http_headers)s b', dir: '/tmp/x', opts: {} });
  assert.equal(args[args.indexOf('-o') + 1], 'a %%(http_headers)s b.%(ext)s');
});

test('nome de arquivo enviado: sem pasta, sem caractere de controle, sem %', () => {
  assert.equal(cleanFileName(encodeURIComponent('../../etc/passwd')), 'passwd');
  assert.equal(cleanFileName('..%2F..%2Fsegredo%25(x)s.txt'), 'segredo_(x)s.txt');
  assert.equal(cleanFileName('C:\\Users\\a\\foto.png'), 'foto.png');
  assert.equal(cleanFileName('.bashrc'), 'bashrc');
  assert.equal(cleanFileName(''), 'arquivo');
  assert.ok(cleanFileName('a'.repeat(500)).length <= 120);
});

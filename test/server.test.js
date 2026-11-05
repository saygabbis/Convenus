'use strict';

// Integração: sobe o server.js de verdade numa porta à parte, com pasta própria e um yt-dlp falso.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-ytdlp.js');
fs.chmodSync(FAKE, 0o755);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-int-'));
const SLOW = path.join(DATA, 'slow');
const PORT = 5300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const URL_OK = 'https://soundcloud.com/tester/fake';
let srv = null;
let cookie = '';

function start(extraEnv = {}) {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, YTDLP: FAKE, YTDLP_PROXY: '', POT_URL: '', FAKE_SLOW_FILE: SLOW, MIN_FREE_GB: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.output = '';
  srv.stdout.on('data', (d) => { srv.output += d; });
  srv.stderr.on('data', (d) => { srv.output += d; });
  return waitUp();
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`servidor não subiu:\n${srv.output}`);
}

function stop(signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!srv || srv.exitCode !== null) return resolve();
    srv.once('exit', resolve);
    srv.kill(signal);
  });
}

const req = (p, opts = {}) => fetch(`${BASE}${p}`, { redirect: 'manual', ...opts, headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) } });
const post = (p, body, headers) => req(p, { method: 'POST', body: JSON.stringify(body), headers });

async function waitJob(id, want = ['done', 'error']) {
  for (let i = 0; i < 100; i++) {
    const j = await (await req(`/api/jobs/${id}`)).json();
    if (want.includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} não terminou`);
}

test.after(async () => {
  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('sem login: página manda pra /entrar, API responde 401, /health público é mínimo', async () => {
  await start();
  const home = await req('/');
  assert.equal(home.status, 302);
  assert.match(home.headers.get('location'), /^\/entrar\?next=/);
  assert.equal((await req('/api/status')).status, 401);
  assert.equal((await post('/api/info', { url: URL_OK })).status, 401);
  assert.equal((await req('/api/jobs/0123456789abcdef/file')).status, 401);
  assert.equal((await post('/api/cookies', { content: 'x' })).status, 401);
  assert.equal((await req('/api/media?u=https://i.ytimg.com/vi/x/hqdefault.jpg')).status, 401);
  const pub = await (await req('/health', { headers: { 'x-real-ip': '8.8.8.8' } })).json();
  assert.deepEqual(Object.keys(pub), ['ok'], 'sem detalhes pra quem vem de fora');
  assert.equal((await req('/entrar')).status, 200);
  assert.equal((await req('/icon.svg')).status, 200);
});

test('login: código errado recusa, certo entra; Origin de outro site é barrado', async () => {
  assert.equal((await post('/api/login', { token: 'errado' })).status, 403);
  const token = fs.readFileSync(path.join(DATA, 'admin.token'), 'utf8').trim();
  const r = await post('/api/login', { token });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  cookie = set.split(';')[0];
  assert.equal((await req('/')).status, 200);
  assert.equal((await post('/api/info', { url: URL_OK }, { origin: 'https://site-malicioso.example' })).status, 403);
});

test('status detalhado só com login, e o /health detalhado só pra localhost', async () => {
  const s = await (await req('/api/status')).json();
  assert.equal(s.ytdlp.ok, true);
  assert.equal(s.ytdlp.version, '2099.01.01');
  assert.ok('ffmpeg' in s && 'warp' in s && 'pot' in s && 'disk' in s);
  assert.equal(typeof s.queue.running, 'number');
  const local = await (await fetch(`${BASE}/health`)).json();
  assert.ok(local.queue, 'localhost recebe o detalhe (script de update)');
});

test('busca mostra legendas (sem live_chat e sem tradução automática)', async () => {
  const info = await (await post('/api/info', { url: URL_OK })).json();
  assert.equal(info.items[0].kind, 'video');
  assert.deepEqual(info.items[0].subs.map((x) => x.lang), ['pt', 'en-orig']);
});

let doneId = '';
test('MP4 com legenda embutida: termina e o arquivo baixa', async () => {
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'mp4', quality: 720, title: 'Fake video', subs: { lang: 'pt', embed: true } });
  assert.equal(r.status, 201);
  const j = await waitJob((await r.json()).id);
  assert.equal(j.status, 'done', j.error);
  const f = await req(`/api/jobs/${j.id}/file`);
  assert.equal(f.status, 200);
  assert.match(await f.text(), /com-legenda/);
  doneId = j.id;
});

test('só a legenda (.srt); idioma inexistente é recusado', async () => {
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'srt', title: 'Fake video', subs: { lang: 'pt' } });
  const j = await waitJob((await r.json()).id);
  assert.equal(j.status, 'done', j.error);
  assert.match(j.filename, /\.srt$/);
  assert.equal((await post('/api/jobs', { url: URL_OK, item: 0, kind: 'srt', subs: { lang: 'xx' } })).status, 400);
});

test('reinício: arquivo pronto continua lá e baixável (nada de apagar downloads no start)', async () => {
  await stop();
  await start();
  const j = await (await req(`/api/jobs/${doneId}`)).json();
  assert.equal(j.status, 'done');
  assert.equal((await req(`/api/jobs/${doneId}/file`)).status, 200);
  const hist = await (await req('/api/jobs')).json();
  assert.ok(hist.jobs.some((x) => x.id === doneId), 'histórico vem do banco');
});

test('reinício no meio de uma tarefa: volta pra fila e termina depois', async () => {
  fs.writeFileSync(SLOW, '1');
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'mp4', quality: 720, title: 'Longo' });
  const { id } = await r.json();
  await waitJob(id, ['running']);
  await new Promise((r2) => setTimeout(r2, 300));
  await stop('SIGTERM'); // encerramento gracioso
  fs.rmSync(SLOW);
  await start();
  assert.match(srv.output, /1 tarefa\(s\) retomada/);
  const j = await waitJob(id);
  assert.equal(j.status, 'done', j.error);
});

test('cancelar uma tarefa em andamento libera a vaga', async () => {
  fs.writeFileSync(SLOW, '1');
  const { id } = await (await post('/api/jobs', { url: URL_OK, item: 0, kind: 'mp4', quality: 720, title: 'Cancela' })).json();
  await waitJob(id, ['running']);
  await req(`/api/jobs/${id}`, { method: 'DELETE' });
  const j = await waitJob(id, ['canceled']);
  assert.equal(j.status, 'canceled');
  fs.rmSync(SLOW);
  const s = await (await req('/api/status')).json();
  assert.equal(s.queue.running, 0);
});

test('corpo grande demais é recusado na hora (não fica pendurado)', async () => {
  const big = 'x'.repeat(50_000);
  const t0 = Date.now();
  const r = await post('/api/info', { url: big });
  assert.equal(r.status, 400);
  assert.ok(Date.now() - t0 < 3000);
});

test('yt-dlp ausente: erro amigável e o servidor continua de pé', async () => {
  await stop();
  await start({ YTDLP: '/caminho/que/nao/existe/yt-dlp' });
  const r = await post('/api/info', { url: URL_OK });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /yt-dlp não está instalado/);
  assert.equal((await fetch(`${BASE}/health`)).ok, true);
});

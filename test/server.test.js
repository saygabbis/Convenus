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
const ARGS_LOG = path.join(DATA, 'args.log');
const FAIL_LOADED = path.join(DATA, 'fail-loaded');
const calls = () => fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const PORT = 5300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const URL_OK = 'https://soundcloud.com/tester/fake';
let srv = null;
let cookie = '';

function start(extraEnv = {}) {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, YTDLP: FAKE, YTDLP_PROXY: '', POT_URL: '', FAKE_SLOW_FILE: SLOW, FAKE_ARGS_LOG: ARGS_LOG, FAKE_FAIL_LOADED: FAIL_LOADED, MIN_FREE_GB: '0', ...extraEnv },
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

let device = '';
test('site aberto sem código: página já sai com id do aparelho; só a administração pede o código', async () => {
  await start();
  const home = await req('/');
  assert.equal(home.status, 200);
  const set = home.headers.get('set-cookie') || '';
  assert.match(set, /^cv_dev=[\w-]{22,}/);
  assert.match(set, /HttpOnly/);
  device = set.split(';')[0];
  cookie = device;
  assert.equal((await req('/')).headers.get('set-cookie'), null, 'aparelho conhecido não ganha id novo');
  const st = await (await req('/api/status')).json();
  assert.deepEqual(Object.keys(st).sort(), ['admin', 'ok', 'youtube'], 'sem detalhes da VPS pra quem não é admin');
  assert.equal(st.admin, false);
  assert.equal((await post('/api/info', { url: URL_OK })).status, 200);
  assert.equal((await post('/api/cookies', { content: 'x' })).status, 401);
  const renew = await req('/renovar');
  assert.equal(renew.status, 302);
  assert.match(renew.headers.get('location'), /^\/entrar\?next=/);
  const pub = await (await req('/health', { headers: { 'x-real-ip': '8.8.8.8' } })).json();
  assert.deepEqual(Object.keys(pub), ['ok'], 'sem detalhes pra quem vem de fora');
  assert.equal((await req('/entrar')).status, 200);
  assert.equal((await req('/icon.svg')).status, 200);
});

test('login de admin: código errado recusa, certo entra; Origin de outro site é barrado', async () => {
  assert.equal((await post('/api/login', { token: 'errado' })).status, 403);
  const token = fs.readFileSync(path.join(DATA, 'admin.token'), 'utf8').trim();
  const r = await post('/api/login', { token });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  cookie = `${device}; ${set.split(';')[0]}`;
  assert.equal((await req('/renovar')).status, 200);
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

test('download reaproveita a busca (--load-info-json, sem cookies) e não busca de novo', async () => {
  fs.writeFileSync(ARGS_LOG, '');
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'mp3', quality: '320', title: 'Rapido' });
  const j = await waitJob((await r.json()).id);
  assert.equal(j.status, 'done', j.error);
  const log = calls();
  assert.equal(log.filter((c) => c.includes('-J')).length, 0, 'busca veio do cache, sem chamar o yt-dlp');
  const dl = log.find((c) => c.includes('--load-info-json'));
  assert.ok(dl, 'baixou a partir da busca salva');
  assert.ok(!dl.includes('--cookies') && !dl.includes(URL_OK));
  assert.deepEqual(fs.readdirSync(path.join(DATA, 'downloads', j.id)).filter((f) => f.startsWith('.busca')), [], 'json temporário apagado');
});

test('busca salva recusada (403): refaz o download do jeito completo e termina', async () => {
  fs.writeFileSync(ARGS_LOG, '');
  fs.writeFileSync(FAIL_LOADED, '1');
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'wav', title: 'Volta' });
  const j = await waitJob((await r.json()).id);
  fs.rmSync(FAIL_LOADED);
  assert.equal(j.status, 'done', j.error);
  const log = calls().filter((c) => !c.includes('-J'));
  assert.ok(log[0].includes('--load-info-json'));
  assert.ok(log.at(-1).includes(URL_OK), 'segunda tentativa com o link');
});

test('legendas: o idioma original não aparece duplicado', async () => {
  const info = await (await post('/api/info', { url: URL_OK })).json();
  const names = info.items[0].subs.map((x) => x.name);
  assert.equal(new Set(names).size, names.length);
});

test('outro aparelho não vê nem baixa as conversões deste', async () => {
  const other = { cookie: 'cv_dev=OutroAparelhoQualquer0000' };
  assert.equal((await req(`/api/jobs/${doneId}`, { headers: other })).status, 404);
  assert.equal((await req(`/api/jobs/${doneId}/file`, { headers: other })).status, 404);
  assert.equal((await req(`/api/jobs/${doneId}`, { method: 'DELETE', headers: other })).status, 404);
  assert.deepEqual((await (await req('/api/jobs', { headers: other })).json()).jobs, []);
  const mine = await (await req('/api/jobs')).json();
  assert.ok(mine.jobs.some((x) => x.id === doneId));
});

test('limpar apaga de vez a conversão terminada (arquivo e histórico)', async () => {
  const r = await post('/api/jobs', { url: URL_OK, item: 0, kind: 'srt', title: 'Some', subs: { lang: 'pt' } });
  const j = await waitJob((await r.json()).id);
  assert.equal((await req(`/api/jobs/${j.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await req(`/api/jobs/${j.id}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(DATA, 'downloads', j.id)));
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

test('conversor de arquivos: envia, converte e baixa; só o mesmo aparelho usa o envio', async () => {
  const r = await fetch(`${BASE}/api/upload`, { method: 'POST', body: 'nome,idade\nAna,30\n', headers: { cookie, origin: BASE, 'x-file-name': encodeURIComponent('pessoas.csv') } });
  assert.equal(r.status, 201);
  const up = await r.json();
  assert.equal(up.ext, 'csv');
  assert.ok(up.targets.some((t) => t.to === 'json'));
  const job = await (await post('/api/jobs', { upload: up.id, to: 'json' })).json();
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.from, 'csv');
  assert.equal(done.filename, 'pessoas.json');
  assert.deepEqual(JSON.parse(await (await req(`/api/jobs/${job.id}/file`)).text()), [{ nome: 'Ana', idade: 30 }]);
  assert.equal((await post('/api/jobs', { upload: up.id, to: 'mp4' })).status, 400);
  const other = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: JSON.stringify({ upload: up.id, to: 'json' }), headers: { 'content-type': 'application/json', cookie: 'cv_dev=outroAparelhoQualquer1234567' } });
  assert.equal(other.status, 404);
});

test('envio maior que o limite é recusado pelo tamanho, sem esperar o arquivo chegar', async () => {
  const http = require('node:http');
  const res = await new Promise((resolve, reject) => {
    const rq = http.request(`${BASE}/api/upload`, { method: 'POST', headers: { cookie, 'content-length': String(600 * 1024 * 1024) } }, resolve);
    rq.on('error', reject);
    rq.write('x');
  });
  assert.equal(res.statusCode, 413);
  res.resume();
});

test('cabeçalhos de segurança, páginas de admin só pelo caminho delas', async () => {
  const home = await req('/');
  assert.match(home.headers.get('content-security-policy'), /script-src 'sha256-[^']+'/);
  assert.doesNotMatch(home.headers.get('content-security-policy'), /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(home.headers.get('strict-transport-security'), /max-age=\d+/);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assert.match((await req('/api/status')).headers.get('content-security-policy'), /default-src 'none'/);
  for (const p of ['/renovar.html', '/entrar.html', '/%2e%2e/server.js']) assert.equal((await req(p)).status, 404, p);
  assert.equal((await req('/entrar')).status, 200);
});

test('yt-dlp ausente: erro amigável e o servidor continua de pé', async () => {
  await stop();
  await start({ YTDLP: '/caminho/que/nao/existe/yt-dlp' });
  const r = await post('/api/info', { url: URL_OK });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /yt-dlp não está instalado/);
  assert.equal((await fetch(`${BASE}/health`)).ok, true);
});

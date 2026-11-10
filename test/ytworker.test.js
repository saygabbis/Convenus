'use strict';

// yt-dlp sempre aberto: sobe, responde, devolve erro como o normal, se recupera de travar/cair
// e recicla quando o yt-dlp é atualizado. Usa um pacote yt_dlp de mentira (precisa de python3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { YtWorker } = require('../lib/ytworker');

const PKG = path.join(__dirname, 'fixtures', 'fake-ytdlp-pkg');
const quiet = { log() {}, error() {} };
const waitReady = async (w) => {
  for (let i = 0; i < 100 && !w.available(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(w.available(), 'subiu');
};

test('sempre aberto: responde vários pedidos no mesmo processo', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const a = await w.run(['-J', '--', 'https://x/1']);
  const b = await w.run(['-J', '--', 'https://x/2']);
  assert.equal(a.code, 0);
  assert.deepEqual(JSON.parse(a.stdout).argv, ['-J', '--', 'https://x/1']);
  assert.equal(JSON.parse(a.stdout).pid, JSON.parse(b.stdout).pid, 'mesmo processo');
});

test('sempre aberto: erro do yt-dlp volta com código 1 e a mensagem no stderr', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const r = await w.run(['boom']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ERROR: \[fake\] falhou/);
  assert.ok(w.available(), 'continua de pé');
});

test('sempre aberto: ocupado = indisponível (quem chama usa o normal)', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const p = w.run(['-J']);
  assert.equal(w.available(), false);
  await p;
  assert.equal(w.available(), true);
});

test('sempre aberto: travou = timeout, mata e sobe outro', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const r = await w.run(['sleep'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  await waitReady(w);
  assert.equal((await w.run(['-J'])).code, 0);
});

test('sempre aberto: caiu no meio = resposta "crashed" e sobe de novo', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const r = await w.run(['crash']);
  assert.equal(r.crashed, true);
  for (let i = 0; i < 100 && !w.available(); i++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(w.available());
});

test('sempre aberto: yt-dlp atualizado (arquivo mudou) = recicla o processo', async (t) => {
  const w = new YtWorker({ ytdlp: PKG, log: quiet });
  t.after(() => w.stop());
  w.start();
  await waitReady(w);
  const pid1 = JSON.parse((await w.run(['-J'])).stdout).pid;
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(PKG, future, future);
  assert.equal(w.available(), false, 'percebeu a atualização');
  await waitReady(w);
  const pid2 = JSON.parse((await w.run(['-J'])).stdout).pid;
  assert.notEqual(pid1, pid2);
});

test('sempre aberto: yt-dlp que não importa = fica indisponível e não insiste', async (t) => {
  const w = new YtWorker({ ytdlp: path.join(__dirname, 'nao-existe'), log: quiet });
  t.after(() => w.stop());
  w.start();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(w.available(), false);
  assert.equal(w.child, null);
});

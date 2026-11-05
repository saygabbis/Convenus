'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, killAll, active } = require('../lib/proc');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('programa que não existe: resolve com erro, não derruba o processo', async () => {
  const r = await run('programa-que-nao-existe-convenus', []).done;
  assert.equal(r.code, -1);
  assert.equal(r.error.code, 'ENOENT');
});

test('timeout total encerra o processo', async () => {
  const t0 = Date.now();
  const r = await run('sleep', ['30'], { timeoutMs: 300 }).done;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('sem saída por tempo demais = travado', async () => {
  const r = await run('bash', ['-c', 'echo oi; sleep 30'], { idleMs: 400 }).done;
  assert.equal(r.idle, true);
  assert.match(r.stdout, /oi/);
});

test('mata o grupo inteiro, inclusive os filhos (ffmpeg aberto pelo yt-dlp)', async () => {
  let childPid = 0;
  const h = run('bash', ['-c', 'sleep 30 & echo $!; wait'], { onStdout: (d) => { childPid = Number(String(d).trim()); } });
  while (!childPid) await new Promise((r) => setTimeout(r, 20));
  assert.ok(alive(childPid));
  h.stop();
  await h.done;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(childPid), false);
});

test('saída limitada: não guarda mais que maxStdout', async () => {
  const r = await run('bash', ['-c', 'yes'], { maxStdout: 1000, killOnOverflow: true, timeoutMs: 5000 }).done;
  assert.equal(r.overflow, true);
  assert.ok(r.stdout.length < 70_000);
});

test('stderr guarda só o fim', async () => {
  const r = await run('bash', ['-c', 'for i in $(seq 1 3000); do echo linha$i >&2; done'], { keepStderr: 100 }).done;
  assert.ok(r.stderr.length <= 100);
  assert.match(r.stderr, /linha3000/);
});

test('done resolve uma vez só e o processo sai da lista de ativos', async () => {
  const h = run('true', []);
  const a = await h.done;
  const b = await h.done;
  assert.equal(a, b);
  assert.equal(active.has(h.child), false);
});

test('killAll encerra tudo que está rodando', async () => {
  const hs = [run('sleep', ['30']), run('sleep', ['30'])];
  await new Promise((r) => setTimeout(r, 100));
  await killAll(2000);
  const rs = await Promise.all(hs.map((h) => h.done));
  for (const r of rs) assert.ok(r.signal || r.code !== 0);
});

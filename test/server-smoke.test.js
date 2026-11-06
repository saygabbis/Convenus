'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

describe('server smoke', () => {
  let tmp;
  let child;
  let base;
  const bootstrap = 'smoke-admin-token-xyz';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-smoke-'));
    fs.writeFileSync(path.join(tmp, 'admin.token'), `${bootstrap}\n`, { mode: 0o600 });
    // Copia mínima: server + libs + public + providers
    for (const f of ['server.js', 'providers.js']) {
      fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });

    const port = 18000 + Math.floor(Math.random() * 1000);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: tmp,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        YTDLP_PROXY: '',
        YTDLP: process.execPath, // não usado no health raso
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 8_000);
      const onData = (buf) => {
        if (String(buf).includes('listen') || String(buf).includes('Convenus')) {
          clearTimeout(t);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`server saiu cedo: ${code}`));
      });
    });
  });

  after(() => {
    try { child.kill('SIGTERM'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('health básico responde sem extensão', async () => {
    const r = await fetch(`${base}/health`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
  });

  it('status público não exige auth', async () => {
    const r = await fetch(`${base}/api/status`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(typeof j.youtube, 'boolean');
  });

  it('login admin + refresh + cookies auth gate', async () => {
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: bootstrap, deviceName: 'Smoke' }),
    }).then((r) => r.json());
    assert.ok(login.accessToken);

    const session = await fetch(`${base}/api/admin/session`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    }).then((r) => r.json());
    assert.equal(session.ok, true);

    const refreshed = await fetch(`${base}/api/admin/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    }).then((r) => r.json());
    assert.ok(refreshed.accessToken);

    const denied = await fetch(`${base}/api/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'nope' }),
    });
    assert.equal(denied.status, 403);
  });

  it('site estático e PWA manifest', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const man = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(man.status, 200);
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { Auth } = require('../lib/auth');
const cookies = require('../lib/cookies');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-test-'));
const job = (over = {}) => ({
  id: 'a'.repeat(16), mode: 'native', url: 'https://soundcloud.com/x/y', index: null, named: false, duration: 0,
  kind: 'mp4', quality: 720, title: 'Teste', opts: { subs: { lang: 'pt', auto: false, embed: true } }, platform: 'SoundCloud',
  status: 'queued', phase: 'Na fila', percent: 0, error: null, file: null, size: 0, attempts: 0,
  createdAt: Date.now(), startedAt: 0, finishedAt: 0, ...over,
});

// ---------- banco ----------

test('banco: salva e lê de volta com os tipos certos', () => {
  const s = new Store(path.join(tmp(), 'db.sqlite'));
  s.save(job());
  const j = s.get('a'.repeat(16));
  assert.equal(j.quality, 720);
  assert.deepEqual(j.opts.subs, { lang: 'pt', auto: false, embed: true });
  s.save(job({ id: 'b'.repeat(16), kind: 'mp3', quality: '320' }));
  assert.equal(s.get('b'.repeat(16)).quality, '320');
  s.close();
});

test('banco: sobrevive a "reinício" (abre de novo o mesmo arquivo)', () => {
  const file = path.join(tmp(), 'db.sqlite');
  let s = new Store(file);
  s.save(job({ status: 'running', percent: 40 }));
  s.close();
  s = new Store(file);
  const [j] = s.load(86_400_000);
  assert.equal(j.status, 'running');
  assert.equal(j.percent, 40);
  s.close();
});

test('banco: load traz ativas sempre e terminadas só dentro do prazo; prune não toca em ativas', () => {
  const s = new Store(path.join(tmp(), 'db.sqlite'));
  const now = Date.now();
  s.save(job({ id: '1'.repeat(16), status: 'done', finishedAt: now - 10_000 }));
  s.save(job({ id: '2'.repeat(16), status: 'done', finishedAt: now - 10 * 86_400_000 }));
  s.save(job({ id: '3'.repeat(16), status: 'queued', createdAt: now - 10 * 86_400_000 }));
  const ids = s.load(86_400_000, now).map((j) => j.id).sort();
  assert.deepEqual(ids, ['1'.repeat(16), '3'.repeat(16)]);
  assert.equal(s.prune(now - 86_400_000), 1);
  assert.ok(s.get('3'.repeat(16)));
  s.close();
});

// ---------- acesso ----------

test('acesso: código certo/errado e sessão assinada', () => {
  const a = new Auth(path.join(tmp(), 'admin.token'));
  assert.ok(a.checkToken(a.token));
  assert.ok(!a.checkToken('errado'));
  assert.ok(!a.checkToken(''));
  const sess = a.newSession();
  assert.ok(a.verify(sess));
  const [body, mac] = sess.split('.');
  assert.equal(a.verify(`${body}x.${mac}`), null, 'adulterada');
  assert.equal(a.verify(a.sign({ exp: Date.now() - 1 })), null, 'expirada');
});

test('acesso: trocar o código derruba as sessões abertas', () => {
  const file = path.join(tmp(), 'admin.token');
  const a = new Auth(file);
  const sess = a.newSession();
  fs.writeFileSync(file, 'outro-codigo\n');
  a.reload();
  assert.equal(a.verify(sess), null);
});

test('acesso: limite de tentativas por IP', () => {
  const a = new Auth(path.join(tmp(), 'admin.token'));
  for (let i = 0; i < 3; i++) assert.ok(a.allowAttempt('1.2.3.4', 3));
  assert.equal(a.allowAttempt('1.2.3.4', 3), false);
  assert.ok(a.allowAttempt('5.6.7.8', 3));
});

test('acesso: o arquivo do código é criado só pra dona (600)', () => {
  const file = path.join(tmp(), 'admin.token');
  new Auth(file); // eslint-disable-line no-new
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// ---------- cookies ----------

const exportOk = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tabc\n.youtube.com\tTRUE\t/\tFALSE\t0\tSID\txyz\n.facebook.com\tTRUE\t/\tTRUE\t0\tc_user\t123\n';

test('cookies: guarda só YouTube/Google e recusa export sem login', () => {
  const t = cookies.filterExport(exportOk);
  assert.match(t, /LOGIN_INFO/);
  assert.doesNotMatch(t, /facebook/);
  assert.throws(() => cookies.filterExport('.youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tx\n'), /não tem o login/);
});

test('cookies: renovação válida troca de forma atômica e guarda o anterior', async () => {
  const d = tmp();
  const file = path.join(d, 'cookies.txt');
  fs.writeFileSync(file, 'VELHO\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvelho\n');
  await cookies.renew({ file, backupFile: path.join(d, 'prev.txt'), masterFile: path.join(d, 'master.txt'), raw: exportOk, validate: async () => {} });
  assert.match(fs.readFileSync(file, 'utf8'), /LOGIN_INFO\tabc/);
  assert.match(fs.readFileSync(path.join(d, 'prev.txt'), 'utf8'), /VELHO/);
  assert.match(fs.readFileSync(path.join(d, 'master.txt'), 'utf8'), /LOGIN_INFO/);
  assert.equal(fs.existsSync(`${file}.new`), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('cookies: se a validação falha, os cookies em uso nem são tocados', async () => {
  const d = tmp();
  const file = path.join(d, 'cookies.txt');
  fs.writeFileSync(file, 'EM USO\n');
  await assert.rejects(cookies.renew({ file, backupFile: path.join(d, 'prev.txt'), raw: exportOk, validate: async () => { throw new Error('YouTube recusou'); } }), /recusou/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'EM USO\n');
  assert.equal(fs.existsSync(`${file}.new`), false);
  assert.equal(fs.existsSync(path.join(d, 'prev.txt')), false);
});

test('cookies: se o teste derruba o login do arquivo novo, também não troca', async () => {
  const d = tmp();
  const file = path.join(d, 'cookies.txt');
  fs.writeFileSync(file, 'EM USO\n');
  const validate = async (temp) => fs.writeFileSync(temp, '# sem login\n');
  await assert.rejects(cookies.renew({ file, backupFile: path.join(d, 'prev.txt'), raw: exportOk, validate }), /recusou/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'EM USO\n');
});

'use strict';

// scripts/update-ytdlp.sh sem rede: um "curl" falso no PATH entrega a versão nova.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'update-ytdlp.sh');

// Um "yt-dlp" de mentira: diz a versão e, se `ok`, passa no teste de extração.
const fakeYtdlp = (version, ok) => `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
${ok ? 'echo titulo; exit 0' : 'exit 1'}
`;

function setup(newOk) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-upd-'));
  const bin = path.join(d, 'yt-dlp');
  fs.writeFileSync(bin, fakeYtdlp('2026.01.01', true), { mode: 0o755 });
  const stubs = path.join(d, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(d, 'novo'), fakeYtdlp('2099.01.01', newOk), { mode: 0o755 });
  // curl falso: API do GitHub → tag nova; download (-o arquivo) → copia o binário novo.
  fs.writeFileSync(path.join(stubs, 'curl'), `#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
if [ -n "$out" ]; then cp "${d}/novo" "$out"; else echo '{"tag_name": "2099.01.01"}'; fi
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, YTDLP: bin, PORT: '1' };
  const runIt = () => {
    try {
      return { code: 0, out: execFileSync('bash', [SCRIPT, '--force'], { env, encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  return { d, bin, runIt };
}

test('versão nova quebrada: não instala, a atual fica intacta', () => {
  const { bin, runIt } = setup(false);
  const r = runIt();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /não passou no teste/);
  assert.equal(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(), '2026.01.01');
  assert.equal(fs.existsSync(`${bin}.new`), false);
});

test('versão nova boa: instala e guarda a anterior em .prev', () => {
  const { bin, runIt } = setup(true);
  const r = runIt();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /atualizado: 2026.01.01 → 2099.01.01/);
  assert.equal(execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(), '2099.01.01');
  assert.equal(execFileSync(`${bin}.prev`, ['--version'], { encoding: 'utf8' }).trim(), '2026.01.01');
});

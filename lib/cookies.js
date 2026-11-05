'use strict';

// Cookies do YouTube (conta descartável). Regras que vieram de quedas reais:
// - só existe UM arquivo ativo; cópias nunca são usadas pelo yt-dlp ao mesmo tempo (o Google vê
//   token reaproveitado e derruba a sessão);
// - renovação: grava num temporário, valida, e só então troca de forma atômica (rename);
// - a versão anterior fica guardada como backup.

const fs = require('node:fs');

const LOGIN_RE = /\t(LOGIN_INFO|SID)\t/;

function hasLogin(file) {
  try {
    return LOGIN_RE.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function copyPrivate(from, to) {
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o600);
}

/**
 * Guarda só as linhas do YouTube/Google de um export Netscape. Devolve o texto pronto
 * ou lança Error com uma mensagem pra pessoa.
 */
function filterExport(raw) {
  const lines = String(raw || '').split(/\r?\n/).filter((l) => /^#(?!HttpOnly_)|^\s*$/.test(l)
    || /^(#HttpOnly_)?\.?(youtube\.com|google\.com)\t/.test(l));
  const seen = new Set();
  const body = lines.filter((l) => {
    if (!l.trim() || l.startsWith('#') && !l.startsWith('#HttpOnly_')) return false;
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  const text = `# Netscape HTTP Cookie File\n${body.join('\n')}\n`;
  if (!LOGIN_RE.test(text) || !/youtube\.com\t/.test(text)) {
    throw new Error('Esse arquivo não tem o login do YouTube. Exporta logado em youtube.com, na janela anônima.');
  }
  return text;
}

/**
 * Troca os cookies com segurança.
 * `validate(tempFile)` deve lançar se os cookies novos não funcionarem (pode regravar o temp:
 * é o yt-dlp girando tokens, e essa versão girada é a que fica).
 */
async function renew({ file, backupFile, masterFile, raw, validate }) {
  const text = filterExport(raw);
  const temp = `${file}.new`;
  writePrivate(temp, text);
  try {
    await validate(temp);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
  if (!hasLogin(temp)) {
    fs.rmSync(temp, { force: true });
    throw new Error('O YouTube recusou esse login (os cookies perderam a sessão no teste).');
  }
  if (fs.existsSync(file)) copyPrivate(file, backupFile);
  fs.renameSync(temp, file); // atômico no mesmo sistema de arquivos
  fs.chmodSync(file, 0o600);
  if (masterFile) copyPrivate(file, masterFile);
}

module.exports = { hasLogin, filterExport, renew, copyPrivate, writePrivate, LOGIN_RE };

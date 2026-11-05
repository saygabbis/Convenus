'use strict';

// Acesso privado: a Gabbis entra uma vez com o código de acesso (admin.token) e recebe uma
// sessão assinada (HMAC) num cookie HttpOnly. O segredo de assinatura deriva do código, então
// trocar o código invalida todas as sessões abertas.

const fs = require('node:fs');
const crypto = require('node:crypto');

const COOKIE = 'cv_sess';
const SESSION_DAYS = 180;

function readOrCreateToken(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${crypto.randomBytes(12).toString('base64url')}\n`, { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Auth {
  constructor(tokenFile) {
    this.tokenFile = tokenFile;
    this.reload();
    this.tries = new Map(); // ip -> [timestamps]
  }

  reload() {
    this.token = readOrCreateToken(this.tokenFile);
    this.key = crypto.createHash('sha256').update(`convenus-session:${this.token}`).digest();
  }

  checkToken(given) {
    return safeEqual(String(given || '').trim(), this.token);
  }

  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', this.key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(value, now = Date.now()) {
    const [body, mac] = String(value || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', this.key).update(body).digest('base64url');
    if (!safeEqual(mac, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return p.exp > now ? p : null;
    } catch {
      return null;
    }
  }

  newSession(now = Date.now()) {
    return this.sign({ iat: now, exp: now + SESSION_DAYS * 86_400_000 });
  }

  sessionFrom(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? this.verify(decodeURIComponent(m[1])) : null;
  }

  cookieHeader(value, req, maxAgeSec = SESSION_DAYS * 86_400) {
    // Atrás do nginx com HTTPS: Secure. Direto em http://127.0.0.1 (testes): sem Secure.
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  /** Limite de tentativas por IP: `max` em `windowMs`. Devolve true se ainda pode tentar. */
  allowAttempt(ip, max = 8, windowMs = 15 * 60_000, now = Date.now()) {
    const list = (this.tries.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.tries.set(ip, list);
      return false;
    }
    list.push(now);
    this.tries.set(ip, list);
    return true;
  }

  clearAttempts(ip) {
    this.tries.delete(ip);
  }
}

module.exports = { Auth, COOKIE, safeEqual };

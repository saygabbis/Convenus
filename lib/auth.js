'use strict';

// Autenticação administrativa por dispositivo: access + refresh com rotação e revogação.
// O admin.token continua sendo o segredo de enrollment (nunca vai pro frontend/git).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('./logger');

const ACCESS_TTL_MS = Number(process.env.ADMIN_ACCESS_TTL_MIN || 60) * 60_000;
const REFRESH_TTL_MS = Number(process.env.ADMIN_REFRESH_TTL_DAYS || 30) * 24 * 60 * 60_000;
const SCOPES = Object.freeze(['status:read', 'cookies:write', 'devices:read', 'devices:revoke', 'health:read']);

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s) {
  return Buffer.from(String(s), 'base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function createAuth({ rootDir, adminToken }) {
  const dataDir = path.join(rootDir, 'data');
  const storePath = path.join(dataDir, 'devices.json');
  const secretPath = path.join(dataDir, 'auth.secret');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, `${b64url(crypto.randomBytes(32))}\n`, { mode: 0o600 });
  }
  const secret = fs.readFileSync(secretPath, 'utf8').trim();

  function load() {
    try {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch {
      return { devices: [] };
    }
  }

  function save(state) {
    const tmp = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  }

  function signAccess({ deviceId, scopes }) {
    const now = Date.now();
    const payload = {
      typ: 'access',
      sub: deviceId,
      scopes,
      iat: now,
      exp: now + ACCESS_TTL_MS,
      jti: b64url(crypto.randomBytes(12)),
    };
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return { token: `${body}.${sig}`, expiresAt: payload.exp, jti: payload.jti };
  }

  function verifyAccess(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqualStr(sig, expect)) return null;
    let payload;
    try {
      payload = JSON.parse(fromB64url(body).toString('utf8'));
    } catch {
      return null;
    }
    if (payload.typ !== 'access' || !payload.sub || !payload.exp || payload.exp < Date.now()) return null;
    const state = load();
    const device = state.devices.find((d) => d.id === payload.sub && !d.revokedAt);
    if (!device) return null;
    if (device.accessJti && device.accessJti !== payload.jti) return null; // revogado por rotação/logout
    return { device, scopes: payload.scopes || device.scopes || [], payload };
  }

  function publicDevice(d) {
    return {
      id: d.id,
      name: d.name,
      scopes: d.scopes,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt || null,
      expiresAt: d.refreshExpiresAt,
      revokedAt: d.revokedAt || null,
    };
  }

  function enroll({ adminSecret, name, userAgent, ip }) {
    if (!safeEqualStr(adminSecret, adminToken)) {
      const err = new Error('Código errado.');
      err.status = 403;
      throw err;
    }
    const deviceName = String(name || 'Dispositivo').trim().slice(0, 80) || 'Dispositivo';
    const refreshRaw = b64url(crypto.randomBytes(32));
    const deviceId = b64url(crypto.randomBytes(12));
    const now = Date.now();
    const access = signAccess({ deviceId, scopes: [...SCOPES] });
    const device = {
      id: deviceId,
      name: deviceName,
      scopes: [...SCOPES],
      refreshHash: hashToken(refreshRaw),
      refreshExpiresAt: now + REFRESH_TTL_MS,
      accessJti: access.jti,
      createdAt: now,
      lastSeenAt: now,
      userAgent: String(userAgent || '').slice(0, 200),
      ip: String(ip || '').slice(0, 80),
      revokedAt: null,
    };
    const state = load();
    state.devices.push(device);
    save(state);
    log.audit('device.enroll', { deviceId, name: deviceName, ip });
    return {
      deviceId,
      accessToken: access.token,
      refreshToken: refreshRaw,
      expiresAt: access.expiresAt,
      refreshExpiresAt: device.refreshExpiresAt,
      scopes: device.scopes,
      device: publicDevice(device),
    };
  }

  function refresh({ refreshToken, ip }) {
    const hash = hashToken(refreshToken);
    const state = load();
    const device = state.devices.find((d) => d.refreshHash === hash);
    if (!device || device.revokedAt) {
      const err = new Error('Sessão inválida ou revogada.');
      err.status = 401;
      throw err;
    }
    if (device.refreshExpiresAt < Date.now()) {
      device.revokedAt = Date.now();
      save(state);
      const err = new Error('Sessão expirada. Autorize o dispositivo de novo.');
      err.status = 401;
      throw err;
    }
    // Rotação: invalida o refresh anterior imediatamente (anti-replay).
    const newRefresh = b64url(crypto.randomBytes(32));
    device.refreshHash = hashToken(newRefresh);
    device.refreshExpiresAt = Date.now() + REFRESH_TTL_MS;
    device.lastSeenAt = Date.now();
    device.ip = String(ip || device.ip || '').slice(0, 80);
    const access = signAccess({ deviceId: device.id, scopes: device.scopes });
    device.accessJti = access.jti;
    save(state);
    log.audit('device.refresh', { deviceId: device.id, ip });
    return {
      deviceId: device.id,
      accessToken: access.token,
      refreshToken: newRefresh,
      expiresAt: access.expiresAt,
      refreshExpiresAt: device.refreshExpiresAt,
      scopes: device.scopes,
      device: publicDevice(device),
    };
  }

  function revoke({ deviceId, byDeviceId, all = false }) {
    const state = load();
    const now = Date.now();
    let count = 0;
    for (const d of state.devices) {
      if (d.revokedAt) continue;
      if (all && byDeviceId) {
        // só o próprio admin pode pedir "all" — caller valida escopo
        d.revokedAt = now;
        d.accessJti = null;
        count++;
      } else if (d.id === deviceId) {
        d.revokedAt = now;
        d.accessJti = null;
        count++;
      }
    }
    save(state);
    log.audit('device.revoke', { deviceId: deviceId || null, byDeviceId, all, count });
    return { ok: true, revoked: count };
  }

  function listDevices() {
    return load().devices.map(publicDevice).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function touch(deviceId) {
    const state = load();
    const d = state.devices.find((x) => x.id === deviceId);
    if (!d || d.revokedAt) return;
    d.lastSeenAt = Date.now();
    save(state);
  }

  function checkBootstrap(token) {
    return safeEqualStr(token, adminToken);
  }

  function hasScope(auth, scope) {
    return Boolean(auth?.scopes?.includes(scope));
  }

  return {
    SCOPES,
    enroll,
    refresh,
    revoke,
    listDevices,
    verifyAccess,
    touch,
    checkBootstrap,
    hasScope,
    publicDevice,
  };
}

module.exports = { createAuth, SCOPES };

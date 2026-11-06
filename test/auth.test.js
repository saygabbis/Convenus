'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('../lib/auth');

describe('admin device auth', () => {
  let root;
  let auth;
  const bootstrap = 'test-admin-secret-value';

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'convenus-auth-'));
    auth = createAuth({ rootDir: root, adminToken: bootstrap });
  });

  it('rejeita enrollment com segredo errado', () => {
    assert.throws(() => auth.enroll({ adminSecret: 'nope', name: 'x', ip: '1.1.1.1' }), /Código errado/);
  });

  it('emite access+refresh e valida escopos', () => {
    const out = auth.enroll({ adminSecret: bootstrap, name: 'PC teste', ip: '127.0.0.1' });
    assert.ok(out.accessToken.includes('.'));
    assert.ok(out.refreshToken);
    const session = auth.verifyAccess(out.accessToken);
    assert.equal(session.device.id, out.deviceId);
    assert.ok(auth.hasScope(session, 'cookies:write'));
  });

  it('rota refresh tokens e invalida o anterior (anti-replay)', () => {
    const first = auth.enroll({ adminSecret: bootstrap, name: 'Rotação', ip: '127.0.0.1' });
    const second = auth.refresh({ refreshToken: first.refreshToken, ip: '127.0.0.1' });
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.ok(auth.verifyAccess(second.accessToken));
    assert.equal(auth.verifyAccess(first.accessToken), null);
    assert.throws(() => auth.refresh({ refreshToken: first.refreshToken, ip: '127.0.0.1' }), /inválida|revogada/);
  });

  it('revoga dispositivo imediatamente', () => {
    const out = auth.enroll({ adminSecret: bootstrap, name: 'Revogar', ip: '127.0.0.1' });
    auth.revoke({ deviceId: out.deviceId, byDeviceId: out.deviceId });
    assert.equal(auth.verifyAccess(out.accessToken), null);
  });
});

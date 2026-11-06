'use strict';

// Sync com a API real da VPS (branch manutencao-estabilidade):
// POST /api/login + cookie de sessão, e/ou Authorization: Bearer <admin.token>
// Só cookies de youtube.com.

const DEFAULT_API = 'https://convert.saygabbis.cloud';
const ALARM = 'convenus-sync';
const DEFAULT_SYNC_MIN = 2;

async function loadPackagedConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('config.local.json'));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function settings() {
  const packed = await loadPackagedConfig();
  const local = await chrome.storage.local.get([
    'apiBase', 'deviceName', 'lastStatus', 'autoSyncCookies',
    'lastCookieHash', 'lastSyncAt', 'lastSyncResult', 'loggedIn',
  ]);
  return {
    apiBase: (local.apiBase || packed.apiBase || DEFAULT_API).replace(/\/$/, ''),
    adminToken: packed.adminToken || '',
    deviceName: local.deviceName || packed.deviceName || 'Convenus Ext',
    autoSyncCookies: local.autoSyncCookies ?? packed.autoSyncCookies !== false,
    syncMinutes: Number(packed.syncMinutes || DEFAULT_SYNC_MIN) || DEFAULT_SYNC_MIN,
    lastStatus: local.lastStatus || null,
    lastCookieHash: local.lastCookieHash || '',
    lastSyncAt: local.lastSyncAt || 0,
    lastSyncResult: local.lastSyncResult || null,
    loggedIn: Boolean(local.loggedIn),
  };
}

async function save(partial) {
  await chrome.storage.local.set(partial);
}

async function api(path, { method = 'GET', body } = {}) {
  const cfg = await settings();
  if (!cfg.adminToken) throw new Error('Falta adminToken em config.local.json');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.adminToken}`,
  };
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureLogin() {
  const cfg = await settings();
  // Bearer (admin.token) já autentica na VPS. /api/login só tenta setar cookie cv_sess.
  try {
    await api('/api/login', { method: 'POST', body: { token: cfg.adminToken } });
  } catch (e) {
    if (/Origem/i.test(e.message)) {
      throw new Error('Servidor ainda bloqueia a extensão. Avise pra atualizar o server.js na VPS.');
    }
    // Ignora falha de login por cookie se o Bearer responder no /api/status.
  }
  await api('/api/status');
  await save({ loggedIn: true });
}

function isYoutubeCookie(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'youtube.com' || d.endsWith('.youtube.com');
}

async function exportYoutubeCookies() {
  const domains = ['.youtube.com', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
  const seen = new Set();
  const lines = ['# Netscape HTTP Cookie File'];
  for (const domain of domains) {
    const list = await chrome.cookies.getAll({ domain });
    for (const c of list) {
      if (!isYoutubeCookie(c.domain)) continue;
      const key = `${c.domain}\t${c.path}\t${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      const namePrefix = c.httpOnly ? '#HttpOnly_' : '';
      lines.push(`${namePrefix}${c.domain}\t${includeSub}\t${c.path}\t${secure}\t${exp}\t${c.name}\t${c.value}`);
    }
  }
  const text = `${lines.join('\n')}\n`;
  if (!/\t(LOGIN_INFO|SID)\t/.test(text)) {
    throw new Error('Sem login YouTube. Abra youtube.com e entre na conta descartável.');
  }
  return text;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function syncCookies({ force = false } = {}) {
  const cfg = await settings();
  if (!cfg.autoSyncCookies && !force) return { skipped: true, reason: 'autoSync desligado' };

  await ensureLogin();

  let content;
  try {
    content = await exportYoutubeCookies();
  } catch (e) {
    await save({ lastSyncAt: Date.now(), lastSyncResult: { ok: false, message: e.message } });
    return { ok: false, error: e.message };
  }

  const hash = await sha256(content);
  let status = { youtube: false };
  try {
    status = await api('/api/status');
  } catch { /* segue e tenta mandar cookies */ }

  const need = force || !status.youtube || hash !== cfg.lastCookieHash;
  if (!need) {
    await save({
      lastSyncAt: Date.now(),
      lastSyncResult: { ok: true, message: 'Cookies iguais — nada a enviar', skipped: true },
    });
    return { ok: true, skipped: true };
  }

  const data = await api('/api/cookies', { method: 'POST', body: { content } });
  await save({
    lastCookieHash: hash,
    lastSyncAt: Date.now(),
    lastSyncResult: { ok: Boolean(data.ok), message: data.message || data.error || '' },
  });
  return data;
}

async function poll() {
  let status = { youtube: false, offline: true };
  let sync = null;
  let authed = false;

  try {
    await ensureLogin();
    authed = true;
    status = await api('/api/status');
    status.offline = false;
    sync = await syncCookies({ force: !status.youtube });
    status = await api('/api/status');
    status.offline = false;
  } catch (e) {
    sync = { ok: false, error: e.message };
    status = { youtube: false, offline: true, error: e.message };
  }

  const snapshot = {
    at: Date.now(),
    youtube: Boolean(status.youtube),
    offline: Boolean(status.offline),
    running: status.queue?.running ?? null,
    queued: status.queue?.queued ?? null,
    authed,
    syncOk: sync ? sync.ok !== false || sync.skipped : null,
    syncMessage: sync?.message || sync?.error || null,
    alerts: [
      status.offline && 'site offline',
      status.error,
      !status.offline && !status.youtube && 'login YouTube ainda ruim',
      sync && sync.ok === false && (sync.error || sync.message),
    ].filter(Boolean),
  };
  await save({ lastStatus: snapshot });
  await updateBadge(snapshot);
  return snapshot;
}

async function updateBadge(snapshot) {
  let text = '';
  let color = '#2f8f63';
  if (snapshot.offline) { text = '!'; color = '#b8382e'; }
  else if (!snapshot.authed) { text = 'Auth'; color = '#c94a24'; }
  else if (!snapshot.youtube) { text = 'YT'; color = '#c94a24'; }
  else { text = 'OK'; color = '#2f8f63'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function armAlarm() {
  const cfg = await settings();
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, cfg.syncMinutes) });
}

chrome.runtime.onInstalled.addListener(async () => {
  await armAlarm();
  poll().catch(() => {});
});
chrome.runtime.onStartup.addListener(async () => {
  await armAlarm();
  poll().catch(() => {});
});

chrome.cookies.onChanged.addListener((change) => {
  if (!isYoutubeCookie(change.cookie?.domain)) return;
  chrome.alarms.create('convenus-sync-soon', { delayInMinutes: 0.2 });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) poll().catch(() => {});
  if (a.name === 'convenus-sync-soon') syncCookies({ force: true }).then(() => poll()).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'getState':
        return { settings: await settings(), status: (await chrome.storage.local.get('lastStatus')).lastStatus || null };
      case 'poll':
        return { ok: true, status: await poll() };
      case 'syncNow':
        return { ok: true, data: await syncCookies({ force: true }) };
      case 'setAutoSync':
        await save({ autoSyncCookies: Boolean(msg.value) });
        return { ok: true };
      default:
        throw new Error('Comando desconhecido');
    }
  })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

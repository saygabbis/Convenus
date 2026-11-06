'use strict';

const $ = (s) => document.querySelector(s);

function showMsg(ok, text) {
  const el = $('#msg');
  el.hidden = !text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
  el.textContent = text || '';
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function paint(state) {
  const st = state.status || {};
  const sync = state.settings?.lastSyncResult;

  $('#dotSite').className = `dot ${st.offline ? 'err' : 'ok'}`;
  $('#txtSite').textContent = st.offline
    ? 'Site offline'
    : `Site online · ${st.running ?? 0} rodando / ${st.queued ?? 0} na fila`;

  $('#dotYt').className = `dot ${st.offline ? 'warn' : (st.youtube ? 'ok' : 'err')}`;
  $('#txtYt').textContent = st.youtube ? 'YouTube autenticado no servidor' : 'YouTube sem login no servidor';

  const syncOk = st.syncOk !== false && sync?.ok !== false;
  $('#dotSync').className = `dot ${st.authed === false ? 'err' : (syncOk ? 'ok' : 'warn')}`;
  const when = state.settings?.lastSyncAt ? new Date(state.settings.lastSyncAt).toLocaleTimeString() : '—';
  $('#txtSync').textContent = st.authed === false
    ? 'Extensão sem auth (confira config.local.json)'
    : `Último sync ${when}${sync?.message ? ` · ${sync.message}` : ''}`;

  $('#autoSync').checked = state.settings?.autoSyncCookies !== false;

  if (st.alerts?.length) {
    $('#alerts').hidden = false;
    $('#alerts').textContent = st.alerts.join(' · ');
  } else {
    $('#alerts').hidden = true;
  }
}

async function refreshUi() {
  const state = await send('getState');
  paint(state);
}

$('#autoSync').addEventListener('change', async (e) => {
  await send('setAutoSync', { value: e.target.checked });
  showMsg(true, e.target.checked ? 'Sync automático ligado.' : 'Sync automático desligado.');
});

$('#btnPoll').addEventListener('click', async () => {
  await send('poll');
  await refreshUi();
  showMsg(true, 'Status atualizado.');
});

$('#btnSync').addEventListener('click', async () => {
  $('#btnSync').disabled = true;
  try {
    const r = await send('syncNow');
    if (!r.ok) throw new Error(r.error || 'Falha');
    showMsg(Boolean(r.data?.ok !== false), r.data?.message || r.data?.error || (r.data?.skipped ? 'Já estava atualizado.' : 'Sync ok.'));
    await send('poll');
    await refreshUi();
  } catch (e) {
    showMsg(false, e.message);
  } finally {
    $('#btnSync').disabled = false;
  }
});

$('#btnOpenYt').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.youtube.com/' });
});

refreshUi().catch((e) => showMsg(false, e.message));
send('poll').then(refreshUi).catch(() => {});

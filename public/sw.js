'use strict';

// Só cuida do "Compartilhar" do celular (share_target com POST). Não guarda a página nem nada
// do site: todo o resto vai direto pra rede, então o app nunca fica com versão velha.

const BOX = 'compartilhados';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'POST' || u.origin !== location.origin || u.pathname !== '/compartilhar') return;
  e.respondWith(receive(e.request));
});

async function receive(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect('/', 303);
  }
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0).slice(0, 10);
  if (files.length) {
    // Os arquivos ficam no aparelho até a página pegar (ela apaga logo depois).
    await caches.delete(BOX);
    const box = await caches.open(BOX);
    await Promise.all(files.map((f, i) => box.put(`/compartilhado/${i}`, new Response(f, {
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `arquivo-${i + 1}`) },
    }))));
    return Response.redirect(`/?compartilhado=${files.length}`, 303);
  }
  const q = new URLSearchParams();
  for (const k of ['url', 'text', 'title']) {
    const v = form.get(k);
    if (typeof v === 'string' && v.trim()) q.set(k, v.trim().slice(0, 4000));
  }
  return Response.redirect(q.toString() ? `/?${q}` : '/', 303);
}

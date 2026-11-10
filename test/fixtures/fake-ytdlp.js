#!/usr/bin/env node
'use strict';

// yt-dlp de mentira pros testes de integração: responde -J com um vídeo fictício (com legenda
// em pt) e "baixa" criando o arquivo na pasta pedida. Sem rede, sem cookies.
//   FAKE_SLOW_FILE: enquanto esse arquivo existir, o download fica parado (simula tarefa longa).

const fs = require('node:fs');
const path = require('node:path');

const a = process.argv.slice(2);
const val = (flag) => a[a.indexOf(flag) + 1];
//   FAKE_ARGS_LOG: grava os argumentos de cada chamada (uma linha JSON por chamada).
//   FAKE_FAIL_LOADED: enquanto esse arquivo existir, download com --load-info-json dá 403.
if (process.env.FAKE_ARGS_LOG) fs.appendFileSync(process.env.FAKE_ARGS_LOG, `${JSON.stringify(a)}\n`);
if (a.includes('--load-info-json') && process.env.FAKE_FAIL_LOADED && fs.existsSync(process.env.FAKE_FAIL_LOADED)) {
  console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden');
  process.exit(1);
}

if (a.includes('--version')) {
  console.log('2099.01.01');
  process.exit(0);
}

if (a.includes('-J')) {
  console.log(JSON.stringify({
    id: 'fake1',
    title: 'Fake video',
    uploader: 'Tester',
    duration: 10,
    thumbnail: 'https://i1.sndcdn.com/fake.jpg',
    formats: [{ format_id: 'h', vcodec: 'avc1', acodec: 'mp4a', height: 720, ext: 'mp4' }],
    subtitles: { pt: [{ ext: 'vtt', name: 'Português' }], live_chat: [{ ext: 'json' }] },
    language: 'en',
    automatic_captions: { 'en-orig': [{ ext: 'vtt', name: 'English (Original)' }], en: [{ ext: 'vtt', name: 'English' }], fr: [{ ext: 'vtt', name: 'French' }] },
  }));
  process.exit(0);
}

const dir = val('-P');
const tmpl = val('-o');

if (process.env.FAKE_SLOW_FILE && fs.existsSync(process.env.FAKE_SLOW_FILE)) {
  console.log('@@P 10.0%|1.00MiB/s|00:30');
  setInterval(() => console.log('@@P 10.0%|1.00MiB/s|00:30'), 500);
  return;
}

if (a.includes('--skip-download')) {
  const lang = val('--sub-langs');
  if (lang !== 'pt' && lang !== 'en-orig') process.exit(0); // yt-dlp sai 0 sem legenda nenhuma
  fs.writeFileSync(path.join(dir, `Fake video.${lang}.srt`), '1\n00:00:00,000 --> 00:00:01,000\nOi\n');
  process.exit(0);
}

const ext = a.includes('--audio-format') ? val('--audio-format') : 'mp4';
const name = tmpl.replace('%(title).150B', 'Fake video').replace('%(ext)s', ext);
const file = path.join(dir, name);
fs.writeFileSync(file, `conteudo ${ext} ${a.includes('--embed-subs') ? 'com-legenda' : ''}`);
console.log('@@P 50.0%|1.00MiB/s|00:01');
console.log(`@@F ${file}`);

'use strict';

// Tarefas e histórico em SQLite (node:sqlite, embutido no Node 22: sem dependência nova).
// A fila em memória continua sendo a fonte da verdade enquanto o processo roda; o banco
// guarda tudo pra sobreviver a reinícios.

const fs = require('node:fs');
const path = require('node:path');

// O módulo ainda é marcado como experimental: evita o aviso no log a cada start.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

const COLUMNS = [
  'id', 'mode', 'url', 'item_index', 'named', 'duration', 'kind', 'quality', 'title', 'opts', 'platform',
  'status', 'phase', 'percent', 'error', 'file', 'size', 'attempts', 'created_at', 'started_at', 'finished_at',
];

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        url TEXT NOT NULL,
        item_index INTEGER,
        named INTEGER NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        quality TEXT,
        title TEXT NOT NULL DEFAULT '',
        opts TEXT NOT NULL DEFAULT '{}',
        platform TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '',
        percent REAL NOT NULL DEFAULT 0,
        error TEXT,
        file TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
    `);
    const cols = COLUMNS.join(', ');
    const marks = COLUMNS.map((c) => `:${c}`).join(', ');
    const sets = COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = :${c}`).join(', ');
    this.upsertStmt = this.db.prepare(`INSERT INTO jobs (${cols}) VALUES (${marks}) ON CONFLICT(id) DO UPDATE SET ${sets}`);
    this.getStmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    this.delStmt = this.db.prepare('DELETE FROM jobs WHERE id = ?');
  }

  save(job) {
    this.upsertStmt.run(toRow(job));
  }

  get(id) {
    const r = this.getStmt.get(id);
    return r ? fromRow(r) : null;
  }

  /** Tarefas que ainda importam: ativas, ou terminadas há menos de `keepMs`. */
  load(keepMs, now = Date.now()) {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') OR finished_at >= ? ORDER BY created_at")
      .all(now - keepMs).map(fromRow);
  }

  history(limit = 100) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(fromRow);
  }

  delete(id) {
    this.delStmt.run(id);
  }

  /** Apaga do histórico o que terminou antes de `beforeMs`. */
  prune(beforeMs) {
    return this.db.prepare("DELETE FROM jobs WHERE status NOT IN ('queued', 'running') AND finished_at > 0 AND finished_at < ?").run(beforeMs).changes;
  }

  close() {
    try {
      this.db.close();
    } catch { /* já fechado */ }
  }
}

function toRow(j) {
  return {
    id: j.id,
    mode: j.mode,
    url: j.url,
    item_index: j.index ?? null,
    named: j.named ? 1 : 0,
    duration: Number(j.duration) || 0,
    kind: j.kind,
    quality: j.quality == null ? null : String(j.quality),
    title: j.title || '',
    opts: JSON.stringify(j.opts || {}),
    platform: j.platform || '',
    status: j.status,
    phase: j.phase || '',
    percent: Number(j.percent) || 0,
    error: j.error || null,
    file: j.file || null,
    size: Number(j.size) || 0,
    attempts: Number(j.attempts) || 0,
    created_at: j.createdAt,
    started_at: j.startedAt || 0,
    finished_at: j.finishedAt || 0,
  };
}

function fromRow(r) {
  let opts = {};
  try {
    opts = JSON.parse(r.opts || '{}');
  } catch { /* opts corrompido: ignora */ }
  return {
    id: r.id,
    mode: r.mode,
    url: r.url,
    index: r.item_index,
    named: Boolean(r.named),
    duration: r.duration,
    kind: r.kind,
    // mp4 guarda a altura como número; mp3 guarda o bitrate como texto ("320").
    quality: r.quality == null ? null : r.kind === 'mp4' ? Number(r.quality) : r.quality,
    title: r.title,
    opts,
    platform: r.platform,
    status: r.status,
    phase: r.phase,
    percent: r.percent,
    error: r.error,
    file: r.file,
    size: r.size,
    attempts: r.attempts,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

module.exports = { Store };

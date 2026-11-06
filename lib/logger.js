'use strict';

// Logs estruturados em JSON (uma linha por evento), sem dependências.

function ts() {
  return new Date().toISOString();
}

function write(level, msg, extra) {
  const line = JSON.stringify({ ts: ts(), level, msg, ...(extra && typeof extra === 'object' ? extra : {}) });
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
  audit: (action, extra) => write('audit', action, extra),
};

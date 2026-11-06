'use strict';

// Retry com backoff exponencial + jitter. Só para falhas transitórias.

async function withRetry(fn, {
  retries = 3,
  baseMs = 400,
  maxMs = 8_000,
  shouldRetry = () => true,
  onRetry,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(maxMs, baseMs * (2 ** attempt));
      const jitter = Math.floor(Math.random() * Math.min(250, delay / 2));
      if (onRetry) onRetry(err, attempt + 1, delay + jitter);
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
  }
  throw lastErr;
}

function isTransient(err) {
  const s = String(err?.message || err || '');
  return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|429|502|503|504|temporar|rate.?limit|Blocked/i.test(s);
}

module.exports = { withRetry, isTransient };

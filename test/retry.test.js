'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isTransient } = require('../lib/retry');

describe('retry', () => {
  it('detecta erros transitórios', () => {
    assert.equal(isTransient(new Error('HTTP 429')), true);
    assert.equal(isTransient(new Error('ECONNRESET')), true);
    assert.equal(isTransient(new Error('Private video')), false);
  });

  it('repete e depois sucede', async () => {
    let n = 0;
    const v = await withRetry(async () => {
      n += 1;
      if (n < 3) throw new Error('temporário 503');
      return 'ok';
    }, { retries: 3, baseMs: 1, shouldRetry: isTransient });
    assert.equal(v, 'ok');
    assert.equal(n, 3);
  });
});

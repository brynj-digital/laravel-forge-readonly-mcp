import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RateLimiter } from '../src/rate-limit.ts';

/** A controllable clock: sleeping advances time rather than waiting for it. */
function clock() {
  let current = 1_700_000_000_000;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows up to the limit without waiting', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 3, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 3; i += 1) await limiter.acquire();
    assert.deepEqual(c.slept, []);
  });

  it('waits for the window to roll before exceeding the limit', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 2, now: c.now, sleep: c.sleep });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    assert.equal(c.slept.length, 1);
    assert.ok(c.slept[0]! >= 60_000, `expected a ~60s wait, got ${c.slept[0]}`);
  });

  it('does not wait once the window has naturally passed', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 1, now: c.now, sleep: c.sleep });
    await limiter.acquire();
    c.advance(61_000);
    await limiter.acquire();
    assert.deepEqual(c.slept, []);
  });

  it('honours a server-reported exhausted budget even when the local window is clear', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 1000, now: c.now, sleep: c.sleep });
    // Forge says: nothing left, resets in 30 seconds.
    limiter.observeHeaders(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' }));
    await limiter.acquire();
    assert.equal(c.slept.length, 1);
    assert.ok(c.slept[0]! >= 30_000, `expected a ~30s wait, got ${c.slept[0]}`);
  });

  it('treats a large X-RateLimit-Reset as an absolute epoch, not a delta', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 1000, now: c.now, sleep: c.sleep });
    const resetEpochSeconds = Math.floor(c.now() / 1000) + 15;
    limiter.observeHeaders(
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) }),
    );
    await limiter.acquire();
    // A delta reading would have waited ~54 years; an epoch reading waits ~15s.
    assert.ok(c.slept[0]! < 20_000, `expected a ~15s wait, got ${c.slept[0]}`);
  });

  it('prefers Retry-After for the post-429 delay', () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: c.now, sleep: c.sleep });
    assert.ok(limiter.retryDelayMs(headers({ 'retry-after': '5' }), 0) >= 5000);
  });

  it('backs off exponentially when the response says nothing useful', () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: c.now, sleep: c.sleep });
    const first = limiter.retryDelayMs(headers({}), 0);
    const second = limiter.retryDelayMs(headers({}), 1);
    assert.ok(second > first, `expected growth, got ${first} then ${second}`);
  });

  it('serialises concurrent acquirers rather than letting them all through', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 2, now: c.now, sleep: c.sleep });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // Four requests against a limit of two: the first two go straight through, the
    // third waits for the window to roll, and once it has rolled the window is
    // empty again so the fourth needs no further wait. One wait, not zero — the
    // point being that concurrent callers queue instead of all deciding to go.
    assert.equal(c.slept.length, 1);
  });

  it('ignores a missing Retry-After instead of reading it as zero', () => {
    // Number(null) is 0, so a naive read turns an absent header into "retry
    // immediately" and hot-loops against the limit we just hit.
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: c.now, sleep: c.sleep });
    assert.ok(
      limiter.retryDelayMs(headers({}), 0) >= 1000,
      'a missing Retry-After must still back off',
    );
  });

  it('ignores a missing X-RateLimit-Remaining instead of reading it as an empty budget', async () => {
    const c = clock();
    const limiter = new RateLimiter({ requestsPerMinute: 1000, now: c.now, sleep: c.sleep });
    // Establish a reset time, then see a response carrying no rate-limit headers.
    limiter.observeHeaders(headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '30' }));
    limiter.observeHeaders(headers({}));
    await limiter.acquire();
    assert.deepEqual(c.slept, [], 'a header-less response must not look like exhaustion');
  });
});

function headers(values: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

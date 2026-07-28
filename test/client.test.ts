import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAllowlist } from '../src/allowlist.ts';
import { ForgeClient, ForgeError } from '../src/client.ts';
import type { Config } from '../src/config.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const config: Config = {
  apiToken: 'test-token',
  baseUrl: 'https://forge.example.test/api',
  organization: 'acme',
  allowSecrets: false,
  requestsPerMinute: 60,
};

/** A limiter that never actually sleeps, so tests stay fast. */
function fastLimiter(): RateLimiter {
  return new RateLimiter({ requestsPerMinute: 1000, sleep: async () => undefined });
}

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function stub(responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = queue.shift();
    if (!next) throw new Error('stub fetch called more times than expected');
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function client(responses: Response[]) {
  const { fetch: fetchImpl, calls } = stub(responses);
  return {
    calls,
    client: new ForgeClient(config, buildAllowlist(false), fetchImpl, fastLimiter()),
  };
}

describe('buildPath', () => {
  it('substitutes and percent-encodes parameters', () => {
    assert.equal(
      ForgeClient.buildPath('/orgs/{organization}/servers/{server}', {
        organization: 'acme co',
        server: 12345,
      }),
      '/orgs/acme%20co/servers/12345',
    );
  });

  it('encodes a slash inside a parameter rather than letting it retarget the request', () => {
    const path = ForgeClient.buildPath('/orgs/{organization}/servers/{server}', {
      organization: 'acme',
      server: '1/sites/2/environment',
    });
    assert.equal(path, '/orgs/acme/servers/1%2Fsites%2F2%2Fenvironment');
  });

  it('throws on a missing parameter instead of requesting a malformed path', () => {
    assert.throws(
      () => ForgeClient.buildPath('/orgs/{organization}/servers/{server}', { organization: 'acme' }),
      /missing path parameter "server"/,
    );
  });
});

describe('ForgeClient.get', () => {
  it('issues GET with bearer auth and JSON headers', async () => {
    const { client: c, calls } = client([json({ data: [] })]);
    await c.get({ path: '/orgs/acme/servers' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(calls[0]?.url, 'https://forge.example.test/api/orgs/acme/servers');
    assert.equal(calls[0]?.headers.authorization, 'Bearer test-token');
    assert.equal(calls[0]?.headers.accept, 'application/json');
  });

  it('refuses a disallowed path without making any request at all', async () => {
    const { client: c, calls } = client([json({ secret: 'leaked' })]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers/1/sites/2/environment' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.match(error.message, /\.env/);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'no HTTP request should be attempted');
  });

  it('refuses the deploy-hook path without making a request', async () => {
    const { client: c, calls } = client([json({ url: 'https://forge.example.test/deploy/abc' })]);
    await assert.rejects(() => c.get({ path: '/orgs/acme/servers/1/sites/2/deployments/deploy-hook' }));
    assert.equal(calls.length, 0);
  });

  it('serialises query parameters, including bracketed and repeated ones', async () => {
    const { client: c, calls } = client([json({ data: [] })]);
    await c.get({
      path: '/orgs/acme/servers',
      query: { 'page[size]': 50, sort: '-created_at', 'filter[name]': 'web', tags: ['a', 'b'] },
    });

    const url = new URL(calls[0]?.url ?? '');
    assert.equal(url.searchParams.get('page[size]'), '50');
    assert.equal(url.searchParams.get('sort'), '-created_at');
    assert.equal(url.searchParams.get('filter[name]'), 'web');
    assert.deepEqual(url.searchParams.getAll('tags'), ['a', 'b']);
  });

  it('strips the redundant links envelope but keeps the cursors in meta', async () => {
    const { client: c } = client([
      json({
        data: [{ id: 1 }],
        meta: { per_page: 30, next_cursor: 'abc', prev_cursor: null },
        links: { next: '/api/orgs/acme/servers?page[cursor]=abc', prev: null },
      }),
    ]);
    const result = (await c.get({ path: '/orgs/acme/servers' })) as Record<string, unknown>;
    assert.ok(!('links' in result));
    assert.deepEqual(result.meta, { per_page: 30, next_cursor: 'abc', prev_cursor: null });
  });

  it('leaves a non-paginated body untouched', async () => {
    const { client: c } = client([json({ data: { id: 1, name: 'web' } })]);
    const result = (await c.get({ path: '/orgs/acme/servers/1' })) as Record<string, unknown>;
    assert.deepEqual(result, { data: { id: 1, name: 'web' } });
  });

  it('passes plain-text responses (logs) through unparsed', async () => {
    const { client: c } = client([
      new Response('[2026-07-28] production.ERROR: boom', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ]);
    const result = await c.get({ path: '/orgs/acme/servers/1/sites/2/logs/application' });
    assert.equal(result, '[2026-07-28] production.ERROR: boom');
  });
});

describe('error mapping', () => {
  it('names the missing scope on a 403, and flags when that scope also grants writes', async () => {
    const { client: c } = client([new Response('{"message":"Forbidden"}', { status: 403 })]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers/1/sites/2/nginx' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.equal(error.status, 403);
        assert.match(error.message, /site:manage-nginx/);
        assert.match(error.message, /also grants the matching write permissions/);
        return true;
      },
    );
  });

  it('tells a view-scope 403 apart, suggesting the token simply add it', async () => {
    const { client: c } = client([new Response('{}', { status: 403 })]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.match(error.message, /server:view/);
        assert.match(error.message, /Add it when creating a token/);
        return true;
      },
    );
  });

  it('explains a 401 as a token problem', async () => {
    const { client: c } = client([new Response('', { status: 401 })]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.equal(error.status, 401);
        assert.match(error.message, /revoked, expired or mistyped/);
        return true;
      },
    );
  });

  it('notes that a 404 may mean the org is invisible to the token', async () => {
    const { client: c } = client([new Response('', { status: 404 })]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers/999' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.match(error.message, /cannot see the organisation/);
        return true;
      },
    );
  });
});

describe('retries', () => {
  it('retries a 429 and then succeeds', async () => {
    const { client: c, calls } = client([
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      json({ data: [{ id: 1 }] }),
    ]);
    const result = (await c.get({ path: '/orgs/acme/servers' })) as Record<string, unknown>;
    assert.equal(calls.length, 2);
    assert.deepEqual(result, { data: [{ id: 1 }] });
  });

  it('gives up after repeated 429s with advice to narrow the request', async () => {
    const { client: c, calls } = client([
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      new Response('', { status: 429, headers: { 'retry-after': '0' } }),
    ]);
    await assert.rejects(
      () => c.get({ path: '/orgs/acme/servers' }),
      (error: unknown) => {
        assert.ok(error instanceof ForgeError);
        assert.equal(error.status, 429);
        assert.match(error.message, /Narrow the request/);
        return true;
      },
    );
    assert.equal(calls.length, 3);
  });

  it('retries a 500 and then succeeds', async () => {
    const { client: c, calls } = client([
      new Response('', { status: 503 }),
      json({ data: [] }),
    ]);
    await c.get({ path: '/orgs/acme/servers' });
    assert.equal(calls.length, 2);
  });
});

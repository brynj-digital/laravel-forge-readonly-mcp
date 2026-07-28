/**
 * Redaction tests, written against the REAL payload shape Forge returns (captured
 * from a live probe on 2026-07-28) rather than an invented one — the whole reason
 * this module exists is that the imagined shape and the real one differed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAllowlist } from '../src/allowlist.ts';
import { ForgeClient } from '../src/client.ts';
import type { Config } from '../src/config.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { containsRedactableField, redact } from '../src/redact.ts';

/** The shape of a real Forge site payload, trimmed. */
const SITE_PAYLOAD = {
  data: {
    id: '742798',
    type: 'sites',
    attributes: {
      name: 'example.test',
      php_version: 'php83',
      quick_deploy: true,
      deployment_url: 'https://forge.laravel.com/servers/277125/sites/742798/deploy/http?token=SECRET',
      healthcheck_url: null,
      maintenance_mode: false,
    },
  },
};

describe('redact', () => {
  it('removes the deploy trigger URL from a site payload', () => {
    const result = redact(SITE_PAYLOAD) as typeof SITE_PAYLOAD;
    const url = result.data.attributes.deployment_url;
    assert.ok(!url.includes('token=SECRET'), 'the trigger token must not survive');
    assert.ok(!url.includes('deploy/http'), 'the trigger path must not survive');
    assert.match(url, /unauthenticated capability to deploy/);
  });

  it('keeps every other field intact', () => {
    const result = redact(SITE_PAYLOAD) as typeof SITE_PAYLOAD;
    assert.equal(result.data.attributes.name, 'example.test');
    assert.equal(result.data.attributes.php_version, 'php83');
    assert.equal(result.data.attributes.quick_deploy, true);
    assert.equal(result.data.attributes.maintenance_mode, false);
    assert.equal(result.data.id, '742798');
  });

  it('leaves a null deployment_url alone, since that is a real fact', () => {
    // A null trigger URL means quick-deploy is off — useful, and not a leak.
    const result = redact({ attributes: { deployment_url: null } }) as {
      attributes: { deployment_url: null };
    };
    assert.equal(result.attributes.deployment_url, null);
  });

  it('redacts inside arrays, which is how list_sites returns them', () => {
    const list = {
      data: [
        { attributes: { deployment_url: 'https://forge.laravel.com/a/deploy/http?token=A' } },
        { attributes: { deployment_url: 'https://forge.laravel.com/b/deploy/http?token=B' } },
      ],
    };
    const result = redact(list) as typeof list;
    for (const item of result.data) {
      assert.ok(!item.attributes.deployment_url.includes('token='));
    }
  });

  it('redacts at any depth', () => {
    const deep = { a: { b: { c: [{ deployment_url: 'x?token=y' }] } } };
    assert.equal(containsRedactableField(redact(deep)), false);
  });

  it('containsRedactableField spots a populated field and ignores an empty one', () => {
    assert.equal(containsRedactableField(SITE_PAYLOAD), true);
    assert.equal(containsRedactableField({ attributes: { deployment_url: null } }), false);
    assert.equal(containsRedactableField({ attributes: { name: 'x' } }), false);
  });
});

describe('the client redacts on the way out', () => {
  const base: Config = {
    apiToken: 't',
    baseUrl: 'https://forge.example.test/api',
    organization: 'acme',
    allowSecrets: false,
    requestsPerMinute: 60,
  };

  function clientFor(config: Config) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(SITE_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return new ForgeClient(
      config,
      buildAllowlist(config.allowSecrets),
      fetchImpl,
      new RateLimiter({ requestsPerMinute: 1000, sleep: async () => undefined }),
    );
  }

  it('strips the trigger URL from an ordinary site read', async () => {
    const result = await clientFor(base).get({ path: '/orgs/acme/sites/742798' });
    assert.equal(containsRedactableField(result), false);
    assert.ok(!JSON.stringify(result).includes('token=SECRET'));
  });

  it('strips it from forge_get too, not just the named tools', async () => {
    const result = await clientFor(base).get({ path: '/orgs/acme/servers/1/sites' });
    assert.ok(!JSON.stringify(result).includes('token=SECRET'));
  });

  it('passes it through only under --unsafe-allow-secrets', async () => {
    const result = await clientFor({ ...base, allowSecrets: true }).get({
      path: '/orgs/acme/sites/742798',
    });
    assert.ok(JSON.stringify(result).includes('token=SECRET'));
  });
});

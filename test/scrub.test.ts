/**
 * Tests for best-effort secret scrubbing in log/command output.
 *
 * Two failure modes matter equally here, and the second is the one that gets
 * scrubbers abandoned: missing a real credential, and mangling ordinary log lines
 * so much that users reach for --unsafe-allow-secrets and lose the protection
 * entirely. So there are as many "leaves this alone" tests as "catches this" ones.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAllowlist } from '../src/allowlist.ts';
import { ForgeClient } from '../src/client.ts';
import type { Config } from '../src/config.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { scrubText } from '../src/redact.ts';

const withheld = /\[withheld:/;

describe('scrubText catches credential shapes', () => {
  const cases: [string, string, RegExp][] = [
    ['env assignment', 'DB_PASSWORD=s3cr3t-value', /s3cr3t/],
    ['quoted env assignment', 'APP_KEY="base64:abcdEFGH1234=="', /abcdEFGH/],
    ['colon form', 'API_KEY: live_abcdef123456', /live_abcdef/],
    ['lowercase key name', 'db_password=hunter2hunter2', /hunter2/],
    ['bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', /eyJhbGci/],
    ['token in URL', 'curl https://example.test/hook?token=abcdef1234567890', /abcdef1234567890/],
    ['aws access key', 'aws_access_key_id AKIAIOSFODNN7EXAMPLE', /AKIAIOSFODNN7EXAMPLE/],
    [
      'basic auth in URL',
      'Cloning https://deploy-user:sup3rs3cret@github.com/acme/app.git',
      /sup3rs3cret/,
    ],
    [
      'forge deploy trigger',
      'curl https://forge.laravel.com/servers/1/sites/2/deploy/http?token=Zx9QwErTyUiOp123',
      /Zx9QwErTyUiOp123/,
    ],
  ];

  for (const [name, input, secret] of cases) {
    it(`redacts a ${name}`, () => {
      const result = scrubText(input);
      assert.ok(!secret.test(result), `secret survived: ${result}`);
      assert.match(result, withheld);
    });
  }

  it('redacts a whole private key block', () => {
    const input = [
      'Writing deploy key',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
      'AAAAMwAAAAtzc2gtZWQyNTUxOQAAACBhbGlj',
      '-----END OPENSSH PRIVATE KEY-----',
      'Done',
    ].join('\n');
    const result = scrubText(input);
    assert.ok(!result.includes('b3BlbnNzaC1rZXk'), 'key body survived');
    assert.match(result, /Writing deploy key/);
    assert.match(result, /Done/);
  });

  it('keeps the key name visible, so the reader knows what was withheld', () => {
    assert.match(scrubText('DB_PASSWORD=hunter2hunter2'), /DB_PASSWORD/);
  });

  it('redacts every occurrence, not just the first', () => {
    const result = scrubText('TOKEN=aaaaaaaaaaaa\nAPI_KEY=bbbbbbbbbbbb\nSECRET=cccccccccccc');
    assert.ok(!/aaaaaaaaaaaa|bbbbbbbbbbbb|cccccccccccc/.test(result), result);
  });
});

describe('scrubText leaves ordinary log output intact', () => {
  const untouched = [
    '[2026-07-28 09:14:22] production.ERROR: Undefined variable $order',
    '#12 /home/forge/site/vendor/laravel/framework/src/Illuminate/Routing/Route.php(260)',
    'Installing dependencies from lock file',
    '  - Downloading laravel/framework (v11.9.2)',
    'npm WARN deprecated request@2.88.2: request has been deprecated',
    'GET /checkout HTTP/1.1" 200 15243 "-" "Mozilla/5.0"',
    'Nothing to migrate.',
    'APP_ENV=production',
    'CACHE_DRIVER=redis',
    'Deployment finished in 43s',
    'error: cannot lock ref refs/heads/main',
    'https://example.test/products?page=2&sort=price',
  ];

  for (const line of untouched) {
    it(`leaves alone: ${line.slice(0, 48)}`, () => {
      assert.equal(scrubText(line), line);
    });
  }

  it('does not touch a short non-secret query parameter', () => {
    // The token patterns require 8+ chars, so ?key=abc must survive.
    assert.equal(scrubText('/search?key=abc'), '/search?key=abc');
  });

  it('is idempotent — scrubbing twice changes nothing further', () => {
    const once = scrubText('DB_PASSWORD=hunter2hunter2');
    assert.equal(scrubText(once), once);
  });
});

describe('the client scrubs log text on the way out', () => {
  const base: Config = {
    apiToken: 't',
    baseUrl: 'https://forge.example.test/api',
    organization: 'acme',
    allowSecrets: false,
    requestsPerMinute: 60,
  };

  const LOG_BODY = {
    data: {
      id: '1',
      type: 'deploymentOutputs',
      attributes: {
        output: 'Deploying...\nDB_PASSWORD=verysecretvalue\nAuthorization: Bearer abcdefgh12345678\nDone',
      },
    },
  };

  function clientFor(config: Config, body: unknown = LOG_BODY) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      })) as unknown as typeof fetch;
    return new ForgeClient(
      config,
      buildAllowlist(config.allowSecrets),
      fetchImpl,
      new RateLimiter({ requestsPerMinute: 1000, sleep: async () => undefined }),
    );
  }

  it('scrubs the `output` field of a deployment log', async () => {
    const result = await clientFor(base).get({
      path: '/orgs/acme/servers/1/sites/2/deployments/3/log',
    });
    const body = JSON.stringify(result);
    assert.ok(!body.includes('verysecretvalue'));
    assert.ok(!body.includes('abcdefgh12345678'));
    assert.match(body, /Deploying/);
  });

  it('scrubs via forge_get too, not just the named log tools', async () => {
    // The reason scrubbing lives in the client rather than the tool handlers.
    const result = await clientFor(base).get({ path: '/orgs/acme/servers/1/sites/2/commands/9/output' });
    assert.ok(!JSON.stringify(result).includes('verysecretvalue'));
  });

  it('scrubs the `content` field site logs use', async () => {
    const siteLog = {
      data: { type: 'applicationLogs', attributes: { content: 'APP_KEY=base64:leakedleaked==' } },
    };
    const result = await clientFor(base, siteLog).get({
      path: '/orgs/acme/servers/1/sites/2/logs/application',
    });
    assert.ok(!JSON.stringify(result).includes('leakedleaked'));
  });

  it('scrubs a plain-text body as well', async () => {
    const fetchImpl = (async () =>
      new Response('DB_PASSWORD=plaintextsecret', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof fetch;
    const client = new ForgeClient(
      base,
      buildAllowlist(false),
      fetchImpl,
      new RateLimiter({ requestsPerMinute: 1000, sleep: async () => undefined }),
    );
    const result = await client.get({ path: '/orgs/acme/servers/1/sites/2/logs/application' });
    assert.ok(!String(result).includes('plaintextsecret'));
  });

  it('passes secrets through only under --unsafe-allow-secrets', async () => {
    const result = await clientFor({ ...base, allowSecrets: true }).get({
      path: '/orgs/acme/servers/1/sites/2/deployments/3/log',
    });
    assert.ok(JSON.stringify(result).includes('verysecretvalue'));
  });
});

/**
 * The allowlist is a security boundary, so these tests are adversarial: they try
 * to reach a withheld endpoint by traversal, by percent-encoding, by smuggling a
 * slash through a path parameter, and by prefix matching.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAllowlist, EXCLUSIONS, matchPath } from '../src/allowlist.ts';
import { FORGE_GET_PATHS } from '../src/generated/forge-get-paths.ts';

const allowlist = buildAllowlist(false);
const permissive = buildAllowlist(true);

const ORG = '/orgs/acme';

describe('generated spec table', () => {
  it('has the full published GET surface', () => {
    assert.equal(FORGE_GET_PATHS.length, 133);
  });

  it('contains no non-GET-looking duplicates', () => {
    const seen = new Set(FORGE_GET_PATHS.map((p) => p.path));
    assert.equal(seen.size, FORGE_GET_PATHS.length);
  });

  it('records a scope for the reads Forge gates behind manage permissions', () => {
    const byPath = new Map(FORGE_GET_PATHS.map((p) => [p.path, p.scope]));
    assert.equal(
      byPath.get('/orgs/{organization}/servers/{server}/sites/{site}/certificates'),
      'site:meta',
    );
    assert.equal(
      byPath.get('/orgs/{organization}/servers/{server}/sites/{site}/logs/application'),
      'server:manage-logs',
    );
    assert.equal(
      byPath.get('/orgs/{organization}/servers/{server}/sites/{site}/deployments/{deployment}/log'),
      'site:manage-deploys',
    );
  });
});

describe('exclusions', () => {
  it('still correspond to paths Forge publishes', () => {
    // If Forge renames one of these, the exclusion protects nothing. buildAllowlist
    // throws on that, and this test is the early warning.
    const known = new Set(FORGE_GET_PATHS.map((p) => p.path));
    for (const exclusion of EXCLUSIONS) {
      assert.ok(known.has(exclusion.path), `exclusion no longer in spec: ${exclusion.path}`);
    }
  });

  it('withholds 13 paths by default', () => {
    assert.equal(EXCLUSIONS.length, 13);
    assert.equal(allowlist.paths.length, FORGE_GET_PATHS.length - 13);
  });

  it('refuses the .env read and says why', () => {
    const result = matchPath(allowlist, `${ORG}/servers/1/sites/2/environment`);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /\.env/);
    assert.match(result.ok ? '' : result.reason, /secret/i);
  });

  it('refuses the deploy-hook read as a write capability, not merely a secret', () => {
    const result = matchPath(allowlist, `${ORG}/servers/1/sites/2/deployments/deploy-hook`);
    assert.equal(result.ok, false);
    const reason = result.ok ? '' : result.reason;
    assert.match(reason, /trigger/i);
    assert.match(reason, /write capability/i);
  });

  it('refuses every excluded path', () => {
    const concrete = (template: string) =>
      template.replace(/\{[^}]+\}/g, (m) => (m === '{organization}' ? 'acme' : '123'));
    for (const exclusion of EXCLUSIONS) {
      const result = matchPath(allowlist, concrete(exclusion.path));
      assert.equal(result.ok, false, `should be refused: ${exclusion.path}`);
    }
  });

  it('is not shadowed by a same-arity allowlisted template', () => {
    // Regression: `.../deployments/deploy-hook` has the same segment count as the
    // allowed `.../deployments/{deployment}`, whose placeholder matches the literal
    // "deploy-hook". An earlier version checked allowances before denials and so
    // served the deploy trigger URL through what looked like a deployment fetch.
    // Denials must win over every allowance.
    const result = matchPath(allowlist, `${ORG}/servers/1/sites/2/deployments/deploy-hook`);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /write capability/i);

    // The general template it collides with must still work for a real id.
    assert.equal(matchPath(allowlist, `${ORG}/servers/1/sites/2/deployments/4242`).ok, true);
  });

  it('folds them back in only under --unsafe-allow-secrets', () => {
    assert.equal(permissive.paths.length, FORGE_GET_PATHS.length);
    const result = matchPath(permissive, `${ORG}/servers/1/sites/2/environment`);
    assert.equal(result.ok, true);
  });
});

describe('matchPath accepts real reads', () => {
  const allowed = [
    '/orgs',
    '/sites',
    `${ORG}/servers`,
    `${ORG}/servers/12345`,
    `${ORG}/servers/12345/sites`,
    `${ORG}/sites/678`,
    `${ORG}/servers/1/sites/2/deployments`,
    `${ORG}/servers/1/sites/2/deployments/99`,
    `${ORG}/servers/1/sites/2/logs/nginx-error`,
    `${ORG}/servers/1/sites/2/integrations/horizon`,
    `${ORG}/servers/1/database/schemas`,
    '/providers/digitalocean/regions',
  ];

  for (const path of allowed) {
    it(`allows ${path}`, () => {
      assert.equal(matchPath(allowlist, path).ok, true);
    });
  }

  it('reports the scope a matched path needs', () => {
    const result = matchPath(allowlist, `${ORG}/servers/1/sites/2/certificates`);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.matched.scope : null, 'site:meta');
  });

  it('keeps scope-gated but non-excluded reads available, to 403 honestly', () => {
    // Nginx config and firewall rules need manage scopes. The package still offers
    // them; a read-only token simply gets a 403 that names the scope. Removing them
    // would be the package deciding an operator's scope policy for them.
    assert.equal(matchPath(allowlist, `${ORG}/servers/1/sites/2/nginx`).ok, true);
    assert.equal(matchPath(allowlist, `${ORG}/servers/1/firewall-rules`).ok, true);
  });
});

describe('matchPath rejects hostile input', () => {
  const rejected: [string, RegExp][] = [
    ['', /empty/],
    ['orgs/acme/servers', /must start with/],
    [`${ORG}/servers?page=1`, /query string/],
    [`${ORG}/servers#frag`, /fragment|query string/],
    [`${ORG}//servers`, /empty segment/],
    [`${ORG}/../secrets`, /traversal/],
    [`${ORG}/./servers`, /traversal/],
    [`${ORG}/%2e%2e/servers`, /traversal/],
    [`${ORG}/%2E%2E/servers`, /traversal/],
    [`${ORG}/servers/1%2Fsites`, /slash/],
    [`${ORG}/servers/1%5Csites`, /slash/],
    [`${ORG}/servers/%ZZ`, /percent-encoding/],
    ['/not/a/forge/endpoint', /not an allowlisted/],
    ['/orgs/acme/servers/1/extra/segments/here', /not an allowlisted/],
  ];

  for (const [path, pattern] of rejected) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      const result = matchPath(allowlist, path);
      assert.equal(result.ok, false, `expected rejection for ${path}`);
      assert.match(result.ok ? '' : result.reason, pattern);
    });
  }

  it('does not prefix-match a longer allowlisted path', () => {
    // /orgs/{organization}/servers/{server} is allowed; a deeper unknown path
    // beneath it must not inherit that permission.
    assert.equal(matchPath(allowlist, `${ORG}/servers/1/anything`).ok, false);
  });

  it('does not let a placeholder swallow multiple segments', () => {
    // /orgs/{organization} is a real endpoint. "acme/servers/1/sites/2/environment"
    // as a single parameter must not collapse into it.
    assert.equal(matchPath(allowlist, '/orgs/acme/servers/1/sites/2/environment').ok, false);
  });
});

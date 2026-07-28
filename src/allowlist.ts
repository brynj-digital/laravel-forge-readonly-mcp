/**
 * The read allowlist: which Forge paths this server will ever request.
 *
 * Two independent guards make this server read-only. The HTTP client can only
 * issue GET (src/client.ts hard-codes the verb — it is not a parameter anywhere),
 * and every path is matched against the templates below before a request is
 * built. This module is the second guard, and it is what makes the generic
 * `forge_get` tool safe to expose: the model chooses a path, but only a path the
 * allowlist already contains.
 *
 * The candidate set is GENERATED from Forge's OpenAPI spec
 * (src/generated/forge-get-paths.ts), so it cannot drift from reality by a typo.
 * What this file adds is the judgement the spec cannot express: 13 of those GETs
 * must not be exposed to a language model at all.
 *
 * ## Why some GETs are excluded
 *
 * "Read-only" is not the same as "safe to read". Two distinct problems:
 *
 *  1. Secrets. `GET .../sites/{site}/environment` is documented by Forge as "Get
 *     .env content" — database passwords, APP_KEY, every third-party API key the
 *     app holds. Same for Composer/npm registry credentials, cloud-provider
 *     credentials and SSH/deploy key material. Reading these would route the
 *     secret through the model and into transcripts and logs.
 *
 *  2. A read that leaks a WRITE. `GET .../deployments/deploy-hook` returns, in
 *     Forge's words, "the deployment trigger URL" — a URL that triggers a deploy
 *     with no further authentication. Handing that string to a model defeats the
 *     entire point of a read-only server, no matter that the verb was GET. This
 *     is the case worth remembering: verb-level reasoning is not sufficient.
 *
 * Both categories can be unlocked with --unsafe-allow-secrets, off by default and
 * named to be hard to enable by accident. Nothing here is a judgement about your
 * infrastructure; it is a judgement about what belongs in a model's context.
 */
import { FORGE_GET_PATHS } from './generated/forge-get-paths.js';

/** A path excluded from the default allowlist, with the reason surfaced to callers. */
export interface Exclusion {
  readonly path: string;
  readonly reason: string;
  readonly kind: 'secret' | 'write-capability';
}

/**
 * The 13 GETs withheld by default.
 *
 * Every entry is asserted to exist in the generated spec paths at construction
 * time (see buildAllowlist) — so if Forge renames one of these, this server fails
 * loudly at startup instead of silently un-excluding a secret.
 */
export const EXCLUSIONS: readonly Exclusion[] = [
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/environment',
    kind: 'secret',
    reason: "the site's .env file — database passwords, APP_KEY, third-party API keys",
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/deployments/deploy-hook',
    kind: 'write-capability',
    reason:
      'the deployment trigger URL — an unauthenticated deploy capability, so reading it would hand out the ability to deploy',
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/composer/credentials',
    kind: 'secret',
    reason: 'private Composer registry credentials',
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/composer/credentials/{repository}',
    kind: 'secret',
    reason: 'private Composer registry credentials',
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/npm/credentials',
    kind: 'secret',
    reason: 'private npm registry credentials',
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/npm/credentials/{registry}',
    kind: 'secret',
    reason: 'private npm registry credentials',
  },
  {
    path: '/orgs/{organization}/server-credentials',
    kind: 'secret',
    reason: 'cloud provider API credentials',
  },
  {
    path: '/orgs/{organization}/server-credentials/{credential}',
    kind: 'secret',
    reason: 'cloud provider API credentials',
  },
  {
    path: '/orgs/{organization}/teams/{team}/server-credentials',
    kind: 'secret',
    reason: 'cloud provider API credentials',
  },
  {
    path: '/orgs/{organization}/servers/{server}/ssh-keys',
    kind: 'secret',
    reason: 'SSH key material',
  },
  {
    path: '/orgs/{organization}/servers/{server}/ssh-keys/{key}',
    kind: 'secret',
    reason: 'SSH key material',
  },
  {
    path: '/orgs/{organization}/servers/{server}/key',
    kind: 'secret',
    reason: 'SSH key material',
  },
  {
    path: '/orgs/{organization}/servers/{server}/sites/{site}/deploy-key',
    kind: 'secret',
    reason: 'deploy key material',
  },
];

export interface AllowedPath {
  readonly template: string;
  readonly segments: readonly string[];
  readonly scope: string | null;
  readonly operationId: string;
}

export interface Allowlist {
  readonly paths: readonly AllowedPath[];
  /** Excluded paths, kept so a rejection can explain itself precisely. */
  readonly excluded: readonly Exclusion[];
}

function split(template: string): string[] {
  return template.split('/').filter((s) => s.length > 0);
}

/**
 * Build the allowlist.
 *
 * @param allowSecrets when true, the exclusions are folded back in (the
 *   --unsafe-allow-secrets escape hatch).
 * @throws if an exclusion no longer matches any path Forge publishes, which
 *   would mean the exclusion has quietly stopped protecting anything.
 */
export function buildAllowlist(allowSecrets = false): Allowlist {
  const known = new Set(FORGE_GET_PATHS.map((p) => p.path));
  const stale = EXCLUSIONS.filter((e) => !known.has(e.path)).map((e) => e.path);
  if (stale.length > 0) {
    throw new Error(
      `Exclusion list is stale — these paths are no longer in Forge's spec, so they are ` +
        `protecting nothing:\n  ${stale.join('\n  ')}\n` +
        'Re-run `npm run generate:paths` and reconcile src/allowlist.ts.',
    );
  }

  const excludedPaths = new Set(EXCLUSIONS.map((e) => e.path));
  const paths = FORGE_GET_PATHS.filter(
    (p) => allowSecrets || !excludedPaths.has(p.path),
  ).map<AllowedPath>((p) => ({
    template: p.path,
    segments: split(p.path),
    scope: p.scope,
    operationId: p.operationId,
  }));

  return { paths, excluded: allowSecrets ? [] : EXCLUSIONS };
}

export type MatchResult =
  | { ok: true; matched: AllowedPath }
  | { ok: false; reason: string };

const TRAVERSAL = new Set(['.', '..']);

/**
 * Does a concrete path's segments match a template's?
 *
 * Arity must be equal (a template is one endpoint, not a subtree) and a
 * `{placeholder}` matches exactly one segment.
 */
function matchesTemplate(template: readonly string[], segments: readonly string[]): boolean {
  if (template.length !== segments.length) return false;
  return template.every((templateSegment, i) => {
    const isPlaceholder = templateSegment.startsWith('{') && templateSegment.endsWith('}');
    return isPlaceholder ? true : templateSegment === segments[i];
  });
}

/**
 * Does `path` match an allowlisted template?
 *
 * Deliberately strict, because this is a security boundary and not a router:
 *
 *  - the path must be absolute and carry no query string or fragment (query
 *    arrives as a separate, separately-validated argument)
 *  - no empty, `.` or `..` segments, before OR after percent-decoding, so
 *    `%2e%2e` cannot smuggle a traversal past us
 *  - a `{param}` placeholder matches exactly one non-empty segment — never a
 *    slash, so one parameter cannot span path boundaries and reach a different
 *    endpoint
 *  - segment counts must be equal; no prefix matching, since a template is a
 *    whole endpoint rather than a subtree
 */
export function matchPath(allowlist: Allowlist, path: string): MatchResult {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'path is empty' };
  if (!path.startsWith('/')) return { ok: false, reason: 'path must start with "/"' };
  if (path.includes('?') || path.includes('#')) {
    return {
      ok: false,
      reason: 'path must not contain a query string or fragment — pass query parameters separately',
    };
  }
  if (path.includes('//')) return { ok: false, reason: 'path contains an empty segment' };

  const raw = path.split('/').filter((s, i, arr) => !(s === '' && i === arr.length - 1));
  const segments = raw.slice(1);
  if (segments.length === 0) return { ok: false, reason: 'path has no segments' };

  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'path contains an empty segment' };
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { ok: false, reason: `segment "${segment}" is not valid percent-encoding` };
    }
    if (TRAVERSAL.has(segment) || TRAVERSAL.has(decoded)) {
      return { ok: false, reason: 'path traversal segments ("." / "..") are not allowed' };
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      return { ok: false, reason: `segment "${segment}" decodes to something containing a slash` };
    }
  }

  // Denials are checked FIRST, and this ordering is load-bearing rather than
  // stylistic. Exclusions are literal paths, but the allowlist contains templates
  // with placeholders of the same arity that would happily swallow them —
  // `.../deployments/deploy-hook` matches `.../deployments/{deployment}`, so
  // checking allowances first would hand out the deploy trigger URL via a tool
  // that looks like it is fetching a deployment. In a deny-by-default boundary an
  // exclusion must win over every allowance, unconditionally.
  const excluded = allowlist.excluded.find((e) => matchesTemplate(split(e.path), segments));
  if (excluded) {
    return {
      ok: false,
      reason:
        `${path} is a read this server deliberately withholds: ${excluded.reason}. ` +
        (excluded.kind === 'write-capability'
          ? 'Exposing it would grant a write capability, which defeats the purpose of a read-only server.'
          : 'Exposing it would route a secret through the model.') +
        ' It can be enabled with --unsafe-allow-secrets, but consider whether you want that in a transcript.',
    };
  }

  for (const candidate of allowlist.paths) {
    if (matchesTemplate(candidate.segments, segments)) return { ok: true, matched: candidate };
  }

  return {
    ok: false,
    reason:
      `${path} is not an allowlisted Forge read. Only GET endpoints from Forge's API are ` +
      'available, and paths must match a documented template exactly ' +
      '(e.g. /orgs/{organization}/servers/{server}/sites). Check the path, or use one of the ' +
      'named tools instead of forge_get.',
  };
}

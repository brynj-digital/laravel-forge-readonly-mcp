/**
 * Response field redaction — the second half of the read-only boundary.
 *
 * ## Why a path allowlist is not enough
 *
 * src/allowlist.ts decides WHICH endpoints may be called. That is necessary but
 * insufficient, and this module exists because a live probe proved it:
 *
 * `/orgs/{org}/servers/{server}/sites/{site}/deployments/deploy-hook` is excluded
 * precisely because it returns a deploy trigger URL — a URL that starts a
 * production deploy with no authentication. But `GET /orgs/{org}/sites/{site}` and
 * `GET /orgs/{org}/servers/{server}/sites`, both perfectly ordinary reads that
 * this server exposes as `get_site` and `list_sites`, return that same URL inline
 * as `attributes.deployment_url`:
 *
 *     "deployment_url": "https://forge.laravel.com/servers/1/sites/2/deploy/http?token=..."
 *
 * So the endpoint-level exclusion was being routed around by two of the most
 * commonly used tools in the package. Withholding an endpoint means nothing if the
 * capability it guards is duplicated into a payload you serve.
 *
 * The lesson generalises: for a read-only surface over someone else's API, the
 * unit of danger is a FIELD, not an endpoint. Fields travel.
 */

export interface RedactedField {
  /** Exact JSON key, matched at any depth. */
  readonly field: string;
  /** Why it is withheld — substituted into the response so it never looks like a bug. */
  readonly reason: string;
}

export const REDACTED_FIELDS: readonly RedactedField[] = [
  {
    field: 'deployment_url',
    reason:
      'deploy trigger URL — an unauthenticated capability to deploy the site, not a read',
  },
];

const BY_FIELD = new Map(REDACTED_FIELDS.map((f) => [f.field, f]));

/**
 * Marker prefix, so a redacted value is distinguishable from a real one.
 *
 * Without this, `containsRedactableField` cannot tell "this field is populated"
 * from "this field is populated with our own replacement text", and redaction
 * becomes unverifiable — which is how the first version of this module passed its
 * own tests while proving nothing.
 */
export const REDACTION_PREFIX = '[withheld:';

function marker(reason: string): string {
  return `${REDACTION_PREFIX} ${reason}]`;
}

function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(REDACTION_PREFIX);
}

function isPopulated(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Recursively replace redacted field values with an explanatory marker.
 *
 * Structure is preserved (the key stays, so a caller can see something was
 * withheld and why) and everything else is passed through untouched.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const rule = BY_FIELD.get(key);
    // Only redact a populated value: a null deployment_url means quick-deploy is
    // off, which is a useful fact and not a leak.
    if (rule && isPopulated(nested) && !isRedacted(nested)) {
      out[key] = marker(rule.reason);
      continue;
    }
    out[key] = redact(nested);
  }
  return out;
}

/**
 * Does this payload still carry an UNREDACTED sensitive field?
 *
 * Deliberately not "does a redacted key exist" — after redaction the key is still
 * there, holding our marker. This answers the only question worth asking: did
 * anything real get through?
 */
export function containsRedactableField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRedactableField);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      (BY_FIELD.has(key) && isPopulated(nested) && !isRedacted(nested)) ||
      containsRedactableField(nested),
  );
}

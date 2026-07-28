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
 *
 * ## And once more, in unstructured text
 *
 * The same lesson recurs a layer down. This server withholds
 * `.../sites/{site}/environment` specifically to keep `.env` out of model
 * context — but a deployment log is the output of a deploy script that may echo
 * environment variables, composer auth tokens appear in build output, and
 * command-history output will happily replay whatever a human chose to run,
 * including `cat .env`. Field-level redaction cannot help there, because the
 * secret is inside a blob of text rather than in a field of its own.
 *
 * So text fields (`content`, `output`) additionally go through `scrubText`. This
 * is explicitly BEST-EFFORT and must not be described as a guarantee: pattern
 * matching over arbitrary log output cannot be complete. It raises the cost of an
 * accident; it does not make logs safe to treat as public.
 */
import { TEXT_FIELDS } from './output.js';

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
 * Credential shapes scrubbed from log/command output.
 *
 * Deliberately high-confidence only. A greedy pattern that mangles ordinary log
 * lines would push people to `--unsafe-allow-secrets` wholesale, which is a worse
 * outcome than a narrow scrubber — so each entry here targets a shape that is
 * almost never anything but a secret.
 */
/**
 * Each pattern carries its OWN replacer.
 *
 * An earlier version inferred the replacement from capture-group position, which
 * was wrong in both directions: for the AWS pattern the capture group IS the
 * secret, so "preserve capture 1, redact the rest" preserved the key it was meant
 * to remove. Explicit replacers per pattern are longer and correct.
 *
 * Every replacer must also be IDEMPOTENT — scrubbed text gets re-scrubbed when a
 * response passes through more than once, and a value pattern like `[^\s]+`
 * happily matches our own `[withheld: …]` marker, nesting markers inside markers.
 */
interface SecretPattern {
  readonly label: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/** Has this value already been redacted? Guards idempotency. */
const done = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trimStart().startsWith(REDACTION_PREFIX);

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    // KEY=value / SECRET: value / PASSWORD="value" — the .env and CI-echo shape.
    // Keeps the key name, which is useful context, and drops the value.
    label: 'credential assignment',
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|APP_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s;,\n]+)/gi,
    replace: (match, key, separator, value) =>
      done(value) ? match : `${key}${separator}${marker('credential assignment')}`,
  },
  {
    label: 'bearer token',
    pattern: /\b(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (match, header, token) => (done(token) ? match : `${header}${marker('bearer token')}`),
  },
  {
    label: 'token in URL',
    pattern: /([?&](?:token|api_key|access_token|key)=)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (match, prefix, token) => (done(token) ? match : `${prefix}${marker('token in URL')}`),
  },
  {
    // Here the match itself is the secret, so it goes entirely.
    label: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,
    replace: () => marker('AWS access key id'),
  },
  {
    label: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => marker('private key block'),
  },
  {
    // Basic-auth credentials embedded in a URL, as composer/npm registries do.
    label: 'credentials in URL',
    pattern: /\b(https?:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi,
    replace: (match, prefix, password) =>
      done(password) ? match : `${prefix}:${marker('credentials in URL')}@`,
  },
];

/**
 * Best-effort removal of credential-shaped substrings from log/command output.
 *
 * Preserves surrounding structure — the key name, the header name, the URL host —
 * so the line still reads as a log line and the reader can see what was withheld.
 *
 * BEST-EFFORT, and deliberately narrow: a greedy scrubber that mangled ordinary
 * log lines would push people to `--unsafe-allow-secrets` wholesale, which loses
 * far more than it gains.
 */
export function scrubText(text: string): string {
  let result = text;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    result = result.replace(pattern, replace as (...args: unknown[]) => string);
  }
  return result;
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
    // Log/command output: scrub credential shapes out of the text itself. Runs
    // here, in the client's response path, rather than in the tool handlers — so
    // it covers `forge_get` reaching a log endpoint directly, not just the named
    // log tools.
    if (TEXT_FIELDS.includes(key) && typeof nested === 'string') {
      out[key] = scrubText(nested);
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

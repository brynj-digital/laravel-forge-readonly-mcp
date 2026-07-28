/**
 * The Forge HTTP client. GET only — the verb is a literal here and is not
 * threaded through from anywhere, so no tool, argument or config value can turn a
 * read into a write.
 *
 * Every request passes through the allowlist first (src/allowlist.ts), so a path
 * this client sends is one Forge documents as a GET and this package has reviewed.
 */
import { type Allowlist, matchPath } from './allowlist.js';
import type { Config } from './config.js';
import { RateLimiter } from './rate-limit.js';
import { redact } from './redact.js';

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

/** Primitive query values; arrays become repeated keys. */
export type QueryValue = string | number | boolean | readonly (string | number)[];

export interface RequestOptions {
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue | undefined>>;
  /**
   * Drop `links` from paginated envelopes. Forge returns both `meta.next_cursor`
   * and a `links` object of fully-qualified URLs saying the same thing; the URLs
   * are pure token cost in a model's context, and worse, they invite a caller to
   * treat them as fetchable when only the cursor is.
   */
  readonly trimLinks?: boolean;
}

const MAX_RETRIES = 2;

export class ForgeClient {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly config: Config,
    private readonly allowlist: Allowlist,
    private readonly fetchImpl: typeof fetch = fetch,
    limiter?: RateLimiter,
  ) {
    this.limiter = limiter ?? new RateLimiter({ requestsPerMinute: config.requestsPerMinute });
  }

  /**
   * Fill a path template with parameters, percent-encoding each one.
   *
   * Encoding here rather than at the call sites is deliberate: a slug containing a
   * slash would otherwise silently retarget the request at a different endpoint,
   * and the allowlist match happens after this, on the built path.
   */
  static buildPath(template: string, params: Readonly<Record<string, string | number>>): string {
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params[name];
      if (value === undefined || value === null || String(value).length === 0) {
        throw new ForgeError(`missing path parameter "${name}" for ${template}`);
      }
      return encodeURIComponent(String(value));
    });
  }

  async get<T = unknown>(options: RequestOptions): Promise<T> {
    const match = matchPath(this.allowlist, options.path);
    if (!match.ok) throw new ForgeError(match.reason, null);

    const url = new URL(this.config.baseUrl + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    let lastError: ForgeError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await this.limiter.acquire();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.config.apiToken}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': 'laravel-forge-readonly-mcp',
          },
        });
      } catch (cause) {
        lastError = new ForgeError(
          `network error calling Forge: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        if (attempt === MAX_RETRIES) throw lastError;
        await this.limiter.wait(Math.min(4000, 500 * 2 ** attempt));
        continue;
      }

      this.limiter.observeHeaders(response.headers);

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new ForgeError(
            "Forge rate limit reached (60 requests/minute per token) and retries were exhausted. " +
              'Narrow the request — a smaller page[size], or one site instead of all of them.',
            429,
          );
        }
        await this.limiter.wait(this.limiter.retryDelayMs(response.headers, attempt));
        continue;
      }

      if (response.status >= 500) {
        lastError = new ForgeError(`Forge returned ${response.status} for ${options.path}`, response.status);
        if (attempt === MAX_RETRIES) throw lastError;
        await this.limiter.wait(Math.min(4000, 500 * 2 ** attempt));
        continue;
      }

      if (!response.ok) throw await this.describeFailure(response, options.path, match.matched.scope);

      const text = await response.text();
      if (text.trim().length === 0) return undefined as T;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A few endpoints (logs, deployment output) return plain text.
        return text as T;
      }
      const trimmed = options.trimLinks === false ? parsed : trimLinks(parsed);
      // Field-level redaction runs on EVERY response, including forge_get's.
      // Withholding the deploy-hook endpoint is worthless while ordinary site
      // reads carry the same trigger URL inline — see src/redact.ts.
      return (this.config.allowSecrets ? trimmed : redact(trimmed)) as T;
    }

    throw lastError ?? new ForgeError(`request to ${options.path} failed`);
  }

  /**
   * Turn a failure into something actionable.
   *
   * The 403 branch is the one that earns its keep: Forge's scope model gates some
   * *reads* behind `manage` scopes, so a perfectly valid read can 403 purely
   * because the token was minted read-only on purpose. Naming the scope turns a
   * dead end into a decision the operator can make.
   */
  private async describeFailure(
    response: Response,
    path: string,
    scope: string | null,
  ): Promise<ForgeError> {
    const body = await response.text().catch(() => '');
    const detail = body.trim().length > 0 ? ` Response: ${body.slice(0, 400)}` : '';

    if (response.status === 401) {
      return new ForgeError(
        'Forge rejected the API token (401). It may be revoked, expired or mistyped.' + detail,
        401,
      );
    }
    if (response.status === 403) {
      const hint = scope
        ? `This endpoint requires the "${scope}" scope, which your token does not have. ` +
          (scope.includes(':view')
            ? 'Add it when creating a token in the Forge dashboard.'
            : `Note that "${scope}" also grants the matching write permissions — this package ` +
              'deliberately does not require you to hold it, and will simply not serve this read ' +
              'if you would rather keep the token read-only.')
        : 'Your token lacks permission for this endpoint.';
      return new ForgeError(`Forge denied access to ${path} (403). ${hint}${detail}`, 403);
    }
    if (response.status === 404) {
      return new ForgeError(
        `Forge returned 404 for ${path}. This can mean three different things: the resource ` +
          'does not exist, your token cannot see the organisation it belongs to, or the feature ' +
          'is not installed on that server — a server with no database returns 404 for the ' +
          'database endpoints rather than an empty list.' +
          detail,
        404,
      );
    }
    if (response.status === 422) {
      return new ForgeError(`Forge rejected the query parameters for ${path} (422).${detail}`, 422);
    }
    return new ForgeError(`Forge returned ${response.status} for ${path}.${detail}`, response.status);
  }
}

/** Strip the redundant `links` envelope, keeping `meta` (which holds the cursors). */
function trimLinks(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('links' in record) || !('meta' in record)) return value;
  const { links: _links, ...rest } = record;
  return rest;
}

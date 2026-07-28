/**
 * Shared helpers for reading Forge's OpenAPI spec. Used by generate-paths.ts and
 * check-drift.ts so both agree on exactly what "a GET operation" means.
 */

export const SPEC_URL = 'https://forge.laravel.com/api/docs.openapi';

export interface Spec {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
}

export interface ExtractedPath {
  path: string;
  scope: string | null;
  operationId: string;
}

/**
 * Fetch the spec, or read a local copy when FORGE_SPEC_FILE is set (offline dev
 * and hermetic tests).
 */
export async function fetchSpec(): Promise<Spec> {
  const local = process.env.FORGE_SPEC_FILE;
  if (local) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(local, 'utf8')) as Spec;
  }
  const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${SPEC_URL} → ${res.status} ${res.statusText}`);
  return (await res.json()) as Spec;
}

/**
 * Pull the single scope each operation requires.
 *
 * Forge models this as `security: [{ oauth2: ["scope"] }]`. Every operation in
 * the spec today lists at most one scope; if that ever changes we throw rather
 * than silently keep the first, because "which scope does this need" feeds both
 * the README's scope table and the 403 hint.
 */
function scopeOf(op: Record<string, unknown>, path: string, method: string): string | null {
  const security = op.security;
  if (!Array.isArray(security) || security.length === 0) return null;
  const scopes = security.flatMap((entry) =>
    entry && typeof entry === 'object' ? Object.values(entry as Record<string, unknown>).flat() : [],
  );
  const named = scopes.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (named.length === 0) return null;
  const unique = [...new Set(named)];
  if (unique.length > 1) {
    throw new Error(
      `${method.toUpperCase()} ${path} requires multiple scopes (${unique.join(', ')}); ` +
        'the single-scope assumption in spec.ts no longer holds — update it.',
    );
  }
  return unique[0] ?? null;
}

/** Every GET operation in the spec, sorted by path for a stable generated file. */
export function extractGetPaths(spec: Spec): ExtractedPath[] {
  const out: ExtractedPath[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const op = item?.get;
    if (!op || typeof op !== 'object') continue;
    const record = op as Record<string, unknown>;
    out.push({
      path,
      scope: scopeOf(record, path, 'get'),
      operationId: typeof record.operationId === 'string' ? record.operationId : '',
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every non-GET operation, so the drift check can assert none leaked into the allowlist. */
export function extractWritePaths(spec: Spec): { path: string; method: string }[] {
  const out: { path: string; method: string }[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (['post', 'put', 'patch', 'delete'].includes(method)) out.push({ path, method });
    }
  }
  return out;
}

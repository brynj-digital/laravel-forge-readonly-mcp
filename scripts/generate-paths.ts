/**
 * Regenerate src/generated/forge-get-paths.ts from Forge's published OpenAPI spec.
 *
 * Why generated and not hand-written: a mistyped path template is silently inert
 * — it never matches, so the tool that uses it 404s forever, or (worse) a
 * mistyped *exclusion* silently stops excluding and a secret endpoint becomes
 * reachable. Deriving both the path list and each path's required scope from the
 * spec removes that whole class of bug.
 *
 * Run:  npm run generate:paths
 * Then: npm run check:drift   (CI runs this against the live spec)
 */
import { writeFile } from 'node:fs/promises';
import { fetchSpec, extractGetPaths, SPEC_URL } from './spec.ts';

const out = new URL('../src/generated/forge-get-paths.ts', import.meta.url);

const spec = await fetchSpec();
const paths = extractGetPaths(spec);

if (paths.length === 0) throw new Error('extracted 0 GET paths — spec shape changed?');

const rows = paths
  .map(
    (p) =>
      `  { path: ${JSON.stringify(p.path)}, scope: ${
        p.scope === null ? 'null' : JSON.stringify(p.scope)
      }, operationId: ${JSON.stringify(p.operationId)} },`,
  )
  .join('\n');

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: ${SPEC_URL}
 * Regenerate: npm run generate:paths
 *
 * Every GET operation Forge publishes, with the OAuth scope it requires
 * (\`null\` = no scope required). This is the raw material for the allowlist in
 * src/allowlist.ts, which then removes the secret-bearing paths; it is also what
 * lets a 403 name the scope the caller is missing instead of just failing.
 *
 * Spec version at generation time: ${String(spec.info?.version ?? 'unknown')}
 * GET operations: ${paths.length}
 */

export interface ForgeGetPath {
  /** Path template relative to the API base, e.g. /orgs/{organization}/servers/{server} */
  readonly path: string;
  /** OAuth scope this GET requires, or null if it requires none. */
  readonly scope: string | null;
  /** Forge's operationId, handy for cross-referencing their docs. */
  readonly operationId: string;
}

export const FORGE_GET_PATHS: readonly ForgeGetPath[] = [
${rows}
];
`;

await writeFile(out, banner, 'utf8');
console.error(`wrote ${paths.length} GET paths to ${out.pathname}`);

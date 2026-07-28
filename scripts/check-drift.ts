/**
 * Fail if this package has drifted from Forge's published API.
 *
 * Forge's API reports itself as version 0.0.1 and is actively changing, so
 * "reconcile against the live spec, never against documentation or memory" is the
 * only way this package stays honest. Four distinct drifts matter:
 *
 *  1. A NEW GET appeared. Harmless but unreviewed — it might be another
 *     `deploy-hook`, a read that hands over a write capability, and it must be
 *     classified before it becomes reachable through forge_get.
 *  2. A GET DISAPPEARED. Any tool pointing at it now 404s forever.
 *  3. An exclusion's path was RENAMED. The worst case: the exclusion silently
 *     stops protecting anything and a secret becomes readable.
 *  4. A path we allow is no longer a GET — it must never be reachable.
 *
 * Run: npm run check:drift   (CI runs it on every PR and weekly)
 */
import { EXCLUSIONS } from '../src/allowlist.ts';
import { FORGE_GET_PATHS } from '../src/generated/forge-get-paths.ts';
import { extractGetPaths, extractWritePaths, fetchSpec, SPEC_URL } from './spec.ts';

const problems: string[] = [];
const notes: string[] = [];

const spec = await fetchSpec();
const live = extractGetPaths(spec);
const livePaths = new Map(live.map((p) => [p.path, p]));
const committed = new Map(FORGE_GET_PATHS.map((p) => [p.path, p]));

for (const path of livePaths.keys()) {
  if (!committed.has(path)) {
    problems.push(
      `NEW GET not yet reviewed: ${path}\n` +
        '    → run `npm run generate:paths`, then decide whether it exposes a secret or a\n' +
        '      write capability (see EXCLUSIONS in src/allowlist.ts) before shipping it.',
    );
  }
}

for (const path of committed.keys()) {
  if (!livePaths.has(path)) {
    problems.push(
      `GET removed upstream: ${path}\n` +
        '    → any tool using it now 404s. Re-generate and drop or repoint the tool.',
    );
  }
}

for (const exclusion of EXCLUSIONS) {
  if (!livePaths.has(exclusion.path)) {
    problems.push(
      `EXCLUSION NO LONGER MATCHES ANYTHING: ${exclusion.path}\n` +
        `    → it was withholding: ${exclusion.reason}\n` +
        '    → Forge has renamed or removed this endpoint. Find its new path and re-exclude it,\n' +
        '      otherwise this protection is silently doing nothing.',
    );
  }
}

// A path that is both a GET and a write in the spec is fine (same path, different
// verbs). What must never happen is this package treating a write-only path as
// readable, which would mean our GET list contains something with no GET at all.
const writeOnly = new Set(
  extractWritePaths(spec)
    .map((w) => w.path)
    .filter((path) => !livePaths.has(path)),
);
for (const path of committed.keys()) {
  if (writeOnly.has(path)) {
    problems.push(`allowlisted path has no GET operation upstream: ${path}`);
  }
}

for (const [path, livePath] of livePaths) {
  const ours = committed.get(path);
  if (ours && ours.scope !== livePath.scope) {
    notes.push(
      `scope changed for ${path}: ${String(ours.scope)} → ${String(livePath.scope)}` +
        ' (re-generate; the README scope table and the 403 hint both read from this)',
    );
  }
}

const excludedCount = EXCLUSIONS.length;
process.stderr.write(
  `spec: ${SPEC_URL}\n` +
    `spec version: ${String(spec.info?.version ?? 'unknown')}\n` +
    `live GETs: ${live.length}   committed: ${FORGE_GET_PATHS.length}   ` +
    `withheld: ${excludedCount}   exposed: ${FORGE_GET_PATHS.length - excludedCount}\n`,
);

if (notes.length > 0) {
  process.stderr.write(`\n${notes.length} scope change(s):\n`);
  for (const note of notes) process.stderr.write(`  - ${note}\n`);
}

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} drift problem(s):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

// Scope changes alone are not a hard failure unless a scope moved from a view
// scope to a manage scope, which would quietly require callers to hold write
// permissions to keep a read working.
const escalated = notes.filter((n) => /→ .*manage|→ .*create|→ .*delete/.test(n));
if (escalated.length > 0) {
  process.stderr.write(
    '\nA read moved behind a write-granting scope. That changes what a read-only token can do,\n' +
      'so it needs a decision (and probably a README update) rather than a silent pass.\n',
  );
  process.exit(1);
}

process.stderr.write('\nno drift\n');

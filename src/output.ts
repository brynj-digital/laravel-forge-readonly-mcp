/**
 * Size control for log and command output.
 *
 * ## Why this is not optional
 *
 * Measured against the live API: one site's application log is **274,503
 * characters over 500 lines** — roughly 69,000 tokens, which a single tool call
 * would drop into the caller's context window. Forge applies no limit and offers
 * no range parameter, so the only place this can be bounded is here.
 *
 * Two limits, because either alone fails:
 *
 *  - **Lines.** Failures are at the END of a log, so we keep the tail, not the
 *    head. A caller asking "why did this deploy fail" wants the last screenful.
 *  - **Characters.** Line counts lie. That 500-line log averages ~550 chars per
 *    line, and a single PHP stack-trace line can run to thousands, so a
 *    200-line tail could still be 100k+ characters. The character cap is the
 *    backstop that actually bounds the payload.
 *
 * Both report what they dropped, so a truncated log never looks like a complete
 * one — silently returning a fragment would be worse than returning too much.
 */

/** Fields Forge returns log/command text in. Site logs use `content`; deployment and job outputs use `output`. */
export const TEXT_FIELDS: readonly string[] = ['content', 'output'];

export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 5_000;
/** ~5k tokens. Applies even when the caller sets no line limit. */
export const DEFAULT_MAX_CHARS = 20_000;

export interface TailOptions {
  /** Keep only the last N lines. Omit to apply no line limit (the char cap still applies). */
  readonly lines?: number | undefined;
  readonly maxChars?: number | undefined;
}

/**
 * Keep the tail of `text`, bounded by lines and/or characters.
 *
 * Prefixes a note whenever anything was dropped. The note goes at the TOP so it
 * survives a caller that itself truncates, and reads as metadata rather than log
 * content.
 */
export function tailText(text: string, options: TailOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const requested = options.lines;
  const notes: string[] = [];

  let result = text;

  if (requested !== undefined) {
    const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_TAIL_LINES);
    const allLines = result.split('\n');
    if (allLines.length > limit) {
      notes.push(
        `${(allLines.length - limit).toLocaleString('en-GB')} earlier lines omitted, showing last ${limit.toLocaleString('en-GB')}`,
      );
      result = allLines.slice(-limit).join('\n');
    }
  }

  if (result.length > maxChars) {
    notes.push(
      `truncated to the last ${maxChars.toLocaleString('en-GB')} characters of ${result.length.toLocaleString('en-GB')}`,
    );
    result = result.slice(-maxChars);
    // Drop a partial first line so the output starts cleanly.
    const firstBreak = result.indexOf('\n');
    if (firstBreak > 0 && firstBreak < 500) result = result.slice(firstBreak + 1);
  }

  if (notes.length === 0) return text;
  return `[${notes.join('; ')}]\n${result}`;
}

/**
 * Forge fetches logs from the server over SSH at request time, so when its access
 * has been revoked the endpoint returns 200 with an SSH error as the "log".
 *
 * That reads as a broken tool rather than a broken server, so name it. The server
 * object carries a `revoked` flag — 8 of R3's 30 servers were revoked when this
 * was written, and every log call against them returns exactly this.
 */
export function unavailableReason(text: string): string | null {
  if (/Permission denied \(publickey\)/i.test(text)) {
    return (
      'Forge could not read this log: SSH was refused (Permission denied (publickey)). ' +
      "This usually means Forge's access to the server has been REVOKED rather than anything " +
      'being wrong with the log — check `revoked` on the server via get_server. Forge fetches ' +
      'logs live over SSH, so no log or command output is available for a revoked server.'
    );
  }
  if (/^\s*===\s*Empty log file\s*===\s*$/i.test(text)) {
    return 'The log file exists but is empty.';
  }
  // Forge keeps each deployment's output in a file on the server and prunes old
  // ones (see a site's `deployment_retention`), so `cat` fails for anything past
  // the retention window. Every historical deployment checked on R3's servers
  // returned this — without an explanation it reads as a bug in this tool.
  if (/^\s*cat:\s.*No such file or directory\s*$/im.test(text)) {
    return (
      'Forge has no stored output for this run. It keeps each deployment\'s output in a file on ' +
      "the server and prunes older ones (see the site's `deployment_retention` setting), so only " +
      'recent deployments have retrievable output. The deployment record itself — status, commit ' +
      'and timings — is still available from get_deployment.'
    );
  }
  return null;
}

/**
 * Apply tailing to the text fields of a Forge response, in place of the originals.
 *
 * Returns a new object; the input is not mutated. Non-object inputs (a plain-text
 * body) are tailed directly.
 */
export function tailOutputFields(value: unknown, options: TailOptions = {}): unknown {
  // A bare string is a plain-text body, so it IS the log. Nested strings are not
  // — they are ordinary data fields and must survive untouched, which is why the
  // recursion below is a separate function. Folding these two cases together
  // truncates every string in the response (site names, URLs, repository paths,
  // deployment scripts), silently corrupting data that has nothing to do with logs.
  if (typeof value === 'string') return decorate(value, options);
  return walk(value, options);
}

function walk(value: unknown, options: TailOptions): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, options));
  // Scalars, including strings, pass through unchanged.
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      TEXT_FIELDS.includes(key) && typeof nested === 'string'
        ? decorate(nested, options)
        : walk(nested, options);
  }
  return out;
}

/** Tail the text and, when Forge returned an SSH/empty placeholder, explain it. */
function decorate(text: string, options: TailOptions): string {
  const reason = unavailableReason(text);
  if (reason) return `[${reason}]\n\n${text}`;
  return tailText(text, options);
}

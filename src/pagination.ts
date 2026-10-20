/**
 * A one-line page summary, placed first in a list response.
 *
 * Forge puts `meta.next_cursor` at the very end of a page, and a page can be
 * long: 30 sites with `include=server` measured about 2,600 lines. A caller
 * reading from the top can take the first page for the whole list. Measured
 * failure: the site being looked for was on page two, and a stale namesake on
 * page one was taken for it.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Add a `page` line ahead of `data` on a paginated list; anything else is
 * returned untouched.
 */
export function withPageSummary(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.meta)) return value;
  if (!('next_cursor' in value.meta)) return value;

  const count = value.data.length;
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;
  const next = value.meta.next_cursor;

  const page =
    typeof next === 'string' && next !== ''
      ? `${items} on this page, and MORE PAGES exist. Pass cursor "${next}" for the next page, or narrow the request with filter.`
      : `${items}. This is the last page.`;

  return { page, ...value };
}

/**
 * Tests for the page summary.
 *
 * The shape is Forge's: `data`, then `meta` with `next_cursor` at the end. The
 * summary has to come first, because that end is where a reader stops.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { withPageSummary } from '../src/pagination.ts';

const page = (count: number, nextCursor: string | null) => ({
  data: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), type: 'sites' })),
  meta: { path: 'https://forge.example/api/orgs/acme/sites', per_page: 30, next_cursor: nextCursor, prev_cursor: null },
});

describe('withPageSummary', () => {
  it('says there are more pages, and gives the cursor', () => {
    const result = withPageSummary(page(30, 'abc123')) as Record<string, unknown>;
    assert.match(String(result.page), /^30 items on this page, and MORE PAGES exist/);
    assert.match(String(result.page), /cursor "abc123"/);
  });

  it('says when this is the last page', () => {
    const result = withPageSummary(page(2, null)) as Record<string, unknown>;
    assert.equal(result.page, '2 items. This is the last page.');
  });

  it('treats an empty cursor as the last page', () => {
    const result = withPageSummary(page(1, '')) as Record<string, unknown>;
    assert.equal(result.page, '1 item. This is the last page.');
  });

  it('puts the summary first, ahead of data and meta', () => {
    const result = withPageSummary(page(3, 'abc123')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(result), ['page', 'data', 'meta']);
    assert.ok(JSON.stringify(result, null, 2).startsWith('{\n  "page":'));
  });

  it('keeps data and meta exactly as Forge sent them', () => {
    const input = page(3, 'abc123');
    const { page: _summary, ...rest } = withPageSummary(input) as Record<string, unknown>;
    assert.deepEqual(rest, input);
  });

  it('leaves a single resource untouched', () => {
    const single = { data: { id: '1', type: 'sites' } };
    assert.equal(withPageSummary(single), single);
  });

  it('leaves a list with no cursor in meta untouched', () => {
    const unpaginated = { data: [{ id: '1' }], meta: { total: 1 } };
    assert.equal(withPageSummary(unpaginated), unpaginated);
  });

  it('leaves text and other non-objects untouched', () => {
    assert.equal(withPageSummary('log output'), 'log output');
    assert.equal(withPageSummary(null), null);
    const list = [1, 2, 3];
    assert.equal(withPageSummary(list), list);
  });
});

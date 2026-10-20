/**
 * Tests for marking sites on revoked servers.
 *
 * The fixture mirrors a real case with fictional ids: two sites with the same
 * name, one on a revoked server still listed as installed.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { flagRevokedServers } from '../src/sites.ts';

const site = (id: string, serverId: string) => ({
  id,
  type: 'sites',
  attributes: { name: 'staging.acme.test', status: 'installed' },
  relationships: { server: { data: { type: 'servers', id: serverId } } },
});

const server = (id: string, revoked: boolean) => ({
  id,
  type: 'servers',
  attributes: { id: Number(id), name: `acme-${id}`, revoked },
});

type Site = { attributes: Record<string, unknown> };

describe('flagRevokedServers', () => {
  it('marks only the site on the revoked server', () => {
    const result = flagRevokedServers({
      data: [site('101', '9001'), site('102', '9002')],
      meta: { next_cursor: null },
      included: [server('9001', true), server('9002', false)],
    }) as { data: Site[] };

    assert.equal(result.data[0]!.attributes.server_revoked, true);
    assert.equal(result.data[1]!.attributes.server_revoked, undefined);
  });

  it('keeps the rest of each site unchanged', () => {
    const result = flagRevokedServers({
      data: [site('101', '9001')],
      included: [server('9001', true)],
    }) as { data: Site[] };

    assert.deepEqual(result.data[0]!.attributes, { name: 'staging.acme.test', status: 'installed', server_revoked: true });
  });

  it('marks a single site from get_site', () => {
    const result = flagRevokedServers({
      data: site('101', '9001'),
      included: [server('9001', true)],
    }) as { data: Site };

    assert.equal(result.data.attributes.server_revoked, true);
  });

  it('leaves the response untouched when the server was not included', () => {
    const response = { data: [site('101', '9001')], meta: { next_cursor: null } };
    assert.equal(flagRevokedServers(response), response);
  });

  it('leaves the response untouched when no included server is revoked', () => {
    const response = { data: [site('101', '9001')], included: [server('9001', false)] };
    assert.equal(flagRevokedServers(response), response);
  });

  it('does not mutate the response it was given', () => {
    const response = { data: [site('101', '9001')], included: [server('9001', true)] };
    flagRevokedServers(response);
    assert.equal((response.data[0]!.attributes as Record<string, unknown>).server_revoked, undefined);
  });
});

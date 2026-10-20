/**
 * Mark sites whose server Forge has revoked.
 *
 * Revoking a server (Forge's archive) leaves its sites listed with
 * `status: "installed"` and nothing on the site saying the box is gone. Two
 * sites with the same name, one on a revoked server, look equally live. The
 * server's `revoked` flag is only visible when the server is embedded, so this
 * reads it from `included` (via `include=server`) and copies it onto each site
 * as `server_revoked: true`.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serverId(site: Json): string | undefined {
  const relationships = isRecord(site.relationships) ? site.relationships : undefined;
  const server = relationships && isRecord(relationships.server) ? relationships.server : undefined;
  const data = server && isRecord(server.data) ? server.data : undefined;
  return data && data.id !== undefined ? String(data.id) : undefined;
}

export function flagRevokedServers(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.included)) return value;

  const revoked = new Set(
    value.included
      .filter(isRecord)
      .filter((item) => item.type === 'servers' && isRecord(item.attributes) && item.attributes.revoked === true)
      .map((item) => String(item.id)),
  );
  if (revoked.size === 0) return value;

  const flag = (site: unknown): unknown => {
    if (!isRecord(site) || !isRecord(site.attributes)) return site;
    const id = serverId(site);
    if (id === undefined || !revoked.has(id)) return site;
    return { ...site, attributes: { ...site.attributes, server_revoked: true } };
  };

  const data = Array.isArray(value.data) ? value.data.map(flag) : flag(value.data);
  return { ...value, data };
}

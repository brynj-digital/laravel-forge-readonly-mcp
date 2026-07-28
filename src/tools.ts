/**
 * The tool surface: 19 curated reads plus one gated escape hatch.
 *
 * Why not one tool per endpoint? Forge publishes 133 GETs. Exposing them 1:1
 * would cost 30–50k tokens of JSON schema in every client's context window before
 * a single question is asked, and most of them are variations no one reaches for.
 * So the common paths get first-class tools with real descriptions, and
 * `forge_get` covers the long tail against the same allowlist. Coverage without
 * the context bill.
 *
 * Tool names are deliberately un-prefixed (`list_servers`, not
 * `forge_list_servers`). MCP gateways that aggregate several servers namespace
 * tools themselves, and a self-prefixed name becomes `forge__forge_list_servers`
 * downstream.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgeClient, ForgeError, type QueryValue } from './client.js';
import type { Config } from './config.js';

/** Read-only, hits a remote API, and repeat calls with the same args are equivalent. */
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

type Json = Record<string, unknown>;

function text(value: unknown) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: body }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Shared pagination/query arguments, kept identical across list tools. */
const listArgs = {
  page_size: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Items per page (Forge default 30).'),
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from a previous response\'s meta.next_cursor.'),
  sort: z
    .string()
    .optional()
    .describe('Comma-separated fields to sort by; prefix with "-" to reverse (e.g. "-created_at").'),
  include: z
    .string()
    .optional()
    .describe('Comma-separated relationships to embed (e.g. "tags,latestDeployment").'),
  filter: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Field filters, e.g. {"name": "acme-web"}. Supported fields vary by endpoint.'),
};

interface ListArgs {
  page_size?: number | undefined;
  cursor?: string | undefined;
  sort?: string | undefined;
  include?: string | undefined;
  filter?: Record<string, string | number | boolean> | undefined;
}

/** Translate friendly argument names into Forge's bracketed query parameters. */
function toQuery(args: ListArgs): Record<string, QueryValue | undefined> {
  const query: Record<string, QueryValue | undefined> = {};
  if (args.page_size !== undefined) query['page[size]'] = args.page_size;
  if (args.cursor !== undefined) query['page[cursor]'] = args.cursor;
  if (args.sort !== undefined) query.sort = args.sort;
  if (args.include !== undefined) query.include = args.include;
  for (const [key, value] of Object.entries(args.filter ?? {})) {
    query[`filter[${key}]`] = value;
  }
  return query;
}

export function registerTools(server: McpServer, client: ForgeClient, config: Config): void {
  /**
   * Resolve the org slug. Configured default wins for single-org setups (the
   * common case), so the model neither has to pass it nor look it up first.
   */
  const org = (provided?: string): string => {
    const slug = provided ?? config.organization;
    if (!slug) {
      throw new ForgeError(
        'No organisation specified. Pass `organization`, or start the server with ' +
          '--organization <slug> / FORGE_ORGANIZATION to set a default. ' +
          'Call list_organizations to see the slugs your token can reach.',
      );
    }
    return slug;
  };

  const organization = z
    .string()
    .optional()
    .describe('Organisation slug. Optional when the server has a default configured.');

  /** Wrap a handler so any ForgeError becomes a readable tool error, not a crash. */
  const guard =
    <A>(handler: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return text(await handler(args));
      } catch (error) {
        return failure(error);
      }
    };

  const get = (template: string, params: Record<string, string | number>, query?: ListArgs) =>
    client.get<Json>({
      path: ForgeClient.buildPath(template, params),
      ...(query ? { query: toQuery(query) } : {}),
    });

  // ---------------------------------------------------------------- orgs, servers

  server.registerTool(
    'list_organizations',
    {
      title: 'List Organisations',
      description:
        'List the Forge organisations this API token can reach, with their slugs. Every other tool takes an organisation slug (or uses the configured default). Start here if you do not know the slug.',
      inputSchema: { ...listArgs },
      annotations: READ,
    },
    guard(async (args: ListArgs) => get('/orgs', {}, args)),
  );

  server.registerTool(
    'list_servers',
    {
      title: 'List Servers',
      description:
        'List the servers in an organisation — provider, region, size, PHP version, IP addresses and provisioning status. Supports filter/sort/include (try include="tags"). Use this to find a server id for the other tools.',
      inputSchema: { organization, ...listArgs },
      annotations: READ,
    },
    guard(async ({ organization: slug, ...args }: ListArgs & { organization?: string }) =>
      get('/orgs/{organization}/servers', { organization: org(slug) }, args),
    ),
  );

  server.registerTool(
    'get_server',
    {
      title: 'Get Server',
      description:
        'Get one server in full: provider and region, sizes, PHP and database versions, IP addresses, tags and provisioning state.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        include: listArgs.include,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        include,
      }: {
        organization?: string;
        server: string | number;
        include?: string;
      }) =>
        get(
          '/orgs/{organization}/servers/{server}',
          { organization: org(slug), server },
          { include },
        ),
    ),
  );

  server.registerTool(
    'list_server_events',
    {
      title: 'List Server Events',
      description:
        "A server's recent Forge activity — provisioning steps, service restarts, configuration changes, who triggered them and whether they succeeded. The closest thing Forge has to an audit trail, and the first place to look when something changed unexpectedly.",
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        ...args
      }: ListArgs & { organization?: string; server: string | number }) =>
        get('/orgs/{organization}/servers/{server}/events', { organization: org(slug), server }, args),
    ),
  );

  server.registerTool(
    'get_server_php',
    {
      title: 'Get Server PHP Versions',
      description:
        'The PHP versions installed on a server, which is the default, and their patch levels. Useful for spotting servers left on an end-of-life version.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
      },
      annotations: READ,
    },
    guard(async ({ organization: slug, server }: { organization?: string; server: string | number }) =>
      get('/orgs/{organization}/servers/{server}/php/versions', { organization: org(slug), server }),
    ),
  );

  // ----------------------------------------------------------------------- sites

  server.registerTool(
    'list_sites',
    {
      title: 'List Sites',
      description:
        'List every site in an organisation across all servers, with its domain, project type, PHP version, repository, deployment and maintenance-mode state. Prefer this over listing sites server by server. Note that the hosting server is NOT included by default — pass include="server" to answer "which server hosts acme.com?" in one call.',
      inputSchema: { organization, ...listArgs },
      annotations: READ,
    },
    guard(async ({ organization: slug, ...args }: ListArgs & { organization?: string }) =>
      get('/orgs/{organization}/sites', { organization: org(slug) }, args),
    ),
  );

  server.registerTool(
    'get_site',
    {
      title: 'Get Site',
      description:
        'Get one site in full: domain and aliases, web directory, PHP version, repository and branch, quick-deploy state and which server it lives on. Note that Forge addresses a single site at organisation level, so no server id is needed.',
      inputSchema: {
        organization,
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        include: listArgs.include,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        site,
        include,
      }: {
        organization?: string;
        site: string | number;
        include?: string;
      }) => get('/orgs/{organization}/sites/{site}', { organization: org(slug), site }, { include }),
    ),
  );

  server.registerTool(
    'list_domains',
    {
      title: 'List Site Domains',
      description:
        'The domains attached to a site, including aliases and their certificate state. Pair with list_certificates to audit SSL expiry.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        ...args
      }: ListArgs & { organization?: string; server: string | number; site: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/sites/{site}/domains',
          { organization: org(slug), server, site },
          args,
        ),
    ),
  );

  server.registerTool(
    'list_certificates',
    {
      title: 'List Site Certificates',
      description:
        "A site's SSL certificates with their type, status and expiry — the read to use for certificate-expiry checks. Requires the site:meta scope.",
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        ...args
      }: ListArgs & { organization?: string; server: string | number; site: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/sites/{site}/certificates',
          { organization: org(slug), server, site },
          args,
        ),
    ),
  );

  // ----------------------------------------------------------------- deployments

  server.registerTool(
    'list_deployments',
    {
      title: 'List Deployments',
      description:
        "A site's deployment history — commit, author, status, duration and timestamps. Use it to find when a site last shipped, or to identify a failed deployment to inspect with get_deployment.",
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        ...args
      }: ListArgs & { organization?: string; server: string | number; site: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/sites/{site}/deployments',
          { organization: org(slug), server, site },
          args,
        ),
    ),
  );

  server.registerTool(
    'get_deployment',
    {
      title: 'Get Deployment',
      description:
        'One deployment in detail: commit, author, status, timings and any failure information. Note that the deployment OUTPUT log needs the site:manage-deploys scope, which also grants the ability to deploy — so a read-only token will get a 403 for the log while this summary still works.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        deployment: z.union([z.string(), z.number()]).describe('Deployment id from list_deployments.'),
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        deployment,
      }: {
        organization?: string;
        server: string | number;
        site: string | number;
        deployment: string | number;
      }) =>
        get('/orgs/{organization}/servers/{server}/sites/{site}/deployments/{deployment}', {
          organization: org(slug),
          server,
          site,
          deployment,
        }),
    ),
  );

  server.registerTool(
    'get_deployment_script',
    {
      title: 'Get Deployment Script',
      description:
        "The site's deployment script — the commands Forge runs on each deploy. Read-only: this cannot change the script.",
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
      }: {
        organization?: string;
        server: string | number;
        site: string | number;
      }) =>
        get('/orgs/{organization}/servers/{server}/sites/{site}/deployments/script', {
          organization: org(slug),
          server,
          site,
        }),
    ),
  );

  // ------------------------------------------------------------------------ logs

  server.registerTool(
    'get_site_logs',
    {
      title: 'Get Site Logs',
      description:
        "Tail a site's logs: the Laravel/application log, or the Nginx access or error log. The first place to look when a site is throwing errors. Requires the server:manage-logs scope (whose only write power is clearing logs).",
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        type: z
          .enum(['application', 'nginx-access', 'nginx-error'])
          .describe('Which log to read.'),
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        type,
      }: {
        organization?: string;
        server: string | number;
        site: string | number;
        type: 'application' | 'nginx-access' | 'nginx-error';
      }) =>
        client.get({
          path: ForgeClient.buildPath(
            `/orgs/{organization}/servers/{server}/sites/{site}/logs/${type}`,
            { organization: org(slug), server, site },
          ),
        }),
    ),
  );

  // ------------------------------------------------------- jobs, workers, queues

  server.registerTool(
    'list_scheduled_jobs',
    {
      title: 'List Scheduled Jobs',
      description:
        'Cron/scheduled jobs, either for a whole server or for one site. Shows the command, user, frequency and last run state — use it to confirm a schedule exists and is firing.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        site: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Restrict to one site; omit for all jobs on the server.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        ...args
      }: ListArgs & {
        organization?: string;
        server: string | number;
        site?: string | number;
      }) =>
        site === undefined
          ? get(
              '/orgs/{organization}/servers/{server}/scheduled-jobs',
              { organization: org(slug), server },
              args,
            )
          : get(
              '/orgs/{organization}/servers/{server}/sites/{site}/scheduled-jobs',
              { organization: org(slug), server, site },
              args,
            ),
    ),
  );

  server.registerTool(
    'list_background_processes',
    {
      title: 'List Background Processes',
      description:
        'Daemons and queue workers on a server — command, user, process count and status. Use it to check queue workers are running and correctly sized.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        ...args
      }: ListArgs & { organization?: string; server: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/background-processes',
          { organization: org(slug), server },
          args,
        ),
    ),
  );

  server.registerTool(
    'get_site_integration',
    {
      title: 'Get Site Integration Status',
      description:
        'Whether a first-party Laravel integration is enabled for a site: Horizon, Octane, Reverb, Pulse, Inertia, the scheduler, or maintenance mode. "laravel-maintenance" answers "is this site in maintenance mode?".',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        integration: z
          .enum([
            'horizon',
            'octane',
            'reverb',
            'pulse',
            'inertia',
            'laravel-maintenance',
            'laravel-scheduler',
          ])
          .describe('Which integration to check.'),
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        integration,
      }: {
        organization?: string;
        server: string | number;
        site: string | number;
        integration: string;
      }) =>
        client.get({
          path: ForgeClient.buildPath(
            `/orgs/{organization}/servers/{server}/sites/{site}/integrations/${integration}`,
            { organization: org(slug), server, site },
          ),
        }),
    ),
  );

  server.registerTool(
    'list_site_commands',
    {
      title: 'List Site Command History',
      description:
        'The history of commands run from a site\'s Commands panel, with who ran them and when. An audit read — this cannot run a command.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id the site is on.'),
        site: z.union([z.string(), z.number()]).describe('Site id from list_sites.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        site,
        ...args
      }: ListArgs & { organization?: string; server: string | number; site: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/sites/{site}/commands',
          { organization: org(slug), server, site },
          args,
        ),
    ),
  );

  // ------------------------------------------------------- databases and backups

  server.registerTool(
    'list_databases',
    {
      title: 'List Databases',
      description:
        'Database schemas on a server, or the database users and the schemas they can access. Names and grants only — this never reads database contents.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        resource: z
          .enum(['schemas', 'users'])
          .optional()
          .describe('"schemas" (default) for databases, "users" for database users.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        resource,
        ...args
      }: ListArgs & {
        organization?: string;
        server: string | number;
        resource?: 'schemas' | 'users';
      }) =>
        get(
          `/orgs/{organization}/servers/{server}/database/${resource ?? 'schemas'}`,
          { organization: org(slug), server },
          args,
        ),
    ),
  );

  server.registerTool(
    'list_backup_configs',
    {
      title: 'List Backup Configurations',
      description:
        'Database backup configurations on a server — schedule, retention, destination and which databases are covered. Answers "is this server actually being backed up?". Listing individual backup INSTANCES needs the server:create-backups scope, which also grants restore, so it is not exposed here.',
      inputSchema: {
        organization,
        server: z.union([z.string(), z.number()]).describe('Server id from list_servers.'),
        ...listArgs,
      },
      annotations: READ,
    },
    guard(
      async ({
        organization: slug,
        server,
        ...args
      }: ListArgs & { organization?: string; server: string | number }) =>
        get(
          '/orgs/{organization}/servers/{server}/database/backups',
          { organization: org(slug), server },
          args,
        ),
    ),
  );

  // ---------------------------------------------------------------- escape hatch

  server.registerTool(
    'forge_get',
    {
      title: 'Forge API Read (any endpoint)',
      description:
        'Perform an arbitrary GET against the Forge API for endpoints the named tools do not cover — monitors, firewall rules, Nginx templates, recipes, teams, PHP config, heartbeats, providers and so on. ' +
        'Pass a path relative to the API base with real ids substituted, e.g. "/orgs/acme/servers/12345/monitors". ' +
        'Only documented Forge GET endpoints are permitted: writes are impossible, and a small set of reads that would expose secrets (.env contents, registry and provider credentials, SSH and deploy keys) or hand over a deploy capability (the deployment trigger URL) are refused with an explanation. ' +
        'Query parameters go in `query`, not in the path — e.g. {"page[size]": 50}.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'API path with ids filled in, starting with "/" and with no query string, e.g. /orgs/acme/servers/12345/monitors',
          ),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. {"page[size]": 50, "sort": "-created_at"}.'),
      },
      annotations: READ,
    },
    guard(
      async ({ path, query }: { path: string; query?: Record<string, string | number | boolean> }) =>
        client.get({ path, ...(query ? { query } : {}) }),
    ),
  );
}

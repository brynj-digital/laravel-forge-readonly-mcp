/**
 * Configuration: CLI flags take precedence over environment variables.
 *
 * Note the deliberate asymmetry — the token may ONLY come from the environment or
 * a flag, never from a tool argument. Nothing a model says can change which
 * credentials, base URL or org default this server uses.
 */

export interface Config {
  readonly apiToken: string;
  readonly baseUrl: string;
  /** Default org slug, so `organization` can be omitted by single-org users. */
  readonly organization: string | null;
  /** Fold the withheld secret/credential reads back in. Off unless asked twice. */
  readonly allowSecrets: boolean;
  /** Requests per minute the local limiter will allow. Forge's default is 60. */
  readonly requestsPerMinute: number;
}

export const DEFAULT_BASE_URL = 'https://forge.laravel.com/api';
export const DEFAULT_RPM = 60;

export class ConfigError extends Error {}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1) {
    const next = argv[exact + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ConfigError(`--${name} requires a value`);
    }
    return next;
  }
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(`--${name}=`.length);
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`) || argv.includes(`--${name}=true`);
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const apiToken = flagValue(argv, 'api-token') ?? env.FORGE_API_TOKEN ?? '';
  if (apiToken.trim().length === 0) {
    throw new ConfigError(
      'No Forge API token. Set FORGE_API_TOKEN or pass --api-token <token>.\n' +
        'Create a token at https://forge.laravel.com → account dashboard → API.\n' +
        'Recommended scopes: organization:view, server:view, user:view, team:view, recipe:view\n' +
        '(all view-only, no write capability), plus site:meta for domains/SSL and\n' +
        'server:manage-logs for logs — Forge gates those two reads behind manage scopes.\n' +
        'Omit either and this server will tell you which scope a 403 needed. See the README.',
    );
  }

  const rpmRaw = flagValue(argv, 'requests-per-minute') ?? env.FORGE_REQUESTS_PER_MINUTE;
  const requestsPerMinute = rpmRaw === undefined ? DEFAULT_RPM : Number(rpmRaw);
  if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new ConfigError(`--requests-per-minute must be a positive number (got "${rpmRaw}")`);
  }

  const baseUrl = (flagValue(argv, 'base-url') ?? env.FORGE_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );

  const organization = flagValue(argv, 'organization') ?? env.FORGE_ORGANIZATION ?? null;

  return {
    apiToken: apiToken.trim(),
    baseUrl,
    organization: organization && organization.length > 0 ? organization : null,
    allowSecrets: hasFlag(argv, 'unsafe-allow-secrets') || truthy(env.FORGE_UNSAFE_ALLOW_SECRETS),
    requestsPerMinute,
  };
}

export const HELP = `laravel-forge-readonly-mcp — read-only MCP server for the Laravel Forge API

Usage:
  laravel-forge-readonly-mcp [options]

Options:
  --api-token <token>          Forge API token (or FORGE_API_TOKEN)
  --organization <slug>        Default org slug, so tools can omit it (or FORGE_ORGANIZATION)
  --base-url <url>             API base URL (default ${DEFAULT_BASE_URL})
  --requests-per-minute <n>    Local rate limit (default ${DEFAULT_RPM}, matching Forge)
  --unsafe-allow-secrets       Expose the withheld .env / credential / key reads.
                               Off by default: these route secrets through the model,
                               and one of them (the deploy-hook URL) is a deploy
                               capability in disguise. See the README.
  --help                       Show this message

This server issues GET requests only. It cannot deploy, restart, restore,
provision or delete anything — there is no tool for it and no code path for it.

Not affiliated with or endorsed by Laravel.
`;

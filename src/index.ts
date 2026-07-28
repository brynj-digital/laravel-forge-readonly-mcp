#!/usr/bin/env node
/**
 * laravel-forge-readonly-mcp — entry point.
 *
 * A read-only MCP server for the Laravel Forge API, speaking stdio.
 *
 * Everything on this process's stdout belongs to the MCP protocol, so all
 * diagnostics go to stderr. A stray console.log here corrupts the stream and the
 * client sees a parse error rather than a message from us.
 *
 * Not affiliated with or endorsed by Laravel.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildAllowlist } from './allowlist.js';
import { ForgeClient } from './client.js';
import { ConfigError, HELP, loadConfig } from './config.js';
import { registerTools } from './tools.js';

export { buildAllowlist, EXCLUSIONS, matchPath } from './allowlist.js';
export { ForgeClient, ForgeError } from './client.js';
export { loadConfig, type Config } from './config.js';
export { FORGE_GET_PATHS } from './generated/forge-get-paths.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    return;
  }

  const config = loadConfig(argv);
  const allowlist = buildAllowlist(config.allowSecrets);
  const client = new ForgeClient(config, allowlist);

  const server = new McpServer(
    { name: 'laravel-forge-readonly-mcp', version: '0.2.0' },
    {
      instructions:
        'Read-only access to Laravel Forge: servers, sites, deployments, logs, domains and ' +
        'certificates, scheduled jobs, queue workers, databases and backup configuration. ' +
        'This server cannot deploy, restart, provision, restore or delete anything. ' +
        'Start with list_sites (it spans every server) or list_servers; use forge_get for ' +
        'endpoints the named tools do not cover.',
    },
  );

  registerTools(server, client, config);

  if (config.allowSecrets) {
    process.stderr.write(
      '[laravel-forge-readonly-mcp] WARNING: --unsafe-allow-secrets is enabled. ' +
        '.env contents, registry/provider credentials, SSH and deploy keys, and the deploy-hook ' +
        'trigger URL are now readable, which means they can reach model context and transcripts.\n',
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[laravel-forge-readonly-mcp] ready — ${allowlist.paths.length} readable Forge endpoints` +
      `${config.organization ? `, default org "${config.organization}"` : ''}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`[laravel-forge-readonly-mcp] ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `[laravel-forge-readonly-mcp] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});

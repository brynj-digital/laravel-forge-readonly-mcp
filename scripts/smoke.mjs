/**
 * End-to-end smoke test against the BUILT binary — no network required.
 *
 * Unit tests cannot catch the two failure modes that matter most for a stdio MCP
 * server: writing anything to stdout (which corrupts the JSON-RPC stream and
 * breaks every client), and a tool that fails to register. So this spawns
 * dist/index.js exactly as a client would, completes a real handshake, lists the
 * tools, and calls one.
 *
 * It also proves the security boundary end to end: asking forge_get for the .env
 * endpoint must be refused by the allowlist BEFORE any HTTP request, which is why
 * a fake token is sufficient here.
 *
 * Run: node scripts/smoke.mjs   (requires npm run build first)
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const EXPECTED_TOOLS = [
  'list_organizations',
  'list_servers',
  'get_server',
  'list_server_events',
  'get_server_php',
  'list_sites',
  'get_site',
  'list_domains',
  'list_certificates',
  'list_deployments',
  'get_deployment',
  'get_deployment_script',
  'get_site_logs',
  'list_scheduled_jobs',
  'list_background_processes',
  'get_site_integration',
  'list_site_commands',
  'list_databases',
  'list_backup_configs',
  'forge_get',
];

const failures = [];
function check(condition, message) {
  if (condition) return;
  failures.push(message);
}

const child = spawn(process.execPath, ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    FORGE_API_TOKEN: process.env.FORGE_API_TOKEN ?? 'smoke-test-token-not-real',
    FORGE_ORGANIZATION: 'smoke-org',
  },
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const pending = new Map();
const nonJsonStdout = [];

createInterface({ input: child.stdout }).on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // The whole point of this check: a stray console.log lands here.
    nonJsonStdout.push(trimmed);
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  check(init.result !== undefined, `initialize failed: ${JSON.stringify(init.error ?? init)}`);
  check(
    init.result?.serverInfo?.name === 'laravel-forge-readonly-mcp',
    `unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`,
  );
  notify('notifications/initialized', {});

  const listed = await request('tools/list', {});
  const tools = listed.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();

  for (const expected of EXPECTED_TOOLS) {
    check(names.includes(expected), `missing tool: ${expected}`);
  }
  check(
    tools.length === EXPECTED_TOOLS.length,
    `expected ${EXPECTED_TOOLS.length} tools, got ${tools.length}: ${names.join(', ')}`,
  );

  for (const tool of tools) {
    check(
      tool.annotations?.readOnlyHint === true,
      `${tool.name} is missing readOnlyHint — clients would treat it as a possible write`,
    );
    check(
      typeof tool.description === 'string' && tool.description.length > 40,
      `${tool.name} needs a real description`,
    );
    // Clients render the top-level Tool.title and only fall back to
    // annotations.title. Aggregating gateways override the top-level field to
    // add their own namespace prefix, so that is the one we must populate.
    const title = tool.title ?? tool.annotations?.title;
    check(typeof title === 'string' && title.length > 0, `${tool.name} is missing a title`);
  }

  // No tool name may imply a mutation. A read-only server that grows a
  // "restart_x" tool has lost its only real guarantee.
  const forbidden = /^(create|update|delete|deploy|restart|reboot|stop|start|run|install|remove|restore|revoke|reset|enable|disable)_/;
  for (const name of names) {
    check(!forbidden.test(name), `tool name looks like a mutation: ${name}`);
  }

  // The security boundary, end to end: refused before any HTTP call.
  const denied = await request('tools/call', {
    name: 'forge_get',
    arguments: { path: '/orgs/smoke-org/servers/1/sites/2/environment' },
  });
  const deniedText = denied.result?.content?.[0]?.text ?? '';
  check(denied.result?.isError === true, 'reading .env should be reported as an error');
  check(/\.env/.test(deniedText), `refusal should explain itself, got: ${deniedText}`);

  const hook = await request('tools/call', {
    name: 'forge_get',
    arguments: { path: '/orgs/smoke-org/servers/1/sites/2/deployments/deploy-hook' },
  });
  const hookText = hook.result?.content?.[0]?.text ?? '';
  check(hook.result?.isError === true, 'reading the deploy hook should be refused');
  check(
    /write capability/i.test(hookText),
    `deploy-hook refusal should name the write capability, got: ${hookText}`,
  );

  check(
    nonJsonStdout.length === 0,
    `non-JSON written to stdout (this corrupts the MCP stream): ${nonJsonStdout.join(' | ')}`,
  );
  check(/ready — \d+ readable Forge endpoints/.test(stderr), `no ready line on stderr: ${stderr}`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  child.stdin.end();
  child.kill();
  await once(child, 'exit').catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`smoke FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  ✖ ${failure}`);
  if (stderr) console.error(`\n--- server stderr ---\n${stderr}`);
  process.exit(1);
}

console.error(`smoke OK — ${EXPECTED_TOOLS.length} tools, stdio clean, withheld reads refused`);

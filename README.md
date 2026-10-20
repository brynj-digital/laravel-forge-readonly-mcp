# laravel-forge-readonly-mcp

A **read-only** [MCP](https://modelcontextprotocol.io) server for the [Laravel Forge](https://forge.laravel.com) API.

Point an AI assistant at your Forge infrastructure to answer questions — which server hosts a
site, when it last deployed, what's in the error log, which certificates are about to expire —
without giving it the ability to change anything.

It cannot deploy, restart, provision, restore, or delete. Not because it's asked not to: there
is no tool for it and no code path for it. The HTTP client only issues `GET`, and the verb isn't
a parameter anywhere.

> Built on Forge's current API (`https://forge.laravel.com/api`). The older `/api/v1` is
> deprecated and Forge discontinues it on **31 August 2026**.

## Install

```bash
npm install -g laravel-forge-readonly-mcp
```

Create a token in Forge → account dashboard → **API**. Recommended scopes are
[below](#token-scopes-the-part-worth-reading).

### Claude Code

```bash
claude mcp add forge -e FORGE_API_TOKEN=your-token -- npx -y laravel-forge-readonly-mcp
```

### Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["-y", "laravel-forge-readonly-mcp"],
      "env": {
        "FORGE_API_TOKEN": "your-token",
        "FORGE_ORGANIZATION": "your-org-slug"
      }
    }
  }
}
```

`FORGE_ORGANIZATION` is optional but worth setting if you have one organisation: tools can then
omit the slug, and the assistant doesn't need a lookup call first.

## Options

| Flag | Environment variable | Default |
|---|---|---|
| `--api-token <token>` | `FORGE_API_TOKEN` | *required* |
| `--organization <slug>` | `FORGE_ORGANIZATION` | none — pass `organization` per call |
| `--base-url <url>` | `FORGE_BASE_URL` | `https://forge.laravel.com/api` |
| `--requests-per-minute <n>` | `FORGE_REQUESTS_PER_MINUTE` | `60`, matching Forge |
| `--unsafe-allow-secrets` | `FORGE_UNSAFE_ALLOW_SECRETS` | off — [see below](#what-it-deliberately-wont-read) |

Credentials come only from flags or the environment, never from a tool argument, so nothing the
model says can change which token, base URL or default organisation is used.

## Tools

24 named tools for the common reads, plus one escape hatch. Forge publishes **133** GET
endpoints; mapping them 1:1 would cost 30–50k tokens of JSON schema in your context window
before you asked anything, so the frequent paths get real tools and `forge_get` covers the rest
against the same allowlist.

| Tool | What it answers |
|---|---|
| `list_organizations` | Which orgs can this token see? |
| `list_servers` / `get_server` | Provider, region, size, PHP version, IPs, provisioning state |
| `list_server_events` | Recent Forge activity on a server — the closest thing to an audit trail |
| `get_server_php` | Installed PHP versions and the default — find servers on an EOL version |
| `list_sites` / `get_site` | Every site **across all servers**: domain, repo, PHP, deploy state |
| `list_domains` / `list_certificates` | Domains, aliases and SSL expiry |
| `list_deployments` / `get_deployment` | Deployment history: commit, author, status, duration |
| `get_deployment_script` | The commands each deploy runs |
| `get_site_logs` | Application, Nginx access or Nginx error log |
| `get_deployment_log` | **Why a deploy failed** — the deploy script's output. Needs `site:manage-deploys` |
| `get_command_output` | Output of a command run from the Commands panel |
| `get_scheduled_job_output` | Output of a cron job's last run — is the schedule actually succeeding? |
| `get_server_event_output` | Output of a Forge server event (provisioning, service restart) |
| `get_background_process_log` | Queue worker / daemon log. Needs `server:create-daemons` |
| `list_scheduled_jobs` | Cron jobs for a server or one site, with last-run state |
| `list_background_processes` | Daemons and queue workers, and whether they're running |
| `get_site_integration` | Is Horizon/Octane/Reverb/Pulse/Inertia/scheduler on? In maintenance mode? |
| `list_site_commands` | History of commands run from the Commands panel |
| `list_databases` | Database schemas, or users and their grants (never contents) |
| `list_backup_configs` | Is this server actually being backed up? |
| `forge_get` | Any other documented Forge GET — monitors, firewall rules, Nginx templates, recipes, teams, providers… |

List tools take `page_size`, `cursor`, `sort`, `include` and `filter`. Cursors are never followed
automatically — see [rate limiting](#rate-limiting).

- **Pages hold at most 30 items.** Forge caps `page[size]` at 30 and silently returns 30 for
  anything larger, so `page_size` is limited to 30 rather than accepting a number Forge will
  ignore.
- **Every list response starts with a `page` line**, such as `30 items on this page, and MORE PAGES
  exist. Pass cursor "…"`, or `2 items. This is the last page.` Forge puts the cursor at the end
  of the response, which on a long page is where a reader stops.

### Log and output tools return the *tail*

Forge offers no range parameter and applies no limit: one real site's application log measured
**274,503 characters over 500 lines** — about 69,000 tokens in a single response. So every
log/output tool returns the **last 200 lines** by default (failures are at the end), raisable via
`tail_lines`, and is additionally capped by character count because line counts lie — that log
averaged ~550 characters per line, and one PHP stack-trace line can exceed a thousand. Anything
dropped is stated at the top of the output, so a truncated log never reads as a complete one.

Forge also returns HTTP 200 in three cases where there is no log to give, each of which reads as
a broken tool unless explained. All three are detected and described in the response:

- **The server's Forge access was revoked.** Forge reads logs over SSH *at request time*, so a
  revoked server yields `Permission denied (publickey)` as the log body. The tools point you at
  `revoked` on the server.
- **The deployment's output file was pruned.** Forge stores each deployment's output on the server
  and deletes older ones per the site's `deployment_retention`, so historical deployments return
  `cat: …: No such file or directory`. The deployment record itself still works.
- **The log is empty** (`=== Empty log file ===`).

## Token scopes: the part worth reading

Forge has genuine view-only scopes, so a token can be minted that is **incapable** of writing.
These five reach **76 of the 120 endpoints this server exposes** (plus 13 more that need no scope
at all) with zero write capability:

```
organization:view  server:view  user:view  team:view  recipe:view
```

Two other view scopes are **not** worth granting. `credential:view` unlocks exactly one endpoint
this server exposes (a VPC lookup) — its other three are cloud-provider credentials, which are
[withheld](#what-it-deliberately-wont-read) — so it buys nothing while widening what a leaked
token could read. `resources:view` currently gates no endpoint at all; add it when Forge ships the
managed-database and object-storage API.

The wrinkle: **30 reads sit behind `manage` scopes**, so getting the read also buys the write.
Two are worth it, and the rest mostly aren't:

| Scope | Reads it unlocks | Writes it also grants | Suggested |
|---|---|---|---|
| `site:meta` | 8 — all domains and certificates | add / modify / **delete a domain** | **Add** — this is SSL and domain visibility |
| `server:manage-logs` | 4 — application and Nginx logs, server logs | *clearing* logs, nothing else | **Add** — smallest blast radius, biggest payoff |
| `site:manage-redirects` / `-notifications` / `-project` | 6 | redirect rules, webhooks, healthcheck | Optional |
| `site:manage-nginx` | 2 — Nginx config | **rewrite the Nginx config** | Skip unless needed |
| `server:manage-network` | 2 — firewall rules | **change the firewall** | Skip unless needed |
| `site:manage-security` | 2 | basic-auth rules | Skip |
| `site:manage-deploys` | 1 — **the deployment log** | **deploy the site**, rewrite the deploy script (8) | Your call — see below |
| `server:create-daemons` | 1 — queue worker log | create daemons, enable Horizon/Octane/Pulse (8) | Your call — see below |
| `server:create-backups` | 2 — backup instances | **restore a backup** | **Don't** |
| `storage:manage` | 2 | delete storage providers | Don't |

**Suggested token — seven scopes:**

```
organization:view  server:view  user:view  team:view  recipe:view  site:meta  server:manage-logs
```

That reaches **101 of the 120 endpoints this server exposes**, and the token cannot deploy,
restore a backup, change a firewall, or rewrite an Nginx config. Its only write powers are
clearing a log and modifying a domain.

For a token with **literally no write capability**, drop `site:meta` and `server:manage-logs`:
89 endpoints, but no logs and no domain or certificate visibility.

### The two log scopes that also grant writes

`get_deployment_log` and `get_background_process_log` are the only tools whose scopes grant real
write power — deploy, and enabling Horizon/Octane/Pulse respectively. There is **no alternative
source**: a deployment object carries only commit, status and timings, with no output field, and
Forge gates the log behind the same scope as deploying.

Worth being precise about what granting them does and doesn't change. It does **not** give this
server, or a model talking to it, any ability to deploy: no write tool exists, the client only
issues GET, the `deploy-hook` endpoint stays excluded and `deployment_url` stays redacted. What it
changes is the **token's** capability if the token itself leaks. Whether that trade is worth a
failed deploy's output is a judgement about your threat model, not something this package should
make for you — so both tools ship regardless, and simply return a 403 naming the scope when you
haven't granted it.

Every scope-gated endpoint stays available in this package regardless of what you grant — your
token's scopes decide, not us. A 403 says which scope was missing, and whether that scope would
also hand over write access:

```
Forge denied access to /orgs/acme/servers/1/sites/2/nginx (403). This endpoint requires the
"site:manage-nginx" scope, which your token does not have. Note that "site:manage-nginx" also
grants the matching write permissions — this package deliberately does not require you to hold
it, and will simply not serve this read if you would rather keep the token read-only.
```

## What it deliberately won't read

**A `GET` being read-only doesn't make it safe to put in front of a language model.** Thirteen
of Forge's reads are withheld by default, for two different reasons.

**They'd leak a secret:**

- `…/sites/{site}/environment` — Forge documents this as *"Get .env content"*: database
  passwords, `APP_KEY`, every third-party API key the app holds
- Composer and npm registry credentials
- Cloud provider credentials (`/server-credentials`)
- SSH keys and deploy keys

**They'd leak a *write capability*:**

- `…/deployments/deploy-hook` returns, in Forge's words, *"the deployment trigger URL"* — a URL
  that triggers a deploy with **no authentication**. Handing that string to a model defeats the
  entire point of a read-only server, however much the verb was `GET`.

That last one is why this package doesn't implement read-only as "allow all GETs". Refusals
explain themselves rather than looking like a bug:

```
/orgs/acme/servers/1/sites/2/deployments/deploy-hook is a read this server deliberately
withholds: the deployment trigger URL — an unauthenticated deploy capability, so reading it
would hand out the ability to deploy. Exposing it would grant a write capability, which
defeats the purpose of a read-only server.
```

### …and one field, wherever it appears

Withholding an endpoint is worthless if the thing it guards is duplicated into a payload you do
serve. Forge returns the deploy trigger URL inline on ordinary site reads:

```json
{ "attributes": { "deployment_url": "https://forge.laravel.com/servers/1/sites/2/deploy/http?token=…" } }
```

That's the same unauthenticated deploy capability as the `deploy-hook` endpoint, arriving through
`get_site` and `list_sites`. So **every response is also filtered field-by-field**, and
`deployment_url` comes back as:

```
[withheld: deploy trigger URL — an unauthenticated capability to deploy the site, not a read]
```

The key is preserved so you can see something was withheld, and a `null` value passes through
untouched — that legitimately means quick-deploy is off. The general lesson, learned by probing
the live API rather than reading its docs: **for a read-only surface over someone else's API the
unit of danger is a field, not an endpoint.** Fields travel.

### …and secrets inside log text

The same lesson recurs a layer down, and this one cannot be solved cleanly. This server withholds
`.../environment` to keep `.env` out of model context — but a **deployment log is the output of a
deploy script** that may echo environment variables, composer auth tokens turn up in build output,
and `get_command_output` replays whatever a human chose to run, `cat .env` included. Field-level
redaction can't help, because the secret is inside a blob of text.

So log and command output additionally passes through a **best-effort scrubber** for
credential-shaped substrings: `KEY=`/`SECRET:`/`PASSWORD=` assignments, `Authorization: Bearer …`,
`?token=…`, AWS `AKIA…` ids, `https://user:pass@host`, and `PRIVATE KEY` blocks. Redactions keep
the key name so the line still reads as a log line and you can see what was withheld.

**This is best-effort and not a guarantee.** Pattern matching over arbitrary log output cannot be
complete, and it is deliberately narrow — a greedy scrubber that mangled ordinary log lines would
push people to disable it wholesale, which loses far more than it gains. Treat log output as
potentially containing secrets regardless. `get_command_output` deserves the most caution of the
set.

`--unsafe-allow-secrets` re-enables all thirteen endpoints and this field. It's off by default and
named to be hard to turn on by accident. If you enable it, those values will appear in model
context and in transcripts and logs wherever they're kept.

## How read-only is enforced

Four independent layers, so no single mistake is sufficient:

1. **No write tool exists.** Only reads are implemented, so there is nothing to disable.
2. **The client can only `GET`.** The verb is a literal in one place and is never threaded
   through from configuration or arguments.
3. **Every path is matched against an allowlist** of Forge's documented GET templates before a
   request is built. This is what makes `forge_get` safe: the model picks a path, but only from a
   set already reviewed. Denials are checked *before* allowances, because an excluded literal
   path (`…/deployments/deploy-hook`) collides with a legitimate template
   (`…/deployments/{deployment}`) — in a deny-by-default boundary the denial must win.
4. **Every response is filtered field-by-field** on the way out, because the endpoint allowlist
   alone let the deploy trigger URL through inline on ordinary site reads. Log and command text is
   additionally scrubbed for credential shapes, and bounded in size.
5. **Your token's scopes**, if you mint it view-only — defence in depth rather than the primary
   control.

The allowlist is **generated from Forge's OpenAPI spec** (`npm run generate:paths`), so a typo
can't silently create a hole. `npm run check:drift` — run in CI on every PR and weekly — fails if
a new GET appears unreviewed, if one we rely on disappears, if a read moves behind a
write-granting scope, or, most importantly, if a withheld path is renamed such that its
exclusion silently stops protecting anything.

## Rate limiting

Forge allows **60 requests per minute per token**. This package keeps a local sliding window and
also honours `X-RateLimit-*` and `Retry-After`, retrying a 429 twice before giving up with advice
to narrow the request.

Cursors are **never followed automatically**. A single "check every site" call must not be able
to spend the whole minute, so pagination is explicit: read the `page` line (or `meta.next_cursor`) and pass the cursor back as
`cursor`.

## Development

```bash
npm install
npm run lint            # tsc --noEmit
npm test                # unit tests (no network)
npm run build
node scripts/smoke.mjs  # drives the built binary over stdio; no network needed
npm run generate:paths  # regenerate the path table from Forge's spec
npm run check:drift     # fail if the package has drifted from Forge's API
```

`FORGE_SPEC_FILE=/path/to/spec.json` makes the generator and drift check read a local spec
instead of fetching.

## Using this behind an MCP gateway

Tool names are intentionally **un-prefixed** (`list_servers`, not `forge_list_servers`), because
aggregating gateways add their own namespace and a self-prefixed name becomes
`forge__forge_list_servers` downstream.

Annotations split by kind: this package sets `readOnlyHint` and `idempotentHint` (facts about the
tool, true everywhere) plus a plain `title`. A gateway is free to override the top-level `title`
with its own house convention.

`main` and `bin` are the same built entry, so a gateway can `require.resolve()` the package and
run it under its own Node rather than needing a global install.

## Licence

MIT. Not affiliated with or endorsed by Laravel. "Laravel" and "Laravel Forge" are trademarks of
Taylor Otwell; this is an independent client for their public API.

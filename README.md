# Bumble

> MCP server for NZ bank data via [Akahu](https://akahu.nz) — transaction categorization, balance tracking, and internal-transfer detection.

Bumble is a self-hostable [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a single household's NZ bank data to MCP clients (Claude Desktop, Claude Code, etc.). It lets an LLM read balances, browse transactions, categorise spending, and detect transfers between your own accounts — through natural conversation.

**Status:** v1.1.0 — adds HTTP transport with OAuth 2.1 so you can host Bumble behind a Cloudflare tunnel and connect to it from claude.ai. v1.0's STDIO transport is unchanged.

## What works in v1

Sixteen tools across five groups, all exercised by unit and MCP-SDK integration tests:

| Group              | Tools                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Accounts           | `list_accounts`, `get_balances`                                                                              |
| Transactions       | `list_transactions`, `search_transactions`, `list_uncategorized`                                             |
| Categorization     | `categorize_transactions`, `list_categories`, `create_category`, `rename_category`, `delete_category`        |
| Rules              | `list_rules`, `delete_rule` (vendor→category rules are learned automatically when you categorise)            |
| Internal transfers | `detect_internal_transfers`, `mark_internal_transfer`, `list_internal_transfers`, `unmark_internal_transfer` |

Plus a `bumble sync` CLI that pulls the latest day of transactions from Akahu, applies vendor rules, and auto-marks high-confidence internal transfer pairs. Designed to run nightly via cron.

**Categorisation flow.** When you ask Claude to categorise an uncategorised transaction, Bumble proposes a category — either the Akahu NZFCC hint or a learned vendor rule. You can accept it or override; Bumble upserts the category by name and records a vendor→category rule so the next matching transaction is auto-categorised.

**Internal-transfer heuristic.** Two passes: (1) auto-mark when both legs of a transfer carry `meta.other_account` referencing one of your own accounts; (2) suggest pairs where the amount matches within a configurable window. Sync runs pass 1; `detect_internal_transfers` surfaces pass-2 candidates for manual confirmation.

## Quick start

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "bumble": {
      "command": "npx",
      "args": ["-y", "mcp-bumble"],
      "env": {
        "AKAHU_APP_TOKEN": "app_token_xxxxx",
        "AKAHU_USER_TOKEN": "user_token_xxxxx",
        "DB_PATH": "/Users/you/.bumble/bumble.db"
      }
    }
  }
}
```

Restart Claude Desktop. The `bumble` server should appear in the MCP indicator with 16 tools available.

Get Akahu tokens from <https://my.akahu.nz/developers> — you need both the App token (per-app) and a User token (per-user, scoped to your accounts).

### npx / bare-metal

```sh
# Run the MCP server (STDIO)
AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… npx -y mcp-bumble

# One-shot sync
AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… npx -y mcp-bumble sync --now
```

### Docker

The Docker image is primarily for running the nightly sync as a daemon.

```sh
cp .env.example .env   # then fill in AKAHU_APP_TOKEN / AKAHU_USER_TOKEN
docker compose up -d   # starts crond; runs `bumble sync` at SYNC_CRON_HOUR:SYNC_CRON_MINUTE in SYNC_TZ
```

Useful one-offs:

```sh
docker compose run --rm bumble sync --now    # force a sync now
docker compose run --rm -i bumble mcp        # MCP STDIO server (attach a client to stdin)
docker compose logs -f bumble                # tail the cron log
```

The container persists data in the `bumble-data` named volume (`/data/bumble.db` inside the container).

## Environment variables

| Variable                    | Required? | Default                                          | Notes                                                                                                               |
| --------------------------- | --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `AKAHU_APP_TOKEN`           | yes       | —                                                | Akahu Personal App token.                                                                                           |
| `AKAHU_USER_TOKEN`          | yes       | —                                                | Akahu User token scoped to the accounts you want exposed.                                                           |
| `DB_PATH`                   | no        | `./bumble.db` (host), `/data/bumble.db` (Docker) | SQLite file. Created on first run.                                                                                  |
| `BUMBLE_TRANSPORT`          | no        | `stdio`                                          | Set to `http` to bind an HTTP server instead of STDIO.                                                              |
| `OAUTH_ISSUER`              | http only | —                                                | Canonical public URL (e.g. `https://bumble.example.com`). Used for `iss`, audience binding, and discovery metadata. |
| `OAUTH_ADMIN_PASSWORD`      | http only | —                                                | Password that gates the consent page.                                                                               |
| `OAUTH_DATA_FILE`           | no        | in-memory                                        | Path to a JSON file for the OAuth state store. Created with mode 0600.                                              |
| `BUMBLE_HTTP_PORT`          | no        | `3001`                                           | Local port to bind.                                                                                                 |
| `BUMBLE_HTTP_HOST`          | no        | `127.0.0.1`                                      | Bind address. Keep loopback when fronted by a tunnel.                                                               |
| `BUMBLE_HTTP_ALLOWED_HOSTS` | no        | —                                                | Comma-separated allowlist of `Host` header values (DNS rebinding protection).                                       |
| `SYNC_CRON_HOUR`            | no        | `2`                                              | Hour for the nightly sync (Docker `cron` mode only).                                                                |
| `SYNC_CRON_MINUTE`          | no        | `0`                                              | Minute for the nightly sync.                                                                                        |
| `SYNC_TZ`                   | no        | `Pacific/Auckland`                               | IANA timezone for cron.                                                                                             |

## Hosting with HTTP + OAuth (v1.1)

If you want to connect to Bumble from claude.ai (custom MCP connector) or any remote MCP client, run it in HTTP mode behind a tunnel.

### 1. Start Bumble in HTTP mode

```sh
BUMBLE_TRANSPORT=http \
  OAUTH_ISSUER=https://bumble.example.com \
  OAUTH_ADMIN_PASSWORD='change-me' \
  OAUTH_DATA_FILE=$HOME/.bumble/oauth.json \
  AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… \
  DB_PATH=$HOME/.bumble/bumble.db \
  npx -y mcp-bumble
```

Bumble binds to `127.0.0.1:3001` by default and exposes:

- `GET /.well-known/oauth-protected-resource` (RFC 9728)
- `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `POST /register` — dynamic client registration (RFC 7591, public clients only)
- `GET|POST /authorize` — password-gated consent page, then code + redirect
- `POST /token` — code exchange and refresh (PKCE S256 required, RFC 8707 resource indicators required)
- `POST /revoke`
- `POST|GET|DELETE /mcp` — MCP transport (bearer auth, scope `mcp`)

Tokens: opaque, sha256-hashed at rest. Access tokens live 15 minutes; refresh tokens live 90 days and rotate on every use.

### 2. Cloudflare tunnel

Add an ingress rule to the tunnel pointing your public hostname at the local Bumble port. Example `~/.cloudflared/config.yml` snippet:

```yaml
ingress:
  - hostname: bumble.example.com
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true
  # ... other rules ...
  - service: http_status:404
```

DNS-route the hostname through Cloudflare (`cloudflared tunnel route dns <tunnel> bumble.example.com`) and reload the tunnel.

### 3. Connect from claude.ai

In **claude.ai → Settings → Connectors → Add custom connector**, set the server URL to `https://bumble.example.com/mcp`. Claude will discover the OAuth server, register itself dynamically, and pop the consent page in a browser tab — paste your `OAUTH_ADMIN_PASSWORD` and approve. After redirect, the connector will mint tokens and start listing tools.

### Security notes

- The admin password is the only thing standing between an attacker who reaches the tunnel and your bank data. Pick something long. Cloudflare Access policies in front of the tunnel are a sensible additional layer.
- Bumble enforces RFC 8707 audience binding — tokens minted for one resource cannot be replayed against another.
- The OAuth state file (`OAUTH_DATA_FILE`) is created with mode `0600`. Don't put it on a shared filesystem.

## Nightly sync on bare metal

If you're running `mcp-bumble` directly (not via Docker), schedule the sync yourself.

**Linux / macOS (cron):**

```cron
0 2 * * * AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=… DB_PATH=$HOME/.bumble/bumble.db /usr/bin/npx -y mcp-bumble sync >> $HOME/.bumble/sync.log 2>&1
```

**macOS (launchd):** drop a `~/Library/LaunchAgents/nz.akahu.mcp-bumble.sync.plist` that runs `npx -y mcp-bumble sync` on a `StartCalendarInterval` at hour 2.

## Development

```sh
npm install
npm run typecheck
npm test          # 286 tests, vitest + v8 coverage
npm run build     # outputs dist/index.js with shebang
```

Coverage threshold (CI gate): 80% lines & branches. Current coverage tracks ~97% lines.

Repo layout:

```
src/
  index.ts          # entrypoint — routes `sync` vs MCP server (stdio or http)
  cli.ts            # `bumble sync [--now]` CLI
  server.ts         # McpServer wiring (transport-agnostic)
  db/               # Drizzle schema, migrations, openDatabase
  akahu/            # Akahu SDK wrapper + sync pipeline
  lib/              # transfers heuristic, rule engine, cache
  tools/            # MCP tool implementations (one file per group)
  transport/        # stdio.ts (Claude Desktop) + http.ts (claude.ai connector)
  oauth/            # OAuth 2.1 provider, JSON-file state store, consent page
test/
  …                 # mirrors src/ — unit + MCP-SDK integration tests
docker/
  entrypoint.sh     # cron / sync / mcp mode dispatcher
```

## Contributing

PRs welcome. The repo enforces:

- TypeScript strict mode (`tsc --noEmit` must pass)
- ESLint + Prettier (`npm run lint`, `npm run format:check`)
- Vitest with v8 coverage ≥ 80% — CI rejects regressions
- One MCP-SDK integration test per tool, plus unit tests on handlers

Open an issue first if you want to add a tool or change the data model — v1 is intentionally lean and the spec lives in this repo's issues.

## License

MIT — see [LICENSE](./LICENSE).

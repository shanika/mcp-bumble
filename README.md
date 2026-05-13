# Bumble

> MCP server for NZ bank data via [Akahu](https://akahu.nz) — transaction categorization & balance tracking.

Bumble is a self-hostable [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a single household's NZ bank data to MCP clients (Claude Desktop, Claude Code, etc.). It enables an LLM to read balances, browse transactions, categorize spending, and detect internal transfers through natural conversation.

**Status:** v0.x — scaffold. Full v1 spec at [`docs/spec.md`](./docs/spec.md) (TBD).

## Features (v1)

- **Account & balance tools** — `list_accounts`, `get_balances`
- **Transaction tools** — `list_transactions`, `search_transactions`, `list_uncategorized`
- **Categorization** — Akahu NZFCC suggestion → user accepts or overrides; vendor→category rules learned automatically
- **Internal transfer detection** — high-confidence pairs auto-marked overnight; medium-confidence surfaced for one-tap confirmation
- **Nightly sync** — `bumble sync` CLI runs via cron at 02:00 local time; pulls new transactions, marks transfers, applies vendor rules

## Quick start

```sh
# Self-host via npx (Node 20+)
npx mcp-bumble

# Or via Docker
docker compose up
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "bumble": {
      "command": "npx",
      "args": ["mcp-bumble"],
      "env": {
        "AKAHU_APP_TOKEN": "app_token_xxxxx",
        "AKAHU_USER_TOKEN": "user_token_xxxxx"
      }
    }
  }
}
```

### Nightly sync (host cron)

```cron
0 2 * * * /usr/bin/npx mcp-bumble sync >> ~/.bumble/sync.log 2>&1
```

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

See [`docs/spec.md`](./docs/spec.md) for the full v1 specification.

## License

MIT — see [LICENSE](./LICENSE).

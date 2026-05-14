#!/bin/sh
set -eu

# Entrypoint for the mcp-bumble Docker image.
# Modes:
#   mcp         (default) — run the MCP STDIO server. Use `docker compose run`
#               with `-i` (stdin attached) so an MCP client can connect.
#   sync [--now] — run a one-shot sync against Akahu and exit.
#   cron        — run as a long-lived daemon that triggers `bumble sync` on the
#               schedule in SYNC_CRON_HOUR / SYNC_CRON_MINUTE / SYNC_TZ.

SYNC_CRON_HOUR="${SYNC_CRON_HOUR:-2}"
SYNC_CRON_MINUTE="${SYNC_CRON_MINUTE:-0}"
SYNC_TZ="${SYNC_TZ:-Pacific/Auckland}"
export TZ="$SYNC_TZ"

mode="${1:-mcp}"
shift || true

write_crontab() {
  mkdir -p /etc/crontabs /var/log/bumble
  cat >/etc/crontabs/root <<EOF
# mcp-bumble nightly sync (TZ=$SYNC_TZ)
$SYNC_CRON_MINUTE $SYNC_CRON_HOUR * * * /usr/local/bin/node /app/dist/index.js sync >> /var/log/bumble/sync.log 2>&1
EOF
  echo "[bumble] crond schedule: $SYNC_CRON_MINUTE $SYNC_CRON_HOUR * * * (TZ=$SYNC_TZ)" >&2
}

case "$mode" in
  mcp)
    exec /usr/local/bin/node /app/dist/index.js "$@"
    ;;
  sync)
    exec /usr/local/bin/node /app/dist/index.js sync "$@"
    ;;
  cron)
    write_crontab
    # -f foreground, -L log to stderr, -l log level 8 (info)
    exec crond -f -L /dev/stderr -l 8
    ;;
  sh|bash)
    exec "$mode" "$@"
    ;;
  *)
    # Anything else: pass through to node (lets users run e.g. `node --inspect`)
    exec /usr/local/bin/node /app/dist/index.js "$mode" "$@"
    ;;
esac

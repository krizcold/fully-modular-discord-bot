#!/usr/bin/env bash
# smdb - run the Fully Modular Discord Bot console inside a bot container.
#
#   ./smdb.sh <container|bot-id> status       # exec into that bot container
#   SMDB_CONTAINER=name ./smdb.sh status      # container via env
#   SMDB_LOCAL=1 ./smdb.sh status             # host-native (dev build in ./dist), localhost:8080
#
# The first argument may be a container name or a bot-id label (resolved to its
# container). Runs only against loopback inside the target host; nothing remote.
set -euo pipefail

if [ "${SMDB_LOCAL:-}" = "1" ]; then
  exec node "$(dirname "$0")/dist/cli/smdb.js" "$@"
fi

container="${SMDB_CONTAINER:-}"
if [ -z "$container" ]; then
  container="${1:-}"
  shift || true
fi
if [ -z "$container" ]; then
  echo "smdb.sh: give a bot container or bot-id (arg1 / SMDB_CONTAINER), or SMDB_LOCAL=1 for host-native" >&2
  exit 2
fi

# If it isn't a running container name, try to resolve it as a bot-id label.
if ! docker inspect "$container" >/dev/null 2>&1; then
  resolved="$(docker ps --filter "label=bot-id=$container" --format '{{.Names}}' | head -1)"
  [ -n "$resolved" ] && container="$resolved"
fi

exec docker exec -i "$container" node /app/dist/cli/smdb.js "$@"

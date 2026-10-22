#!/usr/bin/env bash
# smdb - run the Fully Modular Discord Bot console inside a bot container.
#
#   ./smdb.sh <container|bot-id> status       # exec into that bot container
#   SMDB_CONTAINER=name ./smdb.sh status      # container via env
#   SMDB_LOCAL=1 ./smdb.sh status             # host-native (dev build in ./dist), localhost:8080
#
# The first argument may be a container name or a bot-id label (resolved to the
# bot's app container, the one that ships the console). Runs only against loopback inside the target host; nothing remote.
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

# If it isn't a container name, resolve it as a bot-id label: of that bot's running
# containers (app, auth proxy, database), the one that ships the console.
if ! docker inspect "$container" >/dev/null 2>&1; then
  matches=()
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if docker exec "$name" test -f /app/dist/cli/smdb.js >/dev/null 2>&1; then matches+=("$name"); fi
  done < <(docker ps --filter "label=bot-id=$container" --format '{{.Names}}')
  if [ "${#matches[@]}" -ne 1 ]; then
    echo "smdb.sh: '$container' is no container, and ${#matches[@]} running containers of bot-id '$container' carry the console; name the container" >&2
    exit 2
  fi
  container="${matches[0]}"
fi

exec docker exec -i "$container" node /app/dist/cli/smdb.js "$@"

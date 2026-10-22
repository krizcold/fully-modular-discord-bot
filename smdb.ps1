# smdb - run the Fully Modular Discord Bot console inside a bot container.
#
#   ./smdb.ps1 <container|bot-id> status       # exec into that bot container
#   $env:SMDB_CONTAINER="name"; ./smdb.ps1 status
#   $env:SMDB_LOCAL="1"; ./smdb.ps1 status     # host-native (dev build in .\dist), localhost:8080
#
# The first argument may be a container name or a bot-id label (resolved to the
# bot's app container, the one that ships the console). Runs only against
# loopback inside the target host; nothing remote.
param([Parameter(ValueFromRemainingArguments = $true)] $Args)

if ($env:SMDB_LOCAL -eq "1") {
  node "$PSScriptRoot/dist/cli/smdb.js" @Args
  exit $LASTEXITCODE
}

$container = $env:SMDB_CONTAINER
if (-not $container) {
  if ($Args.Count -lt 1) {
    Write-Error "smdb.ps1: give a bot container or bot-id (arg1 / SMDB_CONTAINER), or SMDB_LOCAL=1 for host-native"
    exit 2
  }
  $container = $Args[0]
  $Args = $Args[1..($Args.Count - 1)]
}

# If it isn't a container name, resolve it as a bot-id label: of that bot's running
# containers (app, auth proxy, database), the one that ships the console.
docker inspect $container *> $null
if ($LASTEXITCODE -ne 0) {
  $found = @()
  foreach ($name in @(docker ps --filter "label=bot-id=$container" --format '{{.Names}}')) {
    if (-not $name) { continue }
    docker exec $name test -f /app/dist/cli/smdb.js *> $null
    if ($LASTEXITCODE -eq 0) { $found += $name }
  }
  if ($found.Count -ne 1) {
    Write-Error "smdb.ps1: '$container' is no container, and $($found.Count) running containers of bot-id '$container' carry the console; name the container"
    exit 2
  }
  $container = $found[0]
}

docker exec -i $container node /app/dist/cli/smdb.js @Args
exit $LASTEXITCODE

# smdb - run the Fully Modular Discord Bot console inside a bot container.
#
#   ./smdb.ps1 <container|bot-id> status       # exec into that bot container
#   $env:SMDB_CONTAINER="name"; ./smdb.ps1 status
#   $env:SMDB_LOCAL="1"; ./smdb.ps1 status     # host-native (dev build in .\dist), localhost:8080
#
# The first argument may be a container name or a bot-id label. Runs only against
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

# If it isn't a running container name, try to resolve it as a bot-id label.
docker inspect $container *> $null
if ($LASTEXITCODE -ne 0) {
  $resolved = docker ps --filter "label=bot-id=$container" --format '{{.Names}}' | Select-Object -First 1
  if ($resolved) { $container = $resolved }
}

docker exec -i $container node /app/dist/cli/smdb.js @Args
exit $LASTEXITCODE

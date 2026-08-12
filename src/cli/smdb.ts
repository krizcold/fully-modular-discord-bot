/**
 * smdb - console control for the Fully Modular Discord Bot.
 * A loopback-only HTTP client over the bot's own web-panel API. Every verb maps to
 * an existing route, so the console does exactly what the panel does and nothing
 * more - plus `cmd invoke` (synthetic slash-command dispatch) and dev fault hooks.
 */

import { parseArgs, flagStr } from './args';
import { resolveTarget, Client, LoopbackError } from './client';
import { dispatch } from './commands';
import { fail, EXIT_USAGE } from './output';

const HELP = `smdb - Fully Modular Discord Bot console

Usage: smdb [--port N | --url URL | --bot NAME [--manager-port N]] [--json] <command> [args]

Bot:       status | start | restart | shutdown [--emergency] | restart-server
           logs [--webui] [--limit N] [--follow] | logs clear
Setup:     setup status | credentials set --body '{...}' | deployment-mode
Config:    config list|get|backups [--file F] [--guild ID] | config update|restore --body '{...}'
           data get <file> [--guild ID] | data update --body '{...}'
AppStore:  appstore bundle|repos|modules|installed|queue | appstore module <name>
           appstore install <name> --repo <id> [--wait] | appstore uninstall <name> [--wait]
           premium tiers
Panels:    panels list | exec <panelId> | press <panelId> <buttonId> | select <panelId> <dropdownId> --values a,b
           panels modal <panelId> <modalId> --fields '{...}'   [--guild ID] [--user ID] [--channel ID]
Command:   cmd invoke <command> --guild ID [--user ID] [--channel ID] [--options '{...}'] [--force] [--repeat N] [--interval MS]
Dev tab:   devmodules list | reload <name> | reload-all
Update:    update status|check|trigger|check-all|loaded-modules|backups | update module <name> | update all-modules
Usage:     usage global | usage guilds | usage guild <guildId>
Fleet:     fleet state|migrations|resume-assignments | assign --shard N --node ID | declare-lost --node ID | drain --node ID
           fleet migrate --kind move|swap|retire|redistribute --body '{...}' | precheck --kind K --body '{...}'
           fleet abort|resume --migration ID | corrupt-lease --shard N (dev hook)
Transform: transform start [--direction file-to-postgres|postgres-to-file] | pause | resume | abort | status
Data:      bundle export <guildId> <file> | bundle import <file>
           graveyard list | graveyard restore <guildId> [retiredAt | --retired-at MS]
Raw:       api <METHOD> <path> [--body JSON] | events [--filter PREFIX] [--timeout S]
           wait --get <path> --until <expr> [--interval MS] [--timeout S] | health

Global flags:
  --port N          target 127.0.0.1:N (default: $WEBUI_PORT or 8080)
  --url URL         loopback URL override (rejected if not 127.0.0.1/::1/localhost)
  --bot NAME        resolve this instance's host port via the local manager, then target it
  --manager-port N  manager port for --bot resolution (default 8090)
  --json            force JSON output (also implied when stdout is not a TTY)
  --wait            block on the terminal WebSocket event for async verbs (install/uninstall)
  --timeout S       seconds before --wait / wait / SSE gives up
`;

/** Ask the local manager for a named instance's published host port. */
async function resolvePortViaManager(botName: string, managerPort: number): Promise<number> {
  const manager = new Client({ host: '127.0.0.1', port: managerPort });
  const res = await manager.request('GET', '/api/bots');
  const bots = ((res.body as { bots?: Array<Record<string, unknown>> })?.bots) || [];
  const hit = bots.find((b) => b.displayName === botName || b.sanitizedName === botName || b.id === botName);
  if (!hit) throw new LoopbackError(`manager on :${managerPort} knows no bot '${botName}'`);
  const port = hit.hostPort;
  if (typeof port !== 'number') throw new LoopbackError(`bot '${botName}' has no published host port (not running in docker mode?)`);
  return port;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(positionals.length === 0 ? EXIT_USAGE : 0);
  }

  let client: Client;
  try {
    const botName = flagStr(flags, 'bot');
    if (botName) {
      const managerPort = parseInt(flagStr(flags, 'manager-port') || '8090', 10);
      const port = await resolvePortViaManager(botName, managerPort);
      client = new Client({ host: '127.0.0.1', port });
    } else {
      client = new Client(resolveTarget({ url: flagStr(flags, 'url'), port: flagStr(flags, 'port') }));
    }
  } catch (err) {
    if (err instanceof LoopbackError) fail(err.message, EXIT_USAGE);
    throw err;
  }

  await dispatch(client, positionals, flags);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

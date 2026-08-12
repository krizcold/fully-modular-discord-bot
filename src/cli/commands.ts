/**
 * smdb verb registry. Each verb maps 1:1 onto an existing bot web-panel route; the
 * CLI holds no business logic. Uncurated or future routes are reachable via `api`.
 * The one exception is `bundle`, which calls the same dataInterchange primitives as
 * src/tools/dataBundle.ts so export/import round-trips run from one entry point.
 */

import * as path from 'path';
import { Client, CliResponse } from './client';
import { emit, printJson, fail, table, jsonMode, EXIT_OK, EXIT_ERR, EXIT_TIMEOUT, EXIT_USAGE } from './output';
import { flagStr, flagInt } from './args';
import { waitForEvent, pollUntil } from './waiter';
import { DATA_ROOT } from '../utils/dataRoot';
import { importNamespace, readBundle, writeBundle } from '../bot/internalSetup/utils/dataInterchange';

interface Ctx {
  client: Client;
  args: string[];
  flags: Record<string, string | boolean>;
}

const DEFAULT_WAIT_MS = 120_000;

function need(ctx: Ctx, idx: number, label: string): string {
  const v = ctx.args[idx];
  if (!v) fail(`missing argument: ${label}`, EXIT_USAGE);
  return v as string;
}

function timeoutMs(ctx: Ctx, fallback: number): number {
  const secs = flagInt(ctx.flags, 'timeout', 0);
  return secs > 0 ? secs * 1000 : fallback;
}

function parseBody(ctx: Ctx, required: boolean): unknown {
  const raw = flagStr(ctx.flags, 'body');
  if (raw === undefined) {
    if (required) fail('--body <json> is required', EXIT_USAGE);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fail('--body must be valid JSON', EXIT_USAGE);
  }
}

function parseJsonFlag(ctx: Ctx, name: string): unknown {
  const raw = flagStr(ctx.flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return fail(`--${name} must be valid JSON`, EXIT_USAGE);
  }
}

/** Common panel context flags shared by execute/button/dropdown/modal. */
function panelContext(ctx: Ctx): Record<string, unknown> {
  const c: Record<string, unknown> = { userId: flagStr(ctx.flags, 'user') || 'web-ui-owner' };
  const guild = flagStr(ctx.flags, 'guild');
  const channel = flagStr(ctx.flags, 'channel');
  if (guild) c.guildId = guild;
  if (channel) c.channelId = channel;
  return c;
}

async function simple(ctx: Ctx, method: string, path: string, body?: unknown, human?: (b: unknown) => void): Promise<void> {
  const res = await ctx.client.request(method, path, { body });
  emit(res, ctx.flags, human);
}

/** Query-string builder that only emits present keys. */
function qs(pairs: Record<string, string | undefined>): string {
  const parts = Object.entries(pairs).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
  return parts.length ? '?' + parts.join('&') : '';
}

type Handler = (ctx: Ctx) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  // --- control (mounted at /api/bot) ---
  status: (c) => simple(c, 'GET', '/api/bot/status'),
  start: (c) => simple(c, 'POST', '/api/bot/start'),
  restart: (c) => simple(c, 'POST', '/api/bot/restart'),
  shutdown: (c) => simple(c, 'POST', '/api/bot/shutdown', { emergency: Boolean(c.flags.emergency) }),
  'restart-server': (c) => simple(c, 'POST', '/api/bot/restart-server'),
  'logs': (c) => {
    if (c.flags.follow) return streamWsLogs(c);
    const base = c.flags.webui ? '/api/bot/logs/webui' : '/api/bot/logs';
    return simple(c, 'GET', `${base}?limit=${flagInt(c.flags, 'limit', 100)}`);
  },
  'logs clear': (c) => simple(c, 'POST', '/api/bot/logs/clear'),

  // --- setup ---
  'setup status': (c) => simple(c, 'GET', '/api/setup/status'),
  'credentials set': (c) => simple(c, 'POST', '/api/setup/credentials', parseBody(c, true)),
  'deployment-mode': (c) => simple(c, 'GET', '/api/setup/deployment-mode'),

  // --- config + data (mounted at /api/config) ---
  'config list': (c) => simple(c, 'GET', `/api/config/list${qs({ guildId: flagStr(c.flags, 'guild') })}`),
  'config get': (c) => simple(c, 'GET', `/api/config/get${qs({ file: flagStr(c.flags, 'file'), guildId: flagStr(c.flags, 'guild') })}`),
  'config update': (c) => simple(c, 'POST', '/api/config/update', parseBody(c, true)),
  'config backups': (c) => simple(c, 'GET', `/api/config/backups${qs({ file: flagStr(c.flags, 'file') })}`),
  'config restore': (c) => simple(c, 'POST', '/api/config/restore', parseBody(c, true)),
  'data get': (c) => simple(c, 'GET', `/api/config/data/get${qs({ file: need(c, 0, 'file'), guildId: flagStr(c.flags, 'guild') })}`),
  'data update': (c) => simple(c, 'POST', '/api/config/data/update', parseBody(c, true)),

  // --- appstore ---
  'appstore bundle': (c) => simple(c, 'GET', '/api/appstore/bundle'),
  'appstore repos': (c) => simple(c, 'GET', '/api/appstore/repos'),
  'appstore modules': (c) => simple(c, 'GET', '/api/appstore/modules'),
  'appstore module': (c) => simple(c, 'GET', `/api/appstore/modules/${encodeURIComponent(need(c, 0, 'name'))}`),
  'appstore installed': (c) =>
    simple(c, 'GET', '/api/appstore/installed', undefined, (b) =>
      table(((b as { modules?: Record<string, unknown>[] }).modules) || [], ['name', 'version', 'loaded']),
    ),
  'appstore queue': (c) => simple(c, 'GET', '/api/appstore/install-queue'),
  'appstore install': (c) => {
    const name = need(c, 0, 'name');
    const repoId = flagStr(c.flags, 'repo');
    if (!repoId) fail('--repo <id> is required', EXIT_USAGE);
    const path = `/api/appstore/modules/${encodeURIComponent(name)}/install`;
    return installLifecycle(c, name, () => c.client.request('POST', path, { body: { repoId } }));
  },
  'appstore uninstall': (c) => {
    const name = need(c, 0, 'name');
    const path = `/api/appstore/modules/${encodeURIComponent(name)}`;
    return installLifecycle(c, name, () => c.client.request('DELETE', path));
  },
  'premium tiers': (c) => simple(c, 'GET', '/api/appstore/premium/tiers'),

  // --- panels (headless interaction surface) ---
  'panels list': (c) => simple(c, 'GET', '/api/panels/list'),
  'panels exec': (c) => simple(c, 'POST', '/api/panels/execute', { panelId: need(c, 0, 'panelId'), ...panelContext(c) }),
  'panels press': (c) =>
    simple(c, 'POST', '/api/panels/button', { panelId: need(c, 0, 'panelId'), buttonId: need(c, 1, 'buttonId'), ...panelContext(c) }),
  'panels select': (c) =>
    simple(c, 'POST', '/api/panels/dropdown', {
      panelId: need(c, 0, 'panelId'),
      dropdownId: need(c, 1, 'dropdownId'),
      values: (flagStr(c.flags, 'values') || '').split(',').filter(Boolean),
      ...panelContext(c),
    }),
  'panels modal': (c) =>
    simple(c, 'POST', '/api/panels/modal', {
      panelId: need(c, 0, 'panelId'),
      modalId: need(c, 1, 'modalId'),
      fields: parseJsonFlag(c, 'fields') || {},
      ...panelContext(c),
    }),

  // --- command invocation (console-exclusive synthetic dispatch) ---
  'cmd invoke': (c) => cmdInvoke(c),

  // --- devmodules (master-only) ---
  'devmodules list': (c) => simple(c, 'GET', '/api/devmodules/list'),
  'devmodules reload': (c) => simple(c, 'POST', `/api/devmodules/${encodeURIComponent(need(c, 0, 'name'))}/reload`),
  'devmodules reload-all': (c) => simple(c, 'POST', '/api/devmodules/reload-all'),

  // --- update ---
  'update status': (c) => simple(c, 'GET', '/api/update/status'),
  'update check': (c) => simple(c, 'POST', '/api/update/check'),
  'update trigger': (c) => simple(c, 'POST', '/api/update/trigger'),
  'update check-all': (c) => simple(c, 'POST', '/api/update/check-all'),
  'update module': (c) => simple(c, 'POST', `/api/update/modules/${encodeURIComponent(need(c, 0, 'name'))}`),
  'update all-modules': (c) => simple(c, 'POST', '/api/update/modules'),
  'update loaded-modules': (c) => simple(c, 'GET', '/api/update/loaded-modules'),
  'update backups': (c) => simple(c, 'GET', '/api/update/backups'),

  // --- usage ---
  'usage global': (c) => simple(c, 'GET', '/api/usage/global'),
  'usage guilds': (c) => simple(c, 'GET', '/api/usage/guilds'),
  'usage guild': (c) => simple(c, 'GET', `/api/usage/guild/${encodeURIComponent(need(c, 0, 'guildId'))}`),

  // --- fleet control plane ---
  'fleet state': (c) => simple(c, 'GET', '/api/fleet/state'),
  'fleet assign': (c) => simple(c, 'POST', '/api/fleet/assign', { shardId: flagInt(c.flags, 'shard', -1), nodeId: flagStr(c.flags, 'node') || '' }),
  'fleet resume-assignments': (c) => simple(c, 'POST', '/api/fleet/resume-assignments'),
  'fleet declare-lost': (c) => simple(c, 'POST', '/api/fleet/declare-lost', { nodeId: flagStr(c.flags, 'node') || '' }),
  'fleet drain': (c) => simple(c, 'POST', '/api/fleet/drain', { nodeId: flagStr(c.flags, 'node') || '' }),
  'fleet migrate': (c) => simple(c, 'POST', '/api/fleet/migrate', { kind: flagStr(c.flags, 'kind'), ...(parseBody(c, false) as object || {}) }),
  'fleet precheck': (c) => simple(c, 'POST', '/api/fleet/migrate/precheck', { kind: flagStr(c.flags, 'kind'), ...(parseBody(c, false) as object || {}) }),
  'fleet abort': (c) => simple(c, 'POST', '/api/fleet/migrate/abort', { migrationId: flagStr(c.flags, 'migration') || '' }),
  'fleet resume': (c) => simple(c, 'POST', '/api/fleet/migrate/resume', { migrationId: flagStr(c.flags, 'migration') || '' }),
  'fleet migrations': (c) => simple(c, 'GET', '/api/fleet/migrations'),
  // Dev-only fault hook (route is inert unless FLEET_DEV_HOOKS=1 on the bot).
  'fleet corrupt-lease': (c) => simple(c, 'POST', '/api/fleet/dev/corrupt-lease', { shardId: flagInt(c.flags, 'shard', -1) }),

  // --- backend transformation (spec 3.2) ---
  'transform start': (c) => {
    const direction = flagStr(c.flags, 'direction');
    return simple(c, 'POST', '/api/fleet/transform', direction ? { direction } : {});
  },
  'transform pause': (c) => simple(c, 'POST', '/api/fleet/transform/pause'),
  'transform resume': (c) => simple(c, 'POST', '/api/fleet/transform/resume'),
  'transform abort': (c) => simple(c, 'POST', '/api/fleet/transform/abort'),
  'transform status': (c) =>
    simple(c, 'GET', '/api/fleet/state', undefined, (b) => {
      const t = (b as { transformation?: unknown }).transformation;
      console.log(JSON.stringify(t ?? null, null, 2));
    }),

  // --- data bundle round-trip (local disk, same primitives as tools/dataBundle) ---
  'bundle export': (c) => bundleExport(c),
  'bundle import': (c) => bundleImport(c),

  // --- graveyard (retired guild namespaces, spec 4.4) ---
  'graveyard list': (c) =>
    simple(c, 'GET', '/api/data/graveyard', undefined, (b) =>
      table(((b as { entries?: Record<string, unknown>[] }).entries) || [], ['guildId', 'retiredAt', 'reason', 'rows', 'backend']),
    ),
  'graveyard restore': (c) => {
    const guildId = need(c, 0, 'guildId');
    const raw = flagStr(c.flags, 'retired-at') ?? c.args[1];
    const body: Record<string, unknown> = { guildId };
    if (raw !== undefined) {
      const retiredAt = Number(raw);
      if (!Number.isFinite(retiredAt)) fail('retiredAt must be a number (ms)', EXIT_USAGE);
      body.retiredAt = retiredAt;
    }
    return simple(c, 'POST', '/api/data/graveyard/restore', body);
  },

  // --- misc + cross-cutting ---
  health: (c) => simple(c, 'GET', '/api/health'),
  api: async (c) => {
    const method = need(c, 0, 'METHOD').toUpperCase();
    const p = need(c, 1, 'path');
    const res: CliResponse = await c.client.request(method, p, { body: parseBody(c, false) });
    emit(res, c.flags);
  },
  events: async (c) => {
    const filter = flagStr(c.flags, 'filter');
    const tmo = timeoutMs(c, 0);
    const conn = c.client.openWs((msg) => {
      if (filter && !msg.type.startsWith(filter)) return;
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    });
    if (tmo > 0) setTimeout(() => { conn.close(); process.exit(EXIT_OK); }, tmo);
  },
  wait: async (c) => {
    const p = flagStr(c.flags, 'get');
    const expr = flagStr(c.flags, 'until');
    if (!p || !expr) fail('wait requires --get <path> and --until <expr>', EXIT_USAGE);
    const result = await pollUntil(c.client, {
      path: p as string,
      expr: expr as string,
      intervalMs: flagInt(c.flags, 'interval', 1000),
      timeoutMs: timeoutMs(c, 60_000),
    });
    printJson(result.body);
    process.exit(result.ok ? EXIT_OK : EXIT_TIMEOUT);
  },
};

/** Install/uninstall: fire-and-report, or block on the appstore queue completion event. */
async function installLifecycle(ctx: Ctx, moduleName: string, trigger: () => Promise<CliResponse>): Promise<void> {
  if (!ctx.flags.wait) {
    const res = await trigger();
    emit(res, ctx.flags);
  }
  try {
    const outcome = await waitForEvent(
      ctx.client,
      {
        successTypes: ['appstore:install:completed', 'appstore:uninstall:completed'],
        failTypes: ['appstore:install:failed', 'appstore:uninstall:failed', 'appstore:install:cancelled', 'appstore:uninstall:cancelled'],
        matchName: moduleName,
        timeoutMs: timeoutMs(ctx, DEFAULT_WAIT_MS),
      },
      async () => {
        const res = await trigger();
        const b = res.body as { success?: boolean; error?: string } | null;
        if (!res.ok || (b && b.success === false)) throw new Error(b?.error || `HTTP ${res.status}`);
      },
    );
    if (jsonMode(ctx.flags)) printJson({ success: outcome.ok, event: outcome.event });
    else process.stdout.write(`${outcome.event.type}\n`);
    process.exit(outcome.ok ? EXIT_OK : EXIT_ERR);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), EXIT_ERR);
  }
}

/** Live bot logs via the /ws bot:log channel. */
function streamWsLogs(ctx: Ctx): Promise<void> {
  return new Promise(() => {
    ctx.client.openWs((msg) => {
      if (msg.type !== 'bot:log') return;
      const d = msg.data as { line?: string };
      process.stdout.write(`${d.line ?? JSON.stringify(msg.data)}\n`);
    });
  });
}

/** POST /api/commands/invoke, with optional client-side repeat loop for kill drills. */
async function cmdInvoke(ctx: Ctx): Promise<void> {
  const command = need(ctx, 0, 'command');
  const body = {
    command,
    guildId: flagStr(ctx.flags, 'guild'),
    channelId: flagStr(ctx.flags, 'channel'),
    userId: flagStr(ctx.flags, 'user'),
    options: parseJsonFlag(ctx, 'options') || {},
    force: Boolean(ctx.flags.force),
  };
  const repeatRaw = flagStr(ctx.flags, 'repeat');
  const repeat = repeatRaw === 'forever' ? Infinity : flagInt(ctx.flags, 'repeat', 1);
  const intervalMs = flagInt(ctx.flags, 'interval', 0);

  if (repeat <= 1 && repeatRaw !== 'forever') {
    return simple(ctx, 'POST', '/api/commands/invoke', body);
  }
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < repeat; i++) {
    try {
      const res = await ctx.client.request('POST', '/api/commands/invoke', { body });
      const b = res.body as { success?: boolean } | null;
      if (res.ok && !(b && b.success === false)) ok++;
      else failed++;
    } catch {
      failed++;
    }
    if (intervalMs > 0 && i < repeat - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  printJson({ command, repeated: ok + failed, ok, failed });
  process.exit(failed > 0 ? EXIT_ERR : EXIT_OK);
}

async function bundleExport(ctx: Ctx): Promise<void> {
  const guildId = need(ctx, 0, 'guildId');
  const file = need(ctx, 1, 'file');
  const summary = await writeBundle(guildId, file);
  printJson({ guildId, file, ...summary });
  process.exit(EXIT_OK);
}

async function bundleImport(ctx: Ctx): Promise<void> {
  const file = need(ctx, 0, 'file');
  const gen = readBundle(file);
  const first = await gen.next();
  if (first.done) fail('bundle is empty; nothing to import', EXIT_ERR);
  const firstRecord = first.value;
  const guildId = firstRecord.guildId;
  async function* full() {
    yield firstRecord;
    yield* gen;
  }
  const destDir = path.join(DATA_ROOT, guildId);
  const result = await importNamespace(guildId, full(), destDir);
  printJson({ guildId, destDir, ...result });
  process.exit(EXIT_OK);
}

export async function dispatch(client: Client, positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const two = positionals.slice(0, 2).join(' ');
  const one = positionals[0] || '';
  const handler = HANDLERS[two] || HANDLERS[one];
  if (!handler) fail(`unknown command: ${positionals.join(' ') || '(none)'} (try 'smdb --help')`, EXIT_USAGE);
  const consumed = HANDLERS[two] ? 2 : 1;
  await handler({ client, args: positionals.slice(consumed), flags });
}

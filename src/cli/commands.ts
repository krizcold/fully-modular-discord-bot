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
import { bundleRefusal, importBundle, readBundle, writeBundle } from '../bot/internalSetup/utils/dataInterchange';

interface Ctx {
  client: Client;
  args: string[];
  flags: Record<string, string | boolean>;
}

const DEFAULT_WAIT_MS = 120_000;
const RESTORE_MINUTE = "Within a minute, if it was restored, the server's data is back and its entry is gone from `smdb graveyard list`; if not, the entry is still listed, unless it had passed the graveyard's keep time and the graveyard sweep removed it, data and all.";

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

/** A fleet state the child could not answer is a failure. */
export function asFleetStateFailure(res: CliResponse): CliResponse {
  const b = res.body as { reachable?: unknown } | null;
  if (b && typeof b === 'object' && b.reachable === false) return { ...res, body: { ...b, success: false } };
  return res;
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
  'config backups': (c) => simple(c, 'GET', `/api/config/backups${qs({ file: flagStr(c.flags, 'file'), guildId: flagStr(c.flags, 'guild'), category: flagStr(c.flags, 'category') })}`),
  'config restore': (c) => simple(c, 'POST', '/api/config/restore', parseBody(c, true)),
  'data get': (c) => simple(c, 'GET', `/api/config/data/get${qs({ file: need(c, 0, 'file'), guildId: flagStr(c.flags, 'guild') })}`),
  'data migrate': (c) => dataMigrate(c),
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

  // --- devmodules ---
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

  // --- fleet ---
  'fleet state': async (c) => {
    const res = await c.client.request('GET', '/api/fleet/state', {});
    emit(asFleetStateFailure(res), c.flags);
  },

  // --- data bundle round-trip (local disk, same primitives as tools/dataBundle) ---
  'bundle export': (c) => bundleExport(c),
  'bundle import': (c) => bundleImport(c),

  // --- graveyard (retired guild namespaces, spec 4.4) ---
  'graveyard list': (c) =>
    simple(c, 'GET', '/api/data/graveyard', undefined, (b) =>
      table(((b as { entries?: Record<string, unknown>[] }).entries) || [], ['guildId', 'retiredAt', 'reason', 'rows', 'backend']),
    ),
  'graveyard restore': async (c) => {
    const guildId = need(c, 0, 'guildId');
    const raw = flagStr(c.flags, 'retired-at') ?? c.args[1];
    const body: Record<string, unknown> = { guildId };
    if (raw !== undefined) {
      const retiredAt = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(retiredAt)) fail('retiredAt must be a whole number of milliseconds', EXIT_USAGE);
      body.retiredAt = retiredAt;
    }
    let res: CliResponse;
    try {
      res = await c.client.request('POST', '/api/data/graveyard/restore', { body });
    } catch {
      // No whole answer: the restore may have run.
      fail(`can't confirm whether server ${guildId} was restored: the web UI did not answer. ${RESTORE_MINUTE}`, EXIT_ERR);
    }
    emit(res, c.flags, (b) => {
      const answer = b as { success?: unknown; retiredAt?: unknown; reason?: unknown; moved?: unknown };
      if (answer?.success !== true || typeof answer.retiredAt !== 'number') return;
      process.stdout.write(`restored server ${guildId} from the entry deleted at ${new Date(answer.retiredAt).toISOString()} (retiredAt ${answer.retiredAt}, reason ${String(answer.reason ?? '')})\n`);
      if (typeof answer.moved === 'number') process.stdout.write(`${answer.moved} row(s) moved\n`);
      if (typeof (answer as { warning?: unknown }).warning === 'string') process.stderr.write(`smdb: warning: ${(answer as { warning: string }).warning}\n`);
    });
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
  const panel = await ctx.client.panelAnswers();
  const refusal = bundleRefusal(guildId, panel.bot, panel.migration);
  if (refusal) fail(`bundle export refused: ${refusal}`, EXIT_ERR);
  let summary;
  try {
    summary = await writeBundle(guildId, file);
  } catch (error) {
    fail(`bundle export failed, nothing written to ${file}: ${error instanceof Error ? error.message : String(error)}`, EXIT_ERR);
  }
  printJson({ guildId, file, source: path.join(DATA_ROOT, guildId), ...summary });
  process.exit(EXIT_OK);
}

async function bundleImport(ctx: Ctx): Promise<void> {
  const file = need(ctx, 0, 'file');
  let guildId: string;
  const gen = readBundle(file);
  try {
    const first = await gen.next();
    if (first.done) fail('bundle is empty; nothing to import', EXIT_ERR);
    guildId = (first.value as { guildId: string }).guildId;
  } catch (error) {
    fail(`bundle import refused: ${error instanceof Error ? error.message : String(error)}`, EXIT_ERR);
  } finally {
    await gen.return(undefined);
  }
  const panel = await ctx.client.panelAnswers();
  const refusal = bundleRefusal(guildId!, panel.bot, panel.migration);
  if (refusal) fail(`bundle import refused: ${refusal}`, EXIT_ERR);
  let result;
  try {
    result = await importBundle(file);
  } catch (error) {
    fail(`bundle import failed: ${error instanceof Error ? error.message : String(error)}`, EXIT_ERR);
  }
  printJson(result);
  process.exit(EXIT_OK);
}

type MigrateClient = Pick<Client, 'request'>;

const MIGRATE_STATUS_CMD = 'smdb api GET /api/data/migrate';
const MIGRATE_REQUEST_MS = 30_000;

async function migrateBotRuns(client: MigrateClient): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const res = await client.request('GET', '/api/bot/status', { timeoutMs: 5000 });
    const running = res.status === 200 && res.body && typeof res.body === 'object' ? (res.body as { status?: { running?: unknown } }).status?.running : undefined;
    return running === true ? 'yes' : running === false ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function migrateNextStep(bot: 'yes' | 'no' | 'unknown'): string {
  if (bot === 'no') return 'the bot is stopped: start it (smdb start)';
  if (bot === 'yes') return 'the bot runs; restart it if it runs in maintenance';
  return "can't confirm whether the bot runs: start the bot if it is stopped (smdb start)";
}

/**
 * `data migrate --to postgres|file`: asks the panel to migrate to DATA_BACKEND_URL (no URL is sent) and follows the
 * job the answer names until it ends. Exits 0 only when the migration is done.
 */
export async function runMigrate(client: MigrateClient, to: 'postgres' | 'file', opts: { intervalMs: number; timeoutMs: number }): Promise<{ code: number; message: string; body?: unknown }> {
  const cantConfirmStart = `can't confirm whether the migration started; check with: ${MIGRATE_STATUS_CMD}`;
  let posted: CliResponse;
  try {
    posted = await client.request('POST', '/api/data/migrate', { body: { to }, timeoutMs: MIGRATE_REQUEST_MS });
  } catch (error) {
    return { code: EXIT_ERR, message: `${cantConfirmStart} (${error instanceof Error ? error.message : String(error)})` };
  }
  if (posted.status >= 500 && !(posted.body && typeof posted.body === 'object' && (posted.body as { success?: unknown }).success === false)) {
    return { code: EXIT_ERR, message: `${cantConfirmStart} (HTTP ${posted.status})`, body: posted.body };
  }
  const answer = (posted.body && typeof posted.body === 'object' ? posted.body : {}) as Record<string, unknown>;
  const jobId = typeof answer.jobId === 'string' ? answer.jobId : null;
  if (jobId && answer.to !== undefined && answer.to !== to) {
    return { code: EXIT_ERR, message: `migration ${jobId} (--to ${String(answer.to)}) is not a migration to ${to}; not following it${answer.error ? `: ${String(answer.error)}` : ''}`, body: answer };
  }
  if (answer.success !== true || !jobId) {
    return { code: EXIT_ERR, message: `migration refused: ${String(answer.error ?? `HTTP ${posted.status}`)}`, body: answer };
  }
  const done = async () => `migration ${jobId} is done; ${migrateNextStep(await migrateBotRuns(client))}`;
  if (answer.state === 'done') return { code: EXIT_OK, message: await done(), body: answer };
  if (answer.state === 'failed' || answer.state === 'interrupted') {
    return { code: EXIT_ERR, message: `migration ${jobId} ${String(answer.state)} at ${String(answer.stage ?? 'an unknown stage')}: ${String(answer.error ?? '')}`, body: answer };
  }
  const cantConfirm = `can't confirm the outcome of migration ${jobId}`;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, opts.intervalMs));
    let res: CliResponse;
    try {
      res = await client.request('GET', '/api/data/migrate', { timeoutMs: MIGRATE_REQUEST_MS });
    } catch (error) {
      if (Date.now() >= deadline) {
        return { code: EXIT_TIMEOUT, message: `${cantConfirm}; the last status request failed (${error instanceof Error ? error.message : String(error)}); check with: ${MIGRATE_STATUS_CMD}` };
      }
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (Date.now() >= deadline) return { code: EXIT_TIMEOUT, message: `${cantConfirm}; the last status request failed (HTTP ${res.status}); check with: ${MIGRATE_STATUS_CMD}`, body: res.body };
      continue;
    }
    const body = (res.body && typeof res.body === 'object' ? res.body : {}) as { success?: unknown; error?: unknown; job?: Record<string, unknown> | null };
    if (body.success !== true) return { code: EXIT_ERR, message: `${cantConfirm}: ${String(body.error ?? `HTTP ${res.status}`)}`, body };
    const job = body.job;
    if (job && job.jobId !== jobId && job.state !== 'running') {
      return { code: EXIT_ERR, message: `${cantConfirm}; the status names migration ${String(job.jobId)} instead; check with: ${MIGRATE_STATUS_CMD}`, body };
    }
    if (!job || job.jobId !== jobId) {
      if (Date.now() >= deadline) return { code: EXIT_TIMEOUT, message: `${cantConfirm}; no status of it came back in time`, body };
      continue;
    }
    if (job.to !== to) return { code: EXIT_ERR, message: `migration ${jobId} is a migration to ${String(job.to)}, not ${to}`, body };
    if (job.state === 'done') return { code: EXIT_OK, message: await done(), body };
    if (job.state === 'failed' || job.state === 'interrupted') {
      return { code: EXIT_ERR, message: `migration ${jobId} ${String(job.state)} at ${String(job.stage)}: ${String(job.error ?? '')}`, body };
    }
    if (Date.now() >= deadline) return { code: EXIT_TIMEOUT, message: `migration ${jobId} still runs; follow it with: smdb api GET /api/data/migrate`, body };
  }
}

async function dataMigrate(ctx: Ctx): Promise<void> {
  const to = flagStr(ctx.flags, 'to');
  if (to !== 'postgres' && to !== 'file') fail('data migrate needs --to postgres or --to file', EXIT_USAGE);
  process.exitCode = EXIT_ERR;
  const result = await runMigrate(ctx.client, to as 'postgres' | 'file', { intervalMs: 2000, timeoutMs: timeoutMs(ctx, 6 * 60 * 60_000) });
  printJson(result.body ?? {});
  process.stderr.write(`smdb: ${result.message}\n`);
  process.exit(result.code);
}

export async function dispatch(client: Client, positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const two = positionals.slice(0, 2).join(' ');
  const one = positionals[0] || '';
  const handler = HANDLERS[two] || HANDLERS[one];
  if (!handler) fail(`unknown command: ${positionals.join(' ') || '(none)'} (try 'smdb --help')`, EXIT_USAGE);
  const consumed = HANDLERS[two] ? 2 : 1;
  await handler({ client, args: positionals.slice(consumed), flags });
}

// NB5 decision 23: the owner channel setting, read and written only by the web UI process. On a Postgres bot it is the
// owner_channel row of smdb_data.meta in the main database; on a JSON bot, /data/owner-channel.json.

import fs from 'fs';
import { dataPath } from '../../utils/dataRoot';
import { resolveDataBackend } from '../../utils/envLoader';
import { pgConfig, showEntry } from '../../utils/databaseAddress';
import { atomicWriteFileSync } from '../../bot/internalSetup/utils/atomicWrite';
import { shortLivedClient } from '../../bot/internalSetup/utils/pgClient';
import { ownerChannelFromFile, ownerChannelOf, type OwnerChannelValue } from '../../bot/internalSetup/utils/dataBackends/mainDatabase';
import { channelCause, postInPlace } from '../../utils/ownerMessages';
import type { RunningMigration } from '../../bot/internalSetup/utils/dataMigration';
import {
  CHOOSING_REFUSAL, STARTING_REFUSAL, chooseNow, getWebuiDataReader, resolveWebuiDatabase, unreachableReason,
  webuiChildCase, webuiReportCount, type WebuiResolution,
} from './webuiDataReader';

const SETTING_APP = 'smdb-webui-setting';
const SESSION_BOUND_MS = 5_000;
const TEST_POST_MS = 10_000;
const TEST_POST_TEXT = "Owner messages from this bot's Bot Manager will be posted here, with a copy of each switch notice; the switch notices themselves stay in the owner's DMs.";

export function ownerChannelFile(): string {
  return dataPath('owner-channel.json');
}

/** Decision 14's key record of the notify-owner route. */
export function ownerMessagesFile(): string {
  return dataPath('owner-messages.json');
}

interface OwnerChannelDeps {
  /** The owner_channel row's value on the web UI's reader pool, null for none. */
  readRow(boundMs: number): Promise<unknown | null>;
  /** The bound of that read (5 s). */
  readMs: number;
  /** How long after the write session's connect answer its mark lasts when the write got no answer (10 s). */
  markAfterConnectMs: number;
}

const realDeps: OwnerChannelDeps = {
  readRow: boundMs => getWebuiDataReader().ownerChannelRow(boundMs),
  readMs: 5_000,
  markAfterConnectMs: 10_000,
};
let deps: OwnerChannelDeps = realDeps;

export function _setOwnerChannelDeps(over: Partial<OwnerChannelDeps> | null): void {
  deps = over ? { ...realDeps, ...over } : realDeps;
}

let lastRefusal: { channelId: string; at: string; text: string } | null = null;
let putChain: Promise<unknown> = Promise.resolve();

export function _resetOwnerChannel(): void {
  lastRefusal = null;
  putChain = Promise.resolve();
}

/** The last refusal in the chosen channel, kept in memory for the panel; dropped by a post there or a new setting. */
export function noteChannelRefusal(channelId: string, cause: string): void {
  lastRefusal = { channelId, at: new Date().toISOString(), text: cause };
}

export function noteChannelPosted(channelId: string): void {
  if (lastRefusal?.channelId === channelId) lastRefusal = null;
}

export function ownerChannelState(): { lastRefusal: { channelId: string; at: string; text: string } | null } {
  return { lastRefusal };
}

function causeOf(error: unknown): string {
  const reason = unreachableReason(error);
  if (reason !== null) return reason;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `SQLSTATE ${code}: ${message}` : message;
}

/** The setting as the web UI reads it: the file on a JSON bot; on Postgres one SELECT through decision 17's resolution. */
export async function readOwnerChannelSetting(): Promise<OwnerChannelValue> {
  if (resolveDataBackend() !== 'postgres') return ownerChannelFromFile(ownerChannelFile());
  const resolved = resolveWebuiDatabase();
  if ('refusal' in resolved) return { kind: 'unreadable', cause: resolved.refusal };
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), deps.readMs); });
  try {
    const value = await Promise.race([deps.readRow(deps.readMs), bound]);
    if (value === 'timeout') return { kind: 'unreadable', cause: 'the database did not answer within 5 s' };
    return value === null || value === undefined ? { kind: 'none' } : ownerChannelOf(value);
  } catch (error) {
    return { kind: 'unreadable', cause: causeOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/setup/owner-channel. */
export async function ownerChannelView(): Promise<Record<string, unknown>> {
  const value = await readOwnerChannelSetting();
  if (value.kind === 'unreadable') return { readable: false, reason: value.cause };
  const channelId = value.kind === 'id' ? value.id : null;
  const refusal = lastRefusal && lastRefusal.channelId === channelId ? { at: lastRefusal.at, text: lastRefusal.text } : null;
  return { readable: true, channelId, lastRefusal: refusal };
}

export type RowWrite =
  | { kind: 'ok' }
  | { kind: 'not-saved'; cause: string }
  | { kind: 'unknown'; cause: string; connectedAt: number };

/**
 * The setting's one statement on a short-lived session of its own to the entry the PUT's last check resolved. Its
 * startup packet carries statement_timeout and idle_session_timeout, so no statement of it runs on the server 10 s after
 * the connect answered.
 */
export async function writeOwnerChannelRow(entry: string, channelId: string | null): Promise<RowWrite> {
  const client = shortLivedClient({
    application_name: SETTING_APP,
    connectionTimeoutMillis: SESSION_BOUND_MS,
    options: `-c statement_timeout=${SESSION_BOUND_MS} -c idle_session_timeout=${SESSION_BOUND_MS}`,
    query_timeout: SESSION_BOUND_MS,
    ...pgConfig(entry),
  });
  try {
    await client.connect();
  } catch (error) {
    void client.end().catch(() => undefined);
    return { kind: 'not-saved', cause: causeOf(error) };
  }
  const connectedAt = Date.now();
  try {
    if (channelId === null) await client.query(`DELETE FROM smdb_data.meta WHERE key = 'owner_channel'`);
    else {
      await client.query(
        `INSERT INTO smdb_data.meta (key, value, updated_at) VALUES ('owner_channel', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(channelId)],
      );
    }
    return { kind: 'ok' };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return { kind: 'not-saved', cause: causeOf(error) };
    return { kind: 'unknown', cause: causeOf(error), connectedAt };
  } finally {
    void client.end().catch(() => undefined);
  }
}

/** The JSON bot's write: the file, or its removal for none. */
export function writeOwnerChannelFile(channelId: string | null): void {
  if (channelId === null) fs.rmSync(ownerChannelFile(), { force: true });
  else atomicWriteFileSync(ownerChannelFile(), JSON.stringify({ channelId }));
}

export interface OwnerChannelHost {
  migrationRunning(): RunningMigration | null;
  ownerChannelWriteStart(): { ok: true; end: (afterMs?: number) => void } | { ok: false; running: RunningMigration };
}

export interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

const refused = (status: number, error: string): RouteAnswer => ({ status, body: { success: false, error } });
const migrationText = (running: RunningMigration) => `A data migration is running (migration ${running.jobId}); change the setting once it ends; nothing was changed`;
const cantUse = (reason: string) => `The setting is kept in the bot's main database, which the web panel cannot use now (${reason}); nothing was changed`;
const confirming = (reason: string) => `The setting is kept in the bot's main database, which the bot process is still confirming (${reason}); nothing was changed`;

/** The bot process's report, as both checks read it: a refusal, or null when it lets the entry through. */
function reportRefusal(entry: string | null): RouteAnswer | null {
  const current = webuiChildCase();
  if (current.kind === 'starting') return refused(503, cantUse(STARTING_REFUSAL));
  if (current.kind !== 'reported') return null;
  const report = current.report;
  if (report.url === null) return refused(503, cantUse(report.reason ?? CHOOSING_REFUSAL));
  if (report.held) return refused(503, confirming(report.reason ?? ''));
  if (entry !== null && report.url !== entry) {
    return refused(503, cantUse(`a check of the databases made now picks ${showEntry(entry)}, while the bot process uses ${showEntry(report.url)}`));
  }
  return null;
}

/** The first check, before the test post, on what is known then. */
function firstCheck(host: OwnerChannelHost, postgres: boolean): RouteAnswer | null {
  const running = host.migrationRunning();
  if (running) return refused(409, migrationText(running));
  if (!postgres) return null;
  const report = reportRefusal(null);
  if (report) return report;
  const current = webuiChildCase();
  if (current.kind === 'none' || current.kind === 'maintenance') {
    const own = resolveWebuiDatabase();
    if ('refusal' in own) return refused(503, cantUse(own.refusal));
  }
  return null;
}

/** The second check, once chooseNow() answered, right before the write. */
function secondCheck(host: OwnerChannelHost, choice: WebuiResolution, countAtStart: number): RouteAnswer | { entry: string } {
  const running = host.migrationRunning();
  if (running) return refused(409, migrationText(running));
  if ('refusal' in choice) return refused(503, cantUse(choice.refusal));
  const report = reportRefusal(choice.entry);
  if (report) return report;
  if (webuiReportCount() !== countAtStart) return refused(503, cantUse('the bot process reported a change of its database during the check'));
  return { entry: choice.entry };
}

/** What changed while the write was on the wire, in the words of the can't-confirm answer. */
function changeWords(entry: string): string {
  const current = webuiChildCase();
  if (current.kind === 'starting') return 'a bot process started';
  if (current.kind === 'maintenance') return 'the bot process booted in maintenance';
  if (current.kind === 'none') return 'the bot process ended';
  const report = current.report;
  if (report.url === null) return `the bot process began choosing its database (${report.reason ?? CHOOSING_REFUSAL})`;
  if (report.held) return `the bot process reported its database held (${report.reason ?? ''})`;
  if (report.url !== entry) return `the bot process moved to ${showEntry(report.url)}`;
  return 'the bot process reported a change of its database';
}

function savedAnswer(channelId: string | null): RouteAnswer {
  lastRefusal = null;
  const note = channelId === null
    ? "Owner messages go to the owner's DMs from now on."
    : `Owner messages go to channel ${channelId} from now on; switch notices also stay in the owner's DMs.`;
  return { status: 200, body: { success: true, channelId, note } };
}

const notSaved = (cause: string) => refused(502, `The setting was not saved (${cause}); owner messages still go where they went before`);

async function putOnce(host: OwnerChannelHost, value: unknown): Promise<RouteAnswer> {
  if (!(value === null || (typeof value === 'string' && /^\d{17,20}$/.test(value)))) {
    return refused(400, "Enter a channel ID (17 to 20 digits), or clear the field to use the owner's DMs");
  }
  const channelId = value as string | null;
  const postgres = resolveDataBackend() === 'postgres';
  if (channelId !== null) {
    const first = firstCheck(host, postgres);
    if (first) return first;
    const post = await postInPlace({ kind: 'channel', id: channelId }, { content: TEST_POST_TEXT }, null, Date.now() + TEST_POST_MS);
    if (!post.ok) {
      if (post.failure.timeout) {
        return { status: 502, body: { success: false, unknown: true, error: "can't confirm whether the test message was posted: Discord did not answer within 10 s; nothing was changed" } };
      }
      if (post.failure.unconfirmed) {
        return { status: 502, body: { success: false, unknown: true, error: `can't confirm whether the test message was posted: ${post.failure.cause}; nothing was changed` } };
      }
      const cause = channelCause(post.failure);
      noteChannelRefusal(channelId, cause);
      return refused(400, `The bot cannot post in channel ${channelId}: ${cause}; nothing was changed`);
    }
    if (post.channelId !== channelId) {
      return refused(400, `The bot cannot post in channel ${channelId}: Discord answered with a message in another channel; nothing was changed`);
    }
    noteChannelPosted(channelId);
  }
  const prefix = channelId !== null ? `The test message was posted in channel ${channelId}, but the setting was not saved: ` : '';
  const withPrefix = (answer: RouteAnswer): RouteAnswer => ({ status: answer.status, body: { ...answer.body, error: prefix + String(answer.body.error) } });

  if (!postgres) {
    const mark = host.ownerChannelWriteStart();
    if (!mark.ok) return withPrefix(refused(409, migrationText(mark.running)));
    try {
      writeOwnerChannelFile(channelId);
    } catch (error) {
      return notSaved(causeOf(error));
    } finally {
      mark.end();
    }
    return savedAnswer(channelId);
  }

  const { resolution, countAtStart } = await chooseNow();
  const second = secondCheck(host, resolution, countAtStart);
  if (!('entry' in second)) return withPrefix(second);
  const mark = host.ownerChannelWriteStart();
  if (!mark.ok) return withPrefix(refused(409, migrationText(mark.running)));
  const entry = second.entry;
  const outcome = await writeOwnerChannelRow(entry, channelId);
  if (outcome.kind === 'unknown') {
    mark.end(Math.max(0, outcome.connectedAt + deps.markAfterConnectMs - Date.now()));
    return { status: 502, body: { success: false, unknown: true, error: `can't confirm whether the setting was saved (${outcome.cause}); reload the page to see where owner messages go` } };
  }
  mark.end();
  if (outcome.kind === 'not-saved') return notSaved(outcome.cause);
  if (webuiReportCount() !== countAtStart) {
    return {
      status: 502,
      body: {
        success: false, unknown: true,
        error: `The setting was written to ${showEntry(entry)}, but while it was written ${changeWords(entry)}; can't confirm where owner messages go; reload the page once the bot runs`,
      },
    };
  }
  return savedAnswer(channelId);
}

/** PUT /api/setup/owner-channel, one request at a time in the web UI process. */
export function putOwnerChannel(host: OwnerChannelHost, value: unknown): Promise<RouteAnswer> {
  const run = putChain.then(() => putOnce(host, value));
  putChain = run.catch(() => undefined);
  return run;
}

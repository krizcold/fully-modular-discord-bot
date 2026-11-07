import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB9 test 9: the memory hook (19, 37, 51, 60) on a real BotManager with the forkMock children, the 'memory:reading'
// push each child receives, the bot process's real handler, and the heartbeat values the real ClaimStore sends.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import * as memory from '../../src/utils/memoryReading';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';
import { startApp } from '../helpers/configRig';

const TOKEN = 'nb9-memory-token';
const T = claimTimings(30);
const MEMINFO = '/proc/meminfo has no MemAvailable line';

let warn: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];
let apps: Array<{ close: () => Promise<void> }> = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  memory._resetMemoryReading();
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
});

async function running(): Promise<{ manager: BotManager; child: any; post: (body: unknown, token?: string) => Promise<{ status: number; body: any }> }> {
  const manager = new BotManager();
  managers.push(manager);
  expect((await manager.start()).success).toBe(true);
  await tick(5);
  const app = await startApp(a => a.use('/api/managed', createManagedRoutes(manager)));
  apps.push(app);
  const post = async (body: unknown, token = TOKEN) => {
    const res = await fetch(`${app.url}/api/managed/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { manager, child: forks.children.at(-1), post };
}

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const pushes = (child: any): any[] => sentTo(child, 'memory:reading');

/** The bot process's own listener, as bot/index.ts installs it. */
function botReceives(message: unknown): void {
  memory.setupMemoryIpc();
  (process as unknown as { emit: (event: string, value: unknown) => boolean }).emit('message', message);
}

/** The heartbeat values the real ClaimStore sends for the reading the bot process keeps: room, free, use, error, age. */
async function heartbeatValues(): Promise<unknown[]> {
  const sent: unknown[][] = [];
  const client = {
    query(config: any, values?: unknown[]) {
      const text: string = typeof config === 'string' ? config : config.text;
      const bound = (typeof config === 'string' ? values : config.values) ?? [];
      if (/^WITH pairs AS/.test(text.trim())) {
        sent.push(bound);
        return Promise.resolve({ rows: [{ at: 1, prior_process: null, rows: [] }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() { /* nothing held */ },
  };
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T, () => undefined);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = { connect: async () => client, end: async () => undefined, on() { return this; } };
  await store.renew({
    me: { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' }, pairs: [], ttlMs: T.ttlMs,
    heartbeat: { capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: false, startedAt: 0, memory: memory.heartbeatMemory() },
  });
  expect(sent).toHaveLength(1);
  return sent[0].slice(15, 20);
}

describe('the hook POST /api/managed/memory (19, 51)', () => {
  it('answers 403 without the manager token and keeps nothing', async () => {
    const { child, post } = await running();
    const res = await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(0) }, 'wrong');
    expect(res.status).toBe(403);
    expect(pushes(child)).toEqual([]);
  });

  it.each([
    ['room as a string', { room: 'yes' }, memory.ROOM_TEXT],
    ['room absent', { room: undefined }, memory.ROOM_TEXT],
    ['useMb 512.5', { useMb: 512.5 }, memory.MB_TEXT],
    ['useMb -1', { useMb: -1 }, memory.MB_TEXT],
    ['freeMb 2147483648', { freeMb: 2147483648 }, memory.MB_TEXT],
    ["freeMb '5'", { freeMb: '5' }, memory.MB_TEXT],
    ['at not a date', { at: 'yesterday' }, memory.AT_TEXT],
    ['at absent', { at: undefined }, memory.AT_TEXT],
    ['error a number', { error: 5 }, memory.ERROR_TEXT],
  ])('%s: 400 with its text, the refusal logged, nothing pushed', async (_name, over, text) => {
    const { child, post } = await running();
    const res = await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(0), ...over });
    expect(res).toEqual({ status: 400, body: { success: false, error: text } });
    expect(logged(warn)).toContain(memory.refusedLine(text));
    expect(pushes(child)).toEqual([]);
  });

  it('200 keeps the reading and pushes it with ageMs the larger of the two ages', async () => {
    const { child, post } = await running();
    const res = await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(3) });
    expect(res).toEqual({ status: 200, body: { success: true } });
    const [message] = pushes(child);
    expect(message.data).toMatchObject({ room: true, useMb: 300, freeMb: 900 });
    expect('error' in message.data).toBe(false);
    expect(message.data.ageMs).toBeGreaterThanOrEqual(180_000);
    expect(message.data.ageMs).toBeLessThan(190_000);
  });

  it("a reading dated ahead of this clock is as old as its time since arrival, never below 0", async () => {
    const { child, post } = await running();
    await post({ room: true, useMb: 300, freeMb: 900, at: new Date(Date.now() + 120_000).toISOString() });
    const age = pushes(child)[0].data.ageMs;
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5_000);
  });

  it('a refused reading leaves the kept one: the next ask forks a standby', async () => {
    const { manager, child, post } = await running();
    await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(0) });
    expect((await post({ room: true, useMb: 512.5, freeMb: 900, at: minutesAgo(0) })).status).toBe(400);
    expect(pushes(child)).toHaveLength(1);
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 1, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
    expect(forks.children).toHaveLength(2);
    expect(sentTo(child, 'reshard:standby-state').map(m => m.data.state)).toEqual(['started']);
    expect(manager).toBeTruthy();
  });
});

describe('the push reaches the bot process, whose heartbeat writes it (37, 60)', () => {
  it.each([
    ['room null with the manager error', { room: null, useMb: 400, freeMb: null, error: MEMINFO }, [null, null, 400, MEMINFO]],
    ['room true', { room: true, useMb: 300, freeMb: 900 }, [true, 900, 300, null]],
    ['room false', { room: false, useMb: 300, freeMb: 100 }, [false, 100, 300, null]],
  ])('%s: the handler keeps it and the heartbeat writes the five columns', async (_name, body, columns) => {
    const { child, post } = await running();
    expect((await post({ ...body, at: minutesAgo(2) })).status).toBe(200);
    botReceives(pushes(child)[0]);
    const values = await heartbeatValues();
    expect(values.slice(0, 4)).toEqual(columns);
    expect(values[4]).toBeGreaterThanOrEqual(120_000);
    expect(values[4]).toBeLessThan(130_000);
  });

  it('with no reading, the heartbeat writes all five as NULL', async () => {
    expect(await heartbeatValues()).toEqual([null, null, null, null, null]);
  });

  it('a message with at and no ageMs is dropped with the ageMs text; the heartbeat writes only a kept reading', async () => {
    botReceives({ type: 'memory:reading', data: { room: true, useMb: 300, freeMb: 900, at: minutesAgo(0) } });
    expect(logged(warn)).toContain(memory.ignoredLine(memory.AGE_TEXT));
    expect(await heartbeatValues()).toEqual([null, null, null, null, null]);
  });

  it('a message with a bad value keeps nothing new and is logged; the last good reading stays', async () => {
    botReceives({ type: 'memory:reading', data: { room: true, useMb: 300, freeMb: 900, ageMs: 1000 } });
    botReceives({ type: 'memory:reading', data: { room: false, useMb: 512.5, freeMb: 900, ageMs: 0 } });
    expect(logged(warn)).toContain(memory.ignoredLine(memory.MB_TEXT));
    expect((await heartbeatValues()).slice(0, 4)).toEqual([true, 900, 300, null]);
  });
});

describe('the push after each fork and promotion (19)', () => {
  it('a bot process forked after the reading arrived gets it at its fork', async () => {
    const { manager, child, post } = await running();
    await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(1) });
    await manager.shutdown();
    await tick(40);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect((await manager.start()).success).toBe(true);
    const next = forks.children.at(-1);
    expect(next).not.toBe(child);
    expect(pushes(next)).toHaveLength(1);
    expect(pushes(next)[0].data).toMatchObject({ room: true, useMb: 300, freeMb: 900 });
  });

  it('the standby gets the reading at its fork and again at its promotion', async () => {
    const { child, post } = await running();
    await post({ room: true, useMb: 300, freeMb: 900, at: minutesAgo(0) });
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 1, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
    const standby = forks.children.at(-1);
    expect(standby).not.toBe(child);
    await tick(5);
    expect(pushes(standby)).toHaveLength(1);
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    await tick(40);
    const sent = sentTo(standby).map(m => m.type);
    expect(sent.filter(t => t === 'memory:reading')).toHaveLength(2);
    expect(sent.lastIndexOf('memory:reading')).toBeLessThan(sent.indexOf('reshard:promoted'));
  });
});

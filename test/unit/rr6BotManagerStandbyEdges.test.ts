import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, B7_LINE, b3Line, b5Line, b6Line } from '../../src/webui/botManager';
import { IDENTIFY_SPACING_MS } from '../../src/bot/internalSetup/fleet/constants';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

const ATTEMPT = 'a-1';
const NOT_THE_ONE = 'the second bot process is not the one for this reshard';
const lines = (): string[] => [...logged(log), ...logged(warn)];
const answers = (child: any): any[] => sentTo(child, 'reshard:standby-state').map(m => m.data);

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = fresh();
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  return { manager, child: forks.children.at(-1) };
}

function roomy(manager: BotManager): void {
  manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
}

function ask(child: any, extra: Record<string, unknown> = {}): void {
  child.emit('message', { type: 'control:reshard-standby', data: { attempt: ATTEMPT, to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x', ...extra } });
}

async function withStandby(extra: Record<string, unknown> = {}): Promise<{ manager: BotManager; child: any; standby: any }> {
  const { manager, child } = await started();
  roomy(manager);
  ask(child, extra);
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  await tick(5);
  return { manager, child, standby };
}

describe("a standby's 'reshard:standby-ready'", () => {
  it("from a Postgres standby asks the bot process nothing and stops nothing", async () => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await tick(10);
    expect(sentTo(child, 'reshard:retire')).toEqual([]);
    expect(standby.signals).toEqual([]);
    expect(lines()).not.toContain(b6Line('the reshard was called off'));
  });

  it("an answer that arrives after the standby was replaced does not stop the new standby", async () => {
    const { child, standby } = await withStandby({ json: true, entry: undefined });
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await tick(2);
    const [retire] = sentTo(child, 'reshard:retire');
    expect(retire?.data).toEqual({ attempt: ATTEMPT });
    ask(child, { attempt: 'a-2' });
    const second = forks.children.at(-1);
    expect(second).not.toBe(standby);
    expect(answers(child).at(-1)).toEqual({ attempt: 'a-2', state: 'started' });
    child.emit('message', { requestId: retire.requestId, data: { accepted: false } });
    await tick(20);
    expect(second.signals).toEqual([]);
    expect(lines()).not.toContain(b6Line('the reshard was called off'));
    expect(answers(child).filter(a => a.state === 'ended')).toEqual([]);
  });
});

describe("a standby's 'reshard:standby-stopping' and its exit", () => {
  it.each([
    ['an empty reason', ''],
    ['a reason that is a number', 5],
  ])("%s: B5 and 'ended' carry the exit, not the reason", async (_name, reason) => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason, kind: 'failed' } });
    expect(sentTo(standby, 'reshard:standby-stop-answer').map(m => m.data)).toEqual([{ promoted: false }]);
    exitChild(standby, 0);
    expect(lines()).toContain(b5Line(0, null, null));
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'exit code 0, signal null' });
  });

  it("a stopping message with no data is answered and its exit sends 'ended' with the exit", async () => {
    const { child, standby } = await withStandby();
    expect(() => standby.emit('message', { type: 'reshard:standby-stopping' })).not.toThrow();
    expect(sentTo(standby, 'reshard:standby-stop-answer').map(m => m.data)).toEqual([{ promoted: false }]);
    exitChild(standby, 0);
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'exit code 0, signal null' });
  });

  it("a message of another type from the standby is not answered as an identify slot", async () => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:something-else', data: { nonce: 'n1', bucket: 0 } });
    await tick(2);
    expect(sentTo(standby, 'identify:slot')).toEqual([]);
    expect(sentTo(child, 'identify:slot')).toEqual([]);
  });
});

describe("the bot process's retire", () => {
  it("a retire with no data hands over to nothing: B7 and a new bot process", async () => {
    const { manager, child } = await started();
    expect(() => child.emit('message', { type: 'control:reshard-retire' })).not.toThrow();
    await tick(40);
    expect(lines()).toContain(B7_LINE);
    expect(forks.children).toHaveLength(2);
    expect((manager as any).botProcess).toBe(forks.children.at(-1));
  });

  it("a retire for another attempt logs no B3 hand-over line", async () => {
    const { child } = await withStandby();
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-other' } });
    await tick(40);
    expect(lines()).not.toContain(b3Line(8));
    expect(lines()).toContain(B7_LINE);
  });

  it("a retire for the standby's attempt logs B3", async () => {
    const { child } = await withStandby();
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(40);
    expect(lines()).toContain(b3Line(8));
  });

  it("an abandoning standby of the same attempt is not stopped as the wrong one", async () => {
    const { manager, child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason: 'r', kind: 'failed' } });
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(40);
    expect(lines()).toContain(B7_LINE);
    expect(lines()).not.toContain(b6Line(NOT_THE_ONE));
    expect(standby.signals).toEqual([]);
    expect((manager as any).botProcess).not.toBe(standby);
  });
});

describe("'identify:slot' input checks", () => {
  it.each([
    ['no data', undefined],
    ['a nonce that is a number', { nonce: 5, bucket: 0 }],
    ['no nonce', { bucket: 0 }],
    ['a negative bucket', { nonce: 'n1', bucket: -1 }],
    ['a fractional bucket', { nonce: 'n1', bucket: 1.5 }],
  ])("%s: no answer", async (_name, data) => {
    const { child } = await started();
    expect(() => child.emit('message', { type: 'identify:slot', ...(data !== undefined ? { data } : {}) })).not.toThrow();
    await tick(2);
    expect(sentTo(child, 'identify:slot')).toEqual([]);
  });
});

describe("'identify:slot' spacing on the monotonic clock", () => {
  async function slots(times: number[]): Promise<number[]> {
    const { child } = await started();
    const now = vi.spyOn(performance, 'now');
    times.forEach((t, i) => {
      now.mockReturnValue(t);
      child.emit('message', { type: 'identify:slot', data: { nonce: `n${i}`, bucket: 0 } });
    });
    now.mockRestore();
    return sentTo(child, 'identify:slot').map(m => m.data.waitMs);
  }

  it('a slot asked after the spacing has passed is granted at once and starts a new spacing', async () => {
    const t = 1_000_000;
    expect(await slots([t, t + IDENTIFY_SPACING_MS + 100, t + IDENTIFY_SPACING_MS + 100])).toEqual([0, 0, IDENTIFY_SPACING_MS]);
  });

  it('a slot asked exactly at the spacing is granted at once and starts a new spacing', async () => {
    const t = 1_000_000;
    expect(await slots([t, t + IDENTIFY_SPACING_MS, t + IDENTIFY_SPACING_MS])).toEqual([0, 0, IDENTIFY_SPACING_MS]);
  });

  it('a slot asked inside the spacing waits out the rest of it', async () => {
    const t = 1_000_000;
    expect(await slots([t, t + 1_000])).toEqual([0, IDENTIFY_SPACING_MS - 1_000]);
  });
});

describe('ownerChannelWriteStart', () => {
  it('a second end() of one write changes nothing; the count follows the writes still open', () => {
    const manager = fresh();
    const first = manager.ownerChannelWriteStart();
    const second = manager.ownerChannelWriteStart();
    if (!first.ok || !second.ok) throw new Error('a write was refused with no migration running');
    first.end();
    first.end();
    expect(manager.ownerChannelWriteSettled()).toBe(false);
    second.end();
    expect(manager.ownerChannelWriteSettled()).toBe(true);
    second.end();
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });
});

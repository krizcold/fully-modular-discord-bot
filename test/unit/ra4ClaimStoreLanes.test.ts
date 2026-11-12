import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaimFailure, ClaimPausedError, ClaimStore, classifyFailure, holderStateOf, type Heartbeat,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type ClaimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const ENTRY = 'postgres://nobody@127.0.0.1:1/none';
const PAUSED_MESSAGE = 'the claims are paused: this process stopped writing to its database';

type Reply = { rows: any[] } | Promise<{ rows: any[] }> | 'hang' | Error;
type Respond = (text: string, values: unknown[]) => Reply;

// A pg client as the claims pool sees it: release(true) ends the connection, so a query on the wire fails, and a
// second release throws as pg's does.
class FakeClient {
  readonly sent: Array<{ text: string; values: unknown[] }> = [];
  readonly releases: Array<boolean | undefined> = [];
  private readonly hung: Array<(error: Error) => void> = [];
  constructor(private readonly respond: Respond) {}

  query(config: any, values?: unknown[]): Promise<{ rows: any[] }> {
    const text: string = typeof config === 'string' ? config : config.text;
    const params = (typeof config === 'string' ? values : config.values) ?? [];
    this.sent.push({ text, values: params });
    const reply = this.respond(text, params);
    if (reply === 'hang') return new Promise((_, reject) => { this.hung.push(reject); });
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  }

  release(destroy?: boolean): void {
    this.releases.push(destroy);
    if (this.releases.length > 1) throw new Error('Release called on client which has already been released to the pool.');
    if (destroy === true) for (const reject of this.hung.splice(0)) reject(new Error('Connection terminated'));
  }

  get destroyed(): boolean {
    return this.releases[0] === true;
  }
}

interface Rig {
  store: ClaimStore;
  clients: FakeClient[];
}

const open: ClaimStore[] = [];
afterEach(async () => {
  for (const store of open.splice(0)) {
    store.abandonRenewal();
    store.abandonWork();
    (store as any).abandonIdentify();
    await store.end();
  }
});

async function rig(respond: Respond, timings: ClaimTimings = T, end: () => Promise<void> = async () => undefined): Promise<Rig> {
  const store = new ClaimStore(ENTRY, timings);
  await (store as any).pool.end().catch(() => undefined);
  const clients: FakeClient[] = [];
  (store as any).pool = {
    async connect() {
      const client = new FakeClient(respond);
      clients.push(client);
      return client;
    },
    end,
    on() { return this; },
  };
  open.push(store);
  return { store, clients };
}

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<{ settled: false } | { settled: true; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ settled: false }>(resolve => { timer = setTimeout(() => resolve({ settled: false }), ms); });
  const done = work.then(() => ({ settled: true as const, error: null }), (error: unknown) => ({ settled: true as const, error }));
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

const renewalRow = (over: Record<string, unknown> = {}) => ({ at: 7, rows: [], prior_process: null, target_written: false, ...over });
const answersRenewal = (row: Record<string, unknown>): Respond => text => (text.trim() === '' ? { rows: [] } : { rows: [row] });
const heartbeat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 1, countSetting: 4, ...over,
});
const renewOf = (store: ClaimStore, hb: Heartbeat = heartbeat()) => store.renew({ me: ME, pairs: [], ttlMs: T.ttlMs, heartbeat: hb });

describe('holderStateOf reads the holder check row', () => {
  const expired = {
    n: 4, shard: 1, holder_process: 'p-old', holder_node: 'n-b', holder_name: 'B', claim: '7', released: false, reserved: false,
    ttl_ms: '30000', expires_up_ms: '100', renewed_ago_ms: 40_000, up_ms: '200',
  };

  it('a stored count of null is no count, not a count of 0', () => {
    expect(holderStateOf([{ n: null, shard: 0 }])).toEqual({ kind: 'no-count' });
  });

  it('a row with no count column is no count', () => {
    expect(holderStateOf([{ shard: 0 }])).toEqual({ kind: 'no-count' });
  });

  it('a shard with no holder column has no claim row', () => {
    expect(holderStateOf([{ n: 4, shard: 1 }])).toEqual({
      kind: 'row', shardCount: 4, shardId: 1, state: 'none', holderProcess: null, holderNode: null, holderName: null,
    });
  });

  it("an expired row whose machine runs a new process seen in time is deferred", () => {
    const got = holderStateOf([{ ...expired, node_process_id: 'p-new', node_takeover_seconds: 30, node_seen_ago_ms: 0 }]);
    expect(got).toMatchObject({ kind: 'row', state: 'expired-deferred', holderProcess: 'p-old' });
  });

  it('with no machine process id the expired row is expired, whatever the other machine columns hold', () => {
    const got = holderStateOf([{ ...expired, node_process_id: null, node_takeover_seconds: 30, node_seen_ago_ms: 0 }]);
    expect(got).toEqual({ kind: 'row', shardCount: 4, shardId: 1, state: 'expired', holderProcess: 'p-old', holderNode: 'n-b', holderName: 'B' });
  });

  it('with no machine process id column the expired row is expired', () => {
    const got = holderStateOf([{ ...expired, node_takeover_seconds: 30, node_seen_ago_ms: 0 }]);
    expect(got).toMatchObject({ kind: 'row', state: 'expired' });
  });
});

describe('the paused claims error', () => {
  it('names itself and says the process stopped writing', async () => {
    const { store } = await rig(answersRenewal(renewalRow()));
    store.pause();
    const error = await renewOf(store).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimPausedError);
    expect((error as Error).name).toBe('ClaimPausedError');
    expect((error as Error).message).toBe(PAUSED_MESSAGE);
  });

  it('is classed unreachable with the short pause detail', () => {
    expect(classifyFailure(new ClaimPausedError())).toEqual({ kind: 'unreachable', detail: 'the claims are paused' });
  });
});

describe('classifyFailure keeps the severity word after a possible commit', () => {
  it("a connection-class error with no severity says 'none'", () => {
    const error = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    expect(classifyFailure(error)).toEqual({ kind: 'error', code: '57P01', message: 'terminating connection due to administrator command', severity: 'none' });
  });
});

describe('a failed statement destroys its connection', () => {
  it('a renewal past its bound destroys the connection instead of returning it to the pool', async () => {
    const { store, clients } = await rig(() => 'hang', { ...T, renewMs: 30 });
    const error = await renewOf(store).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(clients).toHaveLength(1);
    expect(clients[0].releases[0]).toBe(true);
  });

  it('an answer that arrives after a pause destroys its connection, though another call on its lane was the one dropped', async () => {
    let answerFirst: (rows: { rows: any[] }) => void = () => undefined;
    const first = new Promise<{ rows: any[] }>(resolve => { answerFirst = resolve; });
    let calls = 0;
    const { store, clients } = await rig(() => [first, 'hang' as const][calls++] ?? { rows: [] });
    const one = store.readRow(4, 0).then(() => null, (e: unknown) => e);
    await vi.waitFor(() => expect(clients[0]?.sent.length ?? 0).toBe(1), { timeout: 1000, interval: 2 });
    const two = store.readRow(4, 1).then(() => null, (e: unknown) => e);
    await vi.waitFor(() => expect(clients[1]?.sent.length ?? 0).toBe(1), { timeout: 1000, interval: 2 });
    store.pause();
    expect(clients.map(c => c.destroyed)).toEqual([false, true]);
    answerFirst({ rows: [] });
    expect(await one).toBeInstanceOf(ClaimPausedError);
    expect(await two).toBeInstanceOf(ClaimPausedError);
    expect(clients[0].releases[0]).toBe(true);
  });

  it('a renewal the server failed destroys the connection', async () => {
    const failure = Object.assign(new Error('relation "smdb_data.claim_clock" does not exist'), { code: '42P01', severity: 'ERROR' });
    const { store, clients } = await rig(() => failure);
    const error = await renewOf(store).then(() => null, (e: unknown) => e);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'error', code: '42P01', message: failure.message });
    expect(clients[0].releases[0]).toBe(true);
  });
});

describe('pause and retarget end the statements on the wire at once', () => {
  async function onWire(start: (store: ClaimStore) => Promise<unknown>, end?: () => Promise<void>) {
    const r = await rig(() => 'hang', T, end);
    const call = start(r.store);
    call.catch(() => undefined);
    await vi.waitFor(() => expect(r.clients[0]?.sent.length ?? 0).toBeGreaterThan(0), { timeout: 1000, interval: 2 });
    return { ...r, call };
  }

  async function droppedAtOnce(call: Promise<unknown>, client: FakeClient) {
    const outcome = await settlesWithin(call, 1000);
    expect(outcome.settled).toBe(true);
    expect(outcome.settled && outcome.error).toBeInstanceOf(ClaimPausedError);
    expect(client.destroyed).toBe(true);
  }

  it('pause drops the renewal on the wire', async () => {
    const { store, clients, call } = await onWire(s => renewOf(s));
    store.pause();
    expect(clients[0].destroyed).toBe(true);
    await droppedAtOnce(call, clients[0]);
  });

  it('pause drops the work lane statement on the wire', async () => {
    const { store, clients, call } = await onWire(s => s.readRow(4, 0));
    store.pause();
    expect(clients[0].destroyed).toBe(true);
    await droppedAtOnce(call, clients[0]);
  });

  it('pause drops the identify slot statement on the wire', async () => {
    const { store, clients, call } = await onWire(s => s.reserveIdentifySlot(1, ME.processId));
    store.pause();
    expect(clients[0].destroyed).toBe(true);
    await droppedAtOnce(call, clients[0]);
  });

  it('retarget drops the identify slot statement on the wire', async () => {
    const { store, clients, call } = await onWire(s => s.reserveIdentifySlot(1, ME.processId));
    store.retarget(ENTRY);
    expect(clients[0].destroyed).toBe(true);
    await droppedAtOnce(call, clients[0]);
  });

  it('retarget logs an old pool that did not end cleanly, with its error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { store } = await rig(() => ({ rows: [] }), T, () => Promise.reject(new Error('pool end failed')));
      store.retarget(ENTRY);
      const prefix = '[Shards] The claims pool of the database this process left did not end cleanly:';
      await vi.waitFor(() => expect(logged.mock.calls.some(c => c[0] === prefix)).toBe(true), { timeout: 1000, interval: 2 });
      expect(logged.mock.calls.find(c => c[0] === prefix)).toEqual([prefix, 'pool end failed']);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('the renewal statement parameters and answer', () => {
  it('sends a memory error cut to 200 characters', async () => {
    const { store, clients } = await rig(answersRenewal(renewalRow()));
    const error = 'e'.repeat(150) + 'f'.repeat(150);
    await renewOf(store, heartbeat({ memory: { room: true, freeMb: 10, useMb: 5, error, ageMs: 3 } }));
    expect(clients[0].sent[0].values[18]).toBe('e'.repeat(150) + 'f'.repeat(50));
  });

  it("sends this process's edge only when the heartbeat says so", async () => {
    const { store, clients } = await rig(answersRenewal(renewalRow()));
    await renewOf(store, heartbeat({ targetEdge: true }));
    await renewOf(store, heartbeat());
    expect(clients.map(c => c.sent[0].values[20])).toEqual([true, false]);
  });

  it('names no target when the statement wrote none', async () => {
    const { store } = await rig(answersRenewal(renewalRow({ target_written: false, prior_setting: 2 })));
    const got = await renewOf(store);
    expect(got).toEqual({ at: 7, rows: [], priorProcess: null });
  });

  it('names the target the statement wrote, from the prior setting', async () => {
    const { store } = await rig(answersRenewal(renewalRow({ target_written: true, prior_setting: '3' })));
    const got = await renewOf(store);
    expect(got.targetWritten).toEqual({ from: 3, to: 4 });
  });
});

describe('the standby renewal statement', () => {
  it('is a statement the database answers with the renewed rows', async () => {
    const row = { at: 9, rows: JSON.stringify([{ shardCount: 4, shardId: 1, claim: '11', released: false, mine: true }]) };
    const { store, clients } = await rig(answersRenewal(row));
    const got = await store.renewStandby({ me: ME, ttlMs: T.ttlMs, pairs: [{ shardCount: 4, shardId: 1, claim: 11, ready: true }] });
    expect(got).toEqual({ at: 9, rows: [{ shardCount: 4, shardId: 1, claim: 11, released: false, mine: true }], priorProcess: null });
    expect(clients[0].sent[0].text.trim()).not.toBe('');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { l11Line, l5Line, retryTime } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, FakeChannel, claimRow, gatewayAnswer, lineLog, standbyEnv, standbyStore } from '../helpers/standbyRig';

// NB9 test 21 (34, 49, 61): the standby's login budget before it logs in, and the asker's answers to the web UI's
// standby notices, which the bot process's fleet IPC listener hands to its reshard driver.

const h = vi.hoisted(() => ({
  node: { id: 'n-a', name: 'A' },
  reshardMessages: [] as unknown[],
  jsonMessages: [] as unknown[],
  jsonAnswer: null as null | { accepted: boolean; key?: string },
}));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => h.node.id,
  getNodeName: () => h.node.name,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: () => undefined,
  addReleaseStep: () => undefined,
}));

const capacity = process.env.FLEET_SHARD_CAPACITY;
beforeEach(() => {
  h.node = { id: 'n-a', name: 'A' };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (capacity === undefined) delete process.env.FLEET_SHARD_CAPACITY;
  else process.env.FLEET_SHARD_CAPACITY = capacity;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** One standby process (a fresh module graph) on the shared store; its node and capacity as given. */
async function standby(store: MemClaimStore, opts: { node?: { id: string; name: string }; capacity?: number; gateway?: () => Promise<any>; wait?: boolean } = {}) {
  vi.resetModules();
  h.node = opts.node ?? { id: 'n-a', name: 'A' };
  process.env.FLEET_SHARD_CAPACITY = String(opts.capacity ?? 8);
  const sb = await import('../../src/bot/internalSetup/fleet/standbyBoot');
  const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
  const ingest = getIngestService();
  const logins: Array<string | undefined> = [];
  ingest.start = (async (token: string | undefined) => { logins.push(token); return ''; }) as typeof ingest.start;
  const channel = new FakeChannel();
  const { lines, log } = lineLog();
  const reads: string[] = [];
  const work = store.withWorkClient.bind(store);
  store.withWorkClient = ((what: string, fn: any) => { reads.push(what); return work(what, fn); }) as typeof store.withWorkClient;
  let stops = 0;
  const run = sb.standbyMain({
    env: standbyEnv(), storeFactory: () => store, channel, log,
    gateway: async () => { reads.push('gateway'); return (opts.gateway ?? (async () => gatewayAnswer(900)))(); },
    takeLock: async () => undefined, runBot: async () => undefined, stop: () => { stops += 1; },
  });
  if (opts.wait !== false) await run;
  return { ingest, channel, lines, logins, reads, run, stops: () => stops };
}

/** Another machine's rows of W, renewed just now and ready. */
function readyElsewhere(store: MemClaimStore, ids: number[], name = 'C'): void {
  const C = { processId: `p-${name}`, nodeId: `n-${name}`, nodeName: name };
  for (const s of ids) {
    store.rows.set(`8:${s}`, claimRow(8, s, C, { renewedAt: Date.now() }));
    store.ready.set(`8:${s}`, true);
  }
  store.nodes.set(C.nodeId, { ...store.nodes.get('n-a')!, nodeId: C.nodeId, nodeName: name, processId: C.processId, capacity: ids.length });
}

/** Another machine whose old bot process runs (its heartbeat), with room for 3 shards of W. */
function oldNode(store: MemClaimStore, id: string, name: string): void {
  store.nodes.set(id, { ...store.nodes.get('n-a')!, nodeId: id, nodeName: name, processId: `p-${name}-old`, capacity: 3 });
}

describe('test 21: the login budget (34, 61)', () => {
  it('reads the ready rows of W before /gateway/bot and logs in at (W - ready) + W remaining logins', async () => {
    const store = standbyStore();
    readyElsewhere(store, [4, 5, 6, 7]);
    const r = await standby(store, { capacity: 4, gateway: async () => gatewayAnswer(12) });
    expect(r.reads.slice(0, 2)).toEqual(['the login budget', 'gateway']);
    expect(r.logins).toEqual(['token-standby']);
    expect(store.reshard.state).toBe('standby');
  });

  it('one login short: the call-off with the budget reason and failures kept, L11, no login, and the handshake of kind called-off', async () => {
    const store = standbyStore();
    store.attemptRow = { ...store.attemptRow, failures: 1 };
    readyElsewhere(store, [4, 5, 6, 7]);
    const r = await standby(store, { capacity: 4, gateway: async () => gatewayAnswer(11, 600_000) });
    const reason = `Discord allows 11 more gateway logins until ${retryTime(Date.now() + 600_000)}, and the new shards not connected yet (4) plus one more full start (8) need 12`;
    expect(r.logins).toEqual([]);
    expect(r.ingest.getClient()).toBeNull();
    expect(store.reshard.state).toBe('cancelled');
    expect(store.attemptRow).toMatchObject({ reason, failures: 1 });
    expect(r.lines.at(-1)).toBe(l11Line(8, reason, 4, store.attemptRow.retryAfter));
    expect(r.channel.of('reshard:standby-stopping')).toEqual([{ type: 'reshard:standby-stopping', data: { attempt: AT, reason, kind: 'called-off' } }]);
  });

  it('two standbys re-forked after one blip, the other rows ready: with k1 + k2 + W remaining both log in', async () => {
    const store = standbyStore();
    readyElsewhere(store, [6, 7]);
    oldNode(store, 'n-b', 'B');
    const first = await standby(store, { capacity: 3, gateway: async () => gatewayAnswer(14) });
    const second = await standby(store, { node: { id: 'n-b', name: 'B' }, capacity: 3, gateway: async () => gatewayAnswer(14) });
    expect(first.lines[0]).toBe(l5Line(8, [0, 1, 2]));
    expect(second.lines[0]).toBe(l5Line(8, [3, 4, 5]));
    expect(first.logins).toHaveLength(1);
    expect(second.logins).toHaveLength(1);
  });

  it('with one login less, neither logs in: the first calls the attempt off, the second finds it called off', async () => {
    const store = standbyStore();
    readyElsewhere(store, [6, 7]);
    oldNode(store, 'n-b', 'B');
    const first = await standby(store, { capacity: 3, gateway: async () => gatewayAnswer(13) });
    const second = await standby(store, { node: { id: 'n-b', name: 'B' }, capacity: 3, gateway: async () => gatewayAnswer(13) });
    expect(first.logins).toEqual([]);
    expect(second.logins).toEqual([]);
    expect(store.reshard.state).toBe('cancelled');
    expect(second.channel.of('reshard:standby-stopping')[0].data.kind).toBe('called-off');
  });

  it("an unreadable /gateway/bot: L31, no login, the read again after 30 s, then the login", async () => {
    const store = standbyStore();
    let answers = 0;
    const r = await standby(store, {
      wait: false,
      gateway: async () => { answers += 1; return answers === 1 ? { info: null, error: 'HTTP 503' } : gatewayAnswer(900); },
    });
    await tick(1);
    expect(r.lines.at(-1)).toBe("[Shards] Standby: cannot read Discord's gateway login limit (HTTP 503); not connecting the new shards until it is read, trying again every 30 s");
    expect(r.logins).toEqual([]);
    expect(answers).toBe(1);
    await tick(29_000);
    expect(answers).toBe(1);
    await tick(1000);
    await r.run;
    expect(answers).toBe(2);
    expect(r.logins).toEqual(['token-standby']);
  });
});

describe("test 21: the asker's answers through the fleet IPC listener (33, 49)", () => {
  it("hands 'reshard:standby-state' to the reshard driver and answers 'reshard:retire' with the JSON driver's answer", async () => {
    vi.resetModules();
    vi.doMock('../../src/bot/internalSetup/fleet/shardBoot', () => ({
      getReshard: () => ({ onMessage: async (m: unknown) => { h.reshardMessages.push(m); } }),
      getJsonReshard: () => ({ onMessage: (m: unknown) => { h.jsonMessages.push(m); return h.jsonAnswer; } }),
    }));
    const listeners: Array<(m: unknown) => void> = [];
    const sent: unknown[] = [];
    const realSend = process.send;
    (process as any).send = (m: unknown) => { sent.push(m); return true; };
    const on = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (m: unknown) => void) => {
      if (event === 'message') listeners.push(fn);
      return process;
    }) as typeof process.on);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { setupFleetIPCHandlers } = await import('../../src/bot/internalSetup/utils/ipcFleetHandler');
      setupFleetIPCHandlers();
      const ended = { type: 'reshard:standby-state', data: { attempt: AT, state: 'ended', reason: 'exit code 1, signal null' } };
      listeners[0](ended);
      listeners[0](ended);
      expect(h.reshardMessages).toEqual([ended, ended]);
      expect(sent).toEqual([]);
      h.jsonAnswer = { accepted: false, key: 'maintenance' };
      listeners[0]({ type: 'reshard:retire', requestId: 'q1', data: { attempt: AT } });
      expect(sent).toEqual([{ requestId: 'q1', data: { accepted: false, key: 'maintenance' } }]);
    } finally {
      on.mockRestore();
      (process as any).send = realSend;
      vi.doUnmock('../../src/bot/internalSetup/fleet/shardBoot');
    }
  });
});

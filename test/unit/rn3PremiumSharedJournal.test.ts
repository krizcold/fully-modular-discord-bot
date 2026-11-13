import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a Postgres bot (NB10 decision 40, decision 54): readSharedJournal parses the journal key's lines,
// asks NB4's liveness of every other writer, and the bot's pass reloads the cache when a replayable line is pending;
// heldEventsText names another machine's pending lines, and in the web UI any pending line. The journal read, the
// liveness query, this process's id and its node are scripted here; the manager is the real one.

const h = vi.hoisted(() => ({
  journal: { ok: true, lines: [] } as any,
  pool: null as null | { sharedSelect: (sql: string, params: unknown[], bound: number) => Promise<{ rows: any[] }> },
  selects: [] as unknown[][],
  reads: [] as Array<string | undefined>,
  deleted: [] as string[][],
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file === premium) {
        h.reads.push(ledger.currentModule());
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      }
      return real.readRawStrict(file);
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return { ...real, rowBackend: () => h.pool };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = () => ({ kind: 'row', key: 'global/premium-tiers.events.jsonl', op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return {
    ...real,
    readJournal: async () => h.journal,
    appendLine: ticket,
    carryLines: ticket,
    deleteLines: (_key: string, ids: string[]) => {
      h.deleted.push(ids);
      return ticket();
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, setSharedLinesPassStep: () => undefined, refreshShared: async () => ({ ok: true }) };
});
vi.mock('../../src/bot/internalSetup/fleet/processId', () => ({ processId: () => 'me-proc' }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/fleet/nodeIdentity')>();
  return { ...real, getNodeId: () => 'node-here' };
});
vi.mock('../../src/bot/internalSetup/fleet/nodeName', () => ({ getNodeName: () => 'Here' }));
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, PREMIUM, quiet, tick, TIERS, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let managers: PremiumManager[] = [];

const GENERIC = 'Premium holds provider events the bot has not applied yet (premium-tiers.events.jsonl); nothing was saved. Start the bot to apply them, then try again.';
const WAITING = 'Premium holds provider events received while premium-tiers.json could not be read; the bot applies them once it runs normally and is connected to Discord. Nothing was saved. Try again then.';
const foreignText = (name: string, seconds: unknown) =>
  `Premium holds provider events that ${name} received while premium-tiers.json could not be read there; nothing was saved. The bot on ${name} applies them once it runs normally (any bot does once that one has been stopped for ${seconds} s); try again then.`;

const event = { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'e1', guildId: 'g1' };

function line(id: string, fields: Record<string, unknown>): { id: string; line: string } {
  return { id, line: JSON.stringify({ n: 1, event, ...fields }) };
}

function journal(...lines: Array<{ id: string; line: string }>): void {
  h.journal = { ok: true, lines };
}

function liveness(rows: Array<{ process_id: string; takeover_seconds: number; live: boolean }>): void {
  h.pool = {
    sharedSelect: async (_sql, params) => {
      h.selects.push(params);
      return { rows };
    },
  };
}

function manager(asBot: boolean): PremiumManager {
  process.env.BOT_PROCESS_ROLE = asBot ? 'bot' : 'webui';
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(2);
}

beforeEach(() => {
  quiet();
  setBackendKind('postgres');
  Object.assign(h, { journal: { ok: true, lines: [] }, pool: null, selects: [], reads: [], deleted: [] });
  clearGlobal();
  writePremium();
});
afterEach(async () => {
  await tick(5);
  for (const pm of managers.splice(0)) pm.dispose();
  reg.current = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the liveness query of readSharedJournal', () => {
  it('asks nothing when the journal holds only lines this process wrote', async () => {
    const pm = manager(true);
    journal(line('1', { writer: 'me-proc', node: 'node-here' }), line('2', { writer: 'me-proc', node: 'node-here', n: 2 }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
  });

  it('asks nothing for an empty journal', async () => {
    const pm = manager(true);
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
  });

  it('asks only for the other writers, once each', async () => {
    const pm = manager(true);
    liveness([]);
    journal(
      line('1', { writer: 'me-proc', node: 'node-here' }),
      line('2', { writer: 'w-other', node: 'node-here' }),
      line('3', { writer: 'w-other', node: 'node-here', n: 2 }),
    );
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(h.selects).toEqual([[['w-other']]]);
  });

  it("fails with the cause when another writer's line needs the database and there is no connection", async () => {
    const pm = manager(true);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: false, cause: "this process has no connection to the bot's database" });
  });

  it('fails with the error of a liveness query that fails', async () => {
    const pm = manager(true);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    h.pool = { sharedSelect: () => Promise.reject(new Error('connection reset')) };
    expect(await pm.readSharedJournal(false)).toEqual({ ok: false, cause: 'connection reset' });
    h.pool = { sharedSelect: () => Promise.reject('plain refusal') };
    expect(await pm.readSharedJournal(false)).toEqual({ ok: false, cause: 'plain refusal' });
  });
});

describe('the name heldEventsText gives a pending line of another machine', () => {
  const live = () => liveness([{ process_id: 'w-other', takeover_seconds: 30, live: true }]);

  it('is the node when the line names no node name', async () => {
    const pm = manager(true);
    live();
    journal(line('1', { writer: 'w-other', node: 'node-there' }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(foreignText('node-there', 30));
  });

  it('is the writer when the node is not a string', async () => {
    const pm = manager(true);
    live();
    journal(line('1', { writer: 'w-other', node: 7 }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(foreignText('w-other', 30));
  });

  it('is the node when the node name is not a string', async () => {
    const pm = manager(true);
    live();
    journal(line('1', { writer: 'w-other', node: 'node-there', nodeName: 5 }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(foreignText('node-there', 30));
  });

  it('is the node name when the line has one', async () => {
    const pm = manager(true);
    live();
    journal(line('1', { writer: 'w-other', node: 'node-there', nodeName: 'There' }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(foreignText('There', 30));
  });
});

describe('heldEventsText in the bot', () => {
  it("does not refuse for another machine's line whose writer is not live", async () => {
    const pm = manager(true);
    liveness([{ process_id: 'w-other', takeover_seconds: 30, live: false }]);
    journal(line('1', { writer: 'w-other', node: 'node-there', nodeName: 'There' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBeNull();
  });

  it("does not refuse for a pending line of this machine's earlier process with no liveness row", async () => {
    const pm = manager(true);
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-here', nodeName: 'Here' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBeNull();
  });

  it("does not refuse for a pending line of this machine's live writer", async () => {
    const pm = manager(true);
    liveness([{ process_id: 'w-other', takeover_seconds: 30, live: true }]);
    journal(line('1', { writer: 'w-other', node: 'node-here', nodeName: 'Here' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBeNull();
  });
});

describe('heldEventsText in the web UI', () => {
  it('refuses with the generic text for a pending line of this machine', async () => {
    const pm = manager(false);
    liveness([{ process_id: 'w-other', takeover_seconds: 30, live: false }]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBe(GENERIC);
  });

  it('refuses with the generic text for a line of another machine with no liveness row', async () => {
    const pm = manager(false);
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-there', nodeName: 'There' }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(GENERIC);
  });

  it('names another machine whose writer is not live', async () => {
    const pm = manager(false);
    liveness([{ process_id: 'w-other', takeover_seconds: 45, live: false }]);
    journal(line('1', { writer: 'w-other', node: 'node-there', nodeName: 'There' }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBe(foreignText('There', 45));
  });

  it("does not refuse for this process's own lines", async () => {
    const pm = manager(false);
    journal(line('1', { writer: 'me-proc', node: 'node-here' }));
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBeNull();
  });

  it('does not refuse for a line eventsApplied covers', async () => {
    writePremium({}, { eventsApplied: { 'w-other': 1 } });
    const pm = manager(false);
    liveness([{ process_id: 'w-other', takeover_seconds: 30, live: false }]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    await pm.readSharedJournal(false);
    expect(pm.heldEventsText()).toBeNull();
  });
});

describe("the bot's pass", () => {
  it("starts the replay for a pending line of this machine's earlier process", async () => {
    const pm = manager(true);
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    expect(await pm.readSharedJournal(true)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBe(WAITING);
    expect(pm.cacheState()).toBe('replaying');
  });

  it('loads the cache again in a console ledger tagged premium', async () => {
    const pm = manager(true);
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    const before = h.reads.length;
    await pm.readSharedJournal(true);
    await until(() => h.reads.length > before);
    expect(h.reads.slice(before)).toEqual(['premium']);
    expect(pm.cacheState()).toBe('replaying');
  });

  it('starts the replay for a line of a live writer of this machine', async () => {
    const pm = manager(true);
    liveness([{ process_id: 'w-other', takeover_seconds: 30, live: true }]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    await pm.readSharedJournal(true);
    expect(pm.heldEventsText()).toBe(WAITING);
  });

  it("does not replay this process's own lines", async () => {
    const pm = manager(true);
    journal(line('1', { writer: 'me-proc', node: 'node-here' }));
    await pm.readSharedJournal(true);
    expect(pm.heldEventsText()).toBeNull();
    expect(pm.cacheState()).toBe('normal');
  });

  it('keeps the loaded cache when the lines are covered by eventsApplied', async () => {
    writePremium({}, { eventsApplied: { 'w-other': 1 } });
    const pm = manager(true);
    expect(pm.getAllTiers().low.displayName).toBe('Low');
    fs.writeFileSync(PREMIUM, JSON.stringify({ tiers: { ...TIERS, low: { ...TIERS.low, displayName: 'Renamed' } }, eventsApplied: { 'w-other': 1 } }, null, 2));
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-here', n: 1 }));
    await pm.readSharedJournal(true);
    await tick(5);
    expect(pm.getAllTiers().low.displayName).toBe('Low');
    expect(h.deleted).toEqual([]);
  });
});

describe('a call that is not the pass', () => {
  it('does not load the cache again or start the replay', async () => {
    const pm = manager(true);
    liveness([]);
    journal(line('1', { writer: 'w-other', node: 'node-here' }));
    const before = h.reads.length;
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(pm.heldEventsText()).toBeNull();
    expect(pm.cacheState()).toBe('normal');
    expect(h.reads.length).toBe(before);
  });
});

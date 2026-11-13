import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a Postgres bot (NB6 decisions 40, 63, 64 and 75; NB10's journal): a provider event that comes
// while premium cannot take it is kept as a line of the journal key; the replay's marks, once their save landed, delete
// exactly the journal lines they cover; a dropped notice names its cause; a stricter tier tells only the guilds on it.
// The data facade's save, the row outcomes and the shared lines are scripted here; the manager is the real one.

type Outcome = 'landed' | 'unconfirmed' | { refused: { cause: string } };
type Ticket = { kind: 'row'; key: string; op: { state: string; unknown: unknown[]; commitOnWire: boolean; writes: number }; seq: number };

const h = vi.hoisted(() => ({
  unreadable: false,
  premium: '',
  saves: [] as Array<{ opts: any; data: any; ticket: any }>,
  outcomes: new Map<object, { promise: Promise<any>; open: (value: any) => void }>(),
  appends: [] as Array<{ key: string; line: string; id: string; ticket: any }>,
  deletes: [] as Array<{ key: string; ids: string[] }>,
  journalRows: [] as Array<{ id: string; line: string }>,
  liveRows: null as null | Array<Record<string, unknown>>,
}));

function deferredOf(op: object): { promise: Promise<any>; open: (value: any) => void } {
  let entry = h.outcomes.get(op);
  if (!entry) {
    let open!: (value: any) => void;
    const promise = new Promise<any>(resolve => { open = resolve; });
    entry = { promise, open };
    h.outcomes.set(op, entry);
  }
  return entry;
}

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file !== premium) return real.readRawStrict(file);
      if (h.unreadable) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return h.premium;
    },
    saveDataTracked: (_file: string, opts: any, data: unknown) => {
      const ticket = { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: h.saves.length + 1 };
      h.saves.push({ opts, data: JSON.parse(JSON.stringify(data)), ticket });
      return { outcome: 'saved', ticket };
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return {
    ...real,
    rowOutcome: (ticket: any) => deferredOf(ticket.op).promise,
    rowBackend: () => (h.liveRows ? { sharedSelect: async () => ({ rows: h.liveRows }) } : real.rowBackend()),
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, setSharedLinesPassStep: () => undefined, refreshShared: () => Promise.resolve({ ok: true }) };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = (key: string, state: string) => ({ kind: 'row', key, op: { state, unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return {
    ...real,
    appendLine: (key: string, line: string, id: string) => {
      const t = ticket(key, 'queued');
      h.appends.push({ key, line, id, ticket: t });
      return t;
    },
    deleteLines: (key: string, ids: string[]) => {
      h.deletes.push({ key, ids: [...ids] });
      return ticket(key, 'landed');
    },
    carryLines: (key: string) => ticket(key, 'landed'),
    readJournal: async () => ({ ok: true, lines: h.journalRows.map(r => ({ ...r })) }),
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push({ guildId, kind });
    return { delivered: true, via: 'dm' };
  },
}));

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { getNodeId } from '../../src/bot/internalSetup/fleet/nodeIdentity';
import { getNodeName } from '../../src/bot/internalSetup/fleet/nodeName';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, logged, paidSub, quiet, state, tick, TIERS } from './nb10PremiumRig';

const JOURNAL_KEY = 'global/premium-tiers.events.jsonl';
const role = process.env.BOT_PROCESS_ROLE;
let spies: ReturnType<typeof quiet>;

function premiumText(subscriptions: Record<string, unknown>, extra: Record<string, unknown> = {}, tiers: Record<string, unknown> = TIERS): string {
  return JSON.stringify({ tiers, subscriptions, messages: {}, providerAccountLinks: {}, activatedProviders: {}, migrations: [], migrationSilencePolicy: 'cancel', ...extra }, null, 2);
}

function registerFake(): void {
  getPaymentRegistry().register({ id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true } as any);
}

const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const expired = (subId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'fake', providerSubId: subId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return;
    await tick(2);
  }
}

function settle(ticket: Ticket, outcome: Outcome): void {
  ticket.op.state = outcome === 'landed' ? 'landed' : outcome === 'unconfirmed' ? 'unconfirmed' : 'refused';
  deferredOf(ticket.op).open(outcome);
}

/** Makes premium-tiers.json readable again and loads it, which starts a replay when kept events wait. */
function readableAgain(): void {
  h.unreadable = false;
  const pm = getPremiumManager();
  pm.invalidate();
  pm.getAllTiers();
}

/** Makes premium-tiers.json unreadable and drops the cache, so the next event is journaled. */
function unreadableAgain(): void {
  h.unreadable = true;
  getPremiumManager().invalidate();
}

beforeEach(() => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  setBackendKind('postgres');
  resetPremiumManager();
  Object.assign(h, { unreadable: false, saves: [], outcomes: new Map(), appends: [], deletes: [], journalRows: [], liveRows: null });
  h.premium = premiumText({
    g2: { active: paidSub('s2', 'e1', 'low'), paused: [] },
    g3: { active: paidSub('s3', 'e3', 'low'), paused: [] },
  });
  notices.sent = [];
  reg.current = null;
  clearGlobal();
  registerFake();
});
afterEach(async () => {
  for (const s of h.saves) settle(s.ticket, 'landed');
  await tick(5);
  resetPremiumManager();
  reg.current = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a provider event that comes while premium-tiers.json cannot be read', () => {
  it('is kept as a journal line naming this process, its node and its count, with a warning', () => {
    h.unreadable = true;
    getPremiumManager();
    const e1 = expired('e1', 'g2');
    const e2 = expired('e3', 'g3');
    emit(e1);
    emit(e2);
    expect(h.appends.map(a => a.key)).toEqual([JOURNAL_KEY, JOURNAL_KEY]);
    const expectLine = (n: number, event: object) => JSON.parse(JSON.stringify({ writer: processId(), node: getNodeId(), nodeName: getNodeName(), n, event }));
    expect(h.appends.map(a => JSON.parse(a.line))).toEqual([expectLine(1, e1), expectLine(2, e2)]);
    expect(h.appends[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(h.appends[1].id).not.toBe(h.appends[0].id);
    expect(logged(spies.warn).filter(l => l.includes('arrived while'))).toEqual([
      '[PremiumManager] A subscription.expired event from fake (subscription e1, guild g2) arrived while premium-tiers.json cannot be read; it is kept in premium-tiers.events.jsonl and applied once premium runs normally',
      '[PremiumManager] A subscription.expired event from fake (subscription e3, guild g3) arrived while premium-tiers.json cannot be read; it is kept in premium-tiers.events.jsonl and applied once premium runs normally',
    ]);
    expect(h.saves).toHaveLength(0);
  });

  it("is recorded in the ledger of the op it came in, so the op's answer waits for its line", async () => {
    h.unreadable = true;
    getPremiumManager();
    let recorded: unknown[] = [];
    await runSealed('console', null, 'premium', async ledger => {
      emit(expired('e1', 'g2'));
      recorded = ledger.tickets().map(t => t.ticket);
    });
    expect(h.appends).toHaveLength(1);
    expect(recorded).toContain(h.appends[0].ticket);
  });

  it('is named as lost by the exit when its line had not been stored', () => {
    h.unreadable = true;
    const pm = getPremiumManager();
    const event = expired('e1', 'g2');
    emit(event);
    pm.markStopped('stopping');
    pm.logLossesAtExit();
    const lines = logged(spies.error).filter(l => l.includes('was received while'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PremiumManager\] A subscription\.expired event from fake \(subscription e1, guild g2\) was received while premium-tiers\.json could not be read and is /);
    expect(lines[0].endsWith(`: ${JSON.stringify(event)}`)).toBe(true);
  });

  it('that comes while kept events wait for the replay is kept with the words for that state', () => {
    h.unreadable = true;
    const pm = getPremiumManager();
    emit(expired('e1', 'g2'));
    readableAgain();
    expect(pm.cacheState()).toBe('replaying');
    emit(expired('e3', 'g3'));
    expect(h.appends).toHaveLength(2);
    expect(logged(spies.warn).filter(l => l.includes('arrived while'))[1]).toBe(
      '[PremiumManager] A subscription.expired event from fake (subscription e3, guild g3) arrived while premium applies the provider events it kept; it is kept in premium-tiers.events.jsonl and applied once premium runs normally',
    );
  });
});

describe('the journal lines a load finds covered by the marks', () => {
  it('are deleted once, and a pending line of a live writer on another machine still refuses premium ops', async () => {
    h.premium = premiumText({ g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } }, { eventsApplied: { 'p-old': 1 } });
    const event = { type: 'subscription.expired', providerId: 'fake', providerSubId: 'e1', guildId: 'g2', state: state('expired') };
    h.journalRows = [
      { id: 'j-old', line: JSON.stringify({ writer: 'p-old', node: getNodeId(), nodeName: 'HERE', n: 1, event }) },
      { id: 'j-bravo', line: JSON.stringify({ writer: 'p-bravo', node: 'node-bravo', nodeName: 'BRAVO', n: 1, event }) },
    ];
    h.liveRows = [{ process_id: 'p-bravo', live: true, takeover_seconds: 60 }];
    const pm = getPremiumManager();
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    pm.invalidate();
    pm.getAllTiers();
    expect(pm.heldEventsText()).toBe('Premium holds provider events that BRAVO received while premium-tiers.json could not be read there; nothing was saved. The bot on BRAVO applies them once it runs normally (any bot does once that one has been stopped for 60 s); try again then.');
    pm.invalidate();
    pm.getAllTiers();
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: ['j-old'] }]);
  });
});

describe("the replay's marks", () => {
  /** Journals the events while premium-tiers.json cannot be read, then lets the replay save its marks: their ticket. */
  async function replayed(events: object[]): Promise<Ticket> {
    h.unreadable = true;
    getPremiumManager();
    startPremiumTickers();
    for (const e of events) emit(e);
    const before = h.saves.length;
    readableAgain();
    await until(() => h.saves.length > before);
    expect(h.saves).toHaveLength(before + 1);
    expect(h.saves[before].data.eventsApplied?.[processId()]).toBeGreaterThan(0);
    await tick(10);
    return h.saves[before].ticket;
  }

  it('delete only the own lines they cover once their save landed, not a line kept after them', async () => {
    const t1 = await replayed([expired('e1', 'g2'), expired('e3', 'g3')]);
    expect(h.saves[0].data.eventsApplied).toEqual({ [processId()]: 2 });
    unreadableAgain();
    emit(expired('e1', 'g2'));
    expect(h.appends).toHaveLength(3);
    const [a, b] = h.appends.map(x => x.id);
    expect(h.deletes).toEqual([]);
    settle(t1, 'landed');
    await until(() => h.deletes.length > 0, 600);
    await tick(10);
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: [a, b] }]);
  });

  it('delete the lines at once when their save lands', async () => {
    const t1 = await replayed([expired('e1', 'g2')]);
    expect(h.deletes).toEqual([]);
    settle(t1, 'landed');
    const at = Date.now();
    await until(() => h.deletes.length > 0, 600);
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: [h.appends[0].id] }]);
    expect(Date.now() - at).toBeLessThan(600);
  });

  it('ride the next save that lands when their own save was refused', async () => {
    const t1 = await replayed([expired('e1', 'g2')]);
    settle(t1, { refused: { cause: 'io' } });
    await tick(20);
    expect(h.deletes).toEqual([]);
    expect(getPremiumManager().setTier('high', { displayName: 'Higher', priority: 2, overrides: {}, offerings: [] })).toBe(true);
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].data.eventsApplied).toEqual({ [processId()]: 1 });
    settle(h.saves[1].ticket, 'landed');
    await until(() => h.deletes.length > 0, 2500);
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: [h.appends[0].id] }]);
  });

  it("of a later replay are kept when an earlier replay's save is refused, and delete the lines once they land", async () => {
    const t1 = await replayed([expired('e1', 'g2')]);
    unreadableAgain();
    emit(expired('e3', 'g3'));
    readableAgain();
    await until(() => h.saves.length > 1);
    expect(h.saves).toHaveLength(2);
    const t2 = h.saves[1].ticket;
    await tick(10);
    settle(t1, { refused: { cause: 'io' } });
    await tick(20);
    settle(t2, 'landed');
    await until(() => h.deletes.length > 0, 800);
    expect(h.deletes).toEqual([{ key: JOURNAL_KEY, ids: h.appends.map(x => x.id) }]);
  });
});

describe('a member notice whose save was refused', () => {
  it('is logged with the cause and no word of a lost answer', async () => {
    getPremiumManager();
    emit(expired('e1', 'g2'));
    expect(h.saves).toHaveLength(1);
    settle(h.saves[0].ticket, { refused: { cause: 'io' } });
    const want = '[PremiumManager] The paid.sub.expired notice for guild g2 was not sent: the change it announces was not saved (io)';
    await until(() => logged(spies.warn).some(l => l.includes('notice for guild g2')));
    expect(logged(spies.warn).filter(l => l.includes('notice for guild g2'))).toEqual([want]);
    expect(notices.sent).toEqual([]);
  });
});

describe('a tier change that makes the tier stricter', () => {
  it("tells only the guilds with an active or paused subscription on that tier, and its audit line names the admin", async () => {
    const tiers = { ...TIERS, low: { ...TIERS.low, overrides: { someModule: { limit: 5 } } } };
    const pausedOn = (id: string, sub: string, tierId: string) => ({ ...paidSub(id, sub, tierId), status: 'paused' });
    h.premium = premiumText({
      g2: { active: paidSub('s2', 'e2', 'low'), paused: [] },
      g3: { active: paidSub('s3', 'e3', 'high'), paused: [] },
      g4: { active: paidSub('s4', 'e4', 'high'), paused: [pausedOn('s5', 'e5', 'low')] },
      g5: { active: paidSub('s6', 'e6', 'high'), paused: [pausedOn('s7', 'e7', 'high')] },
    }, {}, tiers);
    const pm = getPremiumManager();
    expect(pm.setTier('low', { displayName: 'Low', priority: 1, overrides: {}, offerings: [] })).toBe(true);
    expect(h.saves).toHaveLength(1);
    const lines = h.saves[0].opts.lines.lines.map((l: { line: Buffer }) => JSON.parse(l.line.toString('utf8')));
    expect(lines.map((l: any) => [l.action, l.actor, l.tierId])).toEqual([['tier.update', 'admin', 'low']]);
    settle(h.saves[0].ticket, 'landed');
    await until(() => notices.sent.length >= 2, 1000);
    await tick(20);
    expect(notices.sent.filter(n => n.kind === 'tier.config-change-affecting-subscriber').map(n => n.guildId).sort()).toEqual(['g2', 'g4']);
  });
});

describe('readAuditEntries on a JSON bot', () => {
  it('answers no entries, not truncated, when the audit file does not exist', async () => {
    setBackendKind('file');
    const pm = getPremiumManager();
    expect(fs.existsSync(dataPath('global', 'premium-tiers.audit.jsonl'))).toBe(false);
    await expect(pm.readAuditEntries()).resolves.toEqual({ entries: [], total: 0, truncated: false });
  });
});

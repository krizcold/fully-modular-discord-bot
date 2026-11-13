import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a Postgres bot (NB6 decisions 27, 40, 63, 64, 96, 102): the data facade's save answers as each
// test scripts it, row ops settle when the test opens them, and the shared lines and the mirror are recorded. The
// manager is the real one.

type Answer = 'saved' | { refused: string };
const h = vi.hoisted(() => ({
  script: [] as Array<'saved' | { refused: string }>,
  saves: [] as Array<{ opts: any; data: any }>,
  gates: [] as Array<(value: unknown) => void>,
  auto: null as unknown,
  refresh: [] as string[][],
  steps: [] as unknown[],
  carried: [] as Array<{ key: string; lines: Array<{ id: string; line: string }>; opts: unknown }>,
  deleted: [] as Array<{ key: string; ids: string[] }>,
  readLines: null as null | (() => Promise<unknown>),
  journal: [] as Array<{ id: string; line: string }>,
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const { dataPath } = await import('../../src/utils/dataRoot');
  const premium = dataPath('global', 'premium-tiers.json');
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file === premium) return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      return real.readRawStrict(file);
    },
    saveDataTracked: (file: string, opts: any, data: unknown) => {
      h.saves.push({ opts, data: JSON.parse(JSON.stringify(data)) });
      const next = h.script.shift() ?? 'saved';
      if (next !== 'saved') return { outcome: 'refused', cause: next.refused };
      return { outcome: 'saved', ticket: { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 } };
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return {
    ...real,
    rowBackend: () => ({ sharedSelect: async () => ({ rows: [] }) }),
    rowOutcome: () => {
      if (h.auto !== null) return Promise.resolve(h.auto);
      return new Promise(resolve => { h.gates.push(resolve); });
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    setSharedLinesPassStep: (step: unknown) => { h.steps.push(step); },
    refreshShared: (keys: string[]) => {
      h.refresh.push(keys);
      return Promise.resolve({ ok: true });
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = (key: string) => ({ kind: 'row', key, op: { state: 'landed', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return {
    ...real,
    carryLines: (key: string, lines: Array<{ id: string; line: string }>, opts: unknown) => {
      h.carried.push({ key, lines, opts });
      return ticket(key);
    },
    deleteLines: (key: string, ids: string[]) => {
      h.deleted.push({ key, ids: [...ids] });
      return ticket(key);
    },
    appendLine: (key: string) => ticket(key),
    readLines: () => (h.readLines ? h.readLines() : Promise.resolve({ ok: true, lines: [] })),
    readJournal: () => Promise.resolve({ ok: true, lines: h.journal }),
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { JOURNAL_KEY } from '../../src/bot/internalSetup/utils/sharedLines';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, gate, paidSub, quiet, state, tick, TIERS, writePremium } from './nb10PremiumRig';

const PREMIUM_KEY = 'global/premium-tiers.json';
const AUDIT_KEY = 'global/premium-tiers.audit.jsonl';
const AUDIT_DOC = 'global:/premium-tiers.audit.jsonl';
const DEFAULT_LABEL = 'Upgrade your tier';
const role = process.env.BOT_PROCESS_ROLE;
let managers: PremiumManager[] = [];
let cancelGate = gate<unknown>();

function manager(): PremiumManager {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true, supportsCancel: true }, isConfigured: () => true,
    pauseSubscription: async () => undefined,
    cancelSubscription: () => cancelGate.promise,
  } as any);
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

const script = (...answers: Answer[]) => { h.script = answers; };
const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const expired = (subId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'fake', providerSubId: subId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});
const label = (pm: PremiumManager) => pm.getMessages().upgradeButtonLabel;

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(2);
}

function openRow(index: number, outcome: unknown): void {
  h.gates[index](outcome);
}

beforeEach(() => {
  quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  setBackendKind('postgres');
  Object.assign(h, { script: [], saves: [], gates: [], auto: null, refresh: [], steps: [], carried: [], deleted: [], readLines: null, journal: [] });
  reg.current = null;
  cancelGate = gate<unknown>();
  clearGlobal();
  writePremium({ g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } });
});
afterEach(async () => {
  h.auto = 'landed';
  for (const open of h.gates.splice(0)) open('landed');
  cancelGate.open(undefined);
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

describe("the shared pass's journal read", () => {
  it('a bot manager hands its read to the pass and takes it back when disposed', () => {
    const pm = manager();
    expect(typeof h.steps[h.steps.length - 1]).toBe('function');
    pm.dispose();
    managers = managers.filter(m => m !== pm);
    expect(h.steps[h.steps.length - 1]).toBeNull();
  });

  it('a load whose marks cover every replayable journal line deletes those lines', async () => {
    writePremium({ g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } }, { eventsApplied: { 'old-proc': 3 } });
    h.journal = [{ id: 'j1', line: JSON.stringify({ writer: 'old-proc', node: 'another-node', n: 2, event: { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'e1', guildId: 'g2', state: state() } }) }];
    const pm = manager();
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(h.deleted).toEqual([]);
    pm.invalidate();
    pm.getMessages();
    expect(h.deleted).toEqual([{ key: JOURNAL_KEY, ids: ['j1'] }]);
  });
});

describe('a save the database cannot store (unstorable)', () => {
  it('keeps its change in the cache', () => {
    const pm = manager();
    script({ refused: 'unstorable' });
    expect(pm.setMessages({ upgradeButtonLabel: 'Kept' })).toBe(false);
    expect(label(pm)).toBe('Kept');
  });

  it('keeps its change in the cache after an earlier drop of the cache', () => {
    const pm = manager();
    pm.invalidate();
    script({ refused: 'unstorable' });
    expect(pm.setMessages({ upgradeButtonLabel: 'Kept' })).toBe(false);
    expect(label(pm)).toBe('Kept');
  });

  it('keeps its change in the cache after an earlier save was accepted', () => {
    const pm = manager();
    h.auto = 'landed';
    script('saved', { refused: 'unstorable' });
    expect(pm.setMessages({ upgradeButtonLabel: 'First' })).toBe(true);
    expect(pm.setMessages({ upgradeButtonLabel: 'Second' })).toBe(false);
    expect(label(pm)).toBe('Second');
  });

  it('drops the cache when a drop came while a save was held', () => {
    const pm = manager();
    script({ refused: 'storage-failing' }, { refused: 'unstorable' });
    expect(pm.setMessages({ upgradeButtonLabel: 'Held' })).toBe(true);
    pm.invalidate();
    expect(pm.setMessages({ upgradeButtonLabel: 'Too large' })).toBe(false);
    expect(label(pm)).toBe(DEFAULT_LABEL);
  });
});

describe('a row op that settles', () => {
  it('keeps the subscription reader not ready while the op is open', async () => {
    const pm = manager();
    expect(getPaymentRegistry().subscriptionReaderReady()).toBe(true);
    expect(pm.setMessages({ upgradeButtonLabel: 'Open' })).toBe(true);
    expect(getPaymentRegistry().subscriptionReaderReady()).toBe(false);
    openRow(0, 'landed');
    await until(() => getPaymentRegistry().subscriptionReaderReady());
    expect(getPaymentRegistry().subscriptionReaderReady()).toBe(true);
  });

  it('refused for a cause other than changed-elsewhere, keeps the cache', async () => {
    const pm = manager();
    h.auto = { refused: { cause: 'io' } };
    expect(pm.setMessages({ upgradeButtonLabel: 'Refused' })).toBe(true);
    await tick(10);
    expect(label(pm)).toBe('Refused');
  });
});

describe('an event handed outside every op whose save was held', () => {
  it('is handed again when the save that took its list is refused changed-elsewhere', async () => {
    const pm = manager();
    script({ refused: 'storage-failing' }, 'saved', 'saved');
    emit(expired('e1', 'g2'));
    expect(h.saves).toHaveLength(1);
    expect(pm.setMessages({ upgradeButtonLabel: 'Takes the list' })).toBe(true);
    expect(h.gates).toHaveLength(1);
    openRow(0, { refused: { cause: 'changed-elsewhere' } });
    await until(() => h.saves.length >= 3);
    expect(h.refresh).toEqual([[PREMIUM_KEY]]);
    expect(h.saves).toHaveLength(3);
  });

  it('is handed again when an earlier op is refused changed-elsewhere while the save is held', async () => {
    const pm = manager();
    script('saved', { refused: 'storage-failing' }, 'saved');
    expect(pm.setMessages({ upgradeButtonLabel: 'Earlier' })).toBe(true);
    emit(expired('e1', 'g2'));
    expect(h.saves).toHaveLength(2);
    openRow(0, { refused: { cause: 'changed-elsewhere' } });
    await until(() => h.saves.length >= 3);
    expect(h.refresh).toEqual([[PREMIUM_KEY]]);
    expect(h.saves).toHaveLength(3);
  });

  it('is not handed again after its held save was refused unstorable', async () => {
    const pm = manager();
    script('saved', { refused: 'storage-failing' }, { refused: 'unstorable' }, 'saved');
    expect(pm.setMessages({ upgradeButtonLabel: 'Earlier' })).toBe(true);
    emit(expired('e1', 'g2'));
    expect(pm.setMessages({ upgradeButtonLabel: 'Too large' })).toBe(false);
    expect(h.saves).toHaveLength(3);
    openRow(0, { refused: { cause: 'changed-elsewhere' } });
    await tick(40);
    expect(h.refresh).toEqual([]);
    expect(h.saves).toHaveLength(3);
  });
});

describe('a change refused while kept provider events wait', () => {
  it("writes the change's audit line marked not saved, in an op that locks premium-tiers.json", async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1', 'low'), paused: [] } });
    h.journal = [{ id: 'j1', line: JSON.stringify({ writer: 'old-proc', node: 'another-node', n: 1, event: { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'zz', guildId: 'g9', state: state() } }) }];
    const pm = manager();
    const cancelled = pm.cancelPaidSubscriptionImmediately('g1');
    await tick(2);
    expect(await pm.readSharedJournal(true)).toEqual({ ok: true });
    await until(() => pm.cacheState() === 'replaying');
    expect(pm.cacheState()).toBe('replaying');
    cancelGate.open(undefined);
    expect(await cancelled).toBe(false);
    expect(h.carried).toHaveLength(1);
    expect(h.carried[0].key).toBe(AUDIT_KEY);
    expect(h.carried[0].opts).toEqual({ lockKey: PREMIUM_KEY });
    expect(h.carried[0].lines).toHaveLength(1);
    expect(JSON.parse(h.carried[0].lines[0].line)).toMatchObject({
      action: 'subscription.cancel.paid', guildId: 'g1', subscriptionId: 's1',
      metadata: { immediately: true, notSaved: { cause: 'not-ready' } },
    });
  });
});

describe("the Dummy tick's walk batch on a cache with no stored row", () => {
  it("saves on the base 'absent'", () => {
    clearGlobal();
    const pm = manager();
    script({ refused: 'unstorable' }, 'saved');
    expect(pm.setFullConfig({
      tiers: JSON.parse(JSON.stringify(TIERS)), subscriptions: { g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } } as any,
      messages: {} as any, providerAccountLinks: {}, activatedProviders: {}, migrations: [], migrationSilencePolicy: 'cancel',
    })).toBe(false);
    getPaymentRegistry().emitWalkBatch({
      premiumSha: null,
      events: [{ type: 'subscription.renewed', providerId: 'fake', providerSubId: 'e1', guildId: 'g2', state: state() }],
    } as any);
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].opts.baseSha).toBe('absent');
  });
});

describe('a redelivery whose audit lines cannot be read', () => {
  it('answers the audit file as refused io and writes no install line', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1', 'low'), paused: [] } });
    h.auto = 'landed';
    h.readLines = () => Promise.resolve({ ok: false, cause: 'the database did not answer' });
    const pm = manager();
    const refused = await runSealed('console', null, 'premium', async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      emit({ type: 'subscription.created', providerId: 'fake', providerSubId: 'ps1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() });
      await pm.settled(ledger);
      return ledger.refusedDocs().filter(r => r.doc === AUDIT_DOC);
    });
    expect(refused).toEqual([{ cause: 'io', doc: AUDIT_DOC, seq: expect.any(Number), retried: false }]);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0].opts.lines).toBeUndefined();
    expect(h.carried).toEqual([]);
  });
});

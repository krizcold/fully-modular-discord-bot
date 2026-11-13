import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a Postgres bot (L5 run A, chunk 13-2): an audit line made after the stop is refused in the
// caller's ledger and logged with the install or webhook words; a carried line's marked copy keeps its metadata and its
// drop texts name a line with no guild; a standalone line's op is in the ledger; an install line's entry follows its op
// (landed, gone, replaced); the exit names a landed op's items and a can't-confirm install line exactly; an event
// kept while premium-tiers.json cannot be read is a journal key line; the shared journal's lines are checked one by one.

type Gate = { promise: Promise<any>; open: (value?: any) => void };
const h = vi.hoisted(() => ({
  saves: [] as Array<{ file: string; opts: any }>,
  tickets: [] as any[],
  gates: [] as Array<{ promise: Promise<any>; open: (value?: any) => void }>,
  auto: null as any,
  carried: [] as any[],
  appended: [] as Array<{ key: string; line: string; id: string | undefined }>,
  journal: { ok: true, lines: [] } as any,
  journalReads: 0,
  auditLines: { ok: true, lines: [] } as any,
  pool: null as any,
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
    saveDataTracked: (file: string, opts: any) => {
      h.saves.push({ file, opts });
      const ticket = { kind: 'row', key: 'global/premium-tiers.json', op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 };
      h.tickets.push(ticket);
      return { outcome: 'saved', ticket };
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return {
    ...real,
    rowBackend: () => h.pool ?? real.rowBackend(),
    rowOutcome: () => {
      if (h.auto !== null) return Promise.resolve(h.auto);
      let open!: (value?: any) => void;
      const promise = new Promise<any>(resolve => { open = resolve; });
      h.gates.push({ promise, open });
      return promise;
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return { ...real, setSharedLinesPassStep: () => undefined, refreshShared: () => Promise.resolve({ ok: true }) };
});
vi.mock('../../src/bot/internalSetup/utils/sharedLines', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedLines')>();
  const ticket = (key: string) => ({ kind: 'row', key, op: { state: 'queued', unknown: [], commitOnWire: false, writes: 1 }, seq: 1 });
  return {
    ...real,
    carryLines: (key: string) => {
      const t = ticket(key);
      h.carried.push(t);
      return t;
    },
    deleteLines: (key: string) => ticket(key),
    appendLine: (key: string, line: string, id?: string) => {
      h.appended.push({ key, line, id });
      return ticket(key);
    },
    readJournal: () => {
      h.journalReads += 1;
      return Promise.resolve(h.journal);
    },
    readLines: () => Promise.resolve(h.auditLines),
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

import { PremiumManager, type AuditEntry } from '../../src/bot/internalSetup/utils/premiumManager';
import { forgetItems, newCarry, type Item } from '../../src/bot/internalSetup/utils/premiumItems';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { markPaymentLedger, openLedger, runInLedger, runSealed, writesOf } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { setBackendKind } from '../helpers/backendKind';
import { clearGlobal, logged, paidSub, PREMIUM, quiet, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const AUDIT_DOC = 'global:/premium-tiers.audit.jsonl';
const TS = '2026-11-13T10:00:00.000Z';
let spies: ReturnType<typeof quiet>;
const managers: PremiumManager[] = [];

function manager(): PremiumManager {
  getPaymentRegistry().register({ id: 'fake', displayName: 'Fake', capabilities: {}, isConfigured: () => true } as any);
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}

const emit = (event: object) => getPaymentRegistry().emitEvent(event as any);
const created = (providerSubId: string, guildId = 'g1') => ({
  type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state(),
});
const expired = (subId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'fake', providerSubId: subId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});
const install = (extra: Partial<AuditEntry> = {}): AuditEntry => ({
  timestamp: TS, actor: 'admin', action: 'subscription.install.paid', guildId: 'g1', tierId: 'low', offeringId: 'o1',
  providerId: 'fake', subscriptionId: 's1', metadata: { variantId: 'v1' }, ...extra,
});
const writeAudit = (pm: PremiumManager, entry: AuditEntry, link: object, providerSubId?: string): void =>
  (pm as any).writeAudit(entry, link, providerSubId);
const saveCarry = (pm: PremiumManager, carry: object): unknown => (pm as any).save({ carry });

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return;
    await tick(2);
  }
}

function exitErrors(pm: PremiumManager): string[] {
  spies.error.mockClear();
  pm.markStopped('stopping');
  pm.logLossesAtExit();
  return logged(spies.error);
}

const savedLines = (i: number): any[] => (h.saves[i]?.opts?.lines?.lines ?? []).map((l: { line: Buffer }) => JSON.parse(l.line.toString('utf8')));

beforeEach(() => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  setBackendKind('postgres');
  Object.assign(h, {
    saves: [], tickets: [], gates: [], auto: null, carried: [], appended: [], journal: { ok: true, lines: [] }, journalReads: 0,
    auditLines: { ok: true, lines: [] }, pool: null,
  });
  reg.current = null;
  clearGlobal();
  writePremium({ g2: { active: paidSub('s2', 'e1', 'low'), paused: [] } });
});
afterEach(async () => {
  h.auto = 'landed';
  for (const g of h.gates.splice(0)) g.open('landed');
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

describe('an audit line made after the stop', () => {
  function afterStop(entry: AuditEntry, webhook = false): { errors: string[]; refused: Array<[string, string]> } {
    const pm = manager();
    pm.markStopped('stopping');
    spies.error.mockClear();
    const ledger = openLedger('console');
    if (webhook) markPaymentLedger(ledger, 'payment.webhook');
    runInLedger(ledger, 'premium', () => writeAudit(pm, entry, { standalone: 'test' }, 'ps1'));
    return { errors: logged(spies.error), refused: ledger.refusedDocs().map(r => [r.cause, r.doc]) };
  }

  it("is refused in the caller's ledger as the audit file's refusal by the stop", () => {
    const { refused } = afterStop(install());
    expect(refused).toEqual([['node-stopping', AUDIT_DOC]]);
  });

  it('an install line outside a webhook names its subscription and is lost with its whole line', () => {
    const entry = install();
    const { errors } = afterStop(entry);
    expect(errors).toEqual([
      `[PremiumManager] The audit line subscription.install.paid (guild g1, subscription ps1) was not written before this stop and is lost: ${JSON.stringify(entry)}`,
    ]);
  });

  it("an install line in a webhook says the provider's next delivery writes it", () => {
    const entry = install();
    const { errors } = afterStop(entry, true);
    expect(errors).toEqual([
      `[PremiumManager] The audit line subscription.install.paid (guild g1, subscription ps1) was not written before this stop; the webhook was answered 503, and the provider's next delivery of it writes this line, or, when the subscription's own save was lost too, installs the subscription again under a new id with its own line: ${JSON.stringify(entry)}`,
    ]);
  });

  it('an install line with no subscription id is logged as a plain line', () => {
    const entry = install({ subscriptionId: undefined });
    const { errors } = afterStop(entry);
    expect(errors).toEqual([`[PremiumManager] The audit line subscription.install.paid (guild g1, ${TS}) was not written: the bot is stopping; it is lost`]);
  });
});

describe('an audit line carried by a save', () => {
  function carried(entry: AuditEntry): Item {
    const pm = manager();
    const carry = newCarry();
    writeAudit(pm, entry, { carry });
    expect(carry.items).toHaveLength(1);
    return carry.items[0];
  }
  const tierLine = (): AuditEntry => ({ timestamp: TS, actor: 'admin', action: 'tier.create', tierId: 'low', metadata: { note: 'kept' } });

  it('its marked copy keeps the metadata it had', () => {
    const entry = tierLine();
    const item = carried(entry);
    const at = '2026-11-13T11:00:00.000Z';
    expect(JSON.parse(item.marked!('io', at))).toEqual({ ...entry, metadata: { note: 'kept', notSaved: { cause: 'io', at } } });
    forgetItems([item]);
  });

  it('names a line with no guild as guild none in each drop text', () => {
    const entry = tierLine();
    const item = carried(entry);
    spies.error.mockClear();
    item.drop({ kind: 'stopped', words: 'the bot is stopping' });
    item.drop({ kind: 'unsure', words: 'before this stop' });
    item.drop({ kind: 'refused', words: 'io' });
    expect(logged(spies.error)).toEqual([
      `[PremiumManager] The audit line tier.create (guild none, ${TS}) was not written: the bot is stopping; it is lost`,
      `[PremiumManager] The audit line tier.create (guild none, ${TS}) was being written before this stop; can't confirm whether it is stored: ${JSON.stringify(entry)}`,
      `[PremiumManager] The audit line tier.create (guild none, ${TS}) was not written: the change it records was not saved (io)`,
    ]);
    forgetItems([item]);
  });

  it("a standalone line's op is recorded in the caller's ledger", () => {
    const pm = manager();
    const ledger = openLedger('console');
    runInLedger(ledger, 'premium', () => writeAudit(pm, { timestamp: TS, actor: 'admin', action: 'tier.create', tierId: 'low' }, { standalone: 'test' }));
    expect(h.carried).toHaveLength(1);
    expect(writesOf(ledger).tickets).toEqual([h.carried[0]]);
  });
});

describe("an install line's entry follows its op", () => {
  it('a refused op forgets the line: the exit names none and a redelivery writes it again', async () => {
    const pm = manager();
    h.auto = { refused: { cause: 'io' } };
    emit(created('c1'));
    await until(() => logged(spies.warn).some(l => l.includes('paid.sub.started notice for guild g1 was not sent')));
    expect(savedLines(0).map(l => l.action)).toEqual(['subscription.install.paid']);
    await runSealed('console', null, 'premium', async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      emit(created('c1'));
      await until(() => h.saves.length >= 2);
    });
    expect(h.saves).toHaveLength(2);
    const again = savedLines(1);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: savedLines(0)[0].subscriptionId, metadata: { redelivered: true } });
  });

  it('a refused op leaves no install line for the exit to name', async () => {
    const pm = manager();
    h.auto = { refused: { cause: 'io' } };
    emit(created('c1'));
    await until(() => logged(spies.warn).some(l => l.includes('paid.sub.started notice for guild g1 was not sent')));
    expect(exitErrors(pm).filter(l => l.includes('subscription.install.paid'))).toEqual([]);
  });

  it("an earlier line of the same subscription that settles leaves the newer line's entry", () => {
    const pm = manager();
    const first = newCarry();
    const second = newCarry();
    const newer = install({ timestamp: '2026-11-13T10:00:01.000Z' });
    writeAudit(pm, install(), { carry: first }, 'psX');
    writeAudit(pm, newer, { carry: second }, 'psX');
    saveCarry(pm, second);
    expect(h.tickets).toHaveLength(1);
    forgetItems(first.items);
    const lines = exitErrors(pm).filter(l => l.includes('subscription psX)'));
    expect(lines).toEqual([
      `[PremiumManager] The audit line subscription.install.paid (guild g1, subscription psX) did not reach the disk before this stop and is lost: ${JSON.stringify(newer)}`,
    ]);
  });

  it("an install line with no guild whose op ended unconfirmed is named can't confirm, ending with its line", () => {
    const pm = manager();
    const carry = newCarry();
    const entry = install({ guildId: undefined, subscriptionId: 'sY' });
    writeAudit(pm, entry, { carry }, 'psY');
    saveCarry(pm, carry);
    h.tickets[0].op.state = 'unconfirmed';
    const lines = exitErrors(pm).filter(l => l.includes('subscription psY)'));
    expect(lines).toEqual([
      `[PremiumManager] The audit line subscription.install.paid (guild none, subscription psY) is in the file, but the disk did not confirm its sync; can't confirm whether it is stored: ${JSON.stringify(entry)}`,
    ]);
  });
});

describe('the exit lines of a landed row op', () => {
  it('name neither its audit line nor a notice as lost, and the open notice is named not sent', () => {
    const pm = manager();
    emit(expired('e1', 'g2'));
    expect(h.tickets).toHaveLength(1);
    expect(savedLines(0).map(l => l.action)).toEqual(['subscription.expire.paid']);
    h.tickets[0].op.state = 'landed';
    spies.warn.mockClear();
    const errors = exitErrors(pm);
    expect(errors.filter(l => l.includes('The audit line subscription.expire.paid'))).toEqual([]);
    expect(logged(spies.warn)).toContain('[PremiumManager] The paid.sub.expired notice for guild g2 was not sent: the bot is stopping');
  });
});

describe('a provider event while premium-tiers.json cannot be read', () => {
  it('is kept as a line of the journal key with this process as its writer', () => {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = manager();
    expect(pm.cacheState()).toBe('unreadable');
    const event = created('j1');
    emit(event);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].key).toBe('global/premium-tiers.events.jsonl');
    expect(JSON.parse(h.appended[0].line)).toMatchObject({ writer: processId(), n: expect.any(Number), event });
    expect(logged(spies.warn).filter(l => l.includes('premium-tiers.events.jsonl'))).toEqual([
      '[PremiumManager] A subscription.created event from fake (subscription j1, guild g1) arrived while premium-tiers.json cannot be read; it is kept in premium-tiers.events.jsonl and applied once premium runs normally',
    ]);
  });
});

describe("the shared journal's lines", () => {
  const HELD = 'Premium holds provider events the bot has not applied yet (premium-tiers.events.jsonl); nothing was saved. Start the bot to apply them, then try again.';

  async function heldWith(lines: string[]): Promise<{ read: unknown; text: string | null }> {
    process.env.BOT_PROCESS_ROLE = 'webui';
    h.pool = { sharedSelect: async () => ({ rows: [] }) };
    h.journal = { ok: true, lines: lines.map((line, i) => ({ id: `j${i}`, line })) };
    const pm = manager();
    const read = await pm.readSharedJournal(false);
    return { read, text: pm.heldEventsText() };
  }

  it('keeps a whole line of another writer, which holds the ops', async () => {
    expect(await heldWith([JSON.stringify({ writer: 'w1', n: 1, event: { type: 'subscription.created' } })])).toEqual({ read: { ok: true }, text: HELD });
  });

  it.each([
    ['cut short', '{"writer":"w1"'],
    ['null', 'null'],
    ['an event with no type', JSON.stringify({ writer: 'w1', n: 1, event: {} })],
    ['no event', JSON.stringify({ writer: 'w1', n: 1 })],
    ['a count that is text', JSON.stringify({ writer: 'w1', n: '1', event: { type: 'subscription.created' } })],
    ['a writer that is a number', JSON.stringify({ writer: 5, n: 1, event: { type: 'subscription.created' } })],
  ])('skips a line with %s', async (_what, line) => {
    expect(await heldWith([line])).toEqual({ read: { ok: true }, text: null });
  });

  it('on a JSON bot reads no journal key', async () => {
    setBackendKind('file');
    h.journal = { ok: false, cause: 'the database is down' };
    const pm = manager();
    expect(await pm.readSharedJournal(false)).toEqual({ ok: true });
    expect(h.journalReads).toBe(0);
  });
});

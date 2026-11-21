import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 16 (part 4a): an event whose `holder` is not a holder key is not applied, and L2 holds its JSON. Live, it
// changes nothing. Kept in the journal with a valid event behind it, the replay applies the valid one, raises the
// marks over both, deletes both lines and leaves premium in its normal state. No writer of this tree journals an
// event without a holder key (a provider emits none), so the journal rows write their lines by hand: on the JSON
// files before the load that replays them, on the mirror rig as another process's lines.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { dataPath } from '../../src/utils/dataRoot';
import { notices } from '../helpers/p1Mocks';
import { JOURNAL_KEY } from '../helpers/nb6PremiumRig';
import { allowDropLines } from '../helpers/p1Guard';
import { gh } from '../helpers/p1Holder';
import { p1World, SELLER_ID, SERVERS } from '../helpers/p1World';

const JOURNAL = dataPath('global', 'premium-tiers.events.jsonl');
const SERVER = gh(SERVERS[0]);
const L2 = (event: any) => `[PremiumManager] A ${event.type} event from ${SELLER_ID} (subscription ${event.providerSubId}) names no holder; it was not applied: ${JSON.stringify(event)}`;

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P1 claim 16 on %s: an event without a holder key', (_name, backend) => {
  const w = p1World(backend);
  let lines: string[] = [];
  const logged = (text: string): string[] => (backend === 'rig' ? w.logged(text) : lines.filter(l => l.includes(text)));
  beforeEach(async () => {
    lines = [];
    await w.setup();
    if (backend === 'json') {
      for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await w.teardown();
    fs.rmSync(JOURNAL, { force: true });
  });

  /** The seller's renewal of the server's subscription as its event, and the same event naming 'g1' for its holder. */
  function renewal(): { valid: any; bad: any; end: string } {
    const sub = w.recordOf(SERVER).active.providerSubId;
    const record = w.seller.renew(sub)!;
    const valid = w.stateEvent('subscription.renewed', record) as any;
    return { valid, bad: { ...valid, holder: 'g1' }, end: record.endDate! };
  }

  it.each(['g1', 'guild:g1', '70000000000000001', 'guild:05', 'member:5', '', null, 5])('live, a renewal whose holder is %j is not applied and L2 holds its JSON', async holder => {
    expect(await w.purchase(SERVER, 'mid')).toMatchObject({ ok: true });
    const { valid } = renewal();
    const event = { ...valid, holder };
    const before = { premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) };
    allowDropLines('L2');

    const reply = await w.deliver(event);

    expect(reply).toMatchObject({ ok: true });
    expect({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) }).toEqual(before);
    expect(logged('names no holder')).toEqual([L2(event)]);

    expect(await w.deliver(valid)).toMatchObject({ ok: true });
    expect(w.recordOf(SERVER).active.endDate).toBe(valid.state.endDate);
    expect(logged('names no holder')).toHaveLength(1);
  });

  it("live, a created event whose holder is 'g1' installs nothing and logs L2, not L3", async () => {
    const record = w.orphan(SERVER, 'low');
    const event = { ...(w.createdEvent(record) as any), holder: 'g1' };
    const before = { premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) };
    allowDropLines('L2');

    expect(await w.deliver(event)).toMatchObject({ ok: true });

    expect({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) }).toEqual(before);
    expect(logged('names no holder')).toEqual([L2(event)]);
    expect(logged('was not installed')).toEqual([]);
  });

  it('kept in the journal with a valid one behind it: the replay applies the valid one, raises the marks over both, deletes both lines and leaves premium normal', async () => {
    expect(await w.purchase(SERVER, 'mid')).toMatchObject({ ok: true });
    const { valid, bad, end } = renewal();
    await w.settle();
    allowDropLines('L2');
    let writer: string;

    if (backend === 'json') {
      writer = 'w1';
      fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer, n: 1, event: bad })}\n${JSON.stringify({ writer, n: 2, event: valid })}\n`);
      await w.reload();
      expect(getPremiumManager().cacheState()).toBe('replaying');
      startPremiumTickers();
    } else {
      writer = 'p-dead';
      startPremiumTickers();
      getPremiumManager().getAllTiers();
      const rows = w.rig!.m.state.rows;
      rows.putLine(JOURNAL_KEY, 'j1', JSON.stringify({ writer, node: 'node-bravo', nodeName: 'BRAVO', n: 1, event: bad }));
      rows.putLine(JOURNAL_KEY, 'j2', JSON.stringify({ writer, node: 'node-bravo', nodeName: 'BRAVO', n: 2, event: valid }));
      await runSharedPass();
    }

    await vi.waitFor(async () => {
      await w.settle();
      expect(w.stored().eventsApplied).toEqual({ [writer]: 2 });
    }, { timeout: 8000, interval: 20 });
    const journalLeft = (): number => (backend === 'json'
      ? (fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(l => l.trim()).length : 0)
      : [...w.rig!.m.state.rows.lines.values()].filter(l => l.key === JOURNAL_KEY).length);
    await vi.waitFor(async () => {
      await w.settle();
      expect(journalLeft()).toBe(0);
    }, { timeout: 8000, interval: 20 });

    expect(w.recordOf(SERVER).active.endDate).toBe(end);
    expect(logged('names no holder')).toEqual([L2(bad)]);
    expect(getPremiumManager().cacheState()).toBe('normal');
    expect(await w.op('setMessages', { moduleBlocked: 'blocked' })).toMatchObject({ ok: true });
    expect(w.stored().eventsApplied).toEqual({ [writer]: 2 });
    expect(w.recordOf(SERVER).active.endDate).toBe(end);
  });
});

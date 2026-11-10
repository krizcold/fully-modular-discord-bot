import { describe, expect, it } from 'vitest';
import {
  behindNoticeText, decideMain, tieText, type AnsweredProbe, type NoticeRead,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// NB24 section 8 test 2: decideMain chooses no database while the newest notice read names two or more machines.

const STORE = 'store-a';
const DATE = '2026-11-01T10:00:00.000Z';
const opts = { markerStoreId: STORE, noticeCheckOff: false };

function db(generation: number, machine: string): AnsweredProbe {
  return {
    kind: 'answered', address: 'a:5432/bot', entry: 'postgresql://bot:pw@a:5432/bot', inRecovery: false, readOnly: false,
    generation, machine, since: DATE, sysid: 'sys-a', started: 'start-a', storeId: STORE,
  };
}
const notice = (generation: number, machines: string[]): NoticeRead => ({ kind: 'notice', generation, machine: machines[0], date: DATE, machines });

const reasonOf = (d: ReturnType<typeof decideMain>) => ('reason' in d ? d.reason : null);

describe('NB24 test 2: decideMain with a tie in the notices', () => {
  it('(a) the chosen row A at 3 and a notice at 3 naming A and B: tie', () => {
    const d = decideMain([db(3, 'A')], notice(3, ['A', 'B']), opts);
    expect(d.outcome).toBe('tie');
    expect(reasonOf(d)).toBe("2 machines announced main generation 3 in the switch notices (A and B); can't confirm which is the main, so the bot stays stopped until the owner chooses one in the Bot Manager");
  });

  it('(b) the tie at 3 and the top at 4 (A): tie with the whole below-the-top text', () => {
    const d = decideMain([db(4, 'A')], notice(3, ['A', 'B']), opts);
    expect(d.outcome).toBe('tie');
    expect(reasonOf(d)).toBe("2 machines announced main generation 3 in the switch notices (A and B); a:5432/bot holds generation 4 (A), but no switch notice above generation 3 naming one machine has been read, so the bot stays stopped until one is read. While the Bot Manager records two mains, Keep this machine as the main posts one; once one is posted, the Bot Manager posts it again at its next check of the switch notice if it is no longer among the owner's DMs");
  });

  it('(c) the tie at 5 and the top at 3: behind-notice with the tie form', () => {
    const d = decideMain([db(3, 'A')], notice(5, ['A', 'B', 'C']), opts);
    expect(d.outcome).toBe('behind-notice');
    expect(reasonOf(d)).toBe("can't confirm that a:5432/bot is the main: it holds generation 3 (A), but 3 machines announced generation 5 in the switch notices (A, B and C), and no database in DATA_BACKEND_URL holds it. The bot stays stopped until the owner chooses one in the Bot Manager");
  });

  it('(d) one machine: the three cases of today', () => {
    for (const machines of [undefined, ['B']]) {
      const one = (generation: number): NoticeRead => ({ kind: 'notice', generation, machine: 'B', date: DATE, ...(machines ? { machines } : {}) });
      expect(decideMain([db(3, 'A')], one(2), opts).outcome).toBe('chosen');
      const at = decideMain([db(3, 'A')], one(3), opts);
      expect(at.outcome).toBe('tie');
      expect(reasonOf(at)).toBe(tieText(3, 'a:5432/bot (A)', 'B (B)'));
      const above = decideMain([db(3, 'A')], one(4), opts);
      expect(above.outcome).toBe('behind-notice');
      expect(reasonOf(above)).toBe(behindNoticeText('a:5432/bot', 3, 'A', { generation: 4, machine: 'B', date: DATE }));
    }
    expect(decideMain([db(3, 'A')], notice(3, ['A']), opts).outcome).toBe('chosen');
  });

  it('(e) a notice at 4 naming A alone after the tie at 3, the top at 4 (A): chosen', () => {
    expect(decideMain([db(4, 'A')], notice(4, ['A']), opts).outcome).toBe('chosen');
  });
});

import { describe, expect, it } from 'vitest';

import { noteScopeTicket, pendingFor, saveMark } from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';

type Ticket = Parameters<typeof noteScopeTicket>[1];
type LandingRec = { landed: number; failed?: Array<{ from: number; through: number; errno: string | null; cut: boolean; what: 'lines' | 'whole' }> };

let guilds = 75000;
const freshGuild = () => String(++guilds);

const fileTicket = (record: LandingRec, seq: number, path: string) => ({ kind: 'file', path, seq, record }) as unknown as Ticket;
const failAt = (record: LandingRec, seq: number) => {
  record.failed = [{ from: seq, through: seq, errno: 'EIO', cut: false, what: 'whole' }];
};

describe('sa5: what a scope owes for files after a failed save', () => {
  it('names a path that failed and was written again once, as failed, with its open ticket', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const path = `/data/${g}/m/a.json`;
    const record: LandingRec = { landed: 0 };
    noteScopeTicket(g, fileTicket(record, 1, path));
    failAt(record, 1);
    expect(pendingFor(g, before).files).toEqual([{ path, tickets: [], failed: true }]);
    const again = fileTicket(record, 2, path);
    noteScopeTicket(g, again);
    expect(pendingFor(g, before)).toEqual({ tickets: [again], files: [{ path, tickets: [again], failed: true }], lost: [], refused: [], pruned: false });
  });

  it('marks only the path that failed, not another path that is still open', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const failedPath = `/data/${g}/m/b.json`;
    const openPath = `/data/${g}/m/c.json`;
    const failedRecord: LandingRec = { landed: 0 };
    noteScopeTicket(g, fileTicket(failedRecord, 1, failedPath));
    failAt(failedRecord, 1);
    expect(pendingFor(g, before).files).toEqual([{ path: failedPath, tickets: [], failed: true }]);
    const open = fileTicket({ landed: 0 }, 1, openPath);
    noteScopeTicket(g, open);
    expect(pendingFor(g, before)).toEqual({
      tickets: [open],
      files: [{ path: openPath, tickets: [open], failed: false }, { path: failedPath, tickets: [], failed: true }],
      lost: [],
      refused: [],
      pruned: false,
    });
  });
});

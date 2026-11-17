import { describe, expect, it } from 'vitest';
import { deriveStatus, otherSessionsRefusal } from '../../src/bot/internalSetup/utils/dataMigration';

// L5 regate chunk sa3: the status of a switch whose folder sync failed (NB19 T15) and the order of the migration
// sessions a refusal names (NB21).

describe('the status read of an unconfirmed switch', () => {
  it('answers success with the job interrupted and the unconfirmed text as its error', () => {
    const unconfirmed = 'The marker is written, but its folder sync failed. Run the migration again to confirm the switch.';
    const answer = deriveStatus(
      { ok: true, marker: null, storesExist: false, journal: { jobId: 'job-sa3-unc01', to: 'postgres', stage: 'switching', startedAt: 5, unconfirmed } },
      { running: null, managed: true },
    );
    expect(answer).toEqual({
      status: 200,
      body: { success: true, job: { jobId: 'job-sa3-unc01', state: 'interrupted', to: 'postgres', stage: 'switching', startedAt: 5, error: unconfirmed } },
    });
  });
});

describe('the refusal names the open migration sessions in id order', () => {
  it('two job sessions given out of order are named sorted by id', () => {
    const job = (id: string) => ({ app: `smdb-migrate:${id}`, role: 'bot', own: true, kind: 'client backend' });
    const text = otherSessionsRefusal([job('job-sa3-zzz2'), job('job-sa3-aaa1')], null);
    expect(text).toBe(
      "Migration job-sa3-aaa1, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows. "
      + "Migration job-sa3-zzz2, which is not this bot's last one, holds a session on this database; run this migration once it no longer shows",
    );
  });
});

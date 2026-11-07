import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';

// NB9 test 12: decision 16's identify slot statements on the 'identify' lane of the claims pool (C10).

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const slot = async (bucket: number) => (await rig.direct.query(`SELECT process_id,
  (extract(epoch FROM clock_timestamp() - last_at) * 1000)::float8 AS age_ms FROM smdb_data.identify_slots WHERE bucket = $1`, [bucket])).rows[0];

describe('decision 16, the identify slots', () => {
  it('two sessions racing one bucket: one grant', async () => {
    const answers = await Promise.all([a.reserveIdentifySlot(0, 'p-a'), b.reserveIdentifySlot(0, 'p-b')]);
    expect(answers.filter(x => x.granted)).toHaveLength(1);
    const winner = answers[0].granted ? 'p-a' : 'p-b';
    expect((await slot(0)).process_id).toBe(winner);
  });

  it('the next grant of a bucket comes 5.5 s after the last by clock_timestamp()', async () => {
    expect(await a.reserveIdentifySlot(0, 'p-a')).toEqual({ granted: true });
    const refused = await b.reserveIdentifySlot(0, 'p-b');
    expect(refused.granted).toBe(false);
    await rig.direct.query(`UPDATE smdb_data.identify_slots SET last_at = clock_timestamp() - interval '5400 milliseconds' WHERE bucket = 0`);
    expect((await b.reserveIdentifySlot(0, 'p-b')).granted).toBe(false);
    await rig.direct.query(`UPDATE smdb_data.identify_slots SET last_at = clock_timestamp() - interval '5600 milliseconds' WHERE bucket = 0`);
    expect(await b.reserveIdentifySlot(0, 'p-b')).toEqual({ granted: true });
    expect((await slot(0)).process_id).toBe('p-b');
  });

  it('buckets are independent', async () => {
    expect(await a.reserveIdentifySlot(0, 'p-a')).toEqual({ granted: true });
    expect(await b.reserveIdentifySlot(1, 'p-b')).toEqual({ granted: true });
  });

  it('the wait query answers the time left of the 5.5 s, never below 0', async () => {
    expect(await a.reserveIdentifySlot(3, 'p-a')).toEqual({ granted: true });
    await rig.direct.query(`UPDATE smdb_data.identify_slots SET last_at = clock_timestamp() - interval '2000 milliseconds' WHERE bucket = 3`);
    const answer = await b.reserveIdentifySlot(3, 'p-b');
    expect(answer.granted).toBe(false);
    if (!answer.granted) {
      expect(answer.waitMs).toBeGreaterThan(3000);
      expect(answer.waitMs).toBeLessThanOrEqual(3500);
    }
  });
});

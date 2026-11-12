import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { takeShard } from '../helpers/pgClaims';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';

let rig: ClaimRig;
let store: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  store = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const S = me('s');

describe('the renewal statements on real Postgres', () => {
  it("the serving renewal renews this process's row and answers it as mine", async () => {
    const claim = Number((await takeShard(rig.direct, { processId: A.processId, nodeId: A.nodeId, shardId: 0, shardCount: 1 })).claim);
    await rig.idle(2000);
    const answer = await store.renew({
      me: A, pairs: [{ shardCount: 1, shardId: 0, claim }], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat(),
    });
    expect(answer.rows).toEqual([{ shardCount: 1, shardId: 0, claim, released: false, mine: true }]);
    const row = await rig.row(0, 1);
    expect(BigInt(row.exp)).toBe(BigInt((await rig.clock()).upMs) + BigInt(TIMINGS.ttlMs));
  });

  it("the standby renewal renews its row and writes the pair's readiness", async () => {
    const claim = Number((await takeShard(rig.direct, { processId: S.processId, nodeId: S.nodeId, shardId: 0, shardCount: 1 })).claim);
    expect((await rig.row(0, 1)).ready).toBe(false);
    await rig.idle(2000);
    const answer = await store.renewStandby!({
      me: S, pairs: [{ shardCount: 1, shardId: 0, claim, ready: true }], ttlMs: TIMINGS.ttlMs,
    });
    expect(answer.rows).toEqual([{ shardCount: 1, shardId: 0, claim, released: false, mine: true }]);
    const row = await rig.row(0, 1);
    expect(row.ready).toBe(true);
    expect(BigInt(row.exp)).toBe(BigInt((await rig.clock()).upMs) + BigInt(TIMINGS.ttlMs));
  });
});

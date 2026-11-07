import { describe, expect, it } from 'vitest';

import { ClaimPausedError, ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB9 decision 16 and C10 (code review 1, lane A finding 1): the identify lane is single-flight, one statement and one
// connection at a time, so the one client `pause()` and `retarget()` destroy is the only one on the old pool's wire.
// The pools are fakes that answer as node-pg does: a query waits until the row answers it or its client is destroyed.

const T = claimTimings(30);

interface Sent { pool: string; client: number; text: string; answer: (rows: any[]) => void }

function manualPool(name: string, sent: Sent[], connects: string[]) {
  let ids = 0;
  const pool = {
    async connect() {
      const id = ++ids;
      connects.push(`${name}#${id}`);
      const pending: Array<(e: Error) => void> = [];
      return {
        query(config: any) {
          const text = typeof config === 'string' ? config : config.text;
          return new Promise((resolve, reject) => {
            pending.push(reject);
            sent.push({ pool: name, client: id, text, answer: rows => resolve({ rows, rowCount: rows.length }) });
          });
        },
        release(destroy?: boolean) {
          if (destroy === true) for (const reject of pending.splice(0)) reject(new Error('Connection terminated'));
        },
      };
    },
    async end() { /* nothing to close */ },
    on() { return pool; },
  };
  return pool;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function storeOn(pool: object): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  await (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

describe('NB9 16 and C10: the identify lane is single-flight', () => {
  it('two buckets reserving at once put one statement on the wire at a time', async () => {
    const sent: Sent[] = [];
    const connects: string[] = [];
    const store = await storeOn(manualPool('old', sent, connects));
    const a = store.reserveIdentifySlot(0, 'p-a');
    const b = store.reserveIdentifySlot(1, 'p-a');
    await settle();
    expect(sent).toHaveLength(1);
    expect(connects).toEqual(['old#1']);
    sent[0].answer([{ granted: 1 }]);
    await expect(a).resolves.toEqual({ granted: true });
    await settle();
    expect(sent).toHaveLength(2);
    expect(connects).toEqual(['old#1', 'old#2']);
    sent[1].answer([{ granted: 1 }]);
    await expect(b).resolves.toEqual({ granted: true });
    await store.end();
  });

  it('a pause while two reserves wait destroys the one client, and the second reserve then runs on the new pool', async () => {
    const sent: Sent[] = [];
    const connects: string[] = [];
    const store = await storeOn(manualPool('old', sent, connects));
    (store as any).makePool = () => manualPool('new', sent, connects);
    const a = store.reserveIdentifySlot(0, 'p-a');
    const b = store.reserveIdentifySlot(1, 'p-a');
    const outcomes: string[] = [];
    a.then(() => outcomes.push('a granted'), e => outcomes.push(e instanceof ClaimPausedError ? 'a paused' : `a ${e}`));
    await settle();
    expect(sent.map(s => s.pool)).toEqual(['old']);
    store.pause();
    store.retarget('postgres://nobody@127.0.0.1:1/other');
    store.resume();
    await settle();
    expect(outcomes).toEqual(['a paused']);
    expect(sent.map(s => s.pool)).toEqual(['old', 'new']);
    expect(connects).toEqual(['old#1', 'new#1']);
    sent[1].answer([{ granted: 1 }]);
    await expect(b).resolves.toEqual({ granted: true });
    await store.end();
  });

  it('a reserve whose signal aborts while it waits behind another bucket sends nothing and rejects', async () => {
    const sent: Sent[] = [];
    const connects: string[] = [];
    const store = await storeOn(manualPool('old', sent, connects));
    const stop = new AbortController();
    const a = store.reserveIdentifySlot(0, 'p-a');
    const b = store.reserveIdentifySlot(1, 'p-a', stop.signal);
    const outcomes: string[] = [];
    b.then(() => outcomes.push('b granted'), e => outcomes.push(`b ${e?.name}`));
    await settle();
    expect(sent).toHaveLength(1);
    stop.abort();
    sent[0].answer([{ granted: 1 }]);
    await expect(a).resolves.toEqual({ granted: true });
    await settle();
    expect(sent).toHaveLength(1);
    expect(connects).toEqual(['old#1']);
    expect(outcomes).toEqual(['b AbortError']);
    await store.end();
  });
});

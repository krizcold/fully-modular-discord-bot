import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, rowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';
import { pause, sharedListener } from '../helpers/nb6Pg';
import { sha } from '../helpers/sharedRows';

// NB6 test 21 [pg] (wip-redesign/sheets/NB6.md rows 7 to 9, 21 and 380; round 1's change): the row flush on real
// Postgres. A committed transaction holds its shared_ops row and notifies at COMMIT; a rolled-back one holds no
// shared_ops row and notifies nobody; two writers of one key are ordered by the advisory lock.

const CATEGORY = 'nb6cas';
const keyOf = (name: string) => `global/${CATEGORY}/${name}`;
const opts: dm.DataOptions = { scope: 'global', category: CATEGORY };
const text = (value: unknown) => JSON.stringify(value, null, 2);

let rig: ClaimRig;
let listener: Awaited<ReturnType<typeof sharedListener>>;

beforeAll(async () => {
  rig = await startClaimRig();
  listener = await sharedListener(rig.url);
}, 180_000);

afterAll(async () => {
  await listener?.end();
  await rig?.stop();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  _resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(rig.backend);
  fs.rmSync(dataPath('global', CATEGORY), { recursive: true, force: true });
  await rig.direct.query('DELETE FROM smdb_data.shared_docs');
  await rig.direct.query('DELETE FROM smdb_data.shared_ops');
  listener.heard.length = 0;
});

afterEach(() => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  vi.restoreAllMocks();
});

const save = (name: string, value: unknown) => (dm.saveDataTracked(name, opts, value) as { ticket: unknown }).ticket as RowTicket;
const row = async (key: string) => (await rig.direct.query('SELECT body, sha, rev::text AS rev, updated_by FROM smdb_data.shared_docs WHERE key = $1', [key])).rows[0];
const opsCount = async () => Number((await rig.direct.query('SELECT count(*)::int AS n FROM smdb_data.shared_ops')).rows[0].n);

/** A row another machine stored, as the flush stores one. */
async function otherWrites(key: string, body: string): Promise<void> {
  await rig.direct.query(
    `INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, nextval('smdb_data.shared_rev_seq'), 'BRAVO/p-bravo')
     ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, sha = EXCLUDED.sha, rev = EXCLUDED.rev, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, Buffer.from(body), sha(body)],
  );
}

describe('rows 7 and 8', () => {
  it('row 7: stored byte for byte with its sha, its op row and one notification after COMMIT; row 8: a repeat writes nothing', async () => {
    const ticket = save('r7.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    const stored = await row(keyOf('r7.json'));
    expect(Buffer.compare(stored.body, Buffer.from(text({ v: 1 })))).toBe(0);
    expect(stored.sha).toBe(sha(text({ v: 1 })));
    expect(await opsCount()).toBe(1);
    await pause(200);
    expect(listener.heard.map(p => JSON.parse(p))).toEqual([expect.objectContaining({ k: 'doc', key: keyOf('r7.json'), sha: stored.sha, rev: Number(stored.rev) })]);
    expect(fs.readFileSync(dataPath('global', CATEGORY, 'r7.json'), 'utf8')).toBe(text({ v: 1 }));

    listener.heard.length = 0;
    const again = save('r7.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(again)).toBe('landed');
    expect((await row(keyOf('r7.json'))).rev).toBe(stored.rev);
    expect(await opsCount()).toBe(1);
    await pause(200);
    expect(listener.heard).toEqual([]);
  });
});

describe('row 9', () => {
  it('a plain op over another machine\'s change is rolled back: no op row, no notification, refused changed-elsewhere', async () => {
    const first = save('r9.json', { v: 1 });
    await dm.flushAll();
    expect(rowTicketState(first)).toBe('landed');
    await otherWrites(keyOf('r9.json'), text({ v: 'bravo' }));
    listener.heard.length = 0;
    const ticket = save('r9.json', { v: 2 });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('refused');
    expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    expect((await row(keyOf('r9.json'))).body.toString('utf8')).toBe(text({ v: 'bravo' }));
    expect(await opsCount()).toBe(1);
    await pause(200);
    expect(listener.heard).toEqual([]);
  });
});

describe('row 21: two writers of one key', () => {
  it('the second waits on the advisory lock, meets the first\'s sha and is refused', async () => {
    const base = save('r21.json', { v: 0 });
    await dm.flushAll();
    expect(rowTicketState(base)).toBe('landed');
    const other = await rig.direct.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))", [keyOf('r21.json')]);
      await other.query(
        `UPDATE smdb_data.shared_docs SET body = $2, sha = $3, rev = nextval('smdb_data.shared_rev_seq'), updated_by = 'BRAVO/p-bravo' WHERE key = $1`,
        [keyOf('r21.json'), Buffer.from(text({ v: 'first' })), sha(text({ v: 'first' }))],
      );
      const ticket = save('r21.json', { v: 'second' });
      const flushing = dm.flushAll();
      await pause(500);
      expect(rowTicketState(ticket)).toBe('open');
      await other.query('COMMIT');
      await flushing;
      expect(rowTicketState(ticket)).toBe('refused');
      expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    } finally {
      other.release();
    }
    expect((await row(keyOf('r21.json'))).body.toString('utf8')).toBe(text({ v: 'first' }));
  });
});

describe('row 380: an op that checks another key', () => {
  const PREMIUM = 'global/premium-tiers.json';
  const checked = (name: string, check: Record<string, string | null>) =>
    rowQueue.accept(keyOf(name), dataPath('global', CATEGORY, name), { body: Buffer.from(text({ v: 1 })) }, { sha: 'absent', caller: true, check });

  it('a check of null with no row lands; a sha while the row is absent is refused', async () => {
    const lands = checked('a380.json', { [PREMIUM]: null });
    const refused = checked('b380.json', { [PREMIUM]: sha('{}') });
    await dm.flushAll();
    expect(rowTicketState(lands)).toBe('landed');
    expect(rowTicketState(refused)).toBe('refused');
    expect(await row(keyOf('b380.json'))).toBeUndefined();
  });

  it('a sha the row holds lands', async () => {
    await otherWrites(PREMIUM, '{"tiers":[]}');
    const ticket = checked('c380.json', { [PREMIUM]: sha('{"tiers":[]}') });
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
  });
});

// Part 12: the Dummy tick's op with premium's check (decision 102) and the walk batch's save on the checked sha (110).
describe('rows 378 and 393: the Dummy tick and premium on two clients', () => {
  const PREMIUM = 'global/premium-tiers.json';
  const DUMMY = 'global/payment-providers/dummy/state.json';
  const dummyOp = (value: unknown, check: string | null) =>
    rowQueue.accept(DUMMY, dataPath('global', 'payment-providers', 'dummy', 'state.json'), { body: Buffer.from(text(value)) }, { sha: 'absent', caller: true, check: { [PREMIUM]: check } });

  beforeEach(() => {
    fs.rmSync(dataPath('global', 'payment-providers'), { recursive: true, force: true });
    fs.rmSync(dataPath('global', 'premium-tiers.json'), { force: true });
  });

  it("378: the Dummy op waits on premium's advisory lock while another client's premium save holds it, sees that save's committed sha and rolls back", async () => {
    await otherWrites(PREMIUM, text({ v: 'P' }));
    const other = await rig.direct.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT pg_advisory_xact_lock(hashtext('smdb_shared'), hashtext($1))", [PREMIUM]);
      await other.query(
        `UPDATE smdb_data.shared_docs SET body = $2, sha = $3, rev = nextval('smdb_data.shared_rev_seq'), updated_by = 'ALFA/p-alfa' WHERE key = $1`,
        [PREMIUM, Buffer.from(text({ v: 'P2' })), sha(text({ v: 'P2' }))],
      );
      const ticket = dummyOp({ renewed: true }, sha(text({ v: 'P' })));
      const flushing = dm.flushAll();
      await pause(500);
      expect(rowTicketState(ticket)).toBe('open');
      await other.query('COMMIT');
      await flushing;
      expect(rowTicketState(ticket)).toBe('refused');
      expect(ticket.op.refusal?.cause).toBe('changed-elsewhere');
    } finally {
      other.release();
    }
    expect(await row(DUMMY)).toBeUndefined();
    expect((await row(PREMIUM)).body.toString('utf8')).toBe(text({ v: 'P2' }));
  });

  it('379: the check equal to the stored sha: the Dummy op lands', async () => {
    await otherWrites(PREMIUM, text({ v: 'P' }));
    const ticket = dummyOp({ renewed: true }, sha(text({ v: 'P' })));
    await dm.flushAll();
    expect(rowTicketState(ticket)).toBe('landed');
    expect((await row(DUMMY)).body.toString('utf8')).toBe(text({ renewed: true }));
  });

  it("393: the Dummy op with check P commits; another client commits P2; the batch's premium save on base P is refused and the row keeps P2", async () => {
    await otherWrites(PREMIUM, text({ v: 'P' }));
    const tick = dummyOp({ renewed: true }, sha(text({ v: 'P' })));
    await dm.flushAll();
    expect(rowTicketState(tick)).toBe('landed');
    await otherWrites(PREMIUM, text({ v: 'P2' }));
    const handler = rowQueue.accept(PREMIUM, dataPath('global', 'premium-tiers.json'), { body: Buffer.from(text({ v: 'P', renewed: true })) }, { sha: sha(text({ v: 'P' })), caller: true });
    await dm.flushAll();
    expect(rowTicketState(handler)).toBe('refused');
    expect(handler.op.refusal?.cause).toBe('changed-elsewhere');
    expect((await row(PREMIUM)).body.toString('utf8')).toBe(text({ v: 'P2' }));
  });
});

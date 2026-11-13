import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { providerCredentialsPath } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp, partialText, setOpSettler, type SharedOpReply } from '../../src/bot/internalSetup/utils/sharedOps';
import { settlePremiumInstalls } from '../../src/bot/internalSetup/utils/premiumManager';
import { _resetRowQueue, rowQueue, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import type { WriteLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { lost, sharedRows } from '../helpers/sharedRows';

// sharedOps.ts: the provider credentials op (NB6 decision 57 with 28's answers) on a Postgres bot, over the real row
// queue and PostgresBackend with scripted clients, and the names a partial answer gives as saved (NB13 D4).

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const DOC_KEY = 'global/payment-providers/credentials.json';
const NAME = 'payment-providers/credentials.json';
const DAY = 24 * 60 * 60 * 1000;

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global', 'payment-providers'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setOpSettler(null);
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  _resetSharedMirror();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  setOpSettler(settlePremiumInstalls);
  setBackendKind(null);
  await rig.backend.stop();
  fs.rmSync(dataPath('global', 'payment-providers'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const save = (args: unknown) => applySharedOp({ op: 'provider.saveCredentials', args });
const stored = () => {
  const row = rows.docs.get(DOC_KEY);
  return row ? JSON.parse(row.body.toString('utf8')) : undefined;
};

function holdsFile(text: string): void {
  fs.mkdirSync(path.dirname(providerCredentialsPath()), { recursive: true });
  fs.writeFileSync(providerCredentialsPath(), text);
}

/** A doc another machine stored, and this machine's mirror of it. */
function holdsDoc(value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  rows.put(DOC_KEY, text);
  holdsFile(text);
}

describe('arguments the op refuses', () => {
  it.each([
    ['no arguments', undefined],
    ['no providerId', { changes: { A: '1' } }],
    ['changes as text', { providerId: 'stripe', changes: 'A=1' }],
    ['changes as a list', { providerId: 'stripe', changes: ['A'] }],
  ])('%s: invalid, with no status, and nothing is queued', async (_name, args) => {
    const reply = await save(args);
    expect(reply).toStrictEqual({ ok: false, code: 'invalid', error: 'providerId and changes are required' });
    expect(rowQueue.ops(DOC_KEY)).toEqual([]);
    expect(rows.docs.has(DOC_KEY)).toBe(false);
  });
});

describe('a credentials file this machine cannot use', () => {
  it('not valid JSON: failed with status 500, and the sentence ends with one period', async () => {
    holdsFile('{"stripe":');
    const reply = await save({ providerId: 'stripe', changes: { A: '1' } });
    expect(reply).toStrictEqual({ ok: false, code: 'failed', status: 500, error: `${NAME} cannot be read, so the keys of stripe were not saved: it is not valid JSON.` });
    expect(rows.docs.has(DOC_KEY)).toBe(false);
  });

  it('a read error whose text ends with a period keeps that one period', async () => {
    holdsFile('{}');
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && path.resolve(file) === path.resolve(providerCredentialsPath())) throw new Error('EIO: the disk did not answer.');
      return (real as any)(file, ...rest);
    }) as typeof fs.readFileSync);
    const reply = await save({ providerId: 'stripe', changes: { A: '1' } });
    expect(reply).toStrictEqual({ ok: false, code: 'failed', status: 500, error: `${NAME} cannot be read, so the keys of stripe were not saved: EIO: the disk did not answer.` });
    expect(rows.docs.has(DOC_KEY)).toBe(false);
  });

  it.each([['a number', '5'], ['null', 'null'], ['a list', '[]'], ['text', '"x"']])('a file that holds %s: failed with status 500, nothing stored', async (_name, text) => {
    holdsFile(text);
    const reply = await save({ providerId: 'stripe', changes: { A: '1' } });
    expect(reply).toStrictEqual({ ok: false, code: 'failed', status: 500, error: `${NAME} holds no object, so the keys of stripe were not saved.` });
    expect(rowQueue.ops(DOC_KEY)).toEqual([]);
    expect(rows.docs.has(DOC_KEY)).toBe(false);
  });
});

describe("the provider's entry", () => {
  it("a save keeps the provider's keys it does not change and the other providers' entries", async () => {
    expect(await save({ providerId: 'stripe', changes: { A: '1' } })).toEqual({ ok: true });
    expect(await save({ providerId: 'patreon', changes: { P: 'p' } })).toEqual({ ok: true });
    expect(await save({ providerId: 'stripe', changes: { B: '2' } })).toEqual({ ok: true });
    expect(stored()).toEqual({ stripe: { A: '1', B: '2' }, patreon: { P: 'p' } });
  });

  it.each([['text', 'old-secret'], ['a list', ['K', 'L']], ['a number', 7]])("an entry that holds %s is replaced by the changes alone", async (_name, held) => {
    holdsDoc({ stripe: held, other: { X: 'y' } });
    expect(await save({ providerId: 'stripe', changes: { B: '2' } })).toEqual({ ok: true });
    expect(stored()).toEqual({ stripe: { B: '2' }, other: { X: 'y' } });
  });
});

describe('a save whose answer was lost and could not be checked', () => {
  it('answers unconfirmed with status 202 and names the credentials of the provider', async () => {
    let commits = 0;
    rows.fault = sql => (sql === 'COMMIT' && ++commits === 1 ? lost() : undefined);
    let reply: SharedOpReply | undefined;
    const pending = save({ providerId: 'stripe', changes: { A: '1' } }).then(r => { reply = r; });
    await vi.waitFor(() => expect(rowQueue.ops(DOC_KEY)[0]?.unknown.length).toBe(1), { timeout: 5000, interval: 5 });
    rig.backend.confirmHold((rig.backend as unknown as { epoch: number }).epoch);
    rows.clock.now = new Date(rows.clock.now.getTime() + 6 * DAY);
    for (let i = 0; i < 10 && reply === undefined; i++) await dm.flushAll();
    await pending;
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', status: 202 });
    expect((reply as { error: string }).error).toMatch(/^Can't confirm that the credentials of stripe change was saved: the database has not answered yet \(.+\)\. Reload the App Store tab in a minute to see whether it was\.$/);
    expect(rows.docs.has(DOC_KEY)).toBe(false);
  });
});

describe('the files a partial answer names as saved', () => {
  const row = (key: string, state: string): RowTicket => ({ kind: 'row', key, op: { state } as RowTicket['op'], seq: 1 });
  const ledgerOf = (tickets: RowTicket[]) => ({ tickets: () => tickets.map(ticket => ({ ticket })) }) as unknown as WriteLedger;

  it('names a landed row of one key while a row of another key is still open', () => {
    const text = partialText("Can't confirm the change.", ledgerOf([row('global/premium-tiers.json', 'landed'), row('global/payment-providers/dummy/state.json', 'queued')]));
    expect(text).toBe("Can't confirm the change. What was saved: premium-tiers.json. Reload to see it before you try again: trying again could apply the saved part twice.");
  });
});

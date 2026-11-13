import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  del: null as null | ((...a: any[]) => any),
  confirm: null as null | ((...a: any[]) => any),
  elsewhere: false,
  lease: null as null | boolean,
  deposed: false,
  tracked: null as null | (() => unknown),
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    deleteDataTracked: (...a: any[]) => (h.del ? h.del(...a) : real.deleteDataTracked(...a)),
    confirmWrite: (...a: any[]) => (h.confirm ? h.confirm(...a) : real.confirmWrite(...a)),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => {
  const real = await orig<any>();
  return { ...real, servedElsewhere: (g: string) => h.elsewhere || real.servedElsewhere(g) };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => {
  const real = await orig<any>();
  return { ...real, getDataReadiness: () => (h.lease === null ? real.getDataReadiness() : { leaseSet: () => h.lease, servesGuild: () => true }) };
});
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<any>();
  return { ...real, checkWriterLock: () => (h.deposed ? { kind: 'deposed', holder: { pid: 4242, role: 'bot', start: null } } : real.checkWriterLock()) };
});
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => {
  const real = await orig<any>();
  return { ...real, runTracked: (fn: () => unknown) => (h.tracked ? h.tracked() : real.runTracked(fn)) };
});

import { answerGuildWrite, applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { carriedWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { setBackendKind } from '../helpers/backendKind';

const G = '223456789012345678';
const del = { guildId: G, module: 'mod', filename: 'x.json', op: 'delete' as const };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  h.del = h.confirm = h.tracked = null;
  h.elsewhere = h.deposed = false;
  h.lease = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('the writes an operator delete carries on its reply', () => {
  it('a confirmed row ticket is not carried', async () => {
    const ticket = { kind: 'row', key: 'k', op: { state: 'landed' } };
    h.del = () => ({ outcome: 'deleted', ticket });
    h.confirm = () => 'ok';
    const reply = await applyOperatorDataWrite(del);
    expect(reply).toEqual({ ok: true });
    expect(carriedWrites(reply)!.tickets).toEqual([]);
  });

  it('a confirmed file ticket is carried', async () => {
    const ticket = { kind: 'file', path: '/x/mod/x.json', record: {} };
    h.del = () => ({ outcome: 'deleted', ticket });
    h.confirm = () => 'ok';
    const reply = await applyOperatorDataWrite(del);
    expect(reply).toEqual({ ok: true });
    expect(carriedWrites(reply)!.tickets).toEqual([ticket]);
  });
});

describe('a guild another machine serves', () => {
  it('a Postgres process with its lease set answers not-held', async () => {
    setBackendKind('postgres');
    h.lease = true;
    h.elsewhere = true;
    h.deposed = true;
    expect(await applyOperatorDataWrite(del)).toEqual({ ok: false, code: 'not-held' });
  });

  it('a Postgres process with no lease set yet does not answer not-held', async () => {
    setBackendKind('postgres');
    h.lease = false;
    h.elsewhere = true;
    h.deposed = true;
    expect(await applyOperatorDataWrite(del)).toMatchObject({ ok: false, code: 'held-elsewhere' });
  });

  it('a JSON process does not answer not-held, lease set or not', async () => {
    setBackendKind('file');
    h.elsewhere = true;
    h.deposed = true;
    h.lease = true;
    expect(await applyOperatorDataWrite(del)).toMatchObject({ ok: false, code: 'held-elsewhere' });
    h.lease = false;
    expect(await applyOperatorDataWrite(del)).toMatchObject({ ok: false, code: 'held-elsewhere' });
  });
});

describe('a guild write that threw', () => {
  it('answers io-error with the error', async () => {
    h.tracked = () => {
      throw new Error('tracker broke');
    };
    expect(await answerGuildWrite(del)).toEqual({ ok: false, code: 'io-error', error: 'tracker broke' });
  });

  it('answers io-error with Unknown error for a non-error', async () => {
    h.tracked = () => {
      throw 'not an error';
    };
    expect(await answerGuildWrite(del)).toEqual({ ok: false, code: 'io-error', error: 'Unknown error' });
  });
});

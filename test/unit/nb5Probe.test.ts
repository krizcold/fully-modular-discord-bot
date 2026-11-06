import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAddressList } from '../../src/utils/databaseAddress';
import { decideMain, probePass, type ProbeSession } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// NB5 decision 4 over a fake session (the [pg] nb5Probe rows run the real one): what each address ends as.

type Script = Partial<Record<'connect' | 'identity' | 'generation' | 'meta', unknown>>;
const pgError = (code: string, message = code) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const IDENTITY = { rows: [{ rec: false, ro: 'off', started: '2026-11-01 10:00:00+00', sysid: '7311' }] };

function fakeSession(script: Script, seen: any[]): (config: any) => ProbeSession {
  return config => {
    seen.push(config);
    const answer = async (v: unknown) => {
      if (v instanceof Error) throw v;
      if (v === 'hang') return new Promise<never>(() => undefined);
      return v;
    };
    return {
      connect: () => answer(script.connect ?? undefined),
      query: async (text: string) => {
        if (text.includes('pg_is_in_recovery')) {
          if (text.includes('pg_control_system') && script.identity instanceof Error) throw script.identity;
          return (await answer(script.identity instanceof Error ? IDENTITY_NOSYS : script.identity ?? IDENTITY)) as any;
        }
        if (text.includes('smdb_manager.generation')) return (await answer(script.generation ?? { rows: [] })) as any;
        return (await answer(script.meta ?? { rows: [] })) as any;
      },
      end: async () => undefined,
    };
  };
}
const IDENTITY_NOSYS = { rows: [{ rec: false, ro: 'off', started: '2026-11-01 10:00:00+00', sysid: null }] };
const ENTRY = 'postgresql://bot:pw@db1:5432/bot';

async function probe(script: Script) {
  const seen: any[] = [];
  const [answer] = await probePass(parseAddressList(ENTRY), { session: fakeSession(script, seen) });
  return { answer, seen };
}

afterEach(() => vi.useRealTimers());

describe('the probe', () => {
  it('answers generation 0 with no generation table and no store with no meta table', async () => {
    const { answer, seen } = await probe({ generation: pgError('3F000'), meta: pgError('42P01') });
    expect(answer).toMatchObject({ kind: 'answered', generation: 0, storeId: null, sysid: '7311', inRecovery: false, readOnly: false });
    expect(seen[0]).toMatchObject({ application_name: 'smdb-probe', connectionTimeoutMillis: 5000, query_timeout: 5000, host: 'db1' });
  });

  it('reads one generation row, the store id and the owner channel', async () => {
    const { answer } = await probe({
      generation: { rows: [{ machine: 'node-a', generation: '2', since: new Date('2026-11-01T00:00:00Z') }] },
      meta: { rows: [{ key: 'store_id', value: '"s1"' }, { key: 'owner_channel', value: '"123456789012345678"' }] },
    });
    expect(answer).toMatchObject({ kind: 'answered', generation: 2, machine: 'node-a', since: '2026-11-01T00:00:00.000Z', storeId: 's1', ownerChannel: { kind: 'id', id: '123456789012345678' } });
  });

  it.each([
    ['two rows', { rows: [{ generation: 1 }, { generation: 2 }] }],
    ['generation 0', { rows: [{ machine: 'a', generation: 0, since: null }] }],
    ['a denied read', pgError('42501')],
  ])('fails on an unreadable generation: %s, never 0', async (_n, generation) => {
    const { answer } = await probe({ generation });
    expect(answer.kind).toBe('failed');
    expect((answer as { cause: string }).cause).toMatch(/^an unreadable generation/);
  });

  it('answers sysid null when pg_control_system is denied', async () => {
    const { answer } = await probe({ identity: pgError('42501') });
    expect(answer).toMatchObject({ kind: 'answered', sysid: null });
  });

  it('answers refused on 28000 and failed on 28P01', async () => {
    expect((await probe({ connect: pgError('28000') })).answer.kind).toBe('refused');
    expect((await probe({ connect: pgError('28P01') })).answer).toMatchObject({ kind: 'failed', cause: 'a wrong password (28P01)' });
  });

  it('keeps the store id when the owner channel value is unreadable', async () => {
    const { answer } = await probe({ meta: { rows: [{ key: 'store_id', value: '"s1"' }, { key: 'owner_channel', value: '"abc"' }] } });
    expect(answer).toMatchObject({ kind: 'answered', storeId: 's1', ownerChannel: { kind: 'unreadable' } });
  });

  it('settles an address that hangs at the 10 s pass bound', async () => {
    vi.useFakeTimers();
    const seen: any[] = [];
    const pass = probePass(parseAddressList(ENTRY), { session: fakeSession({ connect: 'hang' }, seen) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pass)[0]).toMatchObject({ kind: 'failed', cause: 'a timeout' });
  });

  it('R5-B1: M connects, its statement never answers, B refused: the bound keeps the login, unreachable', async () => {
    vi.useFakeTimers();
    const seen: any[] = [];
    const m = fakeSession({ identity: 'hang' }, seen);
    const b = fakeSession({ connect: pgError('28000') }, seen);
    const list = 'postgresql://bot:pw@m:5432/bot,postgresql://bot:pw@b:5432/bot';
    const pass = probePass(parseAddressList(list), { session: config => (config.host === 'm' ? m(config) : b(config)) });
    await vi.advanceTimersByTimeAsync(10_000);
    const answers = await pass;
    expect(answers[0]).toMatchObject({ kind: 'failed', cause: 'a timeout', loggedIn: true });
    expect(decideMain(answers, undefined, { markerStoreId: 's1', noticeCheckOff: false })).toMatchObject({
      outcome: 'unreachable',
      reason: 'No database in DATA_BACKEND_URL can be used (b:5432/bot: refused the login (SQLSTATE 28000), m:5432/bot: a timeout)',
    });
  });

  it('fails an unusable entry without opening a session', async () => {
    const seen: any[] = [];
    const answers = await probePass(parseAddressList(`${ENTRY},`), { session: fakeSession({}, seen) });
    expect(answers[1]).toMatchObject({ kind: 'failed', cause: 'entry 2 is empty' });
    expect(seen).toHaveLength(1);
  });
});

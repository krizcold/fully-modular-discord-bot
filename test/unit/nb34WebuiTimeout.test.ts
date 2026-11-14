import { afterEach, describe, expect, it, vi } from 'vitest';

// NB34: the web UI's shared transaction reports a statement timeout (57014) with the failed statement's size, bound
// and elapsed time, not with the ROLLBACK sent after it.

const textBytes = (text: string, values: unknown[]) =>
  Buffer.byteLength(text) + values.reduce<number>((n, v) => n + (Buffer.isBuffer(v) ? v.length : v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(elapsed: (bound: number) => number) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let now = 5_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fs = await import('fs');
  const { dataPath } = await import('../../src/utils/dataRoot');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  const store = await import('../../src/bot/internalSetup/utils/sharedStore');
  const { setBackendKind } = await import('../helpers/backendKind');
  const { webuiSessions } = await import('../helpers/nb6WebuiSession');
  const file = dataPath('global', 'nb34timeout', 'w.json');
  fs.rmSync(dataPath('global', 'nb34timeout'), { recursive: true, force: true });
  store._resetRowQueue();
  setBackendKind('postgres');
  dm.setGuildDataBackend(null);
  const s = webuiSessions();
  store.useWebuiSessions({
    target: async () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: '1:M', countAtStart: 0 }),
    commitCheck: () => null,
    select: async () => ({ rows: [] }),
    tag: () => '1:M',
    session: config => s.session(config as Record<string, unknown>),
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let bound = 0;
    const hit: { q: (typeof s.sent)[number] | null } = { q: null };
    // The statement that carries the 3 KB body fails, so its size (over 1 KiB) differs from the ROLLBACK's.
    s.state.before = sql => {
      const set = /statement_timeout = (\d+)$/.exec(sql);
      if (set) bound = Number(set[1]);
      const q = s.sent[s.sent.length - 1];
      if (hit.q || textBytes(q.sql, q.params ?? []) < 2048) return undefined;
      hit.q = q;
      now += elapsed(bound);
      return Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });
    };
    expect(dm.writeRawAtomicTracked(file, JSON.stringify({ w: 'x'.repeat(3000) }))).toEqual({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(warn.mock.calls.some(c => String(c[0]).includes('SQLSTATE 57014'))).toBe(true));
    const failed = hit.q;
    if (!failed) throw new Error('no statement carried the body');
    const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('SQLSTATE 57014'));
    return { lines, bound, kib: Math.ceil(textBytes(failed.sql, failed.params ?? []) / 1024), sent: s.sent.map(q => q.sql) };
  } finally {
    vi.useRealTimers();
    store.useWebuiSessions(null);
    store._resetRowQueue();
    setBackendKind(null);
  }
}

describe("NB34: the web UI's timeout record describes the statement that failed", () => {
  it('at its bound: the statement of its real size did not finish within its bound', async () => {
    const r = await run(bound => bound);
    expect(r.bound).toBeGreaterThan(0);
    expect(r.kib).toBeGreaterThan(1);
    expect(r.sent).toContain('ROLLBACK');
    expect(r.lines[0]).toBe(
      `[Shared] Saving global/nb34timeout/w.json: a statement of ${r.kib} KiB did not finish within the ${Math.round(r.bound / 1000)} s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this (this machine tries again)`,
    );
  });

  it('before its bound: cancelled after the real elapsed time, before its bound', async () => {
    const r = await run(() => 2_500);
    expect(r.sent).toContain('ROLLBACK');
    expect(r.lines[0]).toBe(
      `[Shared] Saving global/nb34timeout/w.json: a statement of ${r.kib} KiB was cancelled after 2.5 s, before the ${Math.round(r.bound / 1000)} s bound (SQLSTATE 57014); a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way (this machine tries again)`,
    );
  });
});

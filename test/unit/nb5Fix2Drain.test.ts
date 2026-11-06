import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeStore, tokenFor } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// NB5 code review round 1, C3: while latched only the database writes are refused (section 5's R3 operator stop), so
// the exit drain and the maintenance save still write the files they hold. The file side is the file backend's queue,
// counted here; the exit drain runs once per process, so every row loads the modules afresh.

const h = vi.hoisted(() => ({ files: 0, flushes: 0, landed: 0 }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<object>()),
  queuedFileWrites: () => h.files,
  unsavedFileWrites: () => h.files,
  fileFlushesLanded: () => h.landed,
  flushAll: async () => {
    h.flushes += 1;
    if (h.files > 0) { h.files = 0; h.landed += 1; }
  },
}));

const WHY = 'a:5432/bot was replaced by node-b (generation 2)';

class LatchedStore extends FakeStore {
  latchReason(): string | null { return WHY; }
  databaseEpoch(): number { return 2; }
  holdWords(): string | null { return null; }
  chosenEntry(): string { return 'postgres://bot@a:5432/bot'; }
  override async flushGuild(): Promise<any> { return { ok: false, reason: 'unavailable', detail: `${WHY}; this process does not write to it` }; }
}

async function latchedWorld() {
  vi.resetModules();
  const ws = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
  const dm = await import('../../src/bot/internalSetup/utils/dataManager');
  setBackendKind('postgres');
  const store = new LatchedStore();
  const set = ws.initWorkingSet(store);
  dm.setGuildDataBackend(store as never);
  const g = '880000000000000001';
  expect(await set.hydrate(g, tokenFor())).toBe('ready');
  expect(set.save(g, 'm', 'a.json', '"held"')).toBe('accepted');
  set.markForResave('a:5432/bot');
  return { ws, dm, set, g };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  Object.assign(h, { files: 1, flushes: 0, landed: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  h.files = 0;
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('C3: a latched drain still writes the queued files', () => {
  it('the exit drain flushes a queued global file write and logs no file left; the guild is still logged', async () => {
    const w = await latchedWorld();
    await w.dm.drainForExit(2_000);
    expect(h.flushes).toBeGreaterThan(0);
    expect(h.files).toBe(0);
    const lines: string[] = warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '));
    expect(lines.some(l => l.includes('file(s) with queued writes'))).toBe(false);
    expect(lines).toContain(`[Data] Shutdown drain left 1 guild(s) with unflushed writes: ${w.g}`);
    expect(lines).toContain(`[Data] Shutdown drain left 1 guild(s) not re-saved on the main, once one is found: ${w.g}`);
    w.dm.setGuildDataBackend(null);
  });

  it("saveHeldWrites flushes the queued file write and answers no unsaved file, the guild's counts kept", async () => {
    const w = await latchedWorld();
    const counts = await w.dm.saveHeldWrites(2_000);
    expect(h.flushes).toBeGreaterThan(0);
    expect(counts).toMatchObject({ unsavedGuilds: 1, unsavedFiles: 0, resaveGuilds: 1 });
    w.dm.setGuildDataBackend(null);
  });
});

import fs from 'fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

// NB10 code review round 9, the fixer's regression test for NB10-R10-O1: the drain pass after the after-drain steps
// waits only on the file writes, within 5 s, so a working set that never settles cannot push the stop past
// BotManager's 40 s. The stop runs once per process, so this file holds only this case.

const ws = vi.hoisted(() => ({ phase2: false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>();
  const stub = {
    writesSettled: () => !ws.phase2,
    flushOnTheWire: () => ws.phase2,
    flushAllDirty: () => (ws.phase2 ? new Promise<string[]>(() => undefined) : Promise.resolve([] as string[])),
    landedFlushes: () => 0,
    dirtyGuildIds: () => [] as string[],
    resaveGuilds: () => [] as string[],
    unansweredGuilds: () => ({ all: [] as string[], only: [] as string[] }),
    takeDropLines: () => [] as string[],
  };
  return { ...real, getWorkingSet: () => stub };
});

import { dataPath } from '../../src/utils/dataRoot';
import { addAfterDrainStep, beginStop, installStopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { enqueueAppend } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';

const signals = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
afterAll(() => {
  for (const l of process.listeners('SIGTERM')) if (!signals.term.includes(l)) process.off('SIGTERM', l);
  for (const l of process.listeners('SIGINT')) if (!signals.int.includes(l)) process.off('SIGINT', l);
  vi.restoreAllMocks();
});

describe('the drain pass after the after-drain steps (NB10-R10-O1)', () => {
  it('ends once its file line lands, while the working set never settles', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = dataPath('global', 'nb10fix10');
    const file = `${dir}/after-drain.jsonl`;
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(file, { force: true });
    let exitedAt: number | null = null;
    let atExit: string | null = null;
    vi.spyOn(process, 'exit').mockImplementation((() => {
      exitedAt = Date.now();
      atExit = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      return undefined as never;
    }) as typeof process.exit);
    addAfterDrainStep(() => {
      ws.phase2 = true;
      enqueueAppend(file, '{"line":1}\n');
      return true;
    });
    installStopHandler();
    const started = Date.now();
    await beginStop();
    await vi.waitFor(() => expect(exitedAt).not.toBeNull(), { timeout: 8000, interval: 20 });
    expect(exitedAt! - started).toBeLessThan(5000);
    expect(atExit).toBe('{"line":1}\n');
  }, 15_000);
});

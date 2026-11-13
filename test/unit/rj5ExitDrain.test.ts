import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rj5: the exit drain's last lines. The folder chain is stubbed as in ra81FileReplacedOrder.test.ts,
// so a whole write replaced during its failed chain is made the same way on Windows as on Linux.

const h = vi.hoisted(() => ({
  chainFail: new Map<string, string[]>(),
  chainHold: new Map<string, { reached: () => void; released: Promise<void> }>(),
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChain: async (dir: string) => {
      const at = path.resolve(dir);
      const hold = h.chainHold.get(at);
      if (hold) {
        h.chainHold.delete(at);
        hold.reached();
        await hold.released;
      }
      const errno = h.chainFail.get(at)?.shift();
      if (errno) return { failed: true, kind: 'sync', dir: at, errno, error: Object.assign(new Error(`${errno}: stubbed`), { code: errno }) };
      return { failed: false };
    },
    syncFolder: async () => ({ failed: false }),
  };
});

import { enqueueWrite, fileTicket, fileTicketState, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { drainForExit } from '../../src/bot/internalSetup/utils/dataManager';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { dataPath } from '../../src/utils/dataRoot';
import { FakeStore } from '../helpers/fakeStore';

const releases: Array<() => void> = [];

function failChain(d: string, errno = 'EIO') {
  const at = path.resolve(d);
  h.chainFail.set(at, [...(h.chainFail.get(at) ?? []), errno]);
}

function holdChain(d: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  h.chainHold.set(path.resolve(d), { reached, released });
  releases.push(release);
  return { reached: reachedP, release };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  h.chainFail.clear();
  h.chainHold.clear();
  await flushAll();
  vi.restoreAllMocks();
});

describe('the exit drain', () => {
  it('names a whole write replaced during its failed chain whose newer write never landed, and each guild pending a re-save', async () => {
    const errors: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const ws = initWorkingSet(new FakeStore());
    vi.spyOn(ws, 'resaveGuilds').mockReturnValue(['5300000000000000001', '5300000000000000002']);

    const d = dataPath('rj5drain', String(Date.now()));
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, 'w.json');
    failChain(d);
    const one = holdChain(d);
    enqueueWrite(p, 'A1\n');
    const t1 = fileTicket(p);
    await one.reached;
    enqueueWrite(p, 'A2\n');
    const two = holdChain(d);
    one.release();
    await two.reached;
    expect(fileTicketState(t1)).not.toBe('unconfirmed');

    await drainForExit(300);

    const { why, next } = syncWords('sync', path.resolve(d), 'EIO');
    expect(errors).toContain(`[Data] ${p}: the file is written whole, but ${why}; it is not written again; can't confirm it is stored. ${next}`);
    expect(fileTicketState(t1)).toBe('unconfirmed');
    expect(warns).toContain('[Data] Shutdown drain left 2 guild(s) not re-saved on the main, once one is found: 5300000000000000001, 5300000000000000002');
  });
});

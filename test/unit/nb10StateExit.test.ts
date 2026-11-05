import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 13: cells of the state x exit table, driven with the fake child, an injected disk and injected deaths.
// Each cell asserts the answer's code and text, which process the lock names afterwards, and the file's bytes. The
// cells that run inside the bot process (its premium stop step, its replay, its drain) are the premium builder's tests
// and the child scenarios'. A cell the table leaves empty ('none'), or one no test can drive in one process, is a
// comment at its row so the cell count can be checked against the table.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { put } from '../helpers/configRig';
import { noAnswerText, sharedOpFailure } from '../../src/webui/routes/hopFailure';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith, tick } from '../helpers/nb10Rig';
import { maintenanceText } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { CHANGED_TEXT } from '../../src/bot/internalSetup/utils/ipcDataHandler';

const OTHER = 7373;
const live = new Set<number>([process.pid, OTHER]);
const FILE = () => dataPath('global', 'nb10cells', 'x.json');
const BEFORE = '{"v":0}';
const write = (m: BotManager) => m.runSharedOp('global.write', { rel: 'nb10cells/x.json', contentJson: '{"v":1}', expectSha: shaOf(BEFORE) });
const holderPid = () => (fs.existsSync(writerLockPath()) ? JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid : null);
let shaOf: (raw: string) => string;

interface Cell {
  phase: string;
  exit: string;
  run: () => Promise<{ reply: any; child?: any }>;
  code: string | null;
  text: string | RegExp | null;
  lock: () => number | null;
  bytes: 'unchanged' | 'written';
  /** The route's answer text, through sharedOpFailure. */
  route?: string;
  /** The cell sends the child shared ops of its own. */
  sent?: boolean;
  /** Runs after the cell's checks: it ends what the cell held open and checks the state that follows. */
  after?: () => Promise<void>;
}

const DEAD = 999_996;
const lockNaming = (pid: number, role = 'bot') => fs.writeFileSync(writerLockPath(), JSON.stringify({ pid, start: null, role, at: Date.now() }));

/** An op the test holds in progress in the chain (S2), under a real take. */
function heldOp(manager: BotManager): { reply: Promise<any>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
  const reply = (manager as any).enqueueLocal({
    label: 'held op', provider: false,
    run: async () => { await held; return { ok: true }; },
    again: async () => ({ ok: false, code: 'again' }),
  });
  return { reply, release };
}

/** The rename that puts this file in place waits ms first: its write is in flight on the disk (S3). */
function slowRename(absPath: string, ms: number): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === absPath) await new Promise(resolve => setTimeout(resolve, ms));
    return real(from, to);
  }) as typeof fs.promises.rename);
}

/** The child applies each shared op as the bot does; its process has no web UI write gate. */
function applyingChild(child: any): void {
  setSharedWriteGate(null);
  answering(child, message => (message.type === 'shared:op' ? applySharedOp(message.data) : undefined));
}

const cells: Cell[] = [
  {
    phase: 'S1', exit: 'continue',
    run: async () => ({ reply: await write(new BotManager()) }),
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S1', exit: 'crash (a lock naming a dead pid is taken over)',
    run: async () => {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 999_997, start: null, role: 'webui', at: Date.now() }));
      return { reply: await write(new BotManager()) };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S1', exit: 'operator stop',
    run: async () => { const m = new BotManager(); m.beginExit(); return { reply: await write(m) }; },
    code: 'stopping', text: ROUTE_TEXT.exiting, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S4', exit: 'continue (a child waiting for the web UI)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: OTHER } }]);
      return { reply: await write(manager), child };
    },
    code: 'starting', text: `The bot is waiting for the web UI (pid ${OTHER}) to release the data files; nothing was saved. Try again once it has.`, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S4', exit: 'continue (a child that cannot create the lock)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'waiting', cause: 'EROFS' }]);
      return { reply: await write(manager), child };
    },
    code: 'disk', text: /^The bot is waiting for the data disk to take writes \(.*: EROFS\); nothing was saved\. Check the disk, then try again\.$/, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S4', exit: 'restart (a waiting child is stopped and a new one forked)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: OTHER } }]);
      forks.holdExit = false;
      const restarted = await manager.restart();
      expect(restarted.success).toBe(true);
      expect(child.signals).toEqual(['SIGTERM']);
      expect(forks.children).toHaveLength(2);
      expect((manager as any).botProcess).toBe(forks.children[1]);
      return { reply: await write(manager), child: forks.children[1] };
    },
    code: 'starting', text: ROUTE_TEXT.starting, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S4', exit: 'crash (a waiting child exits 1, leaving a lock naming a dead pid)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: OTHER } }]);
      lockNaming(DEAD);
      exitChild(child, 1);
      expect(safety.recordCrash).toHaveBeenCalled();
      await vi.waitFor(() => expect(forks.children).toHaveLength(2), { timeout: 8000, interval: 50 });
      await tick(20);
      return { reply: await write(manager), child: forks.children[1] };
    },
    code: 'starting', text: ROUTE_TEXT.starting, lock: () => DEAD, bytes: 'unchanged',
  },
  {
    phase: 'S5', exit: 'continue (a guild write)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }]);
      return { reply: await manager.writeGuildData({ guildId: '123456789012345678', module: 'mod', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent' }), child };
    },
    code: 'starting', text: ROUTE_TEXT.starting, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S6', exit: 'continue (the op goes to the child)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      answering(child, () => ({ ok: true }));
      return { reply: await write(manager), child };
    },
    code: null, text: null, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S6', exit: 'crash (the child dies before answering)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      answering(child, () => { setTimeout(() => exitChild(child, 1), 5); return undefined; });
      return { reply: await write(manager), child };
    },
    code: 'no-answer', text: null, lock: () => null, bytes: 'unchanged', route: noAnswerText('stopped', 'write'),
  },
  {
    phase: 'S5', exit: 'crash (the child at shared dies before answering)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }]);
      answering(child, () => { setTimeout(() => exitChild(child, 1), 5); return undefined; });
      return { reply: await write(manager), child };
    },
    code: 'no-answer', text: null, lock: () => null, bytes: 'unchanged', route: noAnswerText('stopped', 'write'),
  },
  {
    phase: 'S7', exit: 'continue (a maintenance boot: global.write refused by the child, a premium op applied)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }]);
      child.emit('message', { type: 'maintenance:mode', data: { mode: 'maintenance', boot: true } });
      answering(child, message => (message.data?.op === 'global.write'
        ? { ok: false, code: 'maintenance', error: maintenanceText() }
        : { ok: true, result: true }));
      const premium = await manager.runSharedOp('premium.setTier', { args: ['low', { displayName: 'L', priority: 1, overrides: {}, offerings: [] }] });
      expect(premium).toEqual({ ok: true, result: true });
      const reply = await write(manager);
      expect(sentTo(child, 'shared:op').map(m => m.data.op)).toEqual(['premium.setTier', 'global.write']);
      return { reply, child };
    },
    code: 'maintenance', text: maintenanceText(), lock: () => null, bytes: 'unchanged', sent: true,
  },
  {
    phase: 'S8', exit: 'continue (a stop sent)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      void manager.shutdown(false);
      return { reply: await write(manager), child };
    },
    code: 'stopping', text: ROUTE_TEXT.stopping, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S8', exit: 'restart (a restart stop sent)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      void manager.restart();
      return { reply: await write(manager), child };
    },
    code: 'stopping', text: ROUTE_TEXT.restarting, lock: () => null, bytes: 'unchanged',
  },
  {
    phase: 'S8', exit: 'crash (the child killed during its drain: the previous-child text until its exit is seen, then a local write)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      lockNaming(child.pid);
      live.add(child.pid);
      const stopping = manager.shutdown(false);
      await tick();
      child.signalCode = 'SIGKILL';
      const before = await write(manager);
      expect(before).toMatchObject({ ok: false, code: 'held-elsewhere' });
      expect(before.error).toBe(`A previous bot process this web UI started (pid ${child.pid}) has not exited yet and still holds the data files; nothing was saved. Try again once it has exited.`);
      expect(holderPid()).toBe(child.pid);
      expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
      live.delete(child.pid);
      child.emit('exit', null, 'SIGKILL');
      await stopping;
      return { reply: await write(manager) };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S9', exit: 'continue (another live bot process holds the lock)',
    run: async () => {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
      return { reply: await write(new BotManager()) };
    },
    code: 'held-elsewhere', text: `Another process holds the data files (a bot process this web UI did not start, pid ${OTHER}); nothing was saved. Stop that process or wait until it ends, then try again.`, lock: () => OTHER, bytes: 'unchanged',
  },
  {
    phase: 'S10', exit: 'continue (a bundle import holds the lock)',
    run: async () => {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'import', at: Date.now() }));
      return { reply: await write(new BotManager()) };
    },
    code: 'held-elsewhere', text: /\(a data bundle import, pid 7373\); nothing was saved\./, lock: () => OTHER, bytes: 'unchanged',
  },
  // S1 cancel: nothing taken; a client that goes away before its request reaches BotManager leaves nothing to check.
  {
    phase: 'S1', exit: 'resume (the same CAS write sent again answers changed)',
    run: async () => {
      const m = new BotManager();
      expect(await write(m)).toMatchObject({ ok: true });
      return { reply: await write(m) };
    },
    code: 'changed', text: CHANGED_TEXT, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S1', exit: 'restart (a start forks a child, which has not opened the data files)',
    run: async () => {
      const { manager, child } = await startedWith([]);
      expect(forks.children).toHaveLength(1);
      return { reply: await write(manager), child };
    },
    code: 'starting', text: ROUTE_TEXT.starting, lock: () => null, bytes: 'unchanged',
  },
  (() => {
    let held: ReturnType<typeof heldOp>;
    return {
      phase: 'S2', exit: 'continue (a write queued behind the op runs after it)',
      run: async () => {
        const m = new BotManager();
        held = heldOp(m);
        const queued = write(m);
        await tick(20);
        expect(holderPid()).toBe(process.pid);
        expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
        held.release();
        expect(await held.reply).toEqual({ ok: true });
        return { reply: await queued };
      },
      code: null, text: null, lock: () => null, bytes: 'written',
    } as Cell;
  })(),
  // S2 cancel: the op and its land-or-cancel step run to their end and the answer is lost; continue shows the same path.
  {
    phase: 'S2', exit: 'resume (the repeat queues behind the first copy and answers changed)',
    run: async () => {
      const m = new BotManager();
      const held = heldOp(m);
      const first = write(m);
      const repeat = write(m);
      await tick(20);
      held.release();
      expect(await first).toMatchObject({ ok: true });
      return { reply: await repeat };
    },
    code: 'changed', text: CHANGED_TEXT, lock: () => null, bytes: 'written',
  },
  (() => {
    let held: ReturnType<typeof heldOp>;
    return {
      phase: 'S2', exit: 'restart (a fork during the op: the queued write answers starting, the lock stays with the web UI)',
      run: async () => {
        const m = new BotManager();
        held = heldOp(m);
        const queued = write(m);
        const { child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: process.pid } }], m);
        return { reply: await queued, child };
      },
      code: 'starting', text: ROUTE_TEXT.starting, lock: () => process.pid, bytes: 'unchanged',
      after: async () => {
        held.release();
        expect(await held.reply).toEqual({ ok: true });
        expect(holderPid()).toBe(null);
        expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
      },
    } as Cell;
  })(),
  // S2 crash: the web UI process dies; its lock names a dead pid, and the S1 crash cell shows the next taker taking it over.
  (() => {
    let held: ReturnType<typeof heldOp>;
    let m: BotManager;
    let ended: Promise<void>;
    return {
      phase: 'S2', exit: 'operator stop (beginExit: the queued write answers the shutting-down text; the op in progress ends)',
      run: async () => {
        m = new BotManager();
        held = heldOp(m);
        const queued = write(m);
        await tick(20);
        m.beginExit();
        ended = m.endLocalChain(10_000);
        const reply = await queued;
        expect(await write(m)).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.exiting });
        expect(holderPid()).toBe(process.pid);
        return { reply };
      },
      code: 'stopping', text: ROUTE_TEXT.exiting, lock: () => process.pid, bytes: 'unchanged',
      after: async () => {
        held.release();
        await ended;
        expect(await held.reply).toEqual({ ok: true });
        expect(holderPid()).toBe(null);
        expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
      },
    } as Cell;
  })(),
  {
    phase: 'S3', exit: 'continue (the write lands during the land-or-cancel step; the answer waits for it)',
    run: async () => {
      slowRename(FILE(), 300);
      const started = Date.now();
      const reply = await write(new BotManager());
      expect(Date.now() - started).toBeGreaterThanOrEqual(280);
      return { reply };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  // S3 cancel: none.
  {
    phase: 'S3', exit: 'resume (a new op queues behind the landing one and answers changed)',
    run: async () => {
      slowRename(FILE(), 300);
      const m = new BotManager();
      const first = write(m);
      await tick(50);
      const repeat = write(m);
      expect(await first).toMatchObject({ ok: true });
      return { reply: await repeat };
    },
    code: 'changed', text: CHANGED_TEXT, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S3', exit: 'restart (a fork while the write is on the wire: the lock stays until it lands, then the op answers ok)',
    run: async () => {
      slowRename(FILE(), 2_000);
      const m = new BotManager();
      let landed = false;
      const first = write(m).then(r => { landed = true; return r; });
      await tick(50);
      const { child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: process.pid } }], m);
      expect(landed).toBe(false);
      expect(holderPid()).toBe(process.pid);
      expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
      const reply = await first;
      expect(sentTo(child, 'shared:op')).toEqual([]);
      return { reply };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  // S3 crash and operator stop: as S2.
  // S4 cancel: none.
  {
    phase: 'S4', exit: 'resume (a waiting child: the repeat answers the waiting text again)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'webui', pid: OTHER } }]);
      expect(await write(manager)).toMatchObject({ ok: false, code: 'starting' });
      return { reply: await write(manager), child };
    },
    code: 'starting', text: `The bot is waiting for the web UI (pid ${OTHER}) to release the data files; nothing was saved. Try again once it has.`, lock: () => null, bytes: 'unchanged',
  },
  // S4 operator stop: as restart, whose cell stops the waiting child.
  // S5 and S6 cancel: the HTTP client going away does not reach BotManager; the child applies the op as in continue.
  ...(['S5', 'S6'] as const).flatMap((phase): Cell[] => {
    const stages = phase === 'S5' ? [{ stage: 'shared' }] : [{ stage: 'shared' }, { stage: 'guild' }];
    return [
      {
        phase, exit: 'resume (the child applies the first copy; the repeat answers changed)',
        run: async () => {
          const { manager, child } = await startedWith(stages);
          applyingChild(child);
          expect(await write(manager)).toMatchObject({ ok: true });
          const reply = await write(manager);
          expect(sentTo(child, 'shared:op').map(m => m.data.op)).toEqual(['global.write', 'global.write']);
          return { reply, child };
        },
        code: 'changed', text: CHANGED_TEXT, lock: () => null, bytes: 'written', sent: true,
      },
      {
        phase, exit: 'restart (a restart stop sent: routes answer the restarting text)',
        run: async () => {
          const { manager, child } = await startedWith(stages);
          void manager.restart();
          return { reply: await write(manager), child };
        },
        code: 'stopping', text: ROUTE_TEXT.restarting, lock: () => null, bytes: 'unchanged',
      },
      {
        phase, exit: 'operator stop (a stop sent: routes answer the stopping text)',
        run: async () => {
          const { manager, child } = await startedWith(stages);
          void manager.shutdown(false);
          return { reply: await write(manager), child };
        },
        code: 'stopping', text: ROUTE_TEXT.stopping, lock: () => null, bytes: 'unchanged',
      },
    ];
  }),
  // S7 cancel and resume: as S6.
  ...([['restart', ROUTE_TEXT.restarting], ['operator stop', ROUTE_TEXT.stopping]] as const).map(([exit, text]): Cell => ({
    phase: 'S7', exit: `${exit} (a maintenance boot stopped)`,
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }]);
      child.emit('message', { type: 'maintenance:mode', data: { mode: 'maintenance', boot: true } });
      if (exit === 'restart') void manager.restart();
      else void manager.shutdown(false);
      return { reply: await write(manager), child };
    },
    code: 'stopping', text, lock: () => null, bytes: 'unchanged',
  })),
  {
    phase: 'S7', exit: 'crash (as S5: the child dies before answering)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }]);
      child.emit('message', { type: 'maintenance:mode', data: { mode: 'maintenance', boot: true } });
      answering(child, () => { setTimeout(() => exitChild(child, 1), 5); return undefined; });
      return { reply: await write(manager), child };
    },
    code: 'no-answer', text: null, lock: () => null, bytes: 'unchanged', route: noAnswerText('stopped', 'write'),
  },
  // S8 cancel: as S6.
  {
    phase: 'S8', exit: 'resume (after the exit is seen, the repeat is a local write)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      const stopping = manager.shutdown(false);
      expect(await write(manager)).toMatchObject({ ok: false, code: 'stopping', error: ROUTE_TEXT.stopping });
      exitChild(child);
      await stopping;
      return { reply: await write(manager) };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S8', exit: 'operator stop (a second stop during the stop: as continue)',
    run: async () => {
      const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      void manager.shutdown(false);
      void manager.shutdown(false);
      return { reply: await write(manager), child };
    },
    code: 'stopping', text: ROUTE_TEXT.stopping, lock: () => null, bytes: 'unchanged',
  },
  // S9 cancel: none. S9 operator stop: the container stop ends every process, this one with it.
  {
    phase: 'S9', exit: 'resume (refused again while the holder lives)',
    run: async () => {
      lockNaming(OTHER);
      expect(await write(new BotManager())).toMatchObject({ ok: false, code: 'held-elsewhere' });
      return { reply: await write(new BotManager()) };
    },
    code: 'held-elsewhere', text: `Another process holds the data files (a bot process this web UI did not start, pid ${OTHER}); nothing was saved. Stop that process or wait until it ends, then try again.`, lock: () => OTHER, bytes: 'unchanged',
  },
  {
    phase: 'S9', exit: 'restart (a new child waits for the holder: routes answer the waiting text)',
    run: async () => {
      lockNaming(OTHER);
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'bot', pid: OTHER } }]);
      return { reply: await write(manager), child };
    },
    code: 'starting', text: new RegExp(`^The bot is waiting for .+ \\(pid ${OTHER}\\) to release the data files; nothing was saved\\. Try again once it has\\.$`), lock: () => OTHER, bytes: 'unchanged',
  },
  {
    phase: 'S9', exit: 'crash (the holder dies: refused while it lived, then its stale lock is taken over)',
    run: async () => {
      const holder = 7474;
      live.add(holder);
      lockNaming(holder);
      try {
        expect(await write(new BotManager())).toMatchObject({ ok: false, code: 'held-elsewhere' });
        expect(fs.readFileSync(FILE(), 'utf8')).toBe(BEFORE);
      } finally {
        live.delete(holder);
      }
      return { reply: await write(new BotManager()) };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  {
    phase: 'S10', exit: 'cancel, crash and operator stop (Ctrl-C leaves an import lock naming a dead pid; it is taken over)',
    run: async () => {
      lockNaming(DEAD, 'import');
      return { reply: await write(new BotManager()) };
    },
    code: null, text: null, lock: () => null, bytes: 'written',
  },
  // S10 resume: a second import refused while the first holds the lock is nb10Import.test.ts.
  {
    phase: 'S10', exit: 'restart (as continue: a new child waits for the import)',
    run: async () => {
      lockNaming(OTHER, 'import');
      const { manager, child } = await startedWith([{ stage: 'waiting', holder: { role: 'import', pid: OTHER } }]);
      return { reply: await write(manager), child };
    },
    code: 'starting', text: new RegExp(`^The bot is waiting for .+ \\(pid ${OTHER}\\) to release the data files; nothing was saved\\. Try again once it has\\.$`), lock: () => OTHER, bytes: 'unchanged',
  },
];

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui', live);
  setSharedWriteGate(() => inLocalOp());
  shaOf = (await import('../../src/bot/internalSetup/utils/ipcDataHandler')).shaOfRaw;
  await flushAll();
  put(FILE(), BEFORE);
});

afterEach(() => {
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  fs.rmSync(writerLockPath(), { force: true });
  vi.restoreAllMocks();
});

describe('the state x exit table', () => {
  it.each(cells.map(c => [`${c.phase} ${c.exit}`, c] as const))('%s', async (_name, cell) => {
    const { reply, child } = await cell.run();
    if (cell.code === null) {
      expect(reply).toMatchObject({ ok: true });
    } else {
      expect(reply).toMatchObject({ ok: false, code: cell.code });
      if (typeof cell.text === 'string') expect(reply.error).toBe(cell.text);
      else if (cell.text) expect(reply.error).toMatch(cell.text);
      if (cell.route) expect(sharedOpFailure(reply)).toEqual({ status: 503, error: cell.route });
    }
    await flushAll();
    expect(holderPid()).toBe(cell.lock());
    const bytes = fs.readFileSync(FILE(), 'utf8');
    if (cell.bytes === 'unchanged') expect(bytes).toBe(BEFORE);
    else expect(JSON.parse(bytes)).toEqual({ v: 1 });
    if (child && cell.code !== null && cell.code !== 'no-answer' && !cell.sent) expect(sentTo(child, 'shared:op')).toEqual([]);
    await cell.after?.();
  }, 15_000);
});

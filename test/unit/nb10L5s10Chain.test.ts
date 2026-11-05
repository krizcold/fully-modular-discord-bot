import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10, the web UI's local chain: ops queued behind the one in progress are routed again at a deposition or at the
// exit, a route that fails to run again still answers, and a deposition with no op in progress frees the chain.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { checkWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock, quiet, tick } from '../helpers/nb10Rig';

const OTHER = 5454;
const live = new Set<number>([process.pid, OTHER]);

function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** An op the test holds in progress in the chain, under a real take. */
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

const settled = <T>(p: Promise<T>, ms = 100): Promise<T | 'unanswered'> =>
  Promise.race([p, tick(ms).then(() => 'unanswered' as const)]);

beforeEach(() => {
  quiet();
  freshWriterLock('webui', live);
});

afterEach(() => {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  vi.restoreAllMocks();
});

describe('a queued op whose route fails to run again', () => {
  it('answers failed with the error, not ok and never left unanswered', async () => {
    const manager = new BotManager();
    const current = heldOp(manager);
    const queued = (manager as any).enqueueLocal({
      label: 'queued op', provider: false,
      run: async () => ({ ok: true }),
      again: async () => { throw new Error('route broke'); },
    });
    const ending = manager.endLocalChain();
    expect(await settled(queued)).toEqual({ ok: false, code: 'failed', error: 'route broke' });
    current.release();
    await ending;
    expect(await current.reply).toMatchObject({ ok: true });
  });
});

describe('a reroute with nothing queued', () => {
  it('keeps the lock the chain took for the op it is about to queue, and that op runs under it', async () => {
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    await manager.endLocalChain();
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(process.pid);
    expect(writerLockDepth()).toBeGreaterThan(0);
    const reply = await (manager as any).enqueueLocal({
      label: 'op', provider: false,
      run: async () => ({ ok: true, held: fs.existsSync(writerLockPath()) && JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid === process.pid }),
      again: async () => ({ ok: false, code: 'again' }),
    });
    expect(reply).toEqual({ ok: true, held: true });
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

describe('a deposition with no op in progress', () => {
  it('frees the chain: the next route reads the lock and names the process that holds it', () => {
    const manager = new BotManager();
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
    deposeNow();
    const route: any = manager.writerRoute('shared');
    expect(route).toMatchObject({ ok: false, code: 'held-elsewhere' });
    expect(route.error).toBe(`Another process holds the data files (a bot process this web UI did not start, pid ${OTHER}); nothing was saved. Stop that process or wait until it ends, then try again.`);
  });
});

describe('a deposition during an op in progress', () => {
  it('answers the queued op at once with the deposed text, before the op in progress ends', async () => {
    const manager = new BotManager();
    const current = heldOp(manager);
    const queued = manager.runSharedOp('global.write', { rel: 'nb10s10chain/x.json', contentJson: '{}', expectSha: 'absent' });
    deposeNow();
    const answer: any = await settled(queued);
    expect(answer).toMatchObject({ ok: false, code: 'held-elsewhere' });
    expect(answer.error).toBe(`Another process took the data files (a bot process this web UI did not start, pid ${OTHER}); nothing was saved. Stop that process or wait until it ends, then try again.`);
    current.release();
    expect(await current.reply).toMatchObject({ ok: false, code: 'held-elsewhere' });
  });
});

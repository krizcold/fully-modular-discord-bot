import { AsyncLocalStorage } from 'async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import {
  appendDataTracked, deleteDataTracked, deleteRawAtomic, saveDataTracked, setSharedWriteGate, writeRawAtomic,
} from '../../src/bot/internalSetup/utils/dataManager';
import { PaymentProviderRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import fs from 'fs';

// NB10 test 6: in the web UI process, outside a change the web UI applies itself, no data file is written.

const frames = new AsyncLocalStorage<{ open: boolean }>();
const inOp = () => frames.getStore()?.open === true;
const GATE_LINE = 'the web UI process writes data files only inside a change it applies itself';

afterEach(() => {
  setSharedWriteGate(null);
  vi.restoreAllMocks();
});

describe('the web UI shared write gate', () => {
  it('refuses every facade file write outside an op frame, with the log line', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSharedWriteGate(inOp);
    expect(writeRawAtomic(dataPath('global', 'nb10gate', 'a.json'), '{}')).toBe(false);
    expect(deleteRawAtomic(dataPath('global', 'nb10gate', 'a.json'))).toBe(false);
    expect(saveDataTracked('b.json', { scope: 'global', category: 'nb10gate' }, {})).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(appendDataTracked('c.jsonl', { scope: 'global', category: 'nb10gate' }, 'x\n')).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(deleteDataTracked('b.json', { scope: 'global', category: 'nb10gate' })).toEqual({ outcome: 'refused', cause: 'not-ready' });
    expect(errors.mock.calls.filter(c => String(c[0]).includes(GATE_LINE)).length).toBeGreaterThanOrEqual(4);
  });

  it('lets a session file through', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setSharedWriteGate(inOp);
    expect(writeRawAtomic(dataPath('_sessions', 'nb10.json'), '{}')).toBe(true);
  });

  it('admits writes inside an open frame and refuses them once the frame closed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setSharedWriteGate(inOp);
    const frame = { open: true };
    let later: Promise<boolean> | null = null;
    await frames.run(frame, async () => {
      expect(saveDataTracked('in.json', { scope: 'global', category: 'nb10gate' }, { v: 1 }).outcome).toBe('saved');
      later = new Promise(resolve => setTimeout(() => resolve(writeRawAtomic(dataPath('global', 'nb10gate', 'late.json'), '{}')), 20));
    });
    frame.open = false;
    expect(await later).toBe(false);
  });

  it('a payment event raised outside a frame throws in the web UI process', () => {
    setSharedWriteGate(inOp);
    expect(() => new PaymentProviderRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId: 'x', guildId: '1' } as any))
      .toThrow(/outside a change it applies/);
  });

  it('with no gate installed (the bot process) nothing changes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(saveDataTracked('free.json', { scope: 'global', category: 'nb10gate' }, {}).outcome).toBe('saved');
  });

  it('the real gate (index.ts installs inLocalOp) admits only the open frame, never the lock depth', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    configureWriterLock('webui');
    setSharedWriteGate(inLocalOp);
    const manager = new BotManager();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let fromEarlierTimer: boolean | null = null;
    let insideFrame: boolean | null = null;
    let leftRunning: Promise<boolean> | null = null;
    let lockDepthSeen = -1;
    const earlier = new Promise<void>(resolve => setTimeout(() => {
      lockDepthSeen = writerLockDepth();
      fromEarlierTimer = writeRawAtomic(dataPath('global', 'nb10gate', 'early.json'), '{}');
      resolve();
    }, 30));
    const reply = manager.runLocalOp('held op', async () => {
      insideFrame = writeRawAtomic(dataPath('global', 'nb10gate', 'inside.json'), '{"i":1}');
      leftRunning = new Promise(resolve => setTimeout(() => resolve(writeRawAtomic(dataPath('global', 'nb10gate', 'late2.json'), '{}')), 60));
      await held;
      return { ok: true };
    });
    await earlier;
    expect(lockDepthSeen).toBe(1);
    expect(fromEarlierTimer).toBe(false);
    expect(insideFrame).toBe(true);
    release();
    expect(await reply).toMatchObject({ ok: true });
    expect(await leftRunning).toBe(false);
    expect(errors.mock.calls.filter(c => String(c[0]).includes(GATE_LINE)).length).toBe(2);
    await flushAll();
    expect(queuedFilePaths().filter(p => p.includes('nb10gate'))).toEqual([]);
    expect(fs.existsSync(dataPath('global', 'nb10gate', 'early.json'))).toBe(false);
    expect(fs.existsSync(dataPath('global', 'nb10gate', 'late2.json'))).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });
});

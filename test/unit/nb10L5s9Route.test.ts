import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 decision 5 and the stop's words: which writes a stop rewords, when a write is refused before its read, and the
// route a deposed or exited child leaves.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, deposedRouteText, ROUTE_TEXT } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks, forkStage } from '../helpers/forkMock';

const OTHER = 4242;
const live = new Set<number>([process.pid, OTHER]);
const report = (child: any, data: object) => child.emit('message', { type: 'data:writer', data });
const lockHeldByOther = () => fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'webui', at: Date.now() }));
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forkStage.stages = [];
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  forkStage.stages = ['shared', 'guild'];
  vi.restoreAllMocks();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
});

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = new BotManager();
  forks.holdExit = true;
  await manager.start();
  await tick();
  return { manager, child: forks.children.at(-1) };
}

const stopped = (): any => {
  const manager: any = new BotManager();
  manager.stopKind = 'stop';
  return manager;
};

describe('a child answer during a stop', () => {
  it('an ok answer keeps the child words, whatever its answer field says', () => {
    const manager = stopped();
    const held = { ok: true, answer: 'held', result: 1 };
    expect(manager.wordedByStop('global.write', held)).toBe(held);
    const pending = { ok: true, answer: 'pending' };
    expect(manager.wordedByStop('premium.set', pending)).toBe(pending);
    const stopping = { ok: true, answer: 'node-stopping' };
    expect(manager.wordedByStop('global.write', stopping)).toBe(stopping);
  });

  it('no answer at all stays no answer', () => {
    const manager = stopped();
    expect(manager.wordedByStop('global.write', null)).toBe(null);
    expect(manager.wordedByStop('global.write', undefined)).toBe(undefined);
  });

  it('a refusal for another cause keeps the child words', () => {
    const manager = stopped();
    const conflict = { ok: false, code: 'conflict', error: 'The file changed since you opened it.' };
    expect(manager.wordedByStop('global.write', conflict)).toBe(conflict);
    const noField = { ok: false, error: 'x' };
    expect(manager.wordedByStop('global.write', noField)).toBe(noField);
  });
});

describe('a write refused before its read', () => {
  it('with no child, no exit and no deposition there is no refusal, even when another process holds the lock', () => {
    lockHeldByOther();
    const manager = new BotManager();
    expect(manager.writeRefusal('shared')).toBe(null);
    expect(manager.writeRefusal('guild')).toBe(null);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  });

  it('with no child and a free lock, asking takes no lock', () => {
    const manager = new BotManager();
    expect(manager.writeRefusal('shared')).toBe(null);
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(writerLockDepth()).toBe(0);
  });

  it('at the exit, the exit text', () => {
    const manager: any = new BotManager();
    manager.exiting = true;
    expect(manager.writeRefusal('shared')).toEqual({ ok: false, status: 503, code: 'stopping', error: ROUTE_TEXT.exiting });
  });

  it('after a deposition, the holder that took the files', () => {
    const manager: any = new BotManager();
    manager.chainDeposed = { pid: OTHER, role: 'bot' };
    expect(manager.writeRefusal('shared')).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: deposedRouteText({ role: 'bot', pid: OTHER }) });
  });

  it('a child that has exited and not yet been reaped refuses nothing before the read', async () => {
    const { manager, child } = await started();
    lockHeldByOther();
    child.exitCode = 0;
    expect(manager.isRunning()).toBe(false);
    expect(manager.writeRefusal('shared')).toBe(null);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  });
});

describe('the route a deposed child leaves', () => {
  const holder = { role: 'bot', pid: OTHER };

  it('a running child that reported its deposition: held elsewhere, naming the holder', async () => {
    const { manager, child } = await started();
    report(child, { stage: 'deposed', holder });
    expect(manager.writerRoute('shared')).toEqual({ ok: false, status: 503, code: 'held-elsewhere', error: deposedRouteText(holder) });
  });

  it('a child that reported a deposition and then the guild stage takes the write', async () => {
    const { manager, child } = await started();
    report(child, { stage: 'deposed', holder });
    report(child, { stage: 'guild' });
    expect(manager.writerRoute('shared')).toEqual({ route: 'child' });
  });

  it('once the deposed child has exited, a write runs in the local chain', async () => {
    const { manager, child } = await started();
    report(child, { stage: 'deposed', holder });
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(manager.isRunning()).toBe(false);
    expect(manager.writerRoute('shared')).toEqual({ route: 'local' });
  });
});

describe('the route with no child', () => {
  it('a shared write goes local on a Postgres bot', () => {
    expect(new BotManager().writerRoute('shared', { postgresGuild: true })).toEqual({ route: 'local' });
  });

  it('a guild write on a Postgres bot answers bot-down', () => {
    expect(new BotManager().writerRoute('guild', { postgresGuild: true })).toEqual({ ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' });
  });
});

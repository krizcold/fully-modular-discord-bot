import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 29: the texts name what is known. The bot's wait log names the holder's role; a child's answer to an op
// sent before a stop is worded by BotManager's stop state, keeping the provider sentence of a premium or payment op;
// the unreadable-lock text names the file and the check; each held-elsewhere text names a next step.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { configureWriterLock, takeWriterLockForBoot, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { applyOperatorGlobalRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { forks } from '../helpers/forkMock';
import { call, put, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, startedWith } from '../helpers/nb10Rig';

const STOP_UNCONFIRMED = 'The bot is stopping and could not confirm your change was saved; it may be lost. Check once the bot is started again.';
const STOP_NOT_SAVED = 'The bot is stopping, so your change was not saved. Save again once it is started.';

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  await resetData();
});

afterEach(() => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('the bot wait log', () => {
  it.each([
    ['webui', 'the web UI'],
    ['import', 'a data bundle import'],
    ['bot', 'a bot process'],
  ])('names a %s holder as %s', async (role, words) => {
    const warns = vi.mocked(console.warn);
    const live = new Set([process.pid, 8282]);
    configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    (process as any).send = () => true;
    try {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 8282, start: null, role, at: Date.now() }));
      await takeWriterLockForBoot(async () => { fs.rmSync(writerLockPath(), { force: true }); }, () => 0);
      expect(warns.mock.calls.map(c => String(c[0]))).toContain(`[Data] Waiting for ${words} (pid 8282) to release the data files before the bot opens them`);
    } finally {
      delete (process as any).send;
      freshWriterLock('webui');
    }
  });
});

/** An op sent to a child at shared, whose answer the test releases after BotManager sent a stop or a restart's stop. */
async function answeredAfter(kind: 'stop' | 'restart', op: string, reply: object): Promise<any> {
  const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  answering(child, async m => { if (m.type === 'shared:op') { await gate; return reply; } return undefined; });
  const sent = manager.runSharedOp(op, { args: [] });
  await new Promise(resolve => setTimeout(resolve, 10));
  const stopping = kind === 'stop' ? manager.shutdown(false) : manager.restart();
  release();
  const answer = await sent;
  exitChild(child, 0);
  await stopping.catch(() => undefined);
  return answer;
}

describe('a child answer worded by the stop BotManager sent', () => {
  it.each([
    ['premium.cancelPaidSubscriptionImmediately', 'node-stopping', `${STOP_NOT_SAVED} ${PROVIDER_SENTENCE}`],
    ['payment.webhook', 'node-stopping', `${STOP_NOT_SAVED} ${PROVIDER_SENTENCE}`],
    ['global.write', 'node-stopping', STOP_NOT_SAVED],
    ['dummy.adminSetVariant', 'node-stopping', STOP_NOT_SAVED],
    ['premium.grantManual', 'held', `${STOP_UNCONFIRMED} ${PROVIDER_SENTENCE}`],
    ['dummy.adminSetVariant', 'held', STOP_UNCONFIRMED],
    ['global.write', 'pending', STOP_UNCONFIRMED],
  ])('%s answered %s after a stop', async (op, answer, text) => {
    const reply = await answeredAfter('stop', op, { ok: false, code: 'unconfirmed', answer, error: 'the child text' });
    expect(reply).toMatchObject({ ok: false, error: text });
  });

  it('a partial node-stopping answer after a stop keeps what was saved and asks for a reload, never a save again', async () => {
    const saved = 'What was saved: premium-tiers.json. Reload to see it before you try again: trying again could apply the saved part twice.';
    const reply = await answeredAfter('stop', 'premium.grantManual', {
      ok: false, code: 'unconfirmed', answer: 'node-stopping', partial: true,
      error: `The bot is restarting, so your change was not saved in full. ${saved} ${PROVIDER_SENTENCE}`,
    });
    expect(reply).toMatchObject({ ok: false, partial: true, error: `The bot is stopping, so your change was not saved in full. ${saved} ${PROVIDER_SENTENCE}` });
    expect(reply.error).not.toContain('Save again');
    expect(reply.error).not.toContain('was not saved.');
  });

  it('after a restart stop the child text stays', async () => {
    const reply = await answeredAfter('restart', 'premium.grantManual', { ok: false, code: 'unconfirmed', answer: 'held', error: `the child restart text ${PROVIDER_SENTENCE}` });
    expect(reply).toMatchObject({ error: `the child restart text ${PROVIDER_SENTENCE}` });
  });

  it('a config save answered held after a stop shows the stopping text, not the generic one', async () => {
    put(ROOT_CONFIG_PATH, { a: 1 });
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    answering(child, async m => {
      if (m.type === 'data:global-read') return applyOperatorGlobalRead(m.data);
      if (m.type === 'shared:op') { await gate; return { ok: false, code: 'unconfirmed', answer: 'held', error: 'the child text' }; }
      return undefined;
    });
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      const saving = call(app.url, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
      for (let i = 0; i < 100 && !(child.send.mock.calls as any[]).some(c => c[0]?.type === 'shared:op'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const stopping = manager.shutdown(false);
      release();
      const reply = await saving;
      exitChild(child, 0);
      await stopping;
      expect(JSON.stringify(reply.body)).toContain(STOP_UNCONFIRMED);
    } finally {
      await app.close();
    }
  });
});

describe('the route texts', () => {
  it('the unreadable-lock text names the file and the check; every held-elsewhere text names a next step', async () => {
    const manager = new BotManager();
    fs.mkdirSync(writerLockPath());
    const unreadable = manager.writerRoute('shared') as any;
    fs.rmdirSync(writerLockPath());
    expect(unreadable.error).toContain(writerLockPath());
    expect(unreadable.error).toContain('Check that the web UI can read that file.');
    const live = new Set([process.pid, 9393]);
    configureWriterLock('webui', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    for (const holder of [{ pid: 9393, role: 'bot' }, { pid: 9393, role: 'import' }, { pid: 9393, role: 'webui' }]) {
      fs.writeFileSync(writerLockPath(), JSON.stringify({ ...holder, start: null, at: Date.now() }));
      const route = manager.writerRoute('shared') as any;
      expect(route.code).toBe('held-elsewhere');
      expect(route.error).toMatch(/(then try again|Try again (once|in a moment))\.$/);
    }
    fs.rmSync(writerLockPath(), { force: true });
  });
});

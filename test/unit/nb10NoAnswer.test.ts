import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 45: a change sent to the child that never answers (a timeout, or its exit first) answers 503 code
// no-answer with a can't-confirm text ending "Reload to check.", and the reply carries NB11's noAnswer field. An op that
// calls a payment provider adds the provider sentence (round 10's NB10-R11-O1).

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import express from 'express';
import { BotManager } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { SharedOpAnswered, sharedOpFailure, sharedOpRunner } from '../../src/webui/routes/hopFailure';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';
const BACKGROUND = /may still complete in the background/;

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  await resetData();
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

/** A child at guild that serves reads and leaves every change unanswered; exits on the first change when asked. */
async function silentChild(exitOnChange: boolean): Promise<{ manager: BotManager; child: any }> {
  const started = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
  answering(started.child, m => {
    if (m.type === 'data:guild-read') return applyOperatorDataRead(m.data);
    if (exitOnChange) setTimeout(() => exitChild(started.child, 1), 5);
    return undefined;
  });
  return started;
}

function mountAll(manager: BotManager) {
  const shared = sharedOpRunner(manager);
  return startApp(app => {
    app.use('/api/config', createConfigRoutes(manager));
    app.put('/premium/tiers/:id', express.json(), async (req, res) => {
      try {
        await shared(res, 'premium.setTier', [req.params.id, {}]);
        res.json({ success: true });
      } catch (error) {
        if (!(error instanceof SharedOpAnswered)) res.status(500).json({ success: false });
      }
    });
    app.put('/global/:file', express.json(), async (req, res) => {
      const failure = sharedOpFailure(await manager.runSharedOp('global.write', { rel: `mod/${req.params.file}`, contentJson: '{}', expectSha: 'absent' }));
      if (failure) res.status(failure.status).json({ success: false, error: failure.error });
      else res.json({ success: true });
    });
  });
}

describe('a child that exits before answering a change', () => {
  it.each([
    ['a guild data write', 'POST', '/api/config/data/update', { file: 'mod/x.json', guildId: G, data: { a: 2 } }, "can't confirm whether the change was saved. Reload to check."],
    ['a data file delete', 'POST', '/api/config/data/delete', { file: 'mod/x.json', guildId: G }, "can't confirm whether the file was deleted. Reload to check."],
    ['a guild data delete', 'POST', '/api/config/data/delete-guild', { guildId: G }, "can't confirm whether this server's data was deleted. Within a minute, `smdb graveyard list` lists a new entry for this server if it was deleted; if no new entry is listed by then, it was not."],
    ['a premium op', 'PUT', '/premium/tiers/gold', {}, `can't confirm whether the change was saved. Reload to check. ${PROVIDER_SENTENCE}`],
    ['a global file write', 'PUT', '/global/y.json', {}, "can't confirm whether the change was saved. Reload to check."],
  ] as const)('%s answers 503 no-answer with the can\'t-confirm text', async (_name, method, route, body, ending) => {
    put(dataPath(G, 'mod', 'x.json'), { a: 1 });
    const { manager, child } = await silentChild(true);
    const app = await mountAll(manager);
    try {
      const reply = await call(app.url, method as any, route, body);
      expect(reply.status).toBe(503);
      expect(reply.body.error).toBe(`The bot stopped before answering; ${ending}`);
      if (route.startsWith('/api/config')) expect(reply.body.code).toBe('no-answer');
      expect(JSON.stringify(reply.body)).not.toMatch(BACKGROUND);
      expect(sentTo(child).some(m => m.type === 'data:guild-write' || m.type === 'shared:op')).toBe(true);
      expect(readJson(dataPath(G, 'mod', 'x.json'))).toEqual({ a: 1 });
    } finally {
      await app.close();
    }
  });
});

describe('a child that never answers', () => {
  it('a guild write past 15 s and a premium op past its bound carry noAnswer timeout, and no background text', async () => {
    const { manager } = await silentChild(false);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const write = manager.writeGuildData({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent' });
    const op = manager.runSharedOp('premium.setTier', { args: [] });
    const globalOp = manager.runSharedOp('global.write', { rel: 'mod/y.json', contentJson: '{}', expectSha: 'absent' });
    await vi.advanceTimersByTimeAsync(61_000);
    const writeReply = await write;
    const opReply = await op;
    const globalReply = await globalOp;
    expect(writeReply).toMatchObject({ ok: false, noAnswer: 'timeout' });
    expect(opReply).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'timeout' });
    expect(globalReply).toMatchObject({ ok: false, code: 'no-answer', noAnswer: 'timeout' });
    const text = "The bot did not answer in time; can't confirm whether the change was saved. Reload to check.";
    expect(sharedOpFailure(writeReply)).toEqual({ status: 503, error: text });
    expect(sharedOpFailure(globalReply)).toEqual({ status: 503, error: text });
    expect(sharedOpFailure(opReply)).toEqual({ status: 503, error: `${text} ${PROVIDER_SENTENCE}` });
    expect(fs.existsSync(dataPath('global', 'mod', 'y.json'))).toBe(false);
  });
});

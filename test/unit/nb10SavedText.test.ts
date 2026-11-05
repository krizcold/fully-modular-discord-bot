import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 44: on a JSON bot the config routes answer only once the write landed; an answer the child could not yet
// confirm is 202 with the not-confirmed text, and nothing says "saved successfully" for it.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { createConfigRoutes } from '../../src/webui/routes/config';
import { applyOperatorDataRead, applyOperatorDataWrite, applyOperatorGlobalRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH } from '../../src/bot/internalSetup/utils/configManager';
import { writeBackup } from '../../src/webui/utils/configBackups';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { BACKUPS, call, put, readJson, resetData, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, logged, quiet, resetForks, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';
const PENDING = 'not confirmed as saved yet; reload in a moment to check';
const FALSE_SAVED = /saved successfully|saved, not yet/;
const SLOW_MS = 1_500;

/** Every rename onto a data file takes SLOW_MS before it lands. */
function slowFlushes(): void {
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith('.json') && !String(to).includes('configBackups')) await new Promise(resolve => setTimeout(resolve, SLOW_MS));
    return real(from, to);
  }) as typeof fs.promises.rename);
}

beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  await resetData();
});

afterEach(() => {
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

const saves = (backup: string): Array<[string, string, object, () => unknown, unknown]> => [
  ['POST /update', '/api/config/update', { file: 'config.json', config: { a: 2 } }, () => readJson(ROOT_CONFIG_PATH), { a: 2 }],
  ['POST /restore', '/api/config/restore', { file: 'config.json', filename: backup, guildId: G }, () => readJson(dataPath(G, '_guildConfig', 'config.json')), { g: 0 }],
  ['POST /data/update', '/api/config/data/update', { file: 'mod/x.json', data: { d: 2 }, guildId: G }, () => readJson(dataPath(G, 'mod', 'x.json')), { d: 2 }],
];

function seed(): string {
  put(ROOT_CONFIG_PATH, { a: 1 });
  put(dataPath(G, '_guildConfig', 'config.json'), { g: 1 });
  put(dataPath(G, 'mod', 'x.json'), { d: 1 });
  return writeBackup(BACKUPS(), 'config.json', G, JSON.stringify({ g: 0 })).filename;
}

describe.each(['the local chain', 'the child'])('a slow flush in %s', where => {
  it('each save answers 200 only after the write landed, and never says saved successfully', async () => {
    const backup = seed();
    let manager: BotManager;
    if (where === 'the local chain') {
      setSharedWriteGate(() => inLocalOp());
      manager = new BotManager();
    } else {
      const started = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
      manager = started.manager;
      answering(started.child, m => {
        if (m.type === 'data:global-read') return applyOperatorGlobalRead(m.data);
        if (m.type === 'data:guild-read') return applyOperatorDataRead(m.data);
        if (m.type === 'shared:op') return applySharedOp(m.data);
        if (m.type === 'data:guild-write') return applyOperatorDataWrite(m.data);
        return undefined;
      });
    }
    slowFlushes();
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      for (const [name, route, body, stored, expected] of saves(backup)) {
        const started = Date.now();
        const reply = await call(app.url, 'POST', route, body);
        const landed = stored();
        expect(reply.status, name).toBe(200);
        expect(Date.now() - started, name).toBeGreaterThanOrEqual(SLOW_MS - 100);
        expect(landed, name).toEqual(expected);
        expect(JSON.stringify(reply.body), name).not.toMatch(FALSE_SAVED);
      }
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe('answers the child could not confirm yet', () => {
  it('a guild write answered pending and a global.write answered unconfirmed pending are 202 with the not-confirmed text', async () => {
    seed();
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    answering(child, m => {
      if (m.type === 'data:global-read') return applyOperatorGlobalRead(m.data);
      if (m.type === 'data:guild-read') return applyOperatorDataRead(m.data);
      if (m.type === 'data:guild-write') return { ok: true, pending: true };
      if (m.type === 'shared:op') return { ok: false, code: 'unconfirmed', answer: 'pending', error: 'Your change is not confirmed as saved yet.' };
      return undefined;
    });
    const app = await startApp(a => a.use('/api/config', createConfigRoutes(manager)));
    try {
      const global = await call(app.url, 'POST', '/api/config/update', { file: 'config.json', config: { a: 2 } });
      const guild = await call(app.url, 'POST', '/api/config/data/update', { file: 'mod/x.json', data: { d: 2 }, guildId: G });
      for (const reply of [global, guild]) {
        expect(reply.status).toBe(202);
        expect(reply.body).toMatchObject({ success: true, pending: true, message: PENDING });
        expect(JSON.stringify(reply.body)).not.toMatch(FALSE_SAVED);
      }
      expect(logged(vi.mocked(console.log)).some(l => FALSE_SAVED.test(l) || /updated successfully|saved successfully/.test(l))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

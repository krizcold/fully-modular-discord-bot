import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 10, the fixer's regression tests: the deposed local chain judges an op by its own write
// tickets and refusals after the cancel's wait, never by the reply's pending or partial fields (NB10-R11-D1,
// NB10-R10-D2, NB10-R11-T1); a no-answer reply to a provider op carries the provider sentence (NB10-R11-O1).

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
const fb = vi.hoisted(() => ({ queued: null as string[] | null }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return { ...real, queuedFilePaths: () => fb.queued ?? real.queuedFilePaths() };
});

import { BotManager } from '../../src/webui/botManager';
import { cancelQueued, enqueueWrite, fileTicket, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { carriedWrites, carryWrites, NO_WRITES, type OpWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { sharedOpFailure, webhookAnswer } from '../../src/webui/routes/hopFailure';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { freshWriterLock, quiet } from '../helpers/nb10Rig';

const DIR = dataPath('global', 'nb10fix11');
const file = (name: string) => dataPath('global', 'nb10fix11', name);
const G = '900000000000001169';
const LEAD = 'Another process took the data files (a data bundle import, pid 4242) while your change was being saved;';
const entry = { label: 'x', provider: false, run: async () => undefined, again: async () => undefined, resolve: () => undefined };

const deposed = () => {
  const manager = new BotManager() as any;
  manager.chainDeposed = { role: 'import', pid: 4242 };
  return manager;
};

/** Queues one write and hands back its ticket, before any flush of it starts. */
function queued(name: string, body: string) {
  enqueueWrite(file(name), body);
  return fileTicket(file(name));
}

function writes(tickets: OpWrites['tickets'], extra: Partial<OpWrites> = {}): OpWrites {
  return { ...NO_WRITES, tickets, ...extra };
}

/** Holds the rename of the target's temp file onto it until the test opens the gate; resolves once it is on the wire. */
function holdRename(target: string): { open: () => void; onWire: Promise<void> } {
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const onWire = new Promise<void>(resolve => { reached = resolve; });
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) {
      reached();
      await gate;
    }
    return rename(from, to);
  }) as typeof fs.promises.rename);
  return { open, onWire };
}

beforeEach(async () => {
  quiet();
  fb.queued = null;
  freshWriterLock('webui');
  await flushAll();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(dataPath(G), { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
});

afterEach(async () => {
  fb.queued = null;
  vi.restoreAllMocks();
  await flushAll();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(dataPath(G), { recursive: true, force: true });
});

describe('the deposed local chain judges an op by its own tickets (NB10-R11-D1, NB10-R10-D2, NB10-R11-T1)', () => {
  it('an ok reply still pending whose write lands during the cancel wait answers saved', async () => {
    const held = holdRename(file('a.json'));
    const ticket = queued('a.json', '{"a":1}');
    await held.onWire;
    const answer = deposed().landOrCancel(entry, carryWrites({ ok: true, pending: true }, writes([ticket])));
    held.open();
    expect(await answer).toEqual({ ok: true });
    expect(fs.readFileSync(file('a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('an unconfirmed pending reply, partial or not, whose writes all landed answers saved with its result', async () => {
    const one = queued('b.json', '{}');
    const two = queued('c.json', '{}');
    await flushAll();
    for (const partial of [false, true]) {
      const reply = carryWrites({ ok: false, code: 'unconfirmed', answer: 'pending', partial, error: 'x', result: 5 }, writes([one, two]));
      const answer = await deposed().landOrCancel({ ...entry, provider: true }, reply);
      expect(answer).toEqual({ ok: true, result: 5 });
    }
  });

  it('some writes landed and one was dropped by the deposition: not saved in full, naming the landed file', async () => {
    const landedOne = queued('d.json', '{}');
    await flushAll();
    const dropped = queued('e.json', '{}');
    expect(await cancelQueued([file('e.json')], undefined, { freeze: true })).toEqual([{ path: file('e.json'), outcome: 'cancelled', errno: null }]);
    const answer = await deposed().landOrCancel({ ...entry, provider: true }, carryWrites({ ok: true }, writes([landedOne, dropped])));
    expect(answer).toEqual({
      ok: false, status: 503, code: 'held-elsewhere',
      error: `${LEAD} it was not saved in full. What was saved: d.json. Reload to see it before you try again: trying again could apply the saved part twice. ${PROVIDER_SENTENCE}`,
    });
  });

  it('no write landed and none can land: nothing was saved, whatever the reply says', async () => {
    const dropped = queued('f.json', '{}');
    await cancelQueued([file('f.json')], undefined, { freeze: true });
    for (const reply of [{ ok: true, pending: true }, { ok: false, code: 'unconfirmed', answer: 'writer-lost', partial: true, error: 'x' }]) {
      const answer = await deposed().landOrCancel(entry, carryWrites(reply, writes([dropped])));
      expect(answer.error).toBe(`${LEAD} nothing was saved.`);
    }
    expect(fs.existsSync(file('f.json'))).toBe(false);
  });

  it('a refusal next to a landed write is partial; with nothing landed it is nothing saved', async () => {
    const landedOne = queued('g.json', '{}');
    await flushAll();
    const partial = await deposed().landOrCancel(entry, carryWrites({ ok: true }, writes([landedOne], { refused: true })));
    expect(partial.error).toBe(`${LEAD} it was not saved in full. What was saved: g.json. Reload to see it before you try again: trying again could apply the saved part twice.`);
    const none = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'unconfirmed', answer: 'io', partial: false, error: 'x' }, writes([], { refused: true })));
    expect(none.error).toBe(`${LEAD} nothing was saved.`);
  });

  it("writes that cannot be known answer can't confirm: no carried writes, a write still queued, or a refusal rewritten later", async () => {
    const noWrites = await deposed().landOrCancel(entry, { ok: true, result: 1 });
    expect(noWrites.error).toBe(`${LEAD} can't confirm whether it was saved. Reload to check before you try again.`);

    const landedOne = queued('h.json', '{}');
    await flushAll();
    fb.queued = [];
    const open = queued('i.json', '{}');
    const stillQueued = await deposed().landOrCancel(entry, carryWrites({ ok: true }, writes([landedOne, open])));
    expect(stillQueued.error).toBe(`${LEAD} can't confirm whether it was saved in full. What was saved: h.json. Reload to see it before you try again: trying again could apply the saved part twice.`);
    fb.queued = null;
    await flushAll();

    const rewritten = await deposed().landOrCancel(entry, carryWrites({ ok: true }, writes([], { unknowable: true })));
    expect(rewritten.error).toBe(`${LEAD} can't confirm whether it was saved. Reload to check before you try again.`);
  });

  it('a reply refused before any write (no tickets) says nothing was saved, and an ok one with nothing to write is saved', async () => {
    const refused = await deposed().landOrCancel(entry, carryWrites({ ok: false, code: 'changed', error: 'x' }, NO_WRITES));
    expect(refused.error).toBe(`${LEAD} nothing was saved.`);
    expect(await deposed().landOrCancel(entry, carryWrites({ ok: true }, NO_WRITES))).toEqual({ ok: true });
  });
});

describe('the ops carry their own writes on the local reply, never in what IPC sends', () => {
  it("global.write carries its landed ticket under a key JSON drops", async () => {
    const reply = await applySharedOp({ op: 'global.write', args: { rel: 'nb10fix11/j.json', contentJson: '{"j":1}', expectSha: 'absent' } });
    expect(reply).toEqual({ ok: true, result: true });
    const carried = carriedWrites(reply)!;
    expect(carried.tickets.map(t => (t.kind === 'file' ? t.path : ''))).toEqual([file('j.json')]);
    expect(carried.refused).toBe(false);
    expect(JSON.parse(JSON.stringify(reply))).toEqual({ ok: true, result: true });
    expect(Object.getOwnPropertySymbols(reply).every(s => !Object.getOwnPropertyDescriptor(reply, s)!.enumerable)).toBe(true);
  });

  it('an op refused before it ran carries no writes', async () => {
    expect(carriedWrites(await applySharedOp({ op: 'nope' }))).toEqual(NO_WRITES);
  });

  it("a guild write carries its single ticket", async () => {
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'k.json', op: 'write', contentJson: '{"k":1}', expectSha: 'absent' } as any);
    expect(reply).toMatchObject({ ok: true });
    const carried = carriedWrites(reply)!;
    expect(carried.tickets).toHaveLength(1);
    expect(JSON.stringify(reply)).not.toContain('tickets');
  });
});

describe('a no-answer reply to a provider op carries the provider sentence (NB10-R11-O1)', () => {
  const manager = (error: string) => {
    const m = new BotManager() as any;
    m.writerRoute = () => ({ route: 'child' });
    m.sendIPCMessage = async () => { throw new Error(error); };
    return m as BotManager;
  };

  it('a premium op whose bot exited, and one that timed out, end with the provider sentence', async () => {
    const exited = sharedOpFailure(await manager('bot process exited before replying').runSharedOp('premium.cancelPaidSubscription', { args: [] }));
    expect(exited).toEqual({ status: 503, error: `The bot stopped before answering; can't confirm whether the change was saved. Reload to check. ${PROVIDER_SENTENCE}` });
    const timedOut = sharedOpFailure(await manager('IPC request timed out after 60000ms').runSharedOp('payment.oauthCallback', {}));
    expect(timedOut!.error).toBe(`The bot did not answer in time; can't confirm whether the change was saved. Reload to check. ${PROVIDER_SENTENCE}`);
    const hook = webhookAnswer(await manager('bot process was stopped before replying').runSharedOp('payment.webhook', {}));
    expect(String(hook.body.error).endsWith(PROVIDER_SENTENCE)).toBe(true);
  });

  it('global.write and dummy ops get no provider sentence', async () => {
    for (const op of ['global.write', 'dummy.adminSetVariant']) {
      const failure = sharedOpFailure(await manager('bot process exited before replying').runSharedOp(op, {}));
      expect(failure!.error).toBe("The bot stopped before answering; can't confirm whether the change was saved. Reload to check.");
    }
  });
});

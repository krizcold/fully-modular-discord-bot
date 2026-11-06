import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyOperatorDataRead, applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { guildDataOpOf, RESTORE_TEXTS, setGuildDataBackend } from '../../src/bot/internalSetup/utils/dataManager';
import type { RestoreOutcome } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { setBackendKind } from '../helpers/backendKind';
import { LEASED, NOT_LEASED, readinessRig, stopDrivers, watch } from '../helpers/readinessRig';

// NB7 decision 2: a bot process asked to change or read a guild whose shard it does not serve answers not-held at once,
// before the ready wait and before NB11's admission; nothing is read, hydrated or queued.

const NOT_HELD = { ok: false, code: 'not-held' };

afterEach(() => {
  setStoppedServingHook(null);
  stopDrivers();
  vi.useRealTimers();
});

function rig(lease = NOT_LEASED) {
  const r = readinessRig(lease);
  setGuildDataBackend(r.store);
  const admit = vi.spyOn(r.driver, 'admitInteraction');
  return { ...r, admit };
}

const flush = () => new Promise<void>(resolve => { setImmediate(resolve); });

describe('NB7 decision 2: not-held', () => {
  it('answers a write of an unleased guild in one turn, with nothing hydrated or queued', async () => {
    const { guild, admit, ws, store } = rig();
    const guildId = guild();
    const seen = watch(applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{}' }));
    await flush();
    expect(seen.settled()).toBe(true);
    expect(seen.value()).toMatchObject(NOT_HELD);
    expect(admit).not.toHaveBeenCalled();
    expect(ws.has(guildId)).toBe(false);
    expect(store.hydrationsSent).toBe(0);
    expect(store.flushesSent).toBe(0);
  });

  it('answers a read of an unleased guild in one turn', async () => {
    const { guild, admit } = rig();
    const guildId = guild();
    const seen = watch(applyOperatorDataRead({ guildId, module: 'm', filename: 'a.json' }));
    await flush();
    expect(seen.settled()).toBe(true);
    expect(seen.value()).toEqual(NOT_HELD);
    expect(admit).not.toHaveBeenCalled();
  });

  it('answers not-held for a leased guild once the process stopped serving', async () => {
    const { ready, admit } = rig(LEASED);
    const guildId = await ready();
    setStoppedServingHook(() => true);
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename: 'a.json', op: 'write', contentJson: '{}' })).toMatchObject(NOT_HELD);
    expect(await applyOperatorDataRead({ guildId, module: 'm', filename: 'a.json' })).toEqual(NOT_HELD);
    expect(admit).not.toHaveBeenCalled();
  });

  it('runs a leased guild as today', async () => {
    const { ready } = rig(LEASED);
    const guildId = await ready();
    const read = await applyOperatorDataRead({ guildId, module: 'm', filename: 'a.json' });
    expect(read.ok).toBe(true);
    expect(read.code).toBeUndefined();
  });

  it('validates first: an invalid request is refused as invalid, not not-held', async () => {
    const { guild } = rig();
    const guildId = guild();
    expect(await applyOperatorDataWrite({ guildId, module: 'm', filename: '../x.json', op: 'write', contentJson: '{}' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await applyOperatorDataRead({ guildId: 'abc', module: 'm', filename: 'a.json' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('answers not-held before NB11 admission for a restore and a namespace delete', async () => {
    const { guild, admit } = rig();
    const guildId = guild();
    const answerByMono = (process.hrtime.bigint() + 45_000_000_000n).toString();
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'restore-graveyard', contentJson: '{}', answerByMono })).toMatchObject(NOT_HELD);
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'delete-namespace', answerByMono })).toMatchObject(NOT_HELD);
    expect(admit).not.toHaveBeenCalled();
  });

  it('answers not-held before NB11 admission while a restore of the guild runs, not "already running"', async () => {
    const { ready, store } = rig(LEASED);
    const guildId = await ready();
    let release!: (outcome: RestoreOutcome) => void;
    store.restoreGuild = () => new Promise<RestoreOutcome>(resolve => { release = resolve; });
    const answerByMono = () => (process.hrtime.bigint() + 45_000_000_000n).toString();
    const first = applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'restore-graveyard', contentJson: '{}', answerByMono: answerByMono() });
    for (let i = 0; i < 50 && guildDataOpOf(guildId) !== 'restore'; i++) await flush();
    expect(guildDataOpOf(guildId)).toBe('restore');
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'restore-graveyard', contentJson: '{}', answerByMono: answerByMono() })).toMatchObject({ ok: false, code: 'invalid', error: RESTORE_TEXTS.alreadyRunning });
    setStoppedServingHook(() => true);
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'restore-graveyard', contentJson: '{}', answerByMono: answerByMono() })).toEqual(NOT_HELD);
    expect(await applyOperatorDataWrite({ guildId, module: '', filename: '', op: 'delete-namespace', answerByMono: answerByMono() })).toEqual(NOT_HELD);
    release({ ok: false, reason: 'unavailable' });
    await first;
  });

  it('a JSON bot never answers not-held', async () => {
    const { guild } = rig();
    const guildId = guild();
    setBackendKind('file');
    const reply = await applyOperatorDataRead({ guildId, module: 'm', filename: 'a.json' });
    expect(reply.code).not.toBe('not-held');
  });

  it('answers as today before the lease is set: not-held only once the lease, fixed for the process\'s life, is set', async () => {
    const r = readinessRig(null);
    setGuildDataBackend(r.store);
    const guildId = r.guild();
    expect(await applyOperatorDataRead({ guildId, module: 'm', filename: 'a.json' })).toMatchObject({ ok: false, code: 'backend-unavailable' });
  });
});

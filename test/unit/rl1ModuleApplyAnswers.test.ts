import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, moduleApply.ts: the answers a publishing caller gives (T7, T9, T18, T30), applyLaterOf, and the busy result.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { applyRig } from '../helpers/nb6ApplyRig';
import { readStoreRecord, writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { storeMutex } from '../../src/bot/internalSetup/utils/appStoreManager';
import {
  applyLaterOf, applyModuleChange, deferredText, publisherAnswer, type ApplyResult,
} from '../../src/bot/internalSetup/utils/moduleApply';

const rig = applyRig();
beforeEach(() => rig.setup());
afterEach(() => rig.teardown());

const TAIL = 'The other machines try it when they apply it, and the App Store tab lists each machine where it fails.';
const res = (r: Partial<ApplyResult>): ApplyResult => ({ outcome: 'deferred', reason: null, error: null, loaded: false, ...r });

function setEntry(module: string, fields: { retryAt?: number | null; from?: string }): void {
  const read = readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  read.record.modules[module] = {
    sha: 'absent', stamp: null, files: {}, main: null, built: null, failedSha: null, retryAt: fields.retryAt ?? null,
    ...(fields.from === undefined ? {} : { applying: { from: fields.from, to: 'x', backup: null, displaced: 'backups', tag: null, version: null, updatedBy: null } }),
  } as any;
  writeStoreRecord(read.record);
}

describe('rl1 the busy result', () => {
  it('an apply whose store mutex wait ends unanswered ends busy, and the caller says another change was running', async () => {
    vi.spyOn(storeMutex, 'acquire').mockResolvedValue(null as any);
    const result = await applyModuleChange({ module: 'm', to: 'absent', source: 'rows', displaced: 'backups', reason: 'pass', tag: '1:ALPHA' });
    expect(result).toEqual({ outcome: 'busy', reason: 'busy', error: null, loaded: false });
    expect(publisherAnswer('install', 'm', '1.2.0', result).outcome).toBe('busy');
  });
});

describe('rl1 applyLaterOf', () => {
  it('a module with no entry is tried at the next pass', () => {
    expect(applyLaterOf('nothing-here')).toEqual({ kind: 'pass' });
  });

  it('a retryAt in the past is tried at the next pass; one in the future after it', () => {
    setEntry('m', { retryAt: Date.now() - 60_000 });
    expect(applyLaterOf('m')).toEqual({ kind: 'pass' });
    const at = Date.now() + 60_000;
    setEntry('m', { retryAt: at });
    expect(applyLaterOf('m')).toEqual({ kind: 'after', at });
  });

  it('a retryAt equal to now is due, so it is tried at the next pass', () => {
    const now = 1_800_000_000_000;
    setEntry('m', { retryAt: now });
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(applyLaterOf('m')).toEqual({ kind: 'pass' });
  });
});

describe('rl1 deferredText', () => {
  it('answers nothing for an outcome other than deferred or busy, whatever its reason', () => {
    for (const outcome of ['applied', 'failed', 'loaded'] as const) {
      expect(deferredText('install', 'm', '1.2.0', res({ outcome, reason: 'fetch', error: 'x' }))).toBeNull();
      expect(deferredText('install', 'm', '1.2.0', res({ outcome, reason: 'busy' }))).toBeNull();
    }
  });

  it('a fetch that failed names its error, or says the database did not answer', () => {
    expect(deferredText('install', 'm', '1.2.0', res({ reason: 'fetch', error: 'connection refused' }))).toBe(
      'm 1.2.0 was installed. This machine applies it at its next pass (connection refused).',
    );
    expect(deferredText('update', 'm', '1.2.0', res({ reason: 'fetch' }))).toBe(
      'm 1.2.0 was updated. This machine applies it at its next pass (the database did not answer).',
    );
    expect(deferredText('uninstall', 'm', '1.2.0', res({ reason: 'fetch' }))).toBe(
      'm was uninstalled. This machine removes its files at its next pass (the database did not answer).',
    );
  });

  it('an uninstall while the module starts says the files go at the next pass, and why', () => {
    for (const state of ['e', 'f'] as const) {
      expect(deferredText('uninstall', 'm', '1.2.0', res({ reason: 'starting', state }))).toBe(
        'm was uninstalled. This machine removes its files at its next pass (this machine was still starting m).',
      );
    }
    expect(deferredText('uninstall', 'm', '1.2.0', res({ reason: 'starting', state: 'd' }))).toBe(
      'm was uninstalled. This machine removes its files at its next pass (it is loading m right now).',
    );
  });
});

describe('rl1 publisherAnswer', () => {
  it('a loaded apply is marked starting and says what this machine keeps if its start-up code fails', () => {
    setEntry('m', { from: 'absent' });
    expect(publisherAnswer('install', 'm', '1.2.0', res({ outcome: 'loaded', loaded: true }))).toEqual({
      outcome: 'loaded', reason: null, error: null, loaded: true, starting: true,
      text: 'm 1.2.0 was installed and loaded on this machine, and its start-up code is still running. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps no copy of m.',
    });
    setEntry('m', { from: 'abc123' });
    expect(publisherAnswer('update', 'm', '1.2.0', res({ outcome: 'loaded', loaded: true })).text).toBe(
      'm 1.2.0 was updated and loaded on this machine, and its start-up code is still running. The App Store tab lists this machine if that code fails within 10 minutes; this machine then keeps the previous version.',
    );
  });

  it('a deferred answer carries no starting mark', () => {
    expect(publisherAnswer('install', 'm', '1.2.0', res({ reason: 'busy', outcome: 'busy' }))).toEqual({
      outcome: 'busy', reason: 'busy', error: null, loaded: false,
      text: 'm 1.2.0 was installed. This machine applies it at its next pass (another App Store change was still running on this machine).',
    });
  });

  it('a failed apply whose previous version failed too names both errors, or points to the log', () => {
    expect(publisherAnswer('install', 'm', '1.2.0', res({ outcome: 'failed', error: 'boom', kept: 'failed-too', previousError: 'old boom' })).text).toBe(
      `m 1.2.0 was installed, but it failed to load on this machine (boom), and the previous version did not load either (old boom), so this machine runs without m until a version loads. ${TAIL}`,
    );
    expect(publisherAnswer('update', 'm', '1.2.0', res({ outcome: 'failed', error: 'boom', kept: 'failed-too' })).text).toBe(
      `m 1.2.0 was updated, but it failed to load on this machine (boom), and the previous version did not load either (see the bot's log), so this machine runs without m until a version loads. ${TAIL}`,
    );
  });

  it('in maintenance each operation says the module is applied or removed when maintenance ends', () => {
    const m = res({ reason: 'maintenance' });
    expect(publisherAnswer('install', 'm', '1.2.0', m).text).toBe(
      "m 1.2.0 was installed. This machine's bot is in maintenance, so it applies the module when maintenance ends.",
    );
    expect(publisherAnswer('update', 'm', '1.2.0', m).text).toBe(
      "m was updated to 1.2.0. This machine's bot is in maintenance, so it applies the module when maintenance ends.",
    );
    expect(publisherAnswer('uninstall', 'm', '1.2.0', m).text).toBe(
      "m was uninstalled. This machine's bot is in maintenance, so it removes the module's files when maintenance ends.",
    );
  });
});

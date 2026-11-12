import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import {
  _resetSharedMirror, bootShared, setSharedModulePassStep, sharedBootCause, sharedBootCauseLocal, stopSharedPass,
} from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sharedRows } from '../helpers/sharedRows';

// L5 run A, chunk 81: the first boot try of a process whose module step answers false with no cause. The mirror is
// not reset before it (the reset would hide the state the process starts in), so this file holds one case.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

let pg: ReturnType<typeof scriptedBackend> | null = null;

afterEach(async () => {
  _resetSharedMirror();
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  setMainChooser(null);
  await pg?.backend.stop();
  vi.restoreAllMocks();
});

describe('the boot try of a fresh process with no cause', () => {
  it('logs the wait for the database, not for this machine, and names no local cause', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
    _resetRowQueue();
    setMainChooser(null);
    fs.rmSync(dataPath('global'), { recursive: true, force: true });
    fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
    setBackendKind('postgres');
    const rows = sharedRows();
    pg = scriptedBackend(rows.answer);
    dm.setGuildDataBackend(pg.backend);
    setSharedModulePassStep(async () => false);

    const boot = bootShared();
    const waits = () => lines.filter(l => l.startsWith('[Shared] Waiting for '));
    await vi.waitFor(() => expect(waits().length).toBeGreaterThan(0));
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
    expect(waits()[0]).toBe('[Shared] Waiting for the database to bring the shared files up to date (null); modules start once they are');
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootCauseLocal()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 code review round 1, lane B findings 3 and 5 (out/NB6/review1-B.md; ruled in part-rulings.md "Code review round
// 1"): the boot's line when the pass's module step cannot read the module rows, and a 'module' notice from another
// machine. Module rows are written by the real publish; folders and entries by the real pass's module step.

vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});

import { bootShared, runSharedPass, sharedBootCause, startSharedPass, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { applyRig } from '../helpers/nb6ApplyRig';
import { listenRig } from '../helpers/nb6Listen';
import { lost } from '../helpers/sharedRows';

const rig = applyRig();
const MODULES_SQL = 'SELECT module, sha, version, updated_by FROM smdb_data.shared_modules';
const M_FILES = { 'module.json': '{"name":"m","version":"1.0.0"}', 'index.js': 'exports.v = 1;\n' };
const N_FILES = { 'module.json': '{"name":"n","version":"1.0.0"}', 'index.js': 'exports.n = 1;\n' };

beforeEach(() => rig.setup());
afterEach(async () => {
  _setListenClientFactory(null);
  await rig.teardown();
});

describe("B3: the module step's read fails at the boot", () => {
  it("the boot's line and sharedBootCause name the module read's cause", async () => {
    rig.state.rows.fault = sql => (sql === MODULES_SQL ? lost() : undefined);
    const boot = bootShared();
    await vi.waitFor(() => expect(rig.state.lines.some(l => l.startsWith('[Shared] Waiting for the database'))).toBe(true));
    const cause = sharedBootCause();
    stopSharedPass();
    await expect(boot).resolves.toBe('stopped');
    expect(cause).not.toBeNull();
    expect(cause).toContain(lost().message);
    expect(rig.state.lines.filter(l => l.startsWith('[Shared] Waiting for the database'))).toEqual([
      `[Shared] Waiting for the database to bring the shared files up to date (${cause}); modules start once they are`,
    ]);
  });
});

describe("B5: another machine's 'module' notice", () => {
  it('runs the module step for that module at once; another module waits for the next pass', async () => {
    const listen = listenRig();
    _setListenClientFactory(listen.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(listen.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await runSharedPass();
    const m = await rig.publish('m', M_FILES);
    await rig.publish('n', N_FILES);
    listen.last().notify('smdb_shared', JSON.stringify({ k: 'module', module: 'm', sha: m, rev: 1, by: 'p-bravo' }));
    await vi.waitFor(() => expect(rig.live('m')).toEqual(M_FILES));
    expect(rig.entry('m')?.sha).toBe(m);
    expect(rig.live('n')).toBeNull();
  });
});

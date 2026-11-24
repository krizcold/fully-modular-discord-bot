import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB46 rows 2 to 5 (wip-redesign/notes/NB46-cause.md): a spare, a Postgres bot granted no shard, over NB6 part 18's
// boot rig. The boot loads m with the real ModuleLoader, whose `onModuleCode` opens m's boot start with its entry's sha
// and hands it to its turn; the spare never logs in, so no turn runs. The boot ends as runBot ends it for a process
// granted no shard (`endUnservedBootStarts(0)`); then another machine's uninstall or update reaches m through the pass
// or the notice.

const h = vi.hoisted(() => ({ manifests: (() => []) as () => string[] }));

vi.mock('dotenv/config', () => ({}));
vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/moduleReloader', async orig => {
  const real = await orig<any>();
  const { reloaderMock } = await import('../helpers/nb6FakeLoader');
  return { ...real, ...reloaderMock };
});
vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), findModuleManifests: () => h.manifests() }));

import { bootRig, moduleFiles } from '../helpers/nb6BootRig';
import { listenRig } from '../helpers/nb6Listen';
import { endUnservedBootStarts, startStateOf } from '../../src/bot/internalSetup/utils/moduleCrashes';
import { runSharedPass, startSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';

const rig = bootRig();
const shared = () => rig.apply.state.lines.filter(l => l.startsWith('[Shared]'));
const spareBootEnd = () => endUnservedBootStarts(0);

beforeEach(async () => {
  await rig.setup();
  h.manifests = rig.manifests;
});
afterEach(async () => {
  _setListenClientFactory(null);
  await rig.teardown();
});

/** m 1.0.0 in place, then the spare's boot: m loaded, its boot start open with its sha. */
async function spareWithM(): Promise<string> {
  const s = await rig.inPlace('m', '1.0.0');
  await rig.boot();
  expect(rig.loaded()).toEqual(['m@1.0.0']);
  expect(startStateOf('m')).toBe('c');
  return s;
}

describe("row 2: another machine's uninstall reaches a spare through the pass", () => {
  it('moves the live folder to the backups, drops the entry and unloads m', async () => {
    await spareWithM();
    await spareBootEnd();
    await rig.apply.unpublish('m');
    rig.fakeLoader.unloads = [];
    await rig.apply.pass();
    expect(rig.apply.live('m')).toBeNull();
    expect(rig.apply.backupsOf('m')).toHaveLength(1);
    expect(rig.apply.entry('m')).toBeUndefined();
    expect(rig.fakeLoader.unloads).toEqual(['m']);
  });
});

describe("row 3: another machine's update reaches a spare through the pass", () => {
  it('swaps U in and loads it', async () => {
    await spareWithM();
    await spareBootEnd();
    const u = await rig.publish('m', '2.0.0');
    rig.fakeLoader.loads = [];
    await rig.apply.pass();
    expect(rig.apply.live('m')).toEqual(moduleFiles('m', '2.0.0'));
    expect(rig.fakeLoader.loads).toEqual([{ module: 'm', sha: u }]);
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
  });
});

describe("row 4: another machine's uninstall reaches a spare through its notice alone", () => {
  it("the 'module' notice removes m with no pass after it", async () => {
    await spareWithM();
    await spareBootEnd();
    const listen = listenRig();
    _setListenClientFactory(listen.factory as never);
    startSharedPass();
    await vi.waitFor(() => expect(listen.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await runSharedPass();
    await rig.apply.unpublish('m');
    rig.fakeLoader.unloads = [];
    listen.last().notify('smdb_shared', JSON.stringify({ k: 'module', module: 'm', sha: 'absent', rev: 2, by: 'p-bravo' }));
    await vi.waitFor(() => expect(rig.fakeLoader.unloads).toEqual(['m']));
    await vi.waitFor(() => expect(rig.apply.entry('m')).toBeUndefined());
    expect(rig.apply.live('m')).toBeNull();
  });
});

describe('row 5: a version the spare applied at its own boot', () => {
  it("is finished at the boot's end, and the next boot puts nothing back", async () => {
    const s = await rig.inPlace('m', '1.0.0');
    const u = await rig.publish('m', '2.0.0');
    await rig.boot();
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.entry('m')?.applying).toMatchObject({ from: s, to: u });
    expect(rig.apply.backupsOf('m')).toHaveLength(1);
    expect(startStateOf('m')).toBe('c');
    await spareBootEnd();
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null, built: { sha: u } });
    expect(rig.apply.status('m')).toEqual([expect.objectContaining({ state: 'applied', sha: u })]);
    expect(rig.apply.backupsOf('m')).toEqual([]);
    rig.apply.state.lines.length = 0;
    await rig.boot();
    expect(shared().filter(l => l.includes('was cut off'))).toEqual([]);
    expect(rig.loaded()).toEqual(['m@2.0.0']);
    expect(rig.apply.entry('m')).toMatchObject({ sha: u, applying: null });
  });
});

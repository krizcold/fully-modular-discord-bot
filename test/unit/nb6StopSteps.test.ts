import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { startSharedPass, stopSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { _setListenClientFactory } from '../../src/bot/internalSetup/utils/sharedListener';
import { listenRig } from '../helpers/nb6Listen';
import { mirrorRig, text } from '../helpers/nb6Mirror';

// NB6 test 70, cell 440 on a Postgres bot (wip-redesign/sheets/NB6.md: C25 and D4; part 8): the one stop of the bot
// process (dataManager.ts's installStopHandler) runs the stop step stopSharedPass, as clientInitializer.ts adds it
// on a Postgres bot. It clears the 60 s timer, sets the pass's stop mark and ends the listener; no apply, pass or
// prune starts after it. Cell 462 (a JSON bot adds no step) is in nb6BootOrder.test.ts.

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));

const m = mirrorRig('nb6stop');
const rig = listenRig();
const exits: Array<number | undefined> = [];

beforeAll(async () => {
  await m.setup();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as never);
  const realOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...a: unknown[]) => void) => (event === 'SIGTERM' || event === 'SIGINT' ? process : realOn(event, listener))) as never);
  _setListenClientFactory(rig.factory as never);
});

afterAll(async () => {
  _setListenClientFactory(null);
  await m.teardown();
});

describe('cell 440: a stop with the pass timer and the listener up', () => {
  it('clears the timer, ends the listener, and starts no apply after it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dm.addStopStep(stopSharedPass);
    dm.installStopHandler();
    startSharedPass();
    await vi.waitFor(() => expect(rig.clients[0]?.queries).toContain('LISTEN smdb_guild_requests'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const client = rig.clients[0];

    await dm.beginStop();
    expect(exits).toEqual([0]);
    expect(client.ended).toBe(true);

    m.state.pg.sent.length = 0;
    m.state.rows.put(m.keyOf('late.json'), text({ v: 1 }));
    client.notify('smdb_shared', JSON.stringify({ k: 'doc', key: m.keyOf('late.json'), sha: 'c'.repeat(64), rev: 3, by: 'another-process' }));
    vi.advanceTimersByTime(60_000 * 3);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(m.state.pg.sent).toEqual([]);
    expect(m.read('late.json')).toBeNull();
    expect(rig.clients).toHaveLength(1);
  });
});

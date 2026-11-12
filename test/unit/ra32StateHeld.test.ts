import { afterEach, describe, expect, it, vi } from 'vitest';

const ws = vi.hoisted(() => ({ current: null as null | { resaveGuilds: () => string[]; heldGuilds: () => unknown[] } }));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>()),
  getWorkingSet: () => ws.current,
}));

import { getFleetState } from '../../src/bot/internalSetup/fleet/state';
import { setMainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// Decision 19: the database view shows held counts only while some set waits for a re-save.

afterEach(() => {
  setMainChooser(null);
  ws.current = null;
});

function withView(resave: string[], held: string[]) {
  setMainChooser({
    view: () => ({ chosen: 'db1', generation: 1, machine: 'A', state: 'main', reason: null, addresses: [], checkedAgoMs: 0 }),
  } as any);
  ws.current = {
    resaveGuilds: () => resave,
    heldGuilds: () => held.map(guildId => ({ guildId, reason: null, code: null })),
  };
  return getFleetState().database;
}

describe('the database view held counts', () => {
  it('shows no held counts when no set waits for a re-save', () => {
    expect(withView([], ['g1'])!.held).toBeNull();
  });

  it('shows the held and re-save counts while a set waits for a re-save', () => {
    expect(withView(['g1'], ['g1', 'g2'])!.held).toEqual({ guilds: 2, resave: 1 });
  });
});

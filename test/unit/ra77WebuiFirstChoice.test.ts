import { afterAll, describe, expect, it } from 'vitest';

import { _setWebuiChoiceDeps, ownChoiceLast, resolveWebuiDatabase } from '../../src/webui/utils/webuiDataReader';
import { parseAddressList } from '../../src/utils/databaseAddress';
import type { ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

const A = 'postgres://bot:pw@a.example:5432/bot';

afterAll(() => _setWebuiChoiceDeps(null));

describe('ra77: the first read of a fresh web UI process', () => {
  it('starts a choice of its own with no reset before it', async () => {
    const [e] = parseAddressList(A);
    let probes = 0;
    _setWebuiChoiceDeps({
      entries: () => parseAddressList(A),
      probe: async () => {
        probes++;
        return [{
          kind: 'answered', address: e.shown, entry: A, inRecovery: false, readOnly: false, generation: 0, machine: 'M',
          since: null, sysid: 's', started: 't', storeId: 'store-1', ownerChannel: { kind: 'none' },
        } as ProbeAnswer];
      },
      readNotice: async () => ({ kind: 'none' }),
      markerStoreId: () => 'store-1',
      noticeCheckOff: () => false,
    });
    resolveWebuiDatabase();
    expect(probes).toBe(1);
    for (let i = 0; i < 200 && !('entry' in ownChoiceLast()); i++) await new Promise(resolve => setImmediate(resolve));
    expect(ownChoiceLast()).toEqual({ entry: A, tag: '0' });
  });
});

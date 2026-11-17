import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPanelRoutes } from '../../src/webui/routes/panels';
import { watcherFor } from '../../src/webui/routes/panelRequestRoute';
import { _resetPanelLiveWatch } from '../../src/webui/utils/panelLiveWatch';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';

const GUILD = '223456789012345678';

describe('POST /api/panels/watch when the watch throws a value that is no Error', () => {
  let app: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(async () => {
    setBackendKind('postgres');
    const bot: any = {
      isRunning: () => true,
      writerRoute: () => ({ route: 'child' }),
      panelIpc: async () => ({ success: true }),
      emitPanelUpdate: () => undefined,
      emitPanelLiveStatus: () => undefined,
    };
    vi.spyOn(watcherFor(bot), 'watch').mockImplementation(() => {
      throw 'not an error';
    });
    app = await startApp(a => a.use('/api/panels', createPanelRoutes(bot)));
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    _resetPanelLiveWatch();
    setBackendKind(null);
    vi.restoreAllMocks();
  });

  it('sc3 watch throw: answers 500 with "Failed to watch the panel: Unknown error"', async () => {
    const res = await fetch(`${app!.url}/api/panels/watch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guildId: GUILD, panelId: 'giveaway' }), signal: AbortSignal.timeout(2000),
    });
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 500, body: { success: false, error: 'Failed to watch the panel: Unknown error' },
    });
  });
});

import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => ({ info: { recommendedShards: 1, sessionStartLimit: null }, error: null })),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(await orig<any>()),
  getDataReadiness: () => ({ onLeaseChanged: () => undefined }),
}));

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  cleanOrphanTmpFiles: vi.fn(async () => {}),
}));

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'node-a',
  getNodeName: () => 'Node A',
  getAppVersion: () => '1.0.0',
}));

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: () => undefined,
    isStarted: () => false,
    start: vi.fn(async () => 'ok'),
    stop: vi.fn(async () => {}),
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});

import { bootShards } from '../../src/bot/internalSetup/fleet/shardBoot';
import { placeGuildWrite } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB12 (wip-redesign/sheets/NB12.md, rule P on the file route): the bot process keeps its view of a guild folder
// across writes, so a stored key a write is refused for is reported to the operator once, not on every write.

describe('after the shard boot, the bot keeps a view of each guild folder', () => {
  it('a guild holding a refused key is reported once across two writes', async () => {
    const guildId = '9414000001';
    fs.mkdirSync(path.join(dataPath(guildId), 'm'), { recursive: true });
    fs.writeFileSync(path.join(dataPath(guildId), '.graveyard.json'), '{}');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await bootShards();
    const reported = () => errors.mock.calls.filter(c => String(c[0]).startsWith(`[Data] Guild ${guildId} holds`)).length;
    expect(placeGuildWrite(guildId, 'm/a.json')).toEqual({ ok: true });
    expect(reported()).toBe(1);
    expect(placeGuildWrite(guildId, 'm/b.json')).toEqual({ ok: true });
    expect(reported()).toBe(1);
  });
});

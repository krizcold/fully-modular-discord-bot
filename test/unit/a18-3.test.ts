import { Status } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';

function freshService() {
  const svc = new IngestService();
  const client = svc.buildClient({ intents: [] });
  return { svc, client, ws: client.ws as any };
}

describe('A18-3 resetGateway keeps the first ready reachable', () => {
  it('a stop before the first ready leaves the manager Idle so the next login emits clientReady', () => {
    const { svc, ws } = freshService();
    (svc as any).resetGateway();
    expect(ws.status).toBe(Status.Idle);
    ws.totalShards = 0;
    let fired = 0;
    ws.client.once('clientReady', () => { fired++; });
    ws.checkShardsReady();
    expect(fired).toBe(1);
  });

  it('a stop after the first ready keeps the manager Ready so once-only boot work does not re-run', () => {
    const { svc, client, ws } = freshService();
    client.emit('clientReady', client as any);
    (svc as any).resetGateway();
    expect(ws.status).toBe(Status.Ready);
  });
});

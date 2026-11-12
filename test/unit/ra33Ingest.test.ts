import { afterEach, describe, expect, it } from 'vitest';

import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';

const clients: Array<{ destroy(): unknown }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.destroy();
});

const SAID = '[Ingest] adoptClient() with a Client this service did not build';

describe('adoptClient', () => {
  it('a Client another service built is refused with why', () => {
    const mine = new IngestService();
    const other = new IngestService();
    clients.push(mine.buildClient({ intents: [] }));
    const foreign = other.buildClient({ intents: [] });
    clients.push(foreign);

    expect(() => mine.adoptClient(foreign, () => undefined)).toThrow(SAID);
  });

  it('a service that built no Client refuses with why', () => {
    const other = new IngestService();
    const foreign = other.buildClient({ intents: [] });
    clients.push(foreign);

    expect(() => new IngestService().adoptClient(foreign, () => undefined)).toThrow(SAID);
  });
});

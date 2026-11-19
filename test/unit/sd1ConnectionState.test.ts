import { afterEach, describe, expect, it } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';

const backends: PostgresBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
});

function fresh(): PostgresBackend {
  const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
  backends.push(backend);
  return backend;
}

describe('connectionState outside an outage', () => {
  it('a backend that has not started reports connecting with no outage time', () => {
    expect(fresh().connectionState()).toStrictEqual({ state: 'connecting' });
  });

  it('a ready backend reports ready with no outage time', () => {
    const backend = fresh();
    (backend as unknown as { state: string }).state = 'ready';
    expect(backend.connectionState()).toStrictEqual({ state: 'ready' });
  });
});

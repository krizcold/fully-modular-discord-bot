import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { hopFailure } from '../../src/webui/routes/hopFailure';
import { readThisNodeId } from '../../src/webui/utils/nodeIdRead';
import { dataPath } from '../../src/utils/dataRoot';
import { FLEET_DIR } from '../../src/bot/internalSetup/fleet/constants';

describe('hopFailure: the cross-machine codes answer their own text', () => {
  it.each([
    ['no-holder', 503, "No machine runs this server's shard right now; nothing was saved. Try again in a moment."],
    ['not-taken', 503, 'The machine that runs this server did not apply the change; nothing was saved. Try again in a moment.'],
    ['insecure-transport', 503, "This machine's database address does not check the database's certificate, so changes to servers other machines run are off; nothing was saved. Set sslmode=verify-full with sslrootcert in DATA_BACKEND_URL."],
    ['answer-too-large', 502, 'The answer from the machine that runs this server is too large to pass between machines.'],
  ])('%s with no detail', (code, status, error) => {
    expect(hopFailure(code)).toEqual({ status, error });
  });

  it.each(['no-holder', 'not-taken', 'insecure-transport', 'answer-too-large'])('%s keeps the detail it was given', code => {
    expect(hopFailure(code, 'D')?.error).toBe('D');
  });
});

describe('readThisNodeId reads /data/global/fleet/node.json', () => {
  const file = dataPath('global', FLEET_DIR, 'node.json');
  const write = (body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  afterEach(() => fs.rmSync(file, { force: true }));

  it('answers the stored id', () => {
    write(JSON.stringify({ nodeId: 'node-abc' }));
    expect(readThisNodeId()).toBe('node-abc');
  });

  it.each([
    ['an empty id', { nodeId: '' }],
    ['a numeric id', { nodeId: 5 }],
    ['an array id', { nodeId: ['x'] }],
    ['an object with a length', { nodeId: { length: 3 } }],
    ['JSON null', null],
  ])('answers null for %s', (_name, body) => {
    write(JSON.stringify(body));
    expect(readThisNodeId()).toBeNull();
  });

  it('answers null with no file', () => {
    expect(readThisNodeId()).toBeNull();
  });
});

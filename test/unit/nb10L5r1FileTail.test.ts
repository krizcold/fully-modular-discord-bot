import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropPendingForGuild, enqueueAppend, enqueueWrite, flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { dataPath } from '../../src/utils/dataRoot';

// NB10 file queue: a write dropped before its flush leaves no stale "ends with a newline" mark behind, so the next
// append to a file changed meanwhile (an older batch restored from the graveyard) starts on its own line.

const GUILD = 'nb10l5r1-guild';
let n = 0;

beforeEach(() => {
  fs.mkdirSync(dataPath(GUILD, 'logs'), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await flushAll();
  vi.restoreAllMocks();
  fs.rmSync(dataPath(GUILD), { recursive: true, force: true });
});

describe('a write dropped before its flush', () => {
  it('the next append after the file changed starts on its own line', async () => {
    const p = dataPath(GUILD, 'logs', `t${++n}.jsonl`);
    enqueueAppend(p, '{"a":1}\n');
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}\n');
    enqueueWrite(p, '{"x":1}\n');
    dropPendingForGuild(GUILD);
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"a":1}\n');
    fs.writeFileSync(p, '{"old":1}');
    enqueueAppend(p, '{"b":1}\n');
    await flushAll();
    expect(fs.readFileSync(p, 'utf8')).toBe('{"old":1}\n{"b":1}\n');
  });
});

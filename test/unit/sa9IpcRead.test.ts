import { describe, expect, it } from 'vitest';
import { applyOperatorDataRead } from '../../src/bot/internalSetup/utils/ipcDataHandler';

// The operator's data read refuses a guild id that is not a Discord id before it reads anything.

describe("the operator's data read", () => {
  it.each([['letters', 'abc'], ['a path', '../123'], ['empty', '']])('a guild id of %s is answered "invalid guildId"', async (_name, guildId) => {
    expect(await applyOperatorDataRead({ guildId, module: '', filename: 'a.json' })).toEqual({ ok: false, code: 'invalid', error: 'invalid guildId' });
  });
});

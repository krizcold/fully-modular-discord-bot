import { describe, expect, it } from 'vitest';

import { RESTORE_TEXTS } from '../../src/bot/internalSetup/utils/dataManager';

// NB16 decision 10: a restore refused on any latch cause says the bot refused the database at boot.
describe('the restore text of a refused database', () => {
  it('names the boot refusal, for every cause', () => {
    expect(RESTORE_TEXTS.schemaMismatch).toBe('this bot refused the database at boot (its log says why); nothing was restored');
  });
});

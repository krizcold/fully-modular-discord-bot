import { describe, expect, it } from 'vitest';
import {
  appendData,
  appendDataTracked,
  DataBackendUnavailableError,
  deleteData,
  deleteDataOutcome,
  deleteDataTracked,
  drainForExit,
  freezeGuildWrites,
  saveData,
  saveDataOutcome,
  saveDataTracked,
} from '@internal/utils/dataManager';
import { dataUnavailableMessage } from '@internal/utils/dataBackends/boot';

// Its own file: the drain closes writes for good in this process.
describe('writes once the exit drain has closed', () => {
  it('refuse first, before the frozen check, with node-stopping, on every facade save, append and delete path', async () => {
    const guildId = '123456789012345678';
    freezeGuildWrites(guildId);
    await drainForExit(200);
    const guild = { guildId, category: 'm' };
    const global = { scope: 'global' as const, category: 'm' };
    const writes: Array<[string, () => unknown]> = [];
    for (const [where, options] of [['guild', guild], ['global', global]] as const) {
      writes.push(
        [`saveDataTracked ${where}`, () => saveDataTracked('a.json', options, { v: 1 })],
        [`saveDataOutcome ${where}`, () => saveDataOutcome('a.json', options, { v: 1 })],
        [`saveData ${where}`, () => saveData('a.json', options, { v: 1 })],
        [`appendDataTracked ${where}`, () => appendDataTracked('a.jsonl', options, 'x\n')],
        [`appendData ${where}`, () => appendData('a.jsonl', options, 'x\n')],
        [`deleteDataTracked ${where}`, () => deleteDataTracked('a.json', options)],
        [`deleteDataOutcome ${where}`, () => deleteDataOutcome('a.json', options)],
        [`deleteData ${where}`, () => deleteData('a.json', options)],
      );
    }
    for (const [name, write] of writes) {
      let thrown: unknown;
      try { write(); } catch (error) { thrown = error; }
      expect(thrown, name).toBeInstanceOf(DataBackendUnavailableError);
      expect((thrown as DataBackendUnavailableError).causeKey, name).toBe('node-stopping');
    }
  });

  it('tells the user the bot is restarting', () => {
    expect(dataUnavailableMessage('node-stopping')).toBe('The bot is restarting, so your change was not saved. Please try again in a moment.');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendData, saveData, saveDataOutcome } from '../../src/bot/internalSetup/utils/dataManager';
import { flushAll } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { operatorRefusalText, truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { getWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { setBackendKind } from '../helpers/backendKind';
import { storeGuild } from '../helpers/gateRig';

// NB12 item 3 (wip-redesign/sheets/NB12.md, decision 13): the member's text for a write the bot cannot store, its
// rank, and the operator's answer naming every refused document.

const inLedger = <T>(ledger: ReturnType<typeof openLedger>, fn: () => T) => runInLedger(ledger, 'mod', fn);
let guilds = 9_200_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the member's text", () => {
  it('says a retry gives the same result, whole or partial', () => {
    expect(truthText('unstorable', false)).toBe("Your change holds content the bot cannot store, so it was not saved. Trying again gives the same result; please report it to the bot's operator.");
    expect(truthText('unstorable', true)).toBe("Your change holds content the bot cannot store, so it was not saved in full. Trying again gives the same result; please report it to the bot's operator.");
  });

  it('ranks first: a response that also met a backlog tells the unstorable text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ledger = openLedger('interaction');
    ledger.noteRefusal('database-backlog', 'mod', 'guild:1:m/a.json');
    const { options } = await storeGuild();
    inLedger(ledger, () => appendData('log.jsonl', options, 'a\u0000\n'));
    const verdict = await verdictOf([ledger]);
    expect(verdict).toMatchObject({ ok: false, answer: 'unstorable', partial: false });
  });
});

describe("the operator's answer", () => {
  it('names the document and the reason, and no member text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { options, guildId } = await storeGuild();
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('cache.tmp/x.json', { guildId }, { v: 1 }));
    const verdict = await verdictOf([ledger]);
    expect(verdict.ok).toBe(false);
    const text = operatorRefusalText(verdict as Exclude<typeof verdict, { ok: true }>);
    expect(text).toBe(`The module's write of guild:${guildId}:/cache.tmp/x.json was refused: the part "cache.tmp" ends in ".tmp", which marks an interrupted write. That write was not saved, and trying again gives the same result; the module's author can change what it stores.`);
    expect(text).not.toContain("report it to the bot's operator");
    expect(options).toBeDefined();
  });

  it('a partial action with an accepted write not landed says the bot answered before all were saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, options, guildId } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('panel');
    inLedger(ledger, () => {
      saveData('settings.json', options, { v: 1 });
      saveData('cache.tmp/x.json', { guildId }, { v: 1 });
    });
    const verdict = await verdictOf([ledger]);
    const text = operatorRefusalText(verdict as Exclude<typeof verdict, { ok: true }>);
    expect(text).toContain('That write was not saved');
    expect(text).toContain("The bot answered before all of the action's accepted writes were saved");
    expect(text).not.toContain('Nothing was saved');
    store.holding = false;
    store.release();
  });

  it('an accepted write that landed is said to be saved (file route)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setBackendKind('file');
    const guildId = String(++guilds);
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('state.json', { guildId, category: 'm' }, { v: 1 }));
    await flushAll();
    inLedger(ledger, () => appendData('log.jsonl', { guildId, category: 'm' }, 'x\uD83D\n'));
    const verdict = await verdictOf([ledger]);
    const text = operatorRefusalText(verdict as Exclude<typeof verdict, { ok: true }>);
    expect(text).toContain('unpaired surrogate (U+D83D)');
    expect(text).toContain("The action's accepted writes were saved.");
    expect(text).not.toMatch(/not confirmed|before all/);
  });

  it('an accepted write that landed is said to be saved (working-set route)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { options, guildId } = await storeGuild();
    const ledger = openLedger('panel');
    inLedger(ledger, () => saveData('state.json', options, { v: 1 }));
    expect(await getWorkingSet()!.flushGuildNow(guildId, 1000)).toBe('ok');
    inLedger(ledger, () => appendData('log.jsonl', options, 'x\uD83D\n'));
    const text = operatorRefusalText(await verdictOf([ledger]) as never);
    expect(text).toContain('unpaired surrogate (U+D83D)');
    expect(text).toContain("The action's accepted writes were saved.");
    expect(text).not.toMatch(/not confirmed|before all/);
  });

  it('names every refused document, each with its reason or cause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, options, guildId } = await storeGuild();
    store.holding = true;
    const ledger = openLedger('console');
    inLedger(ledger, () => {
      appendData('log.jsonl', options, 'a\u0000\n');
      saveDataOutcome('cfg.json', options, { n: 1n });
      saveData('state.json', options, { v: 1 });
    });
    ledger.noteRefusal('database-backlog', 'mod', `guild:${guildId}:m/other.json`);
    const text = operatorRefusalText(await verdictOf([ledger]) as never);
    expect(text).toMatch(new RegExp(`^The module's write of guild:${guildId}:m/log\\.jsonl was refused: it holds U\\+0000 at character 1`));
    expect(text).toContain(`The write of guild:${guildId}:m/cfg.json was also refused: the value cannot be written as JSON`);
    expect(text).toContain(`The write of guild:${guildId}:m/other.json was also refused: database-backlog.`);
    expect(text).toContain("The bot answered before all of the action's accepted writes were saved");
    expect(text).not.toContain('other writes were accepted');
    store.holding = false;
    store.release();
  });

  it('an action with no accepted write has no accepted-writes sentence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { options } = await storeGuild();
    const ledger = openLedger('console');
    inLedger(ledger, () => appendData('log.jsonl', options, 'a\u0000\n'));
    const text = operatorRefusalText(await verdictOf([ledger]) as never);
    expect(text).not.toMatch(/accepted writes/);
  });
});

import { describe, expect, it } from 'vitest';
import { truthText } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { rowTimeoutText, t39Cause } from '../../src/bot/internalSetup/utils/sharedStore';
import { heldClauses } from '../../src/bot/internalSetup/utils/heldWords';
import { sharedStartingText } from '../../src/bot/internalSetup/utils/sharedOps';

// NB6 test 44 (wip-redesign/sheets/NB6.md, C4's T35 and D8): the texts each part builds. Part 5: T35's key forms, the
// flush's log when a statement of a row op passes its bound or is cancelled before it.

describe('T35, the key forms', () => {
  it('at the bound', () => {
    expect(rowTimeoutText('global/premium-tiers.json', { bytes: 4 * 1024 * 1024 + 1, elapsedMs: 671_000, boundMs: 671_000, atBound: true })).toBe(
      '[Shared] Saving global/premium-tiers.json: a statement of 4097 KiB did not finish within the 671 s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this (this machine tries again)',
    );
  });

  it('before the bound', () => {
    expect(rowTimeoutText('config.json', { bytes: 2048, elapsedMs: 1234, boundMs: 30_000, atBound: false })).toBe(
      '[Shared] Saving config.json: a statement of 2 KiB was cancelled after 1.2 s, before the 30 s bound (SQLSTATE 57014); a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way (this machine tries again)',
    );
  });
});

// Part 14: T35's module forms (D8), logged by publishModule and unpublishModule; the job ends.
describe('T35, the module forms', () => {
  const at = { bytes: 4 * 1024 * 1024, elapsedMs: 671_000, boundMs: 671_000, atBound: true };
  const before = { bytes: 3000, elapsedMs: 2500, boundMs: 31_000, atBound: false };

  it.each(['install', 'update', 'uninstall'] as const)('at the bound, %s', async operation => {
    const { moduleTimeoutText } = await import('../../src/bot/internalSetup/utils/sharedModules');
    expect(moduleTimeoutText('welcome', operation, at)).toBe(
      `[Shared] Saving module welcome: a statement of 4096 KiB did not finish within the 671 s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this. Nothing was saved, and the ${operation} of welcome ended.`,
    );
  });

  it.each(['install', 'update', 'uninstall'] as const)('before the bound, %s', async operation => {
    const { moduleTimeoutText } = await import('../../src/bot/internalSetup/utils/sharedModules');
    expect(moduleTimeoutText('welcome', operation, before)).toBe(
      `[Shared] Saving module welcome: a statement of 3 KiB was cancelled after 2.5 s, before the 31 s bound (SQLSTATE 57014); a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way. Nothing was saved, and the ${operation} of welcome ended.`,
    );
  });

  it("the <cause> form a publish's refusal carries", async () => {
    const { moduleTimeoutCause } = await import('../../src/bot/internalSetup/utils/sharedModules');
    expect(moduleTimeoutCause(at)).toBe('a statement of 4096 KiB did not finish within the 671 s bound (SQLSTATE 57014)');
  });
});

// Part 6: T22, the reply to a change another machine (or this one) made after the refused change read the data.
describe('T22', () => {
  const at = new Date('2026-11-07T11:30:00.000Z');
  it.each([
    [{ machine: 'BRAVO', at }, false, 'This data was changed on BRAVO at 2026-11-07T11:30:00.000Z after your change read it, so your change was not saved. Reload to see the current values, then try again.'],
    [{ machine: 'BRAVO', at }, true, 'This data was changed on BRAVO at 2026-11-07T11:30:00.000Z after your change read it, so your change was not saved in full. Reload to see the current values, then try again.'],
    [{ machine: null, at }, false, 'This data was changed on this machine at 2026-11-07T11:30:00.000Z after your change read it, so your change was not saved. Reload to see the current values, then try again.'],
    ['deleted' as const, false, 'This data was deleted after your change read it, so your change was not saved. Reload to see the current values, then try again.'],
    ['deleted' as const, true, 'This data was deleted after your change read it, so your change was not saved in full. Reload to see the current values, then try again.'],
  ])('%o, partial %s', (changed, partial, expected) => {
    expect(truthText('changed-elsewhere', partial, changed)).toBe(expected);
  });
});

// Part 7: T36, the held clause of row ops holding a save the database did not answer (C6).
describe('T36', () => {
  it('alone', () => {
    expect(heldClauses({ unansweredFiles: 2 })).toBe('2 file(s) hold a save the database did not answer, which may have landed');
  });

  it("after the guilds' clause, before the unconfirmed lines; absent at 0", () => {
    expect(heldClauses({ unansweredGuilds: 1, unansweredFiles: 1, unconfirmedFiles: 1 })).toBe(
      "1 guild(s) hold a save the database did not answer, which may have landed; 1 file(s) hold a save the database did not answer, which may have landed; 1 file(s) hold changes the disk did not confirm; can't confirm whether they are stored",
    );
    expect(heldClauses({ unsavedFiles: 1, unansweredFiles: 0 })).toBe('0 guild(s) and 1 file(s) hold changes that could not be saved');
  });
});

// Part 9: T38, the child's answer to shared:op and data:global-read before bootShared ended (C24, D9).
describe('T38', () => {
  it.each([
    ['shared:op' as const, null, 'The bot is starting and is bringing the shared files up to date from the database; nothing was saved. Try again in a moment.'],
    ['data:global-read' as const, null, 'The bot is starting and is bringing the shared files up to date from the database. Try again in a moment.'],
    ['shared:op' as const, 'connect ECONNREFUSED 10.0.0.5:5432', 'The bot is waiting for the database (connect ECONNREFUSED 10.0.0.5:5432) before it brings the shared files up to date; nothing was saved. Try again once the database answers.'],
    ['data:global-read' as const, 'connect ECONNREFUSED 10.0.0.5:5432', 'The bot is waiting for the database (connect ECONNREFUSED 10.0.0.5:5432) before it brings the shared files up to date. Try again once the database answers.'],
  ])('%s, cause %s', (type, cause, expected) => {
    expect(sharedStartingText(type, cause)).toBe(expected);
  });
});

// Part 10: T39, the <cause> of a web UI row op the checks refuse (C22, D7), with NB5's reasons.
describe('T39', () => {
  it.each([
    [{ refusal: 'the bot process is starting; try again once it has started', held: false }, "the web panel cannot use the bot's main database now: the bot process is starting; try again once it has started"],
    [{ refusal: 'choosing the main database', held: false }, "the web panel cannot use the bot's main database now: choosing the main database"],
    [{ refusal: 'a check of the databases made now picks w.example:5432/bot, while the bot process uses a.example:5432/bot', held: false }, "the web panel cannot use the bot's main database now: a check of the databases made now picks w.example:5432/bot, while the bot process uses a.example:5432/bot"],
    [{ refusal: 'the bot process reported a change of its database during the check', held: false }, "the web panel cannot use the bot's main database now: the bot process reported a change of its database during the check"],
    [{ refusal: 'R', held: true }, "the bot process is still confirming the bot's main database: R"],
  ])('%o', (refusal, expected) => {
    expect(t39Cause(refusal)).toBe(expected);
  });
});

// Part 16: T37 (C16 as D10 words it) and T18 (61, 65, 77, 104, 109), the publishing caller's answers.
describe('T37', () => {
  it.each([
    ['install' as const, "m 1.2.0 was installed. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart."],
    ['update' as const, "m 1.2.0 was updated. This machine's bot process stopped serving its shards and restarts; it tries to load the module after that restart."],
    ['uninstall' as const, "m was uninstalled. This machine's bot process stopped serving its shards and restarts; it tries to remove the module's files after that restart."],
  ])('%s', async (operation, expected) => {
    const { stoppedServingText } = await import('../../src/bot/internalSetup/utils/moduleApply');
    expect(stoppedServingText(operation, 'm', '1.2.0')).toBe(expected);
  });
});

describe('T18', () => {
  const deferred = (reason: string, extra: Record<string, unknown> = {}) => ({ outcome: reason === 'busy' ? 'busy' : 'deferred', reason, error: null, loaded: false, ...extra }) as never;
  it.each([
    ['update', deferred('busy'), 'm 1.2.0 was updated. This machine applies it at its next pass (another App Store change was still running on this machine).'],
    ['install', deferred('reload'), 'm 1.2.0 was installed. This machine applies it at its next pass (a reload of m was still running).'],
    ['update', deferred('changed'), "m 1.2.0 was updated. This machine applies the database's current version of m at its next pass (the database's version changed while it was being applied)."],
    ['update', deferred('main-changed'), "m 1.2.0 was updated. This machine applies the database's current version of m at its next pass (the main database changed)."],
    ['update', deferred('starting', { state: 'a' }), "m 1.2.0 was updated. This machine applies the database's current version of m at the first pass after it finishes starting m (its start-up code is still running, and the bot waits for it for at most 10 minutes after it began)."],
    ['update', deferred('starting', { state: 'c' }), "m 1.2.0 was updated. This machine applies the database's current version of m at the first pass after it finishes starting m (its start-up code runs once the bot has connected to Discord, loaded its data and started the modules before it, and the bot waits for it for at most 10 minutes)."],
    ['install', deferred('starting', { state: 'd' }), "m 1.2.0 was installed. This machine applies the database's current version of m at the first pass after it finishes starting m (it is loading m right now)."],
    ['update', deferred('starting', { state: 'e' }), "m 1.2.0 was updated. Finishing the last change of m failed on this machine (see the bot's log), so it applies the database's current version of m after the bot's next start."],
    ['update', deferred('starting', { state: 'f' }), "m 1.2.0 was updated. This machine is still finishing its last change of m; it applies the database's current version of m at the first pass after that finishes, or after the bot's next start if finishing fails."],
    ['uninstall', deferred('busy'), 'm was uninstalled. This machine removes its files at its next pass (another App Store change was still running on this machine).'],
    ['uninstall', deferred('main-changed'), 'm was uninstalled. This machine removes its files at its next pass (the main database changed).'],
    ['update', deferred('maintenance'), null],
    ['update', deferred('stopped-serving'), null],
  ])('%s %o', async (operation, result, expected) => {
    const { deferredText } = await import('../../src/bot/internalSetup/utils/moduleApply');
    expect(deferredText(operation as 'install' | 'update' | 'uninstall', 'm', '1.2.0', result)).toBe(expected);
  });
});

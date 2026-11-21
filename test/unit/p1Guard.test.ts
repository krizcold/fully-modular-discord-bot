import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowDropLines } from '../helpers/p1Guard';

// P1 claim 23: the log guard of helpers/setup.ts fails a row during which premium says it left stored entries out
// (L1), dropped an event that names no holder (L2) or did not install a created event (L3), unless the row opted in.
// The rows marked `fails` pass only when the guard failed them.

const L1 = '[PremiumManager] premium-tiers.json holds entries this version does not read: 2 subscription record(s) not keyed by a holder, 0 paid subscription(s) with no buyer, 1 provider account link(s), 1 price-change decision(s). They are not loaded, and the next premium save writes the file without them.';
const L2 = '[PremiumManager] A subscription.renewed event from fake (subscription ps1) names no holder; it was not applied: {"type":"subscription.renewed"}';
const L3 = "[PremiumManager] subscription.created from Fake (subscription ps1, guild 70000000000000001) was not installed: it names no buyer";

const INSTALL_FAILED = '[PremiumManager] installAsyncSubscription failed:';

const swallow = (method: 'log' | 'warn' | 'error') => vi.spyOn(console, method).mockImplementation(() => undefined);

afterEach(() => { vi.restoreAllMocks(); });

describe('a row that logs a drop line without opting in fails', () => {
  it.fails('L1 through a spy that swallows it', () => {
    swallow('warn');
    console.warn(L1);
  });

  it.fails("setFullConfig's line through a spy that swallows it", () => {
    swallow('warn');
    console.warn('[PremiumManager] The configuration given to setFullConfig holds entries this version does not read: 1 subscription record(s) not keyed by a holder, 0 paid subscription(s) with no buyer, 0 provider account link(s), 0 price-change decision(s). They are left out of what is saved.');
  });

  it.fails('L2 through a spy that swallows it', () => {
    swallow('error');
    console.error(L2);
  });

  it.fails('L3 through a spy that swallows it', () => {
    swallow('warn');
    console.warn(L3);
  });

  it.fails('L1 through a spy that lets it through to a second spy', () => {
    const inner = swallow('log');
    vi.spyOn(console, 'log');
    console.log(L1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.fails('L1 through a method the row replaced by hand', () => {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try { console.warn(L1); } finally { console.warn = original; }
    expect(lines).toEqual([L1]);
  });

  it.fails('L1 whose spy the row cleared and restored before it ended', () => {
    const spy = swallow('warn');
    console.warn(L1);
    spy.mockClear();
    spy.mockRestore();
  });

  it.fails('L2 handed to console in two arguments', () => {
    swallow('error');
    console.error('[PremiumManager] A subscription.renewed event from fake (subscription ps1) names no holder; it was not applied:', '{}');
  });

  it.fails('a failed install through a spy that swallows it', () => {
    swallow('error');
    console.error(INSTALL_FAILED, new TypeError("Cannot read properties of undefined (reading 'includes')"));
  });

  it.fails('a failed install when the row opted in to L1 to L3 without naming them', () => {
    swallow('error');
    allowDropLines();
    console.error(INSTALL_FAILED, new Error('boom'));
  });

  it('a failed install the row opted in to by name passes', () => {
    const error = swallow('error');
    allowDropLines('install');
    console.error(INSTALL_FAILED, new Error('boom'));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.fails('L1 when the row opted in to L2 only', () => {
    swallow('warn');
    allowDropLines('L2');
    console.warn(L1);
  });

  it('a row that opted in passes', () => {
    const warn = swallow('warn');
    allowDropLines();
    console.warn(L1);
    console.warn(L2);
    console.warn(L3);
    expect(warn.mock.calls.map(c => c[0])).toEqual([L1, L2, L3]);
  });

  it.fails('the opt-in ends with its row', () => {
    swallow('warn');
    console.warn(L1);
  });
});

describe('a row that logs none of them passes', () => {
  it('lines that only resemble them', () => {
    const error = swallow('error');
    console.error('[PremiumManager] A subscription.created event from hook (subscription h1, guild 70000000000000005) was not applied: the bot is stopping; it is lost: {}');
    console.error('[PremiumManager] subscription.created for unknown tier \'nope\' (provider=fake, sub=ps1)');
    console.error(`note: ${L1}`);
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('a spy on console still reads as that spy', () => {
    const warn = swallow('warn');
    console.warn('one', 2);
    expect(console.warn).toHaveBeenCalledWith('one', 2);
    expect(vi.isMockFunction(console.warn)).toBe(true);
    expect(warn.mock.calls).toEqual([['one', 2]]);
    warn.mockRestore();
    expect(vi.isMockFunction(console.warn)).toBe(false);
  });

  it('a method replaced by hand and put back is the one it was', () => {
    const original = console.info;
    const lines: unknown[][] = [];
    console.info = (...args: unknown[]) => { lines.push(args); };
    console.info('a', 'b');
    console.info = original;
    expect(lines).toEqual([['a', 'b']]);
    expect(console.info).toBe(original);
  });
});

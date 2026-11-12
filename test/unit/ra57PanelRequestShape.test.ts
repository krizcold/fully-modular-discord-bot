import { describe, expect, it } from 'vitest';
import { bodyRefusal, MAX_MEMBERSHIP_IDS } from '../../src/bot/internalSetup/utils/panelRequestShape';

const owner = { via: 'owner', userId: 'web-ui-owner' };
const CH = '123456789012345678';
const GUILD = '123456789012345678';

const invoke = (extra: Record<string, unknown>) => bodyRefusal('command:invoke', { actor: owner, command: 'ping', channelId: CH, ...extra });
const live = (extra: Record<string, unknown>) => bodyRefusal('panel:live', { actor: owner, panelId: 'p1', ...extra });
const membership = (ids: unknown) => bodyRefusal('guild:membership', { actor: owner, ids });

describe('ra57 command invoke command name', () => {
  it('accepts a plain command name with letters, digits, underscore and hyphen', () => {
    expect(invoke({})).toBeNull();
    expect(invoke({ command: 'my-cmd_2' })).toBeNull();
    expect(invoke({ command: 'a'.repeat(64) })).toBeNull();
  });

  it('refuses a command name with a bad character at the start', () => {
    expect(invoke({ command: '.ping' })).toBe('the command name is not valid');
    expect(invoke({ command: 'a b' })).toBe('the command name is not valid');
  });

  it('refuses a command name with a bad character at the end or one too long', () => {
    expect(invoke({ command: 'ping.' })).toBe('the command name is not valid');
    expect(invoke({ command: 'a'.repeat(65) })).toBe('the command name is not valid');
  });

  it('refuses a missing or non string command name', () => {
    expect(invoke({ command: undefined })).toBe('the command name is not valid');
    expect(invoke({ command: 5 })).toBe('the command name is not valid');
  });
});

describe('ra57 command invoke options', () => {
  it('accepts absent options and a plain object', () => {
    expect(invoke({ options: undefined })).toBeNull();
    expect(invoke({ options: { a: 1 } })).toBeNull();
  });

  it('refuses options that are a string or a number', () => {
    expect(invoke({ options: 'x' })).toBe('the options are not valid');
    expect(invoke({ options: 3 })).toBe('the options are not valid');
  });

  it('refuses null options', () => {
    expect(invoke({ options: null })).toBe('the options are not valid');
  });

  it('refuses array options', () => {
    expect(invoke({ options: [] })).toBe('the options are not valid');
  });
});

describe('ra57 command invoke channel and force', () => {
  it('refuses a channel id that is not a snowflake', () => {
    expect(invoke({ channelId: 'abc' })).toBe('the channel id is not valid');
    expect(invoke({ channelId: '123' })).toBe('the channel id is not valid');
  });

  it('accepts an absent channel id', () => {
    expect(invoke({ channelId: undefined })).toBeNull();
  });

  it('accepts force true, force false and no force', () => {
    expect(invoke({ force: true })).toBeNull();
    expect(invoke({ force: false })).toBeNull();
    expect(invoke({ force: undefined })).toBeNull();
  });

  it('refuses a force that is not a boolean', () => {
    expect(invoke({ force: 'yes' })).toBe('force is not valid');
    expect(invoke({ force: 1 })).toBe('force is not valid');
  });
});

describe('ra57 panel live', () => {
  it('refuses a bad panel id', () => {
    expect(live({ panelId: 'bad id' })).toBe('the panel id is not valid');
    expect(live({ panelId: undefined })).toBe('the panel id is not valid');
  });

  it('accepts a finite number, null or no since', () => {
    expect(live({ haveSince: 1700000000000 })).toBeNull();
    expect(live({ haveSince: null })).toBeNull();
    expect(live({})).toBeNull();
  });

  it('refuses a since that is a string', () => {
    expect(live({ haveSince: '5' })).toBe('the since is not valid');
  });

  it('refuses a since that is NaN or infinite', () => {
    expect(live({ haveSince: Number.NaN })).toBe('the since is not valid');
    expect(live({ haveSince: Number.POSITIVE_INFINITY })).toBe('the since is not valid');
  });
});

describe('ra57 guild membership ids', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(100000 + i));

  it('accepts one id and exactly the most ids allowed', () => {
    expect(MAX_MEMBERSHIP_IDS).toBe(100);
    expect(membership([GUILD])).toBeNull();
    expect(membership(ids(MAX_MEMBERSHIP_IDS))).toBeNull();
  });

  it('refuses ids that are missing or not an array', () => {
    expect(membership(undefined)).toBe('the server ids are not valid');
    expect(membership(GUILD)).toBe('the server ids are not valid');
  });

  it('refuses an empty id list', () => {
    expect(membership([])).toBe('the server ids are not valid');
  });

  it('refuses one id more than allowed', () => {
    expect(membership(ids(MAX_MEMBERSHIP_IDS + 1))).toBe('the server ids are not valid');
  });

  it('refuses a list where only some ids are valid', () => {
    expect(membership([GUILD, 'abc'])).toBe('the server ids are not valid');
    expect(membership(['abc'])).toBe('the server ids are not valid');
  });
});

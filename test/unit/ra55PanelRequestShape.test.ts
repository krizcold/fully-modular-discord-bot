import { describe, expect, it } from 'vitest';

import {
  bodyRefusal,
  isSnowflake,
  validChannelId,
  validDropdownValues,
  validGuildId,
  validInteractionId,
  validPanelId,
} from '../../src/bot/internalSetup/utils/panelRequestShape';

const owner = { via: 'owner', userId: 'web-ui-owner' };
const SNOW = '123456789012345678';

describe('panel id', () => {
  it('refuses a panel id that is not a string or holds a bad character anywhere', () => {
    expect(validPanelId(42)).toBe(false);
    expect(validPanelId('bad id')).toBe(false);
    expect(validPanelId(' lead')).toBe(false);
    expect(validPanelId('trail ')).toBe(false);
    expect(validPanelId('ok.panel_1-x')).toBe(true);
    expect(bodyRefusal('panel:execute', { actor: owner, panelId: '../etc' })).toBe('the panel id is not valid');
    expect(bodyRefusal('panel:execute', { actor: owner, panelId: 'a/b' })).toBe('the panel id is not valid');
  });

  it('takes a panel id of 99 characters and refuses one of 100', () => {
    expect(validPanelId('p'.repeat(99))).toBe(true);
    expect(validPanelId('p'.repeat(100))).toBe(false);
    expect(bodyRefusal('panel:live', { actor: owner, panelId: 'p'.repeat(100) })).toBe('the panel id is not valid');
  });
});

describe('interaction id', () => {
  it('refuses a non-string id and one with a bad character at either end', () => {
    expect(validInteractionId(7)).toBe(false);
    expect(validInteractionId(' btn')).toBe(false);
    expect(validInteractionId('btn ')).toBe(false);
    expect(validInteractionId('a:b/c-d.e_f')).toBe(true);
    expect(bodyRefusal('panel:button', { actor: owner, panelId: 'p', buttonId: 'x y' })).toBe('the button id is not valid');
  });

  it('takes ids longer than one character up to 199 and refuses 200', () => {
    expect(validInteractionId('ab')).toBe(true);
    expect(validInteractionId('b'.repeat(199))).toBe(true);
    expect(validInteractionId('b'.repeat(200))).toBe(false);
    expect(bodyRefusal('panel:modal', { actor: owner, panelId: 'p', modalId: 'm'.repeat(200), fields: {} })).toBe('the modal id is not valid');
    expect(bodyRefusal('panel:modal', { actor: owner, panelId: 'p', modalId: 'mm', fields: {} })).toBeNull();
  });
});

describe('snowflake', () => {
  it('refuses digits wrapped in other characters', () => {
    expect(isSnowflake(SNOW)).toBe(true);
    expect(isSnowflake('x' + SNOW)).toBe(false);
    expect(isSnowflake(SNOW + 'x')).toBe(false);
    expect(bodyRefusal('panel:execute', { actor: { via: 'member', userId: 'u' + SNOW }, panelId: 'p' })).toBe("the actor's user id is not valid");
  });
});

describe('channel id', () => {
  it('takes no channel (undefined, null, empty) or a snowflake, and refuses anything else', () => {
    expect(validChannelId(undefined)).toBe(true);
    expect(validChannelId(null)).toBe(true);
    expect(validChannelId('')).toBe(true);
    expect(validChannelId(SNOW)).toBe(true);
    expect(validChannelId('general')).toBe(false);
    expect(validChannelId('Stryker was here!')).toBe(false);
    expect(validChannelId(5)).toBe(false);
    expect(bodyRefusal('panel:execute', { actor: owner, panelId: 'p', channelId: null })).toBeNull();
    expect(bodyRefusal('panel:execute', { actor: owner, panelId: 'p', channelId: '' })).toBeNull();
    expect(bodyRefusal('command:invoke', { actor: owner, command: 'ping', channelId: 'general' })).toBe('the channel id is not valid');
  });
});

describe('guild id', () => {
  it('refuses digits wrapped in other characters', () => {
    expect(validGuildId('12345')).toBe(true);
    expect(validGuildId('a12345')).toBe(false);
    expect(validGuildId('12345a')).toBe(false);
    expect(bodyRefusal('guild:membership', { actor: owner, ids: ['g12345'] })).toBe('the server ids are not valid');
    expect(bodyRefusal('guild:membership', { actor: owner, ids: ['12345g'] })).toBe('the server ids are not valid');
  });

  it('takes the largest bigint and refuses one above it', () => {
    expect(validGuildId('9223372036854775807')).toBe(true);
    expect(validGuildId('9223372036854775808')).toBe(false);
    expect(bodyRefusal('guild:membership', { actor: owner, ids: ['9223372036854775807'] })).toBeNull();
  });
});

describe('dropdown values', () => {
  it('refuses a value that is not an array', () => {
    expect(validDropdownValues('a')).toBe(false);
    expect(validDropdownValues({ length: 1, 0: 'a' })).toBe(false);
    expect(bodyRefusal('panel:dropdown', { actor: owner, panelId: 'p', values: 'a' })).toBe('the dropdown values are not valid');
  });

  it('takes 25 values and refuses 26', () => {
    expect(validDropdownValues(Array.from({ length: 25 }, (_, i) => 'v' + i))).toBe(true);
    expect(validDropdownValues(Array.from({ length: 26 }, (_, i) => 'v' + i))).toBe(false);
  });

  it('refuses the list when any one value is not a string or is 100 characters long', () => {
    expect(validDropdownValues(['a', 'b'.repeat(99)])).toBe(true);
    expect(validDropdownValues(['a', 'b'.repeat(100)])).toBe(false);
    expect(validDropdownValues(['b'.repeat(100)])).toBe(false);
    expect(validDropdownValues([['a']])).toBe(false);
    expect(validDropdownValues(['a', 7])).toBe(false);
    expect(bodyRefusal('panel:dropdown', { actor: owner, panelId: 'p', values: ['ok', 'b'.repeat(100)] })).toBe('the dropdown values are not valid');
  });
});

import { describe, expect, it } from 'vitest';
import { actorRefusal, bodyRefusal, type PanelRequestOp } from '../../src/bot/internalSetup/utils/panelRequestShape';

const owner = { via: 'owner', userId: 'web-ui-owner' };
const CH = '123456789012345678';

function refusal(op: PanelRequestOp, extra: Record<string, unknown>): string | null {
  return bodyRefusal(op, { actor: owner, panelId: 'p1', channelId: CH, ...extra });
}

const dropdown = (extra: Record<string, unknown>) => refusal('panel:dropdown', { values: ['a'], ...extra });
const modal = (extra: Record<string, unknown>) => refusal('panel:modal', { modalId: 'm1', fields: {}, ...extra });

describe('ra56 owner actor user ids', () => {
  it('accepts an owner user id of 5 to 20 digits that is not a snowflake', () => {
    expect(actorRefusal('panel:execute', { via: 'owner', userId: '12345' })).toBeNull();
    expect(actorRefusal('panel:execute', { via: 'owner', userId: '12345678901234567890' })).toBeNull();
  });

  it('refuses an owner user id with text before or after the digits', () => {
    expect(actorRefusal('panel:execute', { via: 'owner', userId: 'a12345' })).toBe("the actor's user id is not valid");
    expect(actorRefusal('panel:execute', { via: 'owner', userId: '12345a' })).toBe("the actor's user id is not valid");
    expect(actorRefusal('panel:execute', { via: 'owner', userId: 'abcde' })).toBe("the actor's user id is not valid");
    expect(actorRefusal('panel:execute', { via: 'owner', userId: '1234' })).toBe("the actor's user id is not valid");
  });
});

describe('ra56 panel action bodies', () => {
  it('accepts a well formed body for each panel op', () => {
    expect(refusal('panel:execute', {})).toBeNull();
    expect(refusal('panel:button', { buttonId: 'b1' })).toBeNull();
    expect(dropdown({})).toBeNull();
    expect(modal({})).toBeNull();
  });

  it('refuses a bad panel id with its text', () => {
    expect(refusal('panel:execute', { panelId: 'bad id!' })).toBe('the panel id is not valid');
  });

  it('refuses a bad channel id with its text', () => {
    expect(refusal('panel:execute', { channelId: 'abc' })).toBe('the channel id is not valid');
  });

  it('refuses a bad button id with its text', () => {
    expect(refusal('panel:button', { buttonId: 'bad id!' })).toBe('the button id is not valid');
  });

  it('refuses dropdown values that are not valid with their text', () => {
    expect(dropdown({ values: 'a' })).toBe('the dropdown values are not valid');
    expect(dropdown({ values: ['x'.repeat(100)] })).toBe('the dropdown values are not valid');
    expect(dropdown({ values: ['x'.repeat(99)] })).toBeNull();
  });

  it('checks a dropdown id only when one is given', () => {
    expect(dropdown({ dropdownId: undefined })).toBeNull();
    expect(dropdown({ dropdownId: null })).toBeNull();
    expect(dropdown({ dropdownId: 'd1' })).toBeNull();
    expect(dropdown({ dropdownId: 'bad id!' })).toBe('the dropdown id is not valid');
  });

  it('refuses a bad modal id with its text', () => {
    expect(modal({ modalId: 'bad id!' })).toBe('the modal id is not valid');
    expect(modal({ modalId: undefined })).toBe('the modal id is not valid');
  });

  it('refuses modal fields that are not a plain object with their text', () => {
    for (const fields of [null, undefined, 'text', 5, true, ['a']]) {
      expect(modal({ fields })).toBe('the modal fields are not valid');
    }
  });
});

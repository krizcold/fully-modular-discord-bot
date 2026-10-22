import { beforeEach, describe, expect, it, vi } from 'vitest';

// R17-J11: an Edit modal over Discord's 4000-character limit is refused by Discord, so both config editors answer
// "too large to edit here" instead, and the view's truncation hint points to Download when Edit cannot hold the file.
const props = vi.hoisted(() => ({ current: {} as Record<string, { value: unknown; isSet: boolean; source?: string }> }));

vi.mock('../../src/bot/internalSetup/utils/configDiscovery', () => ({
  discoverConfigFiles: () => [{ id: 'big', name: 'Big', category: 'config' }],
  discoverGuildConfigFiles: () => [{ id: 'big', name: 'Big', category: 'config' }],
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', () => ({
  getMergedConfig: () => ({ properties: props.current }),
  loadGlobalConfig: () => ({ a: 1 }),
  loadGuildConfig: () => ({ a: 1 }),
  saveGlobalConfig: () => 'saved',
  saveGuildConfig: () => 'saved',
}));

import globalPanel from '../../src/bot/internalSetup/panels/configEditorGlobalPanel';
import guildPanel from '../../src/bot/internalSetup/panels/configEditorGuildPanel';

const context = () => ({ guildId: 'g1', userId: 'u1', data: {} }) as any;
const text = (response: any) => JSON.stringify(response);

const panels = [
  ['global', globalPanel],
  ['guild', guildPanel],
] as const;

describe.each(panels)('%s config editor, the Edit modal bound', (_name, panel) => {
  beforeEach(() => {
    props.current = {};
  });

  it('a value over 4000 characters answers too large instead of building a modal', async () => {
    props.current = { a: { value: 'x'.repeat(4100), isSet: true } };
    const response: any = await panel.handleButton!(context(), 'edit_big');
    expect(response.modal).toBeUndefined();
    expect(text(response)).toContain('too large to edit here');
    expect(text(response)).toContain('Download');
  });

  it('a value within 4000 characters still builds the modal', async () => {
    props.current = { a: { value: 'x'.repeat(100), isSet: true } };
    const response: any = await panel.handleButton!(context(), 'edit_big');
    expect(response.modal).toBeDefined();
  });

  it('the view truncation hint names Download when Edit cannot hold the file', async () => {
    props.current = { a: { value: 'x'.repeat(4100), isSet: true } };
    const response = await panel.handleButton!(context(), 'select_big');
    expect(text(response)).toContain('truncated');
    expect(text(response)).not.toContain('use Edit to see all');
    expect(text(response)).toContain('Download');
  });

  it('the view truncation hint names Edit when Edit can hold the file', async () => {
    props.current = { a: { value: 'x'.repeat(2000), isSet: true } };
    const response = await panel.handleButton!(context(), 'select_big');
    expect(text(response)).toContain('use Edit to see all');
  });
});

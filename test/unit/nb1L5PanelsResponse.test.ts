import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  get: vi.fn(),
  stamp: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../../src/bot/internalSetup/utils/panel/persistentPanelStorage', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPersistentPanel: fx.get,
  updatePersistentPanelState: fx.stamp,
  recordPersistentPanelResponse: fx.record,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', async importOriginal => ({
  ...(await importOriginal<object>()),
  answerWrites: async () => true,
}));

import {
  handlePersistentPanelButton,
  handlePersistentPanelModal,
  updatePersistentPanel,
} from '../../src/bot/internalSetup/utils/panel/persistentPanelResponse';

const instance = { messageId: 'm1', channelId: 'c1', userId: 'u1', createdAt: 0, lastUpdated: 0, state: 'a' };
const client = { channels: { fetch: async () => ({ isTextBased: () => true, messages: { edit: async () => ({}) } }) } } as never;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fx.get.mockResolvedValue(instance);
  fx.stamp.mockResolvedValue(true);
  fx.record.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('updatePersistentPanel reports whether the panel holds the result', () => {
  it('returns false when the state stamp fails although the response was recorded', async () => {
    fx.stamp.mockResolvedValue(false);
    expect(await updatePersistentPanel(client, 'p1', { content: 'v' } as never, undefined, undefined, 'next')).toBe(false);
  });

  it('returns true when both are saved', async () => {
    expect(await updatePersistentPanel(client, 'p1', { content: 'v' } as never, undefined, undefined, 'next')).toBe(true);
  });
});

describe('a persistent panel handler whose result the panel does not hold logs it', () => {
  const context = { client, interaction: { message: { id: 'other' } }, guildId: null, userId: 'u1', navigationStack: [] } as never;

  it('for a button', async () => {
    const panel = { id: 'p-btn', persistent: true, handleButton: async () => ({ content: 'v' }) } as never;
    await handlePersistentPanelButton(context, panel, 'b');
    expect(vi.mocked(console.error).mock.calls.some(c => String(c[0]).includes('Panel p-btn does not hold this result'))).toBe(true);
  });

  it('for a modal', async () => {
    const panel = { id: 'p-modal', persistent: true, handleModal: async () => ({ content: 'v' }) } as never;
    await handlePersistentPanelModal(context, panel, 'x');
    expect(vi.mocked(console.error).mock.calls.some(c => String(c[0]).includes("Panel p-modal does not hold this modal's result"))).toBe(true);
  });
});

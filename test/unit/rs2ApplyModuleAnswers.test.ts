import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotManager, type ModuleApplyAnswer } from '../../src/webui/botManager';
import type { PublishedChange } from '../../src/bot/internalSetup/utils/appStoreManager';
import { STOPPED_SERVING_TEXT } from '../../src/bot/internalSetup/utils/servingGate';

interface FakeBot {
  running: boolean;
  botProcess: object | null;
  stage: Promise<void>;
  reply: () => Promise<unknown>;
  sent: { type: string; data: any; timeout: number }[];
}

function fakeBot(over: Partial<FakeBot> = {}): FakeBot {
  return { running: true, botProcess: {}, stage: Promise.resolve(), reply: async () => undefined, sent: [], ...over };
}

function apply(bot: FakeBot, change: PublishedChange): Promise<ModuleApplyAnswer> {
  const self = {
    isRunning: () => bot.running,
    get botProcess() { return bot.botProcess; },
    whenStage: () => bot.stage,
    sendIPCMessage: (type: string, data: any, timeout: number) => {
      bot.sent.push({ type, data, timeout });
      return bot.reply();
    },
  };
  return BotManager.prototype.applyModule.call(self as unknown as BotManager, change);
}

const install = (over: Partial<PublishedChange> = {}): PublishedChange => ({
  module: 'm', operation: 'install', version: '1.0.0', to: 'abc', tag: '1:ALPHA', updatedBy: 'web', staged: null, applied: null, ...over,
} as PublishedChange);

const NOT_RUNNING = "m 1.0.0 was installed. This machine's bot is not running, so it applies the module when it next starts normally.";
const NO_RESULT = 'the bot answered without a result';

afterEach(() => {
  vi.useRealTimers();
});

describe('applyModule with no bot child to apply it', () => {
  it('a bot that reports running but has no child process answers not-running and sends nothing', async () => {
    const bot = fakeBot({ running: true, botProcess: null });
    expect(await apply(bot, install())).toEqual({ outcome: 'not-running', loaded: false, error: null, text: NOT_RUNNING });
    expect(bot.sent).toEqual([]);
  });

  it('a child process that is not running answers not-running and sends nothing', async () => {
    const bot = fakeBot({ running: false, botProcess: {} });
    expect(await apply(bot, install())).toEqual({ outcome: 'not-running', loaded: false, error: null, text: NOT_RUNNING });
    expect(bot.sent).toEqual([]);
  });

  it('an install with no version names no version in its text', async () => {
    const bot = fakeBot({ running: false, botProcess: null });
    const answer = await apply(bot, install({ version: null }));
    expect(answer.text).toBe("m  was installed. This machine's bot is not running, so it applies the module when it next starts normally.");
  });
});

describe('applyModule while the child never reaches the guild stage', () => {
  it('answers no-answer after 10 minutes and never sends module:apply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bot = fakeBot({ stage: new Promise<void>(() => undefined), reply: async () => ({ outcome: 'applied', reason: null, error: null, loaded: true }) });
    let answer: ModuleApplyAnswer | null = null;
    void apply(bot, install()).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(answer).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toEqual({
      outcome: 'no-answer', loaded: false, error: null,
      text: "m 1.0.0 was installed, but can't confirm whether it loaded on this machine: the bot did not answer within 10 minutes. The App Store tab lists this machine if the module fails to load here.",
    });
    expect(bot.sent).toEqual([]);
  });
});

describe('the 10 minute bound once the child answered', () => {
  it('leaves no timer pending after an answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bot = fakeBot({ reply: async () => ({ outcome: 'applied', reason: null, error: null, loaded: true }) });
    const answer = await apply(bot, install());
    expect(answer).toMatchObject({ outcome: 'applied', loaded: true });
    expect(bot.sent.map(m => m.type)).toEqual(['module:apply']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the answers of module:apply that carry no outcome', () => {
  it('no reply at all fails with the without-a-result text', async () => {
    const bot = fakeBot({ reply: async () => undefined });
    expect(await apply(bot, install())).toEqual({ outcome: 'failed', loaded: false, error: NO_RESULT, text: NO_RESULT });
  });

  it('a null reply fails with the without-a-result text', async () => {
    const bot = fakeBot({ reply: async () => null });
    expect(await apply(bot, install())).toEqual({ outcome: 'failed', loaded: false, error: NO_RESULT, text: NO_RESULT });
  });

  it('an empty reply fails with the without-a-result text', async () => {
    const bot = fakeBot({ reply: async () => ({}) });
    expect(await apply(bot, install())).toEqual({ outcome: 'failed', loaded: false, error: NO_RESULT, text: NO_RESULT });
  });

  it("a refusal with another error fails with the bot's own error, not as stopped serving", async () => {
    const bot = fakeBot({ reply: async () => ({ success: false, error: 'boom' }) });
    expect(await apply(bot, install())).toEqual({ outcome: 'failed', loaded: false, error: 'boom', text: 'boom' });
  });

  it('a non-refusal that carries the stopped-serving text and no outcome fails with that text', async () => {
    const bot = fakeBot({ reply: async () => ({ success: true, error: STOPPED_SERVING_TEXT }) });
    expect(await apply(bot, install())).toEqual({ outcome: 'failed', loaded: false, error: STOPPED_SERVING_TEXT, text: STOPPED_SERVING_TEXT });
  });
});

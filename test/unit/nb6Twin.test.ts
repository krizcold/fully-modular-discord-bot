import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NB7_TEXTS, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { CHANGED_TEXT } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { sendHopReply } from '../../src/webui/routes/config';
import { fakeBot, fakeTime, isInsert, isPoll, nb7Rig, requestPlan, resetNb7, writeOf, type Rig } from '../helpers/nb7Rig';

// NB6 decision 17 and C20 (cell 443): on a Postgres bot the holder's `changed` answer with which 'twin' is passed on
// as the holder gave it: 409 with NB10's changed text, which names no machine; NB7's twin refusal is gone.

let rig: Rig;
beforeEach(() => {
  fakeTime();
  rig = nb7Rig();
});
afterEach(() => {
  resetNb7();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hop(reply: any) {
  const out: { status?: number; body?: any } = {};
  sendHopReply({ status(code: number) { out.status = code; return this; }, json(body: any) { out.body = body; return this; } } as any, reply);
  return out;
}

async function answerOf(reply: unknown) {
  rig.script['postgres://one'] = sql => (isInsert({ sql } as any)
    ? { rows: [{ pg_notify: '' }], rowCount: 1 }
    : isPoll({ sql } as any) ? { rows: [{ state: 'done', reply: JSON.stringify(reply), pickup_over: false, answer_over: false }] } : undefined);
  const plan = await requestPlan('write');
  let value: any;
  void sendGuildChange(fakeBot().bot, plan, { ...writeOf(), op: 'write' }).then(v => { value = v; });
  await vi.advanceTimersByTimeAsync(2000);
  return value;
}

describe('the holder\'s twin that changed (cell 443)', () => {
  it('the reply is the holder\'s, with servedBy', async () => {
    const value = await answerOf({ ok: false, code: 'changed', which: 'twin', error: CHANGED_TEXT });
    expect(value).toEqual({ ok: false, code: 'changed', which: 'twin', error: CHANGED_TEXT, servedBy: 'BRAVO' });
  });

  it('the route answers 409 with the changed text, the same as a target that changed', async () => {
    const twin = hop(await answerOf({ ok: false, code: 'changed', which: 'twin', error: CHANGED_TEXT }));
    const target = hop(await answerOf({ ok: false, code: 'changed', which: 'target', error: CHANGED_TEXT }));
    expect(twin).toEqual({ status: 409, body: { success: false, error: `On BRAVO: ${CHANGED_TEXT}`, servedBy: 'BRAVO' } });
    expect(twin).toEqual(target);
    expect(twin.body.error).not.toMatch(/global config/);
  });

  it('NB7\'s twin text is no longer in the texts', () => {
    expect(Object.keys(NB7_TEXTS)).not.toContain('twin');
  });
});

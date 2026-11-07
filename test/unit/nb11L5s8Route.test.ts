import { beforeEach, describe, expect, it } from 'vitest';

import { createGraveyardRoutes } from '../../src/webui/routes/graveyard';
import type { BotManager } from '../../src/webui/botManager';
import { setBackendKind } from '../helpers/backendKind';
import { call, resetData, startApp } from '../helpers/configRig';

// NB11 (wip-redesign/sheets/NB11.md): the restore route's answers for a retiredAt of 0, a refused retiredAt, a reply
// the bot never answered, an ok reply without a count, and no reply at all.

const G = '123456789012345678';
const MINUTE = `The outcome is fixed within a minute. The entry it restored, if any, stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${G} <its retiredAt> --replace is then safe: it copies that entry in and moves whatever the server holds into a new entry, so nothing is lost. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.`;

beforeEach(async () => {
  setBackendKind('file');
  await resetData();
});

async function restore(reply: () => unknown, body: unknown) {
  const requests: any[] = [];
  const manager = { writeGuildData: async (req: any) => { requests.push(req); return reply(); } } as unknown as BotManager;
  const app = await startApp(a => a.use('/api/data/graveyard', createGraveyardRoutes(manager)));
  try {
    const res = await call(app.url, 'POST', '/api/data/graveyard/restore', body);
    return { ...res, requests };
  } finally {
    await app.close();
  }
}

describe('the restore route', () => {
  it('retiredAt 0 is a whole number of milliseconds: the restore is handed to the bot and its answer returned', async () => {
    const res = await restore(() => ({ ok: true, retiredAt: 0, reason: 'webui-operator-delete', copied: 2 }), { guildId: G, retiredAt: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, retiredAt: 0, reason: 'webui-operator-delete', copied: 2 });
    expect(res.requests).toHaveLength(1);
    expect(JSON.parse(res.requests[0].contentJson)).toEqual({ retiredAt: 0 });
  });

  it('D1: an ok reply naming an unconfirmed move answers 200 with the restore warning', async () => {
    const res = await restore(() => ({ ok: true, retiredAt: 5, reason: 'r', moveUnconfirmed: 'EIO' }), { guildId: G, retiredAt: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, retiredAt: 5, reason: 'r', warning: "The disk did not confirm the move of this server's folder (EIO), so a power cut can undo the restore. Check the disk." });
  });

  it('a refused retiredAt answers success false, never success', async () => {
    const res = await restore(() => ({ ok: true }), { guildId: G, retiredAt: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'retiredAt must be a whole number of milliseconds' });
    expect(res.requests).toEqual([]);
  });

  it('a reply the bot never answered answers success false with the can\'t confirm text', async () => {
    const res = await restore(() => ({ ok: false, code: 'no-answer', noAnswer: 'timeout', error: 'IPC request timed out' }), { guildId: G });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: `can't confirm whether server ${G} was restored: the bot did not answer within 50 s. ${MINUTE}` });
  });

  it.each([null, '3', true])('an ok reply whose copied is %s answers without a copied count', async copied => {
    const res = await restore(() => ({ ok: true, retiredAt: 7, reason: 'r', copied }), { guildId: G, retiredAt: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, retiredAt: 7, reason: 'r' });
    expect('copied' in res.body).toBe(false);
  });

  it.each([undefined, null])('no reply object (%s) answers 500 restore failed, not a crash text', async reply => {
    const res = await restore(() => reply, { guildId: G, retiredAt: 7 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'restore failed' });
  });
});

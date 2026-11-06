import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { _resetGuildRequests, _setGuildRequestDeps, NB7_TEXTS, planGuildChange, sendGuildChange } from '../../src/webui/utils/guildRequests';
import { getWebuiDataReader, setWebuiDataStoreUrl } from '../../src/webui/utils/webuiDataReader';
import { setBackendKind } from '../helpers/backendKind';
import { heldRow } from '../helpers/nb7Rig';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB7 code review round 1 on real Postgres: the request pool reads the server instance's identity on each new
// connection, and two connections to one server read the same value, so a settle on the insert's server still counts
// as a withdrawal (NB7-DL1); the reader's holder check names the database its pool reads (NB7-M2).

const GUILD = String(1n << 22n);
const BOT_DOWN = { ok: false, status: 503, code: 'bot-down', error: 'the bot process is not running' };
const bot = { writerRoute: () => BOT_DOWN, writeGuildData: async () => BOT_DOWN, readGuildData: async () => BOT_DOWN } as any;

let rig: ClaimRig;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

// helpers/setup.ts resets the backend kind before each test.
beforeEach(() => {
  setBackendKind('postgres');
});

afterAll(async () => {
  _setGuildRequestDeps(null);
  _resetGuildRequests();
  setWebuiDataStoreUrl(null);
  setBackendKind(null);
  await rig?.stop();
});

describe('NB7-DL1 and NB7-M2 on real Postgres', () => {
  it('the reader\'s holder check returns the URL of the database it read', async () => {
    setWebuiDataStoreUrl(rig.url);
    const res = await getWebuiDataReader().holderOf(GUILD, 5000);
    expect(res.url).toBe(rig.url);
  }, 30_000);

  it('a request nobody takes is settled on the insert\'s server instance: not taken, nothing was saved', async () => {
    _resetGuildRequests();
    _setGuildRequestDeps({
      holderOf: async () => ({ rows: [heldRow({ holder_process: 'p-nobody', node_process_id: 'p-nobody' })], url: rig.url }),
      readDoc: async () => null,
      currentUrl: () => rig.url,
      nodeId: () => 'n-a',
      nodeName: () => 'ALPHA',
    });
    const plan = await planGuildChange(bot, GUILD, 'write');
    expect(plan.kind).toBe('request');
    const reply = await sendGuildChange(bot, plan, { guildId: GUILD, module: 'm', filename: 'a.json', op: 'write', contentJson: '{"a":1}' });
    expect(reply).toMatchObject({ ok: false, code: 'not-taken', error: NB7_TEXTS.notTaken('BRAVO', 'saved') });
    const rows = (await rig.direct.query(`SELECT state FROM smdb_data.guild_requests WHERE guild_id = $1 AND for_process = 'p-nobody'`, [GUILD])).rows;
    expect(rows).toEqual([{ state: 'expired' }]);
    const sessions = (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-webui-requests'`)).rows[0].n;
    expect(sessions).toBeLessThanOrEqual(2);
  }, 60_000);
});

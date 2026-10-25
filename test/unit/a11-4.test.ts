import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../src/bot/internalSetup/fleet/constants';
import * as seedHold from '../../src/bot/internalSetup/fleet/seedHold';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function runtime(): any {
  const Runtime = (seedHold as any).SeedHoldRuntime;
  expect(Runtime, 'SeedHoldRuntime is exported for these rows').toBeTypeOf('function');
  return new Runtime({
    selfNodeId: 'master-self', selfNodeName: 'master', appVersion: '1.0.0', controlPort: 1, secret: 's',
    transferPort: 2, transferUrl: 'ws://t:2', controlUrl: null, localTerm: 3, claims: [], witness: null,
    pushStatus: () => undefined, park: async () => { throw new Error('park'); },
  });
}

const backupPayload = (nodeId: string, dataBackend: string) => ({
  nodeId, nodeName: nodeId, protocolVersion: PROTOCOL_VERSION, appVersion: '1.0.0',
  capabilities: { backupMaster: true, dataBackend, seedSource: true, shardCapacity: 1 },
});

describe('A11-4 seed hold texts', () => {
  it('an offer that timed out is unanswered, never "no copy to offer"', async () => {
    const rt = runtime();
    rt.server = { request: () => Promise.reject(new Error('Control request control:seed:offer to b1 timed out')), stop: () => undefined };
    expect(rt.onRegister(backupPayload('b1', 'file')).accepted).toBe(true);
    await rt.askOffer('b1');
    const view = rt.buildView();
    expect(view.backups[0].offerFault).toBe('unanswered');
    expect(view.backups[0].offerReason).toMatch(/did not answer its offer within 30 s/);
    const answer = rt.confirm('b1', false);
    expect(answer.success).toBe(false);
    expect(answer.error).toMatch(/did not answer its offer within 30 s/);
    expect(answer.error).not.toMatch(/offers no copy/);
  });

  it('the hold view lists refused backups and names postgres', () => {
    const rt = runtime();
    expect(rt.onRegister(backupPayload('pg1', 'postgres')).accepted).toBe(false);
    rt.onRegister(backupPayload('pg1', 'postgres'));
    const view = rt.buildView();
    expect(view.refused).toHaveLength(1);
    expect(view.refused[0]).toMatchObject({ nodeId: 'pg1', attempts: 2 });
    expect(view.refused[0].reason).toMatch(/postgres/);
    expect(view.refused[0].reason).toMatch(/start this master on the fleet's postgres/);
  });

  it('a stalled lane is answered as stalled, not running', () => {
    const rt = runtime();
    rt.lane = { failed: false, stalled: 'the copy landed but its adopt stopped at phase adopt: x. Restart this bot to finish it.', phase: 'adopting', record: { backupNodeName: 'b1' } };
    const answer = rt.confirm('b1', false);
    expect(answer.error).toMatch(/stalled, not running/);
    expect(answer.error).not.toMatch(/already running/);
  });

  it('the confirm-fresh route answers a stalled lane as stalled, not running', async () => {
    const { createFleetRoutes } = await import('../../src/webui/routes/fleet');
    const botManager: any = {
      isRunning: () => true,
      getFleetState: async () => ({ state: { seedHold: { push: { backupNodeName: 'b1', stalled: 'the adopt stopped at phase adopt: x. Restart this bot to finish it.' } } } }),
    };
    const router: any = createFleetRoutes(botManager);
    const layer = router.stack.find((l: any) => l.route?.path === '/confirm-fresh' && l.route.methods.post);
    expect(layer).toBeTruthy();
    let body: any = null;
    const res: any = { json: (b: any) => { body = b; return res; }, status: () => res };
    await layer.route.stack[0].handle({ body: {} }, res, () => undefined);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/stalled, not running/);
    expect(body.error).not.toMatch(/is running/);
  });

  it('a backup that answers ok false is unreadable, never "no copy"', async () => {
    const rt = runtime();
    rt.server = { request: () => Promise.resolve({ ok: false, reason: 'EACCES' }), stop: () => undefined };
    expect(rt.onRegister(backupPayload('b1', 'file')).accepted).toBe(true);
    await rt.askOffer('b1');
    const view = rt.buildView();
    expect(view.backups[0].offerFault).toBe('unreadable');
    expect(view.backups[0].offerReason).toBe('its offer could not be read: EACCES');
    const answer = rt.confirm('b1', false);
    expect(answer.success).toBe(false);
    expect(answer.error).not.toMatch(/offers no copy/);
  });

  it('the interrupted note is dated and cleared when a new seed starts', async () => {
    seedHold.writeSeedRecord({ seedId: 'seed-old', phase: 'push', backupNodeId: 'b1', backupNodeName: 'b1', sourceNodeId: 'old', guilds: [] } as any);
    await seedHold.resumeSeed('master-self');
    const rt = runtime();
    expect(rt.buildView().interrupted).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    rt.startLane = async () => undefined;
    rt.backups.set('b1', { nodeId: 'b1', nodeName: 'b1', connected: true, offer: { kind: 'live', totalBytes: 0, guilds: [], partialCount: 0, sourceTerm: 3 }, offerReason: null, offerFault: null, offerAt: Date.now(), offerPending: false });
    expect(rt.confirm('b1', true).success).toBe(true);
    expect(rt.buildView().interrupted).toBeNull();
  });

  it('a failed seed prints its date', () => {
    const rt = runtime();
    const lane = { failed: false, phase: 'copying', dialTimer: null, reportTimer: null, stallTimer: null, receiver: null, ws: null, transfer: { stop: () => undefined }, record: { seedId: 'seed-x', backupNodeId: 'b1' } };
    rt.lane = lane;
    rt.failLane(lane, 'boom');
    expect(rt.buildView().lastError).toMatch(/^boom \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\)$/);
  });

  it('the Fleet tab prints dates and names refusals', () => {
    const view = read('webui/public/components/usage/FleetView.jsx');
    expect(view).not.toMatch(/const at = \(ms\) => new Date\(ms\)\.toISOString\(\)\.slice\(11, 16\)/);
    expect(view).toMatch(/refused \(below\)/);
    expect(view).toMatch(/b\.offerFault \?/);
    const source = read('bot/internalSetup/fleet/seedSource.ts');
    expect(source).toMatch(/no longer holds \$\{missing\.length\} guild\(s\)/);
  });
});

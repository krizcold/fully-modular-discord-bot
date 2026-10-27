import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';
import { MigrationCoordinator } from '../../src/bot/internalSetup/fleet/migration/migrationCoordinator';
import { planPinRestoreLegs } from '../../src/bot/internalSetup/fleet/placement';

function node(nodeId: string, extra: Record<string, any> = {}): any {
  return {
    nodeId, nodeName: `name-${nodeId}`, connected: true, isSelf: nodeId === 'm', draining: false,
    lastHeartbeatAt: performance.now(), capabilities: { shardCapacity: 2, dataBackend: 'file' }, ...extra,
  };
}

function registry(nodes: any[], table: Record<number, string>, shardCount = 4): any {
  const shardTable = new Map<number, { nodeId: string }>();
  for (const [s, n] of Object.entries(table)) shardTable.set(Number(s), { nodeId: n });
  return {
    nodes: new Map(nodes.map(n => [n.nodeId, n])),
    shardTable,
    shardCount,
    term: 1,
    pendingConfirmation: new Map(),
    shardGuildTotals: new Map(),
    guildMap: new Map([['g1', 0]]),
    restGuildShards: new Map(),
    shardIdsOf: (id: string) => [...shardTable.entries()].filter(([, v]) => v.nodeId === id).map(([s]) => s),
    healthOf: (n: any) => (n.connected || n.isSelf ? 'up' : 'down'),
  };
}

function coordinator(reg: any): any {
  const c: any = new MigrationCoordinator({
    registry: reg, selfNodeId: 'm', store: {} as any, isPaused: () => false, holdDownRemainingMs: () => 0,
    grantShardsTo: async () => ({ ok: true, pending: false }), revokeLease: async () => ({ ok: true }),
    drainLeaseIdsForShards: () => [], persistPlan: async () => undefined, saveRedistributeProposal: async () => undefined,
    loadRedistributeProposal: async () => null, sendControl: async () => ({}), isSelf: (id: string) => id === 'm',
    selfExecutor: { handle: async () => ({}) }, transferUrlOf: () => 'http://x', pushStatus: () => undefined,
    frozenWriteRejections: () => 0, dataBackendHealthy: () => true,
  });
  c.recordsRead = true;
  return c;
}

describe('A09-2 precheck refuses what start refuses', () => {
  it('refuses a Move onto a draining node', async () => {
    const reg = registry([node('m'), node('a'), node('b', { draining: true })], { 0: 'a' });
    const res = await coordinator(reg).precheck({ kind: 'move', shardId: 0, toNodeId: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name-b is draining/);
  });

  it('start refuses a draining target too', async () => {
    const reg = registry([node('m'), node('a'), node('b', { draining: true })], { 0: 'a' });
    const res = await coordinator(reg).start({ kind: 'move', shardId: 0, toNodeId: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name-b is draining/);
  });

  it('refuses a Move whose target is disconnected', async () => {
    const reg = registry([node('m'), node('a'), node('b', { connected: false })], { 0: 'a' });
    const res = await coordinator(reg).precheck({ kind: 'move', shardId: 0, toNodeId: 'b' });
    expect(res.ok).toBe(false);
  });

  it('a Retire precheck refuses a draining target for any shard', async () => {
    const reg = registry([node('m'), node('a'), node('b'), node('c', { draining: true })], { 0: 'a', 1: 'a' });
    const res = await coordinator(reg).precheck({ kind: 'retire', nodeId: 'a', targets: { 0: 'b', 1: 'c' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name-c is draining/);
  });
});

describe('A09-2 precheck sizing', () => {
  it('says the size is unmeasured instead of reporting 0 bytes', async () => {
    const reg = registry([node('m'), node('a'), node('b')], { 0: 'a' });
    const res = await coordinator(reg).precheck({ kind: 'move', shardId: 0, toNodeId: 'b' });
    expect(res.ok).toBe(true);
    expect(res.estBytes).toBeNull();
    expect(res.targetFreeBytes).toBeNull();
  });
});

describe('A09-2 a declared capacity of 0 reads as 0', () => {
  it('the Move precheck warns that a standby target declares no capacity', async () => {
    const reg = registry([node('m'), node('a'), node('b', { capabilities: { shardCapacity: 0, dataBackend: 'file' } })], { 0: 'a' });
    const res = await coordinator(reg).precheck({ kind: 'move', shardId: 0, toNodeId: 'b' });
    expect(res.ok).toBe(true);
    expect((res.warnings ?? []).join(' ')).toMatch(/name-b declares a shard capacity of 0/);
  });

  it('the redistribute proposal leaves a 0-capacity node out while another can hold the shard', () => {
    const reg = registry([node('m'), node('z', { capabilities: { shardCapacity: 0, dataBackend: 'file' } })], {}, 4);
    const c = coordinator(reg);
    c.buildProposal(4, new Map());
    expect([...c.proposal.values()].every((n: string) => n === 'm')).toBe(true);
    expect(c.proposal.size).toBe(4);
  });

  it('the proposal still places a shard when only 0-capacity nodes are connected', () => {
    const reg = registry([node('m', { capabilities: { shardCapacity: 0, dataBackend: 'file' } })], {}, 2);
    const c = coordinator(reg);
    c.buildProposal(2, new Map());
    expect(c.proposal.size).toBe(2);
  });

  it('proposal warnings name a 0-capacity owner', () => {
    const reg = registry([node('m', { capabilities: { shardCapacity: 0, dataBackend: 'file' } })], {}, 1);
    const c = coordinator(reg);
    c.proposal.set(0, 'm');
    expect(c.proposalWarnings([]).join(' ')).toMatch(/name-m will exceed its declared capacity \(1\/0\)/);
  });

  it('a pin restore displaces onto a node with capacity before a 0-capacity holder', () => {
    const one = { shardCapacity: 1, dataBackend: 'file' };
    const reg = registry([node('m', { capabilities: one }), node('h', { capabilities: { shardCapacity: 0, dataBackend: 'file' } }), node('y', { capabilities: one })], { 0: 'h', 1: 'm' });
    const plan = planPinRestoreLegs(reg, 0, 'm');
    expect(plan?.proposedLegs?.[1]).toEqual({ shardId: 1, fromNodeId: 'm', toNodeId: 'y' });
  });

  it('a pin restore hands the displaced shard to a 0-capacity holder only when no other node declares capacity', () => {
    const reg = registry([node('m', { capabilities: { shardCapacity: 1, dataBackend: 'file' } }), node('h', { capabilities: { shardCapacity: 0, dataBackend: 'file' } })], { 0: 'h', 1: 'm' });
    const plan = planPinRestoreLegs(reg, 0, 'm');
    expect(plan?.proposedLegs?.[1]).toEqual({ shardId: 1, fromNodeId: 'm', toNodeId: 'h' });
  });

  it('a pin restore hands the displaced shard to a 0-capacity holder when the only other node is full', () => {
    const one = { shardCapacity: 1, dataBackend: 'file' };
    const reg = registry([node('m', { capabilities: one }), node('h', { capabilities: { shardCapacity: 0, dataBackend: 'file' } }), node('y', { capabilities: one })], { 0: 'h', 1: 'm', 2: 'y' });
    const plan = planPinRestoreLegs(reg, 0, 'm');
    expect(plan?.proposedLegs?.[1]).toEqual({ shardId: 1, fromNodeId: 'm', toNodeId: 'h' });
  });

  it('a node kept known for a source cleanup has no declared capacity', () => {
    const reg: any = registry([node('m')], {});
    reg.restoreNode = (input: any) => { reg.nodes.set(input.nodeId, { ...input, connected: false }); };
    coordinator(reg).keepOwingKnown('q', { legId: 'l1', committed: { sourceName: 'Q' } });
    expect(reg.nodes.get('q').capacityUnknown).toBe(true);
  });

  it('a pin restore to a 0-capacity master proposes the displacement', () => {
    const reg = registry([node('m', { capabilities: { shardCapacity: 0, dataBackend: 'file' } }), node('h')], { 0: 'h' });
    const plan = planPinRestoreLegs(reg, 0, 'm');
    expect(plan?.proposedLegs).toEqual([{ shardId: 0, fromNodeId: 'h', toNodeId: 'm' }]);
  });
});

describe('A09-2 Fleet tab confirms', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webui', 'public', 'components', 'usage', 'FleetView.jsx'), 'utf8');
  const fn = (name: string) => {
    const start = src.indexOf(`function ${name}`);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\nfunction ', start + 10));
  };

  it('the Move confirm names the node it sends', () => {
    expect(fn('FleetMoveControl')).toMatch(/Move shard \$\{shardId\} to \$\{/);
    expect(fn('FleetMoveControl')).not.toMatch(/to the selected node/);
  });

  it('the Move confirm says an unmeasured size is measured when the move starts', () => {
    expect(fn('FleetMoveControl')).toMatch(/measured when the move starts/);
  });

  it('the Move picker resets and says so when the picked node leaves the list', () => {
    expect(fn('FleetMoveControl')).toMatch(/is no longer eligible/);
  });

  it('the Retire confirm names each shard target and resets a stale pick', () => {
    const retire = fn('FleetRetireControl');
    expect(retire).toMatch(/shard \$\{shardId\} to \$\{/);
    expect(retire).toMatch(/is no longer eligible/);
  });
});

describe('A09-2 placeholder capacity through the saved registry', () => {
  it('a placeholder saved and restored keeps an unknown capacity', async () => {
    const { Registry, persistedNodeOf } = await import('../../src/bot/internalSetup/fleet/registry') as any;
    const first = new Registry();
    first.restoreNode({ nodeId: 'q', nodeName: 'Q', appVersion: '', capabilities: { shardCapacity: 1, dataBackend: 'unknown' }, capacityUnknown: true });
    const saved = JSON.parse(JSON.stringify(persistedNodeOf(first.nodes.get('q'), 1)));
    const second = new Registry();
    second.restoreNode(saved);
    expect(second.nodes.get('q').capacityUnknown).toBe(true);
  });
});

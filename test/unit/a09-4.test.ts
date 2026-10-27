import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/bot/internalSetup/fleet/registry';
import { HealthMonitor, persistsAfterTransition } from '../../src/bot/internalSetup/fleet/healthMonitor';

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function fnSource(rel: string, name: string): string {
  const src = read(rel);
  const start = src.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\nfunction ', start + 10));
}

const caps = { shardCapacity: 1, dataBackend: 'file' } as any;

function restored(lastSeenAt: number) {
  const registry = new Registry();
  registry.restoreNode({ nodeId: 'n1', nodeName: 'one', appVersion: '1', capabilities: caps, lastSeenAt } as any);
  const monitor = new HealthMonitor({ registry, onTransition: () => undefined });
  return { registry, monitor, node: registry.nodes.get('n1')! };
}

describe('A09-4 restored node down time', () => {
  it('seeds downSince from a loss event newer than the last sighting', () => {
    const lossAt = Date.now() - 600_000;
    const { monitor, node } = restored(lossAt - 30_000);
    monitor.seed([{ nodeId: 'n1', nodeName: 'one', shardIds: [0], at: lossAt }]);
    monitor.tick();
    expect(node.downSince).not.toBeNull();
    const agoMs = performance.now() - node.downSince!;
    expect(agoMs).toBeGreaterThan(590_000);
    expect(agoMs).toBeLessThan(610_000);
  });

  it('leaves downSince unknown when the node has no loss event', () => {
    const { monitor, node } = restored(Date.now() - 5_000);
    monitor.tick();
    expect(node.downSince).toBeNull();
  });

  it('ignores a loss event older than the last sighting (the node came back after it)', () => {
    const lossAt = Date.now() - 600_000;
    const { monitor, node } = restored(lossAt + 60_000);
    monitor.seed([{ nodeId: 'n1', nodeName: 'one', shardIds: [0], at: lossAt }]);
    monitor.tick();
    expect(node.downSince).toBeNull();
  });
});

describe('A09-4 lastSeenAt', () => {
  it('a restored node keeps its persisted lastSeenAt until it is heard again', () => {
    const { registry, node } = restored(12345);
    expect(registry.lastSeenAt(node)).toBe(12345);
  });

  it('a heartbeat moves lastSeenAt to the heartbeat time', () => {
    const { registry, node } = restored(12345);
    node.lastHeartbeatAt = performance.now() - 10_000;
    const seen = registry.lastSeenAt(node);
    expect(Math.abs(Date.now() - 10_000 - seen)).toBeLessThan(1_000);
  });

  it('a recovery persists, so the saved lastSeenAt moves past the loss', async () => {
    const registry = new Registry();
    const saved: number[] = [];
    const monitor = new HealthMonitor({
      registry,
      onTransition: (id, from, to) => {
        if (persistsAfterTransition(from, to)) saved.push(registry.lastSeenAt(registry.nodes.get(id)!));
      },
    });
    const up = () => registry.upsertNode({ nodeId: 'n1', nodeName: 'one', appVersion: '1', capabilities: caps, isSelf: false, send: null });
    let seq = 0;
    const beat = () => registry.recordHeartbeat('n1', { term: 1, seq: ++seq, shards: [], guilds: [], metrics: { totals: null, topKGuilds: [] }, load: null } as any);
    up(); beat(); monitor.tick();
    registry.markDisconnected('n1'); monitor.tick();
    const loss = monitor.getLossEvents().at(-1)!;
    await new Promise(r => setTimeout(r, 5));
    up(); beat(); monitor.tick();
    expect(saved.at(-1)!).toBeGreaterThan(loss.at);
    const after = restored(saved.at(-1)!);
    after.monitor.seed(monitor.getLossEvents());
    after.monitor.tick();
    expect(after.node.downSince).toBeNull();
  });
});

describe('A09-4 cards', () => {
  it('a disconnected node counts guilds on its frozen shards from the shard table sources', () => {
    const registry = new Registry();
    registry.shardCount = 4;
    registry.upsertNode({ nodeId: 'n1', nodeName: 'one', appVersion: '1', capabilities: caps, isSelf: false, send: null });
    registry.shardTable.set(0, { shardId: 0, nodeId: 'n1', leaseId: 'l0', term: 1, epoch: 0 });
    registry.shardTable.set(1, { shardId: 1, nodeId: 'n1', leaseId: 'l1', term: 1, epoch: 0 });
    const node = registry.nodes.get('n1')!;
    node.guildCount = 7;
    registry.markDisconnected('n1');
    expect(registry.frozenGuildCountOf(node)).toBe(7);
    const ids = Array.from({ length: 400 }, (_, i) => String(BigInt(i) << 22n));
    const onShard = (sh: number) => ids.filter(id => Number((BigInt(id) >> 22n) % 4n) === sh);
    for (const id of onShard(0).slice(0, 3)) registry.guildMap.set(id, 0);
    for (const id of onShard(1).slice(0, 2)) registry.guildMap.set(id, 1);
    expect(registry.frozenGuildCountOf(node)).toBe(5);
    registry.setAllGuilds([...onShard(0).slice(0, 4), ...onShard(2).slice(0, 9)].map(id => ({ id, name: id })));
    expect(registry.frozenGuildCountOf(node)).toBe(4 + 2);
  });

  it('node card words unknown loss time, not serving and awaiting first heartbeat', () => {
    const card = fnSource('webui/public/components/usage/FleetView.jsx', 'FleetNodeCard');
    expect(card).toMatch(/not reconnected since this master restarted/);
    expect(card).toMatch(/serving can't be confirmed \(not connected to this master\)/);
    expect(card).not.toMatch(/frozen shards, not serving/);
    expect(card).toMatch(/awaiting first heartbeat/);
  });

  it('witness card reads pending before the first renew of this process', () => {
    const card = fnSource('webui/public/components/usage/FleetView.jsx', 'FleetWitnessCard');
    expect(card).toMatch(/w\.lastRenewAt == null && !w\.lastError/);
    expect(card).toMatch(/Witness pending/);
  });
});

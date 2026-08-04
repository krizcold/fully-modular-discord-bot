// Master-only node health tracker: turns the registry's derived health into
// exactly-once up/late/down transitions on the existing self-heartbeat tick.
// A confirmed down stamps downSince and bumps the epoch (every later grant is
// provably ordered after the death observation; frozen leases keep their old
// epoch); it never moves a lease - Wait vs Declare Lost stays with the owner.

import { performance } from 'perf_hooks';
import { LOSS_LOG_CAP } from './constants';
import type { NodeHealth, Registry } from './registry';

export interface LossEvent {
  nodeId: string;
  nodeName: string;
  shardIds: number[];
  at: number;
}

export interface HealthMonitorOptions {
  registry: Registry;
  onTransition: (nodeId: string, from: NodeHealth, to: NodeHealth) => void;
}

export class HealthMonitor {
  private readonly lastHealth = new Map<string, NodeHealth>();
  private lossEvents: LossEvent[] = [];

  constructor(private readonly opts: HealthMonitorOptions) {}

  /** Adopt the persisted loss ring at recovery boot. */
  seed(events: LossEvent[]): void {
    this.lossEvents = events.slice(-LOSS_LOG_CAP);
  }

  getLossEvents(): LossEvent[] {
    return this.lossEvents;
  }

  recordLoss(event: LossEvent): void {
    this.lossEvents.push(event);
    if (this.lossEvents.length > LOSS_LOG_CAP) this.lossEvents.shift();
  }

  tick(): void {
    const { registry, onTransition } = this.opts;
    for (const nodeId of [...this.lastHealth.keys()]) {
      if (!registry.nodes.has(nodeId)) this.lastHealth.delete(nodeId);
    }
    for (const node of registry.nodes.values()) {
      if (node.isSelf) continue;
      const health = registry.healthOf(node);
      const prev = this.lastHealth.get(node.nodeId);
      if (prev === undefined) {
        // First observation is a baseline, not a transition: a node restored
        // down at recovery boot must not bump the epoch or log a fresh loss.
        this.lastHealth.set(node.nodeId, health);
        if (health === 'down' && node.downSince === null) node.downSince = performance.now();
        continue;
      }
      if (health === prev) continue;
      this.lastHealth.set(node.nodeId, health);
      if (health === 'down') {
        node.downSince = performance.now();
        registry.epoch += 1;
        const shardIds = registry.shardIdsOf(node.nodeId);
        this.recordLoss({ nodeId: node.nodeId, nodeName: node.nodeName, shardIds, at: Date.now() });
        console.warn(`[Fleet] Node ${node.nodeName} is DOWN (${shardIds.length} shard(s) frozen); Wait or Declare Lost`);
      } else if (prev === 'down') {
        node.downSince = null;
        console.log(`[Fleet] Node ${node.nodeName} recovered (${health})`);
      }
      onTransition(node.nodeId, prev, health);
    }
  }
}

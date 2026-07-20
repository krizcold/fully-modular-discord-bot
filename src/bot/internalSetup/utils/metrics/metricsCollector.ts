// MetricsCollector - per-process accumulators for CPU/RAM/disk/activity metrics.
// Lives in the bot child (owns the client and the heap). All micros stay INTEGERS
// through collector -> IPC -> REST; floats only appear at REST serialization.

import { getConfigProperty } from '../configManager';
import {
  listGuilds,
  loadModuleData,
  saveModuleData,
  deleteModuleData,
  loadGlobalModuleData,
  saveGlobalModuleData,
  moduleDataExists,
} from '../dataManager';
import {
  RING_LEN,
  LABEL_CAP,
  OTHER_LABEL,
  UNTAGGED_MODULE,
  GLOBAL_GUILD_KEY,
  METRICS_NAMESPACE,
  TOTALS_FILENAME,
} from './constants';

export type MetricKind =
  | 'command'
  | 'autocomplete'
  | 'event'
  | 'button'
  | 'dropdown'
  | 'modal'
  | 'reaction';

export interface Stat {
  calls: number;
  errors: number;
  cpuMicros: number;
  wallMicros: number;
  lastWallMs: number;
}

interface ModuleAcc {
  perLabel: Map<string, Stat>;
  total: Stat;
  ioReads: number;
  ioWrites: number;
}

export interface MetricsSample {
  t: number;
  cpuPct: number;
  rssBytes: number;
  heapBytes: number;
  loopP50Ms: number;
  loopP95Ms: number;
  loopMaxMs: number;
}

interface GuildDisk {
  totalBytes: number;
  byModule: Record<string, number>;
}

function newStat(): Stat {
  return { calls: 0, errors: 0, cpuMicros: 0, wallMicros: 0, lastWallMs: 0 };
}

function addStat(into: Stat, from: Stat): void {
  into.calls += from.calls;
  into.errors += from.errors;
  into.cpuMicros += from.cpuMicros;
  into.wallMicros += from.wallMicros;
  if (from.lastWallMs > into.lastWallMs) into.lastWallMs = from.lastWallMs;
}

class Ring {
  private arr: Array<{ t: number; v: number }> = [];
  private idx = 0;

  push(t: number, v: number): void {
    if (this.arr.length < RING_LEN) {
      this.arr.push({ t, v });
    } else {
      this.arr[this.idx] = { t, v };
      this.idx = (this.idx + 1) % RING_LEN;
    }
  }

  toArray(): Array<{ t: number; v: number }> {
    if (this.arr.length < RING_LEN) return this.arr.slice();
    return this.arr.slice(this.idx).concat(this.arr.slice(0, this.idx));
  }
}

export class MetricsCollector {
  private enabled: boolean;
  private seeded = false;
  private readonly acc = new Map<string, Map<string, ModuleAcc>>();
  private readonly activeSinceFlush = new Set<string>();
  private readonly guildDisk = new Map<string, GuildDisk>();
  private globalDataBytes = 0;
  private readonly ramEstimates = new Map<string, number>();
  private readonly rings = {
    cpu: new Ring(),
    memRss: new Ring(),
    heap: new Ring(),
    loop: new Ring(),
  };
  private latestSample: MetricsSample | null = null;
  private readonly startedAt = Date.now();

  constructor() {
    this.enabled = getConfigProperty<boolean>('metrics.enabled') !== false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Re-reads config so the Config tab's live save takes effect without a
  // restart. Called once per sampler tick - the hot paths only ever see the
  // cached in-memory boolean.
  refreshEnabled(): boolean {
    this.enabled = getConfigProperty<boolean>('metrics.enabled') !== false;
    if (this.enabled && !this.seeded) this.seedTotals();
    return this.enabled;
  }

  // --- recording ---

  record(
    kind: MetricKind,
    guildId: string | null,
    moduleName: string | null,
    label: string,
    cpuMicros: number,
    wallMicros: number,
    errored: boolean
  ): void {
    if (!this.enabled) return;
    const guildKey = guildId || GLOBAL_GUILD_KEY;
    const mod = this.getModuleAcc(guildKey, moduleName || UNTAGGED_MODULE);
    // Kind is preserved in the label key so commands stay separable in leaderboards
    let labelKey = `${kind}:${label}`;
    if (!mod.perLabel.has(labelKey) && mod.perLabel.size >= LABEL_CAP) {
      labelKey = `${kind}:${OTHER_LABEL}`;
    }
    let stat = mod.perLabel.get(labelKey);
    if (!stat) {
      stat = newStat();
      mod.perLabel.set(labelKey, stat);
    }
    const now = Date.now();
    stat.calls += 1;
    stat.cpuMicros += cpuMicros;
    stat.wallMicros += wallMicros;
    stat.lastWallMs = now;
    if (errored) stat.errors += 1;
    mod.total.calls += 1;
    mod.total.cpuMicros += cpuMicros;
    mod.total.wallMicros += wallMicros;
    mod.total.lastWallMs = now;
    if (errored) mod.total.errors += 1;
    this.activeSinceFlush.add(guildKey);
  }

  recordIO(kind: 'read' | 'write', guildId: string | null, moduleName: string | null): void {
    if (!this.enabled) return;
    // The metrics namespace's own persistence must not count itself or it
    // would mark every guild dirty forever
    if (moduleName === METRICS_NAMESPACE) return;
    const guildKey = guildId || GLOBAL_GUILD_KEY;
    const mod = this.getModuleAcc(guildKey, moduleName || UNTAGGED_MODULE);
    if (kind === 'read') mod.ioReads += 1;
    else {
      mod.ioWrites += 1;
      this.activeSinceFlush.add(guildKey);
    }
  }

  private getModuleAcc(guildKey: string, moduleKey: string): ModuleAcc {
    let guild = this.acc.get(guildKey);
    if (!guild) {
      guild = new Map();
      this.acc.set(guildKey, guild);
    }
    let mod = guild.get(moduleKey);
    if (!mod) {
      mod = { perLabel: new Map(), total: newStat(), ioReads: 0, ioWrites: 0 };
      guild.set(moduleKey, mod);
    }
    return mod;
  }

  dropModule(moduleName: string): void {
    if (!this.enabled) return;
    let dropped = 0;
    for (const guild of this.acc.values()) {
      if (guild.delete(moduleName)) dropped++;
    }
    console.log(`[Metrics] dropModule(${moduleName}): pruned accumulators in ${dropped} guild scope(s)`);
  }

  dropGuild(guildId: string): void {
    if (!this.enabled) return;
    this.acc.delete(guildId);
    this.activeSinceFlush.delete(guildId);
    this.guildDisk.delete(guildId);
    this.ramEstimates.delete(guildId);
  }

  // Not gated on enabled: totals persisted during an earlier enabled period
  // would otherwise resurrect the departed guild at the next boot's seed
  dropGuildPersisted(guildId: string): void {
    try {
      if (!moduleDataExists(TOTALS_FILENAME, guildId, METRICS_NAMESPACE)) return;
      if (!deleteModuleData(TOTALS_FILENAME, guildId, METRICS_NAMESPACE)) {
        console.warn(`[Metrics] Could not delete persisted totals for departed guild ${guildId}`);
      }
    } catch (error) {
      console.warn(`[Metrics] Could not delete persisted totals for departed guild ${guildId}:`, error);
    }
  }

  // --- sampler feeds ---

  pushSample(sample: MetricsSample): void {
    if (!this.enabled) return;
    this.latestSample = sample;
    this.rings.cpu.push(sample.t, sample.cpuPct);
    this.rings.memRss.push(sample.t, sample.rssBytes);
    this.rings.heap.push(sample.t, sample.heapBytes);
    this.rings.loop.push(sample.t, sample.loopP95Ms);
  }

  setGuildDisk(guildId: string, totalBytes: number, byModule: Record<string, number>): void {
    if (!this.enabled) return;
    this.guildDisk.set(guildId, { totalBytes, byModule });
  }

  setGlobalDataBytes(bytes: number): void {
    if (!this.enabled) return;
    this.globalDataBytes = bytes;
  }

  setRamEstimate(guildId: string, bytes: number): void {
    if (!this.enabled) return;
    this.ramEstimates.set(guildId, bytes);
  }

  getDiskTotalBytes(): number {
    let total = this.globalDataBytes;
    for (const d of this.guildDisk.values()) total += d.totalBytes;
    return total;
  }

  // --- snapshots (plain JSON for IPC) ---

  getGlobalSnapshot(): any {
    if (!this.enabled) return this.emptyGlobalSnapshot();
    const totals = { calls: 0, errors: 0, cpuMicros: 0, wallMicros: 0, ioReads: 0, ioWrites: 0 };
    for (const guild of this.acc.values()) {
      for (const mod of guild.values()) {
        totals.calls += mod.total.calls;
        totals.errors += mod.total.errors;
        totals.cpuMicros += mod.total.cpuMicros;
        totals.wallMicros += mod.total.wallMicros;
        totals.ioReads += mod.ioReads;
        totals.ioWrites += mod.ioWrites;
      }
    }
    const s = this.latestSample;
    return {
      enabled: true,
      t: Date.now(),
      startedAt: this.startedAt,
      system: {
        cpuPct: s ? s.cpuPct : 0,
        rssBytes: s ? s.rssBytes : 0,
        heapBytes: s ? s.heapBytes : 0,
        loopP50Ms: s ? s.loopP50Ms : 0,
        loopP95Ms: s ? s.loopP95Ms : 0,
        loopMaxMs: s ? s.loopMaxMs : 0,
        uptimeSec: Math.floor(process.uptime()),
        diskTotalBytes: this.getDiskTotalBytes(),
        diskGlobalBytes: this.globalDataBytes,
      },
      series: {
        cpu: this.rings.cpu.toArray(),
        memRss: this.rings.memRss.toArray(),
        heap: this.rings.heap.toArray(),
        loop: this.rings.loop.toArray(),
      },
      leaderboard: this.getLeaderboard(),
      totals,
    };
  }

  private emptyGlobalSnapshot(): any {
    return {
      enabled: false,
      t: Date.now(),
      startedAt: this.startedAt,
      system: {
        cpuPct: 0, rssBytes: 0, heapBytes: 0, loopP50Ms: 0, loopP95Ms: 0, loopMaxMs: 0,
        uptimeSec: Math.floor(process.uptime()), diskTotalBytes: 0, diskGlobalBytes: 0,
      },
      series: { cpu: [], memRss: [], heap: [], loop: [] },
      leaderboard: { modules: [], commands: [], guilds: [] },
      totals: { calls: 0, errors: 0, cpuMicros: 0, wallMicros: 0, ioReads: 0, ioWrites: 0 },
    };
  }

  getGuildSnapshot(guildId: string): any {
    if (!this.enabled) {
      return { enabled: false, guildId, modules: [], disk: { totalBytes: 0, byModule: [] }, ramEstimateBytes: 0, totals: newStat() };
    }
    const guild = this.acc.get(guildId);
    const modules: any[] = [];
    const totals = newStat();
    if (guild) {
      for (const [name, mod] of guild) {
        addStat(totals, mod.total);
        modules.push({
          module: name,
          calls: mod.total.calls,
          errors: mod.total.errors,
          cpuMicros: mod.total.cpuMicros,
          wallMicros: mod.total.wallMicros,
          lastWallMs: mod.total.lastWallMs,
          ioReads: mod.ioReads,
          ioWrites: mod.ioWrites,
          labels: Array.from(mod.perLabel, ([labelKey, stat]) => ({
            label: labelKey,
            calls: stat.calls,
            errors: stat.errors,
            cpuMicros: stat.cpuMicros,
            wallMicros: stat.wallMicros,
          })).sort((a, b) => b.calls - a.calls),
        });
      }
      modules.sort((a, b) => b.calls - a.calls);
    }
    const disk = this.guildDisk.get(guildId);
    return {
      enabled: true,
      guildId,
      modules,
      disk: {
        totalBytes: disk ? disk.totalBytes : 0,
        byModule: disk
          ? Object.entries(disk.byModule)
              .map(([module, bytes]) => ({ module, bytes }))
              .sort((a, b) => b.bytes - a.bytes)
          : [],
      },
      ramEstimateBytes: this.ramEstimates.get(guildId) ?? 0,
      totals,
    };
  }

  getLeaderboard(): any {
    if (!this.enabled) return { modules: [], commands: [], guilds: [] };
    const byModule = new Map<string, { calls: number; errors: number; cpuMicros: number; wallMicros: number; ioReads: number; ioWrites: number }>();
    const byCommand = new Map<string, { module: string; calls: number; errors: number; cpuMicros: number; wallMicros: number }>();
    const guilds: any[] = [];
    for (const [guildKey, guild] of this.acc) {
      let gCalls = 0, gErrors = 0, gCpu = 0, gWall = 0;
      let topModule = '';
      let topModuleCalls = -1;
      for (const [name, mod] of guild) {
        gCalls += mod.total.calls;
        gErrors += mod.total.errors;
        gCpu += mod.total.cpuMicros;
        gWall += mod.total.wallMicros;
        if (mod.total.calls > topModuleCalls) {
          topModuleCalls = mod.total.calls;
          topModule = name;
        }
        let m = byModule.get(name);
        if (!m) {
          m = { calls: 0, errors: 0, cpuMicros: 0, wallMicros: 0, ioReads: 0, ioWrites: 0 };
          byModule.set(name, m);
        }
        m.calls += mod.total.calls;
        m.errors += mod.total.errors;
        m.cpuMicros += mod.total.cpuMicros;
        m.wallMicros += mod.total.wallMicros;
        m.ioReads += mod.ioReads;
        m.ioWrites += mod.ioWrites;
        for (const [labelKey, stat] of mod.perLabel) {
          if (!labelKey.startsWith('command:')) continue;
          const command = labelKey.slice('command:'.length);
          let c = byCommand.get(command);
          if (!c) {
            c = { module: name, calls: 0, errors: 0, cpuMicros: 0, wallMicros: 0 };
            byCommand.set(command, c);
          }
          c.calls += stat.calls;
          c.errors += stat.errors;
          c.cpuMicros += stat.cpuMicros;
          c.wallMicros += stat.wallMicros;
        }
      }
      if (guildKey === GLOBAL_GUILD_KEY) continue;
      const disk = this.guildDisk.get(guildKey);
      guilds.push({
        guildId: guildKey,
        calls: gCalls,
        errors: gErrors,
        cpuMicros: gCpu,
        wallMicros: gWall,
        diskBytes: disk ? disk.totalBytes : 0,
        ramEstimateBytes: this.ramEstimates.get(guildKey) ?? 0,
        topModule,
      });
    }
    // Guilds with disk usage but no recorded activity still get a row
    for (const [guildId, disk] of this.guildDisk) {
      if (this.acc.has(guildId)) continue;
      guilds.push({
        guildId,
        calls: 0,
        errors: 0,
        cpuMicros: 0,
        wallMicros: 0,
        diskBytes: disk.totalBytes,
        ramEstimateBytes: this.ramEstimates.get(guildId) ?? 0,
        topModule: '',
      });
    }
    guilds.sort((a, b) => b.calls - a.calls);
    return {
      modules: Array.from(byModule, ([module, m]) => ({ module, ...m })).sort((a, b) => b.calls - a.calls),
      commands: Array.from(byCommand, ([command, c]) => ({ command, ...c })).sort((a, b) => b.calls - a.calls),
      guilds,
    };
  }

  // Forward-compat: shape consumed by the future control plane's heartbeats; nothing reads it yet
  getHeartbeatSnapshot(): any {
    const board = this.getLeaderboard();
    const snap = this.getGlobalSnapshot();
    return { totals: snap.totals, topKGuilds: board.guilds.slice(0, 10) };
  }

  // --- persistence (lightweight: counter totals + last disk sizes) ---

  seedTotals(): void {
    if (!this.enabled) return;
    this.seeded = true;
    try {
      const globalTotals = loadGlobalModuleData<any>(TOTALS_FILENAME, METRICS_NAMESPACE, null);
      if (globalTotals) {
        this.seedScope(GLOBAL_GUILD_KEY, globalTotals.modules);
        if (typeof globalTotals.globalDataBytes === 'number') {
          this.globalDataBytes = globalTotals.globalDataBytes;
        }
      }
      for (const guildId of listGuilds()) {
        if (!moduleDataExists(TOTALS_FILENAME, guildId, METRICS_NAMESPACE)) continue;
        const totals = loadModuleData<any>(TOTALS_FILENAME, guildId, METRICS_NAMESPACE, null);
        if (!totals) continue;
        this.seedScope(guildId, totals.modules);
        if (typeof totals.diskBytes === 'number') {
          this.guildDisk.set(guildId, { totalBytes: totals.diskBytes, byModule: totals.diskByModule ?? {} });
        }
      }
      this.activeSinceFlush.clear();
      console.log('[Metrics] Seeded counter totals from persisted files');
    } catch (error) {
      console.error('[Metrics] Failed to seed totals:', error);
    }
  }

  private seedScope(guildKey: string, modules: any): void {
    if (!modules || typeof modules !== 'object') return;
    for (const [name, m] of Object.entries<any>(modules)) {
      const mod = this.getModuleAcc(guildKey, name);
      if (m.total) addStat(mod.total, { ...newStat(), ...m.total });
      mod.ioReads += m.ioReads ?? 0;
      mod.ioWrites += m.ioWrites ?? 0;
      if (m.labels && typeof m.labels === 'object') {
        for (const [labelKey, stat] of Object.entries<any>(m.labels)) {
          if (!mod.perLabel.has(labelKey) && mod.perLabel.size >= LABEL_CAP) continue;
          mod.perLabel.set(labelKey, { ...newStat(), ...stat });
        }
      }
    }
  }

  flushTotals(): void {
    if (!this.enabled) return;
    try {
      const active = Array.from(this.activeSinceFlush);
      this.activeSinceFlush.clear();
      saveGlobalModuleData(TOTALS_FILENAME, METRICS_NAMESPACE, {
        v: 1,
        updatedAt: Date.now(),
        globalDataBytes: this.globalDataBytes,
        modules: this.serializeScope(GLOBAL_GUILD_KEY),
      });
      for (const guildKey of active) {
        if (guildKey === GLOBAL_GUILD_KEY) continue;
        this.flushGuild(guildKey);
      }
    } catch (error) {
      console.error('[Metrics] Failed to flush totals:', error);
    }
  }

  private flushGuild(guildId: string): void {
    const disk = this.guildDisk.get(guildId);
    saveModuleData(TOTALS_FILENAME, guildId, METRICS_NAMESPACE, {
      v: 1,
      updatedAt: Date.now(),
      diskBytes: disk ? disk.totalBytes : 0,
      diskByModule: disk ? disk.byModule : {},
      modules: this.serializeScope(guildId),
    });
  }

  private serializeScope(guildKey: string): Record<string, any> {
    const out: Record<string, any> = {};
    const guild = this.acc.get(guildKey);
    if (!guild) return out;
    for (const [name, mod] of guild) {
      const labels: Record<string, Stat> = {};
      for (const [labelKey, stat] of mod.perLabel) labels[labelKey] = { ...stat };
      out[name] = { total: { ...mod.total }, ioReads: mod.ioReads, ioWrites: mod.ioWrites, labels };
    }
    return out;
  }

  reset(): void {
    if (!this.enabled) return;
    this.acc.clear();
    this.activeSinceFlush.clear();
    saveGlobalModuleData(TOTALS_FILENAME, METRICS_NAMESPACE, {
      v: 1,
      updatedAt: Date.now(),
      globalDataBytes: this.globalDataBytes,
      modules: {},
    });
    for (const guildId of listGuilds()) {
      if (!moduleDataExists(TOTALS_FILENAME, guildId, METRICS_NAMESPACE)) continue;
      this.flushGuild(guildId);
    }
    console.log('[Metrics] Counters reset');
  }
}

let instance: MetricsCollector | null = null;

export function getMetricsCollector(): MetricsCollector {
  if (!instance) {
    instance = new MetricsCollector();
  }
  return instance;
}

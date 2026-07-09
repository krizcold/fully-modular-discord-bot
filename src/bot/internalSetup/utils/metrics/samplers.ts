// Metrics samplers: 5s process sample (CPU / RAM / event-loop lag + live IPC push),
// 60s async disk walk + per-guild cache estimate, periodic totals flush.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import type { Client } from 'discord.js';
import { getMetricsCollector, MetricsSample } from './metricsCollector';
import { listGuilds, sizeOfGlobalData } from '../dataManager';
import { SAMPLE_MS, DISK_WALK_MS, FLUSH_MS, BYTES_PER_CACHE_OBJECT } from './constants';

const BASE_DATA_DIR = '/data';

let sampleTimer: NodeJS.Timeout | null = null;
let diskTimer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let loopHistogram: IntervalHistogram | null = null;
let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastSampleHrtime: bigint | null = null;
let clientRef: Client | null = null;
let walking = false;
let lastEnabled: boolean | null = null;
const tickErrorsLogged = new Set<string>();

export function startSamplers(client: Client): void {
  const collector = getMetricsCollector();
  clientRef = client;

  loopHistogram = monitorEventLoopDelay({ resolution: 20 });
  loopHistogram.enable();
  lastCpuUsage = process.cpuUsage();
  lastSampleHrtime = process.hrtime.bigint();

  sampleTimer = setInterval(() => {
    // Metrics must never take the bot down: swallow tick errors, log each
    // distinct message once
    try {
      // Live metrics.enabled toggle: one config read per tick; disabled ticks
      // only refresh the CPU/loop baselines so re-enabling starts clean
      const enabled = collector.refreshEnabled();
      const cpu = process.cpuUsage(lastCpuUsage!);
      lastCpuUsage = process.cpuUsage();
      // Divide by the actual elapsed time, not the nominal interval: timer
      // drift or event-loop stalls would otherwise inflate cpuPct past 100%
      const nowHrtime = process.hrtime.bigint();
      const elapsedMicros = lastSampleHrtime !== null ? Number((nowHrtime - lastSampleHrtime) / 1000n) : 0;
      lastSampleHrtime = nowHrtime;
      const h = loopHistogram!;
      if (!enabled) {
        h.reset();
        // One final push on the enabled->disabled transition so the Usage tab
        // learns about the toggle without a manual refresh
        if (lastEnabled !== false && process.send) {
          process.send({
            type: 'metrics:snapshot',
            data: { t: Date.now(), cpuPct: 0, memRssMb: 0, heapMb: 0, loopLagMs: 0, diskTotalMb: 0, metricsEnabled: false },
          });
        }
        lastEnabled = false;
        return;
      }
      lastEnabled = true;
      const mem = process.memoryUsage();
      const sample: MetricsSample = {
        t: Date.now(),
        cpuPct: elapsedMicros > 0 ? Math.round(((cpu.user + cpu.system) / elapsedMicros) * 10000) / 100 : 0,
        rssBytes: mem.rss,
        heapBytes: mem.heapUsed,
        loopP50Ms: nsToMs(h.percentile(50)),
        loopP95Ms: nsToMs(h.percentile(95)),
        loopMaxMs: nsToMs(h.max),
      };
      h.reset();
      collector.pushSample(sample);

      if (process.send) {
        process.send({
          type: 'metrics:snapshot',
          data: {
            t: sample.t,
            cpuPct: sample.cpuPct,
            memRssMb: Math.round((sample.rssBytes / 1024 / 1024) * 10) / 10,
            heapMb: Math.round((sample.heapBytes / 1024 / 1024) * 10) / 10,
            loopLagMs: sample.loopP95Ms,
            diskTotalMb: Math.round((collector.getDiskTotalBytes() / 1024 / 1024) * 10) / 10,
            metricsEnabled: true,
          },
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!tickErrorsLogged.has(msg)) {
        tickErrorsLogged.add(msg);
        console.error('[Metrics] Sample tick failed (repeats of this error suppressed):', error);
      }
    }
  }, SAMPLE_MS);
  sampleTimer.unref();

  diskTimer = setInterval(() => {
    void runDiskWalk();
  }, DISK_WALK_MS);
  diskTimer.unref();
  void runDiskWalk();

  flushTimer = setInterval(() => {
    collector.flushTotals();
  }, FLUSH_MS);
  flushTimer.unref();

  console.log('[Metrics] Samplers started');
}

export function stopSamplers(): void {
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
  if (diskTimer) { clearInterval(diskTimer); diskTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (loopHistogram) { loopHistogram.disable(); loopHistogram = null; }
  clientRef = null;
  lastEnabled = null;
}

function nsToMs(ns: number): number {
  return Number.isFinite(ns) ? Math.round((ns / 1e6) * 100) / 100 : 0;
}

async function runDiskWalk(): Promise<void> {
  if (walking || !getMetricsCollector().isEnabled()) return;
  walking = true;
  try {
    const collector = getMetricsCollector();
    for (const guildId of listGuilds()) {
      const { totalBytes, byModule } = await sizeGuildDir(path.join(BASE_DATA_DIR, guildId));
      collector.setGuildDisk(guildId, totalBytes, byModule);
      await yieldLoop();
    }
    collector.setGlobalDataBytes(await sizeOfGlobalData());

    if (clientRef) {
      for (const guild of clientRef.guilds.cache.values()) {
        const objects =
          guild.channels.cache.size +
          guild.members.cache.size +
          guild.roles.cache.size +
          guild.emojis.cache.size;
        collector.setRamEstimate(guild.id, objects * BYTES_PER_CACHE_OBJECT);
      }
    }
  } catch (error) {
    console.error('[Metrics] Disk walk failed:', error);
  } finally {
    walking = false;
  }
}

async function sizeGuildDir(dir: string): Promise<{ totalBytes: number; byModule: Record<string, number> }> {
  const byModule: Record<string, number> = {};
  let totalBytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { totalBytes: 0, byModule };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const size = await sizeDir(full);
      byModule[entry.name] = size;
      totalBytes += size;
    } else if (entry.isFile()) {
      try {
        totalBytes += (await fsp.stat(full)).size;
      } catch { /* file vanished mid-walk */ }
    }
  }
  return { totalBytes, byModule };
}

async function sizeDir(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeDir(full);
    } else if (entry.isFile()) {
      try {
        total += (await fsp.stat(full)).size;
      } catch { /* file vanished mid-walk */ }
    }
  }
  return total;
}

function yieldLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

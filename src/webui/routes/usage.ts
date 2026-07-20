// Usage API - bundle-style metrics endpoints for the main web-UI Usage tab.
// Micros arrive as integers over IPC; floats (ms / MB / shares) are produced
// only here at serialization. Bot offline responds success:true running:false
// with EMPTY arrays and zeroed totals - the tab degrades, never errors.

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';

function toMb(bytes: number): number {
  return Math.round(((bytes || 0) / 1024 / 1024) * 1000) / 1000;
}

function microsToMs(micros: number): number {
  return Math.round(((micros || 0) / 1000) * 100) / 100;
}

function emptyGlobalPayload(running: boolean): any {
  return {
    success: true,
    running,
    metricsEnabled: false,
    system: { cpuPct: 0, memRssMb: 0, heapMb: 0, loopLagMs: 0, diskTotalMb: 0, uptime: 0 },
    series: { cpu: [], mem: [], loop: [] },
    leaderboard: { modules: [], commands: [] },
    totals: { calls: 0, errors: 0, cpuMs: 0, wallMs: 0, ioReads: 0, ioWrites: 0 },
  };
}

function serializeModules(modules: any[], totalCpuMicros: number): any[] {
  return (modules || []).map((m: any) => ({
    module: m.module,
    heavyLoad: m.heavyLoad === true,
    calls: m.calls,
    errors: m.errors,
    avgMs: m.calls > 0 ? microsToMs(m.wallMicros / m.calls) : 0,
    cpuMs: microsToMs(m.cpuMicros),
    wallMs: microsToMs(m.wallMicros),
    cpuShare: totalCpuMicros > 0 ? Math.round((m.cpuMicros / totalCpuMicros) * 1000) / 10 : 0,
    ioReads: m.ioReads ?? 0,
    ioWrites: m.ioWrites ?? 0,
  }));
}

function serializeCommands(commands: any[]): any[] {
  return (commands || []).map((c: any) => ({
    command: c.command,
    module: c.module,
    calls: c.calls,
    errors: c.errors,
    avgMs: c.calls > 0 ? microsToMs(c.wallMicros / c.calls) : 0,
    cpuMs: microsToMs(c.cpuMicros),
  }));
}

export function createUsageRoutes(botManager: BotManager): Router {
  const router = Router();

  function validateGuildId(guildId: string): boolean {
    return typeof guildId === 'string' && /^[0-9]+$/.test(guildId) && guildId.length >= 17 && guildId.length <= 19;
  }

  /**
   * GET /api/usage/global
   * One call = full snapshot (mirrors the appstore /bundle style).
   */
  router.get('/global', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json(emptyGlobalPayload(false));
        return;
      }
      const result = await botManager.getGlobalMetrics();
      if (!result?.success || !result.snapshot) {
        res.json(emptyGlobalPayload(true));
        return;
      }
      const snap = result.snapshot;
      res.json({
        success: true,
        running: true,
        metricsEnabled: snap.enabled === true,
        system: {
          cpuPct: snap.system.cpuPct,
          memRssMb: toMb(snap.system.rssBytes),
          heapMb: toMb(snap.system.heapBytes),
          loopLagMs: snap.system.loopP95Ms,
          diskTotalMb: toMb(snap.system.diskTotalBytes),
          uptime: snap.system.uptimeSec,
        },
        series: {
          cpu: (snap.series.cpu || []).map((p: any) => ({ t: p.t, v: p.v })),
          mem: (snap.series.memRss || []).map((p: any) => ({ t: p.t, v: toMb(p.v) })),
          loop: (snap.series.loop || []).map((p: any) => ({ t: p.t, v: p.v })),
        },
        leaderboard: {
          modules: serializeModules(snap.leaderboard.modules, snap.totals.cpuMicros),
          commands: serializeCommands(snap.leaderboard.commands),
        },
        totals: {
          calls: snap.totals.calls,
          errors: snap.totals.errors,
          cpuMs: microsToMs(snap.totals.cpuMicros),
          wallMs: microsToMs(snap.totals.wallMicros),
          ioReads: snap.totals.ioReads,
          ioWrites: snap.totals.ioWrites,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: `Failed to get usage snapshot: ${errorMessage}` });
    }
  });

  /**
   * GET /api/usage/guilds
   * Per-guild rows for the guild table. Names come from the existing
   * bot:guilds IPC; CPU share is attributed-approximate.
   */
  router.get('/guilds', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: true, running: false, guilds: [] });
        return;
      }
      const [boardResult, guildsResult] = await Promise.all([
        botManager.getMetricsLeaderboard(),
        botManager.getBotGuilds(),
      ]);
      if (!boardResult?.success || !boardResult.leaderboard) {
        res.json({ success: true, running: true, guilds: [] });
        return;
      }
      const names = new Map<string, string>();
      if (guildsResult?.success && Array.isArray(guildsResult.guilds)) {
        for (const g of guildsResult.guilds) names.set(g.id, g.name);
      }
      const rows = (boardResult.leaderboard.guilds || []);
      const totalCpuMicros = rows.reduce((sum: number, r: any) => sum + (r.cpuMicros || 0), 0);
      res.json({
        success: true,
        running: true,
        guilds: rows.map((r: any) => ({
          guildId: r.guildId,
          name: names.get(r.guildId) || r.guildId,
          diskMb: toMb(r.diskBytes),
          calls: r.calls,
          errors: r.errors,
          cpuShare: totalCpuMicros > 0 ? Math.round(((r.cpuMicros || 0) / totalCpuMicros) * 1000) / 10 : 0,
          ramEstimateMb: toMb(r.ramEstimateBytes),
          topModule: r.topModule || '',
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: `Failed to get guild usage rows: ${errorMessage}` });
    }
  });

  /**
   * GET /api/usage/guild/:guildId
   * Drilldown for one guild: disk by module (exact), module/command
   * leaderboard, counters, RAM cache estimate.
   */
  router.get('/guild/:guildId', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      if (!validateGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guild ID format' });
        return;
      }
      if (!botManager.isRunning()) {
        res.json({
          success: true,
          running: false,
          disk: { totalMb: 0, byModule: [] },
          leaderboard: { modules: [], commands: [] },
          counters: { calls: 0, errors: 0, cpuMs: 0, wallMs: 0 },
          ramEstimateMb: 0,
        });
        return;
      }
      const result = await botManager.getGuildMetrics(guildId);
      if (!result?.success || !result.snapshot) {
        res.status(500).json({ success: false, error: result?.error || 'Failed to get guild metrics' });
        return;
      }
      const snap = result.snapshot;
      const commands: any[] = [];
      for (const m of snap.modules || []) {
        for (const l of m.labels || []) {
          if (typeof l.label !== 'string' || !l.label.startsWith('command:')) continue;
          commands.push({
            command: l.label.slice('command:'.length),
            module: m.module,
            calls: l.calls,
            errors: l.errors,
            avgMs: l.calls > 0 ? microsToMs(l.wallMicros / l.calls) : 0,
            cpuMs: microsToMs(l.cpuMicros),
          });
        }
      }
      commands.sort((a, b) => b.calls - a.calls);
      res.json({
        success: true,
        running: true,
        disk: {
          totalMb: toMb(snap.disk.totalBytes),
          byModule: (snap.disk.byModule || []).map((d: any) => ({ module: d.module, mb: toMb(d.bytes) })),
        },
        leaderboard: {
          modules: serializeModules(snap.modules, snap.totals.cpuMicros),
          commands,
        },
        counters: {
          calls: snap.totals.calls,
          errors: snap.totals.errors,
          cpuMs: microsToMs(snap.totals.cpuMicros),
          wallMs: microsToMs(snap.totals.wallMicros),
        },
        ramEstimateMb: toMb(snap.ramEstimateBytes),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: `Failed to get guild usage: ${errorMessage}` });
    }
  });

  return router;
}

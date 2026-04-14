import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getAppStoreManager } from '../../bot/internalSetup/utils/appStoreManager';
import type { BotManager } from '../botManager';

export type JobKind = 'install' | 'uninstall';

export type InstallJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface InstallJob {
  id: string;
  kind: JobKind;
  moduleName: string;
  repoId?: string;
  credentials?: Record<string, string>;
  status: InstallJobStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  loaded?: boolean;     // install: hot-load result
  unloaded?: boolean;   // uninstall: hot-unload result
  skipped?: boolean;    // idempotent no-op
}

export type CancelResult =
  | { ok: true; job: InstallJob }
  | { ok: false; reason: 'not-found' | 'already-running' };

const APPSTORE_CONFIG_DIR = path.join(process.env.DATA_DIR || '/data', 'global', 'appstore');
const COMPONENT_CONFIG_PATH = path.join(APPSTORE_CONFIG_DIR, 'component-config.json');

function cleanupComponentConfig(moduleName: string): void {
  try {
    if (!fs.existsSync(COMPONENT_CONFIG_PATH)) return;
    const config = JSON.parse(fs.readFileSync(COMPONENT_CONFIG_PATH, 'utf-8'));
    const prefix = `${moduleName}:`;
    let cleaned = false;
    for (const key of Object.keys(config)) {
      if (key.startsWith(prefix)) {
        delete config[key];
        cleaned = true;
      }
    }
    if (cleaned) fs.writeFileSync(COMPONENT_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {
    /* non-fatal */
  }
}

let instance: InstallQueue | null = null;

export class InstallQueue extends EventEmitter {
  private jobs: InstallJob[] = [];
  private running = false;
  private jobCounter = 0;
  private botManager: BotManager | null = null;

  setBotManager(botManager: BotManager): void {
    this.botManager = botManager;
  }

  enqueueInstall(
    moduleName: string,
    repoId: string,
    credentials?: Record<string, string>
  ): InstallJob {
    const latestPending = this.getLatestPending(moduleName);
    if (latestPending && latestPending.kind === 'install') {
      const err: any = new Error(
        `Module ${moduleName} is already ${latestPending.status === 'running' ? 'being installed' : 'queued for install'}`
      );
      err.code = 'DUPLICATE';
      throw err;
    }

    const job: InstallJob = {
      id: `op-${Date.now()}-${++this.jobCounter}`,
      kind: 'install',
      moduleName,
      repoId,
      credentials,
      status: 'queued',
      enqueuedAt: Date.now()
    };
    this.jobs.push(job);
    this.emit('enqueued', this.redact(job));
    this.pump();
    return job;
  }

  enqueueUninstall(moduleName: string): InstallJob {
    const latestPending = this.getLatestPending(moduleName);
    if (latestPending && latestPending.kind === 'uninstall') {
      const err: any = new Error(
        `Module ${moduleName} is already ${latestPending.status === 'running' ? 'being uninstalled' : 'queued for uninstall'}`
      );
      err.code = 'DUPLICATE';
      throw err;
    }

    const job: InstallJob = {
      id: `op-${Date.now()}-${++this.jobCounter}`,
      kind: 'uninstall',
      moduleName,
      status: 'queued',
      enqueuedAt: Date.now()
    };
    this.jobs.push(job);
    this.emit('enqueued', this.redact(job));
    this.pump();
    return job;
  }

  requestCancel(moduleName: string, kind: JobKind): CancelResult {
    let latest: InstallJob | undefined;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      if (j.moduleName !== moduleName || j.kind !== kind) continue;
      if (j.status !== 'queued' && j.status !== 'running') continue;
      latest = j;
      break;
    }
    if (!latest) return { ok: false, reason: 'not-found' };
    if (latest.status === 'running') return { ok: false, reason: 'already-running' };
    latest.status = 'cancelled';
    latest.finishedAt = Date.now();
    this.emit('cancelled', this.redact(latest));
    this.prune();
    return { ok: true, job: this.redact(latest) };
  }

  getSnapshot(): InstallJob[] {
    return this.jobs.map(j => this.redact(j));
  }

  private getLatestPending(moduleName: string): InstallJob | undefined {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      if (j.moduleName !== moduleName) continue;
      if (j.status === 'queued' || j.status === 'running') return j;
    }
    return undefined;
  }

  private redact(job: InstallJob): InstallJob {
    const { credentials, ...rest } = job;
    return { ...rest };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.jobs.find(j => j.status === 'queued');
    if (!next) return;

    this.running = true;
    next.status = 'running';
    next.startedAt = Date.now();
    this.emit('started', this.redact(next));

    const manager = getAppStoreManager();

    try {
      if (next.kind === 'install') {
        await this.runInstall(next, manager);
      } else {
        await this.runUninstall(next, manager);
      }
    } catch (error) {
      next.status = 'failed';
      next.error = error instanceof Error ? error.message : String(error);
      next.finishedAt = Date.now();
      this.emit('failed', this.redact(next));
    } finally {
      this.running = false;
      this.prune();
      queueMicrotask(() => this.pump());
    }
  }

  private async runInstall(job: InstallJob, manager: ReturnType<typeof getAppStoreManager>): Promise<void> {
    if (manager.isModuleInstalled(job.moduleName)) {
      job.status = 'completed';
      job.loaded = true;
      job.skipped = true;
      job.finishedAt = Date.now();
      this.emit('completed', this.redact(job));
      return;
    }

    if (!job.repoId) {
      throw new Error('Repository ID missing for install job');
    }

    if (job.credentials && typeof job.credentials === 'object') {
      manager.saveCredentials(job.moduleName, job.credentials);
    }

    await manager.installModule(job.moduleName, job.repoId);

    let loaded = false;
    if (this.botManager) {
      try {
        const loadResult = await this.botManager.loadModule(job.moduleName);
        loaded = loadResult?.success === true;
      } catch {
        loaded = false;
      }
    }

    job.status = 'completed';
    job.loaded = loaded;
    job.finishedAt = Date.now();
    this.emit('completed', this.redact(job));
  }

  private async runUninstall(job: InstallJob, manager: ReturnType<typeof getAppStoreManager>): Promise<void> {
    if (!manager.isModuleInstalled(job.moduleName)) {
      job.status = 'completed';
      job.unloaded = true;
      job.skipped = true;
      job.finishedAt = Date.now();
      this.emit('completed', this.redact(job));
      return;
    }

    await manager.uninstallModule(job.moduleName);

    let unloaded = false;
    if (this.botManager) {
      try {
        const unloadResult = await this.botManager.unloadModule(job.moduleName);
        unloaded = unloadResult?.success === true;
      } catch {
        unloaded = false;
      }
    }

    cleanupComponentConfig(job.moduleName);

    job.status = 'completed';
    job.unloaded = unloaded;
    job.finishedAt = Date.now();
    this.emit('completed', this.redact(job));
  }

  private prune(): void {
    const RETENTION_MS = 5 * 60 * 1000;
    const now = Date.now();
    this.jobs = this.jobs.filter(j => {
      if (j.status === 'queued' || j.status === 'running') return true;
      return j.finishedAt !== undefined && now - j.finishedAt < RETENTION_MS;
    });
  }
}

export function getInstallQueue(): InstallQueue {
  if (!instance) {
    instance = new InstallQueue();
  }
  return instance;
}

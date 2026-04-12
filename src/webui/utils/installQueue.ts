import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getAppStoreManager } from '../../bot/internalSetup/utils/appStoreManager';
import { getSourceModulesDir, getModulesDir } from '../../bot/internalSetup/utils/pathHelpers';
import type { BotManager } from '../botManager';

export type InstallJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface InstallJob {
  id: string;
  moduleName: string;
  repoId: string;
  credentials?: Record<string, string>;
  status: InstallJobStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  loaded?: boolean;
}

export type CancelResult =
  | { ok: true; job: InstallJob }
  | { ok: false; reason: 'not-found' | 'already-running' | 'already-finished' };

let instance: InstallQueue | null = null;

export class InstallQueue extends EventEmitter {
  private jobs: InstallJob[] = [];
  private running = false;
  private jobCounter = 0;
  private botManager: BotManager | null = null;

  setBotManager(botManager: BotManager): void {
    this.botManager = botManager;
  }

  enqueue(
    moduleName: string,
    repoId: string,
    credentials?: Record<string, string>
  ): InstallJob {
    const existing = this.jobs.find(
      j =>
        j.moduleName === moduleName &&
        (j.status === 'queued' || j.status === 'running')
    );
    if (existing) {
      const err: any = new Error(
        `Module ${moduleName} is already ${existing.status === 'running' ? 'being installed' : 'queued for install'}`
      );
      err.code = 'DUPLICATE';
      throw err;
    }

    const sourceDir = path.join(getSourceModulesDir(), moduleName);
    const runtimeDir = path.join(getModulesDir(), moduleName);
    const manager = getAppStoreManager();
    if (
      manager.isModuleInstalled(moduleName) ||
      fs.existsSync(sourceDir) ||
      fs.existsSync(runtimeDir)
    ) {
      const err: any = new Error(`Module ${moduleName} is already installed`);
      err.code = 'ALREADY_INSTALLED';
      throw err;
    }

    const job: InstallJob = {
      id: `install-${Date.now()}-${++this.jobCounter}`,
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

  requestCancel(moduleName: string): CancelResult {
    const job = this.jobs.find(
      j => j.moduleName === moduleName && (j.status === 'queued' || j.status === 'running')
    );
    if (!job) {
      return { ok: false, reason: 'not-found' };
    }
    if (job.status === 'running') {
      return { ok: false, reason: 'already-running' };
    }
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    this.emit('cancelled', this.redact(job));
    this.prune();
    return { ok: true, job: this.redact(job) };
  }

  getSnapshot(): InstallJob[] {
    return this.jobs.map(j => this.redact(j));
  }

  getJob(moduleName: string): InstallJob | undefined {
    const job = this.jobs.find(
      j => j.moduleName === moduleName && (j.status === 'queued' || j.status === 'running')
    );
    return job ? this.redact(job) : undefined;
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
      if (next.credentials && typeof next.credentials === 'object') {
        manager.saveCredentials(next.moduleName, next.credentials);
      }

      await manager.installModule(next.moduleName, next.repoId);

      let loaded = false;
      if (this.botManager) {
        try {
          const loadResult = await this.botManager.loadModule(next.moduleName);
          loaded = loadResult?.success === true;
        } catch {
          loaded = false;
        }
      }

      next.status = 'completed';
      next.loaded = loaded;
      next.finishedAt = Date.now();
      this.emit('completed', this.redact(next));
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

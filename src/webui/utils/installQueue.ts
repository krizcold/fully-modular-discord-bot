import { EventEmitter } from 'events';
import { getAppStoreManager, type PublishedChange } from '../../bot/internalSetup/utils/appStoreManager';
import { componentConfigPath, readConfigFile, writeConfigFile } from '../../bot/internalSetup/utils/appStoreConfigFile';
import { resolveDataBackend } from '../../utils/envLoader';
import { FolderSyncError, logFolderSyncError } from '../../bot/internalSetup/utils/folderChain';
import { dropStagedFolder, inStoreWrite, notAppliedText, type BotManager, type ModuleApplyAnswer } from '../botManager';

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
  loadError?: string;
  unloaded?: boolean;   // uninstall: hot-unload result
  skipped?: boolean;    // idempotent no-op
  /** On a Postgres bot, the answer of the bot's apply when it is not today's success (NB6 decision 61). */
  message?: string;
}

export type CancelResult =
  | { ok: true; job: InstallJob }
  | { ok: false; reason: 'not-found' | 'already-running' };

async function cleanupComponentConfig(moduleName: string): Promise<void> {
  try {
    const read = readConfigFile(componentConfigPath());
    if (!read.ok) {
      console.error(`[AppStore] Kept the component toggles of ${moduleName}: component-config.json cannot be read: ${read.error}`);
      return;
    }
    const config = read.config;
    const prefix = `${moduleName}:`;
    let cleaned = false;
    for (const key of Object.keys(config)) {
      if (key.startsWith(prefix)) {
        delete config[key];
        cleaned = true;
      }
    }
    if (cleaned) await writeConfigFile(componentConfigPath(), config, read.sha);
  } catch (error) {
    if (error instanceof FolderSyncError) {
      logFolderSyncError(`[AppStore] The component toggles cleanup of ${moduleName}`, error);
      return;
    }
    console.error(`[AppStore] Kept the component toggles of ${moduleName}: the cleanup write failed:`, error);
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
    await this.storeDocsFirst();
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
      const credentials = job.credentials;
      await inStoreWrite(() => manager.saveCredentialsAwaited(job.moduleName, credentials));
    }

    // A FolderSyncError leaves the module installed, so it is loaded as on success and the job then fails with T9.
    let unconfirmed: FolderSyncError | null = null;
    let installed: Awaited<ReturnType<typeof manager.installModule>>;
    try {
      installed = await manager.installModule(job.moduleName, job.repoId);
    } catch (error) {
      if (!(error instanceof FolderSyncError)) throw error;
      unconfirmed = error;
      installed = true;
    }
    if (typeof installed === 'object') {
      this.complete(job, await this.applied(installed));
      return;
    }

    let loaded = false;
    let loadError: string | undefined;
    if (this.botManager) {
      try {
        const loadResult = await this.botManager.loadModule(job.moduleName);
        loaded = loadResult?.success === true;
        if (!loaded && loadResult?.unconfirmed !== true && typeof loadResult?.error === 'string') loadError = loadResult.error;
      } catch {
        loaded = false;
      }
    }

    job.loaded = loaded;
    if (loadError) job.loadError = loadError;
    if (unconfirmed) throw unconfirmed;
    job.status = 'completed';
    job.finishedAt = Date.now();
    this.emit('completed', this.redact(job));
  }

  private async runUninstall(job: InstallJob, manager: ReturnType<typeof getAppStoreManager>): Promise<void> {
    await this.storeDocsFirst();
    if (!manager.isModuleInstalled(job.moduleName)) {
      job.status = 'completed';
      job.unloaded = true;
      job.skipped = true;
      job.finishedAt = Date.now();
      this.emit('completed', this.redact(job));
      return;
    }

    let unconfirmed: FolderSyncError | null = null;
    let uninstalled: Awaited<ReturnType<typeof manager.uninstallModule>>;
    try {
      uninstalled = await manager.uninstallModule(job.moduleName);
    } catch (error) {
      if (!(error instanceof FolderSyncError)) throw error;
      unconfirmed = error;
      uninstalled = true;
    }
    if (typeof uninstalled === 'object') {
      const answer = await this.applied(uninstalled);
      await inStoreWrite(() => cleanupComponentConfig(job.moduleName));
      this.complete(job, answer);
      return;
    }

    let unloaded = false;
    if (this.botManager) {
      try {
        const unloadResult = await this.botManager.unloadModule(job.moduleName);
        unloaded = unloadResult?.success === true;
      } catch {
        unloaded = false;
      }
    }

    await cleanupComponentConfig(job.moduleName);

    job.unloaded = unloaded;
    if (unconfirmed) throw unconfirmed;
    job.status = 'completed';
    job.finishedAt = Date.now();
    this.emit('completed', this.redact(job));
  }

  /** Decision 31: with no bot child the job first brings the App Store docs up to the rows; a failure fails the job. */
  private async storeDocsFirst(): Promise<void> {
    if (resolveDataBackend() !== 'postgres' || !this.botManager) return;
    const refused = await this.botManager.storeDocsFirst();
    if (refused) throw new Error(refused.error);
  }

  /** Decisions 44 and 61: a landed publish or uninstall is applied by the bot child; with no BotManager, as no child. */
  private async applied(change: PublishedChange): Promise<ModuleApplyAnswer> {
    if (this.botManager) return this.botManager.applyModule(change);
    if (change.staged) dropStagedFolder(change.staged);
    return { outcome: 'not-running', loaded: false, error: null, text: notAppliedText(change.operation, change.module, change.version ?? '', 'not-running') };
  }

  /** The job's results from the apply: loaded and loadError for an install, unloaded for an uninstall, and its text. */
  private complete(job: InstallJob, answer: ModuleApplyAnswer): void {
    job.status = 'completed';
    if (job.kind === 'install') {
      job.loaded = answer.outcome === 'applied' || answer.outcome === 'loaded' ? answer.loaded : false;
      if (answer.outcome === 'failed' && answer.error) job.loadError = answer.error;
    } else {
      job.unloaded = answer.outcome === 'applied' && answer.unloadFailed === undefined;
    }
    if (answer.text) job.message = answer.text;
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

// src/index.ts

// This file is the bot-child entrypoint. Mark the role so the payment-provider
// registry (and any future single-owner loop) knows to run tick / reconcile
// jobs here rather than in the parent web-UI process. When the web-UI forks
// us, this env var is already set by botManager; setting it here too makes
// standalone runs (directly node-executing this file) still correct.
process.env.BOT_PROCESS_ROLE = 'bot';

// Register TypeScript path aliases for production (must be first)
import * as tsConfigPaths from 'tsconfig-paths';
import * as path from 'path';

const isProd = process.env.NODE_ENV !== 'development';

if (isProd) {
  // In production, resolve paths from /app/dist/ instead of /app/src/
  const baseUrl = path.join(__dirname, '..');
  tsConfigPaths.register({
    baseUrl,
    paths: {
      '@/*': ['*'],
      '@bot/*': ['bot/*'],
      '@modules/*': ['bot/modules/*'],
      '@internal/*': ['bot/internalSetup/*'],
      '@bot/types': ['bot/types'],
      '@webui/*': ['webui/*']
    }
  });
} else {
  // In development, use default tsconfig.json paths
  tsConfigPaths.register({
    baseUrl: path.join(__dirname, '..', '..'),
    paths: {
      '@/*': ['src/*'],
      '@bot/*': ['src/bot/*'],
      '@modules/*': ['src/bot/modules/*'],
      '@internal/*': ['src/bot/internalSetup/*'],
      '@bot/types': ['src/bot/types'],
      '@webui/*': ['src/webui/*']
    }
  });
}

// Load environment variables
import 'dotenv/config';

import { beginStop, exitProcess, installStopHandler } from './internalSetup/utils/dataManager';
import { setDiskRole } from './internalSetup/utils/folderChain';
import { configureWriterLock, onDeposed, releaseWriterLockAtExit, reportWriterStage, takeWriterLockForBoot } from './internalSetup/utils/writerLock';
import { setupAddressesIpc } from '../utils/databaseAddress';
import { setupMemoryIpc } from '../utils/memoryReading';

function watchDeposition(): void {
  onDeposed(holder => {
    reportWriterStage('deposed', { holder: { role: holder.role ?? null, pid: holder.pid } });
    // After every deposition listener of this synchronous run.
    void Promise.resolve().then(() => beginStop(true));
  });
}

// NB9 27 and 42: a standby takes no lock before it serves; it takes the lock at serve, then runs the normal boot's steps.
async function standbyBoot(): Promise<void> {
  setupAddressesIpc();
  setupMemoryIpc();
  installStopHandler();
  process.on('exit', () => releaseWriterLockAtExit());
  const { standbyMain } = await import('./internalSetup/fleet/standbyBoot');
  await standbyMain({
    takeLock: async () => {
      configureWriterLock('bot');
      await takeWriterLockForBoot();
      watchDeposition();
    },
  });
}

// Every writer of the data files runs after the writer lock is taken: clientInitializer loads only then.
async function boot(): Promise<void> {
  setDiskRole('bot');
  if (process.env.SMDB_RESHARD_STANDBY) return standbyBoot();
  configureWriterLock('bot');
  setupAddressesIpc();
  setupMemoryIpc();
  await takeWriterLockForBoot();
  installStopHandler();
  process.on('exit', () => releaseWriterLockAtExit());
  watchDeposition();
  const { main } = await import('./internalSetup/clientInitializer');
  main().catch(console.error);
}

boot().catch(error => {
  console.error('[Main] The bot process could not start:', error);
  exitProcess(1);
});

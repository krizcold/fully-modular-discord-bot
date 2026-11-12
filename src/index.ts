import * as path from 'path';
import { register } from 'tsconfig-paths';

const isProduction = process.env.NODE_ENV !== 'development';
const basePath = isProduction ? path.resolve('/app/dist') : path.resolve(__dirname, '..');

const pathPrefix = isProduction ? '' : 'src/';

register({
  baseUrl: basePath,
  paths: {
    '@/updater': [`${pathPrefix}updater`],
    '@/updater/*': [`${pathPrefix}updater/*`],
    '@/*': [`${pathPrefix}*`],
    '@bot/*': [`${pathPrefix}bot/*`],
    '@modules/*': [`${pathPrefix}bot/modules/*`],
    '@internal/*': [`${pathPrefix}bot/internalSetup/*`],
    '@bot/types': [`${pathPrefix}bot/types`],
    '@webui/*': [`${pathPrefix}webui/*`]
  }
});

import { initLogCapture } from './webui/utils/logCapture';
initLogCapture();

import 'dotenv/config';
import { BotManager, inLocalOp, populateTakeCause } from './webui/botManager';
import { endGuildRequests } from './webui/utils/guildRequests';
import { startWebUI, flushBeforeExit } from './webui';
import { ensureConfigPopulated } from './bot/internalSetup/utils/configManager';
import { getSafetyManager } from './utils/updateSafety';
import { exitProcess, setSharedWriteGate } from './bot/internalSetup/utils/dataManager';
import { carryWrites, runSealed, writesOf } from './bot/internalSetup/utils/dataBackends/writeLedger';
import { truthText, verdictOf } from './bot/internalSetup/utils/dataBackends/replyGate';
import { holderWords, readWriterHolder } from './bot/internalSetup/utils/writerLock';

/** The populate as a local op: it holds the data files' lock at most 8 s plus a flush, and main() does not wait for it. */
function populateConfig(botManager: BotManager): void {
  let unchanged = false;
  void botManager.runLocalOp('config.json populate', () => runSealed('console', null, null, async ledger => {
    const populated = ensureConfigPopulated();
    if (populated === 'left') {
      return carryWrites({ ok: false, code: 'invalid', error: 'config.json cannot be read or parsed; left it as it is. Fix the file, then restart.' }, writesOf(ledger));
    }
    unchanged = populated === 'unchanged';
    const verdict = await verdictOf([ledger]);
    return carryWrites(verdict.ok
      ? { ok: true }
      : { ok: false, code: 'unconfirmed', answer: verdict.answer, partial: verdict.partial, error: truthText(verdict.answer, verdict.partial, verdict.changed) }, writesOf(ledger));
  })).then(answer => {
    const take = answer?.lockTake;
    if (answer?.ok) {
      console.log(unchanged ? '[Main] config.json populate: every key is present; nothing written' : '[Main] config.json populate: saved');
    } else if (take) {
      console.log(`[Main] Skipped populating config.json: ${populateTakeCause(take)}`);
    } else if (answer?.code === 'held-elsewhere' || answer?.code === 'starting') {
      const read = readWriterHolder();
      console.log(read.kind === 'held'
        ? `[Main] Skipped populating config.json: ${holderWords(read.holder)} (pid ${read.holder.pid}) holds the data files; the bot populates it at its start`
        : `[Main] Skipped populating config.json: ${answer.error}`);
    } else {
      console.log(`[Main] Skipped populating config.json: ${answer?.error ?? 'unknown outcome'}`);
    }
  }, error => console.error('[Main] config.json populate failed:', error));
}

async function main() {
  // Outside a change the web UI applies itself, this process writes no data file.
  setSharedWriteGate(absPath => inLocalOp(absPath));
  console.log('='.repeat(60));
  console.log('  Discord Bot with Web-UI');
  console.log('='.repeat(60));

  // Check for safe mode flag
  const isSafeMode = process.argv.includes('--safe-mode');
  const safetyManager = getSafetyManager();

  if (isSafeMode) {
    console.log('');
    console.log('┌─────────────────────────────────────────┐');
    console.log('│           SAFE MODE ACTIVE              │');
    console.log('├─────────────────────────────────────────┤');
    console.log('│  Bot auto-start disabled                │');
    console.log('│  Web-UI running for recovery            │');
    console.log('└─────────────────────────────────────────┘');
    console.log('');
  }

  // Create bot manager with safe mode awareness
  const botManager = new BotManager(isSafeMode);

  // The Config tab can show a full config.json before the bot starts; the bot populates it at its own start too.
  console.log('[Main] Synchronizing config.json with schema...');
  populateConfig(botManager);

  // ALWAYS start Web-UI first
  try {
    await startWebUI(botManager);
    console.log('[Main] Web-UI started successfully');
  } catch (error) {
    console.error('[Main] Failed to start Web-UI:', error);
    exitProcess(1);
  }

  // Skip bot start if in safe mode
  if (isSafeMode) {
    console.log('[Main] [Warning] Safe mode active - Bot will NOT auto-start');
    console.log('[Main] [Warning] Use Web-UI to manually start bot or trigger rollback');
  } else {
    // Try to start bot if credentials are configured
    console.log('[Main] Attempting to start bot...');
    const result = await botManager.start();

    if (result.success) {
      if (result.waiting || result.waitingFor || result.cannotLock || result.cannotRead) {
        console.log(result.cannotLock
          ? `[Main] The bot process started and waits for the data disk to take writes (${result.cannotLock})`
          : result.cannotRead
            ? `[Main] The bot process started and cannot tell which process holds the data files (${result.cannotRead})`
            : result.waitingFor
              ? `[Main] The bot process started and waits for ${holderWords({ role: result.waitingFor.role ?? undefined })} (pid ${result.waitingFor.pid}) to release the data files`
              : '[Main] The bot process started and waits for another process to release the data files');
      } else {
        console.log('[Main] Bot started successfully');
      }

      // Health validation (60 second grace period) counts from the moment the bot opened its data files.
      botManager.whenStage('shared').then(() => safetyManager.validateHealth(60000)).then(() => {
        console.log('[Main] Bot health validated - marking as stable');
      }, () => { /* the child exited first; its exit records the crash */ });
    } else {
      if (result.reason === 'credentials_missing') {
        console.log('[Main] [Info] Bot not started - Credentials not configured');
        console.log('[Main] [Info] Please configure credentials via Web-UI');
      } else {
        console.error(`[Main] [Error] Bot failed to start: ${result.error}`);
      }
    }
  }

  console.log('='.repeat(60));
  console.log('  System Ready');
  console.log('='.repeat(60));

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Main] SIGTERM received, shutting down...');
    botManager.beginExit();
    await botManager.shutdown(false);
    await botManager.endLocalChain();
    await endGuildRequests();
    await flushBeforeExit();
    exitProcess(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Main] SIGINT received, shutting down...');
    botManager.beginExit();
    await botManager.shutdown(false);
    await botManager.endLocalChain();
    await endGuildRequests();
    await flushBeforeExit();
    exitProcess(0);
  });
}

main().catch((error) => {
  console.error('[Main] Fatal error:', error);
  exitProcess(1);
});

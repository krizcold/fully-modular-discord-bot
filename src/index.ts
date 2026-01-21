import * as path from 'path';
import { register } from 'tsconfig-paths';

const isProduction = process.env.NODE_ENV !== 'development';
const basePath = isProduction ? path.resolve('/app/dist') : path.resolve(__dirname, '..');

register({
  baseUrl: basePath,
  paths: {
    // Updater now unified - uses Bot Manager API
    '@/updater': ['src/updater'],
    '@/updater/*': ['src/updater/*'],
    '@/*': ['src/*'],
    '@bot/*': ['src/bot/*'],
    '@modules/*': ['src/bot/modules/*'],
    '@internal/*': ['src/bot/internalSetup/*'],
    '@bot/types': ['src/bot/types'],
    '@webui/*': ['src/webui/*']
  }
});

import { initLogCapture } from './webui/utils/logCapture';
initLogCapture();

import 'dotenv/config';
import { BotManager } from './webui/botManager';
import { startWebUI } from './webui';
import { ensureConfigPopulated } from './bot/internalSetup/utils/configManager';
import { getSafetyManager } from './utils/updateSafety';

async function main() {
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

  // Ensure config.json is populated BEFORE Web-UI starts
  // This allows Config tab to work even if bot hasn't started yet
  console.log('[Main] Synchronizing config.json with schema...');
  ensureConfigPopulated();

  // Create bot manager with safe mode awareness
  const botManager = new BotManager(isSafeMode);

  // ALWAYS start Web-UI first
  try {
    await startWebUI(botManager);
    console.log('[Main] Web-UI started successfully');
  } catch (error) {
    console.error('[Main] Failed to start Web-UI:', error);
    process.exit(1);
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
      console.log('[Main] Bot started successfully');

      // Start health validation (60 second grace period)
      safetyManager.validateHealth(60000).then(() => {
        console.log('[Main] Bot health validated - marking as stable');
      });
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
    await botManager.shutdown(false);
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[Main] SIGINT received, shutting down...');
    await botManager.shutdown(false);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Main] Fatal error:', error);
  process.exit(1);
});

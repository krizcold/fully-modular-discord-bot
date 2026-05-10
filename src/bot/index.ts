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

// Import the client initializer to start the bot.
// This will scan for events and commands, create the Discord client with required intents, and log in.
import './internalSetup/clientInitializer';

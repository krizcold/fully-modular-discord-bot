# Fully Modular Discord Bot

> **WORK IN PROGRESS** -- This project is under active development and is NOT ready for production use. APIs, configuration, file structure, and behavior may change without notice. Future updates will likely introduce breaking changes.

**Kriz_cold's Fully modular Discord bot framework built with TypeScript and Discord.js v14**

## Overview

A Discord bot framework designed with modularity at its core. Features are organized as self-contained modules that can be independently developed, distributed, and managed. The framework includes a built-in Web-UI for bot management, multi-server support with per-guild configuration, and an integrated update system for cloud deployments.

### Key Features

- 🧩 **Modular Architecture** - Self-contained modules with manifest-based configuration
- 🌐 **Web-UI Management** - Browser-based dashboard for bot control and monitoring
- 🔄 **Automatic Updates** - Integrated update system with multiple update strategies
- 🏢 **Multi-Server Support** - Per-guild configuration with fallback to global defaults
- 🔒 **Security First** - Permission-based access control and guild-restricted admin panels
- 📦 **Production Ready** - Docker deployment with persistent data management

---

## Quick Start

### Prerequisites

- Discord Bot Token ([Get one here](#-registering-the-bot-account))
- Docker and Docker Compose (for containerized deployment)
- Node.js 24+ (for local development)

### Docker Deployment (Recommended)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/krizcold/fully-modular-discord-bot.git
   cd fully-modular-discord-bot
   ```

2. **Configure credentials:**
   Create a `.env` file or use the Web-UI after first startup:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   CLIENT_ID=your_bot_client_id
   GUILD_ID=your_test_server_id
   MAIN_GUILD_ID=your_main_server_id  # Optional
   ```

3. **Start the bot:**
   ```bash
   docker-compose up -d
   ```

4. **Access Web-UI (local):**
   Open `http://localhost:3000/` in your browser

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file** with your credentials

3. **Run in development mode:**
   ```bash
   npm run dev
   ```

---

## Module System

### What are Modules?

Modules are self-contained feature packages that include:
- Commands (slash commands, context menus)
- Event handlers
- UI panels
- Configuration
- Documentation

Each module has a `module.json` manifest that defines its metadata, dependencies, and exports.

### Module Structure

```
src/bot/modules/{category}/{module-name}/
├── module.json           # Module manifest (required)
├── README.md            # Module documentation
├── commands/            # Slash and context commands
│   ├── commandName.ts
│   └── ...
├── events/              # Discord event handlers
│   ├── ready/
│   │   └── handler.ts
│   └── messageCreate/
│       └── handler.ts
├── panels/              # UI panels (optional)
│   └── panelName.ts
├── handlers/            # Business logic (optional)
│   └── ...
├── types/               # TypeScript types (optional)
│   └── index.ts
└── utils/               # Module utilities (optional)
    └── helpers.ts
```

### Example Module Manifest

```json
{
  "name": "example-module",
  "version": "1.0.0",
  "displayName": "Example Module",
  "description": "A simple example module",
  "author": "your_name",
  "category": "misc",
  "requiredIntents": ["Guilds"],
  "requiredPermissions": [],
  "dependencies": {
    "required": {},
    "optional": {}
  },
  "config": {},
  "enabled": true,
  "exports": {}
}
```

### Creating a New Module

1. **Create module directory:**
   ```bash
   mkdir -p src/bot/modules/misc/my-module
   ```

2. **Create `module.json`:**
   ```json
   {
     "name": "my-module",
     "version": "1.0.0",
     "displayName": "My Module",
     "description": "Description of my module",
     "author": "your_name",
     "category": "misc",
     "requiredIntents": ["Guilds"],
     "requiredPermissions": [],
     "dependencies": {
       "required": {},
       "optional": {}
     },
     "config": {},
     "enabled": true,
     "exports": {}
   }
   ```

3. **Create a command:**
   ```typescript
   // src/bot/modules/misc/my-module/commands/hello.ts
   import { Client, CommandInteraction } from 'discord.js';
   import { CommandOptions } from '@bot/types/commandTypes';

   const helloCommand: CommandOptions = {
     name: 'hello',
     description: 'Say hello!',

     callback: async (client: Client, interaction: CommandInteraction) => {
       await interaction.reply('Hello from my module!');
     }
   };

   export = helloCommand;
   ```

4. **Restart the bot** - The module will be automatically discovered and loaded

### Module Categories

- **fun** - Entertainment and game features
- **misc** - Utility and general-purpose commands
- **moderation** - Server management and admin tools
- **system** - Core framework features

---

## Web-UI Management

The bot includes a browser-based management interface for monitoring and controlling the bot without Discord access.

### Features

- **Dashboard** - Bot status, uptime, and quick controls
- **Credentials** - Update bot token and server IDs
- **Logs** - Real-time log viewing (last 50 lines)
- **Panels** - Execute Discord panels from the browser
- **Bot Control** - Start, stop, restart the bot process

### Accessing Web-UI

**Local Development:**
```
http://localhost:8080
```

**Docker Deployment (with nginx proxy):**
```
http://localhost:3000/?hash=YOUR_AUTH_HASH
```

The Web-UI operates in the main guild context (`MAIN_GUILD_ID`) and has full access to all admin panels.

### Guild Web-UI (OAuth-Based Multi-Guild Access)

**Optional Feature:** Enable Discord OAuth to allow guild administrators to manage their guilds via `/guild` interface.

#### What is Guild Web-UI?

Guild Web-UI provides a separate interface at `/guild` where Discord server administrators can:
- Login with Discord OAuth (no AUTH_HASH needed)
- Select which guild to manage
- Access guild-specific panels (config editor, data browser, module panels)
- Manage only guilds where they have Administrator permission AND bot is present

**When to use:**
- ✅ Multi-guild bots where each guild admin should manage their own settings
- ✅ Community bots where you want to empower guild admins
- ❌ Single-guild bots (owner Web-UI is sufficient)
- ❌ Owner-only management (no need for OAuth overhead)

#### Setup Instructions

**1. Create Discord OAuth Application:**
```bash
# Go to: https://discord.com/developers/applications
# Create a NEW application (separate from your bot application!)
# Name it something like "My Bot - Guild Manager"
```

**2. Configure OAuth2 Settings:**
- Go to OAuth2 section
- Add redirect URI: `http://your-domain:3000/auth/discord/callback`
  - For local testing: `http://localhost:3000/auth/discord/callback`
  - For production: `https://your-domain/auth/discord/callback`
- Select scopes: `identify`, `guilds`, `guilds.members.read`
- Save changes

**3. Configure via Web-UI Credentials Tab:**

Access the owner Web-UI (`http://localhost:3000/?hash=AUTH_HASH`) and go to **Credentials** tab:

1. Expand **"🔐 Advanced: Guild Web-UI OAuth (Optional)"** section
2. Enable **"Enable Guild Web-UI"** checkbox
3. Fill in OAuth credentials:
   - **Discord OAuth Client ID**: From OAuth2 application (General tab)
   - **Discord OAuth Client Secret**: Click "Reset Secret" button, copy immediately
   - **OAuth Callback URL**: Must match Discord redirect URI exactly
   - **Session Secret**: Click "Generate" button or provide your own (min 16 chars)
   - **Redis URL** (Optional): Leave empty to use memory store, or provide Redis URL for persistent sessions

4. Click **"Update & Restart"** to apply changes

**4. Test OAuth Login:**
```bash
# Access guild interface (no AUTH_HASH required):
http://localhost:3000/guild

# You'll be redirected to Discord for OAuth login
# After login, select a guild to manage
```

#### OAuth Configuration Options

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| **Enable Guild Web-UI** | Yes | Toggle to enable OAuth feature | `true` or `false` |
| **Discord OAuth Client ID** | Yes* | OAuth application ID (not bot CLIENT_ID) | `987654321098765432` |
| **Discord OAuth Client Secret** | Yes* | OAuth application secret (keep secure!) | `AbCdEf123456_XXX` |
| **OAuth Callback URL** | Yes* | Discord redirect URI (must match exactly) | `http://localhost:3000/auth/discord/callback` |
| **Session Secret** | Yes* | Random string for session encryption | Click "Generate" button |
| **Redis URL** | No | Optional Redis for persistent sessions | `redis://localhost:6379` |

*Required only when **Enable Guild Web-UI** is enabled

#### Security Considerations

⚠️ **OAuth Client Secret:**
- Never commit to git or share publicly
- Keep it secure like your bot token
- Regenerate if compromised

⚠️ **Session Secret:**
- Use the "Generate" button for secure random value
- Changing it logs out all guild admin users
- Keep it secure - used for encrypting sessions

⚠️ **Redis Sessions (Recommended for Production):**
- Memory store loses sessions on bot restart
- Redis provides persistent session storage
- Use Redis in production for better user experience

#### Permission Validation

Guild Web-UI validates user permissions:
- User must have **Administrator** permission OR be guild owner
- Bot must be present in the guild
- System panels (Update Manager, Global Config) remain owner-only

#### Troubleshooting

**"Authentication required" error:**
- Ensure `ENABLE_GUILD_WEBUI=true` in credentials
- Verify OAuth Client ID and Secret are correct
- Check OAuth Callback URL matches Discord settings exactly

**"No guilds available" after login:**
- User must be Administrator in at least one guild where bot is present
- Check bot is invited to user's guilds
- Verify user has Administrator permission in Discord

**Sessions lost on restart:**
- Configure Redis URL for persistent sessions
- Without Redis, sessions use memory store (lost on restart)

---

## Multi-Server Support

The bot supports multiple Discord servers simultaneously with per-guild configuration.

### Guild ID Configuration

**`.env` file:**
```env
GUILD_ID=123456789012345678        # Test/development server
MAIN_GUILD_ID=987654321098765432   # Production/main server (optional)
```

- **GUILD_ID** - Test server where `testOnly: true` commands are registered
- **MAIN_GUILD_ID** - Production server for Web-UI and restricted admin panels (defaults to GUILD_ID)

### Per-Guild Configuration

**Main Config** (`/data/dist/bot/config.json`):
```json
{
  "testMode": false,
  "adminPanel.itemsPerPage": 10
}
```

**Guild Override** (`/data/guildConfigs/{guildId}.json`):
```json
{
  "adminPanel.itemsPerPage": 25
}
```

Guild configs only need to include values that differ from the main config. All other settings automatically inherit from the main config.

### Main-Guild-Only Panels

Some admin panels are restricted to the main guild for security:

- **🔄 Bot Update Manager** - System updates and deployments
- **📊 System Information** - System-wide statistics and diagnostics

These panels are only accessible:
- In Discord: From the `MAIN_GUILD_ID` server
- In Web-UI: Always accessible (operates in main guild context)

---

## Update System

**Note:** The managed update system works with Bot Manager deployments. Self-hosted instances use the local git-based updater.

### Update Modes

Access via `/admin-panel` command → Bot Update Manager

#### 🔧 Basic Update (Recommended)
- Updates only core framework files
- Preserves all modules and customizations
- **Best for:** Security patches, framework improvements

#### 📈 Relative Update (Enhanced)
- Updates core framework + adds new files
- Never overwrites existing customizations
- **Best for:** Version updates with new features

#### ⚠️ Full Update (Use with caution)
- Replaces ALL source files
- **Deletes all customizations**
- **Best for:** Major breaking changes, starting fresh

### Data Preservation

**All update modes preserve:**
- `/data/{guildId}/` - Guild-specific data
- `/data/global/` - Global data
- `/data/guildConfigs/` - Per-guild configs

---

## Development

### Project Structure

```
/data/
├── src/
│   ├── index.ts              # Main entry point
│   ├── bot/                  # Discord bot code
│   │   ├── index.ts         # Bot entry point
│   │   ├── modules/         # Feature modules
│   │   │   ├── fun/
│   │   │   ├── misc/
│   │   │   └── moderation/
│   │   ├── internalSetup/   # Core framework
│   │   │   ├── events/      # Core event handlers
│   │   │   ├── panels/      # System panels
│   │   │   └── utils/       # Framework utilities
│   │   │       ├── moduleLoader.ts
│   │   │       ├── moduleRegistry.ts
│   │   │       ├── dataManager.ts
│   │   │       └── configManager.ts
│   │   └── types/           # TypeScript types
│   ├── webui/               # Web-UI code
│   │   ├── index.ts
│   │   ├── server.ts
│   │   ├── botManager.ts    # Bot process manager
│   │   ├── routes/          # API routes
│   │   └── public/          # Frontend files
│   └── utils/               # Shared utilities
└── tsconfig.json
```

### NPM Scripts

**Development:**
```bash
npm run dev              # Run with ts-node and auto-restart
npm run dev:bot          # Run bot only (for Web-UI development)
npm run dev:webui        # Run Web-UI only
npm run redis:dev        # Start (or reuse) a local Redis container for session storage
```

Redis is optional in development: without it, sessions use an in-memory store. To enable it,
run `npm run redis:dev` (requires Docker Desktop) and set `REDIS_URL=redis://localhost:6379`
in the Credentials panel or `/data/.env`. Container deployments ship a redis sidecar and set
`REDIS_URL` automatically via docker-compose.

**Building:**
```bash
npm run build            # Compile for development (from src/)
npm run build-prod       # Compile for production (tsc only, used by container build)
```

**Production:**
```bash
npm run start            # Run compiled JavaScript
npm run start:watch      # Build and watch with nodemon
```

**Utilities:**
```bash
npm run exportContext    # Export codebase context for AI/review
```

### Path Aliases

TypeScript path aliases for clean imports:

```typescript
import { CommandOptions } from '@bot/types/commandTypes';
import { getModuleRegistry } from '@internal/utils/moduleRegistry';
import { loadModuleData } from '@internal/utils/dataManager';
```

Available aliases:
- `@bot/*` - Bot code (`src/bot/*`)
- `@internal/*` - Internal setup (`src/bot/internalSetup/*`)
- `@modules/*` - Module directory (`src/bot/modules/*`)
- `@webui/*` - Web-UI code (`src/webui/*`)
- `@bot/types` - Type definitions

### Data Management

All module data should use the `dataManager` abstraction:

```typescript
import { loadModuleData, saveModuleData } from '@internal/utils/dataManager';

// Guild-specific data (isolated per server)
const data = loadModuleData('mydata.json', guildId, 'my-module', {});
saveModuleData('mydata.json', guildId, 'my-module', data);

// Global data (shared across all servers)
const globalData = loadGlobalModuleData('settings.json', 'my-module', {});
saveGlobalModuleData('settings.json', 'my-module', globalData);
```

**Data Storage Paths:**
- Guild data: `/data/{guildId}/{moduleName}/filename.json`
- Global data: `/data/global/{moduleName}/filename.json`

### Creating Commands

**Slash Command Example:**
```typescript
// src/bot/modules/misc/my-module/commands/ping.ts
import { Client, CommandInteraction } from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';

const pingCommand: CommandOptions = {
  name: 'ping',
  description: 'Check bot latency',
  testOnly: true,  // Only in test guild

  callback: async (client: Client, interaction: CommandInteraction) => {
    await interaction.reply(`Pong! ${client.ws.ping}ms`);
  }
};

export = pingCommand;
```

**Context Menu Example:**
```typescript
// src/bot/modules/misc/my-module/commands/userInfo.ts
import { Client, UserContextMenuCommandInteraction, ApplicationCommandType } from 'discord.js';
import { CommandOptions } from '@bot/types/commandTypes';

const userInfoCommand: CommandOptions = {
  name: 'User Info',
  type: ApplicationCommandType.User,

  callback: async (client: Client, interaction: UserContextMenuCommandInteraction) => {
    const user = interaction.targetUser;
    await interaction.reply(`User: ${user.tag}\nID: ${user.id}`);
  }
};

export = userInfoCommand;
```

### Creating Event Handlers

Event handlers are organized by Discord event type:

```typescript
// src/bot/modules/my-module/events/messageCreate/logger.ts
import { Client, Message } from 'discord.js';

export default async (client: Client, message: Message) => {
  if (message.author.bot) return;
  console.log(`[${message.guild?.name}] ${message.author.tag}: ${message.content}`);
};
```

**Folder name = Event type:**
- `events/ready/` → Fires on `ready` event
- `events/messageCreate/` → Fires on `messageCreate` event
- `events/interactionCreate/` → Fires on `interactionCreate` event

**Multiple handlers:** All handlers in an event folder execute in alphabetical order.

**Utility files:** Files without `export default async function` are ignored (utilities/types).

---

## Registering the Bot Account

<details>
<summary><strong>Click to expand bot registration steps</strong></summary>

1. **Create Application:**
   - Go to https://discord.com/developers/applications
   - Click "New Application"
   - Give it a name and click "Create"

2. **Enable Intents:**
   - Go to "Bot" tab
   - Scroll to "Privileged Gateway Intents"
   - Enable: **Presence Intent**, **Server Members Intent**, **Message Content Intent**
   - Click "Save Changes"

3. **Get Credentials:**
   - **Token:** Bot tab → Click "Reset Token" → Copy immediately
   - **Client ID:** OAuth2 → General → Copy "APPLICATION ID"
   - **Guild ID:** Enable Developer Mode in Discord → Right-click server → Copy Server ID

4. **Invite Bot:**
   - OAuth2 → URL Generator
   - Select scopes: `bot`, `applications.commands`
   - Select permissions (or Administrator for testing)
   - Copy generated URL and open in browser
   - Select server and authorize

</details>

---

## Docker Configuration

### docker-compose.yml Structure

The project uses two services:
- **nginxhashlock** - Reverse proxy with hash-based authentication (port 3000)
- **bot app** - Discord bot + Web-UI (port 8080 internal)

### Volume Mounts

```yaml
volumes:
  - ./custom:/app/custom  # User overrides (overlays /app/src at boot)
  - ./data:/data          # Persistent data (appstore-modules, applied-version, bot data)
```

### Environment Variables

Set in docker-compose.yml or via CasaOS UI:
```yaml
environment:
  DISCORD_TOKEN: 'your_token_here'
  GUILD_ID: 'your_guild_id'
  CLIENT_ID: 'your_client_id'
  MAIN_GUILD_ID: 'your_main_guild_id'  # Optional
  AUTH_HASH: '$AUTH_HASH'              # For Web-UI access
```

---

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

- **Issues:** https://github.com/krizcold/fully-modular-discord-bot/issues
- **Discord.js Docs:** https://discord.js.org/
- **Discord Developer Portal:** https://discord.com/developers/applications

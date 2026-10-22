# Bot Modules

This directory contains all bot feature modules, one folder per module.

## Structure

Each module is a self-contained feature with its own:
- Commands
- Events
- Panels
- Types
- Utilities
- Configuration

## Categories

The manifest's `category` field (`fun`, `misc`, `moderation` or `system`) groups a module; it does not set the folder.

## Module Structure

```
modules/{module-name}/   # one level deep; module.json must sit directly inside
├── module.json          # Module manifest (required)
├── README.md            # Module documentation
├── commands/            # Slash/context commands
├── events/              # Event handlers
├── panels/              # UI panels
├── types/               # Module-specific types
└── utils/               # Module utilities
```

## Module Manifest (module.json)

Every module requires a `module.json` manifest:

```json
{
  "name": "module-name",
  "version": "1.0.0",
  "displayName": "Module Display Name",
  "description": "What this module does",
  "author": "your_name",
  "category": "fun",
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

## Creating a New Module

1. Create a folder directly under `modules/`, named like the module (lowercase kebab-case, for example `my-module`; any other name fails validation and the module is skipped)
2. Add a `module.json` manifest whose `name` matches
3. Organize your code in the standard structure
4. Use `@internal/` and `@bot/types` imports for core dependencies
5. Use relative imports within your module

## Path Aliases

- `@internal/*` - Core framework utilities
- `@bot/types` - Shared type definitions
- `@modules/*` - Other modules
- Relative paths - Within your module

## Data Storage

Module data is automatically namespaced:

```typescript
import { loadModuleData, saveModuleData } from '@internal/utils/dataManager';

// Automatically stored in: /data/{guildId}/{moduleName}/filename.json
const data = loadModuleData('filename.json', guildId, 'moduleName', defaultValue);
```

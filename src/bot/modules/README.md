# Bot Modules

This directory contains all bot feature modules organized by category.

## Structure

Each module is a self-contained feature with its own:
- Commands
- Events
- Panels
- Types
- Utilities
- Configuration

## Categories

- **fun/** - Entertainment and game features
- **misc/** - Miscellaneous utilities and examples
- **moderation/** - Server management and moderation tools
- **system/** - Core system configuration and management

## Module Structure

```
modules/{category}/{moduleName}/
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
  "name": "moduleName",
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

1. Choose the appropriate category folder
2. Create a new folder with your module name
3. Add a `module.json` manifest
4. Organize your code in the standard structure
5. Use `@internal/` and `@types` imports for core dependencies
6. Use relative imports within your module

## Path Aliases

- `@internal/*` - Core framework utilities
- `@types` - Shared type definitions
- `@modules/*` - Other modules
- Relative paths - Within your module

## Data Storage

Module data is automatically namespaced:

```typescript
import { loadModuleData, saveModuleData } from '@internal/utils/dataManager';

// Automatically stored in: /data/{guildId}/{moduleName}/filename.json
const data = loadModuleData('filename.json', guildId, 'moduleName', defaultValue);
```

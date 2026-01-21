# Examples Module

Example commands and panels demonstrating Discord.js features and modular architecture.

## Commands

### Slash Commands

- **`/ping`** - Simple pong response with latency
- **`/ping-button`** - Demonstrates button interactions
- **`/pingchat`** - Works with both slash and message triggers
- **`/modal-example`** - Shows modal (popup form) usage
- **`/dropdown-example`** - Demonstrates dropdown menus

### Context Menu Commands

- **Ping User** - Right-click user → Apps → Ping User
- **Ping Message** - Right-click message → Apps → Ping Message

## Panels

- **Example Module Panel** - Demonstrates how modules can include panels
  - Access via `/admin-panel` → Select "Example Module Panel"
  - Shows panel features: buttons, dynamic content, interactions
  - Example of modular panel architecture

## Purpose

These commands and panels serve as templates and demonstrations for:

- Basic command structure
- Interactive components (buttons, dropdowns, modals)
- Handler registration patterns
- Context menu commands
- Dual slash/message triggers
- **Module panels** (NEW!) - How to include panels in modules

## Usage

All commands are set to `testOnly: true` and will only register in your test guild.

## Technical Details

- **Module Name**: `examples`
- **Category**: `misc`
- **Required Intents**: `Guilds` (some commands require additional intents)
- **Dependencies**: None

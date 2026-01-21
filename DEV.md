# DEV.md

Critical development notes for this project.

## Agent Instructions

- Never add relative/narrative comments - be objective, only add comments crucial for active development
- Be concise, analyze before acting
- Avoid emojis in code unless they add actual value. For console logs they are FORBIDDEN, use [Tags] instead.
  - [OK] `[Error]`, `[Warning]`, `[Info]`, `[Debug]`, `[Database]`, `[API]`, etc
  - The rocket emoji (🚀) is forbidden across the entire project, do not ever use it 
- Follow the project's existing architecture - report to user before adding something new
- Keep this document brief - prioritize didactic explanations with examples

---

## Command Naming Conventions

Discord has different naming rules for different command types:

| Command Type | Format | Example |
|--------------|--------|---------|
| Slash (ChatInput) | lowercase, no spaces, 1-32 chars | `role-assign` |
| Context Menu (User/Message) | mixed case, spaces allowed, 1-32 chars | `Edit Role Assignment` |

```typescript
// Slash command - lowercase kebab-case
const slashCommand: CommandOptions = {
  name: 'role-assign',  // lowercase, no spaces
  description: 'Create role assignment messages',
};

// Context menu - human-readable with spaces
const contextMenu: ContextMenuCommandOptions<MessageContextMenuCommandInteraction> = {
  name: 'Edit Role Assignment',  // Mixed case, spaces OK
  type: ApplicationCommandType.Message,
};
```

---

## Command Acknowledgment Patterns

Commands must acknowledge interactions. Choose the pattern based on what the user needs to see.

### Visible Reply

Use when the reply IS the result or contains information the user needs:

```typescript
// Timestamp - user needs to copy the output
await interaction.reply({ content: timestampStr });

// Reminder - user needs confirmation of timing
await interaction.reply({ content: `I'll remind you ${relativeTimestamp}` });

// Error - user needs to know what went wrong
await interaction.reply({ content: 'Error message', flags: MessageFlags.Ephemeral });
```

### Silent Acknowledgment

Use when the action result is already visible elsewhere (e.g., message sent to channel):

```typescript
// Message sent to channel - no confirmation needed, user can see it
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
await interaction.deleteReply();
```

**Rule:** If the user can already see the result of their action, don't show a redundant confirmation.

---

## Panel Button ID Standards

### Standard Panel Buttons (REQUIRED for Web-UI compatibility)

**ALL panel buttons MUST use the panel system** to ensure Web-UI compatibility:

```typescript
// Button ID format: panel_{panelId}_btn_{action}_{optionalData}
new ButtonBuilder()
  .setCustomId(`panel_${PANEL_ID}_btn_add_role_${pendingId}`)
  .setLabel('Add Role')

// Handled by the panel's handleButton method:
handleButton: async (context, buttonId) => {
  // buttonId = "add_role_{pendingId}" (prefix stripped)
  if (buttonId.startsWith('add_role_')) {
    const pendingId = buttonId.split('_')[2];
    // Handle the action...
  }
}
```

**Why:** The Web-UI routes button clicks to `handleButton`. ALL panel buttons must go through the panel system.

### Closing Panels (closePanel)

For terminal actions that close/delete the panel (e.g., Publish, Save, Delete, Cancel), use `closePanel: true`:

```typescript
// In handleButton:
if (action === 'publish') {
  // Do publish logic...
  await publishToChannel(context, pending);
  deletePendingAssignment(guildId, pendingId);

  // Close the panel - works for both Discord AND Web-UI
  return { closePanel: true };
}

// Cancel is the same - just clean up and close
if (action === 'cancel') {
  deletePendingAssignment(guildId, pendingId);
  return { closePanel: true };
}
```

**What happens:**
- **Discord:** Panel system calls `interaction.deleteReply()` to close the ephemeral message
- **Web-UI:** Returns `returnToPanelList: true` to navigate back to panel list

**All terminal actions** (Publish, Save, Delete, Cancel) should use `closePanel: true`. This ensures consistent behavior across Discord and Web-UI.

### Silent Notifications

When closing a panel with a success notification, Discord normally shows an ephemeral followUp message before deleting the panel. For actions where the result is already visible (e.g., giveaway message posted to channel), use `silent: true` to skip the Discord ephemeral message:

```typescript
// Silent success - Discord just closes, Web-UI still shows popup
return closePanelWithSuccess('Giveaway started successfully!', undefined, true);

// Non-silent (default) - Discord shows ephemeral message before closing
return closePanelWithSuccess('Action completed!');
```

**Behavior by platform:**
- **Discord (silent: true):** Panel closes via defer+delete, no ephemeral message shown
- **Discord (silent: false/undefined):** Ephemeral notification shown, then panel deleted
- **Web-UI:** Popup notification always shown (silent flag is ignored)

**When to use silent:**
- Result is already visible elsewhere (message sent to channel, embed updated)
- User can see the outcome without confirmation

**When NOT to use silent (keep notifications visible):**
- Errors and warnings - ALWAYS show these
- Success actions where result isn't immediately visible
- Confirmation needed for destructive actions

The `silent` option is also available on `closePanelWithNotification()`:

```typescript
closePanelWithNotification('success', 'Published!', undefined, true);  // silent
closePanelWithNotification('error', 'Failed!', undefined, false);      // always show errors
```

### Showing Modals from Panel Handlers

Panel handlers (`handleButton` and `handleDropdown`) support returning modals directly. The panel system detects the `modal` property and shows it instead of calling `deferUpdate()`.

```typescript
// In handleButton or handleDropdown:
if (needsConfirmation) {
  const modal = new ModalBuilder()
    .setCustomId('panel_my_panel_modal_confirm')
    .setTitle('Confirm Action');
  // ... add components
  return { modal };  // Panel system shows modal automatically
}

// Normal response
return createV2Response([container]);
```

This works for both buttons AND dropdowns - no workarounds needed.

### Updating Ephemeral Messages from Modals

When modal originates from a button, use `deferUpdate()` + `editReply()` to update the original message:

```typescript
// In panelModalHandler.ts:
if (interaction.message) {
  await interaction.deferUpdate();
  await interaction.editReply(response);
} else {
  await interaction.reply(response);
}
```

This updates the panel in-place instead of creating a new message.

---

## Panel Navigation Context

### AccessMethod Consistency

All panel handlers (button, dropdown, modal) must default to `'direct_command'` when no navigation context exists:

```typescript
// CORRECT - matches dropdown and modal handlers
const accessMethod = navContext?.accessMethod || 'direct_command';

// WRONG - don't guess based on panel scope
if (panel.panelScope === 'system') {
  accessMethod = 'system_panel';
} else {
  accessMethod = 'guild_panel';  // This breaks direct command access
}
```

**Why:** When a user accesses a panel via slash command, no navigation context is stored for the initial message. Guessing `guild_panel` incorrectly adds "Return to Guild Panel Menu" button.

---

## Pagination System

Location: `src/bot/internalSetup/utils/panel/paginationUtils.ts`

**ALWAYS show pagination controls** - buttons disable at boundaries, never hide them.

```typescript
import { paginate, parsePageFromCustomId, PAGINATION_DEFAULTS } from '@internal/utils/panel/paginationUtils';

// Paginate
const paginated = paginate(items, currentPage, {
  itemsPerPage: 6,
  buttonPrefix: 'myPanel_nav',
});

// Render (ALWAYS, even with 1 page)
new ButtonBuilder()
  .setCustomId(`myPanel_nav_prev_${paginated.currentPage}`)
  .setDisabled(!paginated.hasPrev),  // Disabled, not hidden
new ButtonBuilder()
  .setCustomId(`myPanel_nav_page_${paginated.currentPage}`)
  .setLabel(PAGINATION_DEFAULTS.pageFormat(paginated.currentPage + 1, paginated.totalPages))
  .setDisabled(true),
new ButtonBuilder()
  .setCustomId(`myPanel_nav_next_${paginated.currentPage}`)
  .setDisabled(!paginated.hasNext),

// Handle navigation
const newPage = parsePageFromCustomId(buttonId, 'myPanel_nav');
if (newPage !== null) state.currentPage = newPage;
```

---

## Module Settings

Location: `modules/{category}/{moduleName}/settingsSchema.json`

### Schema Structure

```json
{
  "id": "my-module-settings",
  "version": "1.0.0",
  "name": "My Module",
  "description": "Configure module behavior",
  "icon": "⚙️",
  "scope": "both",
  "sections": [
    { "id": "general", "name": "General", "icon": "🔧", "order": 1 }
  ],
  "settings": {
    "featureEnabled": {
      "type": "boolean",
      "default": true,
      "label": "Enable Feature",
      "description": "Toggle this feature on/off",
      "section": "general",
      "order": 1
    },
    "customMessage": {
      "type": "string",
      "default": "Hello {user}",
      "label": "Custom Message",
      "section": "general",
      "order": 2,
      "validation": { "required": true, "maxLength": 200 }
    }
  }
}
```

**Types:** `boolean`, `string`, `number`, `color`, `select`, `multiSelect`, `channel`, `role`, `multiChannel`, `multiRole`

**Scope:** `global` (bot-wide), `guild` (per-server), `both` (either)

### Reading Settings

```typescript
import { getModuleSetting } from '@internal/utils/settings/settingsStorage';

const MODULE_NAME = 'my-module';
const CATEGORY = 'misc';

function getSetting<T extends SettingValue>(key: string, guildId: string, defaultValue: T): T {
  const value = getModuleSetting<T>(MODULE_NAME, key, guildId, CATEGORY);
  return value !== undefined ? value : defaultValue;
}

// Usage
const enabled = getSetting('featureEnabled', guildId, true);
const message = getSetting('customMessage', guildId, 'Hello {user}');
```

Settings are accessible via the admin panel or Web-UI settings interface.

### Validation Limits (3-Tier Hierarchy)

Settings support a 3-tier limit hierarchy for numeric constraints:

```
┌─────────────────────────────────────────────────────────────────┐
│  ABSOLUTE LIMITS (Schema - IMMUTABLE)                           │
│  Only for logic-breaking values: divide by zero, Discord API    │
│  Fields: absoluteMin, absoluteMax, absoluteMinLength, etc.      │
├─────────────────────────────────────────────────────────────────┤
│  HARD LIMITS (System Panel - Overrides schema min/max)          │
│  Bot owner sets bounds that guilds must stay within             │
│  Stored in: /data/global/{module}/settings.json → _hardLimits   │
├─────────────────────────────────────────────────────────────────┤
│  GUILD VALUE (Guild Panel - Within Hard Limits)                 │
│  Guild admin sets their value within the allowed range          │
│  Stored in: /data/{guildId}/{module}/settings.json              │
└─────────────────────────────────────────────────────────────────┘
```

**When to use Absolute Limits (RARE - only when code would break):**
- `absoluteMin: 1` → Value used as divisor or array length (prevents divide by zero)
- `absoluteMax: 25` → Discord dropdown API limit
- `absoluteMax: 10` → Discord embed field limit per row
- `absoluteMinLength: 1` → Required string that cannot be empty

**NOT for Absolute Limits:** Performance, storage, or "reasonable" limits - use Hard Limits instead.

```json
{
  "historyLimit": {
    "type": "number",
    "default": 30,
    "label": "History Limit",
    "section": "general",
    "order": 1,
    "validation": {
      "min": 5,
      "max": 100,
      "absoluteMin": 1
    }
  }
}
```

In this example:
- `min`/`max` are defaults that System panel can override as Hard Limits
- `absoluteMin: 1` prevents 0 or negative (would break array slicing logic)
- No `absoluteMax` because there's no code-breaking upper limit

---

## Emoji Handling

Location: `src/bot/internalSetup/utils/emojiHandler.ts`

Centralized emoji parsing with translation layer: store original input, display resolved emoji.

**Rule:** Any user-provided text that will be displayed MUST go through `resolveEmojisInText()`. This allows users to use `:shortcodes:` naturally without needing full Discord emoji syntax.

Core utilities (like the list system) handle this automatically when given `client` and `guild` context.

### Parsing User Input

```typescript
import { parseEmoji } from '@internal/utils/emojiHandler';

// Accepts flexible formats (case-insensitive fallback):
// :myEmoji:, myEmoji, myEmoji:, :myEmoji:123456, <:myEmoji:123456>
const result = parseEmoji(userInput, client, guild);

if (result.success) {
  // Store identifier (emoji ID or unicode char)
  data.emojiIdentifier = result.identifier;
  // Store display format (<:name:id> or unicode)
  data.emojiDisplay = result.displayEmoji;
} else {
  // Show error to user
  await interaction.followUp({ content: result.errorMessage, flags: MessageFlags.Ephemeral });
}
```

### Resolving Emojis in Text

```typescript
import { resolveEmojisInText } from '@internal/utils/emojiHandler';

// Only :name: format is recognized in text (avoids false positives)
const displayText = resolveEmojisInText(storedContent, client, guild);
// "Hello :wave:" -> "Hello 👋"
```

### Validating Before Display

```typescript
import { isValidEmojiFormat } from '@internal/utils/emojiHandler';

// Always validate before using in Discord components
const emoji = isValidEmojiFormat(stored.emoji) ? stored.emoji : '❓';
new ButtonBuilder().setEmoji(emoji);
```

**Key functions:**
- `parseEmoji()` - Parse single emoji input (emoji-only fields)
- `resolveEmojisInText()` - Replace `:shortcodes:` in text content
- `isValidEmojiFormat()` - Check if string is valid for Discord components
- `getEmojiDisplay()` - Get display format from stored identifier
- `isEmojiAvailable()` - Check if custom emoji is still accessible

---

## Components V2

Discord's Components V2 system enables rich message layouts and features not possible with legacy components.

### Key Features

- **Dropdowns in Modals** - Select menus inside modal dialogs (via `LabelBuilder`)
- **Container-based layouts** - `ContainerBuilder` with accent colors, separators, sections
- **Media galleries** - `MediaGalleryBuilder` for images
- **Flexible text** - `TextDisplayBuilder` for formatted content

### Sending Components V2 Messages

```typescript
import {
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} from 'discord.js';

const container = new ContainerBuilder()
  .setAccentColor(0x5865F2);

container.addTextDisplayComponents(
  new TextDisplayBuilder().setContent('## Title')
);
container.addTextDisplayComponents(
  new TextDisplayBuilder().setContent('Message content here')
);
container.addMediaGalleryComponents(
  new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL('https://example.com/image.png')
  )
);

await channel.send({
  components: [container],
  flags: MessageFlags.IsComponentsV2,  // Required flag
});
```

**Note:** `MessageFlags.IsComponentsV2` is required. The `content` field cannot be used with this flag.

### Dropdowns in Modals

Use `LabelBuilder` to add select menus to modals:

```typescript
import {
  ModalBuilder,
  LabelBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

const select = new StringSelectMenuBuilder()
  .setCustomId('my_select')
  .addOptions(
    new StringSelectMenuOptionBuilder()
      .setLabel('Option 1')
      .setValue('opt1')
      .setDefault(true),
    new StringSelectMenuOptionBuilder()
      .setLabel('Option 2')
      .setValue('opt2'),
  );

const label = new LabelBuilder()
  .setLabel('Choose an option')
  .setDescription('Optional description')
  .setStringSelectMenuComponent(select);

const modal = new ModalBuilder()
  .setCustomId('my_modal')
  .setTitle('My Modal')
  .addComponents(/* text inputs */)
  .addLabelComponents(label);  // Add dropdown via LabelBuilder

await interaction.showModal(modal);
```

### Reading Dropdown Values from Modal

```typescript
// In modal handler:
let selectedValue = 'default';
try {
  const values = interaction.fields.getStringSelectValues('my_select');
  if (values?.length > 0) {
    selectedValue = values[0];
  }
} catch {
  // Dropdown not present or not interacted with
}
```

### Ephemeral Messages

Use `MessageFlags.Ephemeral` instead of the deprecated `ephemeral: true` property:

```typescript
// CORRECT - use flags
await interaction.reply({
  content: 'Only you can see this',
  flags: MessageFlags.Ephemeral,
});

await interaction.deferReply({ flags: MessageFlags.Ephemeral });

await interaction.followUp({
  content: 'Follow-up message',
  flags: MessageFlags.Ephemeral,
});

// WRONG - deprecated pattern
await interaction.reply({
  content: 'Only you can see this',
  ephemeral: true,  // Don't use this
});
```

---

## Channel-Required Panels (Web-UI)

Some panels require a channel context to function properly (e.g., giveaway start, response group creation). In the Web-UI, these panels show a channel selector before the panel content is displayed.

### Setting Up a Channel-Required Panel

Add `requiresChannel: true` to your panel definition:

```typescript
const myPanel: PanelOptions = {
  id: 'my_panel',
  name: 'My Panel',
  description: 'Panel that requires a channel',
  showInAdminPanel: true,
  panelScope: 'guild',
  requiresChannel: true,  // Web-UI will show channel selector

  callback: async (context) => {
    // Use channelId if available, fall back to interaction.channel
    // This works for both Web-UI (channelId set) and Discord (interaction.channel)
    let channel: TextChannel | null = null;
    if (context.channelId) {
      channel = await context.client.channels.fetch(context.channelId) as TextChannel;
    } else if (context.interaction?.channel) {
      channel = context.interaction.channel as TextChannel;
    }
    // ...
  },
};
```

### How It Works

1. **Panel List**: `requiresChannel` is included in the panel list response
2. **Web-UI Selection**: When user clicks a channel-required panel:
   - Guild context must be selected (not "System Panels")
   - Channel dropdown appears with all text/announcement channels
   - Panel is disabled until a channel is selected
3. **Context Propagation**: Selected `channelId` is passed in all interactions:
   - `PanelContext.channelId` in panel callback
   - Available in `handleButton`, `handleDropdown`, `handleModal`
4. **Change Channel**: Users can change the channel without going back to the panel list

### API Changes

All panel routes now accept optional `channelId`:
- `POST /api/panels/execute` - `{ panelId, userId, guildId, channelId }`
- `POST /api/panels/button` - `{ panelId, buttonId, userId, guildId, channelId }`
- `POST /api/panels/dropdown` - `{ panelId, values, dropdownId, userId, guildId, channelId }`
- `POST /api/panels/modal` - `{ panelId, modalId, fields, userId, guildId, channelId }`

### Channel List Endpoint

`GET /api/panels/channels?guildId={guildId}` returns text channels:

```json
{
  "success": true,
  "channels": [
    { "id": "123...", "name": "general", "type": 0, "parentId": null, "parentName": null },
    { "id": "456...", "name": "announcements", "type": 5, "parentId": "789...", "parentName": "Info" }
  ]
}
```

import {
    ApplicationCommand,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
    APIApplicationCommandOptionChoice,
    Locale, // Import Locale type
    PermissionsBitField // Import for type checking if needed
} from 'discord.js';

// Type alias for the payload we send to Discord
type CommandPayload = RESTPostAPIChatInputApplicationCommandsJSONBody | RESTPostAPIContextMenuApplicationCommandsJSONBody;
// Type alias for Localization objects
type LocalizationMap = Partial<Record<Locale, string | null>> | null | undefined;

// Define constants for command types for readability within this file
const typeChat = ApplicationCommandType.ChatInput;

/**
 * Compares an existing command fetched from Discord with the new payload data
 * by calling individual comparison functions for each relevant property.
 *
 * @param existingCommand - The command as registered on Discord.
 * @param newPayload - The final payload data intended for registration/update.
 * @returns {boolean} True if differences are found.
 */
export default function areCommandsDifferent(
    existingCommand: ApplicationCommand,
    newPayload: CommandPayload
): boolean {
    // https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-structure

    if (compareType(existingCommand, newPayload)) return true;
    if (compareName(existingCommand, newPayload)) return true;
    if (compareDescription(existingCommand, newPayload)) return true;
    if (comparePermissions(existingCommand, newPayload)) return true;
    if (compareDmPermission(existingCommand, newPayload)) return true;
    if (compareNsfw(existingCommand, newPayload)) return true;
    if (compareOptions(existingCommand, newPayload)) return true;
    if (compareNameLocalizations(existingCommand, newPayload)) return true;
    if (compareDescriptionLocalizations(existingCommand, newPayload)) return true;
    if (compareIntegrationTypes(existingCommand, newPayload)) return true;
    if (compareContexts(existingCommand, newPayload)) return true;

    // If no differences found after all checks
    return false;
}

// --- Comparison Helper Functions ---

function compareType(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingType = existing.type;
    const newType = payload.type ?? typeChat; // Default payload type if undefined
    return existingType !== newType;
}

function compareName(existing: ApplicationCommand, payload: CommandPayload): boolean {
    return existing.name !== payload.name;
}

function compareDescription(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const newType = payload.type ?? typeChat;
    // Only compare description for ChatInput commands
    if (newType === typeChat) {
        // Type assertion needed to access description safely
        const payloadDesc = (payload as RESTPostAPIChatInputApplicationCommandsJSONBody).description;
        return existing.description !== payloadDesc;
    }
    // If not ChatInput, description should not exist on payload. Check if it existed before.
    return !!existing.description; // Return true if description existed but shouldn't now
}

function comparePermissions(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingPerms = existing.defaultMemberPermissions?.toString() ?? null;
    const newPerms = payload.default_member_permissions ?? null;
    return existingPerms !== newPerms;
}

function compareDmPermission(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingDm = existing.dmPermission ?? true; // Default true
    const newDm = payload.dm_permission ?? true; // Default true
    return existingDm !== newDm;
}

function compareNsfw(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingNsfw = existing.nsfw ?? false; // Default false
    const newNsfw = payload.nsfw ?? false; // Default false
    return existingNsfw !== newNsfw;
}

function compareOptions(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const newType = payload.type ?? typeChat;
    // Only compare options for ChatInput commands
    if (newType === typeChat) {
        const newOptions = (payload as RESTPostAPIChatInputApplicationCommandsJSONBody).options;
        return optionsChanged(existing.options ?? [], newOptions ?? []);
    }
    // If not ChatInput, options should not exist on payload. Check if they existed before.
    return (existing.options?.length ?? 0) > 0; // Return true if options existed but shouldn't now
}

function compareNameLocalizations(existing: ApplicationCommand, payload: CommandPayload): boolean {
    return compareLocalizations(existing.nameLocalizations, payload.name_localizations);
}

function compareDescriptionLocalizations(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const newType = payload.type ?? typeChat;
    // Only compare description localizations for ChatInput commands
    if (newType === typeChat) {
         const newDescLocales = (payload as RESTPostAPIChatInputApplicationCommandsJSONBody).description_localizations;
         return compareLocalizations(existing.descriptionLocalizations, newDescLocales);
    }
     // If not ChatInput, desc localizations should not exist on payload. Check if they existed before.
     return !!existing.descriptionLocalizations && Object.keys(existing.descriptionLocalizations).length > 0;
}


// --- Deep Comparison Helpers (Options, Choices, Localizations) ---

// Helper function to compare options arrays recursively
function optionsChanged(optionsA: any[], optionsB: any[]): boolean {
    if (optionsA.length !== optionsB.length) return true;
    if (optionsA.length === 0) return false; // Both empty

    const sortedA = [...optionsA].sort((a, b) => a.name.localeCompare(b.name));
    const sortedB = [...optionsB].sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < sortedA.length; i++) {
        const optA = sortedA[i];
        const optB = sortedB[i];

        // Compare basic properties
        if (optA.name !== optB.name ||
            optA.description !== optB.description ||
            optA.type !== optB.type ||
            (optA.required ?? false) !== (optB.required ?? false)
           ) {
            return true;
        }
        // Compare choices
        if (choicesChanged(optA.choices ?? [], optB.choices ?? [])) return true;
        // Compare localizations for options
        if (compareLocalizations(optA.nameLocalizations, optB.name_localizations)) return true; // Handles mapping
        if (compareLocalizations(optA.descriptionLocalizations, optB.description_localizations)) return true; // Handles mapping

        // Recursively compare sub-options
        if (optA.type === ApplicationCommandOptionType.Subcommand || optA.type === ApplicationCommandOptionType.SubcommandGroup) {
             if (optionsChanged(optA.options ?? [], optB.options ?? [])) return true;
        }
    }
    return false;
}

// Helper function to compare choices arrays
function choicesChanged(choicesA: APIApplicationCommandOptionChoice[], choicesB: APIApplicationCommandOptionChoice[]): boolean {
    if (choicesA.length !== choicesB.length) return true;
    if (choicesA.length === 0) return false; // Both empty

    const sortedA = [...choicesA].sort((a, b) => a.name.localeCompare(b.name));
    const sortedB = [...choicesB].sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < sortedA.length; i++) {
        const choiceA = sortedA[i];
        const choiceB = sortedB[i];

        if (choiceA.name !== choiceB.name || choiceA.value !== choiceB.value) return true;
        // Compare localizations for choices - FIX: Use correct snake_case key
        if (compareLocalizations(choiceA.name_localizations, choiceB.name_localizations)) return true;
    }
    return false;
}

/**
 * Helper function to compare localization objects.
 * Performs a deep comparison.
 * @param localesA Localization map from object A (can be API format or payload format)
 * @param localesB Localization map from object B (can be API format or payload format)
 * @returns True if localizations differ.
 */
function compareLocalizations(localesA: LocalizationMap, localesB: LocalizationMap): boolean {
    const normA = localesA ?? {}; // Normalize null/undefined to {}
    const normB = localesB ?? {}; // Normalize null/undefined to {}

    const keysA = Object.keys(normA) as Locale[];
    const keysB = Object.keys(normB) as Locale[];

    // Check if the number of localized languages is different
    if (keysA.length !== keysB.length) return true;

    // Check if the values for each locale match
    for (const locale of keysA) {
        // Ensure locale exists in B and values match (handle null explicitly)
        if (!normB.hasOwnProperty(locale) || normA[locale] !== normB[locale]) {
            return true; // Locale missing in B or value differs
        }
    }

    // If all checks pass, the localizations are the same
    return false;
}

/**
 * Compare integration_types arrays.
 * Default is [GuildInstall] if not specified.
 */
function compareIntegrationTypes(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingTypes = existing.integrationTypes ?? [ApplicationIntegrationType.GuildInstall];
    const newTypes = (payload as any).integration_types ?? [ApplicationIntegrationType.GuildInstall];

    if (existingTypes.length !== newTypes.length) return true;

    const sortedExisting = [...existingTypes].sort();
    const sortedNew = [...newTypes].sort();

    for (let i = 0; i < sortedExisting.length; i++) {
        if (sortedExisting[i] !== sortedNew[i]) return true;
    }

    return false;
}

/**
 * Compare contexts arrays.
 * Default is [Guild] if not specified.
 */
function compareContexts(existing: ApplicationCommand, payload: CommandPayload): boolean {
    const existingContexts = existing.contexts ?? [InteractionContextType.Guild];
    const newContexts = (payload as any).contexts ?? [InteractionContextType.Guild];

    if (existingContexts.length !== newContexts.length) return true;

    const sortedExisting = [...existingContexts].sort();
    const sortedNew = [...newContexts].sort();

    for (let i = 0; i < sortedExisting.length; i++) {
        if (sortedExisting[i] !== sortedNew[i]) return true;
    }

    return false;
}

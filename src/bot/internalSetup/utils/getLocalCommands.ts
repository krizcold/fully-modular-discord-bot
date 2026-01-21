import { getModuleRegistry } from './moduleRegistry';
import * as fs from 'fs';
import * as path from 'path';

const isProd = process.env.NODE_ENV !== 'development';

/**
 * Retrieves all commands from loaded modules and internal commands.
 * Excludes any commands whose names appear in the exceptions list.
 *
 * @param exceptions - A list of command names to exclude.
 * @returns An array of command objects from all loaded modules and internal commands.
 */
export default function getLocalCommands(exceptions: string[] = []): any[] {
  const localCommands: any[] = [];

  // Load internal commands from internalSetup/commands
  try {
    const internalCommandsDir = path.join(__dirname, '..', 'commands');
    if (fs.existsSync(internalCommandsDir)) {
      const fileExtension = isProd ? '.js' : '.ts';
      const files = fs.readdirSync(internalCommandsDir)
        .filter(file => file.endsWith(fileExtension) && !file.endsWith('.disabled' + fileExtension));

      for (const file of files) {
        try {
          const filePath = path.join(internalCommandsDir, file);
          // Clear cache in development for hot-reloading
          if (!isProd) {
            delete require.cache[require.resolve(filePath)];
          }
          const command = require(filePath);
          const commandDef = command.default || command;

          if (commandDef && commandDef.name && !exceptions.includes(commandDef.name)) {
            localCommands.push(commandDef);
          }
        } catch (error) {
          console.error(`[getLocalCommands] Error loading internal command ${file}:`, error);
        }
      }

      if (localCommands.length > 0) {
        console.log(`[getLocalCommands] Loaded ${localCommands.length} internal commands`);
      }
    }
  } catch (error) {
    console.error('[getLocalCommands] Error loading internal commands:', error);
  }

  // Load module commands
  try {
    const registry = getModuleRegistry();
    const modules = registry.getAllModules();
    let moduleCommandCount = 0;

    for (const module of modules) {
      for (const command of module.commands) {
        if (command && command.name && !exceptions.includes(command.name)) {
          localCommands.push(command);
          moduleCommandCount++;
        }
      }
    }

    if (modules.length > 0) {
      console.log(`[getLocalCommands] Loaded ${moduleCommandCount} commands from ${modules.length} modules`);
    }

    // Check for duplicate command names
    const finalNames = localCommands.map(cmd => cmd.name);
    if (new Set(finalNames).size !== finalNames.length) {
      console.warn(`[getLocalCommands] WARNING: Duplicate command names detected! Check module command definitions.`);
    }
  } catch (error) {
    console.error('[getLocalCommands] Error loading commands from modules:', error);
  }

  return localCommands;
}

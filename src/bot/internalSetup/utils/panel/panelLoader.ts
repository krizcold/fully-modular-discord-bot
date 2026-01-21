// Panel Loader - Handles loading and validation of panel modules

import { Client } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import getAllFiles from '../getAllFiles';
import { PanelOptions } from '../../../types/panelTypes';
import { getModulesWithSettings, createAllSettingsPanels } from '../settings';

/**
 * Loads panels from bot directories and validates them
 */
export class PanelLoader {
  private client: Client;
  private panels: Map<string, PanelOptions>;

  constructor(client: Client, panels: Map<string, PanelOptions>) {
    this.client = client;
    this.panels = panels;
  }

  /**
   * Load all panels from internal system panels directory
   * Note: Module panels are loaded by ModuleLoader and registered separately
   */
  public async loadPanels(): Promise<void> {
    console.log('[PanelLoader] Loading system panels...');

    const projectRoot = path.join(__dirname, '..', '..', '..', '..', '..');
    const isProd = process.env.NODE_ENV !== 'development';
    const scanRoot = isProd ? 'dist' : 'src';

    const systemPanelsDir = path.join(projectRoot, scanRoot, 'bot', 'internalSetup', 'panels');

    // Load system panels
    if (fs.existsSync(systemPanelsDir)) {
      await this.loadPanelsFromDirectory(systemPanelsDir, 'system');
    } else {
      console.warn('[PanelLoader] System panels directory not found');
    }

    console.log(`[PanelLoader] Loaded ${this.panels.size} system panels`);

    // Load settings panels for modules with settingsSchema.json
    await this.loadSettingsPanels();
  }

  /**
   * Load settings panels for modules with settingsSchema.json
   */
  private async loadSettingsPanels(): Promise<void> {
    const modulesWithSettings = getModulesWithSettings();

    if (modulesWithSettings.length === 0) {
      console.log('[PanelLoader] No modules with settings schemas found');
      return;
    }

    console.log(`[PanelLoader] Creating settings panels for ${modulesWithSettings.length} modules...`);

    const settingsPanels = createAllSettingsPanels(modulesWithSettings);

    for (const panel of settingsPanels) {
      if (this.isValidPanel(panel)) {
        console.log(`[PanelLoader] Loading settings panel: ${panel.id}`);
        this.panels.set(panel.id, panel);

        if (typeof panel.initialize === 'function') {
          try {
            panel.initialize(this.client);
          } catch (error) {
            console.error(`[PanelLoader] Error initializing settings panel ${panel.id}:`, error);
          }
        }
      }
    }

    console.log(`[PanelLoader] Total panels loaded: ${this.panels.size}`);
  }

  /**
   * Load panels from a specific directory
   */
  private async loadPanelsFromDirectory(directory: string, type: 'system'): Promise<void> {
    const panelFiles = getAllFiles(directory, false);

    for (const file of panelFiles) {
      if (file.split(path.sep).includes('disabled')) continue;

      try {
        delete require.cache[require.resolve(file)];
        const panelModule = require(file);
        const panel: PanelOptions = panelModule.default || panelModule;

        if (this.isValidPanel(panel)) {
          console.log(`[PanelLoader] Loading ${type} panel: ${panel.id}`);
          this.panels.set(panel.id, panel);

          // Initialize if needed
          if (typeof panel.initialize === 'function') {
            try {
              panel.initialize(this.client);
            } catch (error) {
              console.error(`[PanelLoader] Error initializing panel ${panel.id}:`, error);
            }
          }
        } else {
          console.warn(`[PanelLoader] Invalid panel in file: ${file}`);
        }
      } catch (error) {
        console.error(`[PanelLoader] Error loading panel from ${file}:`, error);
      }
    }
  }

  /**
   * Validate panel structure
   */
  private isValidPanel(panel: any): panel is PanelOptions {
    return (
      panel &&
      typeof panel === 'object' &&
      typeof panel.id === 'string' &&
      typeof panel.name === 'string' &&
      typeof panel.description === 'string' &&
      typeof panel.callback === 'function'
    );
  }
}

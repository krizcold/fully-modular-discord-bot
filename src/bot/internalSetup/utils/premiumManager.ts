/**
 * Premium Manager
 *
 * Manages guild premium tiers and their setting overrides.
 * Bot owners define tiers with module-specific setting overrides.
 * Guilds are assigned to tiers, and the overrides are applied
 * in the config merge hierarchy.
 *
 * Config file: /data/global/premium-tiers.json
 */

import fs from 'fs';
import path from 'path';
import { ensureDir } from './pathHelpers';

/** Individual tier definition */
export interface PremiumTier {
  /** Human-readable tier name */
  displayName: string;

  /** Priority for tier ordering (higher = more premium) */
  priority: number;

  /** Module-specific setting overrides */
  overrides: Record<string, Record<string, any>>;
}

/** Premium tiers configuration */
export interface PremiumConfig {
  /** All tier definitions keyed by tier ID */
  tiers: Record<string, PremiumTier>;

  /** Guild ID to tier ID mapping */
  guildAssignments: Record<string, string>;
}

/** Default configuration with free tier */
const DEFAULT_CONFIG: PremiumConfig = {
  tiers: {
    free: {
      displayName: 'Free',
      priority: 0,
      overrides: {}
    }
  },
  guildAssignments: {}
};

const CONFIG_PATH = '/data/global/premium-tiers.json';

/** Singleton instance */
let instance: PremiumManager | null = null;

/**
 * Premium Manager - Manages guild premium tiers
 */
export class PremiumManager {
  private config: PremiumConfig;
  private configLoaded: boolean = false;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Load configuration from disk
   */
  load(): void {
    try {
      ensureDir(path.dirname(CONFIG_PATH));

      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const loaded = JSON.parse(content) as PremiumConfig;

        // Merge with defaults to ensure all required fields exist
        this.config = {
          tiers: {
            ...DEFAULT_CONFIG.tiers,
            ...loaded.tiers
          },
          guildAssignments: loaded.guildAssignments || {}
        };
      } else {
        // Create default config file
        this.save();
      }

      this.configLoaded = true;
    } catch (error) {
      console.error('[PremiumManager] Failed to load config:', error);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Save configuration to disk
   */
  save(): boolean {
    try {
      ensureDir(path.dirname(CONFIG_PATH));
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
      return true;
    } catch (error) {
      console.error('[PremiumManager] Failed to save config:', error);
      return false;
    }
  }

  /**
   * Ensure config is loaded
   */
  private ensureLoaded(): void {
    if (!this.configLoaded) {
      this.load();
    }
  }

  // ============================================================================
  // TIER MANAGEMENT
  // ============================================================================

  /**
   * Get all tier definitions
   */
  getAllTiers(): Record<string, PremiumTier> {
    this.ensureLoaded();
    return { ...this.config.tiers };
  }

  /**
   * Get a specific tier definition
   */
  getTier(tierId: string): PremiumTier | null {
    this.ensureLoaded();
    return this.config.tiers[tierId] || null;
  }

  /**
   * Create or update a tier
   */
  setTier(tierId: string, tier: PremiumTier): boolean {
    this.ensureLoaded();
    this.config.tiers[tierId] = tier;
    return this.save();
  }

  /**
   * Delete a tier (cannot delete 'free' tier)
   */
  deleteTier(tierId: string): boolean {
    this.ensureLoaded();

    if (tierId === 'free') {
      console.error('[PremiumManager] Cannot delete the free tier');
      return false;
    }

    if (!this.config.tiers[tierId]) {
      return false;
    }

    // Reassign any guilds using this tier to 'free'
    for (const [guildId, assignedTier] of Object.entries(this.config.guildAssignments)) {
      if (assignedTier === tierId) {
        this.config.guildAssignments[guildId] = 'free';
      }
    }

    delete this.config.tiers[tierId];
    return this.save();
  }

  /**
   * Get tiers sorted by priority (ascending)
   */
  getTiersSortedByPriority(): Array<{ id: string; tier: PremiumTier }> {
    this.ensureLoaded();

    return Object.entries(this.config.tiers)
      .map(([id, tier]) => ({ id, tier }))
      .sort((a, b) => a.tier.priority - b.tier.priority);
  }

  // ============================================================================
  // GUILD ASSIGNMENT
  // ============================================================================

  /**
   * Get the tier ID for a guild (defaults to 'free')
   */
  getGuildTierId(guildId: string): string {
    this.ensureLoaded();
    return this.config.guildAssignments[guildId] || 'free';
  }

  /**
   * Get the tier definition for a guild
   */
  getGuildTier(guildId: string): PremiumTier {
    const tierId = this.getGuildTierId(guildId);
    const tier = this.getTier(tierId);
    return tier || this.config.tiers.free;
  }

  /**
   * Assign a guild to a tier
   */
  setGuildTier(guildId: string, tierId: string): boolean {
    this.ensureLoaded();

    // Validate tier exists
    if (!this.config.tiers[tierId]) {
      console.error(`[PremiumManager] Tier "${tierId}" does not exist`);
      return false;
    }

    // Remove assignment if setting to 'free' (no need to store default)
    if (tierId === 'free') {
      delete this.config.guildAssignments[guildId];
    } else {
      this.config.guildAssignments[guildId] = tierId;
    }

    return this.save();
  }

  /**
   * Remove tier assignment from a guild (resets to free)
   */
  removeGuildTier(guildId: string): boolean {
    this.ensureLoaded();

    if (!this.config.guildAssignments[guildId]) {
      return true; // Already on free tier
    }

    delete this.config.guildAssignments[guildId];
    return this.save();
  }

  /**
   * Get all guild assignments
   */
  getAllGuildAssignments(): Record<string, string> {
    this.ensureLoaded();
    return { ...this.config.guildAssignments };
  }

  /**
   * Get all guilds assigned to a specific tier
   */
  getGuildsByTier(tierId: string): string[] {
    this.ensureLoaded();

    if (tierId === 'free') {
      // Return all guilds NOT explicitly assigned to another tier
      // This is a special case - we don't track 'free' assignments
      return [];
    }

    return Object.entries(this.config.guildAssignments)
      .filter(([_, tier]) => tier === tierId)
      .map(([guildId]) => guildId);
  }

  // ============================================================================
  // SETTING OVERRIDES
  // ============================================================================

  /**
   * Get tier overrides for a specific module and guild
   * Returns empty object if no overrides exist
   */
  getTierOverrides(guildId: string, moduleName: string): Record<string, any> {
    const tier = this.getGuildTier(guildId);
    return tier.overrides[moduleName] || {};
  }

  /**
   * Check if a guild has access to a premium feature
   * Returns true if the guild's tier priority is >= required priority
   */
  hasFeatureAccess(guildId: string, requiredPriority: number): boolean {
    const tier = this.getGuildTier(guildId);
    return tier.priority >= requiredPriority;
  }

  /**
   * Get the full config for display
   */
  getFullConfig(): PremiumConfig {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Set the full config (for import/restore)
   */
  setFullConfig(config: PremiumConfig): boolean {
    // Validate structure
    if (!config.tiers || typeof config.tiers !== 'object') {
      return false;
    }

    // Ensure free tier exists
    if (!config.tiers.free) {
      config.tiers.free = DEFAULT_CONFIG.tiers.free;
    }

    this.config = config;
    return this.save();
  }
}

/**
 * Get the singleton PremiumManager instance
 */
export function getPremiumManager(): PremiumManager {
  if (!instance) {
    instance = new PremiumManager();
    instance.load();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetPremiumManager(): void {
  instance = null;
}

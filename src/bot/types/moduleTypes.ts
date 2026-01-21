import { Client } from 'discord.js';

/**
 * Configuration field schema - defines a single configuration property
 */
export interface ConfigFieldSchema {
  /** Field type for validation */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';

  /** Default value for this field */
  default: any;

  /** Human-readable description */
  description?: string;

  /** Whether this field is required */
  required?: boolean;

  /** For nested objects, define the schema of child properties */
  properties?: Record<string, ConfigFieldSchema>;
}

/**
 * Module configuration schema - defines all possible config keys for a module
 */
export interface ModuleConfigSchema {
  /** Configuration file ID (used for file naming) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this config controls */
  description: string;

  /** Schema for each configuration property */
  properties: Record<string, ConfigFieldSchema>;
}

/**
 * Data file schema - defines a single data file used by a module
 */
export interface DataFileSchema {
  /** Data file ID (used for file naming, e.g., "giveaways.json") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this data file stores */
  description: string;

  /** Whether this data file is required for the module to function */
  required: boolean;

  /** Scope of the data file */
  scope: 'guild' | 'global' | 'both';

  /** Template/default structure for creating the file */
  template?: any;
}

/**
 * Module data schema - defines all data files used by a module
 */
export interface ModuleDataSchema {
  /** Array of data file definitions */
  files: DataFileSchema[];
}

/**
 * API credential field - defines a single credential input for premium modules
 */
export interface ApiCredentialField {
  /** Field type */
  type: 'string' | 'select';

  /** Whether this credential is required */
  required: boolean;

  /** Human-readable description shown to user */
  description: string;

  /** Placeholder text for input fields */
  placeholder?: string;

  /** For 'select' type: available options */
  options?: string[];

  /** Default value */
  default?: string;

  /** Conditional visibility based on other field values */
  dependsOn?: Record<string, string>;
}

/**
 * API credentials schema - defines all credentials needed by a premium module
 */
export interface ApiCredentialsSchema {
  /** Schema for each credential field */
  schema: Record<string, ApiCredentialField>;
}

/**
 * Module manifest schema - defines module metadata and configuration
 */
export interface ModuleManifest {
  /** Unique module identifier (kebab-case) */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Human-readable module name */
  displayName: string;

  /** Brief description of module functionality */
  description: string;

  /** Module author name */
  author: string;

  /** Category folder (fun, misc, moderation, system) */
  category: 'fun' | 'misc' | 'moderation' | 'system' | (string & {});

  /** Discord gateway intents required by this module */
  requiredIntents?: string[];

  /** Discord permissions required by this module */
  requiredPermissions?: string[];

  /** Module dependencies */
  dependencies?: {
    /** Required modules (bot will fail to load if missing) */
    required?: Record<string, string>;

    /** Optional modules (features gracefully degrade if missing) */
    optional?: Record<string, string>;
  };

  /** Module-specific configuration with defaults */
  config?: Record<string, any>;

  /** Configuration schema for this module (defines all possible config keys) */
  configSchema?: ModuleConfigSchema;

  /** Data schema for this module (defines all data files used by module) */
  dataSchema?: ModuleDataSchema;

  /** Whether module is enabled (default: true) */
  enabled?: boolean;

  /** Exported functions/classes for cross-module communication */
  exports?: Record<string, string>;

  /** Whether this is a premium module requiring API credentials */
  premium?: boolean;

  /** API credentials schema for premium modules (shown during App Store install) */
  apiCredentials?: ApiCredentialsSchema;
}

/**
 * Loaded module metadata with resolved paths
 */
export interface LoadedModule {
  /** Module manifest data */
  manifest: ModuleManifest;

  /** Absolute path to module directory */
  path: string;

  /** Loaded commands from this module */
  commands: any[];

  /** Loaded event handlers from this module */
  events: Map<string, Function[]>;

  /** Loaded panels from this module */
  panels: any[];

  /** Module exports for cross-module communication */
  exports: Map<string, any>;

  /** Whether module is initialized */
  initialized: boolean;
}

/**
 * Module export definition
 * Format: "path/to/file.ts#exportName"
 */
export interface ModuleExport {
  /** Module name */
  moduleName: string;

  /** Export name */
  exportName: string;

  /** File path relative to module root */
  filePath: string;

  /** Loaded export value */
  value?: any;
}

/**
 * Module initialization context
 */
export interface ModuleContext {
  /** Discord client instance */
  client: Client;

  /** Module manifest */
  manifest: ModuleManifest;

  /** Module directory path */
  modulePath: string;

  /** Module-specific data directory path */
  dataPath: string;
}

/**
 * Module lifecycle hooks
 */
export interface ModuleHooks {
  /** Called after module is loaded, before commands/events are registered */
  onLoad?: (context: ModuleContext) => void | Promise<void>;

  /** Called after all modules are loaded and registered */
  onReady?: (context: ModuleContext) => void | Promise<void>;

  /** Called when module is being unloaded (hot-reload) */
  onUnload?: (context: ModuleContext) => void | Promise<void>;
}

/**
 * Module validation result
 */
export interface ModuleValidationResult {
  /** Whether module is valid */
  valid: boolean;

  /** Validation errors */
  errors: string[];

  /** Validation warnings */
  warnings: string[];
}

/**
 * Module dependency resolution result
 */
export interface ModuleDependencyGraph {
  /** Modules in load order (topological sort) */
  loadOrder: string[];

  /** Dependency relationships */
  dependencies: Map<string, string[]>;

  /** Circular dependency errors */
  circularDependencies: string[][];

  /** Missing required dependencies */
  missingDependencies: Array<{ module: string; dependency: string }>;
}

/**
 * Data file metadata - used for data discovery and browsing
 * Similar to ConfigFileMetadata but for data files
 */
export interface DataFileMetadata {
  /** Data file ID (filename) */
  id: string;

  /** Full path to the data file */
  path: string;

  /** Human-readable name */
  name: string;

  /** Description of what this data file stores */
  description: string;

  /** File category */
  category: 'data';

  /** Whether the file actually exists on disk */
  exists: boolean;

  /** Whether this file is required for module functionality */
  required: boolean;

  /** Template/default structure */
  template?: any;

  /** Scope of the data file */
  scope: 'guild' | 'global' | 'both';

  /** Module name this data file belongs to */
  moduleName: string;

  /** Original schema definition */
  schema?: DataFileSchema;
}

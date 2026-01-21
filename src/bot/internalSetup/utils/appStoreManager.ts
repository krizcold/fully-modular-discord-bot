/**
 * App Store Manager
 *
 * Manages App Store repositories, module discovery, installation, and credentials.
 * Repositories are GitHub repos containing modules in a Modules/ folder.
 * No index file needed - modules are discovered by scanning for module.json files.
 *
 * Config files:
 * - /data/global/appstore/repos.json - Repository configuration
 * - /data/global/appstore/installed.json - Installed modules tracking
 * - /data/global/appstore/credentials/{moduleName}.json - Module API credentials
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { ModuleManifest } from '../../types/moduleTypes';
import { ensureDir, getModulesDir } from './pathHelpers';

// ============================================================================
// TYPES
// ============================================================================

/** App Store repository configuration */
export interface AppStoreRepository {
  /** Unique repository ID */
  id: string;

  /** Human-readable repository name */
  name: string;

  /** GitHub repository URL */
  url: string;

  /** Branch to use (default: main) */
  branch: string;

  /** GitHub personal access token for private repos (optional) */
  githubToken?: string | null;

  /** Whether this repository is enabled */
  enabled: boolean;

  /** Last time modules were refreshed from this repo */
  lastRefreshed: string | null;
}

/** Repository configuration file */
export interface ReposConfig {
  repositories: AppStoreRepository[];
}

/** Information about a module available in the store */
export interface StoreModuleInfo {
  /** Module manifest */
  manifest: ModuleManifest;

  /** Repository ID this module is from */
  repoId: string;

  /** Repository name */
  repoName: string;

  /** Path within repository */
  repoPath: string;

  /** Whether this module is already installed */
  installed: boolean;

  /** Installed version (if installed) */
  installedVersion?: string;
}

/** Installed module tracking */
export interface InstalledModule {
  /** Module name */
  name: string;

  /** Installed version */
  version: string;

  /** Repository ID it was installed from */
  installedFrom: string;

  /** Installation timestamp */
  installedAt: string;
}

/** Installed modules tracking file */
export interface InstalledConfig {
  modules: Record<string, InstalledModule>;
}

/** Result of checking a single module for updates */
export interface ModuleUpdateCheck {
  moduleName: string;
  installedVersion: string;
  availableVersion: string;
  hasUpdate: boolean;
  repoId: string;
  repoName: string;
}

/** Result of checking all modules for updates */
export interface ModuleUpdatesResult {
  /** Whether the check operation completed (true even with partial errors) */
  success: boolean;
  /** Number of modules successfully checked */
  checked: number;
  /** Number of modules with available updates */
  updatesAvailable: number;
  /** Update info for each checked module */
  updates: ModuleUpdateCheck[];
  /** Errors encountered during checking */
  errors: Array<{ moduleName: string; error: string }>;
  /** Whether any errors occurred (for easy checking) */
  hasErrors: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const APPSTORE_DIR = '/data/global/appstore';
const REPOS_CONFIG_PATH = path.join(APPSTORE_DIR, 'repos.json');
const INSTALLED_CONFIG_PATH = path.join(APPSTORE_DIR, 'installed.json');
const CREDENTIALS_DIR = path.join(APPSTORE_DIR, 'credentials');
const CACHE_DIR = path.join(APPSTORE_DIR, 'cache');

const DEFAULT_REPOS_CONFIG: ReposConfig = {
  repositories: []
};

const DEFAULT_INSTALLED_CONFIG: InstalledConfig = {
  modules: {}
};

// ============================================================================
// VALIDATION HELPERS (prevent command injection)
// ============================================================================

/**
 * Validate a repository URL to prevent command injection.
 * Only allows HTTPS URLs from known git hosting providers.
 */
function validateRepoUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Repository URL must use HTTPS protocol' };
    }

    // Allowlist of known git hosting providers
    const allowedHosts = [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
      'codeberg.org',
      'gitea.com',
      'sr.ht'
    ];

    const hostname = parsed.hostname.toLowerCase();
    const isAllowedHost = allowedHosts.some(host =>
      hostname === host || hostname.endsWith('.' + host)
    );

    if (!isAllowedHost) {
      return { valid: false, error: `Repository host '${hostname}' is not in the allowed list` };
    }

    // Path should not contain suspicious characters
    const suspiciousChars = /[;&|`$(){}[\]<>!]/;
    if (suspiciousChars.test(parsed.pathname)) {
      return { valid: false, error: 'Repository URL contains invalid characters' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid repository URL format' };
  }
}

/**
 * Validate a branch name to prevent command injection.
 * Only allows safe characters in branch names.
 */
function validateBranchName(branch: string): { valid: boolean; error?: string } {
  // Branch names should only contain alphanumeric, hyphen, underscore, slash, dot
  // Must not start with - or contain ..
  const validBranchPattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

  if (!branch || branch.length === 0) {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  if (branch.length > 255) {
    return { valid: false, error: 'Branch name too long' };
  }

  if (branch.includes('..')) {
    return { valid: false, error: 'Branch name cannot contain ".."' };
  }

  if (!validBranchPattern.test(branch)) {
    return { valid: false, error: 'Branch name contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Validate repository configuration before git operations
 */
function validateRepoConfig(repo: AppStoreRepository): { valid: boolean; error?: string } {
  const urlValidation = validateRepoUrl(repo.url);
  if (!urlValidation.valid) {
    return urlValidation;
  }

  const branchValidation = validateBranchName(repo.branch);
  if (!branchValidation.valid) {
    return branchValidation;
  }

  return { valid: true };
}

// ============================================================================
// SINGLETON
// ============================================================================

let instance: AppStoreManager | null = null;

/**
 * App Store Manager - Manages repositories, modules, and credentials
 */
export class AppStoreManager {
  private reposConfig: ReposConfig;
  private installedConfig: InstalledConfig;
  private moduleCache: Map<string, StoreModuleInfo[]> = new Map();

  /** Tracks modules currently being updated to prevent concurrent updates */
  private updatesInProgress: Set<string> = new Set();

  constructor() {
    this.reposConfig = { ...DEFAULT_REPOS_CONFIG };
    this.installedConfig = { ...DEFAULT_INSTALLED_CONFIG };
    this.load();
  }

  /**
   * Load configuration from disk
   */
  load(): void {
    try {
      ensureDir(APPSTORE_DIR);
      ensureDir(CREDENTIALS_DIR);
      ensureDir(CACHE_DIR);

      // Load repos config
      if (fs.existsSync(REPOS_CONFIG_PATH)) {
        const content = fs.readFileSync(REPOS_CONFIG_PATH, 'utf-8');
        this.reposConfig = JSON.parse(content);
      } else {
        this.saveRepos();
      }

      // Load installed config
      if (fs.existsSync(INSTALLED_CONFIG_PATH)) {
        const content = fs.readFileSync(INSTALLED_CONFIG_PATH, 'utf-8');
        this.installedConfig = JSON.parse(content);
      } else {
        this.saveInstalled();
      }
    } catch (error) {
      console.error('[AppStoreManager] Failed to load config:', error);
    }
  }

  /**
   * Save repos configuration
   */
  private saveRepos(): boolean {
    try {
      ensureDir(APPSTORE_DIR);
      fs.writeFileSync(REPOS_CONFIG_PATH, JSON.stringify(this.reposConfig, null, 2));
      return true;
    } catch (error) {
      console.error('[AppStoreManager] Failed to save repos config:', error);
      return false;
    }
  }

  /**
   * Save installed configuration
   */
  private saveInstalled(): boolean {
    try {
      ensureDir(APPSTORE_DIR);
      fs.writeFileSync(INSTALLED_CONFIG_PATH, JSON.stringify(this.installedConfig, null, 2));
      return true;
    } catch (error) {
      console.error('[AppStoreManager] Failed to save installed config:', error);
      return false;
    }
  }

  // ============================================================================
  // REPOSITORY MANAGEMENT
  // ============================================================================

  /**
   * Get all repositories
   */
  getRepositories(): AppStoreRepository[] {
    return [...this.reposConfig.repositories];
  }

  /**
   * Get a repository by ID
   */
  getRepository(id: string): AppStoreRepository | null {
    return this.reposConfig.repositories.find(r => r.id === id) || null;
  }

  /**
   * Add a new repository
   */
  addRepository(
    name: string,
    url: string,
    branch: string = 'main',
    githubToken?: string
  ): AppStoreRepository {
    const normalizedUrl = this.normalizeGitUrl(url);

    // Validate URL before storing
    const urlValidation = validateRepoUrl(normalizedUrl);
    if (!urlValidation.valid) {
      throw new Error(`Invalid repository URL: ${urlValidation.error}`);
    }

    // Validate branch name
    const branchValidation = validateBranchName(branch);
    if (!branchValidation.valid) {
      throw new Error(`Invalid branch name: ${branchValidation.error}`);
    }

    const repo: AppStoreRepository = {
      id: crypto.randomUUID(),
      name,
      url: normalizedUrl,
      branch,
      githubToken: githubToken || null,
      enabled: true,
      lastRefreshed: null
    };

    this.reposConfig.repositories.push(repo);
    this.saveRepos();

    return repo;
  }

  /**
   * Update a repository
   */
  updateRepository(id: string, updates: Partial<AppStoreRepository>): boolean {
    const index = this.reposConfig.repositories.findIndex(r => r.id === id);
    if (index === -1) return false;

    // Validate URL if being updated
    if (updates.url) {
      const urlValidation = validateRepoUrl(updates.url);
      if (!urlValidation.valid) {
        throw new Error(`Invalid repository URL: ${urlValidation.error}`);
      }
    }

    // Validate branch if being updated
    if (updates.branch) {
      const branchValidation = validateBranchName(updates.branch);
      if (!branchValidation.valid) {
        throw new Error(`Invalid branch name: ${branchValidation.error}`);
      }
    }

    this.reposConfig.repositories[index] = {
      ...this.reposConfig.repositories[index],
      ...updates,
      id // Ensure ID cannot be changed
    };

    return this.saveRepos();
  }

  /**
   * Remove a repository
   */
  removeRepository(id: string): boolean {
    const index = this.reposConfig.repositories.findIndex(r => r.id === id);
    if (index === -1) return false;

    this.reposConfig.repositories.splice(index, 1);

    // Clear cache for this repo
    this.moduleCache.delete(id);

    // Clean up cached repo files
    const cacheDir = path.join(CACHE_DIR, id);
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    return this.saveRepos();
  }

  /**
   * Normalize GitHub URL to HTTPS format
   */
  private normalizeGitUrl(url: string): string {
    // Convert SSH to HTTPS
    if (url.startsWith('git@github.com:')) {
      url = url.replace('git@github.com:', 'https://github.com/');
    }

    // Remove .git suffix if present
    if (url.endsWith('.git')) {
      url = url.slice(0, -4);
    }

    return url;
  }

  // ============================================================================
  // MODULE DISCOVERY
  // ============================================================================

  /**
   * Refresh modules from a repository
   * Clones/pulls the repo and scans for module.json files
   */
  async refreshRepository(repoId: string): Promise<StoreModuleInfo[]> {
    const repo = this.getRepository(repoId);
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`);
    }

    const cacheDir = path.join(CACHE_DIR, repoId);
    ensureDir(cacheDir);

    try {
      // Clone or pull the repository
      if (fs.existsSync(path.join(cacheDir, '.git'))) {
        // Pull latest
        this.gitPull(cacheDir, repo);
      } else {
        // Clone
        this.gitClone(repo, cacheDir);
      }

      // Scan for modules
      const modules = this.scanForModules(cacheDir, repo);

      // Update cache
      this.moduleCache.set(repoId, modules);

      // Update last refreshed timestamp
      this.updateRepository(repoId, {
        lastRefreshed: new Date().toISOString()
      });

      return modules;
    } catch (error) {
      console.error(`[AppStoreManager] Failed to refresh repository ${repoId}:`, error);
      throw error;
    }
  }

  /**
   * Clone a repository
   */
  private gitClone(repo: AppStoreRepository, targetDir: string): void {
    // Validate repo config to prevent command injection
    const validation = validateRepoConfig(repo);
    if (!validation.valid) {
      throw new Error(`Invalid repository configuration: ${validation.error}`);
    }

    let cloneUrl = repo.url;

    // Add token for private repos
    if (repo.githubToken) {
      const urlObj = new URL(repo.url);
      urlObj.username = repo.githubToken;
      cloneUrl = urlObj.toString();
    }

    execSync(`git clone --depth 1 --branch "${repo.branch}" "${cloneUrl}" "${targetDir}"`, {
      stdio: 'pipe'
    });
  }

  /**
   * Pull latest from a repository
   */
  private gitPull(repoDir: string, repo: AppStoreRepository): void {
    // Validate repo config to prevent command injection
    const validation = validateRepoConfig(repo);
    if (!validation.valid) {
      throw new Error(`Invalid repository configuration: ${validation.error}`);
    }

    // Set credentials if needed
    if (repo.githubToken) {
      const urlObj = new URL(repo.url);
      urlObj.username = repo.githubToken;
      execSync(`git remote set-url origin "${urlObj.toString()}"`, {
        cwd: repoDir,
        stdio: 'pipe'
      });
    }

    execSync(`git fetch origin "${repo.branch}" && git reset --hard "origin/${repo.branch}"`, {
      cwd: repoDir,
      stdio: 'pipe'
    });
  }

  /**
   * Scan a repository for modules
   */
  private scanForModules(repoDir: string, repo: AppStoreRepository): StoreModuleInfo[] {
    const modules: StoreModuleInfo[] = [];

    // Look for Modules/ directory (case-insensitive)
    let modulesDir: string | null = null;
    const entries = fs.readdirSync(repoDir);

    for (const entry of entries) {
      if (entry.toLowerCase() === 'modules') {
        modulesDir = path.join(repoDir, entry);
        break;
      }
    }

    if (!modulesDir || !fs.existsSync(modulesDir)) {
      console.warn(`[AppStoreManager] No Modules/ directory found in ${repo.name}`);
      return modules;
    }

    // Scan for module directories
    const moduleFolders = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);

    for (const folderName of moduleFolders) {
      const manifestPath = path.join(modulesDir, folderName, 'module.json');

      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as ModuleManifest;

        // Check if installed
        const installed = this.installedConfig.modules[manifest.name];

        modules.push({
          manifest,
          repoId: repo.id,
          repoName: repo.name,
          repoPath: path.join(modulesDir, folderName),
          installed: !!installed,
          installedVersion: installed?.version
        });
      } catch (error) {
        console.error(`[AppStoreManager] Failed to parse module.json for ${folderName}:`, error);
      }
    }

    return modules;
  }

  /**
   * Get all available modules from all enabled repositories
   */
  async getAvailableModules(): Promise<StoreModuleInfo[]> {
    const allModules: StoreModuleInfo[] = [];

    for (const repo of this.reposConfig.repositories) {
      if (!repo.enabled) continue;

      // Use cache if available
      let modules = this.moduleCache.get(repo.id);

      if (!modules) {
        // Refresh if not cached
        try {
          modules = await this.refreshRepository(repo.id);
        } catch (error) {
          console.error(`[AppStoreManager] Failed to get modules from ${repo.name}:`, error);
          continue;
        }
      }

      allModules.push(...modules);
    }

    return allModules;
  }

  /**
   * Get module info by name from cache
   */
  getModuleInfo(moduleName: string): StoreModuleInfo | null {
    for (const [_, modules] of this.moduleCache) {
      const module = modules.find(m => m.manifest.name === moduleName);
      if (module) return module;
    }
    return null;
  }

  // ============================================================================
  // MODULE INSTALLATION
  // ============================================================================

  /**
   * Install a module from the store
   */
  async installModule(moduleName: string, repoId: string): Promise<boolean> {
    const repo = this.getRepository(repoId);
    if (!repo) {
      throw new Error(`Repository ${repoId} not found`);
    }

    // Get module info from cache
    let modules = this.moduleCache.get(repoId);
    let moduleInfo = modules?.find(m => m.manifest.name === moduleName);

    // If not found in cache, try refreshing the repository
    if (!moduleInfo) {
      console.log(`[AppStoreManager] Module ${moduleName} not in cache, refreshing repository...`);
      try {
        await this.refreshRepository(repoId);
        modules = this.moduleCache.get(repoId);
        moduleInfo = modules?.find(m => m.manifest.name === moduleName);
      } catch (refreshError) {
        console.error(`[AppStoreManager] Failed to refresh repository:`, refreshError);
      }
    }

    if (!moduleInfo) {
      throw new Error(`Module ${moduleName} not found in repository ${repo.name}`);
    }

    const targetDir = path.join(getModulesDir(), moduleName);

    // Check if already installed
    if (fs.existsSync(targetDir)) {
      throw new Error(`Module ${moduleName} is already installed`);
    }

    try {
      // Copy module directory
      this.copyDirectory(moduleInfo.repoPath, targetDir);

      // Track installation
      this.installedConfig.modules[moduleName] = {
        name: moduleName,
        version: moduleInfo.manifest.version,
        installedFrom: repoId,
        installedAt: new Date().toISOString()
      };

      this.saveInstalled();

      // Update cache
      moduleInfo.installed = true;
      moduleInfo.installedVersion = moduleInfo.manifest.version;

      console.log(`[AppStoreManager] Installed module: ${moduleName} v${moduleInfo.manifest.version}`);
      return true;
    } catch (error) {
      // Cleanup on failure
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /**
   * Uninstall a module
   */
  async uninstallModule(moduleName: string): Promise<boolean> {
    const installed = this.installedConfig.modules[moduleName];
    if (!installed) {
      throw new Error(`Module ${moduleName} is not installed`);
    }

    const moduleDir = path.join(getModulesDir(), moduleName);

    if (!fs.existsSync(moduleDir)) {
      // Already removed, just update tracking
      delete this.installedConfig.modules[moduleName];
      this.saveInstalled();
      return true;
    }

    try {
      // Remove module directory
      fs.rmSync(moduleDir, { recursive: true, force: true });

      // Remove from tracking
      delete this.installedConfig.modules[moduleName];
      this.saveInstalled();

      // Update cache
      for (const [_, modules] of this.moduleCache) {
        const moduleInfo = modules.find(m => m.manifest.name === moduleName);
        if (moduleInfo) {
          moduleInfo.installed = false;
          moduleInfo.installedVersion = undefined;
        }
      }

      // Remove credentials if any
      this.deleteCredentials(moduleName);

      console.log(`[AppStoreManager] Uninstalled module: ${moduleName}`);
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get all installed modules
   */
  getInstalledModules(): InstalledModule[] {
    return Object.values(this.installedConfig.modules);
  }

  /**
   * Check if a module is installed
   */
  isModuleInstalled(moduleName: string): boolean {
    return !!this.installedConfig.modules[moduleName];
  }

  /**
   * Copy directory recursively
   */
  private copyDirectory(src: string, dest: string): void {
    ensureDir(dest);

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  // ============================================================================
  // CREDENTIALS MANAGEMENT
  // ============================================================================

  /**
   * Save credentials for a module
   */
  saveCredentials(moduleName: string, credentials: Record<string, string>): boolean {
    try {
      ensureDir(CREDENTIALS_DIR);
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
      return true;
    } catch (error) {
      console.error(`[AppStoreManager] Failed to save credentials for ${moduleName}:`, error);
      return false;
    }
  }

  /**
   * Get credentials for a module
   */
  getCredentials(moduleName: string): Record<string, string> | null {
    try {
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      if (!fs.existsSync(credPath)) {
        return null;
      }
      const content = fs.readFileSync(credPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[AppStoreManager] Failed to load credentials for ${moduleName}:`, error);
      return null;
    }
  }

  /**
   * Delete credentials for a module
   */
  deleteCredentials(moduleName: string): boolean {
    try {
      const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
      }
      return true;
    } catch (error) {
      console.error(`[AppStoreManager] Failed to delete credentials for ${moduleName}:`, error);
      return false;
    }
  }

  /**
   * Check if a module has credentials saved
   */
  hasCredentials(moduleName: string): boolean {
    const credPath = path.join(CREDENTIALS_DIR, `${moduleName}.json`);
    return fs.existsSync(credPath);
  }

  // ============================================================================
  // MODULE UPDATE CHECKING
  // ============================================================================

  /**
   * Compare two semver version strings
   * Returns: -1 (v1 < v2), 0 (equal), 1 (v1 > v2)
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const parts2 = v2.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 < p2) return -1;
      if (p1 > p2) return 1;
    }
    return 0;
  }

  /**
   * Check a single installed module for available updates
   */
  async checkModuleForUpdate(moduleName: string): Promise<ModuleUpdateCheck | null> {
    const installed = this.installedConfig.modules[moduleName];
    if (!installed) {
      return null;
    }

    const repo = this.getRepository(installed.installedFrom);
    if (!repo) {
      console.warn(`[AppStoreManager] Repository ${installed.installedFrom} not found for module ${moduleName}`);
      return null;
    }

    try {
      // Refresh the source repository
      await this.refreshRepository(repo.id);

      // Get module info from cache
      const modules = this.moduleCache.get(repo.id);
      const moduleInfo = modules?.find(m => m.manifest.name === moduleName);

      if (!moduleInfo) {
        console.warn(`[AppStoreManager] Module ${moduleName} no longer exists in repository ${repo.name}`);
        return null;
      }

      const hasUpdate = this.compareVersions(installed.version, moduleInfo.manifest.version) < 0;

      return {
        moduleName,
        installedVersion: installed.version,
        availableVersion: moduleInfo.manifest.version,
        hasUpdate,
        repoId: repo.id,
        repoName: repo.name
      };
    } catch (error) {
      console.error(`[AppStoreManager] Failed to check update for ${moduleName}:`, error);
      return null;
    }
  }

  /**
   * Check all installed modules for available updates
   * Groups modules by repository and refreshes each repo only once
   */
  async checkAllModulesForUpdates(): Promise<ModuleUpdatesResult> {
    const result: ModuleUpdatesResult = {
      success: true,
      checked: 0,
      updatesAvailable: 0,
      updates: [],
      errors: [],
      hasErrors: false
    };

    const installedModules = this.getInstalledModules();
    if (installedModules.length === 0) {
      return result;
    }

    // Group modules by repository
    const modulesByRepo = new Map<string, InstalledModule[]>();
    for (const module of installedModules) {
      const repoModules = modulesByRepo.get(module.installedFrom) || [];
      repoModules.push(module);
      modulesByRepo.set(module.installedFrom, repoModules);
    }

    // Process each repository
    for (const [repoId, modules] of modulesByRepo) {
      const repo = this.getRepository(repoId);
      if (!repo) {
        for (const module of modules) {
          result.errors.push({
            moduleName: module.name,
            error: `Repository ${repoId} not found`
          });
        }
        continue;
      }

      // Refresh repository once for all its modules
      try {
        await this.refreshRepository(repoId);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        for (const module of modules) {
          result.errors.push({
            moduleName: module.name,
            error: `Failed to refresh repository: ${errorMsg}`
          });
        }
        continue;
      }

      // Check each module in this repo
      const repoModulesCache = this.moduleCache.get(repoId);
      for (const installed of modules) {
        result.checked++;

        const moduleInfo = repoModulesCache?.find(m => m.manifest.name === installed.name);
        if (!moduleInfo) {
          result.errors.push({
            moduleName: installed.name,
            error: 'Module no longer exists in repository'
          });
          continue;
        }

        const hasUpdate = this.compareVersions(installed.version, moduleInfo.manifest.version) < 0;
        const updateCheck: ModuleUpdateCheck = {
          moduleName: installed.name,
          installedVersion: installed.version,
          availableVersion: moduleInfo.manifest.version,
          hasUpdate,
          repoId: repo.id,
          repoName: repo.name
        };

        result.updates.push(updateCheck);
        if (hasUpdate) {
          result.updatesAvailable++;
        }
      }
    }

    // Operation completed - success is true even with partial errors
    // hasErrors indicates whether any modules failed to check
    result.hasErrors = result.errors.length > 0;
    result.success = true;
    return result;
  }

  /**
   * Check if a module update is currently in progress
   */
  isUpdateInProgress(moduleName: string): boolean {
    return this.updatesInProgress.has(moduleName);
  }

  /**
   * Check if any module update is currently in progress
   */
  hasAnyUpdateInProgress(): boolean {
    return this.updatesInProgress.size > 0;
  }

  /**
   * Update an installed module to the latest version
   * Backs up current module, uninstalls, reinstalls, and rolls back on failure
   */
  async updateModule(moduleName: string): Promise<{ success: boolean; newVersion?: string; error?: string }> {
    // Prevent concurrent updates to the same module
    if (this.updatesInProgress.has(moduleName)) {
      return { success: false, error: `Update already in progress for ${moduleName}` };
    }

    const installed = this.installedConfig.modules[moduleName];
    if (!installed) {
      return { success: false, error: `Module ${moduleName} is not installed` };
    }

    const repo = this.getRepository(installed.installedFrom);
    if (!repo) {
      return { success: false, error: `Repository ${installed.installedFrom} not found` };
    }

    // Mark update as in progress
    this.updatesInProgress.add(moduleName);

    const moduleDir = path.join(getModulesDir(), moduleName);
    const backupDir = path.join(CACHE_DIR, 'backups', `${moduleName}-${Date.now()}`);

    try {
      // Refresh repo to get latest version
      await this.refreshRepository(repo.id);

      // Get latest module info
      const modules = this.moduleCache.get(repo.id);
      const moduleInfo = modules?.find(m => m.manifest.name === moduleName);

      if (!moduleInfo) {
        return { success: false, error: `Module ${moduleName} no longer exists in repository` };
      }

      // Check if update is actually needed
      if (this.compareVersions(installed.version, moduleInfo.manifest.version) >= 0) {
        return { success: true, newVersion: installed.version };
      }

      // Backup current module
      console.log(`[AppStoreManager] Backing up ${moduleName} to ${backupDir}`);
      ensureDir(path.dirname(backupDir));
      if (fs.existsSync(moduleDir)) {
        this.copyDirectory(moduleDir, backupDir);
      }

      // Uninstall current version (but keep tracking info for rollback)
      const previousInstalled = { ...installed };
      try {
        fs.rmSync(moduleDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[AppStoreManager] Failed to remove old module:`, error);
        return { success: false, error: 'Failed to remove current version' };
      }

      // Install new version
      try {
        this.copyDirectory(moduleInfo.repoPath, moduleDir);

        // Update tracking
        this.installedConfig.modules[moduleName] = {
          name: moduleName,
          version: moduleInfo.manifest.version,
          installedFrom: repo.id,
          installedAt: new Date().toISOString()
        };
        this.saveInstalled();

        // Update cache
        moduleInfo.installed = true;
        moduleInfo.installedVersion = moduleInfo.manifest.version;

        // Clean up backup
        fs.rmSync(backupDir, { recursive: true, force: true });

        console.log(`[AppStoreManager] Updated ${moduleName} from ${previousInstalled.version} to ${moduleInfo.manifest.version}`);
        return { success: true, newVersion: moduleInfo.manifest.version };
      } catch (installError) {
        // Rollback from backup
        console.error(`[AppStoreManager] Install failed, rolling back:`, installError);

        try {
          if (fs.existsSync(backupDir)) {
            fs.rmSync(moduleDir, { recursive: true, force: true });
            this.copyDirectory(backupDir, moduleDir);
          }
          // Restore tracking
          this.installedConfig.modules[moduleName] = previousInstalled;
          this.saveInstalled();
        } catch (rollbackError) {
          console.error(`[AppStoreManager] Rollback failed:`, rollbackError);
        }

        // Clean up backup directory after rollback attempt
        try {
          if (fs.existsSync(backupDir)) {
            fs.rmSync(backupDir, { recursive: true, force: true });
          }
        } catch {
          // Ignore cleanup errors
        }

        return { success: false, error: `Install failed: ${installError instanceof Error ? installError.message : String(installError)}` };
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      // Always release the update lock
      this.updatesInProgress.delete(moduleName);
    }
  }

  /**
   * Update all modules that have available updates
   */
  async updateAllModules(): Promise<{
    success: boolean;
    updated: Array<{ moduleName: string; oldVersion: string; newVersion: string }>;
    failed: Array<{ moduleName: string; error: string }>;
  }> {
    const result = {
      success: true,
      updated: [] as Array<{ moduleName: string; oldVersion: string; newVersion: string }>,
      failed: [] as Array<{ moduleName: string; error: string }>
    };

    // First, check for all updates
    const updateCheck = await this.checkAllModulesForUpdates();
    const modulesWithUpdates = updateCheck.updates.filter(u => u.hasUpdate);

    if (modulesWithUpdates.length === 0) {
      return result;
    }

    // Update each module
    for (const moduleUpdate of modulesWithUpdates) {
      const oldVersion = moduleUpdate.installedVersion;
      const updateResult = await this.updateModule(moduleUpdate.moduleName);

      if (updateResult.success && updateResult.newVersion && updateResult.newVersion !== oldVersion) {
        result.updated.push({
          moduleName: moduleUpdate.moduleName,
          oldVersion,
          newVersion: updateResult.newVersion
        });
      } else if (!updateResult.success) {
        result.failed.push({
          moduleName: moduleUpdate.moduleName,
          error: updateResult.error || 'Unknown error'
        });
        result.success = false;
      }
    }

    return result;
  }
}

/**
 * Get the singleton AppStoreManager instance
 */
export function getAppStoreManager(): AppStoreManager {
  if (!instance) {
    instance = new AppStoreManager();
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetAppStoreManager(): void {
  instance = null;
}

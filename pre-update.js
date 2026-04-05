#!/usr/bin/env node

/**
 * Pre-compilation update script
 *
 * Runs BEFORE TypeScript compilation (called from start.sh).
 * Only executes when a system update is in progress (updateInProgress: true).
 *
 * Behavior:
 * - Updates core system files (internalSetup, utils, types, webui, updater)
 * - Copies missing files from the image source to smdb-source
 * - NEVER touches modules/ or modulesDev/ (managed by AppStore + hot-reload)
 * - Creates a backup before updating
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = '/data';
const SMDB_SOURCE_PATH = '/app/smdb-source';
const ORIGINAL_SOURCE_PATH = '/app/src';

// Directories that are managed by AppStore / users — never overwrite
const PROTECTED_DIRS = ['bot/modules', 'bot/modulesDev'];

function loadConfig() {
    const configPath = path.join(DATA_PATH, 'update-config.json');
    const defaultConfig = { updateInProgress: false };

    try {
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(configData) };
        }
    } catch (error) {
        console.warn('[PreUpdate] Error loading config, using defaults:', error.message);
    }

    return defaultConfig;
}

function saveConfig(config) {
    const configPath = path.join(DATA_PATH, 'update-config.json');
    try {
        if (!fs.existsSync(DATA_PATH)) {
            fs.mkdirSync(DATA_PATH, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('[PreUpdate] Error saving config:', error.message);
    }
}

function copyDirectory(src, dest) {
    if (!fs.existsSync(src)) {
        throw new Error(`Source directory does not exist: ${src}`);
    }
    fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Check if a relative path falls inside a protected directory.
 */
function isProtectedPath(relativePath) {
    return PROTECTED_DIRS.some(dir => relativePath === dir || relativePath.startsWith(dir + '/'));
}

/**
 * Create a backup of smdb-source before updating.
 */
function createBackup() {
    try {
        const timestamp = Date.now();
        const backupName = `backup-${timestamp}`;
        const backupPath = path.join('/data/backups', backupName);

        console.log(`[PreUpdate] Creating backup: ${backupName}`);
        fs.mkdirSync('/data/backups', { recursive: true });
        fs.mkdirSync(backupPath, { recursive: true });

        const destDir = path.join(backupPath, 'smdb-source');
        copyDirectory(SMDB_SOURCE_PATH, destDir);

        let version = 'unknown';
        try {
            const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
            version = packageJson.version || 'unknown';
        } catch { /* ignore */ }

        fs.writeFileSync(
            path.join(backupPath, 'metadata.json'),
            JSON.stringify({ timestamp, version, description: 'Pre-update backup (system)', type: 'automatic', size: 0 }, null, 2)
        );

        console.log(`[PreUpdate] Backup created: ${backupName}`);
        return backupPath;
    } catch (error) {
        console.error('[PreUpdate] Failed to create backup:', error.message);
        return null;
    }
}

/**
 * Replace core system directories from the image source.
 * These are the framework files — NOT user modules.
 */
function updateCoreDirs() {
    const coreDirs = [
        'bot/internalSetup',
        'bot/types',
        'utils',
        'webui',
        'updater'
    ];

    for (const dir of coreDirs) {
        const originalPath = path.join(ORIGINAL_SOURCE_PATH, dir);
        const targetPath = path.join(SMDB_SOURCE_PATH, dir);

        if (!fs.existsSync(originalPath)) continue;

        if (fs.existsSync(targetPath)) {
            console.log(`[PreUpdate] Replacing ${dir}/`);
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            console.log(`[PreUpdate] Adding ${dir}/`);
        }
        copyDirectory(originalPath, targetPath);
    }
}

/**
 * Copy files from image source that don't exist in smdb-source.
 * Skips protected directories (modules/, modulesDev/).
 */
function copyMissingFiles(src, dest, relativePath = '') {
    if (!fs.existsSync(src)) return;
    if (isProtectedPath(relativePath)) return;

    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            if (!isProtectedPath(childRelative)) {
                copyMissingFiles(srcPath, destPath, childRelative);
            }
        } else if (!fs.existsSync(destPath)) {
            console.log(`[PreUpdate] Adding missing file: ${childRelative}`);
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Main execution
async function main() {
    const config = loadConfig();

    if (!config.updateInProgress) {
        console.log('[PreUpdate] No update in progress, skipping');
        return;
    }

    console.log('[PreUpdate] System update in progress — applying changes');

    // Check write permissions
    const testFile = path.join(SMDB_SOURCE_PATH, '.write-test');
    try {
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            console.error('[PreUpdate] Cannot write to /app/smdb-source — skipping update');
            return;
        }
        throw error;
    }

    // Backup before updating
    const backupPath = createBackup();
    if (backupPath) {
        console.log(`[PreUpdate] Backup saved to: ${backupPath}`);
    }

    try {
        // 1. Replace core system directories
        updateCoreDirs();

        // 2. Copy any new files that don't exist in smdb-source (skip modules)
        copyMissingFiles(ORIGINAL_SOURCE_PATH, SMDB_SOURCE_PATH);

        // 3. Always copy root-level files (index.ts, package.json, etc.)
        const rootFiles = fs.readdirSync(ORIGINAL_SOURCE_PATH, { withFileTypes: true })
            .filter(e => e.isFile());
        for (const file of rootFiles) {
            const srcPath = path.join(ORIGINAL_SOURCE_PATH, file.name);
            const destPath = path.join(SMDB_SOURCE_PATH, file.name);
            fs.copyFileSync(srcPath, destPath);
        }

        // Mark update as complete
        config.updateInProgress = false;
        config.lastUpdateTime = Date.now();
        saveConfig(config);

        console.log('[PreUpdate] System update completed successfully');
    } catch (error) {
        console.error('[PreUpdate] Error during update:', error.message);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('[PreUpdate] Unhandled error:', error.message);
    process.exit(1);
});

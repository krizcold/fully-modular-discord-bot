#!/usr/bin/env node

// Pre-compilation update script
// This runs BEFORE TypeScript compilation to ensure we compile updated source code

const fs = require('fs');
const path = require('path');

// Simple implementation of the update system logic
// We can't use the TypeScript version because it hasn't been compiled yet

const DATA_PATH = '/data';
const SMDB_SOURCE_PATH = '/app/smdb-source';
const ORIGINAL_SOURCE_PATH = '/app/src';

function loadConfig() {
    const configPath = path.join(DATA_PATH, 'update-config.json');
    const defaultConfig = {
        updateMode: 'none',
        updateInProgress: false
    };

    try {
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            const parsedConfig = JSON.parse(configData);
            return { ...defaultConfig, ...parsedConfig };
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

    // Ensure destination directory exists
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

// Create a backup before updating
function createBackup(updateMode) {
    try {
        const timestamp = Date.now();
        const backupName = `backup-${timestamp}`;
        const backupPath = path.join('/data/backups', backupName);

        console.log(`[PreUpdate] Creating backup: ${backupName}`);

        // Ensure backups directory exists
        fs.mkdirSync('/data/backups', { recursive: true });

        // Create backup directory
        fs.mkdirSync(backupPath, { recursive: true });

        // Copy smdb-source to backup
        const destDir = path.join(backupPath, 'smdb-source');
        console.log('[PreUpdate] Backing up smdb-source...');
        copyDirectory(SMDB_SOURCE_PATH, destDir);

        // Get version from package.json
        let version = 'unknown';
        try {
            const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
            version = packageJson.version || 'unknown';
        } catch (e) {
            // Ignore
        }

        // Create metadata
        const metadata = {
            timestamp,
            version,
            description: `Pre-update backup (${updateMode} mode)`,
            type: 'automatic',
            updateMode,
            size: 0
        };

        // Save metadata
        fs.writeFileSync(
            path.join(backupPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
        );

        console.log(`[PreUpdate] Backup created successfully: ${backupName}`);
        return backupPath;
    } catch (error) {
        console.error('[PreUpdate] Failed to create backup:', error.message);
        // Continue without backup - don't block the update
        return null;
    }
}

function emptyDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        console.log(`[PreUpdate] Removing: ${entry.name}`);
        fs.rmSync(fullPath, { recursive: true, force: true });
    }
    
    console.log('[PreUpdate] Directory contents cleared successfully');
}

function copyMissingFiles(src, dest) {
    if (!fs.existsSync(src)) return;

    // Ensure destination directory exists
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyMissingFiles(srcPath, destPath);
        } else if (!fs.existsSync(destPath)) {
            console.log(`[PreUpdate] Copying missing file: ${entry.name}`);
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function updateCoreFiles(folders) {
    for (const folder of folders) {
        const originalPath = path.join(ORIGINAL_SOURCE_PATH, folder);
        const targetPath = path.join(SMDB_SOURCE_PATH, folder);

        if (fs.existsSync(originalPath)) {
            if (fs.existsSync(targetPath)) {
                console.log(`[PreUpdate] Removing existing ${folder} folder`);
                fs.rmSync(targetPath, { recursive: true, force: true });
            }
            
            console.log(`[PreUpdate] Copying new ${folder} folder`);
            copyDirectory(originalPath, targetPath);
        }
    }
}

function handleFirstInstallation() {
    console.log('[PreUpdate] Performing first installation...');

    if (!fs.existsSync(SMDB_SOURCE_PATH)) {
        console.log('[PreUpdate] Creating smdb-source from original source');
        copyDirectory(ORIGINAL_SOURCE_PATH, SMDB_SOURCE_PATH);
    } else {
        console.log('[PreUpdate] smdb-source already exists, skipping first installation');
    }
}

function handleBasicUpdate() {
    console.log('[PreUpdate] Performing basic update...');

    const internalSetupPath = path.join(SMDB_SOURCE_PATH, 'internalSetup');
    
    // Remove existing internalSetup folder
    if (fs.existsSync(internalSetupPath)) {
        console.log('[PreUpdate] Removing existing internalSetup folder');
        fs.rmSync(internalSetupPath, { recursive: true, force: true });
    }

    // Copy new internalSetup folder
    const originalInternalSetup = path.join(ORIGINAL_SOURCE_PATH, 'internalSetup');
    if (fs.existsSync(originalInternalSetup)) {
        console.log('[PreUpdate] Copying new internalSetup folder');
        copyDirectory(originalInternalSetup, internalSetupPath);
    }

    // Also update utils and types if they exist
    updateCoreFiles(['utils', 'types']);
}

function handleRelativeUpdate() {
    console.log('[PreUpdate] Performing relative update...');

    // First, remove and replace internalSetup folder (like basic update)
    const internalSetupPath = path.join(SMDB_SOURCE_PATH, 'internalSetup');
    
    if (fs.existsSync(internalSetupPath)) {
        console.log('[PreUpdate] Removing existing internalSetup folder');
        fs.rmSync(internalSetupPath, { recursive: true, force: true });
    }

    const originalInternalSetup = path.join(ORIGINAL_SOURCE_PATH, 'internalSetup');
    if (fs.existsSync(originalInternalSetup)) {
        console.log('[PreUpdate] Copying new internalSetup folder');
        copyDirectory(originalInternalSetup, internalSetupPath);
    }

    // Also update utils and types if they exist
    updateCoreFiles(['utils', 'types']);

    // Then copy only missing files from original to smdb-source
    copyMissingFiles(ORIGINAL_SOURCE_PATH, SMDB_SOURCE_PATH);
}

function handleFullUpdate() {
    console.log('[PreUpdate] Performing full update...');

    // Empty the smdb-source folder contents (preserve the mount point directory)
    if (fs.existsSync(SMDB_SOURCE_PATH)) {
        console.log('[PreUpdate] Emptying existing smdb-source folder contents');
        emptyDirectory(SMDB_SOURCE_PATH);
    }

    // Copy entire original source
    console.log('[PreUpdate] Copying entire source folder');
    copyDirectory(ORIGINAL_SOURCE_PATH, SMDB_SOURCE_PATH);
}

// Main execution
async function main() {
    const config = loadConfig();

    console.log(`[PreUpdate] Checking update mode: ${config.updateMode}`);

    if (!config.updateInProgress) {
        console.log('[PreUpdate] No update in progress, skipping pre-update');
        return;
    }

    // Check write permissions before attempting update
    const testFile = path.join(SMDB_SOURCE_PATH, '.write-test');
    try {
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            console.error('[PreUpdate] WARNING: Cannot write to /app/smdb-source - skipping update');
            console.error('[PreUpdate] The bind mount may have incorrect permissions');
            // Don't exit with error - allow bot to continue with existing code
            return;
        }
        throw error;
    }

    console.log(`[PreUpdate] Update in progress, handling mode: ${config.updateMode}`);

    // Create backup before update (except for first installation)
    if (config.updateMode !== 'first') {
        const backupPath = createBackup(config.updateMode);
        if (backupPath) {
            console.log(`[PreUpdate] Backup saved to: ${backupPath}`);
        }
    }

    try {
        switch (config.updateMode) {
            case 'first':
                handleFirstInstallation();
                break;
            case 'basic':
                handleBasicUpdate();
                break;
            case 'relative':
                handleRelativeUpdate();
                break;
            case 'full':
                handleFullUpdate();
                break;
            default:
                console.warn(`[PreUpdate] Unknown update mode: ${config.updateMode}`);
                return;
        }

        // Mark update as complete
        config.updateMode = 'none';
        config.updateInProgress = false;
        config.lastUpdateTime = Date.now();
        saveConfig(config);
        
        console.log('[PreUpdate] Update process completed successfully');

    } catch (error) {
        console.error('[PreUpdate] Error during update process:', error.message);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('[PreUpdate] Unhandled error:', error.message);
    process.exit(1);
});
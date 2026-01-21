#!/bin/sh

echo "Starting Discord bot..."


# **Ensure smdb-source exists** (Recover if missing or if it's empty)
if [ ! -d "/app/smdb-source" ] || [ ! "$(ls -A /app/smdb-source)" ]; then
    echo "--> Initializing source folder (/app/smdb-source)..."
    mkdir -p /app/smdb-source
    chown node:node /app/smdb-source
    cp -r /app/src/* /app/smdb-source/
    chown -R node:node /app/smdb-source
    # ----------------------
    # This will RESET the Source Folder to the DEFAULT state
    # By copying the contents of the original /src/ into the user's /smdb-source/
    # ----------------------
fi

# **Create a clean dist folder to ensure removed files are deleted**
if [ -d "/app/dist" ]; then
    echo "Removing old compiled files..."
    if ! rm -rf /app/dist; then
        echo "ERROR: Failed to remove /app/dist - check permissions"
        ls -ld /app/dist
        exit 1
    fi
    sleep 0.1
fi
echo "Creating dist directory..."
if ! mkdir -p /app/dist; then
    echo "ERROR: Failed to create /app/dist directory"
    exit 1
fi
chown node:node /app/dist

# **Ensure correct TypeScript config** (force production config)
echo "Applying production TypeScript configuration..."
if ! cp /app/tsconfigprod.json /app/tsconfig.json; then
    echo "ERROR: Failed to copy tsconfig - check permissions"
    ls -ld /app/tsconfigprod.json /app/tsconfig.json 2>/dev/null || true
    exit 1
fi

# **Run pre-update system** (BEFORE compilation to ensure we compile updated source)
echo "Checking for pending updates..."
if ! node /app/pre-update.js; then
    echo "ERROR: Pre-update process failed"
    exit 1
fi

# **Run safety check** (Prevent crash loops and handle safe mode)
echo "Running safety check..."
# Run safety check as node user if we're root
if [ "$(id -u)" = "0" ]; then
    runuser -u node -- node /app/safety-check.js
else
    node /app/safety-check.js
fi
SAFETY_EXIT_CODE=$?

# Handle safety check exit codes
if [ "$SAFETY_EXIT_CODE" -eq 2 ]; then
    echo ""
    echo "============================================"
    echo "      SAFE MODE ENABLED - Bot disabled"
    echo "============================================"
    echo ""
    echo "The bot has been disabled to prevent crash loops."
    echo "Web-UI will start normally for manual recovery."
    echo ""
    echo "Access the Web-UI to:"
    echo "  • View crash logs and error details"
    echo "  • Manually start the bot after fixing issues"
    echo "  • Trigger a rollback to previous version"
    echo "  • Clear safe mode when ready"
    echo ""
    echo "Starting Web-UI only..."

    # Start with --safe-mode flag to prevent bot auto-start
    cd /app
    if [ "$(id -u)" = "0" ]; then
        exec runuser -u node -- node dist/index.js --safe-mode
    else
        exec node dist/index.js --safe-mode
    fi
    exit 0
elif [ "$SAFETY_EXIT_CODE" -ne 0 ]; then
    echo "ERROR: Safety check failed with code $SAFETY_EXIT_CODE"
    exit 1
fi

# **Detect if index.js exists in smdb-source**
if [ ! -f "/app/smdb-source/index.js" ]; then
    echo "[!] index.js not found in smdb-source. Copying from /app/src..."
    cp /app/src/index.ts /app/smdb-source/index.ts
fi

# **Compile TypeScript**
echo "Compiling TypeScript..."
if ! npm run build-prod; then
    echo "ERROR: TypeScript compilation failed"
    exit 1
fi

# **Verify compilation output**
if [ ! -f "/app/dist/index.js" ]; then
    echo "ERROR: index.js was not created by TypeScript compilation"
    exit 1
fi

# **Copy JavaScript files from smdb-source to dist** (Preserves folders)
echo "Copying JavaScript files..."
cd /app/smdb-source && find . -name "*.js" -exec cp --parents {} /app/dist/ \;

# **Ensure data directories exist** (Required for persistent storage)
echo "Creating data directories..."
mkdir -p /data/dist/bot
# Fix ownership if running as root
if [ "$(id -u)" = "0" ]; then
    chown -R node:node /data/dist 2>/dev/null || true
fi

# Note: config.json is now auto-generated from schema on bot startup

# **Start the bot**
cd /app
# Always run the bot as node user
if [ "$(id -u)" = "0" ]; then
    echo "Starting bot as node user..."
    exec runuser -u node -- node dist/index.js
else
    exec node dist/index.js
fi

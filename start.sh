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

# **Handle dist directory based on update state**
# Check if a system update just happened — if so, do a full clean rebuild
NEEDS_CLEAN_BUILD=false

# Full clean if update-config.json had updateInProgress (pre-update.js already ran and cleared it,
# but we check lastUpdateTime vs a marker file to detect a recent system update)
if [ -f "/data/update-config.json" ]; then
    # Check for system update marker: if .update-marker doesn't exist or is older than update-config
    if [ ! -f "/app/dist/.update-marker" ]; then
        NEEDS_CLEAN_BUILD=true
    elif [ "/data/update-config.json" -nt "/app/dist/.update-marker" ]; then
        # update-config was modified more recently than our marker — likely a system update
        LAST_UPDATE=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('/data/update-config.json','utf-8'));console.log(c.lastUpdateTime||0)}catch{console.log(0)}" 2>/dev/null)
        MARKER_TIME=$(node -e "try{console.log(require('fs').statSync('/app/dist/.update-marker').mtimeMs|0)}catch{console.log(0)}" 2>/dev/null)
        if [ "$LAST_UPDATE" -gt "$MARKER_TIME" ] 2>/dev/null; then
            NEEDS_CLEAN_BUILD=true
        fi
    fi
fi

# Also full clean if dist doesn't exist at all (first boot)
if [ ! -d "/app/dist" ]; then
    NEEDS_CLEAN_BUILD=true
fi

if [ "$NEEDS_CLEAN_BUILD" = true ]; then
    echo "[Build] System update detected or first boot — full clean build"
    if [ -d "/app/dist" ]; then
        rm -rf /app/dist
    fi
    mkdir -p /app/dist
    chown node:node /app/dist
else
    echo "[Build] Incremental build — reusing existing dist cache"

    # Clean up orphan .js files (compiled files whose .ts source was deleted)
    echo "[Build] Checking for orphan compiled files..."
    if [ -d "/app/dist" ]; then
        ORPHAN_LIST=$(mktemp)
        cd /app/dist
        # Find all .js files in dist, check if corresponding .ts or .js exists in smdb-source
        find . -name "*.js" -type f > "$ORPHAN_LIST" 2>/dev/null
        ORPHAN_COUNT=0
        while read -r jsfile; do
            tsfile=$(echo "$jsfile" | sed 's/\.js$/.ts/')
            srcpath="/app/smdb-source/$tsfile"
            jssrcpath="/app/smdb-source/$jsfile"
            if [ ! -f "$srcpath" ] && [ ! -f "$jssrcpath" ]; then
                rm -f "$jsfile"
                rm -f "${jsfile}.map" 2>/dev/null
                rm -f "$(echo "$jsfile" | sed 's/\.js$/.d.ts/')" 2>/dev/null
                ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
            fi
        done < "$ORPHAN_LIST"
        rm -f "$ORPHAN_LIST"
        cd /app
        if [ "$ORPHAN_COUNT" -gt 0 ]; then
            echo "[Build] Removed $ORPHAN_COUNT orphan compiled file(s)"
        fi
    fi
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

# **Compile TypeScript (incremental)**
echo "Compiling TypeScript..."
if ! npm run build-prod; then
    echo "ERROR: TypeScript compilation failed"
    # If incremental build fails, try a full clean rebuild
    if [ "$NEEDS_CLEAN_BUILD" = false ]; then
        echo "[Build] Incremental build failed — attempting full clean rebuild..."
        rm -rf /app/dist
        mkdir -p /app/dist
        chown node:node /app/dist
        if ! npm run build-prod; then
            echo "ERROR: Full rebuild also failed"
            exit 1
        fi
    else
        exit 1
    fi
fi

# **Verify compilation output**
if [ ! -f "/app/dist/index.js" ]; then
    echo "ERROR: index.js was not created by TypeScript compilation"
    exit 1
fi

# **Copy non-TypeScript assets from smdb-source to dist** (Preserves folders)
echo "Copying assets (JS, JSON, CSS, HTML)..."
cd /app/smdb-source && find . \( -name "*.js" -o -name "*.json" -o -name "*.css" -o -name "*.html" -o -name "*.jsx" \) -exec cp --parents {} /app/dist/ \;

# **Write update marker** (tracks when dist was last built)
date +%s > /app/dist/.update-marker

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

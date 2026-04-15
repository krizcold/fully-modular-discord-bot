#!/bin/sh

set -e

echo "Starting Discord bot..."

# Ensure mount points exist (bind-mounted dirs may be created empty on first boot)
mkdir -p /app/custom /app/dist /data /data/appstore-modules

# Seed /app/custom from baked /app/custom-seed if the bind mount is empty
if [ -d /app/custom-seed ] && [ -z "$(ls -A /app/custom 2>/dev/null)" ]; then
    echo "Seeding /app/custom from /app/custom-seed..."
    cp -a /app/custom-seed/. /app/custom/ 2>/dev/null || true
fi

# Read image-version.json (baked) and applied-version.json (persistent)
IMAGE_BUILD_ID=$(node -e "try{console.log(require('/app/image-version.json').buildId||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
APPLIED_BUILD_ID=$(node -e "try{console.log(require('/data/applied-version.json').buildId||'')}catch(e){console.log('')}" 2>/dev/null || echo "")

if [ -z "$IMAGE_BUILD_ID" ]; then
    echo "ERROR: /app/image-version.json missing or invalid"
    exit 1
fi

echo "Image buildId:   $IMAGE_BUILD_ID"
echo "Applied buildId: ${APPLIED_BUILD_ID:-<none>}"

if [ "$IMAGE_BUILD_ID" != "$APPLIED_BUILD_ID" ]; then
    echo "[Build] buildId mismatch - rebuilding /app/build and /app/dist"

    rm -rf /app/build /app/dist
    mkdir -p /app/build /app/dist

    echo "[Build] Copying /app/src -> /app/build"
    cp -a /app/src/. /app/build/

    if [ -d /app/custom ]; then
        echo "[Build] Applying /app/custom overlay (skipping bot/internalSetup)"
        cd /app/custom
        find . -type d -path "./bot/internalSetup" -prune -o -type f -print | while read -r relpath; do
            relpath="${relpath#./}"
            [ -z "$relpath" ] && continue
            target="/app/build/$relpath"
            mkdir -p "$(dirname "$target")"
            cp -a "/app/custom/$relpath" "$target"
        done
        cd /app
    fi

    if [ -d /data/appstore-modules ]; then
        echo "[Build] Merging /data/appstore-modules -> /app/build/bot/modules"
        mkdir -p /app/build/bot/modules
        for moddir in /data/appstore-modules/*/; do
            [ -d "$moddir" ] || continue
            modname=$(basename "$moddir")
            rm -rf "/app/build/bot/modules/$modname"
            cp -a "$moddir" "/app/build/bot/modules/"
        done
    fi

    echo "[Build] Applying production tsconfig"
    cp /app/tsconfigprod.json /app/tsconfig.json

    echo "[Build] Compiling TypeScript"
    if ! /app/node_modules/.bin/tsc -p /app/tsconfig.json; then
        echo "ERROR: TypeScript compilation failed"
        exit 1
    fi

    if [ ! -f /app/dist/index.js ]; then
        echo "ERROR: index.js was not created by TypeScript compilation"
        exit 1
    fi

    echo "[Build] Copying non-TypeScript assets to /app/dist"
    cd /app/build
    find . -type f \( -name "*.js" -o -name "*.json" -o -name "*.css" -o -name "*.html" -o -name "*.jsx" \) | while read -r f; do
        rel="${f#./}"
        target="/app/dist/$rel"
        mkdir -p "$(dirname "$target")"
        cp "$f" "$target"
    done
    cd /app

    echo "[Build] Generating /app/dist/webui/public/build-info.js"
    mkdir -p /app/dist/webui/public
    node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync('/app/image-version.json','utf8'));fs.writeFileSync('/app/dist/webui/public/build-info.js','window.BOT_BUILD = '+JSON.stringify(v)+';\n');"

    echo "[Build] Writing /data/applied-version.json"
    cp /app/image-version.json /data/applied-version.json

    echo "[Build] Refresh complete"
else
    echo "[Build] buildId match - reusing existing /app/build and /app/dist"
fi

# Safety check (crash loop guard)
echo "Running safety check..."
set +e
if [ "$(id -u)" = "0" ]; then
    runuser -u node -- node /app/safety-check.js
else
    node /app/safety-check.js
fi
SAFETY_EXIT_CODE=$?
set -e

if [ "$SAFETY_EXIT_CODE" -eq 2 ]; then
    echo ""
    echo "============================================"
    echo "      SAFE MODE ENABLED - Bot disabled"
    echo "============================================"
    echo ""
    echo "Starting Web-UI only..."
    cd /app
    if [ "$(id -u)" = "0" ]; then
        exec runuser -u node -- node dist/index.js --safe-mode
    else
        exec node dist/index.js --safe-mode
    fi
elif [ "$SAFETY_EXIT_CODE" -ne 0 ]; then
    echo "ERROR: Safety check failed with code $SAFETY_EXIT_CODE"
    exit 1
fi

# Persistent runtime data
mkdir -p /data/dist/bot
if [ "$(id -u)" = "0" ]; then
    chown -R node:node /data/dist 2>/dev/null || true
fi

cd /app
if [ "$(id -u)" = "0" ]; then
    echo "Starting bot as node user..."
    exec runuser -u node -- node dist/index.js
else
    exec node dist/index.js
fi

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

SAFE_MODE_MARKER=/data/build-safe-mode.json
SAFE_MODE_BUILD=0
COMPILE_FAIL_REASON=""

stage_sources() {
    rm -rf /app/build /app/dist
    mkdir -p /app/build /app/dist
    echo "[Build] Copying /app/src -> /app/build"
    cp -a /app/src/. /app/build/
}

apply_overlays() {
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
}

compile_ts() {
    echo "[Build] Applying production tsconfig"
    cp /app/tsconfigprod.json /app/tsconfig.json

    echo "[Build] Compiling TypeScript"
    if ! /app/node_modules/.bin/tsc -p /app/tsconfig.json; then
        COMPILE_FAIL_REASON="TypeScript compilation failed"
        return 1
    fi

    if [ ! -f /app/dist/index.js ]; then
        COMPILE_FAIL_REASON="index.js was not created by TypeScript compilation"
        return 1
    fi

    return 0
}

if [ "$IMAGE_BUILD_ID" != "$APPLIED_BUILD_ID" ] || [ ! -f /app/dist/index.js ]; then
    echo "[Build] buildId mismatch or /app/dist missing - rebuilding /app/build and /app/dist"

    stage_sources
    apply_overlays

    if ! compile_ts; then
        SAFE_MODE_BUILD=1
        echo ""
        echo "############################################################"
        echo "##  BUILD FAILED - STARTING IN SAFE MODE                  ##"
        echo "############################################################"
        echo "##  Failed step: $COMPILE_FAIL_REASON"
        echo "##  The merged build does not compile. A custom or        ##"
        echo "##  appstore module is most likely broken.                ##"
        echo "##                                                        ##"
        echo "##  Retrying with pristine baked sources only:            ##"
        echo "##    /app/custom overlay:      SKIPPED                   ##"
        echo "##    /data/appstore-modules:   SKIPPED                   ##"
        echo "##                                                        ##"
        echo "##  Fix or remove the broken custom/appstore files,       ##"
        echo "##  then restart the container.                           ##"
        echo "############################################################"
        echo ""

        node -e "const fs=require('fs');fs.writeFileSync('/data/build-safe-mode.json',JSON.stringify({reason:process.argv[1],timestamp:new Date().toISOString()},null,2)+'\n');" "$COMPILE_FAIL_REASON" || true
        # Clear the applied-version marker so the next boot retries the full overlay build
        rm -f /data/applied-version.json

        stage_sources

        if ! compile_ts; then
            echo "ERROR: pristine baked sources also failed to compile: $COMPILE_FAIL_REASON"
            echo "ERROR: the image itself is broken"
            echo "Waiting 60s before exit to avoid a hot restart loop..."
            sleep 60
            exit 1
        fi

        echo "[Build] SAFE MODE build succeeded - running pristine baked sources"
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

    if [ "$SAFE_MODE_BUILD" -eq 0 ]; then
        echo "[Build] Writing /data/applied-version.json"
        cp /app/image-version.json /data/applied-version.json
    fi

    echo "[Build] Refresh complete"
else
    echo "[Build] buildId match - reusing existing /app/build and /app/dist"
fi

if [ "$SAFE_MODE_BUILD" -eq 0 ]; then
    rm -f "$SAFE_MODE_MARKER"
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

RECORD_CRASH_JS='
const fs=require("fs");
const P="/data/update-safety.json";
const D={safeMode:false,maxConsecutiveCrashes:3,crashWindowMs:300000,crashCount:0,crashHistory:[],lastSuccessfulStart:null,currentVersion:null};
let c={...D};
try{c={...D,...JSON.parse(fs.readFileSync(P,"utf8"))}}catch(e){}
const rec={timestamp:Date.now(),exitCode:Number(process.argv[1]),signal:null,errorMessage:"Main process exited unexpectedly"};
c.crashHistory.push(rec);
c.crashCount=(c.crashCount||0)+1;
fs.writeFileSync(P,JSON.stringify(c,null,2));
try{
  fs.mkdirSync("/data/crash-logs",{recursive:true});
  fs.writeFileSync("/data/crash-logs/crash-"+new Date(rec.timestamp).toISOString().replace(/:/g,"-")+".json",JSON.stringify(rec,null,2));
}catch(e){}
'

record_main_crash() {
    if [ "$(id -u)" = "0" ]; then
        runuser -u node -- node -e "$RECORD_CRASH_JS" "$1" || true
    else
        node -e "$RECORD_CRASH_JS" "$1" || true
    fi
}

CHILD_PID=""
TERM_REQUESTED=0

on_term() {
    TERM_REQUESTED=1
    if [ -n "$CHILD_PID" ]; then
        kill -TERM "$CHILD_PID" 2>/dev/null || true
    fi
}

trap on_term TERM INT

# Run node as a child (not exec) so a main-process crash can be recorded
# for safety-check.js before the container exits
if [ "$(id -u)" = "0" ]; then
    echo "Starting bot as node user..."
    runuser -u node -- node dist/index.js &
else
    node dist/index.js &
fi
CHILD_PID=$!

set +e
wait "$CHILD_PID"
EXIT_CODE=$?
# A trapped signal interrupts wait before the child exits; wait again for the real status
while kill -0 "$CHILD_PID" 2>/dev/null; do
    wait "$CHILD_PID"
    EXIT_CODE=$?
done

if [ "$EXIT_CODE" -ne 0 ] && [ "$TERM_REQUESTED" -eq 0 ]; then
    echo "Main process crashed with exit code $EXIT_CODE - recording crash"
    record_main_crash "$EXIT_CODE"
fi

exit "$EXIT_CODE"

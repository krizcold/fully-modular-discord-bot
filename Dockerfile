# Use official Node.js image
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json tsconfigprod.json ./

# Update npm to latest version
RUN npm install -g npm@latest

# Install git (needed by AppStore module manager)
RUN apk add --no-cache git

# Create dist (built fresh on each container start)
RUN mkdir -p /app/dist

# Change ownership BEFORE npm install (only 3 files at this point - FAST!)
RUN chown -R node:node /app

# Switch to node user
USER node

# Install dependencies as node user (creates node_modules owned by node)
RUN npm install

# Copy source files with correct ownership (avoids slow chown later)
COPY --chown=node:node src/ /app/src/

# Select updater module at build time based on BUILD_MODE
# - undefined/empty (default): updater_local (git-based, for self-hosted)
# - managed: updater_managed (API-based, for Bot Manager)
ARG BUILD_MODE
COPY --chown=node:node updaters/ /tmp/updaters/
RUN mkdir -p /app/src/updater && \
    if [ "$BUILD_MODE" = "managed" ]; then \
      echo "Build mode: managed - using Bot Manager API updater"; \
      cp -r /tmp/updaters/updater_managed/* /app/src/updater/; \
    else \
      echo "Build mode: local - using git updater"; \
      cp -r /tmp/updaters/updater_local/* /app/src/updater/; \
    fi && \
    rm -rf /tmp/updaters

# Copy safety check script for crash loop prevention
COPY --chown=node:node safety-check.js /app/safety-check.js

# Bake the seed for /app/custom (copied to /app/custom by start.sh on first boot)
COPY --chown=node:node custom-seed/ /app/custom-seed/

# Build metadata: bot manager writes .build-meta.json into the build context
# right before "docker build" runs. Contents: { commit, branch, builtAt }.
COPY --chown=node:node .build-meta.json /app/.build-meta.json

ARG BUILD_DATE=unknown
RUN set -e; \
    FINAL_DATE="$BUILD_DATE"; \
    if [ "$FINAL_DATE" = "unknown" ]; then FINAL_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ); fi; \
    export FINAL_DATE; \
    node -e "const fs=require('fs');const pkg=require('/app/package.json');const meta=JSON.parse(fs.readFileSync('/app/.build-meta.json','utf8'));const commit=meta.commit||null;const commitShort=commit?commit.slice(0,7):null;const branch=meta.branch||null;const buildDate=process.env.FINAL_DATE;const buildId=commit||buildDate;fs.writeFileSync('/app/image-version.json',JSON.stringify({version:pkg.version,commit,commitShort,branch,buildId,buildDate},null,2));"

# Copy start script and give execution permissions
COPY --chown=node:node start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Default command: run the start script
CMD ["/app/start.sh"]

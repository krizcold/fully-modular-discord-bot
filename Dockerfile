# Use official Node.js image
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json tsconfigprod.json ./

# Update npm to latest version
RUN npm install -g npm@latest

# Create necessary directories
RUN mkdir -p /app/smdb-source /app/dist && \
    chmod -R 777 /app/smdb-source

# Change ownership BEFORE npm install (only 3 files at this point - FAST!)
RUN chown -R node:node /app

# Switch to node user
USER node

# Install dependencies as node user (creates node_modules owned by node)
RUN npm install

# Note that /app/smdb-source is a MOUNTED VOLUME
# While /app/dist is NOT... It's built every time the container starts

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

# Copy pre-update script for handling updates before compilation
COPY --chown=node:node pre-update.js /app/pre-update.js

# Copy safety check script for crash loop prevention
COPY --chown=node:node safety-check.js /app/safety-check.js

# Copy start script and give execution permissions
COPY --chown=node:node start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Default command: run the start script
CMD ["/app/start.sh"]

# ==============================================================================
# Rewind — Private Staging Dockerfile
# Standard Node.js 20 LTS (Debian bookworm-slim)
# Supports: Next.js 16, node:fs, node:child_process, Python 3 AST, and TypeScript API
# ==============================================================================

FROM node:20-bookworm-slim AS base

# Install Python 3 for safe native AST syntax validation (pythonValidator.ts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure standard production environment defaults
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=127.0.0.1 \
    NEXT_TELEMETRY_DISABLED=1

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev=false

# Copy application source code
COPY . .

# Run production build using Turbopack
RUN npm run build

# Remove development-only tools if desired or prune dev dependencies
# Note: TypeScript and tsx are kept for runtime compiler API and dynamic diagnostics

# Create persistent storage directories with appropriate permissions
RUN mkdir -p /app/.rewind_store /app/demo-workspace \
    && chown -R node:node /app

# Switch to non-root node user
USER node

# Expose internal port 3000 (accessible only via private loopback / internal network)
EXPOSE 3000

# Healthcheck targeting system limits endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://127.0.0.1:3000/api/system/limits || exit 1

# Start private staging server bound strictly to loopback
CMD ["npm", "run", "start:staging"]

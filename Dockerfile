# ==============================================================================
# Stage 1: Build stage
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git bash

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Copy monorepo manifests and workspace members for pnpm resolution
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.base.client.json tsconfig.host.json tsconfig.client.json tsconfig.json tsdown.config.ts ./
COPY patches/ ./patches/
COPY scripts/ ./scripts/
COPY vendor/ ./vendor/
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY native/ ./native/
COPY examples/ ./examples/
COPY website/ ./website/
COPY python/ ./python/
COPY scalix.patch.yml ./

ENV CI=true
ENV LEFTHOOK=0

# Install dependencies and build all packages & web frontend
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm run build && \
    pnpm prune --prod --config.confirmModulesPurge=false --ignore-scripts

# ==============================================================================
# Stage 2: Runtime stage
# Scalix limit: Keep every compressed layer under ~60 MB
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Minimal runtime dependencies
RUN apk add --no-cache bash ca-certificates && \
    mkdir -p /home/node/.dsh && \
    chown -R node:node /home/node

ENV NODE_ENV=production
ENV HOME=/home/node
ENV DSH_HOME=/home/node/.dsh
ENV PORT=3080
ENV DSH_TELEMETRY_DISABLED=1

# Copy built artifacts and production dependencies in one single layer with ownership
COPY --chown=node:node --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/vendor ./vendor
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps ./apps
COPY --chown=node:node --from=builder /app/patches ./patches
COPY --chown=node:node --from=builder /app/scripts ./scripts
COPY --chown=node:node --from=builder /app/scalix.patch.yml ./scalix.patch.yml

USER node

EXPOSE 3080

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3080/ || exit 1

ENTRYPOINT ["node", "apps/cli/lib/bin.js"]
CMD ["web", "--patch", "scalix.patch.yml"]

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

# Copy monorepo manifests first for optimal layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.base.client.json tsconfig.host.json tsconfig.client.json tsconfig.json tsdown.config.ts ./
COPY vendor/ ./vendor/
COPY packages/ ./packages/
COPY apps/ ./apps/

# Install dependencies and build all packages & web frontend
RUN pnpm install --frozen-lockfile && \
    pnpm run build && \
    pnpm prune --prod

# ==============================================================================
# Stage 2: Runtime stage
# Scalix limit: Keep every compressed layer under ~60 MB
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Minimal runtime dependencies
RUN apk add --no-cache bash ca-certificates

ENV NODE_ENV=production
ENV DSH_HOST=0.0.0.0
ENV PORT=3080
ENV DSH_TELEMETRY_DISABLED=1

# Copy built artifacts and production dependencies in one single layer with ownership
COPY --chown=node:node --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/vendor ./vendor
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps ./apps

USER node

EXPOSE 3080

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3080/ || exit 1

ENTRYPOINT ["node", "apps/cli/lib/bin.js"]
CMD ["web"]

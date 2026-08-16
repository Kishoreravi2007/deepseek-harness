FROM node:22-alpine

WORKDIR /app

# Install build and runtime dependencies
RUN apk add --no-cache python3 make g++ git bash ca-certificates

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Copy full source tree
COPY . ./

ENV CI=true
ENV LEFTHOOK=0
ENV NODE_ENV=production
ENV HOME=/home/node
ENV DSH_HOME=/home/node/.dsh
ENV PORT=3080
ENV DSH_TELEMETRY_DISABLED=1

# Install monorepo dependencies, build all packages and web frontend in place
RUN mkdir -p /home/node/.dsh && \
    pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm run build && \
    chown -R node:node /app /home/node

USER node

EXPOSE 3080

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3080/ || exit 1

ENTRYPOINT ["node", "apps/cli/lib/bin.js"]
CMD ["web", "--patch", "scalix.patch.yml"]

# ─── Stage 1: Build frontend + server ────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies (python3/make/g++ needed for better-sqlite3 native module)
RUN apk add --no-cache python3 make g++

# Install all dependencies (including devDeps for build tools)
COPY package*.json ./
RUN npm ci

# Copy source and build everything (vite frontend + esbuild server)
COPY . .
RUN npm run build

# ─── Stage 2: Production runtime ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime deps for native modules
RUN apk add --no-cache python3 make g++

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# Create persistent data directory for SQLite
RUN mkdir -p /data && chown node:node /data

# Use non-root user for security
USER node

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/calls.db

EXPOSE 3000

# Health check against the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist-server/server.mjs"]

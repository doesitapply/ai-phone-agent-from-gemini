# ─── Stage 1: Build the frontend ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Production runtime ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built frontend and server
COPY --from=builder /app/dist ./dist
COPY server.ts ./
COPY tsconfig.json ./

# Create data directory for SQLite
RUN mkdir -p /data && chown node:node /data

# Use non-root user for security
USER node

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# SQLite database stored in a persistent volume
ENV DB_PATH=/data/calls.db

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/stats || exit 1

CMD ["npx", "tsx", "server.ts"]

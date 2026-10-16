# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ── dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
# ffmpeg-free, tiny image — Node's built-in SQLite needs no native build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# data must be a mounted volume so rooms, uploads and accounts survive restarts
RUN mkdir -p /app/data/uploads && chown -R node:node /app
VOLUME ["/app/data"]
USER node

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

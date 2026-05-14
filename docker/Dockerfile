# Lightweight Node.js base
FROM node:22-alpine

# git needed to clone the app source at build time; wget needed for healthcheck.
RUN apk add --no-cache git wget

# Clone the upstream AI Proxy source into the image during build.
ARG APP_REPO_URL=https://github.com/fatlungodev/ai-proxy-with-static-content.git
RUN git clone --depth 1 "${APP_REPO_URL}" /app \
    && rm -rf /app/.git

WORKDIR /app

# Container runtime port (must match docker-compose.yml + start.sh)
ENV PORT=3005
ENV HOST=0.0.0.0

# Install production dependencies, then drop privileges. Node:alpine ships a
# pre-created `node` user (uid 1000). Make /app writable by that user so the
# bind-mounted /app/data is also writable on hosts that share the uid.
RUN npm install -g npm@11.9.0 \
    && npm install --omit=dev \
    && mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]

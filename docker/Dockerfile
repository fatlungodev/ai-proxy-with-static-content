# Lightweight Node.js base
FROM node:22-alpine

# git needed to clone the app source at build time
RUN apk add --no-cache git

# Clone the upstream AI Proxy source into the image during build.
ARG APP_REPO_URL=https://github.com/fatlungodev/ai-proxy-with-static-content.git
RUN git clone --depth 1 "${APP_REPO_URL}" /app \
    && rm -rf /app/.git

WORKDIR /app

# Container runtime port (must match docker-compose.yml + start.sh)
ENV PORT=3000
ENV HOST=0.0.0.0

# Install production dependencies
RUN npm install -g npm@11.9.0 \
    && npm install --omit=dev

# Expose proxy port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

# thinker-server in a container. Build from the repository root:
#   docker build -f infra/sync/Dockerfile -t thinker-sync-server .
#   docker run -d --name thinker-sync-server -p 127.0.0.1:8787:8787 -v thinker-sync-data:/data \
#     -e THINKER_SERVER_ADMIN_TOKEN=... -e ANTHROPIC_API_KEY=... thinker-sync-server
# Data (repositories, notes, sessions, tokens) lives in /data. Private repositories need
# THINKER_SERVER_GIT_TOKEN; a model needs ANTHROPIC_API_KEY (or THINKER_LLM_CMD for tests).
FROM node:22-alpine
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm install --no-save --ignore-scripts --no-audit --no-fund @anthropic-ai/sdk
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
ENV THINKER_SERVER_DATA=/data THINKER_LOG=local THINKER_TELEMETRY=off HOME=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["node", "src/server/cli.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "8787"]

# thinker beside an agent built on a framework: the proxy and the hooks on one port.
#
#   docker build -f docker/thinker/Dockerfile -t thinker .        (from the repository root)
#
# The agent's side is one line (python/thinker-langchain): `Thinker("http://thinker:7000")`. That line sends
# the agent's model calls here and fires thinker's hooks here, so neither is wired without the other.
FROM node:22-slim
# git: each agent gets a checkout of its own under /data/agents (src/hook-service.js), and a hook does
# nothing outside one
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/thinker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
# everything thinker keeps (the agents' checkouts, the proxy's log and cut records): mount a volume to keep it
ENV THINKER_HOME=/data
VOLUME /data
EXPOSE 7000
# The cut acts only between prompts: an agent that does its whole job in one instruction is never cut into
# (the rule that did was removed on 2026-11-16 after it cost an answer; AGENTS.md).
CMD ["node", "src/cli.js", "proxy", "--port", "7000", "--host", "0.0.0.0"]

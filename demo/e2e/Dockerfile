# A machine in the fleet: OpenCode 2 with thinker installed and wired, the proxy in the model path,
# and a loopback Messages API in place of a provider, so the agent loop is real and needs no credentials.
#
# Built from the repository root so the checkout can be copied in:
#   docker build -t thinker-e2e -f demo/e2e/Dockerfile .
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# Telemetry is off at the hard door (telemetry.js:isTelemetryEnabled), which is not conditional on test
# mode -- so this container can ship its session events to the fleet sink it is given, and can never
# ship anything to thinker's own metrics API. THINKER_TEST is deliberately NOT set: it blocks a ship to
# any host but loopback (events.js:isTestShipBlocked), and the point of this run is the ship.
ENV THINKER_TELEMETRY=off THINKER_NO_TELEMETRY=1 THINKER_CE=off THINKER_HOOKS=on THINKER_LOG=local
ENV THINKER_HOME=/root/.thinker
ENV PATH="/root/.opencode/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates procps unzip jq \
    && rm -rf /var/lib/apt/lists/*

# OpenCode 2, from its own v2 installer. Not npm (`opencode-ai` is still 1.x) and not the default
# installer (same: 1.19.5) -- and the version matters, because thinker's v2 plugin is a directory with
# an `index.ts` and v1's is a single file, two different doors (`clients.js:opencodeV2Files`).
RUN curl -fsSL https://opencode.ai/v2/install | bash && opencode --version

RUN git config --global user.name "Fleet Agent" && \
    git config --global user.email "agent@example.invalid" && \
    git config --global init.defaultBranch main

COPY . /thinker
WORKDIR /thinker
RUN npm ci --no-audit --no-fund

WORKDIR /workspace
ENTRYPOINT ["/bin/bash", "/thinker/demo/e2e/entry.sh"]

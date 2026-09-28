FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:${PATH}"

# Install core packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 1. Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 2. OpenAI Codex CLI
RUN npm install -g @openai/codex

# 3. Cursor Agent CLI
RUN curl -fsSL https://cursor.com/install | bash

# 4. Google Antigravity CLI (agy)
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Configure git identity for repository commits
RUN git config --global user.name "Test Agent" && \
    git config --global user.email "agent@example.com" && \
    git config --global init.defaultBranch main

WORKDIR /workspace

# Copy thinker repository
COPY . /thinker

# Install thinker dependencies
WORKDIR /thinker
RUN npm install

WORKDIR /workspace
CMD ["/bin/bash", "/thinker/.agents/skills/e2e-testing-onboarding/scripts/run_suite.sh"]

# The agent's image: Node for the Agent SDK (it bundles the Claude Code binary for this
# platform), plus Python, git and curl for the small scripts the agent writes.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/runner
COPY package.json package-lock.json ./
# Optional dependencies carry the platform's Claude Code binary; they must not be skipped.
RUN npm ci --omit=dev
COPY run.mjs ./

RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runner/run.mjs"]

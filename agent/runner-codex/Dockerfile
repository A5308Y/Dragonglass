# OpenAI's Codex CLI, signed in with a ChatGPT plan. Python, git, curl and ripgrep are there for
# the commands Codex runs. The sign-in lives in /codex, a folder Dragonglass mounts for it.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The version the runner was written and tested against; its optional dependency brings the Linux binary.
RUN npm install -g @openai/codex@0.157.1

WORKDIR /opt/runner
COPY run.mjs ask-human-mcp.mjs ./

RUN mkdir -p /workspace /codex && chown node:node /workspace /codex
USER node
ENV HOME=/home/node CODEX_HOME=/codex
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runner/run.mjs"]

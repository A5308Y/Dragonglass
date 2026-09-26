# The local-model agent's image: our own loop needs Node only, no packages. Python, git,
# curl and ripgrep are there for the scripts the agent writes and for searching files.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/runner
COPY run.mjs ./

RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/runner/run.mjs"]

# Qwen-Agent for a local Qwen model. git, curl and ripgrep are there for the agent's shell
# commands and file searches.
FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/runner
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY run.py ./

RUN useradd --uid 1000 --create-home --home-dir /home/agent agent \
  && mkdir -p /workspace && chown agent:agent /workspace
USER agent
ENV HOME=/home/agent PYTHONUNBUFFERED=1
WORKDIR /workspace
ENTRYPOINT ["python", "/opt/runner/run.py"]

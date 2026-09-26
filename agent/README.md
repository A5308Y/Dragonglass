# Delegating a Project tree to an agent: Step 0

A hand-driven spike, before any plugin code depends on it. It proves that an agent can
work on a copy of one Project tree inside a sandbox, reach the internet but nothing on
your Mac or network, never hold the API key, and ask you questions.

## How it fits together

```
agent/runs/<name>/
  input/      you copy the tree's material here; the agent can only read it
  outbox/     the agent writes its results here, as new files
  exchange/   questions/ and answers/, transcript.jsonl, result.json
  logs/       requests.jsonl: every request the agent made to the outside
```

Two containers (`compose.yaml`):

- **agent** runs the Claude Agent SDK (`runner/run.mjs`). It is on an internal network
  with no route out, runs as a non-root user with a read-only system disk, and sees only
  the three run folders above.
- **proxy** (`proxy/proxy.mjs`) is its only way out. It holds your API key and adds it to
  Claude API calls, tunnels other HTTP(S) traffic to public addresses on ports 80 and 443,
  refuses your Mac and local network, and logs every request. For HTTPS it sees the host,
  not the content.

The agent can still send what it was given to any public site. That is the accepted risk
for now: only delegate trees that aren't sensitive, and check `logs/requests.jsonl`.

## Prerequisites

- Docker Desktop (or OrbStack) running.
- An Anthropic API key in your shell: `export ANTHROPIC_API_KEY=...`. It goes to the proxy
  container only.

## Run the sandbox check first

```sh
cd agent
mkdir -p runs/check/{input,outbox,exchange,logs}
cp example/sandbox-check-brief.md runs/check/input/brief.md
echo "A file to read." > runs/check/input/sample.md
RUN_DIR=./runs/check docker compose run --rm --build agent
```

When it asks its question, answer from a second terminal:

```sh
cd agent
node scripts/answer.mjs runs/check                  # shows open questions
node scripts/answer.mjs runs/check <question id> "Green"
```

Afterwards read `runs/check/outbox/REPORT.md`, check `runs/check/logs/requests.jsonl`,
and stop the proxy with `docker compose down`.

## Delegate a real sub-project

1. `mkdir -p runs/<name>/{input,outbox,exchange,logs}`
2. Copy the tree into `runs/<name>/input` by hand:
   - the sub-project's note and the notes of every Project below it (`GTD/Projects`)
   - their Actions (`GTD/Actions`, those whose `project_id` is in the tree)
   - their Project Material folders (`support_path`)
   - the files listed in each Project's `linked_files`, and nothing they link to
3. Copy `example/brief.md` to `runs/<name>/input/brief.md` and fill it in.
4. `RUN_DIR=./runs/<name> docker compose run --rm --build agent`

Settings, all optional, as environment variables:

| Variable | Default | |
|---|---|---|
| `AGENT_MODEL` | `claude-opus-5` | Model for the run |
| `AGENT_MAX_TURNS` | `80` | Stops the run after this many tool round trips |
| `AGENT_ANSWER_TIMEOUT_MINUTES` | `240` | How long `ask_human` waits before the agent carries on |

## What Step 0 should tell us

- Whether the SDK works behind the proxy: model calls, WebSearch, WebFetch, curl, pip.
- Whether anything tries to reach the network directly (it would fail: check the report).
- Whether `ask_human` holds up over a long wait.
- What a run costs (`exchange/result.json`) and how useful the outbox is.

## The contract, for other agents later

Dragonglass only relies on the folder layout above: `input/brief.md` plus read-only
material in, new files in `outbox/`, questions and answers as JSON files in
`exchange/questions` and `exchange/answers` (`{ "id", "question" }` and
`{ "id", "answer" }`), and all network traffic through the proxy. Any runner that honours
that can replace `runner/`, including one driving a local model.

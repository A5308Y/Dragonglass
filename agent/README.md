# Delegating a Project tree to an agent

An agent works on a copy of one Project tree inside a sandbox: it can reach the
internet but nothing on your Mac or network, never holds the API key, can ask you
questions, and adds its results to the Project Material.

## From Dragonglass

1. Put your Anthropic API key in the macOS Keychain (it never goes into the vault):
   `security add-generic-password -a "$USER" -s dragonglass-agent -w`
2. In Dragonglass's settings, under **Agent delegation**, set **Agent kit folder** to this
   folder. Docker Desktop has to be running.
3. On a Project, choose **Delegate to agent…** from its menu or its page. Choose Claude or
   a local model; a local model may read either the Project's tree, with internet access,
   or the whole vault, offline. The dialog lists every file the agent will get; say what
   you want done, set a budget for Claude, and start. For local runs, set the model
   server (and its key's Keychain item, if it needs one) under **Agent delegation**.

The run carries on in the background, also when Obsidian is closed. The Project's page
shows its status and cost, and its questions with a place to answer them. A Waiting
Action "Agent: …" stands for the run in the Project; while the agent waits for you it
reads "Agent asks: …" and is flagged for follow-up, and it is done when the run ends. When it ends,
everything in its outbox is copied into the Project Material under
`Agent runs/<date> <title>/`, including `REPORT.md`; nothing of yours is changed.

Run folders live in `~/Library/Application Support/Dragonglass/agent-runs` unless the
settings say otherwise. The rest of this page describes the sandbox and running it by hand.

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

When it asks its question, answer from a second terminal. This is a shell command, not
something in Obsidian yet, and it has to run in the `agent` folder:

```sh
cd path/to/dragonglass/agent
node scripts/answer.mjs runs/check                  # shows open questions
node scripts/answer.mjs runs/check <question id> "Green"
```

The agent keeps waiting until it gets an answer (4 hours by default), so you can answer
any time while the run is going.

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
| `AGENT_MODEL` | `claude-opus-5-5` | Model for the run |
| `AGENT_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`; Opus 5.5 would otherwise use `medium` |
| `AGENT_MAX_BUDGET_USD` | `5` | Stops the run once its estimated spend passes this |
| `AGENT_MAX_TURNS` | `80` | Stops the run after this many tool round trips |
| `AGENT_ANSWER_TIMEOUT_MINUTES` | `240` | How long `ask_human` waits before the agent carries on |

## Costs

Runs use your API key, billed per token; your Claude subscription doesn't cover them.
Each run writes its estimated cost to `exchange/result.json`, together with the
sub-project it was for (the first line under `## Project` in the brief). To see what
delegating has cost per sub-project:

```sh
node scripts/costs.mjs                                                   # runs started by hand
node scripts/costs.mjs ~/Library/Application\ Support/Dragonglass/agent-runs   # runs from Dragonglass
```

Dragonglass shows the same on each Project's page, per Project and for its whole tree.

The numbers are the SDK's estimates from token counts and list prices; the Claude
Console's usage page is the actual bill. A run you stop by hand shows "cost unknown".

## What Step 0 should tell us

- Whether the SDK works behind the proxy: model calls, WebSearch, WebFetch, curl, pip.
- Whether anything tries to reach the network directly (it would fail: check the report).
- Whether `ask_human` holds up over a long wait.
- What a run costs (`exchange/result.json`) and how useful the outbox is.

## A local model (LM Studio)

`agent-local` runs the same kind of task with a model on your Mac instead of Claude:
our own small agent loop (`runner-local/run.mjs`) talking to LM Studio's
OpenAI-compatible server. It has tools to list, read and search the input, write to the
outbox, run shell commands, fetch URLs, and ask you questions; there is no web search.
Local runs cost nothing, so their result records $0 and the token counts instead.

Setting up LM Studio:

- Load a model with tool-use support, and set its context length to 32k or more.
- Start the server (Developer tab, or `lms server start`) on port 1234, and leave
  "Serve on local network" off. The agent reaches it only through the proxy's `/local`
  route, which goes to `host.docker.internal:1234` and nowhere else on your Mac.
- Keep LM Studio's API key switched on, so other programs on your Mac can't use the model
  server, and hand the key to the proxy only; the agent never sees it:
  `LOCAL_MODEL_API_KEY="$(security find-generic-password -s dragonglass-lmstudio -w)"`
  after storing it with `security add-generic-password -a "$USER" -s dragonglass-lmstudio -T "" -w`.

Check the sandbox with the local model, online and then offline:

```sh
cd agent
mkdir -p runs/local-check/{input,outbox,exchange,logs}
cp example/local-check-brief.md runs/local-check/input/brief.md
echo "A file to read." > runs/local-check/input/sample.md
RUN_DIR=./runs/local-check docker compose run --rm --build agent-local
```

Settings, as environment variables: `LOCAL_MODEL` (default: the first model the server
lists), `LOCAL_MODEL_UPSTREAM` (default `http://host.docker.internal:1234`),
`AGENT_MAX_TURNS` (60), `AGENT_MAX_MINUTES` (120), and `LOCAL_CONTEXT_CHARS` (100000): once
the conversation grows past that many characters, the oldest tool results are shortened.
Keep it well below the model's context length; about four characters make a token.

### Offline, with the whole vault

`AGENT_OFFLINE=1` cuts the run off from the internet entirely: the proxy then passes only
the local model's route, refuses everything else, and the agent gets no fetch tool. That
is the condition for giving it more than one Project tree to read: whatever it reads
can't leave your Mac. To give it the whole vault, read-only, without Obsidian's settings
(which hold the mail passwords) and the trash:

```sh
mkdir -p runs/vault/{input,outbox,exchange,logs}
rsync -a --exclude .obsidian --exclude .trash "/path/to/your/vault/" runs/vault/input/vault/
cp example/brief.md runs/vault/input/brief.md    # name the sub-project it is for, and the task
AGENT_OFFLINE=1 RUN_DIR=./runs/vault docker compose run --rm --build agent-local
```

Copying reads every file, so notes that iCloud keeps only in the cloud are downloaded
first; for a large vault that takes a while.

## The contract, for other agents later

Dragonglass only relies on the folder layout above: `input/brief.md` plus read-only
material in, new files in `outbox/`, questions and answers as JSON files in
`exchange/questions` and `exchange/answers` (`{ "id", "question" }` and
`{ "id", "answer" }`), and all network traffic through the proxy. Any runner that honours
that can replace `runner/`, including one driving a local model.

# Orchestrator

An autonomous software factory on top of PyrusLLM nodes. One process owns a
`requirements.md`, splits it into tickets, runs workers against the node's
OpenAI-compatible gateway, and closes a ticket only when CI goes green.

Runs under **Node, not Bare**. It speaks the OpenAI protocol like any other
client, so nothing here enters the distributed binary or touches the OTA
pipeline.

## Run it

```bash
# a node, serving a model that is big enough to follow instructions
npx bare bin.mjs --no-updates --no-open serve \
  --model qwen4b --ctx 8192 --gpu-layers 0 --log-inference

# the demo: two tickets, two workers in parallel, a CI gate, and a second pass
npm run demo:orchestrator -- --model qwen4b
```

Or drive it directly:

```bash
node orchestrator/index.mjs \
  --gateway http://localhost:8787 --api-key "$KEY" --model qwen4b \
  --requirement ./requirements.md \
  --workspace ./build --storage ./.qvac/orchestrator \
  --workers 2
```

`npm run test:orchestrator` runs the five suites. None of them needs a node.

## How a ticket flows

```
requirements.md
      │  split.mjs  — parse into tickets with a dependency DAG
      ▼
  detectOverlap    — abort if two tickets declare the same file
      │
      ▼
  one batch = tickets whose files are disjoint, run in parallel
      │
      ├── worker: own Hyperdrive, asks the gateway, parses ```file blocks
      │           writes ONLY inside its allowedFiles (security.mjs)
      │
      ▼
  ci.mjs — `npm test` in the workspace
      │
      ├── green → ticket:done, never attempted again
      └── red   → ticket:ci-failed, picked up by the next run
      │
      ▼
  state.mjs — append-only JSONL, so a cron resumes instead of redoing
```

## The parts that are not obvious

**One drive per worker, never a shared one.** Hypercore is single-writer: a
Hyperdrive opened by someone else's key is read-only, and `put()` on it does not
fail — it *hangs*. So each worker creates its own drive and announces the key.
The union has no conflicts by construction, because `detectOverlap` already
guarantees two tickets never declare the same file. Conflicts are not resolved
here; they are made impossible.

**The CI gate must not be written by the model.** In the demo, `verify.mjs` is
seeded into the workspace before any worker runs and belongs to no ticket. If
the tests that judge the work came from the same model doing the work, a green
run proves nothing — the cheapest way to pass is a test that always passes.
`detectOverlap` does not protect this: it only stops two *tickets* from
clashing, and the gate is nobody's ticket.

**A ticket's spec and its allowedFiles have to agree.** Measured: given a spec
asking for three deliverables while the ticket permitted one file, qwen4b did
not cheerfully write extra files — it looped on the contradiction for 253s and
produced nothing. That is worse than a violation, because a violation at least
gets caught and logged.

**The corestore lives in its own subdirectory.** `new Corestore(dir).ready()`
wipes a directory whose contents it does not recognise. Pointed straight at
`--storage`, it eats the run log, the worker directories and the saved model
responses.

**Every limit is in the harness, none in the prompt.** Steps and tokens are
checked *before* spending; the per-tool timeout is smaller than the task's; and
retries are for transient failures only — a 400 or a failing test is never
retried, and a timeout gets one retry rather than three, because a ten-minute
timeout is not a 503.

## What the model has to be able to do

Verified on a Linux box with `qwen4b` (Qwen3 4B, Q4_K_M) served locally:

| | |
|---|---|
| emits parseable ` ```file ` blocks | yes, including a `file:` + backticks variant |
| writes two files in one ticket | yes |
| respects the allowlist | **no** — it tried a `README.md` outside its ticket, and the jail rejected it |
| solves the task rather than copying the prompt's example | yes |
| two concurrent requests on one node | yes, 109s and 163s side by side |

`llama1b` was not able to follow the format reliably. Treat ~4B as the floor.

The system prompt's exact shape is load-bearing and each constraint came from a
failed run — the reasoning is recorded above `systemPrompt` in
[`worker/run.mjs`](../worker/run.mjs). In short: the example must carry real
code, must use the ticket's own path, must not itself solve the task, and the
prompt must never discuss the prompt.

## What is not built

- **Cross-machine.** Everything above ran on one machine. A worker writes to its
  local workspace *and* to its drive; the orchestrator runs CI on *its* local
  workspace. On one machine those are the same directory, which is why it works.
  Nothing yet mirrors a remote worker's drive into the coordinator's workspace,
  so "ten nodes building an app" would today be ten nodes writing to ten disks
  that nobody joins. The transport exists (`qvac/files.mjs`); the mirror and the
  swarm join do not.
- **The cron.** `state.mjs` supports resuming across runs and `isStalled()`
  reports two runs in a row closing nothing, but no scheduler is wired up.
- **A retry ceiling per ticket.** A ticket that never passes CI is reassigned
  every run, forever.
- **A global budget.** Limits are per task; nothing caps a whole project.
- **Node specialisation.** Ask: a node specialised in building peer-to-peer
  apps. The pieces exist — the signed manifest, `security.allowedTools` (still
  `[]`), the RAG index that replicates as a hypercore — but nothing uses them
  for this.
- **Tools beyond writing files.** No `run_shell`, no `git`, no MCP server. The
  worker writes files and the orchestrator runs the tests; that is the whole
  toolset.
- **Prompt-injection measurements.** The prompt states that ticket text and file
  contents are data, not instructions. That claim has never been tested.

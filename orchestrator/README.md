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

## Crossing machines

Built, and covered end to end by `test/coordinator-e2e.mjs`,
`test/coordinator-idempotency-test.mjs`, `test/context-drive-test.mjs`, and
against a *real* Hyperswarm/DHT connection by
[`scripts/smoke-real-swarm.mjs`](../scripts/smoke-real-swarm.mjs) (excluded
from the fast suite on purpose — DHT timing has real variance, see
`NOTES.md`).

```
node orchestrator/coordinator.mjs \
  --worker <workerHexKey[,workerHexKey...]> \
  --requirement ./requirements.md --workspace ./build --storage ./.qvac/coordinator

node worker/serve-tasks.mjs \
  --gateway http://127.0.0.1:8787 --allow <coordinatorHexKey>
```

The two processes are two independent `NodeSwarm`s (their own identity, their
own corestore) that find each other on the marketplace topic — the same
discovery `pyrusllm peers` measures. `worker/serve-tasks.mjs` is deliberately
**plain Node**, not wired into `bin.mjs`/Bare: its inference calls go over HTTP
to the local gateway, same as `worker/run.mjs`, so they still pass through
`store.beginRequest`/`endRequest` — the only place node capacity is counted —
and the process never enters the OTA binary. See the header of
[`worker/serve-tasks.mjs`](../worker/serve-tasks.mjs) for why that split is
load-bearing and not just tidiness.

What actually happens on a ticket:

- **`orchestrator/task-protocol.mjs`** — the `qvac/task/v0` messages
  (`task:assign` / `task:accept` / `task:reject` / `task:progress` /
  `task:result`), built and validated with no transport at all.
- **`orchestrator/context-drive.mjs`** — the coordinator's workspace as a
  Hyperdrive, read sparsely by the worker **over the connection the two nodes
  already hold** — no DHT announce per ticket, no `swarm.join`. The
  cross-machine audit (see the repo's own review of this design) measured that
  leg at 2–17s with a 38s tail if done the other way; skipping it is the
  single biggest latency win in this design.
- **`orchestrator/mirror.mjs`** — applying a `task:result` to the coordinator's
  workspace: fetch by declared path only, verify every hash before writing
  anything, and clear a ticket's declared paths before laying an attempt down
  (so a file attempt A1 wrote that attempt A2 simply doesn't reproduce can't
  linger and pass CI).
- **`worker/task-accept.mjs`** — the far side: allowlist check, mount the
  context drive, call the LOCAL gateway (never the engine in-process — that
  would bypass the slot counter), run the same jail as the local worker, reply
  with files **inline** in `task:result` up to 1 MiB total
  (`mirror.mjs`'s `INLINE_CEILING`) or, over that, on this node's own Files
  drive.
- **Idempotency.** `attemptId` is minted per assignment, not per ticket: a
  worker that goes silent and is reassigned can still deliver, and its late
  result — carrying the now-dead `attemptId` — is discarded with a log line
  rather than double-accepted (`Coordinator._onTaskMessage`, tested in
  `test/coordinator-idempotency-test.mjs`). And `result:received` is appended
  to the run log **before** the mirror, so a coordinator that dies between
  accepting a result and closing the ticket resumes from the log on restart —
  the inference is not paid for twice.
- **`Depends on:` is respected across machines.** `split.mjs`'s
  `dependencyWaves()` turns the pending tickets into real dependency LEVELS —
  not the flat topological order `buildDAG().ready` gives, chunked by a fixed
  worker-count window the way the single-machine `runBatch()` does. That
  distinction matters here specifically: chunking a flat order by window size
  does not guarantee two tickets in the same window are mutually independent,
  only that the whole list is globally ordered. A wave does guarantee it, by
  construction. `Coordinator.run()` assigns one wave at a time and
  re-publishes the context drive (`updateContext`) between waves, so a
  dependent ticket's worker reads what the wave before it actually wrote, not
  a stale snapshot from the top of the run. `Coordinator.init()` also derives
  each ticket's `contextPaths` from its declared dependencies' `allowedFiles`
  by default (overridable via the constructor's `contextHints`), so the
  downstream worker gets pointed at the file it depends on without anyone
  hand-wiring a hint. Tested in `test/split-waves-test.mjs` and
  `test/coordinator-dependency-test.mjs` — the latter checks the model prompt
  the downstream worker actually sent, to prove the read went through the
  drive and returned the upstream ticket's real, post-mirror content.
- **`deadline` is enforced, not decorative.** `task-protocol.mjs`'s
  `timeoutsForAssignment()` clamps the worker's `Harness` timeouts to
  whatever is actually left before `task:assign.deadline`, and refuses the
  assignment outright if the deadline has already lapsed by the time it
  arrives. The coordinator derives `deadline` from the same `taskTimeoutMs` it
  advertises in `limits` (plus headroom for the result to travel back), so the
  two numbers cannot quietly drift apart the way an unread field could.

Two decisions that differ from the earliest sketch of this protocol, both
because the frozen manifest schema (`manifest-v0.json`,
`additionalProperties: false`, generated from a zod schema in a package
outside this repo) has no room for them yet:

- **No `task:ack`.** With results inline under the ceiling there is nothing
  left to seed after `task:result`, so nothing to acknowledge. A worker
  releases its task slot when it sends the result, not when the coordinator
  confirms receipt.
- **Authorization is `--allow` / `--worker` (node config on each side), not a
  signed `security.acceptsTasks` field.** The manifest schema would need a
  version bump coordinated with its source package to carry that field
  honestly; until then, being on the topic is still not enough on its own —
  each side only acts on a key it was explicitly told about.

## What is not built

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

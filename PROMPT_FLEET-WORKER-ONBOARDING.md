# Onboard a new pyrusllm worker into the software factory fleet

> Paste this whole file into a fresh Claude Code window running on (or with
> SSH access to) the CANDIDATE MACHINE — the one you want to turn into a
> `pyrusllm` worker for the orchestrator. Follow the steps IN ORDER. Do not
> move to the next step until the current one is confirmed. If a step fails,
> stop and report the exact error — do not paraphrase it, do not improvise a
> fix by editing `bin.mjs` or inventing a flag that isn't documented.

## What you are setting up, in one paragraph

Two independent things run on this machine: a **gateway** (`serve --swarm`,
serves one model over HTTP and announces it on the Hyperswarm/DHT topic
`qvac-node:marketplace:v1`) and a **task worker**
(`worker/serve-tasks.mjs`, a plain Node process that receives `task:assign`
messages over that same swarm and calls the LOCAL gateway to do the work).
The coordinator that assigns tickets never touches this machine over SSH —
it only needs this worker's swarm public key. SSH (if you have it) is only
for installing/operating this machine, not part of the task protocol.

---

## Step 1 — Decide which model this machine can actually run

Do NOT default to whatever the CLI defaults to. Run:

```bash
node -e "import('./qvac/hardware.mjs').then(h => console.log(h.availableModels()))"
```

This lists every model in the catalog (`smol` 360M, `llama1b` 1B, `qwen1_7b`
1.7B, `qwen4b` 4B, `qwen8b` 8B, `gemma4b` 4B, `gptoss20b` 20B, `katcoder35b`
35B, `katcoder35b_q8` 35B, `qwen35bmoe` 35B-A3B, `gemma31b` 31B) with
`fits: true/false` against this machine's total RAM.

**Hard rule for the WORKER role specifically (not chat-only nodes): never go
below `qwen4b`, even if a smaller model reports `fits: true`.** This is
measured, not a guess — `llama1b` does not reliably follow the ticket
format, `qwen4b` does (parseable `file` blocks, respects the allowlist,
solves the task instead of copying the prompt's example). If `qwen4b` does
not fit in this machine's RAM, this machine is not a worker candidate — it
can still run as a plain chat/inference node with a smaller model, just not
take orchestrator tickets.

**On a machine well past K16's class, don't settle for `qwen4b` just
because it fits — pick the largest model the RAM tier below actually
supports, and prefer the code-specialized one over a general instruct model
of similar size:**

| RAM tier | pick | why |
|---|---|---|
| ~32 GB | `katcoder35b` (Q4_K_M, ~19.9 GB) | the only registry model that is explicitly a coding model, not general instruct; fits with headroom for ctx + concurrency |
| ~64 GB | `katcoder35b_q8` (~34.4 GB) | same model, higher-fidelity quant — the extra RAM buys quality, not a bigger model |

`gptoss20b`, `qwen35bmoe`, and `gemma31b` also fit at 32 GB but are general
instruct, not code-specialized — use them only as a comparison baseline if
`katcoder35b` underperforms on this machine's hardware, not as the default.
**None of the five large aliases above have run the qualification demo
(Step 4) yet in this repo — they are verified as real registry names, not
as proven workers.** Treat Step 4 as mandatory, not a formality, when
picking one of them.

Report back which model you picked and why before continuing.

## Step 2 — Base install

```bash
node --version   # must be >=20
npm --version    # must be >=10 — npm 9 breaks `npm install` on this repo
git pull origin <branch>
npm install
```

If `node`/`npm` are missing or too old, stop and report — do not install a
version manager or global tooling without checking with the operator first.

## Step 3 — Run from source, never the standalone binary

**Do not use `npm run make:*` or any prebuilt `pyrusllm-<platform>` binary
for the worker role.** There is a documented, reproduced bug where the
standalone binary never enumerates CPU backend variants and silently fails
to load any model on at least one platform (Linux x64) — it looks installed,
it looks healthy, and it never serves a single token. The only way to trust
this machine's inference is to run the interpreted source directly:

```bash
bare bin.mjs --no-updates serve --swarm --model <alias-from-step-1> --ctx 8192 --log-inference
```

(If a `pyrusllm` command already exists on this machine's PATH, do not
assume it points at this checkout — it may be a separate, stale install.
Confirm with `which pyrusllm` and compare; when in doubt, use the explicit
`bare bin.mjs` form above instead of the `pyrusllm` shortcut.)

Confirm the log shows the gateway listening and the swarm announcing the
model you picked in Step 1, e.g.:

```
[gateway] listening on http://localhost:8787
[swarm] anuncia  : <your model alias>
[swarm] anunciado en la DHT, esperando pares...
```

Leave this running in its own terminal/pane. Do not Ctrl+C it for the rest
of this process — the worker needs it for every inference call.

## Step 4 — Qualify this machine BEFORE joining the fleet

In a second terminal, run the single-machine demo locally, against this
machine's own gateway, to prove the model/hardware combo can actually do the
job — catching a bad node here is cheap; catching it after the coordinator
assigns it real tickets is not:

```bash
npm run demo:orchestrator -- --model <alias-from-step-1>
```

This must finish with tickets closing (green CI), not hang and not error.
If it fails or hangs, stop, report the full output, and do not proceed to
Step 5 — this machine does not qualify as a worker yet.

## Step 5 — Get an API key and start the task worker (no `--allow` yet)

```bash
curl -s http://localhost:8787/v1/keys/panel
```

Copy the `"key"` field, then:

```bash
node worker/serve-tasks.mjs \
  --gateway http://127.0.0.1:8787 \
  --api-key <key-from-above> \
  --model <alias-from-step-1> \
  --storage .qvac/task-worker
```

It prints a line `[serve-tasks] identity  : <64 hex chars>` and waits. That
64-hex-char string is this worker's identity — it is a public key, safe to
share. It also prints `allowlist EMPTY: no coordinator can assign until one
is added` — that is expected at this point.

## Step 6 — Report the identity, then wait

Report the identity hex string back to whoever is running the coordinator
for this fleet. Do not restart or reconfigure anything yet. Wait for them to
send back the coordinator's own identity hex.

## Step 7 — Authorize the coordinator and restart

```bash
# Ctrl+C the process from Step 5 first. If it does not actually exit and a
# restart later fails with "File descriptor could not be locked", find and
# kill the leftover process (`ps aux | grep serve-tasks`) — do not delete
# the storage directory to work around it.

node worker/serve-tasks.mjs \
  --gateway http://127.0.0.1:8787 \
  --api-key <same-key-as-step-5> \
  --model <alias-from-step-1> \
  --storage .qvac/task-worker \
  --allow <coordinator-identity-hex-from-step-6>
```

Identity persists in `.qvac/task-worker/identity.json` — it is still the
same key you reported in Step 6, it does not change on restart. Confirm the
log now says `N coordinator key(s) allowed` instead of `allowlist EMPTY`.

## Step 8 — Leave it running and report what you see

Leave both terminals open (gateway from Step 3, worker from Step 7). When
the coordinator assigns work you will see `[swarm] conectado ...` followed
by `task:assign` handling and `delivered ... inline`. Report exactly what
appears — full error text if anything breaks, not a summary.

## Step 9 (optional) — Make it survive reboots

Only if this machine is meant to be a permanent, always-on fleet member: set
up a service (systemd on Linux, or the platform's equivalent) whose
`ExecStart` runs the exact `bare bin.mjs ... serve --swarm --model <alias>`
command from Step 3, restart-on-failure, with its own storage path.
`worker/serve-tasks.mjs` is a separate Node process and needs its own
service unit if it should also survive reboots — do not merge the two into
one unit; they are independent processes by design.

---

## Guardrails — do not

- Do not touch `bin.mjs` or invent CLI flags. If something you need isn't a
  documented flag, stop and ask instead of patching around it.
- Do not run the standalone/prebuilt binary for the worker role (Step 3).
- Do not delete `.qvac/task-worker` or any corestore directory to "fix" a
  lock error — find and kill the process holding it instead.
- Do not lower the model below `qwen4b` for the worker role just because a
  smaller one "fits" per Step 1's memory check.
- Do not skip Step 4. A worker that never ran the demo locally is an
  unverified worker, no matter how healthy its logs look.

# Audit — `qvac/task/v0` cross-machine task protocol

Scope: latency and efficiency of the *specified* cross-machine protocol
(`docs/factory-protocol.html` in the `pyrusllm` site), read against the built
single-machine orchestrator. Read-only. Single-machine numbers are measured on
one Linux box (Qwen3 4B, CPU + Vulkan iGPU); everything cross-machine is
projection and is labelled.

---

## 1. Verdict

The protocol is **mostly right, for the wrong reason in two places, and it
leaves the single largest avoidable latency on the table.**

What holds: assignment over the existing Protomux control channel (decision 2)
is the strongest call in the document — the single-JSON-message design in
`qvac/channel.mjs:59-70` really does make new `task:` messages OTA-safe, and a
few hundred bytes of control traffic on the shared stream is invisible next to a
100–250 s inference. One-drive-per-worker (decision 5) is forced by a measured
fact (`worker/run.mjs:10-21`: `put()` on a by-key drive hangs) and has no cheaper
form. The authorization stack (decision 7) and the append-only run log
(decision 6, layer 3) are cheap and correct.

What should change:

- **Decisions 3 and 4 re-solve a problem the stack already solves.** The
  coordinator and worker hold an authenticated, holepunched connection that is
  *already* replicating a corestore (`qvac/swarm.mjs:224`,
  `qvac/corestore.mjs:9-12`). Both the context drive and the result drive can
  replicate over that connection by discovery-key with **zero** DHT announce or
  rediscovery. The spec instead describes "publishes … as a Hyperdrive" /
  "the coordinator discovers the key", inheriting the `qvac/files.mjs` model
  that was built for two nodes that are *not* otherwise talking. Measured cost
  of that mistake: 2–17 s per drive, per ticket, with a measured 38 s tail
  (`NOTES.md`, "El descubrimiento tardó 38 s"; "2.2 s … incluye descubrimiento
  en la DHT").

- **Decision 4's stated rationale is partly false.** "Bytes over the drive do
  not contend with what the node is serving" is only true if the drive
  replicates over a *different* transport. Over the existing connection the
  drive blocks share the one `NoiseSecretStream` with chat chunks and directory
  replication — they interleave at block granularity (no hard stall) but
  compete for the same bandwidth and CPU. For a handful of KB-sized text files
  the honest move is **inline in `task:result`** up to a ceiling, drive only for
  overflow.

- **Decision 1 (worker in Bare, in-process engine) is a positioning argument
  wearing a latency costume, and it actively breaks decision 8.** The only hop
  it removes is JSON over loopback TCP — sub-millisecond against a 100–250 s
  inference. It costs: worker + harness enter the OTA binary, 90 test cases move
  to `brittle-bare`, and the CI shell becomes the node's first execution of an
  arbitrary command via `bare-subprocess`. And an in-process
  `engineMod.complete()` call bypasses `store.beginRequest/endRequest`
  (`qvac/gateway.mjs:1510`, `qvac/provider.mjs:234`) — the only two places the
  slot gauge is incremented — so a node doing task work would advertise free
  capacity while its one decode slot is busy.

**Single biggest latency risk in the current spec:** the two DHT
discover/announce legs (context drive, result drive). ~4–34 s of avoidable
fixed cost per ticket in the common case, with a measured tail to ~76 s, on top
of an inference that is otherwise 75–95 % of the wall time. Remove them by
replicating both drives over the connection that already exists.

**Second:** the node loads llama.cpp with `parallel: 1` (`qvac/engine.mjs:129`
sets only `ctx_size`, `verbosity`, `gpu_layers`). Per
`@qvac/llm-llamacpp/index.d.ts:169-191`, concurrent completions then **serialize
in a queue** — batching only exists at `parallel >= 2`. The advertised
`maxConcurrentRequests: 3` overstates node throughput 3×, and "10 nodes" is 10
concurrent inferences, not 30.

---

## 2. Decision table

| # | Decision | Call | One-line reason |
|---|---|---|---|
| 1 | Worker under Bare, in-process engine, not a Node child | **change** (defer) | No measurable latency win vs loopback HTTP; in-process engine call bypasses the slot gauge (`gateway.mjs:1510`) and enlarges the OTA + first arbitrary-command exec. Keep worker on Node for phase 1. |
| 2 | Assignment over the Protomux `qvac/node/v0` channel | **keep** | Connection exists and is authed; single-JSON-message framing (`channel.mjs:59-70`) makes new messages OTA-safe; control bytes are negligible on the shared stream. |
| 3 | Context = read-only Hyperdrive, sparse-by-path | **keep shape / change transport** | Sparse-by-path is right for a 40 MB tree; replicate over the *existing* connection (`swarm.mjs:224`), do not announce a fresh DHT topic. For a <5 MB early tree a full mirror over that connection is simpler and no slower. |
| 4 | Result = metadata over channel, bytes over worker's drive | **change** | Keep metadata over channel. Inline files in `task:result` up to ~1 MiB; drive only for overflow, replicating over the existing connection. The "no contention" rationale fails when the drive rides the same `NoiseSecretStream`. |
| 5 | One drive per worker | **keep** | Forced by Hypercore single-writer; `put()`-hangs is measured (`worker/run.mjs:14-18`); `detectOverlap` (`orchestrator/index.mjs:35`) keeps the union collision-free. |
| 6 | `attemptId` per assignment + content hash + append-only JSONL | **keep + patch** | Closes the double-accept race. Add a `RESULT_RECEIVED` log event before the fetch (resumable mirror across a coordinator restart) and clear the ticket's declared paths per attempt (a superseded attempt's file the new attempt omits must not linger and pass CI). |
| 7 | `--accept-tasks` off + signed-manifest role + coordinator allowlist | **keep** | Cheap, correct, right seam for x402; zero latency cost. |
| 8 | Count inferences in flight, not tasks open | **keep principle / needs data + wiring** | Right principle, but true only if task inferences pass through `store.beginRequest`. Contingent on decision 1: an in-process worker must be routed through the same accounting or the gauge lies exactly when the node is busy. Also see decision-nothing: `parallel: 1` means "in flight" is 0 or 1. |
| 9 | Conflicts made impossible, not merged | **keep** (phase 1) | `detectOverlap` is what lets a batch run with no merge step. Cost (no refactor / schema / lockfile ticket) is real, already named in `factory.html`, acceptable for "a small app over a week". |

Extra: **concurrent-decoding capacity — needs data / needs config.** `parallel`
is never passed at load (`qvac/engine.mjs:129`). Decide `n_parallel` explicitly
and re-measure per-stream tok/s at 1/2/3 concurrent against a solo baseline.

---

## 3. Latency budget — one ticket, specified design

Warm model on the worker, hot DHT, ~4 small files in, ~4 small files out.

| Stage | Time | Basis |
|---|---|---|
| `task:assign` → `task:accept` | ~0.3 s | measured cross-internet RTT analog ~200 ms (`NOTES.md`, "Cruzar internet costó ~200 ms") + JSON |
| context drive announce + worker discovers key | **2–17 s**, tail 38 s | measured hot-discovery (`NOTES.md`: 3.6–8.7 s typical, 38 s tail; "2.2 s … incluye descubrimiento en la DHT") — **avoidable** |
| context sparse fetch (~4 files, ~100 KB) | ~0.5–1 s | *guess*, scaled from 3 MB / 305 ms local corestore + RTT |
| **inference on worker** | **100–250 s** | measured: warm 109–163 s, cold 253 s (`NOTES.md`, `factory.html`) — **DOMINANT** |
| `task:progress` heartbeats | ~0 | tiny JSON every few seconds |
| `task:result` (metadata only) | ~0.3 s | RTT analog |
| coordinator discovers result drive | **2–17 s**, tail 38 s | as context leg — **avoidable** |
| mirror declared paths (~few KB) | ~0.5 s | *guess* |
| `task:ack` | ~0.3 s | RTT |
| CI (`npm test` in workspace) | 1–30 s | `orchestrator/ci.mjs` caps at 30 s; real runtime is a *guess* |
| **Total** | **~110–330 s** | inference = **75–95 %** of wall time |

- **Dominant term:** inference wall time. Nothing in the transport design moves
  the total by more than ~10 % in the common case.
- **Largest avoidable term:** the two discovery legs — ~4–34 s combined
  (measured range), tail to ~76 s (measured). Removed entirely by replicating
  both drives over the already-open connection.
- Cold model on the worker adds ~150 s (measured 253 s vs ~100 s warm) and
  swamps everything else — keeping the worker's model resident is worth more
  than every transport optimization put together.
- A virgin worker node (new key, empty store) adds the measured **297 s**
  bootstrap before it can be assigned anything at all (`NOTES.md`, "Los 297 s no
  eran la red"). First-run cost, but real.

---

## 4. Findings, ordered by impact

### F1 — The context and result drives do not need the DHT
**Where:** `docs/factory-protocol.html` §"Why the context goes over a drive" /
§"Why the result comes back as metadata"; contrast `qvac/swarm.mjs:218-224`,
`qvac/corestore.mjs:9-12`, `qvac/files.mjs:196-214`.
**Why it matters:** the spec adds an announce-on-DHT + rediscover round trip for
each of two drives, per ticket. Measured discovery between two already-running
nodes is 2–17 s with a 38 s tail (`NOTES.md`). The coordinator and worker
already hold a connection whose corestore is replicating; `corestore.replicate(socket)`
serves any core in the store by discovery-key via `ondiscoverykey`. The
coordinator even knows *which* peer to ask — it is the peer that sent
`task:result`.
**What to do:** create both drives in the node's existing corestore; skip
`swarm.join(drive.discoveryKey, …)` entirely for the coordinator↔worker pair.
Keep a DHT join only as the reconnection fallback if the direct link drops and
the seeder must be refound through a third party. Note `qvac/files.mjs`
`remote()` / `_syncRemote()` currently *does* `swarm.join` per drive and waits
on `drive.update({wait:true})` with `findingPeers` — that path pays the tax the
header comment says it avoids; the protocol should not build on it as written.

### F2 — Result bytes over a per-ticket drive are more latency and more code than inline
**Where:** `docs/factory-protocol.html` §`task:result`, §`task:ack`.
**Why it matters:** for a few KB of text the drive lifecycle is: create →
`ready()` → (announce) → coordinator discovers → `_syncRemote` metadata update
→ per-path sparse fetch → `task:ack` → drive may be dropped. Even with F1
applied (no announce/discover) that is a metadata-core `update()` round trip
plus a blob fetch plus an ack-gated seeding window, versus **one message**. The
frame ceiling is 16 MiB (`0xffffff`, enforced in `NoiseSecretStream`
`MAX_ATOMIC_WRITE`, one layer below Protomux — `qvac/channel.mjs:27-30`), so a
handful of KB inline is nowhere near it.
**What to do:** put `files: [{ path, hash, bytes, content }]` in `task:result`
up to a total ceiling (~1 MiB is comfortable and still 16× under the frame
cap). Above the ceiling, fall back to the worker's *existing* Files drive
(`qvac/files.mjs:79`), replicated per F1 — no new per-ticket drive object. This
also deletes `task:ack`'s second job ("cue to release the task slot"): the slot
releases when `task:result` is sent.
**Trade-off given up:** streaming a large artefact while CI already starts on the
small ones. Not relevant to a text-file software ticket; relevant to the
"Facturas AR / planos" verticals `files.mjs` was actually built for, which keep
the drive path.

### F3 — In-process engine breaks the capacity gauge; the Bare-worker case is positioning
**Where:** `docs/factory-protocol.html` decision rationale "calls the engine
directly"; `qvac/gateway.mjs:1510`, `qvac/provider.mjs:234-323` (the only
`beginRequest`/`endRequest` sites); `qvac/engine.mjs:146-157` (`complete()` is
in-process callable — the capability *does* exist).
**Why it matters:** decision 8 ("count inferences in flight") depends on every
inference passing the slot counter. A Bare worker calling `engineMod.complete()`
directly passes neither the gateway loop nor the Provider, so
`store.activeRequests` for the local node never moves while the worker holds the
one decode slot. A paying client's request and a task inference then queue
against each other in the SDK with the router unaware. The loopback-HTTP worker
(current design) goes through `gateway.mjs:1510` and *is* counted.
**What to do:** keep the worker a Node process talking OpenAI to the local
gateway for phase 1 (as `orchestrator/README.md:7-9` and `worker/run.mjs:4-6`
already argue). If Bare is pursued later for positioning reasons, state it as a
positioning decision and require the worker to acquire a slot through the same
path as any other request.

### F4 — `parallel: 1`: advertised concurrency is 3×, real concurrency is 1
**Where:** `qvac/engine.mjs:129` (no `parallel` key); `@qvac/llm-llamacpp/index.d.ts:169-191`
("Values `>= 2` activate the continuous-batch scheduler … `parallel: 1` … single
response active at a time, batching disabled"); `qvac/store.mjs:90`
(`maxConcurrentRequests: 3`); `NOTES.md` §"Concurrencia del SDK".
**Why it matters:** the NOTES probe proved *no cross-talk* between 3 concurrent
completions but never confirmed wall-clock speedup — and with `parallel: 1` the
explanation for no cross-talk is that they ran one at a time. The demo's
"109 s and 163 s side by side" is consistent with serialization (163 ≈ 109 + a
second, shorter generation), not 2× parallel. Decision 8's accounting is then
trivially honest (in-flight decodes are 0 or 1) but every throughput projection
built on `maxConcurrentRequests` or `maxConcurrentTasks` is inflated. "10 nodes"
= 10 inferences at once, full stop.
**What to do:** decide `n_parallel` deliberately and pass it in
`engine.mjs` `modelConfig`. Re-measure: 1 vs 2 vs 3 identical prompts, each
one's wall time and tok/s against a solo baseline. If per-stream tok/s roughly
halves at 2 concurrent, it is time-slicing — set `parallel: 1`, fix
`maxConcurrentRequests` to 1, and size the fleet accordingly. KV cache splits
`ctx_size / parallel` per slot (`index.d.ts:180-181`), so `parallel: 3` with the
`DEFAULT_CTX_SIZE` of 2048 (`qvac/models.mjs:62`) leaves ~680 tokens per
slot — too small; raising `parallel` forces raising `--ctx`.

### F5 — Reassignment discards good completed work with no salvage path
**Where:** `docs/factory-protocol.html` §Idempotency, §"When things break"
("No `task:progress` past the deadline ⇒ the attempt is abandoned").
**Why it matters:** per-attempt keying *does* close the double-accept race (B
silent → reassigned to C → B returns; B's `task:result` carries the dead
`attemptId` and is rejected). But a 100–250 s inference that finished
successfully is thrown away because heartbeats lapsed — pure waste, and the
retry has to pay the full inference again. The window the question posits
("B's result accepted, then C's arrives") cannot double-accept, because once the
coordinator reassigned, B's attempt is no longer live; the cost is wasted
compute, not corruption.
**What to do:** before minting a fresh `attemptId`, give a still-connected
silent worker a short grace `task:status` probe; if it answers with a completed
result for the old attempt, accept it. Cheap, and it reclaims the most
expensive unit of work in the system.

### F6 — Coordinator restart between `task:result` and `task:ack` has no resume record
**Where:** `docs/factory-protocol.html` §`task:ack` ("Until then the worker
keeps seeding"); `qvac/files.mjs:32-35` (not store-and-forward);
`orchestrator/state.mjs` (logs `CI_PASS`/`TICKET_DONE`, nothing for
"result received, fetch pending").
**Why it matters:** the worker is 24/7 so the seeder side is fine. But if the
coordinator (a laptop) dies mid-mirror, on restart it has no record that
ticket T's attempt A2 has an unfetched result — it re-assigns and re-pays the
inference. Hypercore block download is itself resumable and merkle-verified, so
a *sleep* is harmless (UDX reconnects, fetch continues); a *process death* is
the gap. Also undefined: how long the worker seeds an unacked result before
dropping the drive — `taskTimeoutMs` governs the inference, not the seed window.
**What to do:** append a `RESULT_RECEIVED { ticketId, attemptId, driveKey, paths,
hashes }` event to `runs.jsonl` the moment `task:result` arrives and before the
fetch. On restart, resume the fetch for any `RESULT_RECEIVED` without a matching
`TICKET_DONE`/`CI_*`. Define an explicit worker-side seed-retention deadline
(e.g. `deadline` from `task:assign` + margin) and have the coordinator
re-request by `attemptId` within it.

### F7 — A superseded attempt's stale file can survive into CI
**Where:** `docs/factory-protocol.html` §Idempotency layer 2 ("writing identical
bytes is a no-op"); `orchestrator/ci.mjs:63-80` (`detectChanges` checks only
that declared paths exist).
**Why it matters:** attempts of one ticket share `allowedFiles`, so a new
attempt normally overwrites everything the old one mirrored. But if attempt A1
mirrored declared path X and the model in attempt A2 simply omits X, the stale
A1 copy of X stays in the workspace and CI may pass on it. Content-hash
no-op logic does not catch this — there is no A2 write of X to compare.
**What to do:** on accepting an attempt, clear (or move aside) that ticket's
declared paths in the workspace before applying the attempt's files; or tag each
mirrored file with the `attemptId` it came from and refuse CI if any declared
path is from a superseded attempt.

### F8 — Protomux frame ceiling and interleaving: state it in the spec
**Where:** `qvac/channel.mjs:27-30`; `qvac/swarm.mjs:226-231`.
**Why it matters (efficiency, and to stop a future mistake):** the ceiling is
16 MiB per message, enforced in `NoiseSecretStream` (`MAX_ATOMIC_WRITE =
0xffffff`) below Protomux — not a Protomux setting, so it cannot be raised from
this code. `Provider._validate` separately caps chat content at 32000 chars;
`task:*` messages have no such validator today. Protomux writes each message as
one framed payload on the shared stream in send order across all channels, with
no per-channel window and no sub-message prioritization: a large message
serializes fully before the next, and backpressure is the underlying stream's
(all channels stall together). Small `task:assign` / `task:progress` messages
are therefore free; a multi-MB inline blob on the control channel would
head-of-line-block chat tokens for other clients.
**What to do:** the spec should name the inline ceiling for `task:result`
(F2) and forbid bulk on the control channel explicitly. If a dedicated bulk
channel is ever wanted instead of a drive, a second Protomux channel interleaves
with chat at message granularity and carries its own backpressure — but that is
more code than inline + drive-overflow and only pays off above the inline
ceiling.

---

## 5. The simpler alternative (from question 11)

**Minimum viable cross-machine design:**

1. Worker stays a **Node process** speaking OpenAI to the local gateway
   (`worker/run.mjs` as-is), so it stays out of the OTA binary and its
   inferences stay counted at `gateway.mjs:1510`.
2. Assignment, progress, result-metadata over the existing `qvac/node/v0`
   channel with a `task:` type — decision 2 unchanged.
3. **Context**: coordinator creates the workspace drive in the node's existing
   corestore; worker mounts it by key and reads sparsely **over the existing
   connection** (`ondiscoverykey`). No `swarm.join`. For a tree under a few MB,
   a full `mirror-drive` over that connection instead — simpler, ~1 s.
4. **Results**: files inline in `task:result` up to ~1 MiB total; above that,
   the worker's existing Files drive, replicated over the existing connection.
   No per-ticket drive, no `task:ack`.
5. **Idempotency**: `attemptId` per assignment + content hash + the append-only
   log, plus F6's `RESULT_RECEIVED` event and F7's path-clear.
6. Authorization exactly as decision 7.

**What it gives up vs the specified design:**

| Given up | Load-bearing for "small app over a week on nodes you own"? |
|---|---|
| DHT-discoverable drives (context/result reachable by a *third* node, not just the coordinator) | **No.** One coordinator, known workers. Third-party seeding is a scale concern, not a week-one concern. |
| Streaming a large result artefact while CI starts on the rest | **No.** Text-file tickets. This matters for the PDF/plan verticals, which keep the drive path anyway. |
| `task:ack` as an explicit "verified, release slot" handshake | **No.** Slot releases on `task:result`; verification failure just reopens the ticket next run, which the loop already does. |
| A clean seam where "the worker keeps seeding until acked" models long fetches | **Partly.** Replaced by F6's retention deadline + resume record, which is strictly more robust against coordinator death. |
| Bare "differentiator" positioning | Not an efficiency property. Judge separately. |

Net: the simpler design loses nothing the stated goal needs, removes the
single biggest avoidable latency (F1), and is less code (no per-ticket drive
lifecycle, no `task:ack`, no per-drive swarm join).

---

## 6. Open questions — could not settle from code + repos

| # | Question | What would settle it |
|---|---|---|
| 1 | **Real concurrent-decode throughput.** `parallel: 1` is the load config, but does `@qvac/bare-sdk`'s provider queue serialize cleanly or add overhead per queued job? And at `parallel: 2/3`, what is per-stream tok/s vs solo? | Load with explicit `parallel` ∈ {1,2,3}; run N identical distinguishable prompts; record each stream's wall time + tok/s vs a solo baseline on the same box. |
| 2 | **Cross-internet Hyperdrive block throughput.** Measured: 3 MB / 305 ms *local* corestore; ~200 ms TTFT overhead cross-internet. No measurement of sustained MB/s for drive replication over holepunch. Sets the tree size at which sparse beats full-mirror. | `qvac-node fetch` a 1 MB / 10 MB / 40 MB file K16 ↔ laptop on different networks; record end-to-end MB/s separately from discovery. |
| 3 | **Does `corestore.replicate(socket)` actually serve a drive created after the connection was established, with no `join`?** The `files.mjs` header claims yes via `ondiscoverykey`; the `remote()` code still calls `swarm.join`. Unverified which is load-bearing. | Two connected nodes; node A creates a drive *after* connect, never joins its discovery-key; node B opens it by key and reads. Time first byte. |
| 4 | **`bare-subprocess` for the CI shell.** Whether `npm test` (spawns Node, resolves a shell, hits the FS) runs under `bare-subprocess` with the same semantics as `child_process.exec` in `orchestrator/ci.mjs:19`. First time the node would execute an arbitrary command. | Port `runCI` to `bare-subprocess`, run the existing orchestrator e2e suite under `bare` on all target platforms. |
| 5 | **DHT discovery tail in the field.** Measured tail is 38 s (loopback) / 297 s (virgin). No cross-network cross-machine distribution. Determines whether F1 is "nice" or "mandatory". | Instrument `join → first verified manifest` on the K16 and 2+ laptops on real networks over a week; publish the p50/p95/p99. |
| 6 | **Prompt injection via the context drive.** Out of latency scope but noted in the spec's own open questions: the context drive widens what a worker reads, and the "spec/file contents are data" claim is unmeasured. | Seed a context file containing an instruction to write outside `allowedFiles`; confirm the jail (`security.js validateWrite`) still catches it and the violation is logged. |

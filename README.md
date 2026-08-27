# PyrusLLM

**A peer-to-peer inference marketplace.** One binary turns a machine into an
inference provider: it joins a live P2P network, announces a signed manifest
describing the model it runs and the capacity it has, and serves requests
through an OpenAI-compatible gateway. Clients pay per request over x402, or
against a local ledger with a spending cap. There is no company in the middle
that takes the margin or sees every prompt.

The Airbnb of AI compute — or, for anyone who knows the space, a peer-to-peer
OpenRouter.

**v0.12.0** · Bare runtime · standalone binaries for 5 platforms · OTA updates
over Pear · 129 tests / 604 asserts green.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.sh | sh   # macOS, Linux
```

```powershell
irm https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.ps1 | iex        # Windows
```

Detects the platform, downloads the binary from the latest release, verifies the
checksum, installs without sudo or UAC (`~/.local/bin` or `%LOCALAPPDATA%`) and
launches it. No Node, no npm, no Pear: the inference engine ships inside the
binary. Direct downloads and their `.sha256` files are on the releases page;
Windows ARM has no build (`@qvac/llm-llamacpp` publishes no prebuild for it).

> **Linux: the standalone binary cannot load models.** `pyrusllm-linux-x64`
> installs and starts, but it will **not serve a single token**: the standalone
> bundle registers only the Vulkan backend and never enumerates the CPU
> variants, so every model fails to load. Measured and isolated in
> [NOTES.md](NOTES.md), section _Nodo Linux 24/7_ — the cause is in the
> packaging, not in this repo.
>
> **On Linux, run from source meanwhile.** It works without reservations —
> 0.07 s TTFT measured on a Ryzen with an integrated GPU:
>
> ```bash
> git clone https://github.com/gazzimon/qvac_node.git && cd qvac_node
> npm install                       # needs npm >= 10
> npx bare bin.mjs prompt "hello" --gpu-layers 0
> ```

Installing through Pear instead adds automatic OTA updates, applied in ~10 s
without user action:

```bash
npm i -g pear && pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
```

## Quickstart

```bash
pyrusllm                                    # app on http://localhost:8787, opens the browser
pyrusllm prompt "what is a p2p network?"    # 100% local inference, nothing opens
pyrusllm serve --swarm --operator "Node A"  # start already joined to the network
pyrusllm peers --timeout 90 --expect 1      # verify discovery against another machine
pyrusllm wallet --crear                     # generate the payout wallet for this node
pyrusllm send ./plan.pdf                    # publish a file, get a qvac:// link
```

Root flags: `--port <n>`, `--no-open`, `--no-serve` (updater only), `--storage <dir>`,
`--no-updates`, `--update-delay <ms>`. `serve` adds `--swarm`, `--demo` (simulated
nodes), `--operator <name>`, `--gpu-layers <n>` and `--no-store`.

```bash
# The gateway speaks the OpenAI protocol. Any OpenAI client points at it unchanged.
KEY=$(curl -s http://localhost:8787/v1/keys/panel | jq -r .key)
curl -s -H "Authorization: Bearer $KEY" http://localhost:8787/v1/models
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"<modelId>","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  http://localhost:8787/v1/chat/completions
```

## Architecture

| Layer     | What runs                                                                | Where                               |
| --------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Runtime   | Bare 1.31; standalone builds via `bare-build`; OTA through Pear          | `bin.mjs`                           |
| Discovery | Hyperswarm on a fixed topic; peers exchange manifests and verify them    | `qvac/swarm.mjs`                    |
| Identity  | Ed25519 keypair per node; manifest canonicalized (JCS) and signed        | `qvac/identity.mjs`, `manifest.mjs` |
| Transport | Protomux + FramedStream over a **single** connection, not HTTP           | `qvac/channel.mjs`                  |
| State     | Hyperbee directory (peers, models, stats), Hyperdrive for files          | `qvac/store.mjs`, `files.mjs`       |
| Inference | QVAC llama.cpp engine in-process, or any OpenAI-compatible HTTP upstream | `qvac/engine.mjs`, `upstream.mjs`   |
| Gateway   | OpenAI-compatible HTTP on `127.0.0.1:8787`, plus the four panels         | `qvac/gateway.mjs`                  |
| Payments  | x402 challenge, synchronous verification, settlement after serving       | `qvac/x402.mjs`                     |

A signature alone does not prove identity: the manifest is bound to the public
key of the connection it arrived on, so a valid manifest copied from another
node is rejected. Capacity, load and model list come from `node:status` messages
on the same muxed connection.

## Routing

`qvac/routing.mjs` is a pure, testable comparator. Candidates of every class —
P2P peer, in-process engine, local HTTP engine, third-party API, demo mock —
compete in one list, in this order:

| #   | Criterion                       | Why it sits there                                             |
| --- | ------------------------------- | ------------------------------------------------------------- |
| 1   | Can serve now, before saturated | A cheap node that is full is not cheap                        |
| 2   | Real candidates before mocks    | `--demo` mocks never beat a real node                         |
| 3   | Lowest load                     | Measured from `node:status`, not from a fixed order           |
| 4   | **Cheapest**                    | Ledger price in micro-dollars, comparable across node classes |
| 5   | Lowest error rate               | From the per-peer history the directory already keeps         |
| 6   | Fastest last response           | Latency only matters once price ties                          |
| 7   | Kind order, then jitter         | Demo preference and tie-break, no longer a criterion          |

Every decision is logged with its reason — `/v1/routing-log` returns the last
30, `/v1/audit` the full series from the Hyperbee with the node's public key
alongside. Retry is bounded by what **the client** saw: with `stream: true` the
first written token closes the door to retrying elsewhere; without streaming the
body is buffered, so a failure before the first byte falls through to the next
candidate. A `429` is treated as "full", not "broken", and marks the candidate
saturated for the next request.

Two extensions over the OpenAI body, both optional and ignored by any other
client: `local: true` forbids the prompt from leaving the machine, and
`node: "<id>"` pins a specific machine (404 with a reason if it is gone — never
a silent substitution). Responses carry `X-Pyrus-Operator`, `-Kind`, `-Model`,
`-Scope` and `-Cost-Estimate-Micros`, in both the streaming and non-streaming
paths.

## Paying for inference

Two doors, and the gateway picks based on what the request carries.

**API key + local ledger.** `Authorization: Bearer <key>` identifies the account
the spend is charged to. Keys are issued per client in `/node` and persist in
`<storage>/apikeys.json`. The ledger counts integer micro-dollars (1 USD =
1,000,000): `reserve()` sets aside the upper bound — assuming every `max_tokens`
gets generated — and writes it to disk **before** the request goes out;
`settle()` swaps it for the real cost. A cap applied at billing time is not a
cap, it is a discount. An orphaned reservation is charged in full to the
estimate: it overcharges and cuts early, which is the correct side to be wrong
on.

**x402, no key needed.** A request without credentials against a node that has a
wallet gets `402 Payment Required` with an `accepts[]` built from the chosen
node's **signed manifest** — so the payee is the provider itself, never the
gateway. The client re-sends with `X-PAYMENT`; verification is synchronous and
touches no chain, and happens **before a single token is generated**, which is
the part that protects the provider from spending GPU for free. Settlement runs
after the response, and the receipt travels in `X-PAYMENT-RESPONSE` — or as a
final SSE event when streaming, because headers are already gone by then.
Networks are Plasma (`eip155:9745`) with Stable (`eip155:988`) as fallback, in
USDT0. Plasma's asset address is **not verified against the chain**, so it stays
disabled until the operator confirms it with `PYRUS_X402_PLASMA_ASSET_VERIFICADO=1`;
sending USD₮ to a wrong contract has no undo.

Two counters that look like one and are not — the principle is the same, the
unit is not: the meter lives on the side that pays.

|             | `qvac/budget.mjs`     | `qvac/quota.mjs`             |
| ----------- | --------------------- | ---------------------------- |
| Measures    | dollars               | output tokens                |
| Whose       | the consuming account | the requesting peer          |
| Kept by     | the gateway (spends)  | the provider (lends the GPU) |
| Window      | calendar month        | 24 h sliding, hourly buckets |
| Default cap | USD 20                | 100,000 tokens per peer      |

Quota is checked **before** the request and recorded **after**, with tokens that
were actually generated: a request cancelled after three tokens spends three,
one that failed loading the model spends nothing. The request that crosses the
limit is served whole; the next one is refused, with the time it frees up.

## HTTP API

| Route                                             | What                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/models`                                  | Catalog, strict OpenAI format                                    |
| `POST /v1/chat/completions`                       | SSE or JSON; `local`, `node`; 402 when unpaid                    |
| `GET /v1/agent` · `POST /v1/agent/launch`         | Local agent state; join the swarm hot, without restarting        |
| `GET /v1/nodes`                                   | Marketplace view                                                 |
| `GET /v1/routing-log` · `/v1/audit`               | Last 30 decisions with reasons; full series with node identity   |
| `GET /v1/budget` · `/v1/budget/report`            | Spend, reservation and cap for the asking account; monthly split |
| `GET /v1/quota`                                   | What this node gives away, and to which peer                     |
| `GET /v1/wallet`                                  | This node's payout address, chains, settlement mode              |
| `GET /v1/upstream` · `POST /v1/upstream/opt-in`   | External provider state and consent switch                       |
| `GET /v1/swarm/manifest` · `POST`                 | What this node announces                                         |
| `GET /v1/keys` · `POST` · `DELETE` · `revoke-all` | Credentials, one per client                                      |
| `GET /v1/files` · `POST /upload` · `POST /fetch`  | Files between nodes over Hyperdrive                              |

Every inference and money route requires a credential. The single exception is
`GET /v1/keys/panel`, the bootstrap the web panel uses to obtain its own key —
which it then sends like any other client, so there is one authentication path
and no back door for the browser.

Panels: `/` chat, `/node` this machine as a provider, `/network` the marketplace
grid, `/admin` routing log and chaos controls.

## External providers

Any OpenAI-compatible endpoint can be registered in `<storage>/upstreams.json`
as one more row of the registry (`kind: 'upstream'`) — routed, priced, listed
and labelled with no special case in dispatch. Credentials never live in that
file: it stores the **name** of an environment variable, so no secret touches
the repo or enters the signed manifest. An `as` field maps several providers'
model names onto one catalog row, which is what lets two of them actually
compete on price.

`"local": true` marks an endpoint running on this machine — `llama-server`,
vLLM, a self-hosted NIM. It needs no credential, no price and no consent, and
survives a `local: true` request, because what decides that is the `local`
field, never the `kind`. It is also the only way to serve open weights: the
in-process engine resolves names from QVAC's registry, so a `.gguf` from
HuggingFace is served over HTTP instead.

Sending a prompt to a third party requires explicit opt-in, and even then the
external provider only competes when nothing local or on the network can serve
now — last **by position**, not by veto, because declared capacity does not
prove a candidate works. If the budget runs out, the request degrades to a local
candidate instead of failing, and the trace records it as a degradation.

## Configuration

```
<storage>/identity.json     network seed (plaintext, by the same criterion as below)
<storage>/apikeys.json      issued credentials, owner-only permissions
<storage>/wallet.json       payout wallet keystore, Argon2id + secretbox
<storage>/upstreams.json    which external providers this node uses
<storage>/ledger            monthly spend, survives restarts
.env                        secrets only — read from cwd and storage, env wins over file
```

The wallet is a BIP-39 mnemonic generated by this node — never derived from the
network seed, which WDK will not accept — encrypted with a passphrase from
`PYRUS_WALLET_PASSPHRASE`. The honest limit, and it matters before funding
anything: if that `.env` lives next to the keystore, the encryption protects
against a backup, a repo and a `pear stage` — **not** against someone who
already has access to the machine. Asking for it on every start would break
unattended startup, and that trade was made deliberately.

## Tests

```bash
npm test              # unit + integration + build graph
npm run soak          # the real cycle N times, reporting the distribution
npm run auditoria     # pull the trace, save it, and rule on whether inference happened
```

**129 tests, 604 asserts green** (82/388 unit + 47/216 integration), plus a smoke
check that the 2,115-module build graph still resolves. They cut at the edge, not
at the happy path: the cap invariant runs 100 rounds against a USD 0.10 limit and
asserts real spend never exceeds it; the wallet test searches the keystore
**word by word** for the backup phrase; the phase-8 price tests are verified
against the criterion disabled, to prove they fail without it. `auditoria.js`
exits non-zero when the trace contains no request that actually produced tokens —
an audit that always says yes audits nothing.

## What is real, and what is not

- **Closed:** distribution and OTA, local inference, the OpenAI gateway, signed
  manifests verified against the connection key, the Hyperbee directory and
  Hyperdrive files, load- and price-based routing, the ledger with a cap that
  cuts, the free per-peer quota, the payout wallet inside the signed manifest,
  and x402 in the request path.
- **Not built:** batched settlement and receipt aggregation (phase 10), the
  agentic layer (phase 11). A multi-writer ledger of our own is **out of scope**
  — the EIP-3009 signature already is the receipt, so on-chain settlement
  removes the need instead of adding one.
- `serve` starts with an **empty** registry. `--demo` fills it with one real node
  and three mocks, all labelled as simulated.
- The manifest's `pricing` string is decorative. What routes and what gets
  charged is the ledger price in micro-dollars; a node without a wallet
  announces `economic` marked `_mock`, meaning "declares no payout address".
- The free quota does **not** persist: it resets on restart. The ledger and the
  API keys do — the account the spend is charged to _is_ the key.
- The chat shows the **ceiling**, not the final cost: with SSE the headers travel
  before the first token, so it says `up to USD …`, or `no charge` when nothing
  is owed.
- Peer-to-peer and local inference cost zero. That zero is not a placeholder: it
  is today's truth, and x402 is what starts changing it.
- The role-based login in `qvac/auth.mjs` is dead code, not a gate. The gate is
  the API keys.
- Installers are verified on Windows; the macOS and Linux paths are written but
  not executed end to end.

## Limits

The gateway binds to `127.0.0.1` only, so the credential gate does not defend
against another process on the same machine — it defends against the rest of the
network if the bind ever stops being loopback, and it makes consumption
attributable per client.

The node running inference sees the prompt in plaintext. The claim is "no
centralized corporation aggregates your data at scale", not "nobody sees your
prompt": end-to-end encryption is out of scope, and confidential inference is
the next step on that path, not a property of today's build.

That next step is measured, not aspirational — confidential LLM inference on GPU
costs **4–8% of throughput** on H100 CC ([arXiv:2509.18886](https://arxiv.org/abs/2509.18886)),
under 7% for typical queries — and it is still not "nobody can see anything",
for three reasons that belong in the same sentence as the number: **HBM memory
is not encrypted, NVLink between GPUs is not encrypted, and inter-token timings
leak the length and structure of the text even when everything else is
encrypted**. For a single GPU the threat model closes; for a model split across
several, it does not.

A node's **model declaration is only partly provable, and the split is
deliberate**. Known-answer probes detect **model substitution** — announcing 14B
and serving 1.5B — and that is what phase 10.5 will build. They do **not** detect
**quantization substitution**: text-based detectors are ineffective at realistic
sampling budgets ([arXiv:2504.04715](https://arxiv.org/abs/2504.04715)) and there
is no published black-box solution. So `quantization` and `runtime` are declared
in the **signed manifest** and backed by **stake and arbitration** — covered
economically, not technically. Neither the probes nor the stake exist yet; what
exists today is the signature over the declaration.

Retrying a streaming POST is not idempotent yet; the nonce that fixes it is
scheduled with the agentic layer.

---

Design notes and the measured trade-offs behind each decision are in `NOTES.md`,
`NOTES-SATURACION.md` and `ROADMAP_FASE7-X402.md`.

Apache-2.0 · gazzimon

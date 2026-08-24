# 👋 Present your Startup!

## Startup's name
PyrusLLM

## One sentence pitch / one liner describing your startup
PyrusLLM turns idle hardware into an income-producing AI asset: verified providers, a live catalog, and routing and billing sealed inside a TEE, no operator to trust.

---

## Add more details about your startup

### 1. The problem we're solving.
Today, access to quality AI inference depends on a handful of centralized corporations that set the price, capture the margin on compute that millions already own, and process every prompt in systems: using them is an act of faith, and there is no alternative if they change the rules. PyrusLLM replaces that with an ownerless, verifiable protocol: any computer or datacenter with idle compute becomes an inference provider, cryptographically signs its manifest, and earns $QVAC for every request it serves via an x402 payment.

### 2. Target audience and evidence of demand.
On the demand side: companies and teams that currently depend on a single AI provider for their operations and need service continuity without being tied to one source. On the supply side: crypto node operators, server owners, and investors with the capacity to acquire hardware for AI processing, looking to turn that compute into an income-producing asset. We are in the validation stage for both segments: the base protocol already works and has been verified across separate machines — we built it at the CRECIMIENTO / Aleph 2026 hackathon, Pears Track — and the next step is to measure real appetite on both sides with the economic layer live.

### 3. Value proposition.
PyrusLLM is the Airbnb of AI compute: you install one binary and your machine (a PC or a datacenter) starts earning $QVAC every time someone uses it to infer. The difference from a centralized cloud is that here there is no operator you have to take on faith. All the sensitive marketplace logic — which node each request goes to, how many tokens were consumed, who gets paid how much, what reputation each provider holds — runs as a confidential job inside a TEE and settles onchain in batches: not even we can see who asked what of whom, or tilt the accounting in anyone's favor. For the provider, that means getting paid what the network recorded, not what an intermediary says. For the user, it means their prompt arrives decoupled from their identity, and no node can build a profile out of what it processes. And all of it is consumed from a single chat bar compatible with the OpenAI protocol, picking the model each task needs without jumping between apps.

### 4. Main challenges we're currently facing.
The most immediate one is taking the economic layer from simulated to real: today the node signs its manifest and announces price and capacity, but the accounting does not yet run as a confidential job or settle onchain — that is exactly the piece we want to build on Vela, because it is logic that genuinely requires confidential execution and cannot be left to an operator to administer. The second is verifiable quality: a node declares which model it runs, and that declaration has to be provable — we need an entry benchmark and a reputation score that updates according to real performance. The third is the limit we have not closed yet: at the exact moment of inference, the model needs the prompt in plaintext in memory, so today we protect who sent it but not what it says. And the fourth is not technical but market-side: bootstrapping both sides at once — without providers there is no service, without demand there is no incentive to add hardware.

### 5. Long-term vision.
That putting a machine to work producing AI inference becomes as simple and as ordinary as renting out a property on Airbnb: anyone with hardware joins the marketplace, sets their capacity and their model, and earns from compute that today sits idle — with quality verified and reputation public rather than self-declared. The privacy path only closes fully when inference itself runs on confidential hardware: today we guarantee that no one can link a prompt to whoever wrote it, and the next step is that not even the node processing it can read its content. What we are aiming for is an inference network with no single owner, where price is set by an open market instead of three corporations, the margin stays with whoever contributes the actual compute, and both quality and privacy are verified rather than promised.

---

## Pitch Deck (if you have one, it helps a lot to understand your vision)
_(vacío)_

## Select the team size regarding your startup
Co Founders + employees: **2-3**

## Select the number of cofounders your startup has
**2**

## Startup Stage
_If you are currently looking for money, select the round you are currently raising_

**Raising a Pre-Seed**

## What stage is your product currently in?
**Scaling (with clear metrics)**

## Type Customer
**B2B2C**

---

# 🔎 Ecosystems & Tech

## What technology does your startup use or operate within?
- Multi-Party Computation
- Privacy-Preserving Computation
- Privacy / Confidential Computing
- Stablecoins
- Onchain Reputation Systems
- Crypto Payments & Remittances
- AI
- Data Indexing Solutions

## Is your startup part of any of the following crypto/web3 ecosystems?
- Horizen

## Verticals
- Infra & Dev Tooling
- AI/ML & Crypto Convergence
- Vertical SaaS
- DePin

## Any other tech, ecosystem, or vertical of interest that wasn't listed?
_(vacío)_

## How could Vela fit into your product, and why does that part need privacy or confidential computing?

We come with a working protocol, not an idea. Today any machine installs with a single command, joins a P2P network, signs its manifest, and another node verifies it before accepting anything from it; distribution is proven across separate machines, and the gateway speaks the actual OpenAI protocol, so any existing client points at it without changing a line. Transport, discovery, and verification between nodes are a solved problem for us — and that is our differentiator.

What the protocol cannot solve on its own is the center of the marketplace. Someone has to match each request to a node, and in doing so sees both ends: who asked and who answered. Someone has to meter consumption, apply the price, and decide how much each provider gets paid. That forces a coordinator into existence — one that reconstructs the entire activity of the network and controls the money. Encrypting traffic doesn't prevent it, because the coordinator needs to read both sides to do its job. You cannot have an ownerless market if the piece that decides and charges belongs to someone.

That is why we're applying. We want to move the economic layer into the enclave: metering, batched settlement to each provider, and reputation. These are deterministic, asynchronous workloads that fit the WASM-job-with-onchain-settlement model, and they are exactly the logic that would otherwise require the network to trust us. With Vela we stop promising that we don't look: we can't — and with the enclave code published, anyone can verify it.

One piece we'd rather raise as an open question than promise: matching itself. It's where privacy is won or lost, but it also sits on the latency critical path, and a round trip to the enclave per request may not be viable. There are plausible designs — batching matches, precomputing assignments, moving only the linkage-revealing part into the enclave — and it's the kind of problem where six weeks with your team is worth more than six months on our own.

If this works, Vela is proven in a real inference market, with real hardware earning, where confidential execution isn't an added feature but the condition without which the product doesn't exist.

---

# 🎬 Startup's Media

## Startup's Web Page (URL)
_(vacío)_

## Startup's X Account (URL)
_(vacío)_

## Branding Kit (logo)
_Add a link to a google folder containing your logos options or branding kit, in case you need to update it later. Make sure anyone can access the folder and download your logos._

https://drive.google.com/drive/folders/1Jw0aUW3GYvPlxS3DHe739wmYiINrkXwp?usp=sharing

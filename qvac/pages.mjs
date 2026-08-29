// The 3 panels of the simulated marketplace, as plain HTML strings.
//
// They are embedded in JS (not as loose .html files under /public) on purpose:
// bare-pack builds the standalone binary by following the import graph from
// bin.mjs, and a static file outside that graph does not travel with the
// binary. An exported string does travel, with no need to resolve paths by hand
// nor to depend on bare-fs to serve static content.
//
// PHASE 9 - what the phase emitted but was not visible (the 402, the receipt,
// the D24 attestation and the D25 split) is drawn by `qvac/panel-x402.mjs`.
// That file is NOT imported to be called from here: it is imported to PASTE ITS
// CODE inside the <script> of each page, so the suite tests the very same
// functions the browser runs. The long note on why it lives there and not here
// is in that file's header.

import { FUENTE_EMBEBIDA } from './panel-x402.mjs'
import { FUENTE_EMBEBIDA_WALLET } from './panel-wallet.mjs'
// The version comes from package.json and is NOT copied here: a second literal
// is a second thing to forget on the next bump. `bin.mjs` already imports this
// same file, so the pattern is proven to survive bare-pack.
import pkg from '../package.json' with { type: 'json' }
import { LOGO_FUNDACION } from './logo.mjs'

const NAV = `
<nav class="nav">
  <span class="brand">PyrusLLM<span class="ver">v${pkg.version}</span></span>
  <a href="/">Chat</a>
  <a href="/node">My Node</a>
  <a href="/wallet">Wallet</a>
  <a href="/network">Network</a>
  <span class="agent offline" id="agent-chip"><i></i><b data-agent-label>checking…</b></span>
</nav>`

const STYLE = `
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: ui-sans-serif, system-ui, sans-serif;
    background: #0f1115; color: #e6e6e6;
  }
  .nav {
    display: flex; align-items: center; gap: 1.25rem;
    padding: .9rem 1.5rem; background: #171a21; border-bottom: 1px solid #262b36;
  }
  .nav .brand { font-weight: 700; margin-right: auto; color: #9fd6ff; }
  /* La version, al lado de la marca. Atenuada a proposito: es un dato de
     diagnostico -- lo primero que se pregunta cuando algo no anda igual en dos
     maquinas -- y no un titulo. */
  .nav .brand .ver {
    font-weight: 500; font-size: .68rem; color: #6b7386; margin-left: .4rem;
    font-family: ui-monospace, monospace; vertical-align: 1px;
  }
  .nav a { color: #cfd6e4; text-decoration: none; font-size: .92rem; }
  .nav a:hover { color: #fff; }
  main { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  .sub { color: #8b93a7; font-size: .88rem; margin-bottom: 1.5rem; }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }
  .card {
    background: #171a21; border: 1px solid #262b36; border-radius: 10px;
    padding: 1rem; cursor: pointer; transition: border-color .15s;
  }
  .card:hover { border-color: #4a7dfc; }
  .card.selected { border-color: #4a7dfc; box-shadow: 0 0 0 1px #4a7dfc; }
  /* Hierarchy inverted on purpose: the headline is WHO provides, not which
     model runs. With the model as the title, two cards from different operators
     looked practically identical -the model name is the same on both nodes- and
     the demo is precisely "I buy inference from the other machine".
     The overflow-wrap is mandatory: modelIds have no spaces and were being cut
     in half ("llama_3.2_1b_intruct_tool_calli"). */
  .card h3 { margin: 0 0 .1rem; font-size: 1.05rem; overflow-wrap: anywhere; }
  .card .model {
    font-family: ui-monospace, monospace; font-size: .72rem; color: #8b93a7;
    overflow-wrap: anywhere; line-height: 1.3;
  }
  .tags { display: flex; flex-wrap: wrap; gap: .3rem; margin: .4rem 0; }
  .tag {
    font-size: .72rem; background: #232838; color: #a9b4cc;
    padding: .1rem .5rem; border-radius: 999px;
  }
  .op { color: #8b93a7; font-size: .8rem; }
  .price { font-size: .82rem; color: #d7dbe4; margin-top: .5rem; }
  .price b { display: block; font-size: 1rem; color: #e6e6e6; }
  .price span { display: block; font-size: .74rem; color: #8b93a7; }

  /* Replaces the bar at 0%: an empty bar reading "0%" does not say whether the
     node is idle or hung. The state is named. */
  .state { font-size: .8rem; font-weight: 600; margin-top: .6rem; }
  .state.libre { color: #4ade80; }
  .state.busy { color: #fbbf24; }
  .state.full { color: #f87171; }

  /* The evidence line under the answer: without it the text just shows up and
     nothing says it travelled over P2P from another machine. It is the proof,
     not an ornament. */
  .meta {
    display: flex; flex-wrap: wrap; gap: .25rem .75rem; margin-top: .5rem;
    font-size: .76rem; color: #8b93a7; font-family: ui-monospace, monospace;
  }
  .meta b { color: #4ade80; font-weight: 600; }

  /* DHT discovery takes a measured ~17s. With no loading state that is 17
     seconds of blank screen in front of the judges, which reads as broken. */
  .hint { color: #8b93a7; font-size: .88rem; margin: 0 0 1rem; }
  .hint b { color: #9fd6ff; font-weight: 600; font-family: ui-monospace, monospace; }
  .skel { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 1rem; }
  .skel div {
    height: .7rem; border-radius: 999px; background: #232838; margin-bottom: .55rem;
    animation: pulso 1.4s ease-in-out infinite;
  }
  .skel div:nth-child(2) { animation-delay: .2s; }
  .skel div:nth-child(3) { animation-delay: .4s; }
  @keyframes pulso { 0%, 100% { opacity: .35 } 50% { opacity: .8 } }
  @media (prefers-reduced-motion: reduce) { .skel div { animation: none } }
  .bar-row { display: flex; align-items: center; gap: .5rem; margin-top: .6rem; }
  .bar { flex: 1; height: 6px; background: #262b36; border-radius: 999px; overflow: hidden; }
  .bar > div { height: 100%; border-radius: 999px; transition: width .4s ease; }
  .pct { font-size: .75rem; color: #a9b4cc; min-width: 3ch; text-align: right; }
  /* The two My Node gauges (Phase 6.5 and 6.6). They stack on a narrow screen:
     they are two independent readings, not a side-by-side comparison that
     breaks when the width is lost. */
  .econ-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem; }
  @media (max-width: 700px) { .econ-grid { grid-template-columns: 1fr; } }
  .econ-grid h4 { margin: 0 0 .3rem; font-size: .95rem; }
  .econ-big { font-size: 1.5rem; font-weight: 600; margin: .4rem 0 .5rem; color: #e8ecf5; }
  .bar-fill { height: 100%; border-radius: 999px; background: #5fa8ff; transition: width .4s ease; }
  .econ-row {
    display: flex; justify-content: space-between; gap: .8rem;
    font-size: .82rem; color: #a9b4cc; padding: .35rem 0; border-top: 1px solid #262b36;
  }
  .econ-row code { color: #8b93a7; }

  /* The external-assistant switch (Phase 8.5). Amber like the upstream badge:
     the same color in the panel, in the node list and in the chat provenance
     line, so that "this leaves the network" is learned once. */
  .up-switch {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    border: 1px solid #262b36; border-radius: 10px; padding: .9rem 1rem; margin-top: 1rem;
  }
  .up-switch button { margin: 0; white-space: nowrap; }
  .up-switch.on { border-color: #3a2a10; background: #1a1509; }
  .up-fila {
    display: flex; justify-content: space-between; gap: 1rem;
    padding: .45rem 0; border-bottom: 1px solid #1b1f27; font-size: .9rem;
  }
  .up-fila:last-child { border-bottom: 0; }
  .up-fila .off { color: #f87171; }
  .up-fila .ok { color: #fbbf24; }
  .badge {
    font-size: .7rem; padding: .1rem .5rem; border-radius: 999px; font-weight: 600;
  }
  .badge.online { background: #10331f; color: #4ade80; }
  .badge.offline { background: #3a1414; color: #f87171; }
  .badge.real { background: #1a2740; color: #7db8ff; }
  .badge.mock { background: #2a2440; color: #c7a9ff; }
  /* Green like 'online': a verified P2P peer is the good thing the demo shows,
     it cannot look like a mock. */
  .badge.peer { background: #10331f; color: #4ade80; }
  /* Amber, the warning color used across the rest of the UI: the external path
     works, but it is the only one where the prompt leaves the network and costs
     money. Neither the verified peer's green nor this machine's blue. */
  .badge.upstream { background: #3a2a10; color: #fbbf24; }
  /* Per-card actions. "Chat" comes first and in blue: it is the action that
     tells the demo by itself. "Connect" is secondary but it is the one proving
     this is a real gateway and not a chat with extra steps. */
  .actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem; }
  .actions button { margin-top: 0; font-size: .8rem; padding: .4rem .75rem; }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(6, 8, 12, .78); z-index: 50;
    display: flex; align-items: center; justify-content: center; padding: 1.5rem;
  }
  .modal {
    background: #171a21; border: 1px solid #2e3546; border-radius: 12px;
    padding: 1.25rem 1.4rem 1.4rem; width: 100%; max-width: 700px;
    max-height: 86vh; overflow-y: auto;
  }
  .modal h3 { margin: 0 0 .2rem; font-size: 1.1rem; }
  .modal .sub { margin-bottom: .8rem; }
  .tabs {
    display: flex; flex-wrap: wrap; gap: .2rem;
    border-bottom: 1px solid #262b36; margin: 1rem 0 1.1rem;
  }
  .tabs button {
    background: none; color: #8b93a7; margin: 0; padding: .5rem .85rem;
    border-radius: 8px 8px 0 0; font-size: .84rem;
    border-bottom: 2px solid transparent;
  }
  .tabs button:hover { background: #1f2430; color: #cfd6e4; }
  .tabs button.on { background: none; color: #9fd6ff; border-bottom-color: #4a7dfc; }

  /* Numbered steps. Without the numbering, four command blocks in a row read
     as alternatives rather than as a sequence -that happened with the Open
     WebUI modal, which people ran out of order-. */
  .step { display: flex; gap: .65rem; margin-bottom: 1rem; }
  .step .n {
    flex: none; width: 1.55rem; height: 1.55rem; border-radius: 999px;
    background: #232838; color: #9fd6ff; font-size: .76rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .step .body { flex: 1; min-width: 0; }
  .step p { margin: .2rem 0 .45rem; font-size: .86rem; color: #cfd6e4; line-height: 1.45; }
  .step p a { color: #9fd6ff; }

  .cmd { position: relative; }
  .cmd pre {
    background: #0c0f15; border: 1px solid #262b36; border-radius: 8px;
    padding: .7rem 5rem .7rem .75rem; margin: 0; overflow-x: auto;
    font-family: ui-monospace, monospace; font-size: .75rem; color: #d7dbe4;
    line-height: 1.5;
  }
  .cmd button {
    position: absolute; top: .4rem; right: .4rem; margin: 0;
    padding: .25rem .55rem; font-size: .72rem; background: #2c3348;
  }
  .cmd button:hover { background: #3a445e; }

  /* Real state of the external service, not "let us assume it started". */
  .dot { display: inline-flex; align-items: center; gap: .45rem; font-size: .82rem; color: #8b93a7; }
  .dot i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; font-style: normal; }
  .dot.up { color: #4ade80 } .dot.up i { background: #4ade80 }
  .dot.down { color: #f87171 } .dot.down i { background: #f87171 }

  /* Warning ahead of the steps. WhatsApp does not link a bot but THE
     operator's personal account: that has to be read before scanning the QR,
     not after, so it goes on top and not in the recipe's footer. */
  .aviso {
    background: #241d10; border: 1px solid #4a3a17; border-radius: 8px;
    padding: .6rem .75rem; margin: 0 0 1.1rem;
    font-size: .82rem; color: #e8c98a; line-height: 1.45;
  }

  .chat { margin-top: 1.5rem; border-top: 1px solid #262b36; padding-top: 1.5rem; }
  textarea, input[type=text] {
    width: 100%; background: #10131a; border: 1px solid #262b36; color: #e6e6e6;
    border-radius: 8px; padding: .6rem; font-family: inherit; font-size: .9rem;
  }
  textarea { min-height: 70px; resize: vertical; }
  button {
    background: #4a7dfc; color: #fff; border: none; border-radius: 8px;
    padding: .55rem 1.1rem; font-size: .88rem; cursor: pointer; margin-top: .6rem;
  }
  button:hover { background: #3a6ae8; }
  button.danger { background: #d84343; }
  button.danger:hover { background: #c22f2f; }
  button.ghost { background: #232838; }
  button.ghost:hover { background: #2c3348; }
  pre.response {
    white-space: pre-wrap; background: #10131a; border: 1px solid #262b36;
    border-radius: 8px; padding: .8rem; margin-top: .8rem; min-height: 3em;
    font-family: inherit; font-size: .9rem;
  }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .5rem .6rem; font-size: .85rem; border-bottom: 1px solid #1f2430; }
  th { color: #8b93a7; font-weight: 600; font-size: .78rem; text-transform: uppercase; }
  select { background: #10131a; color: #e6e6e6; border: 1px solid #262b36; border-radius: 8px; padding: .5rem; }
  .field { margin-bottom: 1rem; }
  .field label { display: block; font-size: .82rem; color: #a9b4cc; margin-bottom: .3rem; }
  .log { font-family: ui-monospace, monospace; font-size: .78rem; color: #a9b4cc; }
  .log div { padding: .25rem 0; border-bottom: 1px solid #1a1e28; }
  .muted { color: #6b7386; }

  /* Agent state, visible on all three pages: it is the condition that decides
     whether the network is reachable at all, so it cannot live on one screen
     only. */
  .nav .agent { margin-left: auto; display: inline-flex; align-items: center; gap: .45rem; font-size: .8rem; }
  .nav .agent i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; display: block; flex: none; }
  .nav .agent b { font-weight: 600; }
  .nav .agent.offline { color: #8b93a7 }
  .nav .agent.launching { color: #fbbf24 } .nav .agent.launching i { background: #fbbf24 }
  .nav .agent.live { color: #4ade80 } .nav .agent.live i { background: #4ade80 }
  .nav .agent.error { color: #f87171 } .nav .agent.error i { background: #f87171 }

  /* ---------------------------------------------------------------- chat */
  /* 'chatpage' and not 'chat': a .chat class already exists in the Network
     panel (the old chat block) carrying margin-top, and body inherited it. */
  body.chatpage { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  body.chatpage main {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    max-width: 780px; width: 100%; padding: 0 1.25rem;
  }
  /* The JS sets display:flex when showing it; the direction and the flex-1
     have to live here, or the thread and the composer end up side by side. */
  #chat { flex: 1; min-height: 0; flex-direction: column; }
  #thread { flex: 1; min-height: 0; overflow-y: auto; padding: 1.5rem 0 1rem; }

  /* The gate. It is the first thing seen while the agent is off. */
  .gate { max-width: 30rem; margin: auto; padding: 3rem 0; text-align: center; }
  /* The foundation mark. It sits ABOVE the headline because this screen is the
     first thing a new operator sees, and it is the only place in the panel
     where whose node this is belongs -- repeating it on every screen would be
     branding noise on a working tool.
     The width is capped in rem and not in px so it follows the text scale, and
     height:auto keeps the aspect ratio when the column narrows. Backticks are
     banned in here: this whole block is a template literal. */
  .gate .logo { display: block; width: 100%; max-width: 8.5rem; height: auto;
    margin: 0 auto 1.6rem; opacity: .92; }
  @media (max-width: 480px) { .gate .logo { max-width: 6.5rem; } }
  .gate h1 { font-size: 1.5rem; margin-bottom: .6rem; }
  .gate p { color: #8b93a7; font-size: .92rem; line-height: 1.6; margin: 0 0 1.5rem; }
  .gate button { font-size: .95rem; padding: .7rem 1.5rem; }
  .gate .alt {
    display: inline-block; margin-top: 1.1rem; font-size: .84rem;
    color: #8b93a7; background: none; border: none; cursor: pointer; text-decoration: underline;
  }
  .gate .alt:hover { color: #cfd6e4; }
  .gate .err { color: #f87171; font-size: .84rem; margin-top: .9rem; }

  .msg { margin-bottom: 1.4rem; }
  .msg .who {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .06em;
    color: #8b93a7; margin-bottom: .35rem;
  }
  .msg.user .body {
    background: #171a21; border: 1px solid #262b36; border-radius: 10px;
    padding: .7rem .9rem;
  }
  .msg .body { font-size: .95rem; line-height: 1.65; overflow-wrap: anywhere; }
  .msg .body p { margin: 0 0 .7rem; }
  .msg .body p:last-child { margin-bottom: 0; }
  .msg .body h3, .msg .body h4 { margin: 1rem 0 .5rem; font-size: 1rem; }
  .msg .body ul, .msg .body ol { margin: 0 0 .7rem; padding-left: 1.3rem; }
  .msg .body li { margin-bottom: .25rem; }
  .msg .body code {
    font-family: ui-monospace, monospace; font-size: .85em;
    background: #10131a; border: 1px solid #262b36; border-radius: 4px; padding: .05rem .3rem;
  }
  .msg .body pre {
    background: #0c0f15; border: 1px solid #262b36; border-radius: 8px;
    padding: .8rem; overflow-x: auto; margin: 0 0 .7rem;
  }
  .msg .body pre code { background: none; border: none; padding: 0; font-size: .8rem; }
  .msg .caret::after {
    content: ''; display: inline-block; width: .5rem; height: 1em;
    background: #4a7dfc; vertical-align: text-bottom; animation: blink 1s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0 } }
  @media (prefers-reduced-motion: reduce) { .msg .caret::after { animation: none } }

  /* The provenance line: who answered, how long it took. Without it the chat
     is indistinguishable from any other and the network stops being visible. */
  .prov {
    display: flex; flex-wrap: wrap; gap: .25rem .7rem; margin-top: .5rem;
    font-size: .74rem; color: #8b93a7; font-family: ui-monospace, monospace;
    align-items: center;
  }
  .prov .peer { color: #4ade80; font-weight: 600; }
  .prov .local { color: #7db8ff; font-weight: 600; }
  .prov .upstream { color: #fbbf24; font-weight: 600; }
  /* The cost is not highlighted the way the operator is: it is a figure, not
     an alarm. It stands apart from the latency without shouting. */
  .prov .cost { font-variant-numeric: tabular-nums; }

  .composer { border-top: 1px solid #262b36; padding: .9rem 0 1.1rem; }
  .composer .row { display: flex; gap: .5rem; align-items: flex-end; }
  .composer textarea {
    flex: 1; min-height: 2.6rem; max-height: 11rem; resize: none;
    padding: .65rem .75rem;
  }
  .composer button { margin-top: 0; flex: none; }
  .composer .opts {
    display: flex; flex-wrap: wrap; gap: .6rem; align-items: center;
    margin-bottom: .55rem; font-size: .8rem; color: #8b93a7;
  }
  .composer select {
    background: #10131a; border: 1px solid #262b36; color: #e6e6e6;
    border-radius: 6px; padding: .3rem .45rem; font-family: inherit; font-size: .8rem;
  }
  .composer select:disabled { opacity: .55; }
  .composer label.chk { display: inline-flex; align-items: center; gap: .35rem; cursor: pointer; }

  /* Action palette (Ctrl+K). It lives in the chat and not in a separate panel
     because what it does -- switch model, clear, check spending -- are
     decisions taken WHILE typing, not before. */
  .pal-overlay {
    position: fixed; inset: 0; background: rgba(8,10,16,.72);
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 12vh; z-index: 50;
  }
  .pal {
    width: min(680px, 92vw); background: #161b28;
    border: 1px solid #2c3348; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.5);
  }
  .pal input.filtro {
    width: 100%; box-sizing: border-box; background: transparent; border: 0;
    border-bottom: 1px solid #2c3348; color: #e8ecf6;
    padding: .85rem 1rem; font-size: .95rem; outline: none;
  }
  .pal-lista { max-height: 52vh; overflow-y: auto; padding: .35rem 0; }
  .pal-grupo {
    padding: .55rem 1rem .25rem; font-size: .72rem; text-transform: uppercase;
    letter-spacing: .06em; color: #7c8699;
  }
  .pal-item {
    display: flex; align-items: center; gap: .6rem; width: 100%;
    padding: .5rem 1rem; background: transparent; border: 0; cursor: pointer;
    color: #e8ecf6; font-size: .9rem; text-align: left; margin: 0; border-radius: 0;
  }
  .pal-item:hover, .pal-item.sel { background: #232838; }
  .pal-item .der { margin-left: auto; display: flex; align-items: center; gap: .5rem; }
  .pal-item .val { font-size: .8rem; color: #9aa4b8; }

  /* The mock marker is NOT decorative: the project requires everything
     simulated to be visible. A control that looks functional and does nothing
     is worse than a missing one, because whoever uses it believes it is already
     configured. */
  .pal-item .mock {
    font-size: .66rem; text-transform: uppercase; letter-spacing: .05em;
    background: #3a2f16; color: #e0b95a; border: 1px solid #5a4a20;
    padding: .1rem .4rem; border-radius: 4px;
  }
  .pal-item[disabled] { cursor: default; }
  .pal-item[disabled]:hover { background: transparent; }

  /* Switch and stepper: they are real-looking controls even though almost all
     of them are mocked, because the point of the request is to see the shape.
     */
  .sw { width: 34px; height: 19px; border-radius: 999px; background: #2c3348; position: relative; flex: none; }
  .sw.on { background: #4f7cff; }
  .sw i { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #e8ecf6; transition: left .12s; }
  .sw.on i { left: 17px; }
  .esf { display: flex; gap: 4px; align-items: center; }
  .esf b { width: 7px; height: 7px; border-radius: 50%; background: #2c3348; display: block; }
  .esf b.on { background: #9aa4b8; }
  .esf b.pico { background: #a06cff; }

  .pal-pie { border-top: 1px solid #2c3348; padding: .5rem 1rem; font-size: .72rem; color: #7c8699; }
  .pal-vacio { padding: 1.2rem 1rem; color: #7c8699; font-size: .88rem; }

  /* The composer's "+" */
  .mas-menu {
    position: absolute; bottom: calc(100% + .4rem); left: 0; min-width: 210px;
    background: #161b28; border: 1px solid #2c3348; border-radius: 10px;
    padding: .3rem 0; z-index: 40; box-shadow: 0 12px 30px rgba(0,0,0,.45);
  }
  .composer .row { position: relative; }
  .adjuntos { display: flex; flex-wrap: wrap; gap: .35rem; padding: 0 0 .4rem; }
  .adjunto {
    display: inline-flex; align-items: center; gap: .35rem; font-size: .74rem;
    background: #232838; border: 1px solid #2c3348; border-radius: 6px; padding: .15rem .45rem;
  }
  .adjunto button { all: unset; cursor: pointer; color: #7c8699; padding: 0 .1rem; }
  .adjunto button:hover { color: #e8ecf6; }
  .composer .note { margin-left: auto; font-size: .76rem; }
  .composer .note a { color: #9fd6ff; }

  /* -------------------------------------------------------------------------
     PHASE 9 — the four artifacts the phase emits that until now were only
     visible through curl. The HTML is built by qvac/panel-x402.mjs; here is how
     it looks.

     The three tones are the part that is NOT decoration, which is why they sit
     together:

       good     a fact verified HERE (a recomputed hash that matches);
       warm     a figure with a caveat that has to be read -- an absence with a
                reason, a tx hash nobody checked against the chain, a signature
                this page does not verify;
       bad      something that reads as proof and is not: a mock, a hash that
                does not match, a synthetic tx, a settlement that failed.

     A mock painted green would be exactly the functional-looking mock the
     project rule forbids.
     ------------------------------------------------------------------------- */
  .x402 {
    border: 1px solid #2c3348; border-left: 3px solid #5fa8ff; border-radius: 8px;
    background: #141822; padding: .8rem .9rem; margin: .6rem 0; font-size: .8rem;
  }
  .x402.x-par { display: grid; grid-template-columns: 1fr 1fr; gap: .9rem; align-items: start; }
  @media (max-width: 820px) { .x402.x-par { grid-template-columns: 1fr; } }
  .x-tit {
    font-weight: 600; color: #cfe0ff; margin-bottom: .5rem; font-size: .82rem;
    letter-spacing: .01em;
  }
  .x-bloque { min-width: 0; }
  .x-op { border-top: 1px solid #262b36; padding-top: .5rem; margin-top: .5rem; }
  .x-fila {
    display: flex; gap: .8rem; align-items: baseline; padding: .18rem 0;
    border-bottom: 1px solid #1d2230;
  }
  .x-k {
    color: #8b93a7; font-size: .72rem; min-width: 11ch; flex: 0 0 auto;
    text-transform: none; letter-spacing: .02em;
  }
  /* overflow-wrap is mandatory: addresses, hashes and signatures have no
     spaces and were spilling out of the card cut in half. */
  .x-v { color: #dbe2ef; overflow-wrap: anywhere; min-width: 0; }
  .x-v.mono, .x-pre { font-family: ui-monospace, monospace; font-size: .72rem; }
  .x-v.malo { color: #f87171; }
  .x-nota { color: #7c8699; font-size: .72rem; margin: .3rem 0 .1rem; line-height: 1.4; }
  .x-aviso {
    border-radius: 6px; padding: .35rem .5rem; margin: .35rem 0; font-size: .74rem;
    line-height: 1.45; overflow-wrap: anywhere;
  }
  .x-aviso.bueno { background: #12291c; color: #86efac; border: 1px solid #1f4a31; }
  .x-aviso.tibio { background: #2a2413; color: #fcd34d; border: 1px solid #4a3d18; }
  .x-aviso.malo  { background: #2d1618; color: #fca5a5; border: 1px solid #542125; }
  .x-det { margin-top: .5rem; }
  .x-det summary { cursor: pointer; color: #8b93a7; font-size: .74rem; }
  .x-pre {
    background: #0f1218; border: 1px solid #262b36; border-radius: 6px; padding: .5rem;
    margin: .4rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #a9b4cc;
  }
  /* D25 — "measured" and "estimated" do NOT share a color. That is the whole
     rule: a count of SSE chunks painted like a provider usage is the cheapest
     way to turn an estimate into a number. */
  .x-conteo {
    font-family: ui-monospace, monospace; font-size: .71rem; white-space: nowrap;
    border-radius: 999px; padding: .05rem .5rem; border: 1px solid transparent;
  }
  .x-conteo.tono-medido   { color: #86efac; background: #12291c; border-color: #1f4a31; }
  .x-conteo.tono-estimado { color: #fcd34d; background: #2a2413; border-color: #4a3d18; }
  .x-conteo.tono-ausente  { color: #7c8699; background: #1a1e28; border-color: #262b36; }
  .x-buscar { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .8rem 0; }
  .x-buscar input {
    flex: 1; min-width: 16rem; background: #0f1218; color: #e6e6e6; font-size: .82rem;
    border: 1px solid #2c3348; border-radius: 8px; padding: .5rem .65rem;
    font-family: ui-monospace, monospace;
  }
  .x-buscar button { margin: 0; white-space: nowrap; }

  /* -----------------------------------------------------------------------
     /wallet panel (Phase 11). Narrow phone-wallet column: the visual reference
     is a mobile wallet, not a table. Read-only — the send buttons are drawn
     disabled, see qvac/panel-wallet.mjs.
     ----------------------------------------------------------------------- */
  .w-root { max-width: 460px; margin: 1.5rem auto 0; }
  .w-card {
    background: #12151c; border: 1px solid #262b36; border-radius: 16px;
    padding: 1.1rem 1.1rem .4rem; display: flex; flex-direction: column; gap: 1rem;
  }
  .w-head { display: flex; flex-direction: column; gap: .5rem; }
  .w-acct { display: flex; align-items: center; gap: .55rem; }
  .w-acct-dot {
    width: 1.7rem; height: 1.7rem; border-radius: 999px; flex: none;
    background: #232838; color: #9fd6ff; font-weight: 700; font-size: .8rem;
    display: flex; align-items: center; justify-content: center;
  }
  .w-acct-name {
    font-family: ui-monospace, monospace; font-size: .9rem; color: #e6e6e6; margin-right: auto;
  }
  .w-copy {
    margin: 0; padding: .3rem .6rem; font-size: .72rem; background: #232838;
  }
  .w-copy:hover { background: #2c3348; }
  .w-copy.grande { display: block; width: 100%; margin-top: .6rem; padding: .55rem; font-size: .82rem; }
  .w-red { font-size: .76rem; color: #8b93a7; font-family: ui-monospace, monospace; }
  .w-red.es-prueba { color: #fbbf24; }

  .w-balance { text-align: center; padding: .6rem 0 .2rem; }
  .w-balance-num {
    font-size: 2.1rem; font-weight: 700; color: #f2f5fb;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .w-balance-sub { font-size: .74rem; color: #8b93a7; margin-top: .3rem; }

  .w-acc { display: grid; grid-template-columns: repeat(3, 1fr); gap: .55rem; }
  .w-acc-b {
    margin: 0; display: flex; flex-direction: column; align-items: center; gap: .25rem;
    padding: .6rem .2rem; font-size: .78rem; background: #1b2432;
  }
  .w-acc-b span { font-size: 1rem; }
  .w-acc-b:hover:not(:disabled) { background: #24304180; }
  .w-acc-b:disabled { opacity: .4; cursor: not-allowed; }

  .w-assets-head { font-size: .84rem; color: #a9b4cc; }
  .w-filtro {
    width: 100%; background: #0f1218; color: #e6e6e6; font-size: .82rem;
    border: 1px solid #2c3348; border-radius: 999px; padding: .5rem .9rem; margin: .5rem 0 .2rem;
  }
  .w-filas { display: flex; flex-direction: column; }
  .w-fila {
    display: flex; align-items: center; gap: .7rem; padding: .65rem .1rem;
    border-top: 1px solid #1b1f27;
  }
  .w-fila:first-child { border-top: 0; }
  .w-ico {
    width: 2rem; height: 2rem; border-radius: 999px; flex: none;
    background: #232838; color: #cfd6e4; font-size: .62rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .w-fila-txt { flex: 1; min-width: 0; }
  .w-sym { font-size: .9rem; color: #e6e6e6; }
  .w-name {
    font-size: .72rem; color: #8b93a7; overflow-wrap: anywhere; line-height: 1.3;
  }
  .w-fila-err { font-size: .72rem; color: #fca5a5; margin-top: .15rem; }
  .w-amt {
    font-family: ui-monospace, monospace; font-size: .92rem; color: #e6e6e6;
    font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere;
  }
  .w-amt.es-nativo { color: #9fd6ff; }
  .w-vacio { font-size: .82rem; color: #8b93a7; padding: .9rem .1rem; }
  .w-vacio code { font-family: ui-monospace, monospace; color: #cfd6e4; }
  .w-aviso {
    font-size: .78rem; border-radius: 8px; padding: .55rem .7rem; line-height: 1.4;
  }
  .w-aviso.malo { background: #2d1618; color: #fca5a5; border: 1px solid #542125; }

  .w-dep { text-align: center; }
  .w-dep-lbl { font-size: .78rem; color: #8b93a7; margin-bottom: .5rem; }
  .w-dep-addr {
    font-family: ui-monospace, monospace; font-size: .82rem; color: #e6e6e6;
    background: #0f1218; border: 1px solid #262b36; border-radius: 8px;
    padding: .7rem; overflow-wrap: anywhere;
  }
  .w-dep-nota { font-size: .74rem; color: #8b93a7; margin-top: .7rem; line-height: 1.45; }
  .w-dep-nota.tenue { color: #6b7386; }
  .w-dep-nota b { color: #cfd6e4; }
  .w-dep-link { display: inline-block; margin-top: .6rem; font-size: .78rem; color: #9fd6ff; }

  /* The QR (Phase 12). The white background comes from the <svg> itself and
     does NOT follow the dark theme: a QR reader needs dark-on-light contrast,
     and an inverted one will not scan on many phones. It is the only light
     thing in the panel. */
  .w-qr { display: flex; justify-content: center; margin: .2rem 0 .8rem; }
  .w-qr svg { border-radius: 8px; max-width: 100%; height: auto; }

  /* History (Phase 12). Same rows as the assets, with the direction arrow up
     front and the amount signed. */
  .w-hist { display: flex; flex-direction: column; gap: .4rem; }
  .w-hist-fila {
    display: flex; align-items: center; gap: .7rem; padding: .6rem .1rem;
    border-top: 1px solid #1b1f27;
  }
  .w-hist-fila:first-child { border-top: 0; }
  .w-hist-fila.con-error .w-amt { color: #fca5a5; }
  .w-hist .w-ico { font-size: .95rem; }
  .w-hist .w-ico.entra { color: #86efac; }
  .w-hist .w-ico.sale { color: #cfd6e4; }
  .w-hist .w-amt.entra { color: #86efac; }
  .w-hist-quien { font-family: ui-monospace, monospace; font-size: .78rem; color: #8b93a7; }
  .w-hist .w-name a { color: #9fd6ff; font-family: ui-monospace, monospace; }
  .w-hist-crudo { font-size: .66rem; color: #fbbf24; font-family: system-ui, sans-serif; }
  .w-hist-vacio { font-size: 1.4rem; color: #6b7386; text-align: center; padding: .6rem 0; }
  .w-aviso.tibio { background: #2a2413; color: #fcd34d; border: 1px solid #4a3d18; }
  .w-aviso.bueno { background: #12291c; color: #86efac; border: 1px solid #1f4a31; }

  /* Send (Phase 12). Covers the card while it lasts: form -> review -> status.
     The poll does not repaint until you come back. */
  .w-envio { display: flex; flex-direction: column; gap: .7rem; padding: .3rem 0 .5rem; }
  .w-envio-tit { font-size: 1rem; color: #f2f5fb; font-weight: 600; }
  .w-envio-campo { display: flex; flex-direction: column; gap: .3rem; }
  .w-envio-campo label {
    font-size: .74rem; color: #8b93a7; text-transform: uppercase; letter-spacing: .03em;
  }
  .w-envio-campo input, .w-envio-campo select {
    width: 100%; background: #0f1218; color: #e6e6e6; font-size: .86rem;
    border: 1px solid #2c3348; border-radius: 8px; padding: .55rem .65rem;
    font-family: ui-monospace, monospace;
  }
  .w-envio-acc { display: flex; gap: .5rem; margin-top: .2rem; }
  .w-envio-acc .w-onb-b { flex: 1; }
  .w-envio-rev {
    display: flex; flex-direction: column; gap: .2rem; font-size: .74rem; color: #8b93a7;
    border-top: 1px solid #1b1f27; padding-top: .5rem;
  }
  .w-envio-rev code {
    font-family: ui-monospace, monospace; color: #e6e6e6; font-size: .82rem;
    overflow-wrap: anywhere;
  }
  .w-envio-rev.tenue code { color: #6b7386; }
  .w-envio-det summary { cursor: pointer; color: #8b93a7; font-size: .74rem; }
  .w-envio-det pre {
    background: #0f1218; border: 1px solid #262b36; border-radius: 6px; padding: .5rem;
    margin: .4rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #a9b4cc;
    font-size: .7rem;
  }

  .w-tabs {
    display: flex; gap: .1rem; border-top: 1px solid #262b36;
    margin: .4rem -1.1rem 0; padding: .3rem .4rem 0;
  }
  .w-tab {
    flex: 1; margin: 0; background: none; color: #8b93a7; font-size: .74rem;
    padding: .6rem .2rem; border-radius: 0;
  }
  .w-tab:hover:not(:disabled) { color: #cfd6e4; background: none; }
  .w-tab.on { color: #9fd6ff; }
  .w-tab:disabled { opacity: .4; cursor: not-allowed; }

  /* Onboarding: create or import the wallet from the panel (Phase 11). */
  .w-onb { display: flex; flex-direction: column; gap: .8rem; padding: .4rem 0 .6rem; }
  .w-onb-tit { font-size: 1rem; color: #e6e6e6; font-weight: 600; }
  .w-onb-txt { font-size: .82rem; color: #a9b4cc; line-height: 1.5; }
  .w-onb-txt code, .w-onb-tit code { font-family: ui-monospace, monospace; color: #cfd6e4; font-size: .92em; }
  .w-onb-acc { display: flex; flex-wrap: wrap; gap: .5rem; }
  .w-onb-b { margin: 0; background: #1b2432; font-size: .82rem; }
  .w-onb-b.primaria { background: #4a7dfc; }
  .w-onb-b.primaria:hover { background: #3a6ae8; }
  .w-onb-b:disabled { opacity: .45; cursor: not-allowed; }
  .w-onb-import { display: flex; flex-direction: column; gap: .5rem; }
  .w-onb-import textarea {
    width: 100%; background: #0f1218; color: #e6e6e6; font-size: .82rem;
    border: 1px solid #2c3348; border-radius: 8px; padding: .55rem;
    font-family: ui-monospace, monospace; resize: vertical;
  }
  .w-onb-msg { font-size: .78rem; min-height: 1.1em; }
  .w-onb-ok { color: #86efac; }
  .w-onb-err { color: #fca5a5; }

  /* The 24-word screen: shown exactly once. */
  .w-seed { display: flex; flex-direction: column; gap: .8rem; padding: .3rem 0 .5rem; }
  .w-seed-tit { font-size: .95rem; color: #f2f5fb; font-weight: 600; }
  .w-seed-grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: .35rem .6rem;
  }
  @media (min-width: 380px) { .w-seed-grid { grid-template-columns: repeat(3, 1fr); } }
  .w-seed-w {
    font-family: ui-monospace, monospace; font-size: .82rem; color: #e6e6e6;
    background: #0f1218; border: 1px solid #262b36; border-radius: 6px;
    padding: .35rem .5rem; display: flex; gap: .4rem; align-items: baseline;
  }
  .w-seed-w b { color: #6b7386; font-size: .68rem; min-width: 1.3ch; text-align: right; }
  .w-seed-ok { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: #cfd6e4; }
  .w-seed-ok input { width: auto; }

  /* Network selector (Phase 11). No hot-swap: it saves and asks for a restart. */
  .w-red-box {
    border-top: 1px solid #262b36; margin: .2rem -1.1rem 0; padding: .8rem 1.1rem .4rem;
    display: flex; flex-direction: column; gap: .4rem;
  }
  .w-red-lbl { font-size: .74rem; color: #8b93a7; text-transform: uppercase; letter-spacing: .03em; }
  .w-red-val { font-size: .84rem; color: #cfd6e4; font-family: ui-monospace, monospace; }
  .w-red-row { display: flex; gap: .5rem; align-items: center; }
  .w-red-sel {
    flex: 1; background: #0f1218; color: #e6e6e6; font-size: .82rem;
    border: 1px solid #2c3348; border-radius: 8px; padding: .45rem .5rem;
  }
  .w-red-row .w-onb-b { white-space: nowrap; }
  .w-red-nota { font-size: .72rem; color: #6b7386; line-height: 1.45; }
  .w-red-nota code { font-family: ui-monospace, monospace; color: #a9b4cc; }
  .w-red-nota b { color: #a9b4cc; }

  /* -----------------------------------------------------------------------
     Settings (Phase 12). Overlay INSIDE the card, not a global modal: the
     wallet is a narrow column and its configuration belongs to that column. It
     closes with ✕, with Esc and by clicking outside.
     ----------------------------------------------------------------------- */
  .w-set-ov {
    position: fixed; inset: 0; z-index: 40; background: #05070bcc;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 1.5rem 1rem; overflow-y: auto;
  }
  .w-set {
    width: 100%; max-width: 460px; background: #12151c; border: 1px solid #262b36;
    border-radius: 16px; padding: 1rem 1.1rem 1.1rem;
    display: flex; flex-direction: column; gap: .9rem;
  }
  .w-set-head { display: flex; align-items: center; gap: .5rem; }
  .w-set-tit { font-size: 1rem; color: #f2f5fb; font-weight: 600; margin-right: auto; }
  /* The network selector, moved here, no longer needs the border that set it
     apart from the rest of the card: EVERYTHING on this screen is
     configuration now. */
  .w-set .w-red-box { border-top: 0; margin: 0; padding: 0; }
  .w-set-bloque {
    border-top: 1px solid #262b36; padding-top: .8rem;
    display: flex; flex-direction: column; gap: .45rem;
  }
  .w-set-toks { display: flex; flex-direction: column; }
  .w-set-tok {
    display: flex; align-items: center; gap: .6rem; padding: .5rem .1rem;
    border-top: 1px solid #1b1f27;
  }
  .w-set-tok:first-child { border-top: 0; }
  .w-set-dec { color: #6b7386; font-size: .74rem; }
  .w-set-quitar { font-size: .72rem; padding: .3rem .6rem; white-space: nowrap; }
  .w-set-form { display: flex; flex-direction: column; gap: .45rem; margin-top: .3rem; }
  .w-set-form input {
    width: 100%; background: #0f1218; color: #e6e6e6; font-size: .82rem;
    border: 1px solid #2c3348; border-radius: 8px; padding: .5rem .6rem;
    font-family: ui-monospace, monospace;
  }
  .w-set-form-row { display: flex; gap: .45rem; }
  .w-set-form-row input { min-width: 0; }
  .w-set-form-row #w-token-dec { max-width: 6.5rem; }
  .w-set-form-row .w-onb-b { white-space: nowrap; }
  .w-set-dato {
    display: flex; flex-direction: column; gap: .15rem; font-size: .74rem; color: #8b93a7;
  }
  .w-set-dato code {
    font-family: ui-monospace, monospace; color: #cfd6e4; font-size: .74rem;
    overflow-wrap: anywhere;
  }
  .w-set-flag { color: #fbbf24; font-size: .72rem; }
</style>`

// HTML escaping, injected into the script of the 3 panels.
//
// This is not textbook paranoia: the price is written by the provider from
// their own panel and shown raw in all three. A price like
// `<img src=x onerror=alert(1)>` executed on page load —tested—. EVERYTHING
// coming from the server is escaped, not just the price, because the day an
// operator name or a tag becomes editable the hole comes back on its own.
const ESC = `
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }`

// The nav chip lives on ALL THREE pages and paints itself. It is the only
// shared state, and it has to be: if the agent is off the network does not
// answer, and that has to be visible from wherever you are standing -- not
// just in the chat.
const AGENT_CHIP = `
<script>
  // ---------------------------------------------------------------------
  // The panel credential.
  //
  // The gateway gate stopped accepting requests without Authorization, and the
  // page is not exempt: it asks for its own and sends it like any other
  // client. One single authentication path, with no back door for the browser.
  // ---------------------------------------------------------------------
  window.__panelKey = null

  async function panelKey() {
    if (window.__panelKey) return window.__panelKey
    try {
      const r = await fetch('/v1/keys/panel')
      const d = await r.json()
      window.__panelKey = d.key
    } catch (e) { /* with no key the gate answers 401 and the reason shows */ }
    return window.__panelKey
  }

  window.authFetch = async function (url, opts) {
    const k = await panelKey()
    const o = Object.assign({}, opts || {})
    o.headers = Object.assign({}, o.headers || {}, k ? { Authorization: 'Bearer ' + k } : {})
    return fetch(url, o)
  }

  window.__agent = null
  async function pollAgent() {
    try {
      const r = await fetch('/v1/agent')
      const a = await r.json()
      window.__agent = a
      const chip = document.getElementById('agent-chip')
      if (chip) {
        chip.className = 'agent ' + a.status
        const label = {
          live: 'Live · serving',
          launching: 'Launching…',
          offline: 'Node offline',
          error: 'Launch failed'
        }
        chip.querySelector('[data-agent-label]').textContent = label[a.status] || a.status
      }
      if (typeof window.onAgent === 'function') window.onAgent(a)
    } catch (err) { /* the gateway went down: the chip stays as it was */ }
  }
  pollAgent()
  setInterval(pollAgent, 2500)
</script>`

function page(title, body, bodyClass) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${STYLE}
</head>
<body class="${bodyClass || ''}">
  ${NAV}
  ${AGENT_CHIP}
  <main>${body}</main>
</body>
</html>`
}

// Modal pieces, shared by /network (files) and /node (connect).
// They live here and not inside one page because "Connect" moved to My Node
// -- the credential authenticates against YOUR gateway, not the remote node --
// and copy/close/format are still needed by both.
const MODAL_JS = `
    // navigator.clipboard does NOT exist outside a secure context. The panel
    // opens over http://localhost (secure) but also over http://192.168.x.x
    // from another machine on the LAN, where the API is missing and the "Copy"
    // button silently did nothing. Hence the execCommand fallback.
    async function copyText(text, btn) {
      let ok = false
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          ok = true
        }
      } catch { /* falls through to the fallback */ }
      if (!ok) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { ok = document.execCommand('copy') } catch { ok = false }
        document.body.removeChild(ta)
      }
      const before = btn.textContent
      btn.textContent = ok ? 'Copied' : 'Copy it by hand'
      setTimeout(() => { btn.textContent = before }, 1600)
    }

    let estadoPoll = null

    function cerrarModal() {
      clearInterval(estadoPoll)
      estadoPoll = null
      document.getElementById('modal').innerHTML = ''
      document.removeEventListener('keydown', onEsc)
    }

    function onEsc(ev) { if (ev.key === 'Escape') cerrarModal() }

    // Simple modal for already-built content. The panels that need one with
    // tabs and polling still write #modal by hand; this is for the common case
    // -- a title and a body -- which used to force repeating the overlay, the
    // Esc close and the click-outside close in every single place.
    function openModal(title, bodyHtml) {
      document.getElementById('modal').innerHTML =
        '<div class="modal-overlay" id="modal-overlay"><div class="modal">' +
        '<h3>' + esc(title) + '</h3>' + bodyHtml +
        '<div style="margin-top:1rem"><button class="ghost" id="modal-cerrar">Close</button></div>' +
        '</div></div>'
      document.getElementById('modal-cerrar').addEventListener('click', cerrarModal)
      document.getElementById('modal-overlay').addEventListener('click', function (ev) {
        if (ev.target.id === 'modal-overlay') cerrarModal()
      })
      document.addEventListener('keydown', onEsc)
    }

    function formatBytes(n) {
      if (!n) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }
`

// The "Connect" recipes: the same node, consumed from outside the panel.
// It is the proof that this is a genuine OpenAI-compatible gateway and not a
// chat with our own protocol inside.
const CONNECT_JS = `
    function recipes(c) {
      const model = c.node.modelId

      // The provider block is identical for every OpenClaw channel -the only
      // thing that changes is which channel is turned on-, so it is built once
      // and each recipe passes ITS OWN channels block. Duplicating the whole
      // config per channel guaranteed one of them would drift out of date.
      const configOpenclaw = (channel) => [
        '{',
        '  models: {',
        '    providers: {',
        '      qvac: {',
        '        baseUrl: "' + c.baseUrl + '",',
        '        apiKey: "' + c.apiKey + '",',
        '        api: "openai-completions",',
        '        models: [{ id: "' + model + '", name: "PyrusLLM · P2P network" }]',
        '      }',
        '    }',
        '  },',
        '  agents: { defaults: { model: "qvac/' + model + '" } },',
        '  channels: {',
        channel,
        '  }',
        '}'
      ].join('\\n')

      const providerQvac = configOpenclaw([
        '    telegram: {',
        '      enabled: true,',
        '      botToken: "PEGA_ACA_EL_TOKEN_DE_BOTFATHER",',
        '      dmPolicy: "pairing"',
        '    }'
      ].join('\\n'))

      const providerWhatsapp = configOpenclaw([
        '    whatsapp: {',
        '      enabled: true,',
        '      dmPolicy: "pairing",',
        '      allowFrom: ["+549XXXXXXXXXX"]',
        '    }'
      ].join('\\n'))

      return {
        telegram: {
          title: 'Telegram',
          footer: 'OpenClaw is a self-hosted agent runtime. You message the bot from your phone and this node generates the answer — no OpenAI and no third-party server in between.',
          steps: [
            { text: 'Install OpenClaw.', cmd: 'npm install -g openclaw' },
            { text: 'On Telegram, talk to <b>@BotFather</b>, send <b>/newbot</b> and save the token it gives you (it looks like <code>123:abc</code>).' },
            { text: 'Paste this into <code>~/.openclaw/openclaw.json</code>, replacing the token from step 2:', cmd: providerQvac },
            { text: 'Start the gateway and approve the pairing. The code is valid for 1 hour.', cmd: 'openclaw gateway\\nopenclaw pairing list telegram\\nopenclaw pairing approve telegram <CODE>' }
          ]
        },
        whatsapp: {
          title: 'WhatsApp',
          warning: '<b>This is not a bot.</b> WhatsApp has no @BotFather: OpenClaw links <b>your personal account</b> as one more device (just like WhatsApp Web). Use a number you can dedicate to this and leave <code>dmPolicy: "pairing"</code>, so nobody reaches the node without your approval.',
          footer: 'Same gateway as Telegram, different channel. This node generates the answer: WhatsApp only carries the text.',
          status: {
            url: 'http://127.0.0.1:18789/',
            up: 'The OpenClaw gateway answers on 127.0.0.1:18789',
            down: 'The OpenClaw gateway is not answering yet'
          },
          steps: [
            { text: 'Install OpenClaw and the channel plugin.', cmd: 'npm install -g openclaw\\nopenclaw plugins install clawhub:@openclaw/whatsapp' },
            { text: 'Paste this into <code>~/.openclaw/openclaw.json</code>, with your number in international format (<code>+549…</code>) under <code>allowFrom</code>:', cmd: providerWhatsapp },
            { text: 'Link the account: the command prints a <b>QR in the terminal</b>. On your phone: <b>WhatsApp → Settings → Linked devices → Link a device</b> and scan it. The QR lasts ~60 s; if it expires, run the command again.', cmd: 'openclaw channels login --channel whatsapp' },
            { text: 'Start the gateway and approve the first message. The request is valid for 1 hour.', cmd: 'openclaw gateway\\nopenclaw pairing list whatsapp\\nopenclaw pairing approve whatsapp <CODE>' },
            { text: 'The indicator above only says whether the gateway is alive. That WhatsApp actually stayed <b>linked</b> is confirmed by this command, and it is the first thing to check when no answer arrives — before the node log.', cmd: 'openclaw channels status --probe' }
          ]
        },
        terminal: {
          title: 'Terminal',
          footer: 'Exact OpenAI shape. If this curl works, any compatible client works.',
          steps: [
            { text: 'Ask the node for a streaming answer:', cmd: 'curl ' + c.baseUrl + '/chat/completions \\\\\\n  -H "Authorization: Bearer ' + c.apiKey + '" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"model":"' + model + '","messages":[{"role":"user","content":"hello"}],"stream":true}\\'' },
            { text: 'And the network model catalog, just like the OpenAI API:', cmd: 'curl ' + c.baseUrl + '/models -H "Authorization: Bearer ' + c.apiKey + '"' }
          ]
        },
        hermes: {
          title: 'Hermes Agent',
          footer: 'Agent with persistent memory (local SQLite, no external service). None of this is our code: it is their configuration.',
          steps: [
            { text: 'Paste this into <code>~/.hermes/config.yaml</code>:', cmd: 'model:\\n  provider: custom\\n  base_url: ' + c.baseUrl + '\\n  api_key: ' + c.apiKey + '\\n  default: ' + model },
            { text: 'Start Hermes. Use plain chat, no tool calls.', cmd: 'hermes' }
          ]
        },
        webui: {
          title: 'Open WebUI',
          footer: 'A ChatGPT-style face, self-hosted, pointed at this node. Needs Docker Desktop running.',
          status: {
            url: 'http://localhost:3000/',
            up: 'Open WebUI answers on localhost:3000',
            down: 'Open WebUI is not answering yet'
          },
          steps: [
            { text: 'Bring up the container pointed at this gateway:', cmd: 'docker run -d -p 3000:8080 \\\\\\n  -e OPENAI_API_BASE_URL=' + c.baseUrl + ' \\\\\\n  -e OPENAI_API_KEY=' + c.apiKey + ' \\\\\\n  -v open-webui:/app/backend/data \\\\\\n  --name open-webui ghcr.io/open-webui/open-webui:main' },
            { text: 'Open <a href="http://localhost:3000" target="_blank" rel="noopener">localhost:3000</a> and pick the model <code>' + model + '</code>.' }
          ]
        }
      }
    }

    // The service runs on ANOTHER origin, so a normal fetch hits CORS even
    // when it is up. With mode:no-cors the response is opaque -it cannot be
    // read- but the promise resolves if the port answers and rejects if it
    // does not: enough for "is it up or not", which is all we ask.
    //
    // All we ask. It holds for Open WebUI and for the OpenClaw gateway alike,
    // and hence the indicator's honest limit: it says the process answers, NOT
    // that WhatsApp stayed linked. Only 'channels status' knows that, and it is
    // a command, not a port. Painting "linked" from here would be inventing a
    // state the panel cannot see.
    async function serviceUp(url) {
      try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store' })
        return true
      } catch {
        return false
      }
    }

    function paintStatus(e, up) {
      const el = document.getElementById('estado-dot')
      if (!el) return
      el.className = 'dot ' + (up ? 'up' : 'down')
      el.innerHTML = '<i></i>' + (up ? e.up : e.down)
    }

    function paintTab(rs, key) {
      document.querySelectorAll('.tabs button').forEach(b => {
        b.classList.toggle('on', b.dataset.tab === key)
      })
      const r = rs[key]
      const body = document.getElementById('tab-body')
      body.innerHTML =
        (r.warning ? '<p class="aviso">' + r.warning + '</p>' : '') +
        (r.status ? '<p><span class="dot" id="estado-dot"><i></i>checking…</span></p>' : '') +
        r.steps.map((p, i) => \`
          <div class="step">
            <div class="n">\${i + 1}</div>
            <div class="body">
              <p>\${p.text}</p>
              \${p.cmd ? '<div class="cmd"><pre>' + esc(p.cmd) + '</pre><button data-copy="' + i + '">Copy</button></div>' : ''}
            </div>
          </div>\`).join('') +
        '<p class="sub" style="margin:1rem 0 0">' + r.footer + '</p>'

      body.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => copyText(r.steps[Number(btn.dataset.copy)].cmd, btn))
      })

      clearInterval(estadoPoll)
      estadoPoll = null
      if (r.status) {
        const e = r.status
        const check = () => serviceUp(e.url).then(up => paintStatus(e, up))
        check()
        estadoPoll = setInterval(check, 3000)
      }
    }

    // Takes YOUR local node, not a remote node id.
    //
    // This used to hit /v1/connection/:id and issue a credential "to talk to
    // that provider", which was the wrong idea: the key authenticates against
    // your own gateway, and it is the gateway that then decides which node to
    // route to. One key per remote node suggested a privileged path that does
    // not exist.
    async function openConnection(node, apiKey) {
      let c
      try {
        c = {
          apiKey: apiKey,
          // The host comes from the browser, not from a constant: if you came
          // in through the LAN IP, the command you copy has to point there and
          // not at 127.0.0.1, which on the client machine is something else.
          baseUrl: 'http://' + location.host + '/v1',
          node: node
        }
      } catch (err) {
        alert('Could not build the connection: ' + (err && err.message ? err.message : err))
        return
      }

      const rs = recipes(c)
      document.getElementById('modal').innerHTML = \`
        <div class="modal-overlay" id="modal-overlay">
          <div class="modal">
            <h3>Use your node from anywhere</h3>
            <p class="sub">
              Your gateway, spoken to from outside this panel &mdash; same
              <code>/v1/chat/completions</code>, no privileged path.
              API key: <code>\${esc(c.apiKey)}</code>
            </p>
            <div class="tabs">
              <button data-tab="telegram">Telegram</button>
              <button data-tab="whatsapp">WhatsApp</button>
              <button data-tab="terminal">Terminal</button>
              <button data-tab="hermes">Hermes Agent</button>
              <button data-tab="webui">Open WebUI</button>
            </div>
            <div id="tab-body"></div>
            <button class="ghost" id="cerrar-modal">Close</button>
          </div>
        </div>\`

      document.querySelectorAll('.tabs button').forEach(b => {
        b.addEventListener('click', () => paintTab(rs, b.dataset.tab))
      })
      document.getElementById('cerrar-modal').addEventListener('click', cerrarModal)
      // Close by clicking the backdrop, but NOT when the click starts inside
      // the panel: without the target check, selecting text from a command and
      // releasing the mouse outside closed the modal.
      document.getElementById('modal-overlay').addEventListener('click', ev => {
        if (ev.target.id === 'modal-overlay') cerrarModal()
      })
      document.addEventListener('keydown', onEsc)

      paintTab(rs, 'telegram')
    }
`

export const NETWORK_HTML = page(
  'PyrusLLM · Network',
  `
  <h1>The network</h1>
  <p class="sub">Every node this machine knows about: what it serves, what it charges and how loaded it is. To ask any of them something, use the <a href="/">chat</a>; to let your own machine answer, see <a href="/node">my node</a>.</p>
  <p class="hint" id="buscando" style="display:none"></p>
  <div id="grid" class="grid"></div>
  <div id="modal"></div>


  <script>
    let nodesById = {}

    // Three classes of node, and the difference matters far too much to hide
    // behind a boolean: 'peer' is a genuinely REMOTE node, discovered through
    // the swarm and with its signed manifest verified. It used to fall into
    // the same 'simulated' bucket as the mocks -- exactly backwards.
    // A local upstream is named for what it is -- an engine on this machine
    // spoken to over HTTP -- and not for how it is asked.
    function labelFor (n) {
      if (n.local) return 'local engine · this machine'
      return KIND_LABEL[n.kind] || esc(n.kind)
    }

    const KIND_LABEL = {
      real: 'this machine',
      peer: 'verified P2P peer',
      mock: 'simulated',
      // The kind that sends the prompt OUTSIDE the network: to a third-party
      // API, on the operator's account. The label says so without euphemisms
      // because it is the only one that limits the privacy promise.
      //
      // CAREFUL: not every upstream is a third party. A llama-server or a NIM
      // on localhost also comes in over HTTP and is also kind 'upstream', but
      // the prompt never leaves the machine. That case is split out by n.local
      // in labelFor(); this entry is only the default.
      upstream: 'external API · third party',
      // Comes from the Hyperbee directory: its manifest verified at some
      // point, but there is no socket now. Never a routing candidate (see
      // store.mjs).
      known: 'known · disconnected'
    }
${ESC}

    function barColor(pct) {
      return pct < 50 ? '#4ade80' : pct < 80 ? '#fbbf24' : '#f87171'
    }

    // The grid is BUILT once and after that only the numbers are updated.
    //
    // It used to innerHTML the whole grid on every poll (every 3s): the cards
    // were destroyed and recreated non-stop, so a click landing right at that
    // moment was lost -Playwright could not even click a card: "element was
    // detached from the DOM"-. It also restarted the bars' CSS transition on
    // every round.
    let gridKey = null

    function buildGrid(nodes) {
      document.getElementById('grid').innerHTML = nodes.map(n => \`
        <div class="card" data-id="\${esc(n.id)}">
          <span class="badge \${n.local ? 'real' : esc(n.kind)}">\${labelFor(n)}</span>
          <h3>\${esc(n.operator)}</h3>
          <div class="model">\${esc(n.displayName)}</div>
          <div class="tags">\${n.tags.map(t => \`<span class="tag">\${esc(t)}</span>\`).join('')}</div>
          <div class="price" data-price></div>
          <span class="badge offline" data-offline style="display:none">offline</span>
          <div class="state" data-state></div>
          <div class="bar-row" data-load style="display:none"><div class="bar"><div data-fill></div></div><span class="pct"></span></div>
          <div class="actions">
            <button class="ghost" data-usar="\${esc(n.id)}">Use this node</button>
            <button class="ghost" data-files="\${esc(n.id)}">Files</button>
          </div>
        </div>
      \`).join('')
      // Browsing the marketplace and picking a machine to talk to was the
      // missing journey: until now the chat only let you name a MODEL, and two
      // peers serving the same one collapsed into a single option. The pin
      // travels through sessionStorage because it is a choice made for this
      // session, not a preference that should outlive the browser.
      document.querySelectorAll('[data-usar]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          try { sessionStorage.setItem('pyrus.pin', el.dataset.usar) } catch (e) { /* private mode */ }
          window.location.href = '/'
        })
      })

      // "Connect" moved to /node because the credential authenticates against
      // YOUR gateway and not against the remote node the card shows.
      document.querySelectorAll('[data-files]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          openFiles(el.dataset.files)
        })
      })
    }

    // Discovery loading state. Measured: the first peer takes ~17s to show up
    // over the DHT. Without this it is 17 seconds of empty grid in front of
    // the judges, which does not read as "searching" but as "it is broken".
    const openedAt = Date.now()
    let searching = false

    function renderSearching() {
      if (searching) return
      searching = true
      const seg = () => Math.round((Date.now() - openedAt) / 1000)
      document.getElementById('grid').innerHTML = \`
        <div class="skel"><div style="width:60%"></div><div style="width:85%"></div><div style="width:40%"></div></div>
        <div class="skel"><div style="width:70%"></div><div style="width:50%"></div><div style="width:65%"></div></div>
      \`
      const hint = document.getElementById('buscando')
      hint.style.display = ''
      hint.innerHTML = 'Looking for nodes on the DHT… <b><span id="seg"></span>s</b>'
      document.getElementById('seg').textContent = seg()
      clearInterval(window.__segTimer)
      window.__segTimer = setInterval(() => {
        const el = document.getElementById('seg')
        if (el) el.textContent = seg()
      }, 1000)
    }

    function render(nodes) {
      if (!nodes.length) {
        gridKey = null
        nodesById = {}
        return renderSearching()
      }
      if (searching) {
        searching = false
        clearInterval(window.__segTimer)
        document.getElementById('buscando').style.display = 'none'
      }

      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))

      // Only node identity justifies rebuilding the DOM; price and load change
      // often and are updated in place.
      const key = nodes.map(n => n.id + '|' + n.displayName + '|' + n.operator + '|' + n.tags.join('/')).join(',')
      if (key !== gridKey) {
        gridKey = key
        buildGrid(nodes)
      }

      for (const n of nodes) {
        const card = document.querySelector('.card[data-id="' + CSS.escape(n.id) + '"]')
        if (!card) continue

        // The price is split into amount (large) and unit (small). It is built
        // with nodes and textContent and NOT with innerHTML: the price is
        // written by the provider from their panel, and an <img src=x onerror>
        // in there was already proven to execute on page load.
        const price = card.querySelector('[data-price]')
        price.textContent = ''
        const cut = String(n.pricing).indexOf(' / ')
        const amount = document.createElement('b')
        const unit = document.createElement('span')
        amount.textContent = cut === -1 ? n.pricing : String(n.pricing).slice(0, cut)
        unit.textContent = cut === -1 ? '' : String(n.pricing).slice(cut + 3)
        price.appendChild(amount)
        price.appendChild(unit)

        // One or the other is shown, without recreating nodes: that way the
        // bar's CSS transition really animates instead of restarting on every
        // poll.
        const load = card.querySelector('[data-load]')
        const offline = card.querySelector('[data-offline]')
        const state = card.querySelector('[data-state]')
        const down = n.loadPct === null
        offline.style.display = down ? '' : 'none'
        state.style.display = down ? 'none' : ''

        // The bar only appears when there is real load. At 0% it was an empty
        // bar with a "0%" next to it that did not tell "idle" from "hung"; the
        // state is now said in words.
        load.style.display = !down && n.loadPct > 0 ? '' : 'none'
        if (!down) {
          // Three states, not two: a node with 1 of 4 slots taken is NOT
          // "busy" -it accepts work-, and saying so discourages the buyer on
          // the one screen where they choose. "Busy" is reserved for the node
          // that genuinely has no room.
          const active = n.activeRequests
          const cap = n.maxConcurrentRequests
          const full = active >= cap
          const busy = active > 0
          state.className = 'state ' + (full ? 'full' : busy ? 'busy' : 'libre')
          state.textContent = full
            ? 'At capacity · ' + active + '/' + cap
            : busy
              ? 'Serving · ' + active + '/' + cap
              : 'Available'
          if (busy) {
            const fill = load.querySelector('[data-fill]')
            fill.style.width = n.loadPct + '%'
            fill.style.background = barColor(n.loadPct)
            load.querySelector('.pct').textContent = n.loadPct + '%'
          }
        }
      }
    }


    // -----------------------------------------------------------------------
    // "Connect": the same node, consumed from outside the panel.
    //
    // It is the proof that this is a genuine OpenAI-compatible gateway and not
    // a chat with our own protocol inside: the command copied here is the one
    // any third-party client would use, with no privileged path.
    // -----------------------------------------------------------------------

${MODAL_JS}

    async function openFiles(id) {
      try {
        // The local node (kind 'real'/'mock') has no peerKey: that is ITS own
        // drive. A 'peer' node does have one, and without passing it the
        // gateway always returned the local drive, no matter which card had
        // been clicked.
        const node = nodesById[id]
        const peerKey = node && node.peerKey
        const url = peerKey ? '/v1/files?peerKey=' + encodeURIComponent(peerKey) : '/v1/files'
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const data = await r.json()

        // Shows the drive of the node they picked, with a qvac:// link that
        // can be pasted on another machine to download it with no prior P2P
        // connection.
        const files = data.files || []
        const modal = document.getElementById('modal')
        modal.innerHTML = \`
          <div class="modal-overlay" id="modal-overlay">
            <div class="modal">
              <h3>Files on \${esc(node ? node.operator : 'this node')}</h3>
              <p class="sub"><code>qvac://</code> links can be copied and pasted on another machine to download with no prior pairing.</p>
              \${files.length === 0
                ? '<p class="muted">No published files.</p>'
                : '<table><thead><tr><th>Name</th><th>Size</th><th>Link</th></tr></thead><tbody>' +
                  files.map(f => \`
                    <tr>
                      <td>\${esc(f.path)}</td>
                      <td>\${formatBytes(f.bytes)}</td>
                      <td><button class="ghost" data-copy-file="\${esc(f.link)}" style="font-size:.75rem">Copy</button></td>
                    </tr>\`).join('') +
                  '</tbody></table>'
              }
              <button class="ghost" id="cerrar-modal">Close</button>
            </div>
          </div>\`

        document.getElementById('cerrar-modal').addEventListener('click', cerrarModal)
        document.getElementById('modal-overlay').addEventListener('click', ev => {
          if (ev.target.id === 'modal-overlay') cerrarModal()
        })
        document.querySelectorAll('[data-copy-file]').forEach(btn => {
          btn.addEventListener('click', () => copyText(btn.dataset.copyFile, btn))
        })
        document.addEventListener('keydown', onEsc)
      } catch (err) {
        alert('Could not read the files: ' + (err && err.message ? err.message : err))
      }
    }

    async function refresh() {
      const r = await authFetch('/v1/nodes')
      const { nodes } = await r.json()
      render(nodes)
    }


    // The poll overwrites the whole grid, so a failure must not take the panel
    // down.
    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 3000)
  </script>
  `
)

export const NODE_HTML = page(
  'PyrusLLM · My Node',
  `
  <h1>My node</h1>
  <p class="sub">Your own machine as a provider: status, load and the rate it publishes.</p>

  <div id="onboarding"></div>

  <div class="field" id="node-picker" style="display:none">
    <label>Which of your nodes</label>
    <select id="node-select"></select>
  </div>

  <p class="hint" id="no-node" style="display:none">This gateway is not serving any model yet.</p>

  <div id="detail"></div>

  <div class="card" style="cursor:default; margin-top:1.5rem">
    <h3>Using your node from outside</h3>
    <p class="sub">Any OpenAI-compatible client &mdash; Telegram, WhatsApp, your terminal,
      Open WebUI &mdash; can talk to this gateway. It routes to the network exactly like
      the chat does, with no privileged path.</p>

    <div id="keys"></div>

    <button id="new-key">New key</button>
    <button class="danger" id="revoke-all">Revoke all</button>
    <p class="hint" style="margin:.8rem 0 0">One key per client, so you can cut off a single
      bot without touching the rest. Revoking takes effect immediately. Keys are stored on
      this machine and <b>survive a restart</b> &mdash; they have to: the spend cap is counted
      per key, so a registry that reset with the process would be a cap you could clear by
      restarting the node.</p>
  </div>

  <div class="card" style="cursor:default; margin-top:1.5rem">
    <h3>Traffic</h3>
    <p class="sub">The two halves of the exchange: what this machine answered for others,
      and what it asked of them.</p>
    <div class="tabs" id="flow-tabs">
      <button data-flow="in" class="on">Served to others</button>
      <button data-flow="out">Asked of others</button>
    </div>
    <div id="flow-body"></div>
  </div>

  <div class="card" style="cursor:default; margin-top:1.5rem">
    <h3>Free tier and spend cap</h3>
    <p class="sub">The two meters, and they point in opposite directions: one counts what you
      give away, the other what you spend. Inference on your own machine is in neither &mdash;
      it costs nobody anything but your electricity, so it is free and uncapped.</p>

    <div class="econ-grid">
      <div>
        <h4>What you give</h4>
        <p class="hint">Every peer gets a free allowance from this node. It is enforced here,
          by the machine that pays the electricity &mdash; not by whoever is asking.</p>
        <p class="econ-big" id="q-given">&mdash;</p>
        <p class="hint" id="q-window">&mdash;</p>
        <div id="q-peers"></div>
      </div>

      <div>
        <h4>What you spend</h4>
        <p class="hint">Only the external assistant costs dollars. When this runs out the node
          does not stop: it falls back to local inference, which stays free.</p>
        <p class="econ-big" id="b-remaining">&mdash;</p>
        <div class="bar"><div class="bar-fill" id="b-bar"></div></div>
        <p class="hint" id="b-detail">&mdash;</p>
      </div>
    </div>
  </div>

  <div class="card" style="cursor:default; margin-top:1.5rem" id="wallet-card">
    <h3>Where this node gets paid</h3>
    <p class="sub">Your payment address travels inside the <b>signed</b> manifest, so a peer that
      checks the signature knows this machine &mdash; and no other &mdash; declared it. It is a
      different key from the one that identifies you on the network: that one lives in the clear,
      this one does not.</p>
    <div id="wallet-estado"></div>
  </div>

  <div class="card" style="cursor:default; margin-top:1.5rem" id="recibo-card">
    <h3>A paid request, end to end</h3>
    <p class="sub">Two artefacts prove two different halves of the same exchange, so they are
      shown side by side: the <b>settlement receipt</b> says somebody paid, and the
      <b>attestation</b> says what this node served &mdash; signed with the payout wallet over
      the JCS form of everything except the signature. Paste the completion id
      (<code>chatcmpl-&hellip;</code>) that came back with the answer.</p>
    <div class="x-buscar">
      <input id="recibo-id" placeholder="chatcmpl-…" autocomplete="off" spellcheck="false">
      <button id="recibo-ver">Look it up</button>
    </div>
    <p class="hint" style="margin:0 0 .5rem">Optional, and it is the whole point of
      <code>outputHash</code>: paste the answer you actually received and the hash gets
      <b>recomputed here</b> and compared. The hash is over the text, and text does not depend on
      how many pieces it travelled in &mdash; so a provider that inflates the gateway&rsquo;s count
      by chopping the stream finer cannot move it.</p>
    <textarea id="recibo-texto" rows="3" placeholder="the answer you received, verbatim (optional)"
      style="width:100%;background:#0f1218;color:#e6e6e6;border:1px solid #2c3348;border-radius:8px;padding:.5rem .65rem;font-size:.82rem"></textarea>
    <div id="recibo-box"></div>
  </div>

  <div class="card" style="cursor:default; margin-top:1.5rem" id="up-card">
    <h3>External assistant</h3>
    <p class="sub">The one path where a prompt leaves the P2P network and goes to a company&rsquo;s
      API, which sees it, may log it, and bills it. Off by default.</p>

    <div id="up-estado"></div>

    <div class="up-switch" id="up-switch" style="display:none">
      <div>
        <b id="up-titulo">Sending prompts to a third party</b>
        <p class="hint" id="up-detalle" style="margin:.25rem 0 0">&mdash;</p>
      </div>
      <button id="up-toggle">&mdash;</button>
    </div>

    <p class="hint" id="up-nota" style="margin:.9rem 0 0">Even switched on, the external
      assistant only competes when nobody local or on the network has capacity, and never when
      the request asks to stay on this machine. Turning it on here does not write the config
      file: on restart it goes back to whatever <code>upstreams.json</code> says.</p>
  </div>

  <div id="model-modal"></div>
  <div id="modal"></div>

  <script>
    let nodesById = {}
    let current = null
    let shellFor = null // which node the #detail DOM is built for
    let isMine = false  // is the chosen node THIS gateway? (only there can we re-sign)
    let swarmActive = false
    let catalogById = {} // alias -> {displayName, sizeGB, fits}, from /v1/swarm/manifest
${ESC}
${FUENTE_EMBEBIDA}
${MODAL_JS}
${CONNECT_JS}

    // -------------------------------------------------------------------
    // Onboarding: only shows up if this gateway has not joined the swarm yet.
    // -------------------------------------------------------------------
    function renderOnboarding(swarm) {
      swarmActive = !!swarm
      const box = document.getElementById('onboarding')
      if (swarm) {
        box.innerHTML = ''
        return
      }
      const cmd = 'pyrusllm serve --swarm --operator "your name"'
      box.innerHTML = \`
        <div class="card" style="margin-bottom:1.5rem; cursor:default">
          <h3>This node is not announced on the P2P network yet</h3>
          <p class="sub">Launch it from the chat, or restart the gateway with:</p>
          <pre>\${esc(cmd)}</pre>
          <button id="copy-swarm-cmd" class="ghost">Copy command</button>
        </div>
      \`
      document.getElementById('copy-swarm-cmd')
        .addEventListener('click', (e) => { navigator.clipboard.writeText(cmd); e.target.textContent = 'Copied' })
    }

    // -------------------------------------------------------------------
    // Detail of the chosen node. Built ONCE per node and after that only the
    // texts that change are updated -- see the older note below on why (the
    // price input kept losing whatever the user was typing).
    // -------------------------------------------------------------------
    function buildShell(n) {
      document.getElementById('detail').innerHTML = \`
        <div class="card" style="cursor:default">
          <span class="badge \${esc(n.status)}" id="d-badge"></span>
          <h3 id="d-name"></h3>
          <div class="op" id="d-op"></div>
          <div class="tags" id="d-tags"></div>
          <p>Current load: <b id="d-pct"></b> <span id="d-req"></span></p>
        </div>
        <div class="field">
          <label>Published rate</label>
          <input type="text" id="pricing">
        </div>
        <div id="mine-fields"></div>
        <button id="save-pricing">Save changes</button>
        <button id="toggle" class="ghost"></button>
      \`
      document.getElementById('save-pricing').addEventListener('click', saveFields)
      document.getElementById('toggle').addEventListener('click', toggleStatus)
      shellFor = n.id
      mineFieldsBuiltFor = null // forces rebuilding the "mine-fields" block too
    }

    // The fields that only make sense on YOUR OWN P2P node -- editing them
    // means re-signing the manifest with your identity, something that cannot
    // be done on somebody else's node. They are built apart from buildShell()
    // because "it is mine" can change without the chosen node changing (e.g.
    // you just started --swarm).
    let mineFieldsBuiltFor = null

    function buildMineFields() {
      const box = document.getElementById('mine-fields')
      if (!isMine) {
        box.innerHTML = ''
        mineFieldsBuiltFor = false
        return
      }
      box.innerHTML = \`
        <div class="field">
          <label>Published name</label>
          <input type="text" id="displayName">
        </div>
        <div class="field">
          <label>Tags (comma separated)</label>
          <input type="text" id="tagsInput">
        </div>
        <div class="field">
          <label>Capacity (concurrent requests)</label>
          <input type="text" id="maxConc">
        </div>
        <div class="field">
          <label>Model</label>
          <select id="modelSelect"></select>
          <div class="muted" id="modelLoadStatus" style="margin-top:.3rem"></div>
        </div>
      \`
      document.getElementById('modelSelect').addEventListener('change', onModelSelectChange)
      mineFieldsBuiltFor = true
    }

    function renderDetail() {
      const n = nodesById[current]
      if (!n) return
      if (shellFor !== n.id) buildShell(n)
      if (mineFieldsBuiltFor !== isMine) buildMineFields()

      const badge = document.getElementById('d-badge')
      badge.className = 'badge ' + n.status
      badge.textContent = n.status === 'online' ? 'online' : 'offline'
      document.getElementById('d-name').textContent = n.displayName
      document.getElementById('d-op').textContent = n.operator
      document.getElementById('d-tags').innerHTML =
        n.tags.map(t => \`<span class="tag">\${esc(t)}</span>\`).join('')
      document.getElementById('d-pct').textContent =
        n.loadPct === null ? '—' : n.loadPct + '%'
      document.getElementById('d-req').textContent =
        '(' + n.activeRequests + '/' + n.maxConcurrentRequests + ' active requests)'
      document.getElementById('toggle').textContent =
        n.status === 'online' ? 'Go offline' : 'Go back online'

      // The only thing the user edits: only overwritten when they are NOT
      // touching it.
      const pricing = document.getElementById('pricing')
      if (document.activeElement !== pricing) pricing.value = n.pricing

      if (isMine) {
        const dn = document.getElementById('displayName')
        if (dn && document.activeElement !== dn) dn.value = n.displayName
        const tg = document.getElementById('tagsInput')
        if (tg && document.activeElement !== tg) tg.value = n.tags.join(', ')
        const mc = document.getElementById('maxConc')
        if (mc && document.activeElement !== mc) mc.value = n.maxConcurrentRequests

        renderModelSelect(n.modelId)
      }
    }

    // -------------------------------------------------------------------
    // Model selector: only offers what fits in THIS machine's RAM (see
    // /v1/swarm/manifest -> models[].fits). Switching model goes through a
    // confirmation modal because it triggers a real load.
    // -------------------------------------------------------------------
    let modelSelectBuiltWith = null
    let modelLoadPoll = null

    function renderModelSelect(currentModelId) {
      const select = document.getElementById('modelSelect')
      if (!select) return
      const key = Object.keys(catalogById).sort().join(',')
      if (key !== modelSelectBuiltWith) {
        modelSelectBuiltWith = key
        select.innerHTML = Object.entries(catalogById).map(([alias, m]) => \`
          <option value="\${esc(alias)}" \${!m.fits ? 'disabled' : ''}>
            \${esc(m.displayName)} (\${m.sizeGB} GB)\${m.fits ? '' : ' — does not fit in this RAM'}
          </option>\`).join('')
      }
      if (document.activeElement !== select) select.value = currentModelId
    }

    async function onModelSelectChange(e) {
      const nextAlias = e.target.value
      const n = nodesById[current]
      if (!n || nextAlias === n.modelId) return

      const info = catalogById[nextAlias]
      const proceed = confirm(
        'Switch this node\\'s model to "' + (info ? info.displayName : nextAlias) + '".\\n\\n' +
        'It can take several seconds -or fail for lack of memory- while the ' +
        'node keeps answering with the current model. If it fails, the current model is kept.'
      )
      if (!proceed) { e.target.value = n.modelId; return }

      const r = await fetch('/v1/swarm/manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: nextAlias })
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        alert((data.error && data.error.message) || 'could not switch the model')
        e.target.value = n.modelId
        return
      }
      pollModelLoad()
    }

    function pollModelLoad() {
      clearInterval(modelLoadPoll)
      modelLoadPoll = setInterval(async () => {
        const r = await fetch('/v1/swarm/manifest')
        if (!r.ok) return
        const data = await r.json()
        const status = document.getElementById('modelLoadStatus')
        if (!data.modelLoad || data.modelLoad.status === 'ready') {
          if (status) status.textContent = ''
          clearInterval(modelLoadPoll)
          await refresh()
          return
        }
        if (status) {
          status.textContent = data.modelLoad.status === 'loading'
            ? 'Loading the new model… (this can take a while)'
            : 'Load failed: ' + (data.modelLoad.message || 'unknown error')
        }
        if (data.modelLoad.status === 'error') clearInterval(modelLoadPoll)
      }, 2000)
    }

    let optionsKey = null

    async function refresh() {
      const r = await authFetch('/v1/nodes')
      const { nodes: all, swarm } = await r.json()

      // This page is ONLY about your machine. It used to list the whole
      // network and start on all[0], which is usually a remote peer: the panel
      // said "Your node" and showed somebody else's, with a price field and a
      // save button next to it that could do nothing to a third party's signed
      // manifest. Other people's nodes are viewed in /network.
      const nodes = all.filter(n => n.kind === 'real')
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      if (!current || !nodesById[current]) current = nodes[0]?.id

      // A dropdown with a single option is noise: there is almost always just
      // one local node, and the selector only shows when there is a real
      // choice to make.
      document.getElementById('node-picker').style.display = nodes.length > 1 ? '' : 'none'
      document.getElementById('no-node').style.display = nodes.length ? 'none' : ''
      if (!nodes.length) {
        document.getElementById('detail').innerHTML = ''
        shellFor = null
        renderOnboarding(swarm)
        return
      }

      renderOnboarding(swarm)
      isMine = !!swarm && !!nodesById[current] &&
        nodesById[current].kind === 'real' && nodesById[current].id.startsWith('local:')

      if (isMine && !Object.keys(catalogById).length) {
        const rr = await fetch('/v1/swarm/manifest')
        if (rr.ok) {
          const data = await rr.json()
          catalogById = Object.fromEntries((data.models || []).map(m => [m.alias, m]))
        }
      }

      // The <select> is only repainted when the node list changed. Repainting
      // it on every poll closed the dropdown if you had it open.
      const key = nodes.map(n => n.id + '|' + n.displayName + '|' + n.operator).join(',')
      if (key !== optionsKey) {
        optionsKey = key
        document.getElementById('node-select').innerHTML = nodes.map(n =>
          \`<option value="\${esc(n.id)}" \${n.id === current ? 'selected' : ''}>\${esc(n.displayName)} — \${esc(n.operator)}</option>\`
        ).join('')
      }
      renderDetail()
    }

    async function saveFields() {
      const pricing = document.getElementById('pricing')
      const patch = { pricing: pricing.value }

      if (isMine) {
        const dn = document.getElementById('displayName')
        const tg = document.getElementById('tagsInput')
        const mc = document.getElementById('maxConc')
        if (dn) patch.displayName = dn.value
        if (tg) patch.tags = tg.value.split(',').map(t => t.trim()).filter(Boolean)
        if (mc && Number.isFinite(+mc.value) && +mc.value > 0) patch.maxConcurrentRequests = +mc.value
      }

      // Without the blur, the input keeps focus and the refresh below does not
      // update it: it would keep showing what was typed even if the server
      // trimmed it, and what actually got saved would not be visible.
      document.activeElement && document.activeElement.blur && document.activeElement.blur()

      await authFetch('/v1/nodes/' + encodeURIComponent(current), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing: patch.pricing })
      })

      if (isMine && (patch.displayName !== undefined || patch.tags !== undefined || patch.maxConcurrentRequests !== undefined)) {
        await fetch('/v1/swarm/manifest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: patch.displayName,
            tags: patch.tags,
            maxConcurrentRequests: patch.maxConcurrentRequests
          })
        })
      }

      await refresh()
    }

    async function toggleStatus() {
      const status = nodesById[current].status === 'online' ? 'offline' : 'online'
      await authFetch('/v1/nodes/' + encodeURIComponent(current), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      })
      await refresh()
    }

    document.getElementById('node-select').addEventListener('change', (e) => {
      current = e.target.value
      renderDetail()
    })


    // ------------------------------------------------------------------
    // Credentials. Several on purpose: one per client, so a single bot can be
    // cut off without touching the rest and so the trace knows which one asked
    // for what.
    // ------------------------------------------------------------------
    let keys = []

    function age(ts) {
      if (!ts) return 'never'
      const s = Math.round((Date.now() - ts) / 1000)
      if (s < 60) return s + 's ago'
      if (s < 3600) return Math.round(s / 60) + 'm ago'
      if (s < 86400) return Math.round(s / 3600) + 'h ago'
      return Math.round(s / 86400) + 'd ago'
    }

    function paintKeys() {
      const box = document.getElementById('keys')
      if (!keys.length) {
        box.innerHTML = '<p class="hint">No keys issued yet.</p>'
        return
      }
      box.innerHTML =
        '<table><thead><tr><th>Client</th><th>Key</th><th>Last used</th><th></th></tr></thead><tbody>' +
        keys.map(function (k) {
          return '<tr>' +
            '<td>' + esc(k.label) + '</td>' +
            '<td class="muted" style="font-family:ui-monospace,monospace;font-size:.75rem;overflow-wrap:anywhere">' +
              esc(k.key) + '</td>' +
            '<td class="muted">' + age(k.lastUsedAt) + '</td>' +
            '<td style="white-space:nowrap">' +
              '<button class="ghost" data-copy-key="' + esc(k.key) + '" style="font-size:.75rem;margin:0">Copy</button> ' +
              '<button class="ghost" data-connect-key="' + esc(k.key) + '" style="font-size:.75rem;margin:0">Connect</button> ' +
              '<button class="danger" data-revoke="' + esc(k.id) + '" style="font-size:.75rem;margin:0">Revoke</button>' +
            '</td></tr>'
        }).join('') + '</tbody></table>'

      box.querySelectorAll('[data-copy-key]').forEach(function (b) {
        b.addEventListener('click', function () { copyText(b.dataset.copyKey, b) })
      })
      box.querySelectorAll('[data-connect-key]').forEach(function (b) {
        b.addEventListener('click', function () {
          const n = nodesById[current]
          if (!n) return alert('This gateway is not serving any model yet.')
          openConnection(n, b.dataset.connectKey)
        })
      })
      box.querySelectorAll('[data-revoke]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Revoke this key? Whatever is using it stops working immediately.')) return
          b.disabled = true
          try {
            const r = await authFetch('/v1/keys/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' })
            const d = await r.json()
            keys = d.keys || []
            paintKeys()
          } catch (err) {
            alert('Could not revoke: ' + ((err && err.message) || err))
            b.disabled = false
          }
        })
      })
    }

    async function loadKeys() {
      try {
        const r = await authFetch('/v1/keys')
        const d = await r.json()
        keys = d.keys || []
        paintKeys()
      } catch (e) {
        document.getElementById('keys').innerHTML = '<p class="hint">Could not read the keys.</p>'
      }
    }

    document.getElementById('new-key').addEventListener('click', async function () {
      const label = prompt('What is this key for? (e.g. "telegram bot")')
      if (label === null) return
      try {
        const r = await authFetch('/v1/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label })
        })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        await loadKeys()
      } catch (err) {
        alert('Could not create the key: ' + ((err && err.message) || err))
      }
    })

    document.getElementById('revoke-all').addEventListener('click', async function (e) {
      // The number goes in the question: saying "the current key is revoked"
      // when five are issued is lying to whoever is about to click.
      const n = keys.length
      if (!confirm('Revoke all ' + n + (n === 1 ? ' key' : ' keys') +
        '? Every client using them stops working immediately.')) return
      const btn = e.target
      btn.disabled = true
      try {
        const r = await authFetch('/v1/keys/revoke-all', { method: 'POST' })
        const d = await r.json()
        keys = d.keys || []
        // The panel re-credentials itself: its old key just died with the
        // rest, and without this the page would be left unable to talk to the
        // gateway.
        window.__panelKey = null
        paintKeys()
      } catch (err) {
        alert('Could not revoke: ' + ((err && err.message) || err))
      }
      btn.disabled = false
    })

    // ------------------------------------------------------------------
    // Traffic. Both directions come out of the SAME trace, separated by kind:
    // 'served' is what this node produced for a peer (written by provider.mjs)
    // and 'route' is what this node asked of somebody else.
    // ------------------------------------------------------------------
    let flow = 'in'

    function flowRow(e) {
      const time = esc(new Date(e.ts).toLocaleTimeString())
      const who = esc(e.operator || 'unknown')
      const bits = []
      if (e.tokens) bits.push(e.tokens + ' tok')
      if (e.ttftMs !== null && e.ttftMs !== undefined) bits.push('ttft ' + e.ttftMs + 'ms')
      if (e.tokensPerSec) bits.push(e.tokensPerSec + ' tok/s')
      bits.push(e.ms + 'ms')
      const failed = e.ok === false ? ' <b style="color:#f87171">FAILED</b>' : ''
      // PHASE 9 / D25 \u2014 the split gets its own column with its provenance
      // attached. Folding prefill and decode into the "tok" next to it would
      // mix them again, which is exactly what D25 separated; and without the
      // provenance, a count of SSE chunks reads just like a provider usage.
      //
      // D27 alongside: without finishReason, a client cut and a complete
      // answer look identical in the trace.
      const conteo = htmlDeConteo(vistaDeConteo(e))
      const fin = e.finishReason
        ? '<div class="x-nota" style="margin:.2rem 0 0">' +
          esc(e.finishReason) + ' \u2014 ' + esc(textoDeFinishReason(e.finishReason)) + '</div>'
        : ''
      return '<tr><td class="muted">' + time + '</td><td>' + who + '</td>' +
        '<td class="muted">' + esc(e.modelId || '') + '</td>' +
        '<td class="muted">' + esc(bits.join(' \u00b7 ')) + failed + '</td>' +
        '<td>' + conteo + fin + '</td></tr>'
    }

    function paintFlow(log) {
      const entries = flow === 'in'
        ? log.filter(e => e.kind === 'served')
        // Work routed to our own machine is not a transaction with anybody:
        // without this filter, "what we asked of others" filled up with our
        // own node.
        : log.filter(e => e.kind === 'route' && e.target && e.target !== 'local')

      const box = document.getElementById('flow-body')
      if (!entries.length) {
        box.innerHTML = '<p class="hint" style="margin:1rem 0 0">' + (flow === 'in'
          ? 'Nobody has asked this machine for inference yet.'
          : 'This machine has not consumed another node yet.') + '</p>'
        return
      }

      const tokens = entries.reduce((a, e) => a + (e.tokens || 0), 0)
      box.innerHTML =
        '<p class="hint" style="margin:.9rem 0 .2rem">' + entries.length +
        (entries.length === 1 ? ' request' : ' requests') + ' \u00b7 ' + tokens + ' tokens</p>' +
        '<table><thead><tr><th>Time</th><th>' +
        (flow === 'in' ? 'Asked by' : 'Answered by') +
        '</th><th>Model</th><th></th><th>prefill / decode (D25)</th></tr></thead><tbody>' +
        entries.map(flowRow).join('') + '</tbody></table>' +
        '<p class="x-nota">D25 records the two dimensions separately because they do not ' +
        'scale alike: prefill processes the prompt in parallel and is compute-bound, decode ' +
        'generates token by token and is memory-bandwidth-bound. Pricing stays flat (D22): ' +
        'this is recorded to be able to decide with data, not to bill on it today.</p>'
    }

    document.querySelectorAll('#flow-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        flow = b.dataset.flow
        document.querySelectorAll('#flow-tabs button').forEach(x => {
          x.classList.toggle('on', x.dataset.flow === flow)
        })
        refreshFlow()
      })
    })

    async function refreshFlow() {
      try {
        const r = await authFetch('/v1/routing-log')
        const { log } = await r.json()
        paintFlow(log || [])
      } catch (e) { /* the next poll retries */ }
    }

    // -------------------------------------------------------------------
    // PHASE 9 — the receipt and the attestation of a paid request.
    //
    // It uses a BARE fetch and not authFetch, and that is not an oversight: the
    // GET /v1/receipts/:id route is the only one in the system that does NOT
    // ask for a credential, on purpose. Whoever paid through a 402 has none --
    // that is the entire point of the 402 -- so demanding one to see their own
    // receipt would leave them unable to audit precisely what they paid for.
    // Sending the panel key here would also hide that property behind a header
    // that is not needed.
    //
    // There is no route that LISTS receipts and none is invented: Phase 9 is
    // closed and adding surface reopens it. You look one up by id, which is
    // what comes back with the answer.
    // -------------------------------------------------------------------
    async function viewReceipt() {
      const box = document.getElementById('recibo-box')
      const id = document.getElementById('recibo-id').value.trim()
      if (!id) {
        box.innerHTML = '<p class="hint">The completion id is missing.</p>'
        return
      }
      // Empty means ABSENT, not empty string: the hash of "" is a valid hash,
      // and comparing it against the declared one would say "does NOT match"
      // when the truth is there is nothing to compare against. They are two
      // different states and the view tells them apart.
      const texto = document.getElementById('recibo-texto').value
      const ctx = texto.length ? { textoRecibido: texto } : {}

      box.innerHTML = '<p class="hint">Looking it up…</p>'
      try {
        const r = await fetch('/v1/receipts/' + encodeURIComponent(id))
        if (r.status === 404) {
          box.innerHTML =
            '<div class="x402"><div class="x-aviso tibio">There is no receipt for that id. ' +
            'Receipts live in process memory and only the last 200 are kept: ' +
            'this is not a ledger, the real ledger is the chain. A restart wipes them.' +
            '</div></div>'
          return
        }
        if (!r.ok) {
          box.innerHTML = '<div class="x402"><div class="x-aviso malo">HTTP ' + r.status +
            '</div></div>'
          return
        }
        box.innerHTML = htmlDeRecibo(await r.json(), ctx)
      } catch (e) {
        box.innerHTML = '<div class="x402"><div class="x-aviso malo">' +
          esc((e && e.message) || e) + '</div></div>'
      }
    }

    document.getElementById('recibo-ver').addEventListener('click', () => {
      viewReceipt().catch(() => {})
    })
    document.getElementById('recibo-id').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') viewReceipt().catch(() => {})
    })

    // -------------------------------------------------------------------
    // The two meters (Phase 6.5 and 6.6). They are requested together because
    // they are the same question seen from both sides, but they come from
    // different endpoints on purpose: /v1/quota is kept by the provider and
    // /v1/budget by the gateway.
    //
    // Each fails on its own. If the node is not serving yet there is no quota
    // to show, and that is no reason to wipe out the spending figure.
    // -------------------------------------------------------------------
    function thousands(n) {
      return Number(n || 0).toLocaleString('en-US')
    }

    async function refreshQuota() {
      try {
        const r = await authFetch('/v1/quota')
        if (!r.ok) return
        const q = await r.json()

        document.getElementById('q-given').textContent = thousands(q.given_tokens) + ' tokens'
        document.getElementById('q-window').textContent =
          thousands(q.quota_tokens) + ' output tokens per peer, per ' + q.window_hours + ' h — ' +
          'a sliding window, so it tops back up on its own'

        const box = document.getElementById('q-peers')
        if (!q.peers.length) {
          box.innerHTML = '<p class="hint">No peer has asked this node for anything yet.</p>'
          return
        }
        box.innerHTML = q.peers.map((p) => \`
          <div class="econ-row">
            <code>\${esc(p.peer)}</code>
            <span>\${thousands(p.used)} used · \${thousands(p.remaining)} left</span>
          </div>
        \`).join('')
      } catch (e) { /* the next poll retries */ }
    }

    async function refreshSpend() {
      try {
        const r = await authFetch('/v1/budget')
        if (!r.ok) return
        const b = await r.json()

        // B13 — there are TWO caps and either one can be the one that cuts.
        // The SMALLER of the two remainders is shown, because that is the one
        // in charge: with the account one at USD 20 and the node one at USD 2,
        // saying "you have 20 left" promises nineteen that do not exist.
        const nodeCap = b.node || {}
        const nodeRules =
          nodeCap.remaining_micros !== undefined && nodeCap.remaining_micros < b.remaining_micros
        const remaining = nodeRules ? nodeCap.remaining : b.remaining
        document.getElementById('b-remaining').textContent = remaining + ' left'

        // The percentage is computed against the cap, not against what is
        // left: with the cap at zero there is no division by zero and no bar
        // sitting at 100%.
        const capMicros = nodeRules ? nodeCap.cap_micros : b.cap_micros
        const spentMicros = nodeRules ? nodeCap.spent_micros : b.spent_micros
        const used = capMicros > 0 ? (spentMicros / capMicros) * 100 : 0
        document.getElementById('b-bar').style.width = Math.min(100, used).toFixed(1) + '%'

        document.getElementById('b-detail').textContent =
          (nodeRules ? nodeCap.spent + ' spent of ' + nodeCap.cap + ' on this machine' : b.spent + ' spent of ' + b.cap + ' by this client') +
          ' this period (' + b.period + ')' +
          (b.reserved_micros > 0 ? ' · ' + b.reserved + ' committed to requests in flight' : '') +
          (nodeRules
            ? ' · your client cap is ' + b.cap + ', but the machine total is what cuts first'
            : nodeCap.cap
              ? ' · machine total: ' + nodeCap.spent + ' of ' + nodeCap.cap
              : '')
      } catch (e) { /* the next poll retries */ }
    }

    // -------------------------------------------------------------------
    // The external assistant and its switch (Phase 8.5).
    //
    // The endpoint to turn it on existed from the start and could only be used
    // with curl. The case that motivated it is "the network saturated in the
    // middle of a demo", and at that moment nobody opens a terminal.
    //
    // The button says what WILL HAPPEN, not the state it is in: "Turn on" when
    // it is off. A button that says "On" and is also lit up leaves you unsure
    // whether it is a state or an action, and this one in particular decides
    // whether somebody's prompt leaves the machine.
    // -------------------------------------------------------------------
    // PHASE 7 — the payout address. Having NO wallet is a normal state and is
    // said as such: a node that only consumes does not need one. What must not
    // happen is that it reads as if something were broken.
    async function refreshWallet() {
      const estado = document.getElementById('wallet-estado')
      if (!estado) return
      try {
        const r = await authFetch('/v1/wallet')
        if (!r.ok) return
        const w = await r.json()

        if (!w.configured) {
          estado.innerHTML =
            '<p class="hint">This node has no wallet yet, so its manifest announces ' +
            '<code>economic</code> as a marked mock &mdash; it declares no payment address. ' +
            'That is fine for a node that only consumes.</p>' +
            '<p class="hint">To create one: <code>pyrusllm wallet --create</code>. It prints ' +
            '24 words <b>once</b> &mdash; write them down. The seed is stored encrypted with ' +
            '<code>PYRUS_WALLET_PASSPHRASE</code>.</p>'
          return
        }

        estado.innerHTML =
          '<p class="econ-big" style="font-size:1rem; word-break:break-all">' +
          esc(w.address) +
          '</p>' +
          '<p class="hint">Networks: ' +
          w.chains.map((c) => '<code>' + esc(c) + '</code>').join(', ') +
          ' &mdash; settlement: <code>' +
          esc(w.settlement) +
          '</code></p>' +
          '<p class="hint">Nothing is charged yet: the manifest says who to pay, paying is ' +
          'still to come. <b>Plasma is not a testnet</b> &mdash; whatever lands here is real.</p>'
      } catch (e) {
        /* with no gateway the rest of the page already says so */
      }
    }

    async function refreshUpstream() {
      try {
        const r = await authFetch('/v1/upstream')
        if (!r.ok) return
        const u = await r.json()

        const card = document.getElementById('up-card')
        const sw = document.getElementById('up-switch')
        const estado = document.getElementById('up-estado')

        // With no upstream configured the switch has nothing to turn on: the
        // configuration is explained and no button that would do nothing is
        // offered.
        if (!u.upstreams.length) {
          sw.style.display = 'none'
          estado.innerHTML = '<p class="hint">No external assistant is configured. ' +
            'Copy <code>upstreams.example.json</code> to your storage directory as ' +
            '<code>upstreams.json</code> and restart the node.</p>'
          return
        }

        estado.innerHTML = u.upstreams.map(function (m) {
          // The credential is the only thing that can be missing while
          // looking like everything else: the model shows up in the list, with
          // a name and a price, and never answers. Which environment variable
          // is missing is named, not "error".
          var cred = m.credential
            ? '<span class="ok">ready</span>'
            : '<span class="off">no credential &mdash; set ' + esc(m.apiKeyEnv) + '</span>'
          return '<div class="up-fila"><span>' + esc(m.displayName) + ' <code>' +
            esc(m.label) + '</code></span>' + cred + '</div>'
        }).join('')

        sw.style.display = 'flex'
        sw.className = 'up-switch' + (u.optIn ? ' on' : '')
        document.getElementById('up-detalle').textContent = u.optIn
          ? 'On. With the network at capacity, a prompt can leave this machine.'
          : 'Off. No prompt leaves this machine, whatever the load.'
        var boton = document.getElementById('up-toggle')
        boton.textContent = u.optIn ? 'Turn off' : 'Turn on'
        boton.className = u.optIn ? 'danger' : ''
        boton.dataset.next = u.optIn ? 'false' : 'true'
      } catch (e) { /* the next poll retries */ }
    }

    document.getElementById('up-toggle').addEventListener('click', async function (ev) {
      const boton = ev.currentTarget
      const turnOn = boton.dataset.next === 'true'
      boton.disabled = true
      try {
        await authFetch('/v1/upstream/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: turnOn })
        })
      } catch (e) { /* the refresh below shows whatever state it ended in */ }
      boton.disabled = false
      refreshUpstream()
    })

    function refreshEconomics() {
      refreshQuota()
      refreshSpend()
      refreshUpstream()
      refreshWallet()
    }

    loadKeys()
    refreshFlow()
    setInterval(refreshFlow, 3000)

    // Slower than the rest: these two numbers move one request at a time, not
    // one token at a time. Polling every 2.5 s would be asking the gateway to
    // walk the ledger to say the same thing four times in a row.
    refreshEconomics()
    setInterval(refreshEconomics, 8000)

    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 2500)
  </script>
  `
)

export const ADMIN_HTML = page(
  'PyrusLLM · Admin',
  `
  <h1>Admin panel</h1>
  <p class="sub">Every node on the network and the gateway routing log.</p>

  <table>
    <thead>
      <tr><th>Node</th><th>Operator</th><th>Kind</th><th>Status</th><th>Load</th><th>Price</th><th></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <h3 style="margin-top:2rem">Routing log</h3>
  <div id="log" class="log"></div>

  <script>
${ESC}
${FUENTE_EMBEBIDA}

    async function refreshNodes() {
      const r = await authFetch('/v1/nodes')
      const { nodes } = await r.json()
      document.getElementById('rows').innerHTML = nodes.map(n => \`
        <tr>
          <td>\${esc(n.displayName)}</td>
          <td class="muted">\${esc(n.operator)}</td>
          <td><span class="badge \${esc(n.kind)}">\${esc(n.kind)}</span></td>
          <td><span class="badge \${esc(n.status)}">\${n.status === 'online' ? 'online' : 'offline'}</span></td>
          <td>\${n.loadPct === null ? '—' : esc(n.loadPct + '% (' + n.activeRequests + '/' + n.maxConcurrentRequests + ')')}</td>
          <td>\${esc(n.pricing)}</td>
          <td><button class="\${n.status === 'online' ? 'danger' : 'ghost'}" data-id="\${esc(n.id)}" data-action="\${n.status === 'online' ? 'kick' : 'restore'}">\${n.status === 'online' ? 'Kick' : 'Restore'}</button></td>
        </tr>
      \`).join('')
      document.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = encodeURIComponent(btn.dataset.id)
          const action = btn.dataset.action
          btn.disabled = true // the poll repaints the table: avoids a double click
          if (action === 'kick') {
            await authFetch('/v1/nodes/' + id + '/kick', { method: 'POST' })
          } else {
            await fetch('/v1/nodes/' + id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'online' })
            })
          }
          await refreshNodes()
        })
      })
    }

    // The trace stopped being only about routing: it now carries model_load
    // and the two D7 swarm events, which have neither a modelId nor a target
    // node. Painting them with the old template showed
    // "undefined → undefined (undefinedms)".
    const linea = (e) => {
      const time = esc(new Date(e.ts).toLocaleTimeString())
      const detail = \`<span class="muted">\${esc(e.reason || '')}</span>\`

      if (e.kind && e.kind !== 'route') {
        return \`<div>\${time} — <b>\${esc(e.kind)}</b> \${detail}</div>\`
      }

      // The three numbers of the demo. Shown only if they exist: a request
      // that failed before the first token has no tok/s, and a "0 tok/s" there
      // would be an invented measurement.
      const metrics = []
      if (e.tokens) metrics.push(esc(e.tokens) + ' tok')
      if (e.ttftMs !== null && e.ttftMs !== undefined) metrics.push('ttft ' + esc(e.ttftMs) + 'ms')
      if (e.tokensPerSec) metrics.push(esc(e.tokensPerSec) + ' tok/s')
      metrics.push(esc(e.ms) + 'ms')

      const target = e.target ? \` <b>[\${esc(e.target)}]</b>\` : ''
      const failed = e.ok === false ? \` <b>FAILED\${e.code ? ' ' + esc(e.code) : ''}</b>\` : ''

      // PHASE 9 / D25 and D27. The split goes with its provenance and not
      // folded into "metrics": dropped in there it would be one more number
      // next to the tok/s, and the difference between a measured token and a
      // counted SSE chunk is lost on exactly that line.
      const conteo = ' ' + htmlDeConteo(vistaDeConteo(e))
      const fin = e.finishReason
        ? \` <span class="muted">\${esc(e.finishReason)} — \${esc(textoDeFinishReason(e.finishReason))}</span>\`
        : ''

      return \`<div>\${time} — \${esc(e.modelId)}\${target} → \${esc(e.operator)}\` +
        \` (\${metrics.join(' · ')})\${conteo}\${fin}\${failed} \${detail}</div>\`
    }

    async function refreshLog() {
      const r = await authFetch('/v1/routing-log')
      const { log } = await r.json()
      document.getElementById('log').innerHTML = log.length
        ? log.map(linea).join('')
        : '<div class="muted">no requests routed yet</div>'
    }

    refreshNodes().catch(() => {})
    refreshLog().catch(() => {})
    setInterval(() => refreshNodes().catch(() => {}), 2500)
    setInterval(() => refreshLog().catch(() => {}), 2500)
  </script>
  `
)

// ---------------------------------------------------------------------------
// The chat. It is the screen the app opens on: ask first, with the network
// topology -which node, which price- as something you look at afterwards and
// not as the mandatory step before being allowed to type a prompt.
// ---------------------------------------------------------------------------

// String.raw: regexes with backslashes live inside and, without this, the
// template literal eats them when pages.mjs is evaluated -- /\*\*/ would reach
// the browser as /**/. It carries no backticks and no interpolations for
// exactly that reason.
const CHAT_JS = String.raw`
    var msgs = []
    var nodes = []
    var streaming = false
    var ctrl = null
    var userPicked = false
    var skipped = sessionStorage.getItem('pyrus.skipGate') === '1'

    // Backticks and sentinels built at runtime: this script travels inside a
    // template literal in pages.mjs, and a stray backtick closes it midway.
    var BT = String.fromCharCode(96)
    var S = String.fromCharCode(1)
    var fenceRe = new RegExp(BT + BT + BT + '(\w*)\n?([\s\S]*?)' + BT + BT + BT, 'g')
    var codeRe = new RegExp(BT + '([^' + BT + '\n]+)' + BT, 'g')
    var slotRe = new RegExp(S + 'C(\d+)' + S, 'g')

    // Minimal markdown, by hand. No CDN on purpose: these pages travel as a
    // string inside the standalone binary -- see the note at the top of the
    // file -- and an external dependency does not travel with them.
    //
    // Escaping happens FIRST and marking afterwards: the other way around, any
    // model answer with a "<script>" inside would be real HTML on the page.
    function md(src) {
      var blocks = []
      var t = esc(src)
      t = t.replace(fenceRe, function (m, lang, code) {
        blocks.push(code.replace(/\n$/, ''))
        return S + 'C' + (blocks.length - 1) + S
      })
      t = t.replace(codeRe, '<code>$1</code>')
      t = t.replace(/^#{3,} (.+)$/gm, '<h4>$1</h4>')
      t = t.replace(/^#{1,2} (.+)$/gm, '<h3>$1</h3>')
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      t = t.replace(/(?:^[-*] .+(?:\n|$))+/gm, function (m) {
        return '<ul>' + m.trim().split('\n').map(function (l) {
          return '<li>' + l.replace(/^[-*] /, '') + '</li>'
        }).join('') + '</ul>'
      })
      t = t.replace(/(?:^\d+\. .+(?:\n|$))+/gm, function (m) {
        return '<ol>' + m.trim().split('\n').map(function (l) {
          return '<li>' + l.replace(/^\d+\. /, '') + '</li>'
        }).join('') + '</ol>'
      })
      t = t.split(/\n{2,}/).map(function (p) {
        var x = p.trim()
        if (!x) return ''
        if (/^<(h3|h4|ul|ol)/.test(x)) return x
        return '<p>' + x.replace(/\n/g, '<br>') + '</p>'
      }).join('')
      return t.replace(slotRe, function (m, i) {
        return '<pre><code>' + blocks[+i] + '</code></pre>'
      })
    }

    function agentLive() {
      return window.__agent && window.__agent.status === 'live'
    }

    function peersOnline() {
      return nodes.filter(function (n) { return n.kind === 'peer' && n.status === 'online' })
    }

    function localNode() {
      return nodes.filter(function (n) { return n.kind === 'real' })[0] || null
    }

    // "Auto" = the best available. It names the MODEL and lets the gateway
    // pick the machine: since phase 8 that is decided by pickCandidate based
    // on load, so Auto finally means something. It used to lean on
    // findAllByModelId preferring the peer, which was a demo preference.
    function autoModelId() {
      var p = peersOnline()[0]
      var l = localNode()
      return (p && p.modelId) || (l && l.modelId) || 'llama1b'
    }

    // Every candidate that can be pinned by hand, one per MACHINE and not per
    // model. It used to dedupe by modelId and two peers serving llama1b
    // collapsed into a single option: there was no way to pick which one.
    function pinnable() {
      return nodes.filter(function (n) {
        return (
          n.status === 'online' &&
          (n.kind === 'peer' || n.kind === 'real' || n.kind === 'mock' || n.kind === 'upstream')
        )
      })
    }

    // The node pinned from /network ("Use this node").
    function savedPin() {
      try { return sessionStorage.getItem('pyrus.pin') } catch (e) { return null }
    }

    function savePin(id) {
      try {
        if (id) sessionStorage.setItem('pyrus.pin', id)
        else sessionStorage.removeItem('pyrus.pin')
      } catch (e) { /* private mode: the pin lives only in the selector */ }
    }

    // -------------------------------------------------------------- the gate
    window.onAgent = function (a) {
      var gate = document.getElementById('gate')
      var chat = document.getElementById('chat')
      var showGate = a.status !== 'live' && !skipped

      gate.style.display = showGate ? 'block' : 'none'
      chat.style.display = showGate ? 'none' : 'flex'

      var btn = document.getElementById('launch')
      btn.disabled = a.status === 'launching'
      btn.textContent = a.status === 'launching' ? 'Joining the network...' : 'Launch local agent'

      var err = document.getElementById('gate-err')
      if (!a.canLaunch && a.status !== 'live') {
        err.style.display = ''
        err.textContent = 'This gateway was started without launch support. Restart it with: pyrusllm serve --swarm'
      } else if (a.status === 'error') {
        err.style.display = ''
        err.textContent = a.message || 'could not launch the agent'
      } else {
        err.style.display = 'none'
      }
      paintOptions()
    }

    document.getElementById('launch').addEventListener('click', async function () {
      var btn = this
      btn.disabled = true
      btn.textContent = 'Joining the network...'
      try {
        await fetch('/v1/agent/launch', { method: 'POST' })
      } catch (e) { /* the chip poll repaints the real state */ }
      pollAgent()
    })

    // A way out still exists: your own model does not depend on the network,
    // and a first launch that will not let you produce a single token against
    // the machine already in front of you is a wall with nothing behind it.
    document.getElementById('skip').addEventListener('click', function () {
      skipped = true
      sessionStorage.setItem('pyrus.skipGate', '1')
      if (window.__agent) window.onAgent(window.__agent)
      document.getElementById('prompt').focus()
    })

    // ------------------------------------------------------------- options
    // The selector has THREE modes, which are two different questions: which
    // model you want and on which machine. Until now only the first one could
    // be answered.
    //
    //   local        -> this machine, and nothing leaves here  (local:true)
    //   auto         -> the best available, the gateway decides by load
    //   node:<id>    -> one specific machine                    (node:<id>)
    //
    // The "Local only" checkbox was absorbed into the first option. With both
    // existing separately they could contradict each other -- picking a peer's
    // model AND ticking local only gave a 404, because the gateway filters the
    // peers after the choice is made.
    function paintOptions() {
      var sel = document.getElementById('model')
      var live = agentLive()
      var loc = localNode()
      var chosen = sel.value || savedPin() && 'node:' + savedPin()

      var opts = []
      if (loc) {
        opts.push('<option value="local">' + esc(loc.displayName) + ' - this machine only</option>')
      }
      opts.push('<option value="auto"' + (live ? '' : ' disabled') + '>Auto - best available node</option>')

      // One option per MACHINE, with its load: that is what makes it possible
      // to choose between two peers serving the same model.
      var list = pinnable()
      if (list.length) {
        opts.push('<optgroup label="Specific node">')
        list.forEach(function (n) {
          var load = typeof n.loadPct === 'number' ? ' - ' + n.loadPct + '% busy' : ''
          opts.push(
            '<option value="node:' + esc(n.id) + '">' +
            esc(n.operator) + ' - ' + esc(n.displayName) + load +
            '</option>'
          )
        })
        opts.push('</optgroup>')
      }
      sel.innerHTML = opts.join('')

      var stillThere = false
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === chosen && !sel.options[i].disabled) stillThere = true
      }

      // A pin that arrived from /network wins over the default, but only if
      // that node is still around: if it left, we fall back to Auto and clear
      // it, instead of leaving the selector pointing at a ghost.
      var pin = savedPin()
      if (pin && !stillThere) {
        var pinAlive = false
        for (var j = 0; j < sel.options.length; j++) {
          if (sel.options[j].value === 'node:' + pin) pinAlive = true
        }
        // A pin is only discarded when we KNOW the node is gone: with the grid
        // still empty -- the first paint happens before /v1/nodes answers --
        // no pin shows up, and clearing it there always threw away the one
        // that had just arrived from /network.
        if (!pinAlive && list.length) { savePin(null); pin = null }
      }

      // If nobody picked by hand, Auto wins as soon as it becomes available:
      // the node used to come alive while the selector stayed nailed to the
      // local model, because that was the only valid option the first time it
      // was painted.
      if (stillThere) sel.value = chosen
      else if (pin) sel.value = 'node:' + pin
      else if (!userPicked && live) sel.value = 'auto'
      else sel.value = live ? 'auto' : (loc ? 'local' : 'auto')

      var note = document.getElementById('routing')
      var peers = peersOnline()
      if (sel.value === 'local') {
        note.textContent = 'Nothing leaves this machine.'
      } else if (sel.value.indexOf('node:') === 0) {
        note.textContent = 'Pinned to one machine - no fallback if it is busy.'
      } else if (!live) {
        note.textContent = 'Node offline - the network is out of reach.'
      } else {
        note.textContent = peers.length + (peers.length === 1 ? ' node' : ' nodes') + ' reachable'
      }
    }

    // Translates the selector mode into the three request fields.
    function target() {
      var v = document.getElementById('model').value
      if (v === 'local') {
        var l = localNode()
        return { model: (l && l.modelId) || autoModelId(), local: true, node: null }
      }
      if (v.indexOf('node:') === 0) {
        var id = v.slice(5)
        var n = nodes.filter(function (x) { return x.id === id })[0]
        return { model: (n && n.modelId) || autoModelId(), local: false, node: id }
      }
      return { model: autoModelId(), local: false, node: null }
    }

    // -------------------------------------------------------------- the thread
    function render() {
      var el = document.getElementById('thread')
      if (!msgs.length) {
        el.innerHTML = '<div class="hint" style="margin-top:2rem">Ask your node anything. ' +
          'Every answer says which machine produced it.</div>'
        return
      }
      el.innerHTML = msgs.map(function (m) {
        var who = m.role === 'user' ? 'You' : 'Assistant'
        var body = m.role === 'user' ? '<p>' + esc(m.content).replace(/\n/g, '<br>') + '</p>' : md(m.content)
        var cls = 'body' + (m.streaming && !m.content ? ' caret' : '')
        return '<div class="msg ' + m.role + '">' +
          '<div class="who">' + who + '</div>' +
          '<div class="' + cls + '">' + body + '</div>' +
          (m.meta ? prov(m.meta) : '') +
          // PHASE 9 — the challenge and the receipt go ATTACHED to the turn
          // that produced them. On a separate tab they would be two loose
          // artifacts to correlate by hand; here the evidence sits next to the
          // answer it talks about.
          //
          // The outputHash is recomputed against m.content, which is exactly
          // the text this browser accumulated delta by delta. That is the
          // entire point of D24: the hash is over the TEXT and does not depend
          // on the chunking, so comparing it here really does check that what
          // was attested is what was received -- not that two fields of the
          // same JSON agree.
          (m.x402 ? htmlDeDesafio(m.x402) : '') +
          (m.recibo
            ? htmlDeRecibo(m.recibo, { textoRecibido: m.content, messages: m.enviado })
            : '') +
          '</div>'
      }).join('')
      el.scrollTop = el.scrollHeight
    }

    // The provenance line. It is what sets this apart from any other chat:
    // the node that answered is named, not assumed.
    function prov(m) {
      // What decides is scope (the X-Pyrus-Scope header), not the kind: an
      // upstream can be a third party or an engine of our own behind HTTP, and
      // that difference is precisely what this line exists to declare.
      var outside = m.scope === 'external'
      var cls = m.kind === 'peer' ? 'peer' : outside ? 'upstream' : 'local'
      // "(this machine)" is a claim, not an ornament: hanging it on a
      // third-party API would say the prompt never left here when it did. And
      // the other way around, putting "(external API)" on a localhost
      // llama-server would accuse it of a leak that never happened.
      var who =
        m.kind === 'peer'
          ? m.operator
          : outside
            ? m.operator + ' (external API)'
            : m.operator + ' (this machine)'
      // Each part in its own span: joined into a single text node, the flex
      // gap does not apply and it read "18150ms1 tok/s20.2s".
      var parts = ['<span class="' + cls + '">' + esc(who) + '</span>']
      if (m.ttft !== null) parts.push('<span>first token ' + m.ttft + 'ms</span>')
      if (m.tps) parts.push('<span>' + m.tps + ' tok/s</span>')
      parts.push('<span>' + m.secs + 's total</span>')
      // The cost is ALWAYS there, zero included, and zero is written out in
      // words. "USD 0.0000" reads as "it came out very cheap" and that is not
      // it: it is that nobody is charged, because P2P payment does not exist
      // yet. And "up to" is not an ornament either: this number is the ceiling
      // the spend was authorised against, not what it ended up costing.
      //
      // The text is built by textoDeCostoEstimado, in panel-x402.mjs, and not
      // by a function in here: it is the SAME rule the new Phase 9 views
      // apply, and with two implementations one of them drifts on its own. The
      // six decimals live there for the usual reason -- with four, a turn
      // under 50 micros shows as "USD 0.0000", identical to free, which is
      // exactly the distinction this line exists to make.
      //
      // An OLD turn, without the field, draws nothing: calling it "no charge"
      // would claim it was free when all that is certain is it was not
      // recorded.
      if (m.cost === undefined || m.cost === null) { /* old turn, no data */ }
      else parts.push('<span class="cost">' + esc(textoDeCostoEstimado(m.cost).texto) + '</span>')
      return '<div class="prov">' + parts.join('') + '</div>'
    }

    function toggleButtons() {
      document.getElementById('send').style.display = streaming ? 'none' : ''
      document.getElementById('stop').style.display = streaming ? '' : 'none'
      document.getElementById('prompt').disabled = streaming
    }

    async function send() {
      if (streaming) return
      var ta = document.getElementById('prompt')
      var text = ta.value.trim()
      if (!text) return

      var dest = target()

      msgs.push({ role: 'user', content: text })
      // x402 and recibo start out null and almost always stay that way: they
      // only exist when the request went through the payment path. enviado
      // keeps the messages EXACTLY as they travelled, which is what the
      // attestation's promptHash is recomputed against -- the hash is over the
      // whole canonicalised conversation, not over the last turn.
      var slot = {
        role: 'assistant',
        content: '',
        meta: null,
        streaming: true,
        x402: null,
        recibo: null,
        enviado: null
      }
      msgs.push(slot)
      ta.value = ''
      ta.style.height = 'auto'
      streaming = true
      toggleButtons()
      render()

      var t0 = Date.now()
      var ttft = null
      var toks = 0
      ctrl = new AbortController()

      try {
        // The COMPLETE history, minus the empty slot being filled. Without
        // this every turn started from scratch and the model remembered
        // nothing.
        var history = msgs.filter(function (m) { return !m.streaming }).map(function (m) {
          return { role: m.role, content: m.content }
        })
        slot.enviado = history

        var resp = await authFetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: dest.model,
            messages: history,
            stream: true,
            local: dest.local,
            // The node field only travels when the user pinned a machine:
            // sending it as null on every request would muddy the contract for
            // the clients that never use it.
            node: dest.node || undefined
          })
        })

        if (!resp.ok) {
          var msg = 'HTTP ' + resp.status
          var b = null
          try {
            b = await resp.json()
            if (b && b.error && b.error.message) msg = b.error.message
          } catch (e) { /* the body was not JSON: the status is what is left */ }

          // PHASE 9 — a 402 with accepts[] is NOT a text error: it is the node
          // saying how much it charges, to whom, on which network and up to
          // how many tokens. Flattening it to "[error] HTTP 402" threw away
          // the four facts the phase DoD demands of the challenge.
          //
          // We get here when the request goes out WITHOUT a valid credential
          // against a node that has a wallet: the panel key revoked from
          // /node, or the /v1/keys/panel bootstrap that never answered. It is
          // the same 402 a stranger sees with curl, and now it reads the same.
          //
          // The other 402 that exists -- budget exhausted (B13) -- carries no
          // accepts and continues down the text path, which for that case is
          // the right one: there is nothing to pay, there is a cap that was
          // hit.
          var challengeView = vistaDeDesafio(b)
          if (resp.status === 402 && challengeView.esDesafio) {
            slot.x402 = challengeView
            slot.content = ''
            return
          }

          slot.content = '[error] ' + msg
          return
        }

        // Who answered travels in headers, not in the body: see
        // provenanceHeaders() in gateway.mjs.
        var operator = decodeURIComponent(resp.headers.get('X-Pyrus-Operator') || '') || 'unknown node'
        var kind = resp.headers.get('X-Pyrus-Kind') || 'real'
        var scope = resp.headers.get('X-Pyrus-Scope') || 'local'
        // PHASE 8 — what this turn may end up costing. It is the CEILING the
        // spend was authorised against, not what it cost: in SSE the headers
        // go out before the first token, so the real figure does not exist
        // yet.
        var cost = parseInt(resp.headers.get('X-Pyrus-Cost-Estimate-Micros') || '0', 10) || 0

        var reader = resp.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        while (true) {
          var r = await reader.read()
          if (r.done) break
          buf += dec.decode(r.value, { stream: true })
          var chunks = buf.split('\n\n')
          buf = chunks.pop()
          for (var i = 0; i < chunks.length; i++) {
            var line = chunks[i]
            if (line.indexOf('data: ') !== 0) continue
            var payload = line.slice(6)
            if (payload === '[DONE]') continue
            var ev = JSON.parse(payload)
            if (ev.error) {
              slot.content += '\n[error] ' + (ev.error.message || ev.error)
              continue
            }
            // PHASE 9 / D12 — the receipt travels as a FINAL SSE EVENT and
            // not in X-PAYMENT-RESPONSE, because with streaming the headers
            // already went out before the first token. It is recognised by
            // paymentResponse, the key the gateway hangs on it; it is not a
            // completion chunk and it has no choices.
            //
            // It is stored whole (receipt + attestation + the reason when it
            // is missing) and drawn below the answer. receiptUrl stays so it
            // can be looked at again from /node later.
            if (ev.paymentResponse || ev.attestation || ev.attestationMissing) {
              slot.recibo = ev
              continue
            }
            var d = ev.choices && ev.choices[0] && ev.choices[0].delta
            var piece = (d && d.content) || ''
            if (piece) {
              if (ttft === null) ttft = Date.now() - t0
              toks++
              slot.content += piece
              render()
            }
          }
        }

        var total = (Date.now() - t0) / 1000
        slot.meta = {
          operator: operator,
          kind: kind,
          scope: scope,
          ttft: ttft,
          tps: ttft !== null && total > 0 ? Math.round(toks / total) : 0,
          secs: total.toFixed(1),
          cost: cost
        }
      } catch (err) {
        if (err && err.name === 'AbortError') slot.content += '\n[stopped]'
        else slot.content += '\n[error] ' + ((err && err.message) || err)
      } finally {
        slot.streaming = false
        streaming = false
        ctrl = null
        toggleButtons()
        render()
        save()
      }
    }

    function save() {
      try {
        sessionStorage.setItem('pyrus.chat', JSON.stringify(msgs.slice(-40)))
      } catch (e) { /* with no storage the chat still works, it just does not survive a reload */ }
    }

    function load() {
      try {
        var raw = sessionStorage.getItem('pyrus.chat')
        if (raw) msgs = JSON.parse(raw).filter(function (m) { return m && m.content })
      } catch (e) { msgs = [] }
    }

    document.getElementById('send').addEventListener('click', send)
    document.getElementById('stop').addEventListener('click', function () {
      if (ctrl) ctrl.abort()
    })
    document.getElementById('model').addEventListener('change', function () {
      userPicked = true
      // Picking by hand discards the pin that came from /network: the
      // selector has the last word, otherwise the chip would say one thing and
      // the request would do another.
      if (this.value.indexOf('node:') !== 0) savePin(null)
      else savePin(this.value.slice(5))
      paintOptions()
    })
    document.getElementById('new').addEventListener('click', function () {
      msgs = []
      save()
      render()
    })

    var ta = document.getElementById('prompt')
    ta.addEventListener('input', function () {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 176) + 'px'
    })
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        send()
      }
    })

    async function refreshNodes() {
      try {
        var r = await authFetch('/v1/nodes')
        var j = await r.json()
        nodes = j.nodes || []
        paintOptions()
      } catch (e) { /* the next poll retries */ }
    }

    // ======================================================================
    // Action palette (Ctrl+K) and the composer's "+" menu.
    //
    // Half of these actions are WIRED to endpoints that already exist; the
    // other half is shape with nothing behind it yet. The latter carry a
    // visible MOCK label, not just a comment: a control that looks functional
    // and does nothing is worse than a missing one, because whoever touches it
    // walks away believing they already configured it.
    // ======================================================================

    var options = { thinking: false, effort: 2, fast: false, switchOnFlag: false, mode: 'auto' }
    try {
      var saved = JSON.parse(sessionStorage.getItem('pyrus.opts') || 'null')
      if (saved) options = Object.assign(options, saved)
    } catch (e) { /* with no session, the defaults stand */ }

    function saveOpts() {
      try { sessionStorage.setItem('pyrus.opts', JSON.stringify(options)) } catch (e) {}
    }

    var attachments = []

    function paintAttachments() {
      var cont = document.getElementById('adjuntos')
      cont.innerHTML = attachments.map(function (a, i) {
        return '<span class="adjunto">' + esc(a.name) +
          ' <button data-quita="' + i + '" title="Remove">&times;</button></span>'
      }).join('')
      cont.querySelectorAll('[data-quita]').forEach(function (b) {
        b.addEventListener('click', function () {
          attachments.splice(Number(b.dataset.quita), 1)
          paintAttachments()
        })
      })
    }

    function toggleSwitch(on) { return '<span class="sw' + (on ? ' on' : '') + '"><i></i></span>' }

    function stepper(n) {
      var out = '<span class="esf">'
      for (var i = 0; i < 5; i++) {
        var cls = i === 4 ? (n >= 4 ? 'pico' : '') : (i <= n ? 'on' : '')
        out += '<b class="' + cls + '"></b>'
      }
      return out + '</span>'
    }

    var NIVELES = ['Minimal', 'Low', 'Medium', 'High', 'Max']

    // Each action declares whether it is wired. mock:true paints the label.
    function actions() {
      return [
        { g: 'Context', t: 'Attach file...', d: 'Uploads to this node drive and inserts its name', f: attachFile },
        { g: 'Context', t: 'Mention file from this node...', d: 'Lists what this node publishes', f: mentionFile },
        { g: 'Context', t: 'Clear conversation', f: function () { document.getElementById('new').click() } },
        { g: 'Context', t: 'Rewind', d: 'Undoes the last exchange', f: rewind, off: msgs.length < 2 },
        { g: 'Context', t: 'Browse the web', mock: true, d: 'There is no web tool yet' },

        { g: 'Model', t: 'Switch model...', v: modelLabel(), f: function () {
          cerrarPal()
          var sel = document.getElementById('model')
          sel.focus()
          if (sel.showPicker) { try { sel.showPicker() } catch (e) {} }
        } },
        { g: 'Model', t: 'Effort', v: NIVELES[options.effort], extra: stepper(options.effort), mock: true,
          f: function () { options.effort = (options.effort + 1) % 5; saveOpts(); repintarPal() } },
        { g: 'Model', t: 'Thinking', extra: toggleSwitch(options.thinking), mock: true,
          d: 'Measured: turning it on for nemotron-3.5 costs 100x the tokens. The toggle does not reach the upstream yet',
          f: function () { options.thinking = !options.thinking; saveOpts(); repintarPal() } },
        { g: 'Model', t: 'Switch models when a message is flagged', extra: toggleSwitch(options.switchOnFlag), mock: true,
          f: function () { options.switchOnFlag = !options.switchOnFlag; saveOpts(); repintarPal() } },
        { g: 'Model', t: 'Toggle fast mode', extra: toggleSwitch(options.fast), mock: true,
          f: function () { options.fast = !options.fast; saveOpts(); repintarPal() } },
        { g: 'Model', t: 'Account & usage...', d: 'Real spending and quota for this node', f: viewAccount },

        { g: 'Modes', t: 'Manual', d: 'Asks for approval before every action', mock: true,
          v: options.mode === 'manual' ? 'active' : '',
          f: function () { options.mode = 'manual'; saveOpts(); repintarPal() } },
        { g: 'Modes', t: 'Plan', d: 'Explores and proposes before touching anything', mock: true,
          v: options.mode === 'plan' ? 'active' : '',
          f: function () { options.mode = 'plan'; saveOpts(); repintarPal() } },
        { g: 'Modes', t: 'Auto', d: 'Approves what is safe and stops at what is risky', mock: true,
          v: options.mode === 'auto' ? 'active' : '',
          f: function () { options.mode = 'auto'; saveOpts(); repintarPal() } }
      ]
    }

    function modelLabel() {
      var sel = document.getElementById('model')
      if (!sel || sel.selectedIndex < 0) return ''
      var t = sel.options[sel.selectedIndex].textContent
      return t.length > 34 ? t.slice(0, 33) + '…' : t
    }

    // ---------------------------------------------------- real actions

    function rewind() {
      // The last user/assistant pair is dropped. It is local and exact: the
      // COMPLETE history is sent on every request, so undoing it here really
      // undoes what the model will see on the next turn.
      cerrarPal()
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
      if (msgs.length) msgs.pop()
      save()
      render()
    }

    async function viewAccount() {
      cerrarPal()
      openModal('Account & usage', '<p class="hint">Loading...</p>')
      try {
        var res = await Promise.all([
          authFetch('/v1/budget').then(function (x) { return x.json() }),
          authFetch('/v1/quota').then(function (x) { return x.json() })
        ])
        var b = res[0]
        var q = res[1]
        openModal('Account & usage',
          '<p class="sub">Real numbers from this node, not an example.</p>' +
          '<h4 style="margin:.6rem 0 .3rem">Spending on external APIs (' + esc(b.period || '') + ')</h4>' +
          '<p>Spent <b>' + esc(b.spent || '-') + '</b> of a cap of <b>' + esc(b.cap || '-') +
          '</b> &middot; ' + esc(b.remaining || '-') + ' left</p>' +
          '<h4 style="margin:.9rem 0 .3rem">Quota this node GIVES AWAY to its peers</h4>' +
          '<p><b>' + esc(String(q.given_tokens != null ? q.given_tokens : 0)) + '</b> tokens given &middot; ' +
          esc(String(q.quota_tokens || 0)) + ' per peer every ' + esc(String(q.window_hours || 0)) + ' h &middot; ' +
          esc(String((q.peers || []).length)) + ' peer(s) consuming</p>')
      } catch (e) {
        openModal('Account & usage', '<p class="hint">Could not read it: ' + esc(e.message) + '</p>')
      }
    }

    async function mentionFile() {
      cerrarPal()
      openModal('Mention a file', '<p class="hint">Reading this node drive...</p>')
      try {
        var res = await authFetch('/v1/files')
        var j = await res.json()
        var fs = j.files || []
        if (!fs.length) {
          openModal('Mention a file', '<p class="hint">This node does not publish any file yet. ' +
            'Upload one with "Attach file" or from <a href="/node">my node</a>.</p>')
          return
        }
        openModal('Mention a file', '<div class="pal-lista">' + fs.map(function (f) {
          var name = f.name || f.path || ''
          return '<button class="pal-item" data-men="' + esc(name) + '">' + esc(name) +
            '<span class="der"><span class="val">' + esc(String(f.size != null ? f.size : '')) +
            '</span></span></button>'
        }).join('') + '</div>')
        document.querySelectorAll('[data-men]').forEach(function (b) {
          b.addEventListener('click', function () {
            var ta = document.getElementById('prompt')
            ta.value = (ta.value ? ta.value + ' ' : '') + '@' + b.dataset.men
            cerrarModal()
            ta.focus()
          })
        })
      } catch (e) {
        openModal('Mention a file', '<p class="hint">Could not list it: ' + esc(e.message) + '</p>')
      }
    }

    function attachFile() {
      cerrarPal()
      var inp = document.createElement('input')
      inp.type = 'file'
      inp.addEventListener('change', async function () {
        var f = inp.files && inp.files[0]
        if (!f) return
        attachments.push({ name: f.name + ' (uploading...)' })
        paintAttachments()
        var i = attachments.length - 1
        try {
          // It REALLY uploads to this node's Hyperdrive. What does not exist
          // is a model that reads the file: hence the name is inserted into
          // the prompt and the binary is not sent to the chat.
          var res = await authFetch('/v1/files/upload?name=' + encodeURIComponent(f.name), {
            method: 'POST',
            body: f
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          attachments[i] = { name: f.name }
          var ta = document.getElementById('prompt')
          ta.value = (ta.value ? ta.value + ' ' : '') + '@' + f.name
        } catch (e) {
          attachments[i] = { name: f.name + ' (failed)' }
        }
        paintAttachments()
      })
      inp.click()
    }

    // ------------------------------------------------------------ the palette

    var palAbierta = false
    var palFiltro = ''
    var palSel = 0

    function visibles() {
      var q = palFiltro.toLowerCase()
      return actions().filter(function (a) {
        return !q || (a.t + ' ' + (a.d || '') + ' ' + a.g).toLowerCase().indexOf(q) !== -1
      })
    }

    function repintarPal() {
      if (!palAbierta) return
      var lista = visibles()
      var html = ''
      var grupo = null
      lista.forEach(function (a, i) {
        if (a.g !== grupo) {
          grupo = a.g
          html += '<div class="pal-grupo">' + esc(grupo) + '</div>'
        }
        html += '<button class="pal-item' + (i === palSel ? ' sel' : '') + '"' +
          (a.off ? ' disabled' : '') + ' data-i="' + i + '"><span>' + esc(a.t) +
          (a.d ? '<br><span class="val">' + esc(a.d) + '</span>' : '') + '</span><span class="der">' +
          (a.v ? '<span class="val">' + esc(a.v) + '</span>' : '') +
          (a.mock ? '<span class="mock">mock</span>' : '') +
          (a.extra || '') + '</span></button>'
      })
      if (!html) html = '<div class="pal-vacio">Nothing matches that filter.</div>'

      document.getElementById('pal-lista').innerHTML = html
      document.querySelectorAll('#pal-lista .pal-item').forEach(function (b) {
        b.addEventListener('click', function () {
          var a = visibles()[Number(b.dataset.i)]
          if (a && a.f && !a.off) a.f()
        })
      })
    }

    function abrirPal() {
      palAbierta = true
      palFiltro = ''
      palSel = 0
      document.getElementById('palette').innerHTML =
        '<div class="pal-overlay" id="pal-ov"><div class="pal">' +
        '<input class="filtro" id="pal-filtro" placeholder="Filter actions..." autocomplete="off">' +
        '<div class="pal-lista" id="pal-lista"></div>' +
        '<div class="pal-pie">Enter to run &middot; Esc to close &middot; ' +
        'anything marked <b>mock</b> does nothing yet</div></div></div>'
      repintarPal()
      var inp = document.getElementById('pal-filtro')
      inp.focus()
      inp.addEventListener('input', function () {
        palFiltro = inp.value
        palSel = 0
        repintarPal()
      })
      document.getElementById('pal-ov').addEventListener('click', function (ev) {
        if (ev.target.id === 'pal-ov') cerrarPal()
      })
    }

    function cerrarPal() {
      palAbierta = false
      document.getElementById('palette').innerHTML = ''
    }

    document.getElementById('abrir-pal').addEventListener('click', abrirPal)

    document.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault()
        if (palAbierta) cerrarPal()
        else abrirPal()
        return
      }
      if (!palAbierta) return
      if (ev.key === 'Escape') { ev.preventDefault(); cerrarPal(); return }
      var lista = visibles()
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        palSel = Math.min(palSel + 1, lista.length - 1)
        repintarPal()
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        palSel = Math.max(palSel - 1, 0)
        repintarPal()
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        var a = lista[palSel]
        if (a && a.f && !a.off) a.f()
      }
    })

    // --------------------------------------------------------- the "+" menu

    document.getElementById('mas').addEventListener('click', function (ev) {
      ev.stopPropagation()
      var already = document.getElementById('mas-menu')
      if (already) { already.remove(); return }
      var row = document.getElementById('mas').parentNode
      var m = document.createElement('div')
      m.className = 'mas-menu'
      m.id = 'mas-menu'
      m.innerHTML =
        '<button class="pal-item" data-m="subir">Upload from computer</button>' +
        '<button class="pal-item" data-m="ctx">Add context</button>' +
        '<button class="pal-item" data-m="web">Browse the web<span class="der">' +
        '<span class="mock">mock</span></span></button>'
      row.appendChild(m)
      m.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          m.remove()
          if (b.dataset.m === 'subir') attachFile()
          if (b.dataset.m === 'ctx') mentionFile()
        })
      })
      document.addEventListener('click', function cerrar() {
        var el = document.getElementById('mas-menu')
        if (el) el.remove()
        document.removeEventListener('click', cerrar)
      })
    })

    load()
    render()
    refreshNodes()
    setInterval(refreshNodes, 3000)
`

export const CHAT_HTML = page(
  'PyrusLLM \u00b7 Chat',
  `
  <div id="gate" class="gate" style="display:none">
    <img class="logo" src="${LOGO_FUNDACION}"
      alt="Fundación Iniciativa Urbana Inteligente">
    <h1>Put your machine on the network</h1>
    <p>Launching your local agent joins this machine to the P2P network: it starts
      serving your model to other nodes, and that is what gets you access to
      theirs. Until it is live the network stays out of reach \u2014 your own
      model still answers.</p>
    <button id="launch">Launch local agent</button>
    <div class="err" id="gate-err" style="display:none"></div>
    <div><button class="alt" id="skip">Just use my local model</button></div>
  </div>

  <div id="chat" style="display:none">
    <div id="thread"></div>
    <div class="composer">
      <div class="opts">
        <select id="model"></select>
        <button class="ghost" id="new" style="margin:0;padding:.25rem .6rem;font-size:.78rem">New chat</button>
        <span class="note" id="routing"></span>
      </div>
      <div class="adjuntos" id="adjuntos"></div>
      <div class="row">
        <button class="ghost" id="mas" title="Add context" style="margin:0;padding:.35rem .6rem">+</button>
        <button class="ghost" id="abrir-pal" title="Actions (Ctrl+K)" style="margin:0;padding:.35rem .6rem">&#9092;</button>
        <textarea id="prompt" rows="1" placeholder="Ask anything..."></textarea>
        <button id="send">Send</button>
        <button id="stop" class="ghost" style="display:none">Stop</button>
      </div>
    </div>
  <div id="modal"></div>
  <div id="palette"></div>
  </div>

  <script>
${ESC}
${FUENTE_EMBEBIDA}
${MODAL_JS}
${CHAT_JS}
  </script>
  `,
  'chatpage'
)

// -----------------------------------------------------------------------------
// /wallet panel (Phase 11) — this node's PAYOUT wallet, READ ONLY.
//
// The entire drawing is decided by the pure functions in
// `qvac/panel-wallet.mjs`, pasted here by `FUENTE_EMBEBIDA_WALLET` just like
// panel-x402: testing them in the suite is testing them here. This file only
// contributes the poll and the click wiring. Send and swap are NOT here: the
// buttons are drawn disabled.
// -----------------------------------------------------------------------------
export const WALLET_HTML = page(
  'PyrusLLM · Wallet',
  `
  <h1>Wallet</h1>
  <p class="sub">This node's payout wallet: address, balance, movements and which network it is on. You can create, import, receive and send from here; the network and the tokens being watched are configured with the ☰. The node signs, not the browser: the seed never leaves the process that opens it. The address is the same one that travels signed inside the manifest.</p>
  <div id="wallet-root" class="w-root"><div class="skel"><div style="width:55%"></div><div style="width:80%"></div><div style="width:35%"></div></div></div>

  <script>
${ESC}
${FUENTE_EMBEBIDA_WALLET}
${MODAL_JS}

    let vistaWallet = vistaDeSaldos(null)
    let filtroWallet = ''
    let tabWallet = 'assets'

    // PHASE 12 — the history. Stays null until the tab is entered: reading it
    // on every poll would mean hitting the explorer every 15 s for a screen
    // nobody may be looking at.
    let vistaHist = null

    // Onboarding state machine. 'seed' is the 24-word screen: once there, the
    // poll must NOT repaint until it is confirmed.
    let onbEstado = 'idle'   // 'idle' | 'seed'
    let onbSeed = null        // { frase, address }
    let onbOcupado = false

    // PHASE 12 — Settings open. Same criterion as 'seed': while it is up, the
    // 15 s poll does NOT repaint. A half-filled form (a 42-character token
    // address pasted by hand) cannot be overwritten on its own.
    let settingsAbierto = false

    // PHASE 12 — the send state machine. Same criterion again: with anything
    // other than 'idle' up, the poll does NOT repaint. A balance refresh
    // wiping a half-pasted destination address, or worse, covering the screen
    // showing the hash of a just-sent transaction, cannot be allowed.
    let envioEstado = 'idle'   // 'idle' | 'form' | 'revision' | 'enviando' | 'resultado'
    let envioDatos = null      // { destino, monto, asset, simbolo, red, mainnet, ... }
    let envioGas = null        // whatever /v1/wallet/send/quote answered
    let envioResultado = null  // { estado, hash, explorer, ... }

    // Reading and drawing are separate because Settings needs to re-read
    // WITHOUT repainting the card behind it: after adding a token what gets
    // refreshed is the overlay, not the wallet that is covered.
    async function cargarVistaWallet () {
      try {
        const r = await authFetch('/v1/wallet/balances')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        vistaWallet = vistaDeSaldos(await r.json())
      } catch (e) {
        vistaWallet = vistaDeSaldos({
          error: 'could not read /v1/wallet/balances: ' + ((e && e.message) || e)
        })
      }
    }

    async function cargarWallet () {
      await cargarVistaWallet()
      pintarWallet()
    }

    // On every poll (15 s) the whole card is repainted, UNLESS we are on the
    // seed-phrase screen (never overwritten), or the focus is in the search box
    // (there only #w-filas is touched so what was typed is not eaten).
    function pintarWallet () {
      if (onbEstado === 'seed') return
      if (settingsAbierto) return
      if (envioEstado !== 'idle') return
      const foco = document.activeElement
      if (foco && foco.id === 'w-filtro') {
        const filas = document.getElementById('w-filas')
        if (filas) { filas.innerHTML = htmlDeFilas(vistaWallet, filtroWallet); return }
      }
      document.getElementById('wallet-root').innerHTML =
        htmlDeWallet(vistaWallet, filtroWallet, tabWallet, vistaHist)
      cablearWallet()
    }

    // PHASE 12 — the movements. Requested when entering the tab and on the
    // poll ONLY if the tab is still open: the explorer is a third party and
    // there is no reason to hit it every 15 s from a screen nobody has up.
    async function cargarHistorial () {
      try {
        const r = await authFetch('/v1/wallet/history')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        vistaHist = vistaDeHistorial(await r.json())
      } catch (e) {
        // A failing fetch is NOT "there were no movements": the view is built
        // with the reason, which is what htmlDeHistorial draws as "—".
        vistaHist = vistaDeHistorial({
          ok: false,
          error: 'could not read /v1/wallet/history: ' + ((e && e.message) || e)
        })
      }
      if (tabWallet === 'history') pintarWallet()
    }

    function pintarSeed () {
      document.getElementById('wallet-root').innerHTML =
        '<div class="w-card">' + htmlDeSeed(onbSeed.frase, onbSeed.address) + '</div>'
      const chk = document.getElementById('w-seed-check')
      const listo = document.getElementById('w-seed-listo')
      chk.addEventListener('change', () => { listo.disabled = !chk.checked })
      listo.addEventListener('click', () => {
        // The phrase is released from memory and we go back to the normal
        // wallet.
        onbSeed = null
        onbEstado = 'idle'
        cargarWallet()
      })
      document.querySelectorAll('.w-card [data-copy]').forEach(b => {
        b.addEventListener('click', () => copyText(b.dataset.copy, b))
      })
    }

    // ---------------------------------------------------------------------
    // PHASE 12 — send. The screen COVERS the card (like the seed one) and the
    // poll does not repaint it. The node does the signing: three strings leave
    // from here.
    // ---------------------------------------------------------------------
    function msgEnvio (texto, malo) {
      const el = document.getElementById('w-env-msg')
      if (el) el.innerHTML = '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' +
        esc(texto) + '</span>'
    }

    function pintarEnvio () {
      const root = document.getElementById('wallet-root')
      if (envioEstado === 'form') {
        root.innerHTML = '<div class="w-card">' + htmlDeEnvio(vistaWallet) + '</div>'
      } else if (envioEstado === 'revision' || envioEstado === 'enviando') {
        root.innerHTML = '<div class="w-card">' +
          htmlDeRevisionEnvio(vistaWallet, envioDatos, envioGas) + '</div>'
      } else {
        root.innerHTML = '<div class="w-card">' + htmlDeEstadoEnvio(envioResultado) + '</div>'
      }
      cablearEnvio()
    }

    function salirDelEnvio () {
      envioEstado = 'idle'
      envioDatos = null
      envioGas = null
      envioResultado = null
      cargarWallet()
      // Whatever was just sent has to show up in the history the next time it
      // is opened: the cache is dropped so it is not shown stale.
      vistaHist = null
    }

    async function revisarEnvio () {
      const asset = (document.getElementById('w-env-asset') || {}).value || 'native'
      const destino = ((document.getElementById('w-env-destino') || {}).value || '').trim()
      const monto = ((document.getElementById('w-env-monto') || {}).value || '').trim()

      if (!envioParecePlausible({ destino, monto, asset })) {
        msgEnvio('check the destination (0x + 40 hex) and the amount (a decimal greater than zero)', true)
        return
      }
      msgEnvio('estimating gas…', false)
      try {
        const r = await authFetch('/v1/wallet/send/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino, monto, asset })
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) { msgEnvio((d && d.error && d.error.message) || ('HTTP ' + r.status), true); return }
        envioDatos = d
        envioGas = d
        envioEstado = 'revision'
        pintarEnvio()
      } catch (e) {
        msgEnvio('could not estimate: ' + ((e && e.message) || e), true)
      }
    }

    async function confirmarEnvio () {
      if (envioEstado === 'enviando') return
      // The three fields come from what the QUOTE returned, not from reading
      // the inputs again: they are the same ones gas was estimated on and the
      // same ones the person just reviewed on screen. Re-reading the form here
      // would open the door to reviewing one thing and sending another.
      const cuerpo = {
        destino: envioDatos.destino,
        monto: envioDatos.monto,
        asset: envioDatos.asset || 'native'
      }

      // MAINNET asks you to type it, same as the network selector — and here
      // it weighs more, because this is not undone by restarting.
      if (envioDatos.mainnet) {
        const c = prompt('MAINNET moves real money and this cannot be undone.\\n\\n' +
          envioDatos.monto + ' ' + (envioDatos.simbolo || '') + ' to ' + envioDatos.destino +
          '\\n\\nType MAINNET to confirm:')
        if (c !== 'MAINNET') { msgEnvio('cancelled', true); return }
        cuerpo.confirmar = 'MAINNET'
      }

      envioEstado = 'enviando'
      const boton = document.getElementById('w-env-confirmar')
      if (boton) boton.disabled = true
      msgEnvio('signing and broadcasting…', false)
      try {
        const r = await authFetch('/v1/wallet/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpo)
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          envioResultado = {
            estado: 'fallida',
            error: (d && d.error && d.error.message) || ('HTTP ' + r.status),
            detalle: (d && d.error && d.error.detalle) || null,
            destino: envioDatos.destino,
            monto: envioDatos.monto,
            simbolo: envioDatos.simbolo
          }
        } else {
          envioResultado = d
        }
      } catch (e) {
        envioResultado = {
          estado: 'fallida',
          error: 'could not send: ' + ((e && e.message) || e),
          destino: envioDatos.destino,
          monto: envioDatos.monto,
          simbolo: envioDatos.simbolo
        }
      }
      envioEstado = 'resultado'
      pintarEnvio()
    }

    function cablearEnvio () {
      const cancelar = document.getElementById('w-env-cancelar')
      if (cancelar) cancelar.addEventListener('click', salirDelEnvio)
      const listo = document.getElementById('w-env-listo')
      if (listo) listo.addEventListener('click', salirDelEnvio)
      const volver = document.getElementById('w-env-volver')
      if (volver) volver.addEventListener('click', () => { envioEstado = 'form'; pintarEnvio() })
      const revisar = document.getElementById('w-env-revisar')
      if (revisar) revisar.addEventListener('click', revisarEnvio)
      const confirmar = document.getElementById('w-env-confirmar')
      if (confirmar) confirmar.addEventListener('click', confirmarEnvio)
    }

    // ---------------------------------------------------------------------
    // PHASE 12 — Settings, behind the ☰.
    //
    // It is drawn in a container SEPARATE from #wallet-root, not inside it:
    // that way closing it does not force repainting the whole card, and a poll
    // arriving while it is open (it cannot: pintarWallet bails) would not drag
    // it along.
    // ---------------------------------------------------------------------
    function contenedorSettings () {
      let el = document.getElementById('w-set-host')
      if (!el) {
        el = document.createElement('div')
        el.id = 'w-set-host'
        document.body.appendChild(el)
      }
      return el
    }

    function cerrarSettings () {
      settingsAbierto = false
      contenedorSettings().innerHTML = ''
      document.removeEventListener('keydown', onEscSettings)
      // On the way back it reloads: a token may have been added or removed,
      // and the asset list has to reflect that without waiting for the next
      // poll.
      cargarWallet()
    }

    function onEscSettings (ev) { if (ev.key === 'Escape') cerrarSettings() }

    function pintarSettings () {
      contenedorSettings().innerHTML = htmlDeSettings(vistaWallet)
      document.getElementById('w-set-cerrar').addEventListener('click', cerrarSettings)
      // A click OUTSIDE the card closes it; inside it does not. The exact
      // target is compared so that releasing the mouse outside after selecting
      // text does not close it, which is the bug the /network modal already
      // had.
      document.getElementById('w-set-ov').addEventListener('click', ev => {
        if (ev.target.id === 'w-set-ov') cerrarSettings()
      })
      document.addEventListener('keydown', onEscSettings)
      cablearSettings()
    }

    function msgToken (texto, malo) {
      const el = document.getElementById('w-token-msg')
      if (el) el.innerHTML = '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' +
        esc(texto) + '</span>'
    }

    async function tokensFetch (metodo, cuerpo, alTerminar) {
      try {
        const r = await authFetch('/v1/wallet/tokens', {
          method: metodo,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpo)
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) { msgToken((d && d.error && d.error.message) || ('HTTP ' + r.status), true); return }
        // The view is reloaded from the server and the overlay repainted: the
        // list you see is the one that ended up ON DISK, not the one the
        // browser assumes.
        await cargarVistaWallet()
        pintarSettings()
        if (alTerminar) alTerminar()
      } catch (e) {
        msgToken('could not save: ' + ((e && e.message) || e), true)
      }
    }

    function cablearSettings () {
      // Adding a token. The shape is checked HERE before posting — it is the
      // same rule the node applies before touching disk.
      const bAdd = document.getElementById('w-token-add')
      if (bAdd) {
        bAdd.addEventListener('click', () => {
          const addr = (document.getElementById('w-token-addr') || {}).value || ''
          const sym = (document.getElementById('w-token-sym') || {}).value || ''
          const dec = (document.getElementById('w-token-dec') || {}).value || ''
          const tok = { address: addr.trim(), symbol: sym.trim(), decimals: Number(dec) }
          if (!tokenParecePlausible(tok)) {
            msgToken('check the three fields: address 0x + 40 hex, symbol of 1 to 12 ' +
              'characters, decimals an integer from 0 to 36', true)
            return
          }
          bAdd.disabled = true
          tokensFetch('POST', tok, () => msgToken('added — shown unverified', false))
        })
      }

      document.querySelectorAll('[data-w-token-del]').forEach(b => {
        b.addEventListener('click', () => {
          tokensFetch('DELETE', { address: b.dataset.wTokenDel })
        })
      })

      cablearSelectorRed()
    }

    function msgOnb (texto, malo) {
      const el = document.getElementById('w-onb-msg')
      if (el) el.innerHTML = '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' +
        esc(texto) + '</span>'
    }

    async function crearWallet (frase) {
      if (onbOcupado) return
      onbOcupado = true
      msgOnb(frase ? 'importing…' : 'generating the wallet…', false)
      try {
        const r = await authFetch('/v1/wallet/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(frase ? { frase } : {})
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          msgOnb((d && d.error && d.error.message) || ('HTTP ' + r.status), true)
          return
        }
        if (d.frase) {
          // New wallet: on to the seed-phrase screen, exactly once.
          onbSeed = { frase: d.frase, address: d.address }
          onbEstado = 'seed'
          pintarSeed()
        } else {
          // Import: there is no phrase to show, straight to the wallet.
          await cargarWallet()
        }
        if (d.swarmActivo && !d.swarmReanunciado) {
          msgOnb('wallet ready, but the manifest could not be re-announced: restart the node so peers see the address', true)
        }
      } catch (e) {
        msgOnb('could not create the wallet: ' + ((e && e.message) || e), true)
      } finally {
        onbOcupado = false
      }
    }

    function cablearWallet () {
      const f = document.getElementById('w-filtro')
      if (f) {
        f.value = filtroWallet
        f.addEventListener('input', ev => {
          filtroWallet = ev.target.value
          const filas = document.getElementById('w-filas')
          if (filas) filas.innerHTML = htmlDeFilas(vistaWallet, filtroWallet)
        })
      }
      document.querySelectorAll('.w-card [data-w-tab]').forEach(b => {
        b.addEventListener('click', () => {
          tabWallet = b.dataset.wTab
          pintarWallet()
          // The history is only requested here, the first time the tab is
          // opened.
          if (tabWallet === 'history' && !vistaHist) cargarHistorial()
        })
      })
      document.querySelectorAll('.w-card [data-copy]').forEach(b => {
        b.addEventListener('click', () => copyText(b.dataset.copy, b))
      })

      // Onboarding: create / import.
      const bCrear = document.getElementById('w-onb-crear')
      if (bCrear) {
        bCrear.addEventListener('click', () => {
          if (confirm('24 words will be generated and shown ONCE only. Write them down on paper. Continue?')) {
            crearWallet(null)
          }
        })
      }
      const bTog = document.getElementById('w-onb-importar-toggle')
      if (bTog) {
        bTog.addEventListener('click', () => {
          const box = document.getElementById('w-onb-import')
          if (box) box.hidden = !box.hidden
        })
      }
      const bImp = document.getElementById('w-onb-importar')
      if (bImp) {
        bImp.addEventListener('click', () => {
          const ta = document.getElementById('w-onb-frase')
          const frase = ta ? ta.value : ''
          if (!fraseParecePlausible(frase)) {
            msgOnb('that does not look like a BIP-39 phrase (12 to 24 lowercase words)', true)
            return
          }
          crearWallet(palabrasDeFrase(frase).join(' '))
        })
      }

      // PHASE 12 — Send opens its own screen, which covers the card.
      const bSend = document.getElementById('w-acc-send')
      if (bSend) {
        bSend.addEventListener('click', () => {
          envioEstado = 'form'
          envioDatos = null
          envioGas = null
          envioResultado = null
          pintarEnvio()
        })
      }

      // PHASE 12 — the ☰ opens Settings. Everything that used to be loose
      // configuration on the card lives in there now.
      const bSet = document.getElementById('w-set-abrir')
      if (bSet) {
        bSet.addEventListener('click', () => {
          settingsAbierto = true
          pintarSettings()
        })
      }
    }

    // Network selector. It does NOT hot-swap: it saves and asks for a
    // restart. Going to MAINNET requires typing MAINNET, which is what the
    // endpoint demands.
    //
    // PHASE 12 — moved here from cablearWallet WITHOUT changing anything: the
    // selector is now drawn inside Settings, so its wiring goes with the rest
    // of that screen.
    function cablearSelectorRed () {
      const bRed = document.getElementById('w-red-aplicar')
      if (bRed) {
        bRed.addEventListener('click', async () => {
          const sel = document.getElementById('w-red-sel')
          const msg = document.getElementById('w-red-msg')
          const write = (t, malo) => {
            if (msg) msg.innerHTML =
              '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' + esc(t) + '</span>'
          }
          if (!sel) return
          const red = sel.value
          const opt = sel.options[sel.selectedIndex]
          const isMainnet = opt && opt.dataset.mainnet === '1'
          const current = (vistaWallet.red && vistaWallet.red.nombre) || ''
          if (red === current) { write('you are already on that network', true); return }
          const cuerpo = { red }
          if (isMainnet) {
            const c = prompt('MAINNET moves real money. Type MAINNET to confirm:')
            if (c !== 'MAINNET') { write('cancelled', true); return }
            cuerpo.confirmar = 'MAINNET'
          }
          bRed.disabled = true
          try {
            const r = await authFetch('/v1/wallet/network', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cuerpo)
            })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) { write((d && d.error && d.error.message) || ('HTTP ' + r.status), true); return }
            write(
              'saved: ' + d.red + ' (eip155:' + d.chainId + '). Restart the node for it to take effect.' +
              (d.avisoX402 ? ' ' + d.avisoX402 : ''),
              false
            )
          } catch (e) {
            write('could not save: ' + ((e && e.message) || e), true)
          } finally {
            bRed.disabled = false
          }
        })
      }
    }

    cargarWallet()
    setInterval(() => {
      cargarWallet()
      // The history only refreshes while its tab is open.
      if (tabWallet === 'history') cargarHistorial()
    }, 15000)
  </script>`
)

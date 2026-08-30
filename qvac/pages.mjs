// The 3 panels of the simulated marketplace, as pure HTML strings.
//
// They're embedded in JS (not as loose .html files in /public) on purpose:
// bare-pack builds the standalone binary by following the import graph from
// bin.mjs, and a static file outside that graph doesn't travel with the
// binary. An exported string does travel, without having to resolve paths
// by hand or depend on bare-fs to serve static content.
//
// PHASE 9 — what the phase emitted and wasn't visible (the 402, the receipt,
// D24's attestation and D25's split) is rendered with `qvac/panel-x402.mjs`.
// That file is NOT imported to call it from here: it's imported to PASTE ITS
// CODE inside each page's <script>, so the suite tests the same functions
// that run in the browser. The long note on why it lives there and not here
// is in that file's header.

import { FUENTE_EMBEBIDA } from './panel-x402.mjs'

const NAV = `
<nav class="nav">
  <span class="brand">PyrusLLM</span>
  <a href="/">Chat</a>
  <a href="/node">My Node</a>
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
     model runs. With the model as the title, two cards from different
     operators looked practically identical -the model name is the same on
     both nodes- and the demo is exactly "I bought inference from the other
     machine." overflow-wrap is mandatory: modelIds have no spaces and were
     getting cut in half ("llama_3.2_1b_intruct_tool_calli"). */
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

  /* Replaces the bar at 0%: an empty bar with "0%" doesn't say whether the
     node is free or hung. The state gets named instead. */
  .state { font-size: .8rem; font-weight: 600; margin-top: .6rem; }
  .state.libre { color: #4ade80; }
  .state.busy { color: #fbbf24; }
  .state.full { color: #f87171; }

  /* The evidence line under the response: without this, the text shows up
     and nothing says it traveled P2P from another machine. It's the proof,
     not decoration. */
  .meta {
    display: flex; flex-wrap: wrap; gap: .25rem .75rem; margin-top: .5rem;
    font-size: .76rem; color: #8b93a7; font-family: ui-monospace, monospace;
  }
  .meta b { color: #4ade80; font-weight: 600; }

  /* DHT discovery takes ~17s measured. Without a loading state, that's 17
     seconds of empty screen in front of the judges, which reads as broken. */
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
  /* My Node's two gauges (Phase 6.5 and 6.6). They stack on narrow screens:
     they're two independent readings, not a side-by-side comparison that
     breaks when it loses width. */
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

  /* The external assistant's switch (Phase 8.5). Amber like the upstream
     badge: the same color in the panel, in the node list, and in the chat's
     provenance line, so "this leaves the network" only has to be learned
     once. */
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
  /* Green like 'online': a verified P2P peer is the good thing the demo
     shows off, it can't look like a mock. */
  .badge.peer { background: #10331f; color: #4ade80; }
  /* Amber, the rest of the UI's warning color: the external one works, but
     it's the only path where the prompt leaves the network and costs money.
     Neither the verified peer's green nor this machine's blue. */
  .badge.upstream { background: #3a2a10; color: #fbbf24; }
  /* Per-card actions. "Chat" stays first and in blue: it's the action that
     tells the demo's story on its own. "Connect" is secondary but it's what
     proves this is a real gateway and not a chat with extra steps. */
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
     as alternatives instead of a sequence -happened with the Open WebUI
     modal, where people ran them out of order-. */
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

  /* The external service's real status, not "let's assume it started." */
  .dot { display: inline-flex; align-items: center; gap: .45rem; font-size: .82rem; color: #8b93a7; }
  .dot i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; font-style: normal; }
  .dot.up { color: #4ade80 } .dot.up i { background: #4ade80 }
  .dot.down { color: #f87171 } .dot.down i { background: #f87171 }

  /* Warning ahead of the steps. WhatsApp doesn't link a bot, it links the
     operator's personal account: that has to be read before scanning the QR,
     not after, so it goes at the top and not at the bottom of the recipe. */
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

  /* Agent status, visible on all three pages: it's the condition that
     decides whether the network is reachable or not, so it can't live on
     just one screen. */
  .nav .agent { margin-left: auto; display: inline-flex; align-items: center; gap: .45rem; font-size: .8rem; }
  .nav .agent i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; display: block; flex: none; }
  .nav .agent b { font-weight: 600; }
  .nav .agent.offline { color: #8b93a7 }
  .nav .agent.launching { color: #fbbf24 } .nav .agent.launching i { background: #fbbf24 }
  .nav .agent.live { color: #4ade80 } .nav .agent.live i { background: #4ade80 }
  .nav .agent.error { color: #f87171 } .nav .agent.error i { background: #f87171 }

  /* ---------------------------------------------------------------- chat */
  /* 'chatpage' and not 'chat': a .chat class already exists on the Network
     panel (the old chat block) with margin-top, and the body inherited it. */
  body.chatpage { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  body.chatpage main {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    max-width: 780px; width: 100%; padding: 0 1.25rem;
  }
  /* The JS sets display:flex when showing it; the direction and flex-1 have
     to be here, or the thread and the composer end up side by side. */
  #chat { flex: 1; min-height: 0; flex-direction: column; }
  #thread { flex: 1; min-height: 0; overflow-y: auto; padding: 1.5rem 0 1rem; }

  /* The gate. The first thing seen while the agent is off. */
  .gate { max-width: 30rem; margin: auto; padding: 3rem 0; text-align: center; }
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

  /* The provenance line: who answered, how long it took. Without this the
     chat is indistinguishable from any other and the network stops being
     visible. */
  .prov {
    display: flex; flex-wrap: wrap; gap: .25rem .7rem; margin-top: .5rem;
    font-size: .74rem; color: #8b93a7; font-family: ui-monospace, monospace;
    align-items: center;
  }
  .prov .peer { color: #4ade80; font-weight: 600; }
  .prov .local { color: #7db8ff; font-weight: 600; }
  .prov .upstream { color: #fbbf24; font-weight: 600; }
  /* Cost isn't highlighted like the operator: it's data, not an alarm. It's
     told apart from latency without shouting. */
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

  /* Action palette (Ctrl+K). Lives in the chat and not in a separate panel
     because what it does -- switching models, clearing, checking spend --
     are decisions made WHILE writing, not before. */
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

  /* The mock marker is NOT decorative: the project requires that everything
     simulated be visible. A control that looks like it works and does
     nothing is worse than an absent one, because whoever uses it thinks
     they already configured it. */
  .pal-item .mock {
    font-size: .66rem; text-transform: uppercase; letter-spacing: .05em;
    background: #3a2f16; color: #e0b95a; border: 1px solid #5a4a20;
    padding: .1rem .4rem; border-radius: 4px;
  }
  .pal-item[disabled] { cursor: default; }
  .pal-item[disabled]:hover { background: transparent; }

  /* Switch and stepper: they're real-looking controls even though almost
     all of them are mocked, because the point of the request is to see the
     shape. */
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
     PHASE 9 — the four artifacts the phase emits, which until now could only
     be seen with curl. The HTML is built by qvac/panel-x402.mjs; here's how
     it looks.

     The three tones are the part that is NOT decoration, and that's why
     they're kept together:

       good    a fact verified RIGHT HERE (a recomputed hash that matches);
       warm    data with a caveat that needs reading -- an absence with a
               reason, a tx hash nobody verified against the chain, a
               signature this page doesn't check;
       bad     something that reads as proof and isn't: a mock, a hash that
               doesn't match, a synthetic tx, a settlement that failed.

     A mock painted green would be exactly the mock that looks functional
     that the project's rule prohibits.
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
  /* overflow-wrap mandatory: addresses, hashes, and signatures have no
     spaces and used to spill out of the card cut in half. */
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
  /* D25 — "measured" and "estimated" do NOT share a color. That's the whole
     rule: an SSE chunk count painted the same as a provider's usage is the
     cheapest way to turn an estimate into a fact. */
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
</style>`

// HTML escaping, injected into all 3 panels' script.
//
// Not manual-level paranoia: the price is written by the provider from their
// panel and shown raw in all three. A price like
// `<img src=x onerror=alert(1)>` used to execute when the page opened
// —tested—. EVERYTHING that comes from the server gets escaped, not just
// the price, because the day an operator name or a tag becomes editable the
// hole comes back on its own.
const ESC = `
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }`

// The nav chip lives on all THREE pages and paints itself. It's the only
// shared state, and it has to be: if the agent is off the network doesn't
// answer, and that has to be visible from wherever you're standing -- not
// just in the chat.
const AGENT_CHIP = `
<script>
  // ---------------------------------------------------------------------
  // The panel's credential.
  //
  // The gateway's gate stopped accepting requests without Authorization,
  // and the page isn't exempt: it requests its own and sends it like any
  // other client. A single authentication path, with no back door for the
  // browser.
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
// Live here and not inside a single page because "Connect" moved to My
// Node -- the credential authenticates against YOUR gateway, not against
// someone else's node -- and both still need copy/close/format.
const MODAL_JS = `
    // navigator.clipboard does NOT exist outside a secure context. The
    // panel opens over http://localhost (secure) but also over
    // http://192.168.x.x from another machine on the LAN, where the API
    // isn't there and the "Copy" button silently did nothing. Hence the
    // execCommand fallback.
    async function copiar(texto, btn) {
      let ok = false
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(texto)
          ok = true
        }
      } catch { /* cae al fallback */ }
      if (!ok) {
        const ta = document.createElement('textarea')
        ta.value = texto
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { ok = document.execCommand('copy') } catch { ok = false }
        document.body.removeChild(ta)
      }
      const antes = btn.textContent
      btn.textContent = ok ? 'Copied' : 'Copy by hand'
      setTimeout(() => { btn.textContent = antes }, 1600)
    }

    let estadoPoll = null

    function cerrarModal() {
      clearInterval(estadoPoll)
      estadoPoll = null
      document.getElementById('modal').innerHTML = ''
      document.removeEventListener('keydown', onEsc)
    }

    function onEsc(ev) { if (ev.key === 'Escape') cerrarModal() }

    // Simple modal for content that's already built. Panels that need one
    // with tabs and polling still write #modal by hand; this one is for the
    // common case -- a title and a body -- which used to force repeating
    // the overlay, the Esc close, and the click-outside close everywhere.
    function abrirModal(titulo, cuerpoHtml) {
      document.getElementById('modal').innerHTML =
        '<div class="modal-overlay" id="modal-overlay"><div class="modal">' +
        '<h3>' + esc(titulo) + '</h3>' + cuerpoHtml +
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
// The proof that this is a real OpenAI-compatible gateway and not a chat
// with our own protocol inside.
const CONNECT_JS = `
    function recetas(c) {
      const modelo = c.node.modelId

      // The provider block is identical across every OpenClaw channel -the
      // only thing that changes is which channel gets turned on-, so it
      // gets built once and each recipe passes it ITS OWN channels block.
      // Duplicating the whole config per channel guaranteed one would end
      // up out of date.
      const configOpenclaw = (canal) => [
        '{',
        '  models: {',
        '    providers: {',
        '      qvac: {',
        '        baseUrl: "' + c.baseUrl + '",',
        '        apiKey: "' + c.apiKey + '",',
        '        api: "openai-completions",',
        '        models: [{ id: "' + modelo + '", name: "QVAC · P2P network" }]',
        '      }',
        '    }',
        '  },',
        '  agents: { defaults: { model: "qvac/' + modelo + '" } },',
        '  channels: {',
        canal,
        '  }',
        '}'
      ].join('\\n')

      const proveedorQvac = configOpenclaw([
        '    telegram: {',
        '      enabled: true,',
        '      botToken: "PASTE_THE_BOTFATHER_TOKEN_HERE",',
        '      dmPolicy: "pairing"',
        '    }'
      ].join('\\n'))

      const proveedorWhatsapp = configOpenclaw([
        '    whatsapp: {',
        '      enabled: true,',
        '      dmPolicy: "pairing",',
        '      allowFrom: ["+549XXXXXXXXXX"]',
        '    }'
      ].join('\\n'))

      return {
        telegram: {
          titulo: 'Telegram',
          pie: 'OpenClaw is a self-hosted agent runtime. You write to the bot from your phone and the response is generated by this node — no OpenAI or third-party server in between.',
          pasos: [
            { texto: 'Install OpenClaw.', cmd: 'npm install -g openclaw' },
            { texto: 'On Telegram, talk to <b>@BotFather</b>, send <b>/newbot</b>, and save the token it gives you (it looks like <code>123:abc</code>).' },
            { texto: 'Paste this into <code>~/.openclaw/openclaw.json</code>, replacing the token from step 2:', cmd: proveedorQvac },
            { texto: 'Start the gateway and approve the pairing. The code is valid for 1 hour.', cmd: 'openclaw gateway\\nopenclaw pairing list telegram\\nopenclaw pairing approve telegram <CODE>' }
          ]
        },
        whatsapp: {
          titulo: 'WhatsApp',
          aviso: '<b>It is not a bot.</b> WhatsApp has no @BotFather: OpenClaw links <b>your personal account</b> as one more device (same as WhatsApp Web). Use a number you can dedicate to this and leave <code>dmPolicy: "pairing"</code> so nobody writes to the node without you approving it.',
          pie: 'Same gateway as Telegram, another channel. The response is generated by this node: WhatsApp only carries the text.',
          estado: {
            url: 'http://127.0.0.1:18789/',
            up: 'The OpenClaw gateway is responding on 127.0.0.1:18789',
            down: 'The OpenClaw gateway is not responding yet'
          },
          pasos: [
            { texto: 'Install OpenClaw and the channel plugin.', cmd: 'npm install -g openclaw\\nopenclaw plugins install clawhub:@openclaw/whatsapp' },
            { texto: 'Paste this into <code>~/.openclaw/openclaw.json</code>, with your number in international format (<code>+549…</code>) in <code>allowFrom</code>:', cmd: proveedorWhatsapp },
            { texto: 'Link the account: the command prints a <b>QR in the terminal</b>. On your phone: <b>WhatsApp → Settings → Linked devices → Link a device</b> and scan it. The QR lasts ~60s; if it expires, repeat the command.', cmd: 'openclaw channels login --channel whatsapp' },
            { texto: 'Start the gateway and approve the first message. The request is valid for 1 hour.', cmd: 'openclaw gateway\\nopenclaw pairing list whatsapp\\nopenclaw pairing approve whatsapp <CODE>' },
            { texto: 'The status light above only says whether the gateway is alive. This command confirms whether WhatsApp actually got <b>linked</b>, and it is the first thing to check if the response does not arrive — before the node log.', cmd: 'openclaw channels status --probe' }
          ]
        },
        terminal: {
          titulo: 'Terminal',
          pie: 'Exact OpenAI shape. If this curl works, any compatible client works.',
          pasos: [
            { texto: 'Ask the node for a streamed response:', cmd: 'curl ' + c.baseUrl + '/chat/completions \\\\\\n  -H "Authorization: Bearer ' + c.apiKey + '" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"model":"' + modelo + '","messages":[{"role":"user","content":"hello"}],"stream":true}\\'' },
            { texto: 'And the network\\'s model catalog, same as OpenAI\\'s API:', cmd: 'curl ' + c.baseUrl + '/models -H "Authorization: Bearer ' + c.apiKey + '"' }
          ]
        },
        hermes: {
          titulo: 'Hermes Agent',
          pie: 'Agent with persistent memory (local SQLite, no external service). There is no code of ours here: it is your own configuration.',
          pasos: [
            { texto: 'Paste this into <code>~/.hermes/config.yaml</code>:', cmd: 'model:\\n  provider: custom\\n  base_url: ' + c.baseUrl + '\\n  api_key: ' + c.apiKey + '\\n  default: ' + modelo },
            { texto: 'Start Hermes. Use simple chat, no tool calls.', cmd: 'hermes' }
          ]
        },
        webui: {
          titulo: 'Open WebUI',
          pie: 'A ChatGPT-like face, self-hosted, pointed at this node. Needs Docker Desktop running.',
          estado: {
            url: 'http://localhost:3000/',
            up: 'Open WebUI is responding on localhost:3000',
            down: 'Open WebUI is not responding yet'
          },
          pasos: [
            { texto: 'Bring up the container pointed at this gateway:', cmd: 'docker run -d -p 3000:8080 \\\\\\n  -e OPENAI_API_BASE_URL=' + c.baseUrl + ' \\\\\\n  -e OPENAI_API_KEY=' + c.apiKey + ' \\\\\\n  -v open-webui:/app/backend/data \\\\\\n  --name open-webui ghcr.io/open-webui/open-webui:main' },
            { texto: 'Open <a href="http://localhost:3000" target="_blank" rel="noopener">localhost:3000</a> and pick the <code>' + modelo + '</code> model.' }
          ]
        }
      }
    }

    // The service runs on ANOTHER origin, so a normal fetch gets CORS'd even
    // when it's up. With mode:no-cors the response is opaque -can't be
    // read- but the promise resolves if the port answers and rejects if it
    // doesn't: enough for "is it up or not," which is the only thing being
    // asked.
    //
    // The only thing. Holds for Open WebUI and for OpenClaw's gateway alike,
    // and hence the status light's honest limit: it says the process
    // answers, NOT that WhatsApp got linked. Only 'channels status' knows
    // that, and it's a command, not a port. Painting "linked" from here
    // would mean inventing a state the panel can't see.
    async function servicioArriba(url) {
      try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store' })
        return true
      } catch {
        return false
      }
    }

    function pintarEstado(e, arriba) {
      const el = document.getElementById('estado-dot')
      if (!el) return
      el.className = 'dot ' + (arriba ? 'up' : 'down')
      el.innerHTML = '<i></i>' + (arriba ? e.up : e.down)
    }

    function pintarTab(rs, clave) {
      document.querySelectorAll('.tabs button').forEach(b => {
        b.classList.toggle('on', b.dataset.tab === clave)
      })
      const r = rs[clave]
      const cuerpo = document.getElementById('tab-body')
      cuerpo.innerHTML =
        (r.aviso ? '<p class="aviso">' + r.aviso + '</p>' : '') +
        (r.estado ? '<p><span class="dot" id="estado-dot"><i></i>checking…</span></p>' : '') +
        r.pasos.map((p, i) => \`
          <div class="step">
            <div class="n">\${i + 1}</div>
            <div class="body">
              <p>\${p.texto}</p>
              \${p.cmd ? '<div class="cmd"><pre>' + esc(p.cmd) + '</pre><button data-copy="' + i + '">Copy</button></div>' : ''}
            </div>
          </div>\`).join('') +
        '<p class="sub" style="margin:1rem 0 0">' + r.pie + '</p>'

      cuerpo.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => copiar(r.pasos[Number(btn.dataset.copy)].cmd, btn))
      })

      clearInterval(estadoPoll)
      estadoPoll = null
      if (r.estado) {
        const e = r.estado
        const chequear = () => servicioArriba(e.url).then(arriba => pintarEstado(e, arriba))
        chequear()
        estadoPoll = setInterval(chequear, 3000)
      }
    }

    // Takes YOUR local node, not another node's id.
    //
    // This used to hit /v1/connection/:id and issue a credential "for
    // talking to such-and-such provider," which was the wrong idea: the key
    // authenticates against your own gateway, and it's the one that later
    // decides which node to route to. A key per remote node suggested a
    // privileged path that doesn't exist.
    async function abrirConexion(nodo, apiKey) {
      let c
      try {
        c = {
          apiKey: apiKey,
          // The host is given by the browser, not a constant: if you came in
          // through the LAN's IP, the command you copy has to point there
          // and not at 127.0.0.1, which on the client's machine is a
          // different thing.
          baseUrl: 'http://' + location.host + '/v1',
          node: nodo
        }
      } catch (err) {
        alert('Could not build the connection: ' + (err && err.message ? err.message : err))
        return
      }

      const rs = recetas(c)
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
        b.addEventListener('click', () => pintarTab(rs, b.dataset.tab))
      })
      document.getElementById('cerrar-modal').addEventListener('click', cerrarModal)
      // Closes by clicking the background, but NOT when the click starts
      // inside the panel: without the target check, selecting a command's
      // text and releasing the mouse outside would close the modal.
      document.getElementById('modal-overlay').addEventListener('click', ev => {
        if (ev.target.id === 'modal-overlay') cerrarModal()
      })
      document.addEventListener('keydown', onEsc)

      pintarTab(rs, 'telegram')
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

    // Three node classes, and the difference matters too much to paper over
    // with a boolean: 'peer' is a genuinely REMOTE node, discovered by the
    // swarm with its signed manifest verified. It used to fall into the same
    // 'simulated' bucket as the mocks -- exactly backwards from reality.
    // A local upstream is named for what it is -- an engine on this machine
    // that's spoken to over HTTP -- not for how it's asked.
    function etiquetaDe (n) {
      if (n.local) return 'local engine · this machine'
      return KIND_LABEL[n.kind] || esc(n.kind)
    }

    const KIND_LABEL = {
      real: 'this machine',
      peer: 'verified P2P peer',
      mock: 'simulated',
      // The kind that sends the prompt OUTSIDE the network: to a third
      // party's API, on the operator's account. The label says so with no
      // euphemism because it's the one that bounds the privacy promise.
      //
      // NOTE: not every upstream is a third party. A llama-server or a NIM
      // on localhost also comes in over HTTP and is also kind 'upstream',
      // but the prompt doesn't leave the machine. That case is split off by
      // n.local in etiquetaDe(); this entry is just the default.
      upstream: 'external API · third party',
      // Comes from the Hyperbee directory: its manifest verified at some
      // point, but there's no socket now. Never a routing candidate (see
      // store.mjs).
      known: 'known · disconnected'
    }
${ESC}

    function barColor(pct) {
      return pct < 50 ? '#4ade80' : pct < 80 ? '#fbbf24' : '#f87171'
    }

    // The grid gets BUILT once and afterward only the numbers get updated.
    //
    // It used to innerHTML the whole grid on every poll (every 3s): the
    // cards were destroyed and recreated nonstop, so a click that landed
    // right at that moment got lost -Playwright couldn't even click a
    // card: "element was detached from the DOM"-. It also reset the bars'
    // CSS transition every time around.
    let gridKey = null

    function buildGrid(nodes) {
      document.getElementById('grid').innerHTML = nodes.map(n => \`
        <div class="card" data-id="\${esc(n.id)}">
          <span class="badge \${n.local ? 'real' : esc(n.kind)}">\${etiquetaDe(n)}</span>
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
      // Looking at the marketplace and picking a machine to talk to is the
      // path that was missing: until now the chat only let you name a
      // MODEL, and two peers serving the same one collapsed into one
      // option. The pin travels via sessionStorage because it's a choice
      // for this session, not a preference meant to outlive the browser.
      document.querySelectorAll('[data-usar]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          try { sessionStorage.setItem('pyrus.pin', el.dataset.usar) } catch (e) { /* private mode */ }
          window.location.href = '/'
        })
      })

      // "Connect" moved to /node because the credential authenticates
      // against YOUR gateway and not against the other node the card shows.
      document.querySelectorAll('[data-files]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          abrirArchivos(el.dataset.files)
        })
      })
    }

    // Discovery's loading state. Measured: the first peer takes ~17s to
    // show up via the DHT. Without this it's 17 seconds of empty grid in
    // front of the judges, which reads not as "searching" but as "broken."
    const abiertoEn = Date.now()
    let buscando = false

    function renderBuscando() {
      if (buscando) return
      buscando = true
      const seg = () => Math.round((Date.now() - abiertoEn) / 1000)
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
        return renderBuscando()
      }
      if (buscando) {
        buscando = false
        clearInterval(window.__segTimer)
        document.getElementById('buscando').style.display = 'none'
      }

      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))

      // Only nodes' identity justifies rebuilding the DOM; price and load
      // change often and get updated in place.
      const key = nodes.map(n => n.id + '|' + n.displayName + '|' + n.operator + '|' + n.tags.join('/')).join(',')
      if (key !== gridKey) {
        gridKey = key
        buildGrid(nodes)
      }

      for (const n of nodes) {
        const card = document.querySelector('.card[data-id="' + CSS.escape(n.id) + '"]')
        if (!card) continue

        // The price is split into amount (large) and unit (small). Built
        // with DOM nodes and textContent and NOT with innerHTML: the price
        // is written by the provider from their own panel, and it's already
        // proven that an <img src=x onerror> in there executes when the
        // page opens.
        const precio = card.querySelector('[data-price]')
        precio.textContent = ''
        const corte = String(n.pricing).indexOf(' / ')
        const monto = document.createElement('b')
        const unidad = document.createElement('span')
        monto.textContent = corte === -1 ? n.pricing : String(n.pricing).slice(0, corte)
        unidad.textContent = corte === -1 ? '' : String(n.pricing).slice(corte + 3)
        precio.appendChild(monto)
        precio.appendChild(unidad)

        // One or the other gets shown, without recreating DOM nodes: that
        // way the bar's CSS transition actually animates instead of
        // resetting on every poll.
        const load = card.querySelector('[data-load]')
        const offline = card.querySelector('[data-offline]')
        const estado = card.querySelector('[data-state]')
        const caido = n.loadPct === null
        offline.style.display = caido ? '' : 'none'
        estado.style.display = caido ? 'none' : ''

        // The bar only shows up when there's real load. At 0% it was an
        // empty bar with a "0%" next to it that didn't tell "free" apart
        // from "hung"; the state is now said in words.
        load.style.display = !caido && n.loadPct > 0 ? '' : 'none'
        if (!caido) {
          // Three states, not two: a node with 1 of 4 slots taken is NOT
          // "busy" -it still accepts work-, and saying so discourages the
          // buyer on the one screen where they choose. "Busy" is reserved
          // for one that genuinely has no room.
          const activos = n.activeRequests
          const tope = n.maxConcurrentRequests
          const lleno = activos >= tope
          const ocupado = activos > 0
          estado.className = 'state ' + (lleno ? 'full' : ocupado ? 'busy' : 'libre')
          estado.textContent = lleno
            ? 'At capacity · ' + activos + '/' + tope
            : ocupado
              ? 'Serving · ' + activos + '/' + tope
              : 'Available'
          if (ocupado) {
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
    // The proof that this is a real OpenAI-compatible gateway and not a chat
    // with our own protocol inside: the command copied here is the same one
    // any third-party client would use, with no privileged path.
    // -----------------------------------------------------------------------

${MODAL_JS}

    async function abrirArchivos(id) {
      try {
        // The local node (kind 'real'/'mock') has no peerKey: that one is
        // ITS OWN drive. A 'peer' node does have one, and without passing it
        // the gateway always returned the local drive, no matter which card
        // had been clicked.
        const nodo = nodesById[id]
        const peerKey = nodo && nodo.peerKey
        const url = peerKey ? '/v1/files?peerKey=' + encodeURIComponent(peerKey) : '/v1/files'
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const data = await r.json()

        // Shows the chosen node's drive, with a qvac:// link that can be
        // pasted on another machine to download it with no prior P2P
        // connection.
        const archivos = data.files || []
        const modal = document.getElementById('modal')
        modal.innerHTML = \`
          <div class="modal-overlay" id="modal-overlay">
            <div class="modal">
              <h3>Files on \${esc(nodo ? nodo.operator : 'this node')}</h3>
              <p class="sub"><code>qvac://</code> links can be copied and pasted on another machine to download without pairing first.</p>
              \${archivos.length === 0
                ? '<p class="muted">No files published.</p>'
                : '<table><thead><tr><th>Name</th><th>Size</th><th>Link</th></tr></thead><tbody>' +
                  archivos.map(f => \`
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
          btn.addEventListener('click', () => copiar(btn.dataset.copyFile, btn))
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


    // The poll overwrites the whole grid, so if it fails it can't take down
    // the panel.
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
    let shellFor = null // which node #detail's DOM is currently built for
    let isMine = false  // is the chosen node THIS gateway? (only then can it be re-signed)
    let swarmActive = false
    let catalogById = {} // alias -> {displayName, sizeGB, fits}, from /v1/swarm/manifest
${ESC}
${FUENTE_EMBEBIDA}
${MODAL_JS}
${CONNECT_JS}

    // -------------------------------------------------------------------
    // Onboarding: shows up only if this gateway hasn't joined the swarm yet.
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
    // Chosen node's detail. Built ONCE per node and afterward only the
    // texts that change get updated -- see the old note further down for
    // why (the price input was losing what the user had typed).
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
      mineFieldsBuiltFor = null // also forces the "mine-fields" block to rebuild
    }

    // Fields that only make sense on YOUR OWN P2P node -- editing them
    // means re-signing the manifest with your identity, something that
    // can't be done on someone else's node. Built separately from
    // buildShell() because "is mine" can change without the chosen node
    // changing (e.g. you just started --swarm).
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

      // The one thing the user edits: only overwritten if they're NOT
      // currently touching it.
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
    // /v1/swarm/manifest -> models[].fits). Changing model goes through a
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
        'Change this node\\'s model to "' + (info ? info.displayName : nextAlias) + '".\\n\\n' +
        'It can take several seconds -or fail for lack of memory- while the ' +
        'node keeps responding with the current model. If it fails, the current model stays.'
      )
      if (!proceed) { e.target.value = n.modelId; return }

      const r = await fetch('/v1/swarm/manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: nextAlias })
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        alert((data.error && data.error.message) || 'could not change the model')
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
      const { nodes: todos, swarm } = await r.json()

      // This page is ONLY about your machine. It used to list the whole
      // network and start on todos[0], which is usually a remote peer: the
      // panel said "Your node" and showed someone else's, with a price
      // field and a save button next to it that could do nothing to a third
      // party's signed manifest. Other nodes are viewed at /network.
      const nodes = todos.filter(n => n.kind === 'real')
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      if (!current || !nodesById[current]) current = nodes[0]?.id

      // A dropdown with a single option is noise: there's almost always just
      // one local node, and the selector only shows up if there's actually
      // something to choose.
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

      // The <select> only repaints if the node list changed. Repainting it
      // on every poll used to close the dropdown if you had it open.
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

      // Without the blur, the input keeps focus and the refresh below
      // doesn't update it: it would keep showing what was typed even if the
      // server trimmed it, and there'd be no way to see it actually saved.
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
    // Credentials. Several on purpose: one per client, so a bot can be cut
    // off without touching the rest, and so the trail knows which one
    // requested what.
    // ------------------------------------------------------------------
    let keys = []

    function edad(ts) {
      if (!ts) return 'never'
      const s = Math.round((Date.now() - ts) / 1000)
      if (s < 60) return s + 's ago'
      if (s < 3600) return Math.round(s / 60) + 'm ago'
      if (s < 86400) return Math.round(s / 3600) + 'h ago'
      return Math.round(s / 86400) + 'd ago'
    }

    function pintarKeys() {
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
            '<td class="muted">' + edad(k.lastUsedAt) + '</td>' +
            '<td style="white-space:nowrap">' +
              '<button class="ghost" data-copy-key="' + esc(k.key) + '" style="font-size:.75rem;margin:0">Copy</button> ' +
              '<button class="ghost" data-connect-key="' + esc(k.key) + '" style="font-size:.75rem;margin:0">Connect</button> ' +
              '<button class="danger" data-revoke="' + esc(k.id) + '" style="font-size:.75rem;margin:0">Revoke</button>' +
            '</td></tr>'
        }).join('') + '</tbody></table>'

      box.querySelectorAll('[data-copy-key]').forEach(function (b) {
        b.addEventListener('click', function () { copiar(b.dataset.copyKey, b) })
      })
      box.querySelectorAll('[data-connect-key]').forEach(function (b) {
        b.addEventListener('click', function () {
          const n = nodesById[current]
          if (!n) return alert('This gateway is not serving any model yet.')
          abrirConexion(n, b.dataset.connectKey)
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
            pintarKeys()
          } catch (err) {
            alert('Could not revoke: ' + ((err && err.message) || err))
            b.disabled = false
          }
        })
      })
    }

    async function cargarKeys() {
      try {
        const r = await authFetch('/v1/keys')
        const d = await r.json()
        keys = d.keys || []
        pintarKeys()
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
        await cargarKeys()
      } catch (err) {
        alert('Could not create the key: ' + ((err && err.message) || err))
      }
    })

    document.getElementById('revoke-all').addEventListener('click', async function (e) {
      // The number goes in the question: saying "revoke the current key"
      // when there are five issued is lying to whoever's about to click.
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
        // rest, and without this the page would be left unable to talk to
        // the gateway.
        window.__panelKey = null
        pintarKeys()
      } catch (err) {
        alert('Could not revoke: ' + ((err && err.message) || err))
      }
      btn.disabled = false
    })

    // ------------------------------------------------------------------
    // Traffic. Both directions come from the SAME trail, split by kind:
    // 'served' is what this node produced for a peer (written by
    // provider.mjs) and 'route' is what this node asked someone else for.
    // ------------------------------------------------------------------
    let flow = 'in'

    function filaFlujo(e) {
      const hora = esc(new Date(e.ts).toLocaleTimeString())
      const quien = esc(e.operator || 'unknown')
      const bits = []
      if (e.tokens) bits.push(e.tokens + ' tok')
      if (e.ttftMs !== null && e.ttftMs !== undefined) bits.push('ttft ' + e.ttftMs + 'ms')
      if (e.tokensPerSec) bits.push(e.tokensPerSec + ' tok/s')
      bits.push(e.ms + 'ms')
      const fallo = e.ok === false ? ' <b style="color:#f87171">FAILED</b>' : ''
      // PHASE 9 / D25 \u2014 the split goes in its own column with its
      // provenance attached. Adding prefill and decode into the "tok"
      // column next to it would mix them back together, which is exactly
      // what D25 split apart; and without the provenance, an SSE chunk
      // count reads the same as a provider's usage.
      //
      // D27 alongside: without finishReason, in the trail a client cutoff
      // and a complete response look identical.
      const conteo = htmlDeConteo(vistaDeConteo(e))
      const fin = e.finishReason
        ? '<div class="x-nota" style="margin:.2rem 0 0">' +
          esc(e.finishReason) + ' \u2014 ' + esc(textoDeFinishReason(e.finishReason)) + '</div>'
        : ''
      return '<tr><td class="muted">' + hora + '</td><td>' + quien + '</td>' +
        '<td class="muted">' + esc(e.modelId || '') + '</td>' +
        '<td class="muted">' + esc(bits.join(' \u00b7 ')) + fallo + '</td>' +
        '<td>' + conteo + fin + '</td></tr>'
    }

    function pintarFlujo(log) {
      const entradas = flow === 'in'
        ? log.filter(e => e.kind === 'served')
        // What gets routed to your own machine isn't a transaction with
        // anyone: without this filter, "what we asked others for" would
        // fill up with our own node.
        : log.filter(e => e.kind === 'route' && e.target && e.target !== 'local')

      const box = document.getElementById('flow-body')
      if (!entradas.length) {
        box.innerHTML = '<p class="hint" style="margin:1rem 0 0">' + (flow === 'in'
          ? 'Nobody has asked this machine for inference yet.'
          : 'This machine has not consumed another node yet.') + '</p>'
        return
      }

      const tokens = entradas.reduce((a, e) => a + (e.tokens || 0), 0)
      box.innerHTML =
        '<p class="hint" style="margin:.9rem 0 .2rem">' + entradas.length +
        (entradas.length === 1 ? ' request' : ' requests') + ' \u00b7 ' + tokens + ' tokens</p>' +
        '<table><thead><tr><th>Time</th><th>' +
        (flow === 'in' ? 'Asked by' : 'Answered by') +
        '</th><th>Model</th><th></th><th>prefill / decode (D25)</th></tr></thead><tbody>' +
        entradas.map(filaFlujo).join('') + '</tbody></table>' +
        '<p class="x-nota">D25 records the two dimensions separately because they don\\'t scale ' +
        'the same way: prefill processes the prompt in parallel and is bound by compute, decode ' +
        'generates token by token and is bound by memory bandwidth. Pricing is still ' +
        'flat (D22): this gets recorded so a decision can be made with data, not to charge for it today.</p>'
    }

    document.querySelectorAll('#flow-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        flow = b.dataset.flow
        document.querySelectorAll('#flow-tabs button').forEach(x => {
          x.classList.toggle('on', x.dataset.flow === flow)
        })
        refrescarFlujo()
      })
    })

    async function refrescarFlujo() {
      try {
        const r = await authFetch('/v1/routing-log')
        const { log } = await r.json()
        pintarFlujo(log || [])
      } catch (e) { /* the next poll retries */ }
    }

    // -------------------------------------------------------------------
    // PHASE 9 — a charged request's receipt and attestation.
    //
    // Uses a PLAIN fetch and not authFetch, and it isn't an oversight: the
    // GET /v1/receipts/:id route is the only one in the system that does
    // NOT require a credential, on purpose. Whoever paid via 402 has none --
    // that's the whole point of the 402 --, so requiring one to see their
    // own receipt would leave them unable to audit exactly what they paid
    // for. Sending the panel's key here would also hide that property
    // behind a header that isn't needed.
    //
    // There's no route that LISTS receipts and none gets invented: Phase 9
    // is closed and adding surface area to it reopens it. It's looked up by
    // id, which is what comes back with the response.
    // -------------------------------------------------------------------
    async function verRecibo() {
      const box = document.getElementById('recibo-box')
      const id = document.getElementById('recibo-id').value.trim()
      if (!id) {
        box.innerHTML = '<p class="hint">Missing the completion id.</p>'
        return
      }
      // Empty means ABSENT, not an empty string: the hash of "" is a valid
      // hash, and comparing it against the declared one would say "does NOT
      // match" when the truth is there's nothing to compare against. Two
      // different states, and the view tells them apart.
      const texto = document.getElementById('recibo-texto').value
      const ctx = texto.length ? { textoRecibido: texto } : {}

      box.innerHTML = '<p class="hint">Looking it up…</p>'
      try {
        const r = await fetch('/v1/receipts/' + encodeURIComponent(id))
        if (r.status === 404) {
          box.innerHTML =
            '<div class="x402"><div class="x-aviso tibio">No receipt for that id. ' +
            'Receipts live in the process\\'s memory and the last 200 are kept: ' +
            'this is not a ledger, the real ledger is the chain. A restart clears them.' +
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
      verRecibo().catch(() => {})
    })
    document.getElementById('recibo-id').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') verRecibo().catch(() => {})
    })

    // -------------------------------------------------------------------
    // The two gauges (Phase 6.5 and 6.6). Requested together because they're
    // the same question seen from both sides, but they come from different
    // endpoints on purpose: /v1/quota is kept by the provider and /v1/budget
    // by the gateway.
    //
    // Each one fails on its own. If the node isn't serving yet there's no
    // quota to show, and that has no reason to blank out the spend.
    // -------------------------------------------------------------------
    function miles(n) {
      return Number(n || 0).toLocaleString('en-US')
    }

    async function refrescarCuota() {
      try {
        const r = await authFetch('/v1/quota')
        if (!r.ok) return
        const q = await r.json()

        document.getElementById('q-given').textContent = miles(q.given_tokens) + ' tokens'
        document.getElementById('q-window').textContent =
          miles(q.quota_tokens) + ' output tokens per peer, per ' + q.window_hours + ' h — ' +
          'a sliding window, so it tops back up on its own'

        const box = document.getElementById('q-peers')
        if (!q.peers.length) {
          box.innerHTML = '<p class="hint">No peer has asked this node for anything yet.</p>'
          return
        }
        box.innerHTML = q.peers.map((p) => \`
          <div class="econ-row">
            <code>\${esc(p.peer)}</code>
            <span>\${miles(p.used)} used · \${miles(p.remaining)} left</span>
          </div>
        \`).join('')
      } catch (e) { /* the next poll retries */ }
    }

    async function refrescarGasto() {
      try {
        const r = await authFetch('/v1/budget')
        if (!r.ok) return
        const b = await r.json()

        // B13 — there are TWO caps and whichever cuts things off could be
        // either one. The LESSER of the two remainders gets shown, because
        // that's the one that rules: with the account's at USD 20 and the
        // node's at USD 2, saying "you have 20 left" promises nineteen that
        // don't exist.
        const nodo = b.node || {}
        const nodoManda =
          nodo.remaining_micros !== undefined && nodo.remaining_micros < b.remaining_micros
        const restante = nodoManda ? nodo.remaining : b.remaining
        document.getElementById('b-remaining').textContent = restante + ' left'

        // The percentage is calculated against the cap, not against what's
        // left: with the cap at zero there's no division by zero and no bar
        // stuck at 100%.
        const capMicros = nodoManda ? nodo.cap_micros : b.cap_micros
        const spentMicros = nodoManda ? nodo.spent_micros : b.spent_micros
        const usado = capMicros > 0 ? (spentMicros / capMicros) * 100 : 0
        document.getElementById('b-bar').style.width = Math.min(100, usado).toFixed(1) + '%'

        document.getElementById('b-detail').textContent =
          (nodoManda ? nodo.spent + ' spent of ' + nodo.cap + ' on this machine' : b.spent + ' spent of ' + b.cap + ' by this client') +
          ' this period (' + b.period + ')' +
          (b.reserved_micros > 0 ? ' · ' + b.reserved + ' committed to requests in flight' : '') +
          (nodoManda
            ? ' · your client cap is ' + b.cap + ', but the machine total is what cuts first'
            : nodo.cap
              ? ' · machine total: ' + nodo.spent + ' of ' + nodo.cap
              : '')
      } catch (e) { /* the next poll retries */ }
    }

    // -------------------------------------------------------------------
    // The external assistant and its switch (Phase 8.5).
    //
    // The endpoint to turn it on had existed from the start and could only
    // be used with curl. The case that motivated it is "the network got
    // saturated mid-demo," and at that moment nobody opens a terminal.
    //
    // The button says what's about to HAPPEN, not the state it's in: "Turn
    // on" when it's off. A button that says "On" while also being on gives
    // no way to tell whether it's a state or an action, and this one in
    // particular decides whether someone's prompt leaves the machine.
    // -------------------------------------------------------------------
    // PHASE 7 — the payout address. There being NO wallet is a normal state
    // and it's stated as such: a node that only consumes doesn't need one.
    // What can't happen is for it to read like something's broken.
    async function refrescarWallet() {
      const estado = document.getElementById('wallet-estado')
      if (!estado) return
      try {
        const r = await authFetch('/v1/wallet')
        if (!r.ok) return
        const w = await r.json()

        if (!w.configurada) {
          estado.innerHTML =
            '<p class="hint">This node has no wallet yet, so its manifest announces ' +
            '<code>economic</code> as a marked mock &mdash; it declares no payment address. ' +
            'That is fine for a node that only consumes.</p>' +
            '<p class="hint">To create one: <code>pyrusllm wallet --crear</code>. It prints ' +
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
        /* no gateway: the rest of the page already says so */
      }
    }

    async function refrescarUpstream() {
      try {
        const r = await authFetch('/v1/upstream')
        if (!r.ok) return
        const u = await r.json()

        const card = document.getElementById('up-card')
        const sw = document.getElementById('up-switch')
        const estado = document.getElementById('up-estado')

        // With no upstream configured, the switch has nothing to turn on:
        // it explains how to configure one instead of offering a button
        // that would do nothing.
        if (!u.upstreams.length) {
          sw.style.display = 'none'
          estado.innerHTML = '<p class="hint">No external assistant is configured. ' +
            'Copy <code>upstreams.example.json</code> to your storage directory as ' +
            '<code>upstreams.json</code> and restart the node.</p>'
          return
        }

        estado.innerHTML = u.upstreams.map(function (m) {
          // The credential is the one thing that can be missing and still
          // look like everything else: the model shows up in the list,
          // with a name and a price, and it just never answers. It states
          // which environment variable is missing, not "error."
          var cred = m.credencial
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
      const encender = boton.dataset.next === 'true'
      boton.disabled = true
      try {
        await authFetch('/v1/upstream/opt-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: encender })
        })
      } catch (e) { /* the refresh below shows whatever state it ended up in */ }
      boton.disabled = false
      refrescarUpstream()
    })

    function refrescarEconomia() {
      refrescarCuota()
      refrescarGasto()
      refrescarUpstream()
      refrescarWallet()
    }

    cargarKeys()
    refrescarFlujo()
    setInterval(refrescarFlujo, 3000)

    // Slower than the rest: these two numbers move one request at a time,
    // not one token at a time. Polling every 2.5s would mean asking the
    // gateway to walk the ledger to say the same thing four times in a row.
    refrescarEconomia()
    setInterval(refrescarEconomia, 8000)

    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 2500)
  </script>
  `
)

export const ADMIN_HTML = page(
  'PyrusLLM · Admin',
  `
  <h1>Admin panel</h1>
  <p class="sub">Every node on the network and the gateway's routing log.</p>

  <table>
    <thead>
      <tr><th>Node</th><th>Operator</th><th>Type</th><th>Status</th><th>Load</th><th>Price</th><th></th></tr>
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
          btn.disabled = true // the poll repaints the table: prevents double-clicks
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

    // The trail stopped being routing-only: it now carries model_load and
    // the swarm's two D7 events, which have neither a modelId nor a
    // destination node. Painting them with the old template showed
    // "undefined → undefined (undefinedms)".
    const linea = (e) => {
      const hora = esc(new Date(e.ts).toLocaleTimeString())
      const detalle = \`<span class="muted">\${esc(e.reason || '')}</span>\`

      if (e.kind && e.kind !== 'route') {
        return \`<div>\${hora} — <b>\${esc(e.kind)}</b> \${detalle}</div>\`
      }

      // The demo's three numbers. Only shown if they exist: a request that
      // failed before the first token has no tok/s, and a "0 tok/s" there
      // would be a made-up measurement.
      const metricas = []
      if (e.tokens) metricas.push(esc(e.tokens) + ' tok')
      if (e.ttftMs !== null && e.ttftMs !== undefined) metricas.push('ttft ' + esc(e.ttftMs) + 'ms')
      if (e.tokensPerSec) metricas.push(esc(e.tokensPerSec) + ' tok/s')
      metricas.push(esc(e.ms) + 'ms')

      const destino = e.target ? \` <b>[\${esc(e.target)}]</b>\` : ''
      const fallo = e.ok === false ? \` <b>FAILED\${e.code ? ' ' + esc(e.code) : ''}</b>\` : ''

      // PHASE 9 / D25 and D27. The split goes with its provenance and isn't
      // added into "metricas": stuffed in there it would be one more number
      // next to the tok/s, and the difference between a measured token and
      // a counted SSE chunk gets lost exactly on that line.
      const conteo = ' ' + htmlDeConteo(vistaDeConteo(e))
      const fin = e.finishReason
        ? \` <span class="muted">\${esc(e.finishReason)} — \${esc(textoDeFinishReason(e.finishReason))}</span>\`
        : ''

      return \`<div>\${hora} — \${esc(e.modelId)}\${destino} → \${esc(e.operator)}\` +
        \` (\${metricas.join(' · ')})\${conteo}\${fin}\${fallo} \${detalle}</div>\`
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
// El chat. Es la pantalla que abre la app: preguntar primero, y la topologia
// de la red -que nodo, que precio- como algo que se mira despues y no como el
// paso previo obligatorio a poder escribir un prompt.
// ---------------------------------------------------------------------------

// String.raw: adentro viven regex con backslashes y, sin esto, el template
// literal se los come al evaluar pages.mjs -- /\*\*/ llegaria al browser
// como /**/. No lleva backticks ni interpolaciones justamente por eso.
const CHAT_JS = String.raw`
    var msgs = []
    var nodes = []
    var streaming = false
    var ctrl = null
    var userPicked = false
    var skipped = sessionStorage.getItem('pyrus.skipGate') === '1'

    // Backticks y sentinelas armados en runtime: este script viaja adentro de
    // un template literal de pages.mjs, y un backtick suelto lo cierra al medio.
    var BT = String.fromCharCode(96)
    var S = String.fromCharCode(1)
    var fenceRe = new RegExp(BT + BT + BT + '(\w*)\n?([\s\S]*?)' + BT + BT + BT, 'g')
    var codeRe = new RegExp(BT + '([^' + BT + '\n]+)' + BT, 'g')
    var slotRe = new RegExp(S + 'C(\d+)' + S, 'g')

    // Markdown minimo, a mano. Sin CDN a proposito: estas paginas viajan como
    // string adentro del binario standalone -- ver la nota de arriba del
    // archivo-, y una dependencia externa no viaja con ellas.
    //
    // Se escapa PRIMERO y se marca despues: al reves, cualquier respuesta del
    // modelo con un "<script>" adentro seria HTML de verdad en la pagina.
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

    // "Auto" = el mejor disponible. Nombra el MODELO y deja que el gateway
    // elija la maquina: desde la fase 8 eso lo decide pickCandidate por carga,
    // asi que Auto por fin significa algo. Antes se apoyaba en que
    // findAllByModelId prefiriera al par, que era una preferencia de demo.
    function autoModelId() {
      var p = peersOnline()[0]
      var l = localNode()
      return (p && p.modelId) || (l && l.modelId) || 'llama1b'
    }

    // Todos los candidatos que se pueden fijar a mano, uno por MAQUINA y no
    // por modelo. Antes se deduplicaba por modelId y dos pares sirviendo
    // llama1b colapsaban en una sola opcion: no habia forma de elegir cual.
    function fijables() {
      return nodes.filter(function (n) {
        return (
          n.status === 'online' &&
          (n.kind === 'peer' || n.kind === 'real' || n.kind === 'mock' || n.kind === 'upstream')
        )
      })
    }

    // El nodo que quedo fijado desde /network ("Use this node").
    function pinGuardado() {
      try { return sessionStorage.getItem('pyrus.pin') } catch (e) { return null }
    }

    function guardarPin(id) {
      try {
        if (id) sessionStorage.setItem('pyrus.pin', id)
        else sessionStorage.removeItem('pyrus.pin')
      } catch (e) { /* modo privado: el pin vive solo en el selector */ }
    }

    // -------------------------------------------------------------- la puerta
    window.onAgent = function (a) {
      var gate = document.getElementById('gate')
      var chat = document.getElementById('chat')
      var mostrarGate = a.status !== 'live' && !skipped

      gate.style.display = mostrarGate ? 'block' : 'none'
      chat.style.display = mostrarGate ? 'none' : 'flex'

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
      } catch (e) { /* el poll del chip repinta el estado real */ }
      pollAgent()
    })

    // Sigue existiendo una salida: el modelo propio no depende de la red, y un
    // primer arranque que no deja producir un solo token contra la maquina que
    // ya tenes adelante es una pared sin nada atras.
    document.getElementById('skip').addEventListener('click', function () {
      skipped = true
      sessionStorage.setItem('pyrus.skipGate', '1')
      if (window.__agent) window.onAgent(window.__agent)
      document.getElementById('prompt').focus()
    })

    // ------------------------------------------------------------- opciones
    // El selector tiene TRES modos, que son dos preguntas distintas:
    // que modelo se quiere y en que maquina. Hasta ahora solo se podia
    // contestar la primera.
    //
    //   local        -> esta maquina, y nada sale de aca   (local:true)
    //   auto         -> el mejor disponible, decide el gateway por carga
    //   node:<id>    -> una maquina concreta                (node:<id>)
    //
    // El checkbox "Local only" se absorbio en la primera opcion. Existiendo
    // los dos por separado se podian contradecir -- elegir el modelo de un par
    // Y tildar local only daba 404, porque el gateway filtra los pares
    // despues de elegir.
    function paintOptions() {
      var sel = document.getElementById('model')
      var vivo = agentLive()
      var loc = localNode()
      var elegido = sel.value || pinGuardado() && 'node:' + pinGuardado()

      var opts = []
      if (loc) {
        opts.push('<option value="local">' + esc(loc.displayName) + ' - this machine only</option>')
      }
      opts.push('<option value="auto"' + (vivo ? '' : ' disabled') + '>Auto - best available node</option>')

      // Una opcion por MAQUINA, con su carga: es lo que hace posible elegir
      // entre dos pares que sirven el mismo modelo.
      var lista = fijables()
      if (lista.length) {
        opts.push('<optgroup label="Specific node">')
        lista.forEach(function (n) {
          var carga = typeof n.loadPct === 'number' ? ' - ' + n.loadPct + '% busy' : ''
          opts.push(
            '<option value="node:' + esc(n.id) + '">' +
            esc(n.operator) + ' - ' + esc(n.displayName) + carga +
            '</option>'
          )
        })
        opts.push('</optgroup>')
      }
      sel.innerHTML = opts.join('')

      var sigue = false
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === elegido && !sel.options[i].disabled) sigue = true
      }

      // Un pin que llego desde /network manda sobre el default, pero solo si
      // ese nodo sigue estando: si se fue, se cae a Auto y se limpia, en vez
      // de dejar el selector apuntando a un fantasma.
      var pin = pinGuardado()
      if (pin && !sigue) {
        var vivoPin = false
        for (var j = 0; j < sel.options.length; j++) {
          if (sel.options[j].value === 'node:' + pin) vivoPin = true
        }
        // Solo se descarta un pin cuando SABEMOS que el nodo no esta: con la
        // grilla todavia vacia -- el primer pintado ocurre antes de que
        // conteste /v1/nodes -- ningun pin figura, y borrarlo ahi tiraba
        // siempre el que acababa de llegar desde /network.
        if (!vivoPin && lista.length) { guardarPin(null); pin = null }
      }

      // Si nadie eligio a mano, Auto gana apenas queda disponible: antes el
      // nodo se ponia vivo y el selector seguia clavado en el modelo local
      // porque era la unica opcion valida cuando se pinto la primera vez.
      if (sigue) sel.value = elegido
      else if (pin) sel.value = 'node:' + pin
      else if (!userPicked && vivo) sel.value = 'auto'
      else sel.value = vivo ? 'auto' : (loc ? 'local' : 'auto')

      var nota = document.getElementById('routing')
      var pares = peersOnline()
      if (sel.value === 'local') {
        nota.textContent = 'Nothing leaves this machine.'
      } else if (sel.value.indexOf('node:') === 0) {
        nota.textContent = 'Pinned to one machine - no fallback if it is busy.'
      } else if (!vivo) {
        nota.textContent = 'Node offline - the network is out of reach.'
      } else {
        nota.textContent = pares.length + (pares.length === 1 ? ' node' : ' nodes') + ' reachable'
      }
    }

    // Traduce el modo del selector a los tres campos del request.
    function destino() {
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

    // --------------------------------------------------------------- el hilo
    function render() {
      var el = document.getElementById('thread')
      if (!msgs.length) {
        el.innerHTML = '<div class="hint" style="margin-top:2rem">Ask your node anything. ' +
          'Every answer says which machine produced it.</div>'
        return
      }
      el.innerHTML = msgs.map(function (m) {
        var quien = m.role === 'user' ? 'You' : 'Assistant'
        var cuerpo = m.role === 'user' ? '<p>' + esc(m.content).replace(/\n/g, '<br>') + '</p>' : md(m.content)
        var clase = 'body' + (m.streaming && !m.content ? ' caret' : '')
        return '<div class="msg ' + m.role + '">' +
          '<div class="who">' + quien + '</div>' +
          '<div class="' + clase + '">' + cuerpo + '</div>' +
          (m.meta ? prov(m.meta) : '') +
          // FASE 9 — el desafio y el recibo van PEGADOS al turno que los
          // produjo. En una pestaña aparte serian dos artefactos sueltos que
          // hay que correlacionar a mano; aca la evidencia esta al lado de la
          // respuesta sobre la que habla.
          //
          // El outputHash se recomputa contra m.content, que es exactamente
          // el texto que este navegador acumulo delta a delta. Ese es el punto
          // entero de D24: el hash es del TEXTO y no depende del troceo, asi
          // que compararlo aca comprueba de verdad que lo atestiguado es lo que
          // se recibio -- no que dos campos del mismo JSON coincidan.
          (m.x402 ? htmlDeDesafio(m.x402) : '') +
          (m.recibo
            ? htmlDeRecibo(m.recibo, { textoRecibido: m.content, messages: m.enviado })
            : '') +
          '</div>'
      }).join('')
      el.scrollTop = el.scrollHeight
    }

    // La linea de procedencia. Es lo que separa a esto de cualquier otro chat:
    // el nodo que contesto sale nombrado, no supuesto.
    function prov(m) {
      // El que decide es scope (header X-Pyrus-Scope), no el kind: un
      // upstream puede ser un tercero o un motor propio detras de HTTP, y la
      // diferencia es justamente la que esta linea existe para declarar.
      var afuera = m.scope === 'external'
      var clase = m.kind === 'peer' ? 'peer' : afuera ? 'upstream' : 'local'
      // "(this machine)" es una afirmacion, no un adorno: colgarsela a una API
      // de terceros diria que el prompt no salio de aca cuando salio. Y al
      // reves, ponerle "(external API)" a un llama-server de localhost seria
      // acusar de una fuga que no hubo.
      var quien =
        m.kind === 'peer'
          ? m.operator
          : afuera
            ? m.operator + ' (external API)'
            : m.operator + ' (this machine)'
      // Cada parte en su propio span: unidas en un solo nodo de texto, el gap
      // del flex no aplica y se leia "18150ms1 tok/s20.2s".
      var partes = ['<span class="' + clase + '">' + esc(quien) + '</span>']
      if (m.ttft !== null) partes.push('<span>first token ' + m.ttft + 'ms</span>')
      if (m.tps) partes.push('<span>' + m.tps + ' tok/s</span>')
      partes.push('<span>' + m.secs + 's total</span>')
      // El costo va SIEMPRE, incluido el cero, y el cero se escribe con
      // palabras. "USD 0.0000" se lee como "salio muy barato" y no es eso: es
      // que a nadie se le cobra, porque el pago P2P todavia no existe. Y
      // "up to" tampoco es un adorno: este numero es el techo con el que se
      // autorizo el gasto, no lo que termino saliendo.
      //
      // El texto lo arma textoDeCostoEstimado, en panel-x402.mjs, y no una
      // funcion de aca: es la MISMA regla que aplican las vistas nuevas de la
      // Fase 9, y con dos implementaciones una de las dos se afloja sola. Los
      // seis decimales viven ahi por la misma razon de siempre -- con cuatro,
      // un turno de menos de 50 micros se muestra "USD 0.0000", identico a
      // gratis, que es justo la distincion que esta linea existe para hacer.
      //
      // Un turno VIEJO, sin el campo, no dibuja nada: decirle "no charge" seria
      // afirmar que fue gratis cuando lo unico cierto es que no se registro.
      if (m.cost === undefined || m.cost === null) { /* turno viejo, sin el dato */ }
      else partes.push('<span class="cost">' + esc(textoDeCostoEstimado(m.cost).texto) + '</span>')
      return '<div class="prov">' + partes.join('') + '</div>'
    }

    function toggleButtons() {
      document.getElementById('send').style.display = streaming ? 'none' : ''
      document.getElementById('stop').style.display = streaming ? '' : 'none'
      document.getElementById('prompt').disabled = streaming
    }

    async function send() {
      if (streaming) return
      var ta = document.getElementById('prompt')
      var texto = ta.value.trim()
      if (!texto) return

      var dest = destino()

      msgs.push({ role: 'user', content: texto })
      // x402 y recibo arrancan nulos y casi siempre se quedan asi: solo
      // existen cuando el request paso por el camino de pago. enviado guarda
      // los mensajes TAL CUAL viajaron, que es contra lo que se recomputa el
      // promptHash de la atestacion -- el hash es sobre la conversacion entera
      // canonicalizada, no sobre el ultimo turno.
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
        // El historial COMPLETO, menos el slot vacio que se esta llenando. Sin
        // esto cada turno arrancaba de cero y el modelo no recordaba nada.
        var historial = msgs.filter(function (m) { return !m.streaming }).map(function (m) {
          return { role: m.role, content: m.content }
        })
        slot.enviado = historial

        var resp = await authFetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: dest.model,
            messages: historial,
            stream: true,
            local: dest.local,
            // El campo node solo viaja cuando el usuario fijo una maquina: mandarlo
            // en null en todos los requests ensuciaria el contrato para los
            // clientes que nunca lo usan.
            node: dest.node || undefined
          })
        })

        if (!resp.ok) {
          var msj = 'HTTP ' + resp.status
          var b = null
          try {
            b = await resp.json()
            if (b && b.error && b.error.message) msj = b.error.message
          } catch (e) { /* el cuerpo no era JSON: queda el status */ }

          // FASE 9 — un 402 con accepts[] NO es un error de texto: es el nodo
          // diciendo cuanto cobra, a quien, en que red y hasta cuantos tokens.
          // Aplanarlo a "[error] HTTP 402" tiraba los cuatro datos que el DoD
          // de la fase le exige al desafio.
          //
          // Se llega aca cuando el request sale SIN credencial valida contra un
          // nodo con wallet: la key del panel revocada desde /node, o el
          // bootstrap de /v1/keys/panel que no contesto. Es el mismo 402 que ve
          // un desconocido con curl, y ahora se lee igual.
          //
          // El otro 402 que existe -- presupuesto agotado (B13) -- no trae
          // accepts y sigue por el camino de texto, que para ese caso es el
          // correcto: no hay nada que pagar, hay un tope que se toco.
          var vistaDesafio = vistaDeDesafio(b)
          if (resp.status === 402 && vistaDesafio.esDesafio) {
            slot.x402 = vistaDesafio
            slot.content = ''
            return
          }

          slot.content = '[error] ' + msj
          return
        }

        // Quien contesto viaja en headers, no en el cuerpo: ver
        // provenanceHeaders() en gateway.mjs.
        var operador = decodeURIComponent(resp.headers.get('X-Pyrus-Operator') || '') || 'unknown node'
        var tipo = resp.headers.get('X-Pyrus-Kind') || 'real'
        var alcance = resp.headers.get('X-Pyrus-Scope') || 'local'
        // FASE 8 — lo que este turno puede llegar a costar. Es el TECHO con el
        // que se autorizo el gasto, no lo que salio: en SSE los headers salen
        // antes del primer token, asi que el real todavia no existe.
        var costo = parseInt(resp.headers.get('X-Pyrus-Cost-Estimate-Micros') || '0', 10) || 0

        var reader = resp.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        while (true) {
          var r = await reader.read()
          if (r.done) break
          buf += dec.decode(r.value, { stream: true })
          var trozos = buf.split('\n\n')
          buf = trozos.pop()
          for (var i = 0; i < trozos.length; i++) {
            var linea = trozos[i]
            if (linea.indexOf('data: ') !== 0) continue
            var carga = linea.slice(6)
            if (carga === '[DONE]') continue
            var ev = JSON.parse(carga)
            if (ev.error) {
              slot.content += '\n[error] ' + (ev.error.message || ev.error)
              continue
            }
            // FASE 9 / D12 — el recibo viaja como EVENTO SSE FINAL y no en
            // X-PAYMENT-RESPONSE, porque con stream los headers ya salieron
            // antes del primer token. Se reconoce por paymentResponse, que es
            // la clave que el gateway le cuelga; no es un chunk de completion y
            // no tiene choices.
            //
            // Se guarda entero (recibo + atestacion + el motivo cuando falta) y
            // se dibuja abajo de la respuesta. receiptUrl queda para poder
            // volver a mirarlo desde /node despues.
            if (ev.paymentResponse || ev.attestation || ev.attestationMissing) {
              slot.recibo = ev
              continue
            }
            var d = ev.choices && ev.choices[0] && ev.choices[0].delta
            var pedazo = (d && d.content) || ''
            if (pedazo) {
              if (ttft === null) ttft = Date.now() - t0
              toks++
              slot.content += pedazo
              render()
            }
          }
        }

        var total = (Date.now() - t0) / 1000
        slot.meta = {
          operator: operador,
          kind: tipo,
          scope: alcance,
          ttft: ttft,
          tps: ttft !== null && total > 0 ? Math.round(toks / total) : 0,
          secs: total.toFixed(1),
          cost: costo
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
      } catch (e) { /* sin storage el chat anda igual, solo no sobrevive al reload */ }
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
      // Elegir a mano descarta el pin que venia de /network: el selector es la
      // ultima palabra, si no el chip diria una cosa y el request haria otra.
      if (this.value.indexOf('node:') !== 0) guardarPin(null)
      else guardarPin(this.value.slice(5))
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
    // Paleta de acciones (Ctrl+K) y menu "+" del composer.
    //
    // La mitad de estas acciones estan CABLEADAS contra endpoints que ya
    // existen; la otra mitad es forma sin fondo todavia. Las segundas llevan
    // una etiqueta MOCK visible, no solo un comentario: un control que parece
    // funcionar y no hace nada es peor que uno ausente, porque el que lo toca
    // se queda creyendo que ya lo configuro.
    // ======================================================================

    var opciones = { thinking: false, esfuerzo: 2, rapido: false, cambiarSiFlag: false, modo: 'auto' }
    try {
      var guardadas = JSON.parse(sessionStorage.getItem('pyrus.opts') || 'null')
      if (guardadas) opciones = Object.assign(opciones, guardadas)
    } catch (e) { /* sin sesion, quedan los defaults */ }

    function guardarOpts() {
      try { sessionStorage.setItem('pyrus.opts', JSON.stringify(opciones)) } catch (e) {}
    }

    var adjuntos = []

    function pintarAdjuntos() {
      var cont = document.getElementById('adjuntos')
      cont.innerHTML = adjuntos.map(function (a, i) {
        return '<span class="adjunto">' + esc(a.nombre) +
          ' <button data-quita="' + i + '" title="Remove">&times;</button></span>'
      }).join('')
      cont.querySelectorAll('[data-quita]').forEach(function (b) {
        b.addEventListener('click', function () {
          adjuntos.splice(Number(b.dataset.quita), 1)
          pintarAdjuntos()
        })
      })
    }

    function interruptor(on) { return '<span class="sw' + (on ? ' on' : '') + '"><i></i></span>' }

    function escalon(n) {
      var out = '<span class="esf">'
      for (var i = 0; i < 5; i++) {
        var cls = i === 4 ? (n >= 4 ? 'pico' : '') : (i <= n ? 'on' : '')
        out += '<b class="' + cls + '"></b>'
      }
      return out + '</span>'
    }

    var NIVELES = ['Minimal', 'Low', 'Medium', 'High', 'Max']

    // Cada accion declara si esta cableada. mock:true pinta la etiqueta.
    function acciones() {
      return [
        { g: 'Context', t: 'Attach file...', d: 'Sube al drive de este nodo e inserta su nombre', f: adjuntarArchivo },
        { g: 'Context', t: 'Mention file from this node...', d: 'Lista lo que este nodo publica', f: mencionarArchivo },
        { g: 'Context', t: 'Clear conversation', f: function () { document.getElementById('new').click() } },
        { g: 'Context', t: 'Rewind', d: 'Deshace el ultimo intercambio', f: rebobinar, off: msgs.length < 2 },
        { g: 'Context', t: 'Browse the web', mock: true, d: 'No hay herramienta de web todavia' },

        { g: 'Model', t: 'Switch model...', v: etiquetaModelo(), f: function () {
          cerrarPal()
          var sel = document.getElementById('model')
          sel.focus()
          if (sel.showPicker) { try { sel.showPicker() } catch (e) {} }
        } },
        { g: 'Model', t: 'Effort', v: NIVELES[opciones.esfuerzo], extra: escalon(opciones.esfuerzo), mock: true,
          f: function () { opciones.esfuerzo = (opciones.esfuerzo + 1) % 5; guardarOpts(); repintarPal() } },
        { g: 'Model', t: 'Thinking', extra: interruptor(opciones.thinking), mock: true,
          d: 'Medido: prenderlo en nemotron-3.5 cuesta 100x tokens. El toggle todavia no viaja al upstream',
          f: function () { opciones.thinking = !opciones.thinking; guardarOpts(); repintarPal() } },
        { g: 'Model', t: 'Switch models when a message is flagged', extra: interruptor(opciones.cambiarSiFlag), mock: true,
          f: function () { opciones.cambiarSiFlag = !opciones.cambiarSiFlag; guardarOpts(); repintarPal() } },
        { g: 'Model', t: 'Toggle fast mode', extra: interruptor(opciones.rapido), mock: true,
          f: function () { opciones.rapido = !opciones.rapido; guardarOpts(); repintarPal() } },
        { g: 'Model', t: 'Account & usage...', d: 'Gasto y cuota reales de este nodo', f: verCuenta },

        { g: 'Modes', t: 'Manual', d: 'Pide aprobacion antes de cada accion', mock: true,
          v: opciones.modo === 'manual' ? 'activo' : '',
          f: function () { opciones.modo = 'manual'; guardarOpts(); repintarPal() } },
        { g: 'Modes', t: 'Plan', d: 'Explora y propone antes de tocar nada', mock: true,
          v: opciones.modo === 'plan' ? 'activo' : '',
          f: function () { opciones.modo = 'plan'; guardarOpts(); repintarPal() } },
        { g: 'Modes', t: 'Auto', d: 'Aprueba lo seguro y frena en lo riesgoso', mock: true,
          v: opciones.modo === 'auto' ? 'activo' : '',
          f: function () { opciones.modo = 'auto'; guardarOpts(); repintarPal() } }
      ]
    }

    function etiquetaModelo() {
      var sel = document.getElementById('model')
      if (!sel || sel.selectedIndex < 0) return ''
      var t = sel.options[sel.selectedIndex].textContent
      return t.length > 34 ? t.slice(0, 33) + '…' : t
    }

    // ---------------------------------------------------- acciones reales

    function rebobinar() {
      // Se saca el ultimo par usuario/asistente. Es local y exacto: el
      // historial COMPLETO se manda en cada request, asi que deshacerlo aca
      // deshace de verdad lo que el modelo va a ver en el turno siguiente.
      cerrarPal()
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
      if (msgs.length) msgs.pop()
      save()
      render()
    }

    async function verCuenta() {
      cerrarPal()
      abrirModal('Account & usage', '<p class="hint">Cargando...</p>')
      try {
        var res = await Promise.all([
          authFetch('/v1/budget').then(function (x) { return x.json() }),
          authFetch('/v1/quota').then(function (x) { return x.json() })
        ])
        var b = res[0]
        var q = res[1]
        abrirModal('Account & usage',
          '<p class="sub">Numeros reales de este nodo, no un ejemplo.</p>' +
          '<h4 style="margin:.6rem 0 .3rem">Gasto en APIs externas (' + esc(b.period || '') + ')</h4>' +
          '<p>Gastado <b>' + esc(b.spent || '-') + '</b> de un tope de <b>' + esc(b.cap || '-') +
          '</b> &middot; queda ' + esc(b.remaining || '-') + '</p>' +
          '<h4 style="margin:.9rem 0 .3rem">Cuota que este nodo REGALA a sus pares</h4>' +
          '<p><b>' + esc(String(q.given_tokens != null ? q.given_tokens : 0)) + '</b> tokens entregados &middot; ' +
          esc(String(q.quota_tokens || 0)) + ' por par cada ' + esc(String(q.window_hours || 0)) + ' h &middot; ' +
          esc(String((q.peers || []).length)) + ' par(es) consumiendo</p>')
      } catch (e) {
        abrirModal('Account & usage', '<p class="hint">No se pudo leer: ' + esc(e.message) + '</p>')
      }
    }

    async function mencionarArchivo() {
      cerrarPal()
      abrirModal('Mention a file', '<p class="hint">Leyendo el drive de este nodo...</p>')
      try {
        var res = await authFetch('/v1/files')
        var j = await res.json()
        var fs = j.files || []
        if (!fs.length) {
          abrirModal('Mention a file', '<p class="hint">Este nodo no publica ningun archivo todavia. ' +
            'Subi uno con "Attach file" o desde <a href="/node">my node</a>.</p>')
          return
        }
        abrirModal('Mention a file', '<div class="pal-lista">' + fs.map(function (f) {
          var nombre = f.name || f.path || ''
          return '<button class="pal-item" data-men="' + esc(nombre) + '">' + esc(nombre) +
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
        abrirModal('Mention a file', '<p class="hint">No se pudo listar: ' + esc(e.message) + '</p>')
      }
    }

    function adjuntarArchivo() {
      cerrarPal()
      var inp = document.createElement('input')
      inp.type = 'file'
      inp.addEventListener('change', async function () {
        var f = inp.files && inp.files[0]
        if (!f) return
        adjuntos.push({ nombre: f.name + ' (subiendo...)' })
        pintarAdjuntos()
        var i = adjuntos.length - 1
        try {
          // Sube DE VERDAD al Hyperdrive de este nodo. Lo que no existe es un
          // modelo que lea el archivo: por eso se inserta el nombre en el
          // prompt y no se manda el binario al chat.
          var res = await authFetch('/v1/files/upload?name=' + encodeURIComponent(f.name), {
            method: 'POST',
            body: f
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          adjuntos[i] = { nombre: f.name }
          var ta = document.getElementById('prompt')
          ta.value = (ta.value ? ta.value + ' ' : '') + '@' + f.name
        } catch (e) {
          adjuntos[i] = { nombre: f.name + ' (fallo)' }
        }
        pintarAdjuntos()
      })
      inp.click()
    }

    // ------------------------------------------------------------ la paleta

    var palAbierta = false
    var palFiltro = ''
    var palSel = 0

    function visibles() {
      var q = palFiltro.toLowerCase()
      return acciones().filter(function (a) {
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
      if (!html) html = '<div class="pal-vacio">Nada coincide con ese filtro.</div>'

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
        '<div class="pal-pie">Enter para ejecutar &middot; Esc para cerrar &middot; ' +
        'lo marcado <b>mock</b> todavia no hace nada</div></div></div>'
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

    // --------------------------------------------------------- el menu "+"

    document.getElementById('mas').addEventListener('click', function (ev) {
      ev.stopPropagation()
      var ya = document.getElementById('mas-menu')
      if (ya) { ya.remove(); return }
      var fila = document.getElementById('mas').parentNode
      var m = document.createElement('div')
      m.className = 'mas-menu'
      m.id = 'mas-menu'
      m.innerHTML =
        '<button class="pal-item" data-m="subir">Upload from computer</button>' +
        '<button class="pal-item" data-m="ctx">Add context</button>' +
        '<button class="pal-item" data-m="web">Browse the web<span class="der">' +
        '<span class="mock">mock</span></span></button>'
      fila.appendChild(m)
      m.querySelectorAll('[data-m]').forEach(function (b) {
        b.addEventListener('click', function () {
          m.remove()
          if (b.dataset.m === 'subir') adjuntarArchivo()
          if (b.dataset.m === 'ctx') mencionarArchivo()
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

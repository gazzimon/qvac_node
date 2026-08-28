// Los 3 paneles del marketplace simulado, como strings HTML puros.
//
// Van embebidos en JS (no como archivos .html sueltos en /public) a proposito:
// bare-pack arma el binario standalone siguiendo el grafo de imports de
// bin.mjs, y un archivo estatico fuera de ese grafo no viaja con el binario.
// Un string exportado si viaja, sin tener que resolver paths a mano ni
// depender de bare-fs para servir contenido estatico.
//
// FASE 9 — lo que la fase emitia y no se veia (el 402, el recibo, la atestacion
// de D24 y el split de D25) se dibuja con `qvac/panel-x402.mjs`. Ese archivo NO
// se importa para llamarlo desde aca: se importa para PEGAR SU CODIGO adentro
// del <script> de cada pagina, y asi la suite prueba las mismas funciones que
// corre el navegador. La nota larga de por que esta ahi y no aca vive en la
// cabecera de ese archivo.

import { FUENTE_EMBEBIDA } from './panel-x402.mjs'
import { FUENTE_EMBEBIDA_WALLET } from './panel-wallet.mjs'

const NAV = `
<nav class="nav">
  <span class="brand">PyrusLLM</span>
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
  /* Jerarquia invertida a proposito: el titular es QUIEN provee, no que modelo
     corre. Con el modelo de titulo, dos tarjetas de operadores distintos se
     veian practicamente iguales -el nombre del modelo es el mismo en los dos
     nodos- y la demo es justamente "le compro inferencia a la otra maquina".
     El overflow-wrap es obligatorio: los modelId no tienen espacios y se
     cortaban a la mitad ("llama_3.2_1b_intruct_tool_calli"). */
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

  /* Reemplaza a la barra en 0%: una barra vacia con "0%" no dice si el nodo
     esta libre o colgado. El estado se nombra. */
  .state { font-size: .8rem; font-weight: 600; margin-top: .6rem; }
  .state.libre { color: #4ade80; }
  .state.busy { color: #fbbf24; }
  .state.full { color: #f87171; }

  /* La linea de evidencia bajo la respuesta: sin esto, el texto aparece y nada
     dice que viajo por P2P desde otra maquina. Es la prueba, no un adorno. */
  .meta {
    display: flex; flex-wrap: wrap; gap: .25rem .75rem; margin-top: .5rem;
    font-size: .76rem; color: #8b93a7; font-family: ui-monospace, monospace;
  }
  .meta b { color: #4ade80; font-weight: 600; }

  /* El descubrimiento por DHT tarda ~17s medidos. Sin estado de carga, eso son
     17 segundos de pantalla vacia delante del jurado, que se leen como roto. */
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
  /* Los dos medidores de My Node (Fase 6.5 y 6.6). Se apilan en pantalla
     angosta: son dos lecturas independientes, no una comparacion lado a lado
     que se rompa al perder el ancho. */
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

  /* El interruptor del asistente externo (Fase 8.5). Ambar como el badge del
     upstream: el mismo color en el panel, en la lista de nodos y en la linea de
     procedencia del chat, para que "esto sale de la red" se aprenda una vez. */
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
  /* Verde como 'online': un par P2P verificado es la cosa buena que muestra
     la demo, no puede parecerse a un mock. */
  .badge.peer { background: #10331f; color: #4ade80; }
  /* Ambar, el color de aviso del resto de la UI: el externo funciona, pero es
     el unico camino donde el prompt sale de la red y cuesta plata. Ni el verde
     del par verificado ni el azul de esta maquina. */
  .badge.upstream { background: #3a2a10; color: #fbbf24; }
  /* Acciones por tarjeta. "Chatear" queda primero y en azul: es la accion que
     cuenta la demo sola. "Conectar" es secundaria pero es la que prueba que
     esto es un gateway de verdad y no un chat con pasos extra. */
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

  /* Pasos numerados. Sin la numeracion, cuatro bloques de comandos seguidos se
     leen como alternativas y no como una secuencia -pasaba con el modal de
     Open WebUI, que la gente ejecutaba salteado-. */
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

  /* Estado real del servicio externo, no "asumamos que arranco". */
  .dot { display: inline-flex; align-items: center; gap: .45rem; font-size: .82rem; color: #8b93a7; }
  .dot i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; font-style: normal; }
  .dot.up { color: #4ade80 } .dot.up i { background: #4ade80 }
  .dot.down { color: #f87171 } .dot.down i { background: #f87171 }

  /* Advertencia previa a los pasos. WhatsApp no vincula un bot sino LA cuenta
     personal del operador: eso hay que leerlo antes de escanear el QR, no
     despues, asi que va arriba y no en el pie de la receta. */
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

  /* Estado del agente, visible en las tres paginas: es la condicion que decide
     si se llega a la red o no, asi que no puede vivir solo en una pantalla. */
  .nav .agent { margin-left: auto; display: inline-flex; align-items: center; gap: .45rem; font-size: .8rem; }
  .nav .agent i { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7386; display: block; flex: none; }
  .nav .agent b { font-weight: 600; }
  .nav .agent.offline { color: #8b93a7 }
  .nav .agent.launching { color: #fbbf24 } .nav .agent.launching i { background: #fbbf24 }
  .nav .agent.live { color: #4ade80 } .nav .agent.live i { background: #4ade80 }
  .nav .agent.error { color: #f87171 } .nav .agent.error i { background: #f87171 }

  /* ---------------------------------------------------------------- chat */
  /* 'chatpage' y no 'chat': ya existe una clase .chat en el panel Network
     (el bloque de chat viejo) con margin-top, y el body la heredaba. */
  body.chatpage { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  body.chatpage main {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    max-width: 780px; width: 100%; padding: 0 1.25rem;
  }
  /* El JS le pone display:flex al mostrarlo; la direccion y el flex-1 tienen
     que estar aca, o el hilo y el composer quedan uno al lado del otro. */
  #chat { flex: 1; min-height: 0; flex-direction: column; }
  #thread { flex: 1; min-height: 0; overflow-y: auto; padding: 1.5rem 0 1rem; }

  /* La puerta. Es lo primero que se ve mientras el agente esta apagado. */
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

  /* La linea de procedencia: quien contesto, cuanto tardo. Sin esto el chat es
     indistinguible de cualquier otro y la red deja de ser visible. */
  .prov {
    display: flex; flex-wrap: wrap; gap: .25rem .7rem; margin-top: .5rem;
    font-size: .74rem; color: #8b93a7; font-family: ui-monospace, monospace;
    align-items: center;
  }
  .prov .peer { color: #4ade80; font-weight: 600; }
  .prov .local { color: #7db8ff; font-weight: 600; }
  .prov .upstream { color: #fbbf24; font-weight: 600; }
  /* El costo no se resalta como el operador: es un dato, no una alarma. Se
     distingue de la latencia sin gritar. */
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

  /* Paleta de acciones (Ctrl+K). Vive en el chat y no en un panel aparte
     porque lo que hace -- cambiar de modelo, limpiar, ver el gasto -- son
     decisiones que se toman MIENTRAS se escribe, no antes. */
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

  /* La marca de mock NO es decorativa: el proyecto exige que todo lo simulado
     se vea. Un control que parece funcionar y no hace nada es peor que uno
     ausente, porque el que lo usa cree que ya lo configuro. */
  .pal-item .mock {
    font-size: .66rem; text-transform: uppercase; letter-spacing: .05em;
    background: #3a2f16; color: #e0b95a; border: 1px solid #5a4a20;
    padding: .1rem .4rem; border-radius: 4px;
  }
  .pal-item[disabled] { cursor: default; }
  .pal-item[disabled]:hover { background: transparent; }

  /* Interruptor y escalon: son controles de aspecto real aunque casi todos
     esten mockeados, porque el punto del pedido es ver la forma. */
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

  /* El "+" del composer */
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
     FASE 9 — los cuatro artefactos que la fase emite y que hasta ahora solo se
     veian con curl. El HTML lo arma qvac/panel-x402.mjs; aca esta como se ve.

     Los tres tonos son la parte que NO es decoracion, y por eso estan juntos:

       bueno    un hecho comprobado ACA (un hash recomputado que coincide);
       tibio    un dato con una salvedad que hay que leer -- una ausencia con
                motivo, un tx hash que nadie verifico contra la cadena, una
                firma que esta pagina no comprueba;
       malo     algo que se lee como prueba y no lo es: un mock, un hash que no
                coincide, un tx sintetico, una liquidacion que fallo.

     Un mock pintado de verde seria exactamente el mock que parece funcional que
     la regla del proyecto prohibe.
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
  /* overflow-wrap obligatorio: direcciones, hashes y firmas no tienen espacios
     y se salian de la tarjeta cortadas a la mitad. */
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
  /* D25 — "medido" y "estimado" NO comparten color. Es la regla entera: un
     conteo de chunks de SSE pintado igual que un usage del proveedor es la
     forma mas barata de convertir una estimacion en un numero. */
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
     Panel /wallet (Fase 11). Columna angosta tipo billetera de celular: la
     referencia visual es una wallet movil, no una tabla. Solo lectura — los
     botones de enviar se dibujan deshabilitados, ver qvac/panel-wallet.mjs.
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

  /* El QR (Fase 12). El fondo blanco lo pone el propio <svg> y NO sigue el tema
     oscuro: un lector de QR necesita contraste oscuro-sobre-claro, y uno
     invertido no escanea en muchos telefonos. Es lo unico claro del panel. */
  .w-qr { display: flex; justify-content: center; margin: .2rem 0 .8rem; }
  .w-qr svg { border-radius: 8px; max-width: 100%; height: auto; }

  /* Historial (Fase 12). Mismas filas que los activos, con la flecha de
     direccion adelante y el monto con signo. */
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

  /* Enviar (Fase 12). Tapa la tarjeta mientras dura: form -> revision ->
     estado. El poll no repinta hasta que se vuelve. */
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

  /* Onboarding: crear o importar la wallet desde el panel (Fase 11). */
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

  /* La pantalla de las 24 palabras: se muestra una sola vez. */
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

  /* Selector de red (Fase 11). No hace hot-swap: guarda y pide reiniciar. */
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
     Settings (Fase 12). Overlay ADENTRO de la tarjeta, no un modal global: la
     billetera es una columna angosta y su configuracion pertenece a esa
     columna. Se cierra por ✕, por Esc y por click afuera.
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
  /* El selector de red, mudado acá, ya no necesita el borde que lo separaba
     del resto de la tarjeta: ahora TODO en esta pantalla es configuracion. */
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

// Escapado de HTML, inyectado en el script de los 3 paneles.
//
// No es paranoia de manual: el precio lo escribe el proveedor desde su panel y
// se muestra crudo en los tres. Un precio como `<img src=x onerror=alert(1)>`
// se ejecutaba al abrir la pagina —probado—. Se escapa TODO lo que venga del
// servidor, no solo el precio, porque el dia que un nombre de operador o un
// tag se vuelvan editables el agujero vuelve solo.
const ESC = `
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }`

// El chip del nav vive en las TRES paginas y se pinta solo. Es el unico estado
// compartido, y tiene que serlo: si el agente esta apagado la red no contesta,
// y eso hay que verlo desde donde sea que uno este parado -- no solo en el chat.
const AGENT_CHIP = `
<script>
  // ---------------------------------------------------------------------
  // La credencial del panel.
  //
  // El gate del gateway dejo de aceptar requests sin Authorization, y la
  // pagina no esta exenta: pide la suya y la manda como cualquier otro
  // cliente. Un solo camino de autenticacion, sin puerta trasera para el
  // navegador.
  // ---------------------------------------------------------------------
  window.__panelKey = null

  async function panelKey() {
    if (window.__panelKey) return window.__panelKey
    try {
      const r = await fetch('/v1/keys/panel')
      const d = await r.json()
      window.__panelKey = d.key
    } catch (e) { /* sin key el gate responde 401 y se ve el motivo */ }
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
    } catch (err) { /* el gateway se cayo: el chip se queda como estaba */ }
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

// Piezas del modal, compartidas por /network (archivos) y /node (conectar).
// Viven aca y no adentro de una pagina porque "Conectar" se mudo a My Node
// -- la credencial autentica contra TU gateway, no contra el nodo ajeno --
// y copiar/cerrar/formatear las siguen necesitando las dos.
const MODAL_JS = `
    // navigator.clipboard NO existe fuera de un contexto seguro. El panel se
    // abre por http://localhost (seguro) pero tambien por http://192.168.x.x
    // desde otra maquina de la LAN, donde la API no esta y el boton "Copiar"
    // no hacia nada en silencio. Por eso el fallback con execCommand.
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
      btn.textContent = ok ? 'Copiado' : 'Copiá a mano'
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

    // Modal simple para contenido ya armado. Los paneles que necesitan uno con
    // tabs y polling siguen escribiendo #modal a mano; este es para el caso
    // comun -- un titulo y un cuerpo -- que antes obligaba a repetir el
    // overlay, el cierre por Esc y el cierre por click afuera en cada lugar.
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

// Las recetas de "Conectar": el mismo nodo, consumido desde afuera del panel.
// Es la prueba de que esto es un gateway OpenAI-compatible de verdad y no un
// chat con nuestro protocolo adentro.
const CONNECT_JS = `
    function recetas(c) {
      const modelo = c.node.modelId

      // El bloque de proveedor es identico para todos los canales de OpenClaw
      // -lo unico que cambia es que canal se enciende-, asi que se arma una
      // sola vez y cada receta le pasa SU bloque de channels. Duplicar el
      // config entero por canal garantizaba que uno quedara desactualizado.
      const configOpenclaw = (canal) => [
        '{',
        '  models: {',
        '    providers: {',
        '      qvac: {',
        '        baseUrl: "' + c.baseUrl + '",',
        '        apiKey: "' + c.apiKey + '",',
        '        api: "openai-completions",',
        '        models: [{ id: "' + modelo + '", name: "QVAC · red P2P" }]',
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
        '      botToken: "PEGA_ACA_EL_TOKEN_DE_BOTFATHER",',
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
          pie: 'OpenClaw es un runtime de agente self-hosted. Le escribís al bot desde el celular y la respuesta la genera este nodo — sin OpenAI ni servidor de terceros en el medio.',
          pasos: [
            { texto: 'Instalá OpenClaw.', cmd: 'npm install -g openclaw' },
            { texto: 'En Telegram, hablale a <b>@BotFather</b>, mandá <b>/newbot</b> y guardá el token que te da (tiene forma <code>123:abc</code>).' },
            { texto: 'Pegá esto en <code>~/.openclaw/openclaw.json</code>, reemplazando el token del paso 2:', cmd: proveedorQvac },
            { texto: 'Arrancá el gateway y aprobá el pareo. El código vale 1 hora.', cmd: 'openclaw gateway\\nopenclaw pairing list telegram\\nopenclaw pairing approve telegram <CODIGO>' }
          ]
        },
        whatsapp: {
          titulo: 'WhatsApp',
          aviso: '<b>No es un bot.</b> WhatsApp no tiene @BotFather: OpenClaw vincula <b>tu cuenta personal</b> como un dispositivo más (igual que WhatsApp Web). Usá un número que puedas dedicar a esto y dejá <code>dmPolicy: "pairing"</code>, así nadie te escribe al nodo sin que vos lo apruebes.',
          pie: 'Mismo gateway que Telegram, otro canal. La respuesta la genera este nodo: WhatsApp sólo transporta el texto.',
          estado: {
            url: 'http://127.0.0.1:18789/',
            up: 'El gateway de OpenClaw responde en 127.0.0.1:18789',
            down: 'El gateway de OpenClaw todavía no responde'
          },
          pasos: [
            { texto: 'Instalá OpenClaw y el plugin del canal.', cmd: 'npm install -g openclaw\\nopenclaw plugins install clawhub:@openclaw/whatsapp' },
            { texto: 'Pegá esto en <code>~/.openclaw/openclaw.json</code>, con tu número en formato internacional (<code>+549…</code>) en <code>allowFrom</code>:', cmd: proveedorWhatsapp },
            { texto: 'Vinculá la cuenta: el comando imprime un <b>QR en la terminal</b>. En el celular: <b>WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo</b> y escaneá. El QR dura ~60 s; si vence, repetí el comando.', cmd: 'openclaw channels login --channel whatsapp' },
            { texto: 'Arrancá el gateway y aprobá el primer mensaje. El pedido vale 1 hora.', cmd: 'openclaw gateway\\nopenclaw pairing list whatsapp\\nopenclaw pairing approve whatsapp <CODIGO>' },
            { texto: 'El semáforo de arriba sólo dice si el gateway está vivo. Que WhatsApp haya quedado <b>vinculado</b> lo confirma este comando, y es lo primero que hay que mirar si no llega la respuesta — antes que el log del nodo.', cmd: 'openclaw channels status --probe' }
          ]
        },
        terminal: {
          titulo: 'Terminal',
          pie: 'Forma OpenAI exacta. Si este curl anda, anda cualquier cliente compatible.',
          pasos: [
            { texto: 'Pedile una respuesta al nodo con streaming:', cmd: 'curl ' + c.baseUrl + '/chat/completions \\\\\\n  -H "Authorization: Bearer ' + c.apiKey + '" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"model":"' + modelo + '","messages":[{"role":"user","content":"hola"}],"stream":true}\\'' },
            { texto: 'Y el catálogo de modelos de la red, igual que la API de OpenAI:', cmd: 'curl ' + c.baseUrl + '/models -H "Authorization: Bearer ' + c.apiKey + '"' }
          ]
        },
        hermes: {
          titulo: 'Hermes Agent',
          pie: 'Agente con memoria persistente (SQLite local, sin servicio externo). No hay código nuestro acá: es configuración suya.',
          pasos: [
            { texto: 'Pegá esto en <code>~/.hermes/config.yaml</code>:', cmd: 'model:\\n  provider: custom\\n  base_url: ' + c.baseUrl + '\\n  api_key: ' + c.apiKey + '\\n  default: ' + modelo },
            { texto: 'Arrancá Hermes. Usá chat simple, sin tool calls.', cmd: 'hermes' }
          ]
        },
        webui: {
          titulo: 'Open WebUI',
          pie: 'Cara de ChatGPT, self-hosted, apuntada a este nodo. Necesita Docker Desktop corriendo.',
          estado: {
            url: 'http://localhost:3000/',
            up: 'Open WebUI responde en localhost:3000',
            down: 'Open WebUI todavía no responde'
          },
          pasos: [
            { texto: 'Levantá el contenedor apuntado a este gateway:', cmd: 'docker run -d -p 3000:8080 \\\\\\n  -e OPENAI_API_BASE_URL=' + c.baseUrl + ' \\\\\\n  -e OPENAI_API_KEY=' + c.apiKey + ' \\\\\\n  -v open-webui:/app/backend/data \\\\\\n  --name open-webui ghcr.io/open-webui/open-webui:main' },
            { texto: 'Abrí <a href="http://localhost:3000" target="_blank" rel="noopener">localhost:3000</a> y elegí el modelo <code>' + modelo + '</code>.' }
          ]
        }
      }
    }

    // El servicio corre en OTRO origen, asi que un fetch normal da CORS aunque
    // este arriba. Con mode:no-cors la respuesta es opaca -no se puede leer-
    // pero la promesa resuelve si el puerto contesta y rechaza si no: alcanza
    // para "esta arriba o no", que es lo unico que se pregunta.
    //
    // Lo unico. Vale para Open WebUI y para el gateway de OpenClaw por igual,
    // y de ahi el limite honesto del semaforo: dice que el proceso contesta,
    // NO que WhatsApp quedo vinculado. Eso solo lo sabe 'channels status', que
    // es un comando y no un puerto. Pintar "vinculado" desde aca seria inventar
    // un estado que el panel no puede ver.
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
        (r.estado ? '<p><span class="dot" id="estado-dot"><i></i>chequeando…</span></p>' : '') +
        r.pasos.map((p, i) => \`
          <div class="step">
            <div class="n">\${i + 1}</div>
            <div class="body">
              <p>\${p.texto}</p>
              \${p.cmd ? '<div class="cmd"><pre>' + esc(p.cmd) + '</pre><button data-copy="' + i + '">Copiar</button></div>' : ''}
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

    // Recibe TU nodo local, no un id de nodo ajeno.
    //
    // Antes esto pegaba a /v1/connection/:id y emitia una credencial "para
    // hablarle a tal proveedor", que era una idea equivocada: la key autentica
    // contra tu propio gateway, y es el quien despues decide a que nodo rutear.
    // Una key por nodo remoto sugeria un camino privilegiado que no existe.
    async function abrirConexion(nodo, apiKey) {
      let c
      try {
        c = {
          apiKey: apiKey,
          // El host lo dice el browser, no una constante: si entraste por la IP
          // de la LAN, el comando que copiaas tiene que apuntar ahi y no a
          // 127.0.0.1, que en la maquina del cliente es otra cosa.
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
            <button class="ghost" id="cerrar-modal">Cerrar</button>
          </div>
        </div>\`

      document.querySelectorAll('.tabs button').forEach(b => {
        b.addEventListener('click', () => pintarTab(rs, b.dataset.tab))
      })
      document.getElementById('cerrar-modal').addEventListener('click', cerrarModal)
      // Cerrar clickeando el fondo, pero NO cuando el click nace adentro del
      // panel: sin el chequeo de target, seleccionar texto de un comando y
      // soltar el mouse afuera cerraba el modal.
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

    // Tres clases de nodo, y la diferencia importa demasiado para taparla con
    // un booleano: 'peer' es un nodo REMOTO de verdad, descubierto por el
    // swarm y con su manifiesto firmado verificado. Antes caia en el mismo
    // 'simulado' que los mocks -- justo al revés de lo que pasa.
    // Un upstream local se nombra por lo que es -- un motor de esta maquina al
    // que se le habla por HTTP -- y no por como se le pide.
    function etiquetaDe (n) {
      if (n.local) return 'local engine · this machine'
      return KIND_LABEL[n.kind] || esc(n.kind)
    }

    const KIND_LABEL = {
      real: 'this machine',
      peer: 'verified P2P peer',
      mock: 'simulated',
      // El kind que manda el prompt FUERA de la red: a una API de un tercero,
      // con la cuenta del operador. La etiqueta lo dice sin eufemismos porque
      // es la unica que acota la promesa de privacidad.
      //
      // OJO: no todo upstream es un tercero. Un llama-server o un NIM en
      // localhost tambien entra por HTTP y tambien es kind 'upstream', pero el
      // prompt no sale de la maquina. Ese caso lo separa n.local en
      // etiquetaDe(); esta entrada es solo el default.
      upstream: 'external API · third party',
      // Sale del directorio Hyperbee: su manifiesto verifico alguna vez, pero
      // ahora no hay socket. Nunca es candidato de ruteo (ver store.mjs).
      known: 'known · disconnected'
    }
${ESC}

    function barColor(pct) {
      return pct < 50 ? '#4ade80' : pct < 80 ? '#fbbf24' : '#f87171'
    }

    // El grid se ARMA una vez y despues solo se actualizan los numeros.
    //
    // Antes se hacia innerHTML del grid entero en cada poll (cada 3s): las
    // tarjetas se destruian y se volvian a crear sin parar, asi que un click
    // que cayera justo en ese momento se perdia -Playwright no pudo ni
    // clickear una tarjeta: "element was detached from the DOM"-. Ademas
    // reiniciaba la transicion CSS de las barras en cada vuelta.
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
      // Mirar el marketplace y elegir una maquina para hablarle es el recorrido
      // que faltaba: hasta ahora el chat solo dejaba nombrar un MODELO, y dos
      // pares sirviendo el mismo colapsaban en una opcion. El pin viaja por
      // sessionStorage porque es una eleccion de esta sesion, no una
      // preferencia que deba sobrevivir al navegador.
      document.querySelectorAll('[data-usar]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          try { sessionStorage.setItem('pyrus.pin', el.dataset.usar) } catch (e) { /* modo privado */ }
          window.location.href = '/'
        })
      })

      // "Conectar" se mudo a /node porque la credencial autentica contra TU
      // gateway y no contra el nodo ajeno que muestra la tarjeta.
      document.querySelectorAll('[data-files]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          abrirArchivos(el.dataset.files)
        })
      })
    }

    // Estado de carga del descubrimiento. Medido: el primer par tarda ~17s en
    // aparecer por la DHT. Sin esto son 17 segundos de grilla vacia delante
    // del jurado, que no se leen como "buscando" sino como "esta roto".
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

      // Solo la identidad de los nodos justifica rearmar el DOM; el precio y
      // la carga cambian seguido y se actualizan en el lugar.
      const key = nodes.map(n => n.id + '|' + n.displayName + '|' + n.operator + '|' + n.tags.join('/')).join(',')
      if (key !== gridKey) {
        gridKey = key
        buildGrid(nodes)
      }

      for (const n of nodes) {
        const card = document.querySelector('.card[data-id="' + CSS.escape(n.id) + '"]')
        if (!card) continue

        // El precio se parte en monto (grande) y unidad (chica). Se arma con
        // nodos y textContent y NO con innerHTML: el precio lo escribe el
        // proveedor desde su panel, y ya se probo que un <img src=x onerror>
        // ahi adentro ejecuta al abrir la pagina.
        const precio = card.querySelector('[data-price]')
        precio.textContent = ''
        const corte = String(n.pricing).indexOf(' / ')
        const monto = document.createElement('b')
        const unidad = document.createElement('span')
        monto.textContent = corte === -1 ? n.pricing : String(n.pricing).slice(0, corte)
        unidad.textContent = corte === -1 ? '' : String(n.pricing).slice(corte + 3)
        precio.appendChild(monto)
        precio.appendChild(unidad)

        // Se muestra uno u otro, sin recrear nodos: asi la transicion CSS de
        // la barra anima de verdad en vez de reiniciarse en cada poll.
        const load = card.querySelector('[data-load]')
        const offline = card.querySelector('[data-offline]')
        const estado = card.querySelector('[data-state]')
        const caido = n.loadPct === null
        offline.style.display = caido ? '' : 'none'
        estado.style.display = caido ? 'none' : ''

        // La barra solo aparece cuando hay carga de verdad. Al 0% era una
        // barra vacia con un "0%" al lado que no distinguia "libre" de
        // "colgado"; el estado ahora se dice con palabras.
        load.style.display = !caido && n.loadPct > 0 ? '' : 'none'
        if (!caido) {
          // Tres estados, no dos: un nodo con 1 de 4 slots tomados NO esta
          // "ocupado" -acepta trabajo-, y decirlo asi desalienta al comprador
          // en la unica pantalla donde elige. "Ocupado" se reserva para el que
          // de verdad no tiene lugar.
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
    // "Conectar": el mismo nodo, consumido desde afuera del panel.
    //
    // Es la prueba de que esto es un gateway OpenAI-compatible de verdad y no
    // un chat con nuestro protocolo adentro: el comando que se copia aca es el
    // que usaria cualquier cliente de terceros, sin camino privilegiado.
    // -----------------------------------------------------------------------

${MODAL_JS}

    async function abrirArchivos(id) {
      try {
        // El nodo local (kind 'real'/'mock') no tiene peerKey: ese es SU
        // propio drive. Un nodo 'peer' si lo tiene, y sin pasarlo el gateway
        // siempre devolvia el drive local, sin importar que tarjeta se
        // hubiera clickeado.
        const nodo = nodesById[id]
        const peerKey = nodo && nodo.peerKey
        const url = peerKey ? '/v1/files?peerKey=' + encodeURIComponent(peerKey) : '/v1/files'
        const r = await fetch(url)
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const data = await r.json()

        // Muestra el drive del nodo que eligio, con link qvac:// que se puede
        // pegar en otra maquina para bajarlo sin conexion P2P previa.
        const archivos = data.files || []
        const modal = document.getElementById('modal')
        modal.innerHTML = \`
          <div class="modal-overlay" id="modal-overlay">
            <div class="modal">
              <h3>Archivos en \${esc(nodo ? nodo.operator : 'este nodo')}</h3>
              <p class="sub">Los links <code>qvac://</code> se pueden copiar y pegar en otra máquina para bajar sin pairing previo.</p>
              \${archivos.length === 0
                ? '<p class="muted">Sin archivos publicados.</p>'
                : '<table><thead><tr><th>Nombre</th><th>Tamaño</th><th>Link</th></tr></thead><tbody>' +
                  archivos.map(f => \`
                    <tr>
                      <td>\${esc(f.path)}</td>
                      <td>\${formatBytes(f.bytes)}</td>
                      <td><button class="ghost" data-copy-file="\${esc(f.link)}" style="font-size:.75rem">Copiar</button></td>
                    </tr>\`).join('') +
                  '</tbody></table>'
              }
              <button class="ghost" id="cerrar-modal">Cerrar</button>
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


    // El poll pisa el grid entero, asi que si falla no puede tumbar el panel.
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
    let shellFor = null // para que nodo esta armado el DOM de #detail
    let isMine = false  // el nodo elegido, es ESTE gateway? (solo ahi se puede re-firmar)
    let swarmActive = false
    let catalogById = {} // alias -> {displayName, sizeGB, fits}, de /v1/swarm/manifest
${ESC}
${FUENTE_EMBEBIDA}
${MODAL_JS}
${CONNECT_JS}

    // -------------------------------------------------------------------
    // Onboarding: aparece solo si este gateway no se unio al swarm todavia.
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
    // Detalle del nodo elegido. Se arma UNA vez por nodo y despues solo se
    // actualizan los textos que cambian -- ver la nota vieja mas abajo sobre
    // por que (el input de precio perdia lo que el usuario tipeaba).
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
      mineFieldsBuiltFor = null // fuerza reconstruir el bloque "mine-fields" tambien
    }

    // Los campos que solo tienen sentido sobre TU PROPIO nodo P2P -- editarlos
    // implica re-firmar el manifiesto con tu identidad, algo que no se puede
    // hacer sobre el nodo de otro. Se arman aparte de buildShell() porque
    // "es mio" puede cambiar sin que cambie el nodo elegido (ej. arrancaste
    // --swarm recien).
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

      // Lo unico que el usuario edita: solo se pisa si NO lo esta tocando.
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
    // Selector de modelo: solo ofrece lo que entra en la RAM de ESTA
    // maquina (ver /v1/swarm/manifest -> models[].fits). Cambiar de modelo
    // pasa por un modal de confirmacion porque dispara una carga real.
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
        'Cambiar el modelo de este nodo a "' + (info ? info.displayName : nextAlias) + '".\\n\\n' +
        'Puede tardar varios segundos -o fallar por falta de memoria- mientras el ' +
        'nodo sigue respondiendo con el modelo actual. Si falla, se mantiene el modelo de ahora.'
      )
      if (!proceed) { e.target.value = n.modelId; return }

      const r = await fetch('/v1/swarm/manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: nextAlias })
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        alert((data.error && data.error.message) || 'no se pudo cambiar el modelo')
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

      // Esta pagina es SOLO sobre tu maquina. Antes listaba la red entera y
      // arrancaba en todos[0], que suele ser un par remoto: el panel decia
      // "Tu nodo" y mostraba el de otra persona, con un campo de precio y un
      // boton de guardar al lado que no podian hacer nada sobre el manifiesto
      // firmado de un tercero. Los nodos ajenos se miran en /network.
      const nodes = todos.filter(n => n.kind === 'real')
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      if (!current || !nodesById[current]) current = nodes[0]?.id

      // Un desplegable con una sola opcion es ruido: casi siempre hay un unico
      // nodo local, y solo se muestra el selector si de verdad hay que elegir.
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

      // El <select> se repinta solo si cambio la lista de nodos. Repintarlo en
      // cada poll cerraba el desplegable si lo tenias abierto.
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

      // Sin el blur, el input sigue teniendo el foco y el refresh de abajo no
      // lo actualiza: quedaria mostrando lo tipeado aunque el server lo haya
      // recortado, y no se veria que quedo guardado de verdad.
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
    // Credenciales. Varias a proposito: una por cliente, para poder cortar a
    // un bot sin tocar a los demas y para que el rastro sepa cual pidio que.
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
      // El numero va en la pregunta: decir "se revoca la key actual" cuando hay
      // cinco emitidas es mentirle a quien esta por apretar.
      const n = keys.length
      if (!confirm('Revoke all ' + n + (n === 1 ? ' key' : ' keys') +
        '? Every client using them stops working immediately.')) return
      const btn = e.target
      btn.disabled = true
      try {
        const r = await authFetch('/v1/keys/revoke-all', { method: 'POST' })
        const d = await r.json()
        keys = d.keys || []
        // El panel se re-credencia solo: su key vieja acaba de morir con el
        // resto, y sin esto la pagina quedaria sin poder hablarle al gateway.
        window.__panelKey = null
        pintarKeys()
      } catch (err) {
        alert('Could not revoke: ' + ((err && err.message) || err))
      }
      btn.disabled = false
    })

    // ------------------------------------------------------------------
    // Trafico. Las dos direcciones salen del MISMO rastro, separadas por
    // kind: 'served' es lo que este nodo produjo para un par (lo escribe
    // provider.mjs) y 'route' es lo que este nodo le pidio a alguien.
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
      // FASE 9 / D25 \u2014 el split va en su propia columna y con su procedencia
      // pegada. Sumar prefill y decode en el "tok" de al lado los volveria a
      // mezclar, que es justo lo que D25 separo; y sin la procedencia, un
      // conteo de chunks de SSE se lee igual que un usage del proveedor.
      //
      // D27 al lado: sin finishReason, en el rastro un corte del cliente y
      // una respuesta completa se ven identicos.
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
        // Lo ruteado al propio equipo no es una transaccion con nadie: sin este
        // filtro, "lo que le pedimos a otros" se llenaba de nuestro propio nodo.
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
        '<p class="x-nota">D25 registra las dos dimensiones por separado porque no escalan ' +
        'igual: el prefill procesa el prompt en paralelo y lo limita el computo, el decode ' +
        'genera token a token y lo limita el ancho de banda de memoria. El precio sigue siendo ' +
        'plano (D22): esto se registra para poder decidir con datos, no para tarifar hoy.</p>'
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
      } catch (e) { /* el poll siguiente reintenta */ }
    }

    // -------------------------------------------------------------------
    // FASE 9 — el recibo y la atestacion de un request cobrado.
    //
    // Va con fetch PELADO y no con authFetch, y no es un olvido: la ruta
    // GET /v1/receipts/:id es la unica del sistema que NO pide credencial, a
    // proposito. Quien pago por 402 no tiene ninguna -- ese es todo el punto
    // del 402 --, asi que exigirle una para ver su propio recibo lo dejaria sin
    // poder auditar justamente lo que pago. Mandarle la key del panel aca
    // ademas escondería esa propiedad detras de un header que no hace falta.
    //
    // No hay ruta que LISTE recibos y no se inventa una: la Fase 9 esta cerrada
    // y agregarle superficie la reabre. Se busca por id, que es el que vuelve
    // con la respuesta.
    // -------------------------------------------------------------------
    async function verRecibo() {
      const box = document.getElementById('recibo-box')
      const id = document.getElementById('recibo-id').value.trim()
      if (!id) {
        box.innerHTML = '<p class="hint">Falta el id de la completion.</p>'
        return
      }
      // Vacio es AUSENTE, no cadena vacia: el hash de "" es un hash valido, y
      // compararlo contra el declarado diria "NO coincide" cuando lo cierto es
      // que no hay con que comparar. Son dos estados distintos y la vista los
      // distingue.
      const texto = document.getElementById('recibo-texto').value
      const ctx = texto.length ? { textoRecibido: texto } : {}

      box.innerHTML = '<p class="hint">Buscando…</p>'
      try {
        const r = await fetch('/v1/receipts/' + encodeURIComponent(id))
        if (r.status === 404) {
          box.innerHTML =
            '<div class="x402"><div class="x-aviso tibio">No hay recibo para ese id. ' +
            'Los recibos viven en memoria del proceso y se guardan los ultimos 200: ' +
            'no es un ledger, el ledger de verdad es la cadena. Un reinicio los borra.' +
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
    // Los dos medidores (Fase 6.5 y 6.6). Se piden juntos porque son la misma
    // pregunta vista de los dos lados, pero vienen de endpoints distintos a
    // proposito: /v1/quota lo lleva el proveedor y /v1/budget el gateway.
    //
    // Cada uno falla por su cuenta. Si el nodo no esta sirviendo todavia no
    // hay cuota que mostrar, y eso no tiene por que borrar el gasto.
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
      } catch (e) { /* el poll siguiente reintenta */ }
    }

    async function refrescarGasto() {
      try {
        const r = await authFetch('/v1/budget')
        if (!r.ok) return
        const b = await r.json()

        // B13 — hay DOS topes y el que corta puede ser cualquiera de los dos.
        // Se muestra el MENOR de los dos remanentes, porque ese es el que
        // manda: con el de la cuenta en USD 20 y el del nodo en USD 2, decir
        // "te quedan 20" es prometer diecinueve que no existen.
        const nodo = b.node || {}
        const nodoManda =
          nodo.remaining_micros !== undefined && nodo.remaining_micros < b.remaining_micros
        const restante = nodoManda ? nodo.remaining : b.remaining
        document.getElementById('b-remaining').textContent = restante + ' left'

        // El porcentaje se calcula sobre el tope, no sobre lo que queda: con
        // el tope en cero no hay division por cero ni una barra al 100%.
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
      } catch (e) { /* el poll siguiente reintenta */ }
    }

    // -------------------------------------------------------------------
    // El asistente externo y su interruptor (Fase 8.5).
    //
    // El endpoint para prenderlo existia desde el principio y solo se podia
    // usar con curl. El caso que lo motivo es "se saturo la red en medio de una
    // demo", y en ese momento nadie abre una terminal.
    //
    // El boton dice lo que va a PASAR, no el estado en el que esta: "Turn on"
    // cuando esta apagado. Un boton que dice "On" y ademas esta prendido no se
    // sabe si es un estado o una accion, y este en particular decide si el
    // prompt de alguien sale de la maquina.
    // -------------------------------------------------------------------
    // FASE 7 — la direccion de cobro. Que NO haya wallet es un estado normal y
    // se dice como tal: un nodo que solo consume no necesita una. Lo que no
    // puede pasar es que se lea como si algo estuviera roto.
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
        /* sin gateway el resto de la pagina ya lo dice */
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

        // Sin ningun upstream configurado, el interruptor no tiene nada que
        // prender: se explica como se configura y no se ofrece un boton que no
        // haria nada.
        if (!u.upstreams.length) {
          sw.style.display = 'none'
          estado.innerHTML = '<p class="hint">No external assistant is configured. ' +
            'Copy <code>upstreams.example.json</code> to your storage directory as ' +
            '<code>upstreams.json</code> and restart the node.</p>'
          return
        }

        estado.innerHTML = u.upstreams.map(function (m) {
          // La credencial es lo unico que puede faltar y verse igual que todo
          // lo demas: el modelo aparece en la lista, con nombre y precio, y no
          // contesta nunca. Se dice cual variable de entorno falta, no "error".
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
      } catch (e) { /* el poll siguiente reintenta */ }
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
      } catch (e) { /* el refresco de abajo muestra el estado que quedo */ }
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

    // Mas lento que el resto: estos dos numeros se mueven de a un request, no
    // de a un token. Pollear cada 2,5 s seria pedirle al gateway que recorra
    // el ledger para decir lo mismo cuatro veces seguidas.
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
  <h1>Panel de administración</h1>
  <p class="sub">Todos los nodos de la red y el log de ruteo del gateway.</p>

  <table>
    <thead>
      <tr><th>Nodo</th><th>Operador</th><th>Tipo</th><th>Estado</th><th>Carga</th><th>Precio</th><th></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <h3 style="margin-top:2rem">Log de ruteo</h3>
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
          <td><span class="badge \${esc(n.status)}">\${n.status === 'online' ? 'en línea' : 'fuera de línea'}</span></td>
          <td>\${n.loadPct === null ? '—' : esc(n.loadPct + '% (' + n.activeRequests + '/' + n.maxConcurrentRequests + ')')}</td>
          <td>\${esc(n.pricing)}</td>
          <td><button class="\${n.status === 'online' ? 'danger' : 'ghost'}" data-id="\${esc(n.id)}" data-action="\${n.status === 'online' ? 'kick' : 'restore'}">\${n.status === 'online' ? 'Tirar' : 'Reactivar'}</button></td>
        </tr>
      \`).join('')
      document.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = encodeURIComponent(btn.dataset.id)
          const action = btn.dataset.action
          btn.disabled = true // el poll repinta la tabla: evita doble click
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

    // El rastro dejo de ser solo de ruteo: ahora trae model_load y los dos
    // eventos D7 del swarm, que no tienen modelId ni nodo destino. Pintarlos
    // con la plantilla vieja mostraba "undefined → undefined (undefinedms)".
    const linea = (e) => {
      const hora = esc(new Date(e.ts).toLocaleTimeString())
      const detalle = \`<span class="muted">\${esc(e.reason || '')}</span>\`

      if (e.kind && e.kind !== 'route') {
        return \`<div>\${hora} — <b>\${esc(e.kind)}</b> \${detalle}</div>\`
      }

      // Los tres numeros de la demo. Se muestran solo si existen: un request
      // que fallo antes del primer token no tiene tok/s, y un "0 tok/s" ahi
      // seria una medicion inventada.
      const metricas = []
      if (e.tokens) metricas.push(esc(e.tokens) + ' tok')
      if (e.ttftMs !== null && e.ttftMs !== undefined) metricas.push('ttft ' + esc(e.ttftMs) + 'ms')
      if (e.tokensPerSec) metricas.push(esc(e.tokensPerSec) + ' tok/s')
      metricas.push(esc(e.ms) + 'ms')

      const destino = e.target ? \` <b>[\${esc(e.target)}]</b>\` : ''
      const fallo = e.ok === false ? \` <b>FALLO\${e.code ? ' ' + esc(e.code) : ''}</b>\` : ''

      // FASE 9 / D25 y D27. El split va con su procedencia y no sumado a
      // "metricas": metido ahi seria un numero mas al lado de los tok/s, y la
      // diferencia entre un token medido y un chunk de SSE contado se pierde
      // exactamente en ese renglon.
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
        : '<div class="muted">todavía no hay requests ruteados</div>'
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
      } catch (e) { /* el poll siguiente reintenta */ }
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

// -----------------------------------------------------------------------------
// Panel /wallet (Fase 11) — la wallet de COBRO de este nodo, SOLO LECTURA.
//
// El dibujo entero lo deciden las funciones puras de `qvac/panel-wallet.mjs`,
// pegadas aca por `FUENTE_EMBEBIDA_WALLET` igual que panel-x402: probarlas en
// la suite es probarlas aca. Este archivo solo aporta el poll y el cableado de
// clicks. Enviar y hacer swap NO estan: los botones se ven deshabilitados.
// -----------------------------------------------------------------------------
export const WALLET_HTML = page(
  'PyrusLLM · Wallet',
  `
  <h1>Wallet</h1>
  <p class="sub">La wallet de cobro de este nodo: dirección, saldo, movimientos y en qué red. Se puede crear, importar, recibir y enviar desde acá; la red y los tokens que se vigilan se configuran con el ☰. La firma la hace el nodo, no el navegador: la seed nunca sale del proceso que la abre. La dirección es la misma que viaja firmada en el manifiesto.</p>
  <div id="wallet-root" class="w-root"><div class="skel"><div style="width:55%"></div><div style="width:80%"></div><div style="width:35%"></div></div></div>

  <script>
${ESC}
${FUENTE_EMBEBIDA_WALLET}
${MODAL_JS}

    let vistaWallet = vistaDeSaldos(null)
    let filtroWallet = ''
    let tabWallet = 'assets'

    // FASE 12 — el historial. Queda en null hasta que se entra al tab: leerlo en cada
    // poll seria pegarle al explorer cada 15 s por una pantalla que quiza nadie
    // esta mirando.
    let vistaHist = null

    // Maquina de estados del onboarding. 'seed' es la pantalla de las 24
    // palabras: una vez ahi, el poll NO puede repintar hasta que se confirme.
    let onbEstado = 'idle'   // 'idle' | 'seed'
    let onbSeed = null        // { frase, address }
    let onbOcupado = false

    // FASE 12 — Settings abierto. Mismo criterio que 'seed': mientras esta
    // arriba, el poll de 15 s NO repinta. Un formulario a medio llenar (una
    // address de token de 42 caracteres pegada a mano) no se puede pisar solo.
    let settingsAbierto = false

    // FASE 12 — la maquina de estados de enviar. Mismo criterio de nuevo: con
    // algo distinto de 'idle' arriba, el poll NO repinta. Que un refresco de
    // saldos borre una direccion de destino a medio pegar, o peor, tape la
    // pantalla que dice el hash de una transaccion recien mandada, no puede pasar.
    let envioEstado = 'idle'   // 'idle' | 'form' | 'revision' | 'enviando' | 'resultado'
    let envioDatos = null      // { destino, monto, asset, simbolo, red, mainnet, ... }
    let envioGas = null        // lo que contesto /v1/wallet/send/quote
    let envioResultado = null  // { estado, hash, explorer, ... }

    // Leer y dibujar estan separados porque Settings necesita releer SIN
    // repintar la tarjeta de atras: despues de agregar un token lo que se
    // refresca es el overlay, no la billetera que esta tapada.
    async function cargarVistaWallet () {
      try {
        const r = await authFetch('/v1/wallet/balances')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        vistaWallet = vistaDeSaldos(await r.json())
      } catch (e) {
        vistaWallet = vistaDeSaldos({
          error: 'no se pudo leer /v1/wallet/balances: ' + ((e && e.message) || e)
        })
      }
    }

    async function cargarWallet () {
      await cargarVistaWallet()
      pintarWallet()
    }

    // En cada poll (15 s) se repinta la tarjeta entera, SALVO que estemos en la
    // pantalla de la frase (no se pisa), o que el foco este en el buscador (ahi
    // se toca solo #w-filas para no comerse lo tipeado).
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

    // FASE 12 — los movimientos. Se pide al entrar al tab y en el poll SOLO si
    // el tab sigue abierto: el explorer es un tercero y no hay por que pegarle
    // cada 15 s desde una pantalla que nadie tiene arriba.
    async function cargarHistorial () {
      try {
        const r = await authFetch('/v1/wallet/history')
        if (!r.ok) throw new Error('HTTP ' + r.status)
        vistaHist = vistaDeHistorial(await r.json())
      } catch (e) {
        // Un fetch que falla NO es "no hubo movimientos": se arma la vista con
        // el motivo, que es lo que htmlDeHistorial dibuja como "—".
        vistaHist = vistaDeHistorial({
          ok: false,
          error: 'no se pudo leer /v1/wallet/history: ' + ((e && e.message) || e)
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
        // La frase se suelta de memoria y se vuelve a la billetera normal.
        onbSeed = null
        onbEstado = 'idle'
        cargarWallet()
      })
      document.querySelectorAll('.w-card [data-copy]').forEach(b => {
        b.addEventListener('click', () => copiar(b.dataset.copy, b))
      })
    }

    // ---------------------------------------------------------------------
    // FASE 12 — enviar. La pantalla TAPA la tarjeta (como la de la frase) y el
    // poll no la repinta. La firma la hace el nodo: de acá salen tres strings.
    // ---------------------------------------------------------------------
    function msgEnvio (texto, malo) {
      const el = document.getElementById('w-env-msg')
      if (el) el.innerHTML = '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' +
        esc(texto) + '</span>'
    }

    function pintarEnvio () {
      const raiz = document.getElementById('wallet-root')
      if (envioEstado === 'form') {
        raiz.innerHTML = '<div class="w-card">' + htmlDeEnvio(vistaWallet) + '</div>'
      } else if (envioEstado === 'revision' || envioEstado === 'enviando') {
        raiz.innerHTML = '<div class="w-card">' +
          htmlDeRevisionEnvio(vistaWallet, envioDatos, envioGas) + '</div>'
      } else {
        raiz.innerHTML = '<div class="w-card">' + htmlDeEstadoEnvio(envioResultado) + '</div>'
      }
      cablearEnvio()
    }

    function salirDelEnvio () {
      envioEstado = 'idle'
      envioDatos = null
      envioGas = null
      envioResultado = null
      cargarWallet()
      // Lo que se acaba de mandar tiene que aparecer en el historial la proxima
      // vez que se abra: se tira el cache para no mostrarlo desactualizado.
      vistaHist = null
    }

    async function revisarEnvio () {
      const asset = (document.getElementById('w-env-asset') || {}).value || 'native'
      const destino = ((document.getElementById('w-env-destino') || {}).value || '').trim()
      const monto = ((document.getElementById('w-env-monto') || {}).value || '').trim()

      if (!envioParecePlausible({ destino, monto, asset })) {
        msgEnvio('revisá el destino (0x + 40 hex) y el monto (un decimal mayor que cero)', true)
        return
      }
      msgEnvio('estimando el gas…', false)
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
        msgEnvio('no se pudo estimar: ' + ((e && e.message) || e), true)
      }
    }

    async function confirmarEnvio () {
      if (envioEstado === 'enviando') return
      // Los tres campos salen de lo que devolvio la COTIZACION, no de leer los
      // inputs de nuevo: son los mismos sobre los que se estimo el gas y los
      // mismos que la persona acaba de revisar en pantalla. Releer el formulario
      // acá abriria la puerta a revisar una cosa y mandar otra.
      const cuerpo = {
        destino: envioDatos.destino,
        monto: envioDatos.monto,
        asset: envioDatos.asset || 'native'
      }

      // MAINNET pide escribirlo, igual que el selector de red — y acá pesa mas,
      // porque esto no se deshace reiniciando.
      if (envioDatos.mainnet) {
        const c = prompt('MAINNET mueve plata real y esto no se puede deshacer.\\n\\n' +
          envioDatos.monto + ' ' + (envioDatos.simbolo || '') + ' a ' + envioDatos.destino +
          '\\n\\nEscribí MAINNET para confirmar:')
        if (c !== 'MAINNET') { msgEnvio('cancelado', true); return }
        cuerpo.confirmar = 'MAINNET'
      }

      envioEstado = 'enviando'
      const boton = document.getElementById('w-env-confirmar')
      if (boton) boton.disabled = true
      msgEnvio('firmando y difundiendo…', false)
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
          error: 'no se pudo enviar: ' + ((e && e.message) || e),
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
    // FASE 12 — Settings, detras del ☰.
    //
    // Se dibuja en un contenedor APARTE de #wallet-root, no adentro: asi
    // cerrarlo no obliga a repintar la tarjeta entera, y un poll que llegue
    // mientras esta abierto (no puede: pintarWallet corta) no lo arrastraria.
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
      // Al volver se recarga: puede haberse agregado o quitado un token, y la
      // lista de activos tiene que reflejarlo sin esperar al proximo poll.
      cargarWallet()
    }

    function onEscSettings (ev) { if (ev.key === 'Escape') cerrarSettings() }

    function pintarSettings () {
      contenedorSettings().innerHTML = htmlDeSettings(vistaWallet)
      document.getElementById('w-set-cerrar').addEventListener('click', cerrarSettings)
      // Click AFUERA de la tarjeta cierra; adentro no. Se compara el target
      // exacto para que soltar el mouse afuera despues de seleccionar texto no
      // cierre, que es el bug que ya tenia el modal de /network.
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
        // La vista se recarga del server y se repinta el overlay: la lista que
        // se ve es la que quedo EN DISCO, no la que el navegador supone.
        await cargarVistaWallet()
        pintarSettings()
        if (alTerminar) alTerminar()
      } catch (e) {
        msgToken('no se pudo guardar: ' + ((e && e.message) || e), true)
      }
    }

    function cablearSettings () {
      // Agregar un token. La forma se chequea ACA antes de postear — es la
      // misma regla que el nodo aplica antes de tocar disco.
      const bAdd = document.getElementById('w-token-add')
      if (bAdd) {
        bAdd.addEventListener('click', () => {
          const addr = (document.getElementById('w-token-addr') || {}).value || ''
          const sym = (document.getElementById('w-token-sym') || {}).value || ''
          const dec = (document.getElementById('w-token-dec') || {}).value || ''
          const tok = { address: addr.trim(), symbol: sym.trim(), decimals: Number(dec) }
          if (!tokenParecePlausible(tok)) {
            msgToken('revisá los tres campos: dirección 0x + 40 hex, símbolo de 1 a 12 ' +
              'caracteres, decimales enteros de 0 a 36', true)
            return
          }
          bAdd.disabled = true
          tokensFetch('POST', tok, () => msgToken('agregado — se muestra sin verificar', false))
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
      msgOnb(frase ? 'importando…' : 'generando la wallet…', false)
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
          // Wallet nueva: a la pantalla de la frase, una sola vez.
          onbSeed = { frase: d.frase, address: d.address }
          onbEstado = 'seed'
          pintarSeed()
        } else {
          // Import: no hay frase que mostrar, se va derecho a la billetera.
          await cargarWallet()
        }
        if (d.swarmActivo && !d.swarmReanunciado) {
          msgOnb('wallet lista, pero el manifiesto no se pudo re-anunciar: reiniciá el nodo para que los pares vean la dirección', true)
        }
      } catch (e) {
        msgOnb('no se pudo crear la wallet: ' + ((e && e.message) || e), true)
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
          // El historial se pide recien acá, la primera vez que se abre el tab.
          if (tabWallet === 'history' && !vistaHist) cargarHistorial()
        })
      })
      document.querySelectorAll('.w-card [data-copy]').forEach(b => {
        b.addEventListener('click', () => copiar(b.dataset.copy, b))
      })

      // Onboarding: crear / importar.
      const bCrear = document.getElementById('w-onb-crear')
      if (bCrear) {
        bCrear.addEventListener('click', () => {
          if (confirm('Se van a generar 24 palabras que se muestran UNA sola vez. Anotalas en papel. ¿Seguir?')) {
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
            msgOnb('eso no parece una frase BIP-39 (12 a 24 palabras en minúscula)', true)
            return
          }
          crearWallet(palabrasDeFrase(frase).join(' '))
        })
      }

      // FASE 12 — Send abre su propia pantalla, que tapa la tarjeta.
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

      // FASE 12 — el ☰ abre Settings. Todo lo que antes era configuracion
      // suelta en la tarjeta vive ahi adentro.
      const bSet = document.getElementById('w-set-abrir')
      if (bSet) {
        bSet.addEventListener('click', () => {
          settingsAbierto = true
          pintarSettings()
        })
      }
    }

    // Selector de red. NO hace hot-swap: guarda y pide reiniciar. Ir a
    // MAINNET pide escribir MAINNET, que es lo que el endpoint exige.
    //
    // FASE 12 — se mudo de cablearWallet a acá SIN cambiarle nada: el
    // selector ahora se dibuja adentro de Settings, así que su cableado va con
    // el resto de esa pantalla.
    function cablearSelectorRed () {
      const bRed = document.getElementById('w-red-aplicar')
      if (bRed) {
        bRed.addEventListener('click', async () => {
          const sel = document.getElementById('w-red-sel')
          const msg = document.getElementById('w-red-msg')
          const escribir = (t, malo) => {
            if (msg) msg.innerHTML =
              '<span class="' + (malo ? 'w-onb-err' : 'w-onb-ok') + '">' + esc(t) + '</span>'
          }
          if (!sel) return
          const red = sel.value
          const opt = sel.options[sel.selectedIndex]
          const esMainnet = opt && opt.dataset.mainnet === '1'
          const actual = (vistaWallet.red && vistaWallet.red.nombre) || ''
          if (red === actual) { escribir('ya estás en esa red', true); return }
          const cuerpo = { red }
          if (esMainnet) {
            const c = prompt('MAINNET mueve plata real. Escribí MAINNET para confirmar:')
            if (c !== 'MAINNET') { escribir('cancelado', true); return }
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
            if (!r.ok) { escribir((d && d.error && d.error.message) || ('HTTP ' + r.status), true); return }
            escribir(
              'guardado: ' + d.red + ' (eip155:' + d.chainId + '). Reiniciá el nodo para que tome efecto.' +
              (d.avisoX402 ? ' ' + d.avisoX402 : ''),
              false
            )
          } catch (e) {
            escribir('no se pudo guardar: ' + ((e && e.message) || e), true)
          } finally {
            bRed.disabled = false
          }
        })
      }
    }

    cargarWallet()
    setInterval(() => {
      cargarWallet()
      // El historial se refresca solo mientras su tab esta abierto.
      if (tabWallet === 'history') cargarHistorial()
    }, 15000)
  </script>`
)

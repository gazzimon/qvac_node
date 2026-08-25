// Los 3 paneles del marketplace simulado, como strings HTML puros.
//
// Van embebidos en JS (no como archivos .html sueltos en /public) a proposito:
// bare-pack arma el binario standalone siguiendo el grafo de imports de
// bin.mjs, y un archivo estatico fuera de ese grafo no viaja con el binario.
// Un string exportado si viaja, sin tener que resolver paths a mano ni
// depender de bare-fs para servir contenido estatico.

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
  .composer .note { margin-left: auto; font-size: .76rem; }
  .composer .note a { color: #9fd6ff; }
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
    const KIND_LABEL = {
      real: 'this machine',
      peer: 'verified P2P peer',
      mock: 'simulated',
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
          <span class="badge \${esc(n.kind)}">\${KIND_LABEL[n.kind] || esc(n.kind)}</span>
          <h3>\${esc(n.operator)}</h3>
          <div class="model">\${esc(n.displayName)}</div>
          <div class="tags">\${n.tags.map(t => \`<span class="tag">\${esc(t)}</span>\`).join('')}</div>
          <div class="price" data-price></div>
          <span class="badge offline" data-offline style="display:none">offline</span>
          <div class="state" data-state></div>
          <div class="bar-row" data-load style="display:none"><div class="bar"><div data-fill></div></div><span class="pct"></span></div>
          <div class="actions">
            <button class="ghost" data-files="\${esc(n.id)}">Files</button>
          </div>
        </div>
      \`).join('')
      // La tarjeta ya no selecciona nada: esta pagina es de lectura. Chatear
      // vive en /, y "Conectar" se mudo a /node porque la credencial autentica
      // contra TU gateway y no contra el nodo ajeno que muestra la tarjeta.
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
      const r = await fetch('/v1/nodes')
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
      bot without touching the rest. Revoking takes effect immediately, and keys live in this
      process&rsquo;s memory &mdash; restarting the node revokes every one of them anyway.</p>
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
      const r = await fetch('/v1/nodes')
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
      return '<tr><td class="muted">' + hora + '</td><td>' + quien + '</td>' +
        '<td class="muted">' + esc(e.modelId || '') + '</td>' +
        '<td class="muted">' + esc(bits.join(' \u00b7 ')) + fallo + '</td></tr>'
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
        '</th><th>Model</th><th></th></tr></thead><tbody>' +
        entradas.map(filaFlujo).join('') + '</tbody></table>'
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
        const r = await fetch('/v1/routing-log')
        const { log } = await r.json()
        pintarFlujo(log || [])
      } catch (e) { /* el poll siguiente reintenta */ }
    }

    cargarKeys()
    refrescarFlujo()
    setInterval(refrescarFlujo, 3000)

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

    async function refreshNodes() {
      const r = await fetch('/v1/nodes')
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

      return \`<div>\${hora} — \${esc(e.modelId)}\${destino} → \${esc(e.operator)}\` +
        \` (\${metricas.join(' · ')})\${fallo} \${detalle}</div>\`
    }

    async function refreshLog() {
      const r = await fetch('/v1/routing-log')
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

    // "Auto" = el mejor disponible. El gateway ya prefiere el par remoto sobre
    // el local para un mismo modelId (findAllByModelId), asi que alcanza con
    // nombrar el modelo: si hay un par sirviendolo, gana el.
    function autoModelId() {
      var p = peersOnline()[0]
      var l = localNode()
      return (p && p.modelId) || (l && l.modelId) || 'llama1b'
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
    function paintOptions() {
      var sel = document.getElementById('model')
      var vivo = agentLive()
      var pares = peersOnline()
      var loc = localNode()
      var elegido = sel.value

      var opts = ['<option value="auto"' + (vivo ? '' : ' disabled') + '>Auto - best available node</option>']
      if (loc) {
        opts.push('<option value="' + esc(loc.modelId) + '">' + esc(loc.displayName) + ' - this machine</option>')
      }
      var vistos = {}
      pares.forEach(function (n) {
        if (vistos[n.modelId]) return
        vistos[n.modelId] = 1
        opts.push('<option value="' + esc(n.modelId) + '">' + esc(n.displayName) + ' - ' + esc(n.operator) + '</option>')
      })
      sel.innerHTML = opts.join('')

      var sigue = false
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === elegido && !sel.options[i].disabled) sigue = true
      }
      // Si nadie eligio a mano, Auto gana apenas queda disponible: antes el
      // nodo se ponia vivo y el selector seguia clavado en el modelo local
      // porque era la unica opcion valida cuando se pinto la primera vez.
      if (!userPicked && vivo) sel.value = 'auto'
      else sel.value = sigue ? elegido : (vivo ? 'auto' : (loc ? loc.modelId : 'auto'))

      var nota = document.getElementById('routing')
      var soloLocal = document.getElementById('localonly').checked
      if (soloLocal) {
        nota.textContent = 'Nothing leaves this machine.'
      } else if (!vivo) {
        nota.textContent = 'Node offline - the network is out of reach.'
      } else {
        nota.textContent = pares.length + (pares.length === 1 ? ' node' : ' nodes') + ' reachable'
      }
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
          '</div>'
      }).join('')
      el.scrollTop = el.scrollHeight
    }

    // La linea de procedencia. Es lo que separa a esto de cualquier otro chat:
    // el nodo que contesto sale nombrado, no supuesto.
    function prov(m) {
      var clase = m.kind === 'peer' ? 'peer' : 'local'
      var quien = m.kind === 'peer' ? m.operator : m.operator + ' (this machine)'
      // Cada parte en su propio span: unidas en un solo nodo de texto, el gap
      // del flex no aplica y se leia "18150ms1 tok/s20.2s".
      var partes = ['<span class="' + clase + '">' + esc(quien) + '</span>']
      if (m.ttft !== null) partes.push('<span>first token ' + m.ttft + 'ms</span>')
      if (m.tps) partes.push('<span>' + m.tps + ' tok/s</span>')
      partes.push('<span>' + m.secs + 's total</span>')
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

      var sel = document.getElementById('model')
      var soloLocal = document.getElementById('localonly').checked
      var modelo = sel.value === 'auto' ? autoModelId() : sel.value

      msgs.push({ role: 'user', content: texto })
      var slot = { role: 'assistant', content: '', meta: null, streaming: true }
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

        var resp = await authFetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({ model: modelo, messages: historial, stream: true, local: soloLocal })
        })

        if (!resp.ok) {
          var msj = 'HTTP ' + resp.status
          try {
            var b = await resp.json()
            if (b && b.error && b.error.message) msj = b.error.message
          } catch (e) { /* el cuerpo no era JSON: queda el status */ }
          slot.content = '[error] ' + msj
          return
        }

        // Quien contesto viaja en headers, no en el cuerpo: ver
        // provenanceHeaders() en gateway.mjs.
        var operador = decodeURIComponent(resp.headers.get('X-Pyrus-Operator') || '') || 'unknown node'
        var tipo = resp.headers.get('X-Pyrus-Kind') || 'real'

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
          ttft: ttft,
          tps: ttft !== null && total > 0 ? Math.round(toks / total) : 0,
          secs: total.toFixed(1)
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
    document.getElementById('localonly').addEventListener('change', paintOptions)
    document.getElementById('model').addEventListener('change', function () {
      userPicked = true
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
        var r = await fetch('/v1/nodes')
        var j = await r.json()
        nodes = j.nodes || []
        paintOptions()
      } catch (e) { /* el poll siguiente reintenta */ }
    }

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
        <label class="chk"><input type="checkbox" id="localonly"> Local only</label>
        <button class="ghost" id="new" style="margin:0;padding:.25rem .6rem;font-size:.78rem">New chat</button>
        <span class="note" id="routing"></span>
      </div>
      <div class="row">
        <textarea id="prompt" rows="1" placeholder="Ask anything..."></textarea>
        <button id="send">Send</button>
        <button id="stop" class="ghost" style="display:none">Stop</button>
      </div>
    </div>
  </div>

  <script>
${ESC}
${CHAT_JS}
  </script>
  `,
  'chatpage'
)

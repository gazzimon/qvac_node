// Los 3 paneles del marketplace simulado, como strings HTML puros.
//
// Van embebidos en JS (no como archivos .html sueltos en /public) a proposito:
// bare-pack arma el binario standalone siguiendo el grafo de imports de
// bin.mjs, y un archivo estatico fuera de ese grafo no viaja con el binario.
// Un string exportado si viaja, sin tener que resolver paths a mano ni
// depender de bare-fs para servir contenido estatico.

const NAV = `
<nav class="nav">
  <span class="brand">QVAC · marketplace</span>
  <a href="/">Cliente</a>
  <a href="/proveedor">Proveedor</a>
  <a href="/admin">Admin</a>
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

function page(title, body) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${STYLE}
</head>
<body>
  ${NAV}
  <main>${body}</main>
</body>
</html>`
}

export const CLIENTE_HTML = page(
  'QVAC Marketplace · Cliente',
  `
  <h1>Marketplace de inferencias</h1>
  <p class="sub">Elegí un proveedor y chateá acá mismo, o conectate desde Telegram, tu terminal o cualquier cliente OpenAI-compatible. La inferencia corre en su nodo, no en un datacenter central.</p>
  <p class="hint" id="buscando" style="display:none"></p>
  <div id="grid" class="grid"></div>
  <div id="modal"></div>

  <div id="chat" class="chat" style="display:none">
    <h3>Chat con <span id="chat-target"></span></h3>
    <textarea id="prompt" placeholder="Escribí tu prompt..."></textarea>
    <button id="send">Enviar</button>
    <pre id="out" class="response"></pre>
    <div id="meta" class="meta" style="display:none"></div>
  </div>

  <script>
    let selected = null
    let nodesById = {}

    // Tres clases de nodo, y la diferencia importa demasiado para taparla con
    // un booleano: 'peer' es un nodo REMOTO de verdad, descubierto por el
    // swarm y con su manifiesto firmado verificado. Antes caia en el mismo
    // 'simulado' que los mocks -- justo al revés de lo que pasa.
    const KIND_LABEL = {
      real: 'nodo real (este equipo)',
      peer: 'par P2P verificado',
      mock: 'simulado'
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
          <span class="badge offline" data-offline style="display:none">fuera de línea</span>
          <div class="state" data-state></div>
          <div class="bar-row" data-load style="display:none"><div class="bar"><div data-fill></div></div><span class="pct"></span></div>
          <div class="actions">
            <button data-chat="\${esc(n.id)}">Chatear acá</button>
            <button class="ghost" data-conn="\${esc(n.id)}">Conectar…</button>
          </div>
        </div>
      \`).join('')
      document.querySelectorAll('.card').forEach(el => {
        el.addEventListener('click', () => selectNode(el.dataset.id))
      })
      // stopPropagation en los dos: sin esto el click sube a la tarjeta y
      // "Conectar" ademas seleccionaba el nodo y scrolleaba al chat.
      document.querySelectorAll('[data-chat]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          selectNode(el.dataset.chat)
          document.getElementById('chat').scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      })
      document.querySelectorAll('[data-conn]').forEach(el => {
        el.addEventListener('click', ev => {
          ev.stopPropagation()
          abrirConexion(el.dataset.conn)
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
      hint.innerHTML = 'Buscando proveedores en la DHT… <b><span id="seg"></span>s</b>'
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
        card.classList.toggle('selected', selected === n.id)

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
            ? 'Ocupado · ' + activos + '/' + tope
            : ocupado
              ? 'Atendiendo · ' + activos + '/' + tope
              : 'Disponible'
          if (ocupado) {
            const fill = load.querySelector('[data-fill]')
            fill.style.width = n.loadPct + '%'
            fill.style.background = barColor(n.loadPct)
            load.querySelector('.pct').textContent = n.loadPct + '%'
          }
        }
      }
    }

    function selectNode(id) {
      selected = id
      const n = nodesById[id]
      if (!n) return
      document.getElementById('chat').style.display = 'block'
      document.getElementById('chat-target').textContent = n.operator + ' · ' + n.displayName
      render(Object.values(nodesById))
    }

    // -----------------------------------------------------------------------
    // "Conectar": el mismo nodo, consumido desde afuera del panel.
    //
    // Es la prueba de que esto es un gateway OpenAI-compatible de verdad y no
    // un chat con nuestro protocolo adentro: el comando que se copia aca es el
    // que usaria cualquier cliente de terceros, sin camino privilegiado.
    // -----------------------------------------------------------------------

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

    function recetas(c) {
      const modelo = c.node.modelId
      const proveedorQvac = [
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
        '    telegram: {',
        '      enabled: true,',
        '      botToken: "PEGA_ACA_EL_TOKEN_DE_BOTFATHER",',
        '      dmPolicy: "pairing"',
        '    }',
        '  }',
        '}'
      ].join('\\n')

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
          estado: true,
          pasos: [
            { texto: 'Levantá el contenedor apuntado a este gateway:', cmd: 'docker run -d -p 3000:8080 \\\\\\n  -e OPENAI_API_BASE_URL=' + c.baseUrl + ' \\\\\\n  -e OPENAI_API_KEY=' + c.apiKey + ' \\\\\\n  -v open-webui:/app/backend/data \\\\\\n  --name open-webui ghcr.io/open-webui/open-webui:main' },
            { texto: 'Abrí <a href="http://localhost:3000" target="_blank" rel="noopener">localhost:3000</a> y elegí el modelo <code>' + modelo + '</code>.' }
          ]
        }
      }
    }

    let webuiPoll = null

    function cerrarModal() {
      clearInterval(webuiPoll)
      webuiPoll = null
      document.getElementById('modal').innerHTML = ''
      document.removeEventListener('keydown', onEsc)
    }

    function onEsc(ev) { if (ev.key === 'Escape') cerrarModal() }

    // Open WebUI corre en OTRO origen, asi que un fetch normal da CORS aunque
    // el servicio este arriba. Con mode:no-cors la respuesta es opaca -no se
    // puede leer- pero la promesa resuelve si el puerto contesta y rechaza si
    // no: alcanza para "esta arriba o no", que es lo unico que se pregunta.
    async function webuiArriba() {
      try {
        await fetch('http://localhost:3000/', { mode: 'no-cors', cache: 'no-store' })
        return true
      } catch {
        return false
      }
    }

    function pintarEstadoWebui(arriba) {
      const el = document.getElementById('webui-dot')
      if (!el) return
      el.className = 'dot ' + (arriba ? 'up' : 'down')
      el.innerHTML = '<i></i>' + (arriba ? 'Open WebUI responde en localhost:3000' : 'Open WebUI todavía no responde')
    }

    function pintarTab(rs, clave) {
      document.querySelectorAll('.tabs button').forEach(b => {
        b.classList.toggle('on', b.dataset.tab === clave)
      })
      const r = rs[clave]
      const cuerpo = document.getElementById('tab-body')
      cuerpo.innerHTML =
        (r.estado ? '<p><span class="dot" id="webui-dot"><i></i>chequeando…</span></p>' : '') +
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

      clearInterval(webuiPoll)
      webuiPoll = null
      if (r.estado) {
        webuiArriba().then(pintarEstadoWebui)
        webuiPoll = setInterval(() => webuiArriba().then(pintarEstadoWebui), 3000)
      }
    }

    async function abrirConexion(id) {
      let c
      try {
        const r = await fetch('/v1/connection/' + encodeURIComponent(id), { method: 'POST' })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        c = await r.json()
      } catch (err) {
        alert('No se pudo generar la conexión: ' + (err && err.message ? err.message : err))
        return
      }

      const rs = recetas(c)
      document.getElementById('modal').innerHTML = \`
        <div class="modal-overlay" id="modal-overlay">
          <div class="modal">
            <h3>Conectar con \${esc(c.node.operator)}</h3>
            <p class="sub">
              Mismo nodo, consumido desde afuera del panel.
              Tu API key: <code>\${esc(c.apiKey)}</code>
            </p>
            <div class="tabs">
              <button data-tab="telegram">Telegram</button>
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

    async function refresh() {
      const r = await fetch('/v1/nodes')
      const { nodes } = await r.json()
      render(nodes)
    }

    async function send() {
      if (!selected) return
      const prompt = document.getElementById('prompt').value.trim()
      if (!prompt) return
      const out = document.getElementById('out')

      // El nodo elegido pudo desaparecer entre el click y el Enviar: si el par
      // se desconecta, el poll lo saca de la grilla y esto quedaba undefined.
      const nodo = nodesById[selected]
      if (!nodo) {
        out.textContent = '[error] el proveedor que elegiste ya no está conectado'
        return
      }

      out.textContent = ''
      const btn = document.getElementById('send')
      btn.disabled = true

      // D7 del lado del cliente. Sin estos numeros la respuesta aparece y nada
      // prueba que se genero en otra maquina: la linea de abajo es la
      // evidencia de la demo, no un adorno.
      const t0 = Date.now()
      let primerTokenMs = null
      let tokens = 0
      const metaEl = document.getElementById('meta')
      metaEl.style.display = 'none'
      metaEl.textContent = ''

      const pintarMeta = () => {
        const total = ((Date.now() - t0) / 1000).toFixed(1)
        const partes = [
          (nodo.kind === 'peer' ? 'respondió ' : 'local · ') + nodo.operator,
          tokens + ' tokens',
          primerTokenMs === null ? 'sin respuesta' : 'primer token ' + primerTokenMs + 'ms',
          total + 's total'
        ]
        metaEl.textContent = ''
        partes.forEach((p, i) => {
          const el = document.createElement(i === 0 && nodo.kind === 'peer' ? 'b' : 'span')
          el.textContent = p
          metaEl.appendChild(el)
        })
        metaEl.style.display = ''
      }

      try {
        const resp = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Forma OpenAI, igual que la que manda cualquier cliente de terceros.
          // El panel no tiene un camino privilegiado: si esto anda, un curl con
          // el mismo body tambien anda.
          body: JSON.stringify({
            model: nodesById[selected].modelId,
            messages: [{ role: 'user', content: prompt }],
            stream: true
          })
        })

        // Un error del gateway NO viene en formato SSE, viene como JSON con el
        // status HTTP correspondiente. Sin este chequeo, el parser de abajo
        // descarta cada linea que no empiece con "data: " y el usuario ve la
        // pantalla vacia: apretar Enviar contra un nodo caido no mostraba nada.
        if (!resp.ok) {
          let msg = 'HTTP ' + resp.status
          try {
            const body = await resp.json()
            // Forma OpenAI: { error: { message, type, code } }. Antes esto leia
            // error como string y mostraba "[object Object]".
            // (Ojo: nada de backticks en estos comentarios, viven adentro de
            // un template literal y lo cierran en el medio.)
            if (body && body.error && body.error.message) msg = body.error.message
          } catch { /* el cuerpo no era JSON: queda el status */ }
          out.textContent = '[error] ' + msg
          return
        }
        if (!resp.body) {
          out.textContent = '[error] el gateway no devolvio cuerpo de respuesta'
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\\n\\n')
          buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') continue
            const ev = JSON.parse(payload)
            // Un error a mitad de stream viaja por el mismo canal SSE: ya se
            // mandaron los headers 200, no hay status HTTP que corregir.
            if (ev.error) {
              out.textContent += '\\n[error] ' + (ev.error.message || ev.error)
              continue
            }
            // chat.completion.chunk: el primer chunk trae solo {role} y el
            // ultimo solo {finish_reason}. Ninguno de los dos tiene content.
            const delta = ev.choices && ev.choices[0] && ev.choices[0].delta
            const trozo = (delta && delta.content) || ''
            if (trozo) {
              if (primerTokenMs === null) primerTokenMs = Date.now() - t0
              tokens++
            }
            out.textContent += trozo
          }
        }
      } catch (err) {
        // Si el gateway se cae a mitad de stream, esto es lo unico que separa
        // "hubo un error" de "la respuesta se corto sola y nadie avisa".
        out.textContent += '\\n[error] ' + (err && err.message ? err.message : String(err))
      } finally {
        btn.disabled = false
        // Se pinta aun si hubo error: "0 tokens / sin respuesta" es informacion
        // util cuando el nodo se cae a mitad de stream (D3/D4 de Fase 5).
        pintarMeta()
      }
    }

    document.getElementById('send').addEventListener('click', send)
    // El poll pisa el grid entero, asi que si falla no puede tumbar el panel.
    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 3000)
  </script>
  `
)

export const PROVEEDOR_HTML = page(
  'QVAC Marketplace · Proveedor',
  `
  <h1>Panel de proveedor</h1>
  <p class="sub">Así ve su propio nodo quien ofrece la inferencia: estado, carga y precio.</p>

  <div class="field">
    <label>Tu nodo</label>
    <select id="node-select"></select>
  </div>

  <div id="detail"></div>

  <script>
    let nodesById = {}
    let current = null
    let shellFor = null // para que nodo esta armado el DOM de #detail
${ESC}

    // El detalle se arma UNA vez por nodo y despues solo se actualizan los
    // textos que cambian.
    //
    // Antes se hacia innerHTML entero en cada refresh (cada 2.5s), lo que
    // borraba el precio que el proveedor estaba tipeando y le sacaba el foco:
    // medido, escribir "0.007 QVAC / 1K tok" y a los 3.2s el input habia
    // vuelto solo al valor viejo. Con el poll corriendo era imposible cargar
    // un precio a velocidad humana.
    function buildShell(n) {
      document.getElementById('detail').innerHTML = \`
        <div class="card" style="cursor:default">
          <span class="badge \${esc(n.status)}" id="d-badge"></span>
          <h3 id="d-name"></h3>
          <div class="op" id="d-op"></div>
          <div class="tags" id="d-tags"></div>
          <p>Carga actual: <b id="d-pct"></b> <span id="d-req"></span></p>
        </div>
        <div class="field">
          <label>Precio publicado</label>
          <input type="text" id="pricing">
        </div>
        <button id="save-pricing">Guardar precio</button>
        <button id="toggle" class="ghost"></button>
      \`
      document.getElementById('save-pricing').addEventListener('click', savePricing)
      document.getElementById('toggle').addEventListener('click', toggleStatus)
      shellFor = n.id
    }

    function renderDetail() {
      const n = nodesById[current]
      if (!n) return
      if (shellFor !== n.id) buildShell(n)

      const badge = document.getElementById('d-badge')
      badge.className = 'badge ' + n.status
      badge.textContent = n.status === 'online' ? 'en línea' : 'fuera de línea'
      document.getElementById('d-name').textContent = n.displayName
      document.getElementById('d-op').textContent = n.operator
      document.getElementById('d-tags').innerHTML =
        n.tags.map(t => \`<span class="tag">\${esc(t)}</span>\`).join('')
      document.getElementById('d-pct').textContent =
        n.loadPct === null ? '—' : n.loadPct + '%'
      document.getElementById('d-req').textContent =
        '(' + n.activeRequests + '/' + n.maxConcurrentRequests + ' requests activos)'
      document.getElementById('toggle').textContent =
        n.status === 'online' ? 'Ponerme fuera de línea' : 'Volver a estar en línea'

      // Lo unico que el usuario edita: solo se pisa si NO lo esta tocando.
      const input = document.getElementById('pricing')
      if (document.activeElement !== input) input.value = n.pricing
    }

    let optionsKey = null

    async function refresh() {
      const r = await fetch('/v1/nodes')
      const { nodes } = await r.json()
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      if (!current) current = nodes[0]?.id

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

    async function savePricing() {
      const input = document.getElementById('pricing')
      const pricing = input.value
      // Sin el blur, el input sigue teniendo el foco y el refresh de abajo no
      // lo actualiza: quedaria mostrando lo tipeado aunque el server lo haya
      // recortado a 60 chars, y no se veria que quedo guardado de verdad.
      input.blur()
      await fetch('/v1/nodes/' + encodeURIComponent(current), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing })
      })
      await refresh()
    }

    async function toggleStatus() {
      const status = nodesById[current].status === 'online' ? 'offline' : 'online'
      await fetch('/v1/nodes/' + encodeURIComponent(current), {
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

    refresh().catch(() => {})
    setInterval(() => refresh().catch(() => {}), 2500)
  </script>
  `
)

export const ADMIN_HTML = page(
  'QVAC Marketplace · Admin',
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
            await fetch('/v1/nodes/' + id + '/kick', { method: 'POST' })
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

    async function refreshLog() {
      const r = await fetch('/v1/routing-log')
      const { log } = await r.json()
      document.getElementById('log').innerHTML = log.length
        ? log.map(e => \`<div>\${esc(new Date(e.ts).toLocaleTimeString())} — \${esc(e.modelId)} → \${esc(e.operator)} (\${esc(e.ms)}ms) <span class="muted">\${esc(e.reason)}</span></div>\`).join('')
        : '<div class="muted">todavía no hay requests ruteados</div>'
    }

    refreshNodes().catch(() => {})
    refreshLog().catch(() => {})
    setInterval(() => refreshNodes().catch(() => {}), 2500)
    setInterval(() => refreshLog().catch(() => {}), 2500)
  </script>
  `
)

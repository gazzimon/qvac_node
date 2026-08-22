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
  <a href="/skills">Skills</a>
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
  .card h3 { margin: 0 0 .3rem; font-size: 1rem; }
  .tags { display: flex; flex-wrap: wrap; gap: .3rem; margin: .4rem 0; }
  .tag {
    font-size: .72rem; background: #232838; color: #a9b4cc;
    padding: .1rem .5rem; border-radius: 999px;
  }
  .op { color: #8b93a7; font-size: .8rem; }
  .price { font-size: .82rem; color: #d7dbe4; margin-top: .3rem; }
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
  .keybox {
    display: flex; align-items: center; gap: .6rem; background: #171a21;
    border: 1px solid #262b36; border-radius: 10px; padding: .7rem 1rem;
    margin-bottom: 1.5rem; flex-wrap: wrap;
  }
  .keybox code {
    background: #10131a; padding: .3rem .6rem; border-radius: 6px;
    font-size: .82rem; color: #9fd6ff;
  }
  .keybox button { margin-top: 0; padding: .4rem .8rem; font-size: .8rem; }
  .card-actions { display: flex; gap: .4rem; margin-top: .7rem; flex-wrap: wrap; }
  .card-actions button { margin-top: 0; padding: .35rem .7rem; font-size: .78rem; }
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.6);
    display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 10;
  }
  .modal {
    background: #171a21; border: 1px solid #262b36; border-radius: 12px;
    padding: 1.3rem; max-width: 560px; width: 100%;
  }
  .modal h3 { margin-top: 0; }
  .modal pre {
    white-space: pre-wrap; background: #10131a; border: 1px solid #262b36;
    border-radius: 8px; padding: .8rem; font-size: .8rem; overflow-x: auto;
  }
  .tool-cat { font-size: .7rem; padding: .1rem .5rem; border-radius: 999px; background: #2a2440; color: #c7a9ff; }
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
  <p class="sub">Elegí un proveedor y conectate. Conectar te genera una API key para ese nodo y te deja listo para chatear desde Hermes Agent (o tu propia terminal) — el chat en sí no pasa por acá.</p>

  <div id="grid" class="grid"></div>

  <div id="hermes-modal"></div>

  <script>
    let nodesById = {}
${ESC}

    function closeModal() {
      clearInterval(webuiPoll)
      webuiPoll = null
      document.getElementById('hermes-modal').innerHTML = ''
    }

    function showModal(html) {
      document.getElementById('hermes-modal').innerHTML = html
      const overlay = document.getElementById('modal-overlay')
      const close = document.getElementById('close-modal')
      if (close) close.addEventListener('click', closeModal)
      if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal() })
    }

    async function fetchConnection(nodeId) {
      const r = await fetch('/v1/hermes/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId })
      })
      const data = await r.json()
      if (!r.ok) { alert(data.error || 'no se pudo conectar'); return null }
      return data
    }

    async function connectTerminal(nodeId) {
      const data = await fetchConnection(nodeId)
      if (!data) return
      const curl = \`curl \${location.origin}/v1/chat/completions -H "Authorization: Bearer \${data.apiKey}" -H "Content-Type: application/json" -d '{"modelId":"\${data.node.modelId}","prompt":"hola"}'\`
      showModal(\`
        <div class="modal-overlay" id="modal-overlay">
          <div class="modal">
            <h3>Conectado a \${data.node.displayName}</h3>
            <p class="sub">API key nueva para este nodo. Con Hermes Agent -historial, tools y memoria ya resueltos-: pegá esto en tu terminal.</p>
            <pre>\${data.command}</pre>
            <button id="copy-hermes">Copiar comando de Hermes</button>
            <p class="sub" style="margin-top:1rem">¿Preferís curl directo?</p>
            <pre>\${curl}</pre>
            <button id="copy-curl" class="ghost">Copiar curl</button>
            <button id="close-modal" class="ghost">Cerrar</button>
          </div>
        </div>
      \`)
      document.getElementById('copy-hermes').addEventListener('click', () => navigator.clipboard.writeText(data.command))
      document.getElementById('copy-curl').addEventListener('click', () => navigator.clipboard.writeText(curl))
    }

    let webuiPoll = null

    async function isWebUIUp() {
      try {
        // no-cors: no podemos leer la respuesta, pero si el fetch no tira
        // excepcion es porque HAY algo escuchando en el puerto.
        await fetch('http://localhost:3000/', { mode: 'no-cors', cache: 'no-store' })
        return true
      } catch {
        return false
      }
    }

    function setWebUIStatus(up) {
      const el = document.getElementById('webui-status')
      const openBtn = document.getElementById('open-webui')
      if (!el) return
      if (up) {
        el.innerHTML = '<span class="badge online">● corriendo en localhost:3000</span>'
        openBtn.disabled = false
      } else {
        el.innerHTML = '<span class="badge offline">○ todavía no responde en localhost:3000</span>'
        openBtn.disabled = false // se deja clickeable igual, por si el check da falso negativo
      }
    }

    async function connectWebUI(nodeId) {
      const data = await fetchConnection(nodeId)
      if (!data) return
      showModal(\`
        <div class="modal-overlay" id="modal-overlay">
          <div class="modal">
            <h3>Chat web para \${data.node.displayName}</h3>
            <p class="sub">Abre <b>Open WebUI</b> -self-hosted, con cara de ChatGPT, sí tiene UI web de verdad- ya apuntado a este nodo. Necesita Docker Desktop <b>corriendo</b>.</p>
            <p class="sub"><b>Paso 1</b> — corré esto en tu terminal (una sola vez; la primera vez tarda ~1 min en bajar la imagen):</p>
            <pre>\${data.openWebuiCommand}</pre>
            <button id="copy-webui">Copiar comando</button>
            <p class="sub" style="margin-top:1rem"><b>Paso 2</b> — cuando esté listo, abrilo: <span id="webui-status">verificando…</span></p>
            <button id="open-webui" class="ghost">Abrir chat web →</button>
            <button id="recheck-webui" class="ghost">Volver a chequear</button>
            <button id="close-modal" class="ghost">Cerrar</button>
          </div>
        </div>
      \`)
      document.getElementById('copy-webui').addEventListener('click', () => navigator.clipboard.writeText(data.openWebuiCommand))
      document.getElementById('open-webui').addEventListener('click', () => window.open(data.openWebuiUrl, '_blank'))
      document.getElementById('recheck-webui').addEventListener('click', async () => setWebUIStatus(await isWebUIUp()))

      clearInterval(webuiPoll)
      isWebUIUp().then(setWebUIStatus)
      webuiPoll = setInterval(async () => setWebUIStatus(await isWebUIUp()), 3000)
    }

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
        <div class="card" style="cursor:default" data-id="\${esc(n.id)}">
          <span class="badge \${esc(n.kind)}">\${n.kind === 'real' ? 'nodo real' : 'simulado'}</span>
          <h3>\${esc(n.displayName)}</h3>
          <div class="op">\${esc(n.operator)}</div>
          <div class="tags">\${n.tags.map(t => \`<span class="tag">\${esc(t)}</span>\`).join('')}</div>
          <div class="price" data-price></div>
          <span class="badge offline" data-offline style="display:none">fuera de línea</span>
          <div class="bar-row" data-load><div class="bar"><div data-fill></div></div><span class="pct"></span></div>
          <div class="card-actions">
            <button class="terminal-btn" data-id="\${esc(n.id)}">Conectar con tu terminal</button>
            <button class="webui-btn ghost" data-id="\${esc(n.id)}">Abrir chat web</button>
          </div>
        </div>
      \`).join('')
      document.querySelectorAll('.terminal-btn').forEach(el => {
        el.addEventListener('click', () => connectTerminal(el.dataset.id))
      })
      document.querySelectorAll('.webui-btn').forEach(el => {
        el.addEventListener('click', () => connectWebUI(el.dataset.id))
      })
    }

    function render(nodes) {
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
        card.querySelector('[data-price]').textContent = n.pricing

        // Se muestra uno u otro, sin recrear nodos: asi la transicion CSS de
        // la barra anima de verdad en vez de reiniciarse en cada poll.
        const load = card.querySelector('[data-load]')
        const offline = card.querySelector('[data-offline]')
        const caido = n.loadPct === null
        load.style.display = caido ? 'none' : ''
        offline.style.display = caido ? '' : 'none'
        if (!caido) {
          const fill = load.querySelector('[data-fill]')
          fill.style.width = n.loadPct + '%'
          fill.style.background = barColor(n.loadPct)
          load.querySelector('.pct').textContent = n.loadPct + '%'
        }
      }
    }

    async function refresh() {
      const r = await fetch('/v1/models')
      const { nodes } = await r.json()
      render(nodes)
    }

    // El poll pisa solo los numeros (ver render/buildGrid), asi que si falla
    // no puede tumbar el panel.
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
      const r = await fetch('/v1/models')
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
      const r = await fetch('/v1/models')
      const { nodes } = await r.json()
      document.getElementById('rows').innerHTML = nodes.map(n => \`
        <tr>
          <td>\${esc(n.displayName)}</td>
          <td class="muted">\${esc(n.operator)}</td>
          <td><span class="badge \${esc(n.kind)}">\${esc(n.kind)}</span></td>
          <td><span class="badge \${esc(n.status)}">\${n.status === 'online' ? 'en línea' : 'fuera de línea'}</span></td>
          <td>\${n.loadPct === null ? '—' : n.loadPct + '% (' + n.activeRequests + '/' + n.maxConcurrentRequests + ')'}</td>
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

export const SKILLS_HTML = page(
  'QVAC Marketplace · Skills',
  `
  <h1>Skills &amp; Tools</h1>
  <p class="sub">Catálogo de tools que declaran los proveedores conectados. <b>Todavía es solo catálogo</b> — ningún tool se ejecuta de verdad en este track, ver <code>security.toolCallPolicy</code> del manifiesto.</p>

  <table>
    <thead>
      <tr><th>Tool</th><th>Descripción</th><th>Proveedor</th><th></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <script>
    async function refresh() {
      const r = await fetch('/v1/tools')
      const { tools } = await r.json()
      document.getElementById('rows').innerHTML = tools.length
        ? tools.map(t => \`
          <tr>
            <td>\${t.name}</td>
            <td class="muted">\${t.description}</td>
            <td>\${t.displayName} <span class="muted">— \${t.operator}</span></td>
            <td><span class="tool-cat">catálogo, no ejecuta</span></td>
          </tr>
        \`).join('')
        : '<tr><td class="muted" colspan="4">sin tools declaradas</td></tr>'
    }
    refresh()
    setInterval(refresh, 4000)
  </script>
  `
)

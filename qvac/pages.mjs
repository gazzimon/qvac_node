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
</style>`

function barColor(pct) {
  if (pct === null) return '#3a3f4d'
  if (pct < 50) return '#4ade80'
  if (pct < 80) return '#fbbf24'
  return '#f87171'
}

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
  <p class="sub">Elegí un proveedor y mandale un prompt. La inferencia corre en su nodo, no en un datacenter central.</p>
  <div id="grid" class="grid"></div>

  <div id="chat" class="chat" style="display:none">
    <h3>Chat con <span id="chat-target"></span></h3>
    <textarea id="prompt" placeholder="Escribí tu prompt..."></textarea>
    <button id="send">Enviar</button>
    <pre id="out" class="response"></pre>
  </div>

  <script>
    let selected = null
    let nodesById = {}

    function bar(pct) {
      if (pct === null) return '<span class="badge offline">fuera de línea</span>'
      const color = pct < 50 ? '#4ade80' : pct < 80 ? '#fbbf24' : '#f87171'
      return \`<div class="bar-row"><div class="bar"><div style="width:\${pct}%;background:\${color}"></div></div><span class="pct">\${pct}%</span></div>\`
    }

    function render(nodes) {
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      document.getElementById('grid').innerHTML = nodes.map(n => \`
        <div class="card \${selected === n.id ? 'selected' : ''}" data-id="\${n.id}">
          <span class="badge \${n.kind}">\${n.kind === 'real' ? 'nodo real' : 'simulado'}</span>
          <h3>\${n.displayName}</h3>
          <div class="op">\${n.operator}</div>
          <div class="tags">\${n.tags.map(t => \`<span class="tag">\${t}</span>\`).join('')}</div>
          <div class="price">\${n.pricing}</div>
          \${bar(n.loadPct)}
        </div>
      \`).join('')
      document.querySelectorAll('.card').forEach(el => {
        el.addEventListener('click', () => selectNode(el.dataset.id))
      })
    }

    function selectNode(id) {
      selected = id
      const n = nodesById[id]
      document.getElementById('chat').style.display = 'block'
      document.getElementById('chat-target').textContent = n.displayName + ' (' + n.operator + ')'
      render(Object.values(nodesById))
    }

    async function refresh() {
      const r = await fetch('/v1/models')
      const { nodes } = await r.json()
      render(nodes)
    }

    async function send() {
      if (!selected) return
      const prompt = document.getElementById('prompt').value.trim()
      if (!prompt) return
      const out = document.getElementById('out')
      out.textContent = ''
      const btn = document.getElementById('send')
      btn.disabled = true
      try {
        const resp = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: nodesById[selected].modelId, prompt })
        })
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
            const { delta, error } = JSON.parse(payload)
            if (error) { out.textContent += '\\n[error] ' + error; continue }
            out.textContent += delta || ''
          }
        }
      } finally {
        btn.disabled = false
      }
    }

    document.getElementById('send').addEventListener('click', send)
    refresh()
    setInterval(refresh, 3000)
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

    function renderDetail() {
      const n = nodesById[current]
      if (!n) return
      const pct = n.loadPct === null ? '—' : n.loadPct + '%'
      document.getElementById('detail').innerHTML = \`
        <div class="card" style="cursor:default">
          <span class="badge \${n.status}">\${n.status === 'online' ? 'en línea' : 'fuera de línea'}</span>
          <h3>\${n.displayName}</h3>
          <div class="op">\${n.operator}</div>
          <div class="tags">\${n.tags.map(t => \`<span class="tag">\${t}</span>\`).join('')}</div>
          <p>Carga actual: <b>\${pct}</b> (\${n.activeRequests}/\${n.maxConcurrentRequests} requests activos)</p>
        </div>
        <div class="field">
          <label>Precio publicado</label>
          <input type="text" id="pricing" value="\${n.pricing}">
        </div>
        <button id="save-pricing">Guardar precio</button>
        <button id="toggle" class="ghost">\${n.status === 'online' ? 'Ponerme fuera de línea' : 'Volver a estar en línea'}</button>
      \`
      document.getElementById('save-pricing').addEventListener('click', savePricing)
      document.getElementById('toggle').addEventListener('click', toggleStatus)
    }

    async function refresh() {
      const r = await fetch('/v1/models')
      const { nodes } = await r.json()
      nodesById = Object.fromEntries(nodes.map(n => [n.id, n]))
      if (!current) current = nodes[0]?.id
      const sel = document.getElementById('node-select')
      sel.innerHTML = nodes.map(n => \`<option value="\${n.id}" \${n.id === current ? 'selected' : ''}>\${n.displayName} — \${n.operator}</option>\`).join('')
      renderDetail()
    }

    async function savePricing() {
      const pricing = document.getElementById('pricing').value
      await fetch('/v1/nodes/' + current, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pricing })
      })
      refresh()
    }

    async function toggleStatus() {
      const status = nodesById[current].status === 'online' ? 'offline' : 'online'
      await fetch('/v1/nodes/' + current, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      })
      refresh()
    }

    document.getElementById('node-select').addEventListener('change', (e) => {
      current = e.target.value
      renderDetail()
    })

    refresh()
    setInterval(refresh, 2500)
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
    async function refreshNodes() {
      const r = await fetch('/v1/models')
      const { nodes } = await r.json()
      document.getElementById('rows').innerHTML = nodes.map(n => \`
        <tr>
          <td>\${n.displayName}</td>
          <td class="muted">\${n.operator}</td>
          <td><span class="badge \${n.kind}">\${n.kind}</span></td>
          <td><span class="badge \${n.status}">\${n.status === 'online' ? 'en línea' : 'fuera de línea'}</span></td>
          <td>\${n.loadPct === null ? '—' : n.loadPct + '% (' + n.activeRequests + '/' + n.maxConcurrentRequests + ')'}</td>
          <td>\${n.pricing}</td>
          <td><button class="\${n.status === 'online' ? 'danger' : 'ghost'}" data-id="\${n.id}" data-action="\${n.status === 'online' ? 'kick' : 'restore'}">\${n.status === 'online' ? 'Tirar' : 'Reactivar'}</button></td>
        </tr>
      \`).join('')
      document.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id
          const action = btn.dataset.action
          if (action === 'kick') {
            await fetch('/v1/nodes/' + id + '/kick', { method: 'POST' })
          } else {
            await fetch('/v1/nodes/' + id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'online' })
            })
          }
          refreshNodes()
        })
      })
    }

    async function refreshLog() {
      const r = await fetch('/v1/routing-log')
      const { log } = await r.json()
      document.getElementById('log').innerHTML = log.length
        ? log.map(e => \`<div>\${new Date(e.ts).toLocaleTimeString()} — \${e.modelId} → \${e.operator} (\${e.ms}ms) <span class="muted">\${e.reason}</span></div>\`).join('')
        : '<div class="muted">todavía no hay requests ruteados</div>'
    }

    refreshNodes()
    refreshLog()
    setInterval(refreshNodes, 2500)
    setInterval(refreshLog, 2500)
  </script>
  `
)

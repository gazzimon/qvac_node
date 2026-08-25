// Tests de INTEGRACION: levantan el gateway de verdad y le hablan por HTTP.
//
// Existen porque test/index.js prueba cada modulo aislado -- costs sin budget,
// routing sin store, quota sin provider -- y lo que se rompe al juntar dos
// ramas casi nunca es un modulo: es el cable entre dos.
//
// Todo corre en UN proceso y sin red: `createGateway` bindea 127.0.0.1 y el
// cliente es el mismo bare-http1 que usa el servidor. Lo que necesita dos
// maquinas sigue estando en docs/RUNBOOK-2-MAQUINAS.md, no aca.

const test = require('brittle')
const http = require('bare-http1')

// Un puerto alto y propio para no chocar con un nodo que el desarrollador
// tenga abierto en 8787 mientras corre los tests.
const PORT = 8899
const BASE = 'http://127.0.0.1:' + PORT

function pedir (metodo, ruta, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    const headers = {}
    let payload = null
    if (o.body !== undefined && o.body !== null) {
      payload = JSON.stringify(o.body)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    if (o.key) headers.Authorization = 'Bearer ' + o.key

    const req = http.request(BASE + ruta, { method: metodo, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (e) { /* HTML o SSE */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function esperar (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// El gateway se levanta UNA vez para toda la suite: arrancarlo por test haria
// que cada uno pelee por el puerto con el anterior que todavia esta cerrando.
let server = null
let KEY = null

test('arranca el gateway y entrega la key del panel', async (t) => {
  const { createGateway } = await import('../qvac/gateway.mjs')
  server = createGateway({ port: PORT, demo: true })

  // listen es asincrono: se espera al primer request que conteste.
  for (let i = 0; i < 50 && !KEY; i++) {
    try {
      const r = await pedir('GET', '/v1/keys/panel')
      if (r.json && r.json.key) KEY = r.json.key
    } catch (e) {
      await esperar(100)
    }
  }

  t.ok(KEY, 'el bootstrap de la key no pide key: sin eso no habria primer acceso')
  t.ok(KEY.startsWith('qvac_sk_'), 'con el prefijo que pone apikeys.mjs')
})

// ---------------------------------------------------------------------------
// Que las superficies de las fases 6.5, 6.6 y 8 respondan A LA VEZ. Cada una
// entro por un commit distinto y esto es lo que ninguna prueba sola.
// ---------------------------------------------------------------------------

test('las rutas de las tres fases conviven en el mismo proceso', async (t) => {
  const rutas = [
    ['/v1/models', 'catalogo OpenAI'],
    ['/v1/nodes', 'marketplace'],
    ['/v1/routing-log', 'rastro de ruteo (fase 8)'],
    ['/v1/quota', 'cuota gratuita (fase 6.6)']
  ]
  for (const par of rutas) {
    const r = await pedir('GET', par[0], { key: KEY })
    t.is(r.status, 200, par[0] + ' -> 200  (' + par[1] + ')')
  }
})

test('los cuatro paneles siguen renderizando', async (t) => {
  const rutas = ['/', '/node', '/network', '/admin']
  for (const ruta of rutas) {
    const r = await pedir('GET', ruta)
    t.is(r.status, 200, ruta + ' -> 200')
    t.ok(r.body.indexOf('<') !== -1, ruta + ' devuelve HTML')
  }
})

// ---------------------------------------------------------------------------
// El cable que mas importa: un chat tiene que dejar rastro en el ruteo Y en el
// ledger a la vez. Son dos modulos que entraron por commits distintos y que
// nunca se ejercitaron juntos.
// ---------------------------------------------------------------------------

test('un chat deja rastro de ruteo y liquida el presupuesto', async (t) => {
  const antes = await pedir('GET', '/v1/quota', { key: KEY })

  const chat = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(chat.status, 200)
  t.ok(chat.json.choices[0].message.content.length > 0, 'contesto algo')

  // Fase 8: la decision quedo escrita, con el motivo.
  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entradas = Array.isArray(log.json) ? log.json : (log.json.log || log.json.entries)
  const ultima = entradas[0]
  t.ok(ultima.reason, 'el log dice POR QUE se eligio: ' + ultima.reason)
  t.ok(ultima.decision, 'y con que carga lo decidio')
  t.is(ultima.decision.elegido, ultima.nodeId, 'la decision apunta al nodo que contesto')

  // Fase 6.5: el ledger liquido este request. Un mock cuesta cero y eso es la
  // verdad, no un relleno -- pero el CAMPO tiene que estar, o el rastro de la
  // fase 8.5 arranca con un agujero en las entradas viejas.
  t.is(typeof ultima.costMicros, 'number', 'el costo quedo registrado')

  // Fase 6.6: la cuota mide lo que este nodo le REGALA A PARES. Un chat propio
  // no consume cuota de nadie, y confundir las dos cosas seria cobrarle al
  // dueno de la maquina por usar su propia maquina.
  const despues = await pedir('GET', '/v1/quota', { key: KEY })
  t.is(
    despues.json.given_tokens,
    antes.json.given_tokens,
    'un chat propio no descuenta cuota de par'
  )
})

// ---------------------------------------------------------------------------
// Las puertas. Cada una se agrego en un commit distinto y ninguna prueba
// unitaria verifica que sigan cerradas cuando conviven.
// ---------------------------------------------------------------------------

test('las rutas que gastan o mutan siguen pidiendo la key', async (t) => {
  const chat = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(chat.status, 401, 'chat sin key -> 401')

  const conKeyMala = await pedir('POST', '/v1/chat/completions', {
    key: 'qvac_sk_inventada',
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conKeyMala.status, 401, 'una key que no existe tampoco pasa')

  // Sin swarm esta ruta corta con 503 antes de mirar la key. El 401 se
  // verifica con `serve --swarm` (S3 de NOTES-SATURACION.md); aca lo que
  // importa es que un anonimo NO logre editar el manifiesto.
  const manifiesto = await pedir('POST', '/v1/swarm/manifest', {
    body: { maxConcurrentRequests: 99 }
  })
  t.ok(
    manifiesto.status === 401 || manifiesto.status === 503,
    'el manifiesto no se edita anonimo (status ' + manifiesto.status + ')'
  )
})

// ---------------------------------------------------------------------------
// Las dos extensiones propias del request. `local` es vieja y `node` entro en
// la fase 8: lo que se prueba es que no se pisen.
// ---------------------------------------------------------------------------

test('el pin de maquina convive con local:true', async (t) => {
  const nodos = await pedir('GET', '/v1/nodes', { key: KEY })
  const mock = nodos.json.nodes.filter((n) => n.modelId === 'facturas-ar')[0]

  const fijado = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: {
      model: 'facturas-ar',
      messages: [{ role: 'user', content: 'hola' }],
      node: mock.id
    }
  })
  t.is(fijado.status, 200, 'fijar una maquina que existe contesta')

  const fantasma = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: {
      model: 'facturas-ar',
      messages: [{ role: 'user', content: 'hola' }],
      node: 'no-existe'
    }
  })
  t.is(fantasma.status, 404, 'y una que no existe NO cae a otra maquina')
  t.is(fantasma.json.error.code, 'node_not_found')

  // local:true sobre un modelo que solo sirve un mock local sigue siendo
  // valido: el filtro saca pares, no mocks de esta misma maquina.
  const soloLocal = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: {
      model: 'facturas-ar',
      messages: [{ role: 'user', content: 'h' }],
      local: true
    }
  })
  t.is(soloLocal.status, 200, 'local:true no rompe el request')
})

test('los headers de procedencia dicen que maquina contesto', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'traductor-en-es', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 200)
  t.ok(r.headers['x-pyrus-operator'], 'X-Pyrus-Operator presente')
  t.ok(r.headers['x-pyrus-kind'], 'X-Pyrus-Kind presente: ' + r.headers['x-pyrus-kind'])
})

// ---------------------------------------------------------------------------
// D5: nunca un cuelgue silencioso. Es la invariante mas vieja del gateway y la
// que mas facil se rompe cuando alguien agrega una rama de ruteo nueva.
// ---------------------------------------------------------------------------

test('un modelo que nadie sirve da 404 y dice cuales SI hay', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'modelo-que-no-existe', messages: [{ role: 'user', content: 'h' }] }
  })
  t.is(r.status, 404)
  t.is(r.json.error.code, 'model_not_found')
  t.ok(
    r.json.error.message.indexOf('disponibles') !== -1,
    'el error es accionable: ' + r.json.error.message.slice(0, 70)
  )
})

// El JS del chat vive dentro de un template literal, asi que una comilla
// invertida suelta en un comentario rompe la pagina entera sin que ningun test
// unitario se entere. Esto lo agarra: si la pagina no parsea, no renderiza.
test('el selector del chat ofrece los tres modos', async (t) => {
  const r = await pedir('GET', '/')
  t.is(r.status, 200)
  t.ok(r.body.indexOf('this machine only') !== -1, 'modo 1: solo esta maquina')
  t.ok(r.body.indexOf('Auto - best available node') !== -1, 'modo 2: el mejor disponible')
  t.ok(r.body.indexOf('Specific node') !== -1, 'modo 3: una maquina concreta')
  t.ok(r.body.indexOf('localonly') === -1, 'el checkbox se absorbio en el modo 1')
  // Una opcion por MAQUINA, no por modelo: es lo que hacia imposible elegir
  // entre dos pares sirviendo el mismo modelId.
  t.ok(r.body.indexOf('function fijables') !== -1, 'la lista ya no deduplica por modelId')
})

test('cierra el gateway sin dejar el puerto tomado', async (t) => {
  const { shutdownGateway } = await import('../qvac/gateway.mjs')
  await shutdownGateway()
  if (server) server.close()
  t.pass('apagado ordenado')
})

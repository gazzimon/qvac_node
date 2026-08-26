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

function pedir(metodo, ruta, opts) {
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
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(data)
        } catch (e) {
          /* HTML o SSE */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function esperar(ms) {
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
  const entradas = Array.isArray(log.json) ? log.json : log.json.log || log.json.entries
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

// ---------------------------------------------------------------------------
// FASE 8.5 — el asistente externo, de punta a punta
//
// El "proveedor externo" es un servidor de verdad levantado aca al lado, que
// habla el mismo SSE que la API de NVIDIA. No es un mock del cliente: el
// codigo bajo prueba abre un socket, manda el JSON, parsea los chunks y lee el
// `usage`. Lo unico que no se ejercita contra el proveedor real es la latencia.
//
// Pegarle a integrate.api.nvidia.com desde el test seria pagar dolares por
// correr `npm test` y dejar la suite atada a la red y a una credencial.
// ---------------------------------------------------------------------------

const PUERTO_EXTERNO = 8898
let servidorExterno = null
let ultimoPedidoExterno = null

// B2: un proveedor que NO manda `usage` no es un caso raro, es el default del
// protocolo -- `usage` en streaming hay que pedirlo-. Se apaga desde el test
// para poder ejercitar el modo de falla y no solo el camino feliz.
let mandaUsage = true

// B3: un proveedor que acepta la conexion y despues no manda nada. Es el caso
// que dejaba el request abierto para siempre -- y con el, la reserva del
// presupuesto que lo autorizo.
let seCuelga = false

// Un proveedor compatible con OpenAI en veinte lineas: dos deltas, un `usage`
// con tokens que NO coinciden con los contados de este lado -- a proposito,
// para probar que se liquida con los del proveedor -- y el [DONE].
function levantarProveedorFalso() {
  return new Promise((resolve) => {
    servidorExterno = http.createServer((req, res) => {
      let crudo = ''
      req.on('data', (c) => {
        crudo += c
      })
      req.on('end', () => {
        try {
          ultimoPedidoExterno = JSON.parse(crudo)
        } catch (e) {
          ultimoPedidoExterno = null
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (d) => res.write('data: ' + JSON.stringify(d) + '\n\n')
        // Cabecera mandada y despues silencio: el socket sigue vivo, asi que
        // nadie del otro lado se entera solo. Es lo que tiene que cortar el reloj.
        if (seCuelga) return
        chunk({ choices: [{ delta: { role: 'assistant' } }] })
        // `reasoning_content` en el MISMO delta que el contenido: si el cliente
        // lo leyera, el pensamiento del modelo saldria al chat.
        chunk({
          choices: [{ delta: { reasoning_content: 'primero pienso...', content: 'hola ' } }]
        })
        chunk({ choices: [{ delta: { content: 'desde afuera' } }] })
        if (mandaUsage) {
          chunk({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 1000, completion_tokens: 500 }
          })
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    servidorExterno.listen(PUERTO_EXTERNO, '127.0.0.1', () => resolve())
  })
}

const MODELO_EXTERNO = 'proveedor/modelo-de-prueba'

test('se configura un asistente externo como una fila mas del registro', async (t) => {
  await levantarProveedorFalso()

  const env = (await import('bare-env')).default
  env.PYRUS_TEST_KEY = 'clave-de-prueba'

  const upstream = await import('../qvac/upstream.mjs')
  const store = await import('../qvac/store.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'test',
        label: 'Proveedor de prueba',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: MODELO_EXTERNO,
            displayName: 'Modelo de prueba',
            maxTokens: 256,
            pricePerMTok: { input: 1, output: 2 }
          }
        ]
      }
    ]
  })

  t.is(ups.length, 1)
  t.ok(ups[0].disponible(), 'la credencial se lee del entorno, no de la config')

  // El precio va contra el id de la FILA, que es lo que mira claveDePrecio().
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: ups[0].model,
    displayName: ups[0].displayName,
    operator: 'Proveedor de prueba (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('GET', '/v1/nodes')
  const fila = r.json.nodes.find((n) => n.kind === 'upstream')
  t.ok(fila, 'aparece en el marketplace sin tocar el panel')
  t.is(fila.modelId, MODELO_EXTERNO)

  const modelos = await pedir('GET', '/v1/models')
  t.ok(
    modelos.json.data.some((m) => m.id === MODELO_EXTERNO),
    'y en /v1/models, que es lo que lee un cliente de terceros'
  )
})

test('sin opt-in el prompt NO sale a un tercero, y el error dice como prenderlo', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  gw.setUpstreamOptIn(false)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: MODELO_EXTERNO, messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 503)
  t.is(r.json.error.code, 'upstream_opt_in_required')
  t.ok(
    r.json.error.message.indexOf('opt-in') !== -1,
    'el error es accionable: ' + r.json.error.message.slice(0, 60)
  )
})

test('el opt-in se prende por HTTP y pide credencial', async (t) => {
  // B7: LEER el estado del externo tambien pide credencial. No lleva secretos
  // -- va el nombre de la variable de entorno, nunca su valor -- pero dice
  // quien es el proveedor y si hay una cuenta cargada del otro lado.
  const leerSinKey = await pedir('GET', '/v1/upstream')
  t.is(leerSinKey.status, 401, 'ni siquiera mirar el estado es publico')

  const leerConKey = await pedir('GET', '/v1/upstream', { key: KEY })
  t.is(leerConKey.status, 200)
  t.ok(leerConKey.json.upstreams[0].apiKeyEnv, 'va el NOMBRE de la variable...')
  t.absent(JSON.stringify(leerConKey.json).indexOf('clave-de-prueba') !== -1, '...y nunca su valor')

  const sinKey = await pedir('POST', '/v1/upstream/opt-in', { body: { enabled: true } })
  t.is(sinKey.status, 401, 'autorizar gasto no puede quedar abierto al puerto')

  const r = await pedir('POST', '/v1/upstream/opt-in', { key: KEY, body: { enabled: true } })
  t.is(r.status, 200)
  t.is(r.json.optIn, true)
  t.is(r.json.upstreams[0].credencial, true)
  t.absent(
    r.json.upstreams[0].apiKey,
    'el estado NUNCA devuelve el secreto, solo el nombre de la variable'
  )
  t.is(r.json.upstreams[0].apiKeyEnv, 'PYRUS_TEST_KEY')
})

test('con opt-in el externo contesta, y la respuesta dice que fue el externo', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: MODELO_EXTERNO, messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200)
  t.is(r.json.choices[0].message.content, 'hola desde afuera', 'llegan los deltas del proveedor')
  t.is(
    r.json.choices[0].message.content.indexOf('pienso'),
    -1,
    'y NO llega el reasoning_content: delataria al proveedor de atras'
  )

  // D19: la divulgacion va en los headers, que es lo que lee el chat.
  t.is(r.headers['x-pyrus-kind'], 'upstream', 'el header dice que salio de la maquina')
  t.is(
    decodeURIComponent(r.headers['x-pyrus-operator']),
    'Proveedor de prueba (externo)',
    'y dice a quien'
  )

  // El tope de salida lo impone el nodo aunque el cliente no mande max_tokens.
  t.is(ultimoPedidoExterno.max_tokens, 256, 'sin techo la reserva no acotaria nada')
  t.is(ultimoPedidoExterno.stream, true)
})

test('el rastro registra el externo con lo que costo de verdad', async (t) => {
  const r = await pedir('GET', '/v1/routing-log')
  const entrada = r.json.log.find((e) => e.target === 'upstream')

  t.ok(entrada, 'el ruteo al externo queda en el mismo rastro que el resto')
  t.is(entrada.ok, true)
  // 1000 tokens de entrada a USD 1/1M + 500 de salida a USD 2/1M = 2000 micros.
  // Los tokens son los del `usage` del proveedor, NO los deltas contados de
  // este lado: liquidar con los propios subfacturaria casi todo el request.
  t.is(entrada.costMicros, 2000, 'se liquida con el usage del proveedor')
})

test('local:true nunca sale a un tercero, con opt-in o sin el', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: MODELO_EXTERNO, messages: [{ role: 'user', content: 'hola' }], local: true }
  })

  t.is(r.status, 503)
  t.is(r.json.error.code, 'local_only', 'el candado gana aunque el opt-in este prendido')
})

test('agotado el presupuesto se contesta local, nunca el externo', async (t) => {
  const store = await import('../qvac/store.mjs')
  const budget = await import('../qvac/budget.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Un externo que sirve el MISMO modelo que un candidato local: es la unica
  // forma de que exista una alternativa a la que degradar.
  const compartido = 'facturas-ar'
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'caro',
        label: 'Proveedor caro',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [{ modelId: compartido, maxTokens: 256, pricePerMTok: { input: 1, output: 2 } }]
      }
    ]
  })
  // A proposito: el mock local sirve ESTE MISMO modelId. Si el precio se
  // indexara por modelo, el candidato local heredaria la tarifa del externo,
  // su reserva fallaria igual y en vez de degradar saldria un 402.
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: compartido,
    displayName: 'Modelo caro',
    operator: 'Proveedor caro (externo)',
    maxConcurrentRequests: 4
  })

  // Se satura el candidato local: sin esto el externo ni compite (D19).
  const propios = store.listNodes().filter((n) => n.modelId === compartido && n.kind !== 'upstream')
  for (const n of propios) {
    for (let i = 0; i < n.maxConcurrentRequests; i++) store.beginRequest(n.id)
  }

  // La cuenta contra la que se liquida NO es el nodeId de la key ('panel')
  // sino el id de la ENTRADA del registro de keys, que es lo que devuelve
  // cuentaDe(req). Ponerle el tope al string equivocado creaba una cuenta
  // fantasma con tope cero mientras la real seguia con los USD 20 del default
  // -- y el test pasaba por el camino que no queria probar.
  const apikeys = await import('../qvac/apikeys.mjs')
  const cuenta = apikeys.keyForNode('panel', 'web panel').id
  t.ok(cuenta, 'la cuenta sale del registro de keys, no del nodeId')

  // Tope en cero: no alcanza ni para un token.
  budget.setCap(cuenta, 0)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: compartido, messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'no se niega el servicio: se degrada')
  t.not(r.headers['x-pyrus-kind'], 'upstream', 'y NO fue el externo')

  const log = await pedir('GET', '/v1/routing-log')
  const entrada = log.json.log[0]
  t.ok(entrada.degradado, 'la degradacion queda auditada, no se confunde con una eleccion normal')
  t.ok(
    entrada.reason.indexOf('presupuesto agotado') !== -1,
    'y el motivo dice por que: ' + entrada.reason.slice(0, 60)
  )

  budget.setCap(cuenta, 20000000)
  for (const n of propios) {
    for (let i = 0; i < n.maxConcurrentRequests; i++) store.endRequest(n.id)
  }
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// B2 y B4 — los dos agujeros por los que el tope dejaba de ser un tope
// ---------------------------------------------------------------------------

test('el pedido al proveedor SIEMPRE pide usage, y la config no puede pisar el tope', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Una config hostil: pide diez mil tokens de salida y apaga el streaming.
  // Los dos campos son exactamente los que el nodo necesita controlar -- uno
  // acota la reserva, el otro es el formato que sabe parsear-.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'hostil',
        label: 'Config hostil',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'proveedor/hostil',
            maxTokens: 256,
            pricePerMTok: { input: 1, output: 2 },
            extraBody: {
              max_tokens: 10000,
              stream: false,
              stream_options: { include_usage: false },
              chat_template_kwargs: { enable_thinking: false }
            }
          }
        ]
      }
    ]
  })
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'proveedor/hostil',
    displayName: 'Hostil',
    operator: 'Config hostil (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/hostil', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 200)

  t.is(ultimoPedidoExterno.max_tokens, 256, 'gana el tope del nodo, no el de la config')
  t.is(ultimoPedidoExterno.stream, true, 'la config no puede apagar el streaming')
  t.is(
    ultimoPedidoExterno.stream_options.include_usage,
    true,
    'el usage lo pide el codigo: no es un campo que se pueda olvidar ni apagar'
  )
  t.alike(
    ultimoPedidoExterno.chat_template_kwargs,
    { enable_thinking: false },
    'y lo demas de la config sigue pasando: extiende, no sobreescribe'
  )

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('un proveedor que no manda usage se liquida por la reserva, no por los deltas', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  mandaUsage = false

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'mudo',
        label: 'Proveedor mudo',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'proveedor/mudo',
            maxTokens: 256,
            pricePerMTok: { input: 1, output: 2 }
          }
        ]
      }
    ]
  })
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'proveedor/mudo',
    displayName: 'Mudo',
    operator: 'Proveedor mudo (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/mudo', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 200, 'el request se contesta igual: esto no es un error del usuario')

  const log = await pedir('GET', '/v1/routing-log')
  const entrada = log.json.log[0]
  t.is(entrada.target, 'upstream')

  // La reserva: 'hola' son 4 bytes -> ceil(4/2) = 2 tokens de entrada a USD 1
  // por millon, mas los 256 de tope de salida a USD 2 por millon.
  //   2 * 1 + 256 * 2 = 514 micro-dolares.
  //
  // Liquidar con lo contado de este lado habria dado 4 micros -- dos deltas de
  // SSE a tarifa de salida, y la entrada gratis-: 128 veces menos. Ese era el
  // agujero: no un error de redondeo, dos ordenes de magnitud por request.
  t.is(entrada.costMicros, 514, 'se cobra la cota superior con la que se autorizo el gasto')

  mandaUsage = true
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// B3 — el gasto no puede sobrevivir al silencio del proveedor
// ---------------------------------------------------------------------------

test('un proveedor que se cuelga no deja el request colgado', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const budget = await import('../qvac/budget.mjs')
  const apikeys = await import('../qvac/apikeys.mjs')
  const gw = await import('../qvac/gateway.mjs')

  seCuelga = true

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'colgado',
        label: 'Proveedor colgado',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'proveedor/colgado',
            maxTokens: 256,
            pricePerMTok: { input: 1, output: 2 },
            // 300ms en vez de 60s: el reloj es el mismo, lo unico que cambia es
            // cuanto hay que esperar para verlo funcionar.
            timeoutPrimerChunkMs: 300
          }
        ]
      }
    ]
  })
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'proveedor/colgado',
    displayName: 'Colgado',
    operator: 'Proveedor colgado (externo)',
    maxConcurrentRequests: 4
  })

  const cuenta = apikeys.keyForNode('panel', 'web panel').id
  const antes = budget.usage(cuenta)

  const arranco = Date.now()
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/colgado', messages: [{ role: 'user', content: 'hola' }] }
  })
  const tardo = Date.now() - arranco

  t.ok(tardo < 5000, 'corta por el reloj, no por el fin del universo: ' + tardo + 'ms')
  t.is(r.status, 502, 'y el request TERMINA, con el error del proveedor')

  const despues = budget.usage(cuenta)
  t.is(despues.reserved, antes.reserved, 'la reserva se libero: no quedo saldo comprometido')
  t.is(despues.spent, antes.spent, 'y no se cobro nada: no llego un solo token')

  const log = await pedir('GET', '/v1/routing-log')
  const entrada = log.json.log[0]
  t.is(entrada.ok, false, 'el fallo queda en el rastro')
  t.is(entrada.costMicros, 0, 'cobrar la cota superior aca seria cobrar un request que no ocurrio')

  const nodo = store.listNodes().find((n) => n.id === 'upstream:' + ups[0].id)
  t.is(nodo.activeRequests, 0, 'y el slot del nodo tampoco quedo tomado')

  seCuelga = false
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('un motor local detras de HTTP contesta sin credencial y sin opt-in', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Se apaga el opt-in a proposito: si le aplicara, este test no pasaria. Es
  // toda la diferencia entre "upstream" y "tercero".
  gw.setUpstreamOptIn(false)

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'motor',
        label: 'Motor local',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'pesos-abiertos', as: 'modelo-compartido', maxTokens: 128 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: ups[0].anunciadoComo,
    displayName: 'Pesos abiertos',
    operator: 'Motor local (local)',
    local: true
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'modelo-compartido', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'contesta con el opt-in apagado: no es un tercero')
  t.is(r.json.choices[0].message.content, 'hola desde afuera')
  t.is(r.headers['x-pyrus-scope'], 'local', 'y lo declara: el prompt no salio de la maquina')
  t.is(r.headers['x-pyrus-kind'], 'upstream', 'aunque se le haya pedido por HTTP')

  // Sin Authorization: el proveedor local no lleva credencial y mandarle una
  // vacia seria peor que no mandar nada.
  t.absent(ultimoPedidoExterno.max_tokens > 128, 'respeta su propio tope de salida')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(log.json.log[0].target, 'local', 'y el rastro no lo cuenta como consumo externo: no lo fue')

  store.clearUpstreams()
  gw.setUpstreams([])
})

test('con las dos puertas abiertas contesta la de casa, no la que cobra', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const env = (await import('bare-env')).default
  env.PYRUS_TEST_KEY = 'clave-de-prueba'

  // El MISMO modelo por dos caminos, que es lo que habilita `as`: sin eso
  // serian dos modelos distintos y no se cruzarian nunca.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'motor',
        label: 'Motor local',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'pesos-abiertos', as: 'dos-puertas' }]
      },
      {
        id: 'pago',
        label: 'Proveedor pago',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [{ modelId: 'el-caro', as: 'dos-puertas', pricePerMTok: { input: 1, output: 2 } }]
      }
    ]
  })
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true) // prendido: ni asi tiene que ganar el pago

  for (const u of ups) {
    if (u.precio) costs.registrarPrecio('upstream:' + u.id, u.precio)
    store.registerUpstream({
      id: u.id,
      modelId: u.anunciadoComo,
      displayName: u.displayName,
      operator: u.label,
      local: u.esLocal,
      maxConcurrentRequests: 2
    })
  }

  t.is(
    store.findAllByModelId('dos-puertas').length,
    2,
    'dos candidatos para un modelo: recien ahora el ruteo tiene algo que decidir'
  )

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'dos-puertas', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200)
  t.is(r.headers['x-pyrus-scope'], 'local', 'gana la de casa mientras tenga lugar (D19)')
  t.is(
    ultimoPedidoExterno.model,
    'pesos-abiertos',
    'y se le pidio con SU nombre, no con el anunciado'
  )

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('cierra el proveedor externo de prueba', async (t) => {
  if (servidorExterno) servidorExterno.close()
  t.pass('apagado')
})

test('cierra el gateway sin dejar el puerto tomado', async (t) => {
  const { shutdownGateway } = await import('../qvac/gateway.mjs')
  await shutdownGateway()
  if (server) server.close()
  t.pass('apagado ordenado')
})

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

// Puertos altos y propios para no chocar con un nodo que el desarrollador tenga
// abierto en 8787 mientras corre los tests.
//
// SE ELIGEN POR CORRIDA, y no es un gusto: esta suite abre cuatro listeners y
// los cuatro quedan en TIME_WAIT cuando el proceso termina. En Windows eso
// impide volver a bindearlos por hasta dos minutos, asi que DOS CORRIDAS
// SEGUIDAS morian con "el puerto 8899 ya esta en uso".
//
// Y morian de la peor forma: `createGateway` hace `Bare.exit(1)` en EADDRINUSE
// -- que es lo correcto para el producto, porque el operador tiene que
// enterarse --, asi que el proceso se iba ANTES de la primera linea de TAP. Una
// corrida sin una sola linea de salida no se distingue de una corrida verde
// mirando el exit code, y `npm run bug-puesto` -- que encadena una corrida por
// arreglo -- la leia como "nadie vigila este arreglo". Se vio: tres entradas de
// la Fase 9 salieron NO ROMPIO con el bug puesto y el test rompiendo de verdad.
//
// El arnes ahora distingue ese caso (ver `corrio()` en scripts/bug-puesto.js).
// Esto es la otra mitad: que no vuelva a pasar. Se prueba un bloque de puertos
// y se usa el primero que este libre entero, que es determinista -- rotar al
// azar solo hace el choque menos frecuente, no imposible.
// El bloque se reserva CONTIGUO y no solo en los offsets que se usan hoy: los
// tests del facilitator abren puertos DERIVADOS (`PUERTO_FACILITATOR_REAL + 1`,
// `+ 2`), y un offset que nadie comprobo es un puerto que puede estar ocupado
// por cualquier otra cosa de la maquina. Eso vuelve como el fallo mas caro de
// esta suite: la corrida que muere antes de escribir una linea de TAP.
const OFFSETS = [4, 5, 6, 7, 8, 9]

const PUERTOS_DESDE = 8800
const PUERTOS_HASTA = 9700

let PORT = 8899
let BASE = 'http://127.0.0.1:' + PORT

function puertoLibre(p) {
  return new Promise((resolve) => {
    const s = http.createServer(() => {})
    s.on('error', () => resolve(false))
    // Un listener que nunca acepto una conexion no deja TIME_WAIT al cerrarse,
    // asi que si esta sonda bindea, el servidor de verdad tambien.
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// Reserva el bloque entero de una: los cuatro listeners tienen que caer juntos,
// porque cada test los referencia por su offset.
async function elegirPuertos() {
  for (let base = PUERTOS_DESDE; base <= PUERTOS_HASTA; base += 10) {
    const libres = []
    for (const d of OFFSETS) libres.push(await puertoLibre(base + d))
    if (libres.every(Boolean)) {
      PORT = base + 9
      BASE = 'http://127.0.0.1:' + PORT
      PUERTO_EXTERNO = base + 8
      PUERTO_FACILITATOR = base + 7
      PUERTO_FACILITATOR_REAL = base + 4
      return base
    }
  }
  throw new Error(
    'no hay un bloque de puertos libre entre ' + PUERTOS_DESDE + ' y ' + PUERTOS_HASTA
  )
}

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
    Object.assign(headers, o.headers || {})

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

  // Antes de bindear: ver la nota de PUERTOS_DESDE. Sin esto, la segunda
  // corrida seguida se muere sin escribir una linea de TAP.
  await elegirPuertos()
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

test('la sonda de puertos distingue ocupado de libre', async (t) => {
  // Lo que vigila esta prueba no es una funcionalidad del producto: es lo que
  // hace que ESTA SUITE pueda correr dos veces seguidas. Ver la nota de
  // PUERTOS_DESDE arriba -- el modo de falla es que el proceso se muera antes de
  // la primera linea de TAP, y una corrida sin salida no se distingue de una
  // verde mirando el exit code.
  //
  // Si `puertoLibre` dijera que si siempre, `elegirPuertos` entregaria un bloque
  // ocupado y el gateway haria `Bare.exit(1)` -- o sea, la falla volveria
  // exactamente como estaba y sin ruido. Por eso se prueba la sonda, que es la
  // pieza que puede mentir en silencio.
  const ocupado = await new Promise((resolve) => {
    const s = http.createServer(() => {})
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const puerto = ocupado.address().port

  t.absent(await puertoLibre(puerto), 'un puerto con un listener encima NO esta libre')

  await new Promise((resolve) => ocupado.close(resolve))
  t.ok(await puertoLibre(puerto), 'y cerrado vuelve a estarlo')

  // Y que el bloque que se eligio sea coherente: los cuatro listeners tienen que
  // caer juntos, porque cada test los referencia por su offset y un bloque
  // mezclado apuntaria la mitad de la suite a un puerto de otra corrida.
  const base = PORT - 9
  t.is(PUERTO_EXTERNO, base + 8, 'el proveedor externo, en el mismo bloque')
  t.is(PUERTO_FACILITATOR, base + 7, 'el facilitator falso tambien')
  t.is(PUERTO_FACILITATOR_REAL, base + 4, 'y el self-hosted de D30.4')
  t.ok(base >= PUERTOS_DESDE && base <= PUERTOS_HASTA, 'dentro del rango declarado')

  // Y los puertos DERIVADOS tambien tienen que caer adentro del bloque. Los dos
  // tests del facilitator abren `+ 1` y `+ 2` sobre PUERTO_FACILITATOR_REAL: si
  // el bloque no los reserva, son puertos que nadie comprobo.
  for (const derivado of [
    PUERTO_FACILITATOR_REAL,
    PUERTO_FACILITATOR_REAL + 1,
    PUERTO_FACILITATOR_REAL + 2
  ]) {
    t.ok(
      OFFSETS.indexOf(derivado - base) !== -1,
      'el puerto ' + derivado + ' (offset ' + (derivado - base) + ') esta reservado'
    )
  }
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
// B12 — las rutas que solo LEEN tambien cuentan
//
// B7 le puso credencial a GET /v1/upstream porque, sin secretos y todo, decia
// quien es el proveedor, que modelos se le pagan y si hay cuenta del otro lado.
// El razonamiento era correcto y estaba incompleto: /v1/nodes devuelve el mismo
// `operator` y ademas el `pricing`, y /v1/routing-log devuelve `costMicros`
// -- el gasto en dolares, request por request -- que es MAS de lo que /v1/upstream
// llega a decir. Cerrar una de las tres puertas y dejar dos abiertas no protege
// nada.
//
// La tercera, /v1/models, NO se cierra: es el catalogo del protocolo de OpenAI
// y un cliente tiene que poder leerlo antes de tener key. Se le saca el dato en
// vez de la puerta.
// ---------------------------------------------------------------------------

test('las rutas que solo leen plata o proveedor tambien piden la key', async (t) => {
  const nodos = await pedir('GET', '/v1/nodes')
  t.is(nodos.status, 401, 'el marketplace dice operador y precio: no es publico')

  const log = await pedir('GET', '/v1/routing-log')
  t.is(log.status, 401, 'y el rastro dice cuanto se gasto, que es peor')

  const conKeyMala = await pedir('GET', '/v1/routing-log', { key: 'qvac_sk_inventada' })
  t.is(conKeyMala.status, 401, 'una key que no existe tampoco pasa')

  // La contracara: con credencial siguen contestando lo de siempre. Un gate que
  // rompe al panel no es un gate, es una regresion.
  const conKey = await pedir('GET', '/v1/nodes', { key: KEY })
  t.is(conKey.status, 200, 'con key sigue siendo el mismo marketplace')
  t.ok(Array.isArray(conKey.json.nodes), 'y con la misma forma')
})

test('/v1/models sigue abierto pero ya no dice quien es el proveedor', async (t) => {
  const r = await pedir('GET', '/v1/models')
  t.is(r.status, 200, 'un cliente OpenAI descubre el catalogo antes de tener key')
  t.ok(r.json.data.length > 0)

  // `owned_by` decia "Proveedor de prueba (externo)" y con eso cualquiera que
  // llegara al puerto sabia contra que API paga este nodo.
  const delatores = r.json.data.filter((m) => m.owned_by !== 'pyrusllm')
  t.is(delatores.length, 0, 'ninguna fila nombra al operador: ' + JSON.stringify(delatores))
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

let PUERTO_EXTERNO = 8898
let servidorExterno = null
let ultimoPedidoExterno = null

// B11: lo que importa no es el objeto que arma el cliente sino lo que LLEGA al
// otro lado. Un `authorization` duplicado se ve identico a uno solo hasta que
// se lo mira desde el servidor, donde aparece concatenado.
let ultimosHeadersExternos = null

// B2: un proveedor que NO manda `usage` no es un caso raro, es el default del
// protocolo -- `usage` en streaming hay que pedirlo-. Se apaga desde el test
// para poder ejercitar el modo de falla y no solo el camino feliz.
let mandaUsage = true

// B3: un proveedor que acepta la conexion y despues no manda nada. Es el caso
// que dejaba el request abierto para siempre -- y con el, la reserva del
// presupuesto que lo autorizo.
let seCuelga = false

// Manda tokens y CORTA el socket sin [DONE], pero SOLO para el modelo que se
// le nombre. Un flag global cortaria tambien la respuesta del candidato que
// tiene que salvar el request, que es justo lo que el test quiere ver.
let cortaModelo = null

// El proveedor contesta 429 para el modelo que se le nombre: es como se ve
// desde afuera una cuota diaria agotada en un tier gratuito. No se mide en
// dolares, asi que el ledger no la ve venir -- lo unico que queda es
// reaccionar al rechazo.
let cuotaAgotadaModelo = null

// B14 (segunda mitad): el proveedor contesta BIEN y no manda un solo token de
// contenido. Cierra limpio, con [DONE]. No es lo mismo que colgarse: ahi salta
// el reloj y el 502 sale por el camino de error, sin pasar nunca por la guarda
// del 200 vacio -- que es como el primer intento de este test pasaba por el
// motivo equivocado.
let sinContenidoModelo = null

// B14: el proveedor corta por el tope y lo DICE, que es como termina de verdad
// un request con `max_tokens` chico. El finish_reason viaja en el ultimo chunk
// y hasta ahora se descartaba.
let finishReasonFalso = null

// B15: abre con 200, manda un delta, y despues un objeto `error` EN EL CUERPO.
// Es lo que hace un proveedor cuando se rompe algo despues de haber mandado los
// headers -- el status ya viajo y no se puede corregir -, y es el modo normal
// de fallar de OpenRouter cuando el proveedor de atras se cae a mitad.
let errorEnStreamModelo = null

// D24 — el proveedor devuelve UN texto fijo, y elige COMO lo trocea.
//
// Es el vector del ataque que D24 cierra: el gateway cuenta un delta a la vez,
// y quien decide cuantos deltas son es el proveedor. `{ modelo, texto,
// porCaracter }` sirve el mismo texto en dos troceos distintos para poder
// comparar que cambia y que no.
let respuestaModelo = null

// D27 caso 1 — el proveedor manda un pedazo, espera, y manda el resto. La pausa
// es la ventana en la que el cliente corta: sin ella no hay forma de que el test
// sepa que el segundo pedazo NO alcanzo a entrar al contenido atestiguado.
let pausaModelo = null

// Un proveedor compatible con OpenAI en veinte lineas: dos deltas, un `usage`
// con tokens que NO coinciden con los contados de este lado -- a proposito,
// para probar que se liquida con los del proveedor -- y el [DONE].
function levantarProveedorFalso() {
  return new Promise((resolve) => {
    servidorExterno = http.createServer((req, res) => {
      ultimosHeadersExternos = req.headers
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
        if (
          cuotaAgotadaModelo &&
          ultimoPedidoExterno &&
          ultimoPedidoExterno.model === cuotaAgotadaModelo
        ) {
          res.writeHead(429, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (d) => res.write('data: ' + JSON.stringify(d) + '\n\n')
        // Cabecera mandada y despues silencio: el socket sigue vivo, asi que
        // nadie del otro lado se entera solo. Es lo que tiene que cortar el reloj.
        if (seCuelga) return
        chunk({ choices: [{ delta: { role: 'assistant' } }] })
        if (
          sinContenidoModelo &&
          ultimoPedidoExterno &&
          ultimoPedidoExterno.model === sinContenidoModelo
        ) {
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        // D24 — el mismo texto, troceado como el proveedor quiera. Sale por su
        // propio camino y termina ahi: lo que se compara es el troceo, y meterle
        // el `usage` y los demas flags de abajo mezclaria variables.
        if (respuestaModelo && ultimoPedidoExterno.model === respuestaModelo.modelo) {
          const partes = respuestaModelo.porCaracter
            ? respuestaModelo.texto.split('')
            : [respuestaModelo.texto]
          for (const p of partes) chunk({ choices: [{ delta: { content: p } }] })
          chunk({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 7, completion_tokens: 11 }
          })
          res.write('data: [DONE]\n\n')
          return res.end()
        }

        // D27 casos 1 y 2 — un pedazo, una pausa, y despues el resto o la
        // muerte.
        //
        // La PAUSA es la pieza que hace deterministas a los dos casos, y no es
        // decoracion: `cortaModelo` destruye el socket en el mismo tick en que
        // escribe, y entonces bare-fetch descarta la respuesta entera y falla
        // con NETWORK_ERROR antes de que el gateway alcance a leer un solo
        // delta -- o sea, `started` en false y un 500 sin que nada haya llegado
        // al cliente, que es OTRO caso. Para probar "cae A MITAD" hay que
        // asegurarse de que la primera mitad efectivamente llego.
        if (pausaModelo && ultimoPedidoExterno.model === pausaModelo.modelo) {
          chunk({ choices: [{ delta: { content: pausaModelo.primero } }] })
          const t = setTimeout(() => {
            try {
              if (pausaModelo.corta) return res.destroy()
              chunk({ choices: [{ delta: { content: pausaModelo.segundo } }] })
              res.write('data: [DONE]\n\n')
              res.end()
            } catch (e) {
              /* el cliente ya se fue: es exactamente el caso que se prueba */
            }
          }, pausaModelo.ms)
          if (t.unref) t.unref()
          return
        }

        // `reasoning_content` en el MISMO delta que el contenido: si el cliente
        // lo leyera, el pensamiento del modelo saldria al chat.
        chunk({
          choices: [{ delta: { reasoning_content: 'primero pienso...', content: 'hola ' } }]
        })
        chunk({ choices: [{ delta: { content: 'desde afuera' } }] })
        // B15: el error llega DESPUES de los headers y despues de algun token,
        // que es el unico momento en que puede llegar por el cuerpo. El stream
        // se cierra limpio -- con [DONE] y todo --, asi que nada mas que el
        // objeto `error` distingue esto de una respuesta que salio bien.
        if (
          errorEnStreamModelo &&
          ultimoPedidoExterno &&
          ultimoPedidoExterno.model === errorEnStreamModelo
        ) {
          chunk({ error: { message: 'upstream provider is down', code: 502 } })
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        if (cortaModelo && ultimoPedidoExterno && ultimoPedidoExterno.model === cortaModelo) {
          return res.destroy()
        }
        if (mandaUsage) {
          chunk({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 1000, completion_tokens: 500 }
          })
        }
        // El chunk de cierre con el motivo, como lo manda un proveedor real.
        if (finishReasonFalso) {
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReasonFalso }] })
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

  const r = await pedir('GET', '/v1/nodes', { key: KEY })
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
  const r = await pedir('GET', '/v1/routing-log', { key: KEY })
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

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
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

// ---------------------------------------------------------------------------
// B11 — la credencial de un proveedor no puede viajar al endpoint de otro
//
// El mismo criterio que el test de arriba, sobre los headers en vez del body, y
// con una vuelta mas: aca la defensa vieja no estaba ausente, estaba escrita en
// el case equivocado. `Authorization` no colisiona con `authorization`, asi que
// la del archivo y la nuestra sobrevivian LAS DOS y salian concatenadas.
//
// Por eso el assert mira lo que recibio el SERVIDOR y no el objeto que armo el
// cliente: del lado de aca las dos versiones se ven bien.
// ---------------------------------------------------------------------------

test('la config no puede mandarle la credencial de un proveedor a otro', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'headers-hostiles',
        label: 'Config con headers hostiles',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        extraHeaders: {
          // En MINUSCULA, que es como los escribe cualquiera que copie una
          // linea de un curl. Ese detalle era todo el bug.
          authorization: 'Bearer CREDENCIAL-DE-OTRO-PROVEEDOR',
          'content-type': 'text/plain',
          // Y uno legitimo, para probar que la defensa no se come todo: los
          // headers de atribucion de OpenRouter tienen que seguir llegando.
          'HTTP-Referer': 'https://ejemplo.test'
        },
        models: [
          {
            modelId: 'proveedor/headers',
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
    modelId: 'proveedor/headers',
    displayName: 'Headers hostiles',
    operator: 'Config con headers hostiles (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/headers', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 200)

  t.is(
    ultimosHeadersExternos.authorization,
    'Bearer clave-de-prueba',
    'llega UNA credencial y es la nuestra: sin el arreglo llegaban las dos concatenadas'
  )
  t.absent(
    String(ultimosHeadersExternos.authorization).includes('OTRO-PROVEEDOR'),
    'y la del archivo no viaja ni pegada al final'
  )
  t.is(
    ultimosHeadersExternos['content-type'],
    'application/json',
    'el cuerpo es JSON aunque el archivo diga otra cosa'
  )
  t.is(
    ultimosHeadersExternos['http-referer'],
    'https://ejemplo.test',
    'y un header legitimo del proveedor sigue pasando: extiende, no sobreescribe'
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

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
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

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
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

// ---------------------------------------------------------------------------
// B14 — `finish_reason` no puede decir `stop` cuando el tope recorto
//
// D9 lo declara NO NEGOCIABLE, y no es formalismo: `finish_reason` es el unico
// campo que el cliente mira para saber si le falta texto, y el que un agente
// mira para decidir si pedir la continuacion. Decir `stop` despues de cortar
// por un tope que ademas se cobro es mentir en el unico lugar donde importa.
//
// El nodo impone su propio `maxTokens` aunque el cliente no lo pida
// (upstream.mjs), asi que esto pasa HOY, sin esperar a la Fase 9.
// ---------------------------------------------------------------------------

async function conUpstreamDePrueba(t, { modelId, extra = {} }, fn) {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'b14',
        label: 'Proveedor con tope',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [{ modelId, maxTokens: 256, pricePerMTok: { input: 1, output: 2 }, ...extra }]
      }
    ]
  })
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true)
  store.registerUpstream({
    id: ups[0].id,
    modelId,
    displayName: 'Con tope',
    operator: 'Proveedor con tope (externo)',
    maxConcurrentRequests: 4
  })

  try {
    await fn()
  } finally {
    store.clearUpstreams()
    costs.olvidarPreciosExternos()
    gw.setUpstreams([])
    gw.setUpstreamOptIn(false)
  }
}

test('si el proveedor corto por el tope, el cliente lee length y no stop', async (t) => {
  finishReasonFalso = 'length'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/cortado' }, async () => {
    // Sin stream: la respuesta se arma entera y el campo viaja en el JSON.
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/cortado', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.status, 200)
    t.is(
      r.json.choices[0].finish_reason,
      'length',
      'la respuesta se corto por el tope y lo dice (D9)'
    )

    // Y con stream, en el chunk de cierre, que es donde lo lee un cliente SSE.
    const s = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: {
        model: 'proveedor/cortado',
        messages: [{ role: 'user', content: 'hola' }],
        stream: true
      }
    })
    t.is(s.status, 200)
    t.ok(
      s.body.includes('"finish_reason":"length"'),
      'el chunk de cierre tambien lo dice, no solo el camino sin stream'
    )
  })

  finishReasonFalso = null
})

test('una respuesta que termino sola sigue diciendo stop', async (t) => {
  finishReasonFalso = 'stop'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/entero' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/entero', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.json.choices[0].finish_reason, 'stop', 'sin recorte, terminacion normal')
  })

  // Y si el proveedor no dice nada, se reporta `stop`: es el default de "nadie
  // lo dijo", no una afirmacion sobre todas las respuestas.
  finishReasonFalso = null
  await conUpstreamDePrueba(t, { modelId: 'proveedor/mudo-fin' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/mudo-fin', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.json.choices[0].finish_reason, 'stop')
  })
})

test('una respuesta vacia es 502 tambien SIN stream, no un 200 con content ""', async (t) => {
  // La otra mitad de B14. La guarda existia solo del lado del stream, con el
  // `return` del no-stream por delante: quien pedia sin `stream: true` -- un
  // curl, Open WebUI, el default de cualquier SDK de OpenAI -- recibia 200 con
  // `content: ""` y `finish_reason: "stop"`. Un cliente no tenia como
  // distinguirlo de un modelo que decidio no decir nada.
  //
  // El proveedor contesta BIEN: 200, chunk de apertura, [DONE]. Cero contenido.
  // Ese es el caso que llega a la guarda; uno colgado saltaria por el reloj.
  sinContenidoModelo = 'proveedor/vacio'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/vacio' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/vacio', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.not(r.status, 200, 'una respuesta sin un solo token no es un exito')
    // Acceso defensivo a proposito: si esto falla, el assert de arriba ya dijo
    // que se rompio, y un TypeError sobre `error.code` abortaria la corrida
    // entera sin llegar a los tests que siguen. Es la misma leccion de B18 --
    // un test que revienta en vez de fallar no dice que se rompio.
    t.is(
      (r.json && r.json.error && r.json.error.code) || null,
      'empty_response',
      'y lo dice con su propio codigo'
    )
    t.absent(r.json && r.json.choices, 'no viaja un choices vacio con finish_reason stop')
  })

  sinContenidoModelo = null
})

// ---------------------------------------------------------------------------
// B6 — la estimacion del prompt cuenta BYTES, y hasta ahora nadie lo probaba
//
// `estimarPromptTokens` divide bytes UTF-8 por 2. La version anterior dividia
// CARACTERES por 3 y se declaraba cota superior: en ingles es cierto, y en
// chino, japones, coreano, arabe o hindi es falso -- ahi la relacion se acerca
// a 1 token por caracter y la reserva quedaba muy por debajo del gasto, justo
// donde el comentario prometia lo contrario.
//
// El arreglo entro con la Fase 6.5 y quedo SIN TEST QUE LO EJERZA, que es por
// lo que B6 siguio abierto tres auditorias. El unico assert que lo rozaba usa
// el prompt 'hola': 4 caracteres y 4 bytes, ceil(4/3) = ceil(4/2) = 2. El mismo
// numero con el bug y sin el.
//
// Con 10 caracteres CJK son 30 bytes: 15 tokens contra 4. Esa es la diferencia
// que el test tiene que ver.
// ---------------------------------------------------------------------------

test('un prompt en CJK no subestima la reserva: se cuentan bytes, no caracteres', async (t) => {
  await conUpstreamDePrueba(t, { modelId: 'proveedor/cjk' }, async () => {
    // 10 caracteres, 30 bytes UTF-8. Reserva = ceil(30/2) tokens de entrada a
    // USD 1 el millon + 256 de tope de salida a USD 2 el millon:
    //   15 * 1 + 256 * 2 = 527 micros.
    // Contando caracteres daria ceil(10/3) = 4 -> 516: casi cuatro veces menos
    // de entrada, y una reserva corta es un tope que se pasa.
    const cjk = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: {
        model: 'proveedor/cjk',
        messages: [{ role: 'user', content: '解释什么是点对点网络' }]
      }
    })
    t.is(cjk.status, 200)
    t.is(
      cjk.headers['x-pyrus-cost-estimate-micros'],
      '527',
      'bytes/2 sobre CJK; contando caracteres habria estimado 516'
    )

    // El contraste que explica por que esto no se veia: con ASCII los dos
    // criterios dan el MISMO numero, asi que el test que ya existia pasaba
    // igual con el bug puesto.
    const ascii = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/cjk', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(
      ascii.headers['x-pyrus-cost-estimate-micros'],
      '514',
      'en ASCII los dos criterios coinciden: por eso el bug sobrevivio'
    )
  })
})

test('un motivo que no conocemos viaja tal cual, no se aplana a stop', async (t) => {
  // Inventarle un final conocido a algo que el proveedor nombro distinto es la
  // misma mentira, mas chica. `content_filter` es el caso real que importa: el
  // cliente tiene que poder distinguir "termino" de "lo cortaron".
  finishReasonFalso = 'content_filter'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/filtrado' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/filtrado', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.json.choices[0].finish_reason, 'content_filter')
  })

  finishReasonFalso = null
})

// ---------------------------------------------------------------------------
// B15 — un 200 no quiere decir que salio bien
//
// El status HTTP viaja con los headers, o sea antes de que el modelo genere un
// solo token. Todo lo que se rompe DESPUES no puede corregirlo: viaja como un
// objeto `error` adentro del cuerpo, con el stream cerrandose limpio, [DONE]
// incluido. Es el modo normal de fallar de OpenRouter cuando el proveedor de
// atras se cae a mitad.
//
// El parser miraba `usage` y `delta.content` y nada mas, asi que el error se
// descartaba como cualquier evento desconocido. Eso daba la peor falla posible:
// la que se ve identica a funcionar.
// ---------------------------------------------------------------------------

test('un error adentro de un stream 200 no se reporta como respuesta exitosa', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  errorEnStreamModelo = 'proveedor/roto-a-mitad'

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'roto',
        label: 'Proveedor roto a mitad',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'proveedor/roto-a-mitad',
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
    modelId: 'proveedor/roto-a-mitad',
    displayName: 'Roto a mitad',
    operator: 'Proveedor roto a mitad (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/roto-a-mitad', messages: [{ role: 'user', content: 'hola' }] }
  })

  // Lo que pasaba antes: 200, `content: ""`, `finish_reason: "stop"`. Un
  // cliente no tenia como distinguirlo de un modelo que decidio no decir nada.
  t.not(r.status, 200, 'un error del proveedor no puede salir como respuesta valida')
  t.is(r.status, 502, 'y es 502, porque el que fallo fue la maquina de un tercero')
  t.absent(r.json && r.json.choices, 'no viaja un choices vacio con finish_reason stop')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = log.json.log[0]
  t.is(entrada.ok, false, 'el fallo queda en el rastro y no como un request exitoso')

  errorEnStreamModelo = null
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('un error adentro del stream deja seguir con el candidato siguiente', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  errorEnStreamModelo = 'r'

  // Dos puertas al mismo modelo. La primera se rompe a mitad del stream; la
  // segunda contesta bien.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'roto2',
        label: 'Se rompe a mitad',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'r', as: 'con-respaldo-2' }]
      },
      {
        id: 'sano',
        label: 'Contesta bien',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 's', as: 'con-respaldo-2' }]
      }
    ]
  })
  gw.setUpstreams(ups)

  store.registerUpstream({
    id: ups[0].id,
    modelId: 'con-respaldo-2',
    displayName: 'Roto',
    operator: 'Se rompe a mitad',
    local: true,
    maxConcurrentRequests: 8
  })
  store.registerUpstream({
    id: ups[1].id,
    modelId: 'con-respaldo-2',
    displayName: 'Sano',
    operator: 'Contesta bien',
    local: true,
    maxConcurrentRequests: 1
  })
  // Mismo motivo que en el test del upstream caido: con la carga empatada el
  // orden lo decide un `random()`. Ocupandole el unico slot al sano, el roto va
  // primero de forma deterministica.
  store.beginRequest('upstream:' + ups[1].id)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-respaldo-2', messages: [{ role: 'user', content: 'hola' }] }
  })

  // D4 permite el reintento acá: sin `stream: true` el contenido se junta y no
  // sale hasta el final, asi que el cliente todavia no vio el pedazo del roto.
  t.is(r.status, 200, 'el error del primero no es el error del request')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Contesta bien', 'contesto el segundo')
  t.is(
    r.json.choices[0].message.content,
    'hola desde afuera',
    'y sin el pedazo que alcanzo a generar el que se rompio'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.is(e.intentos.length, 2, 'los dos intentos quedan en el rastro')
  t.is(e.intentos[0].ok, false, 'el primero fallo aunque el proveedor dijo 200')
  t.is(e.intentos[1].ok, true)

  errorEnStreamModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
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

  // FASE 8 — y ahora gana POR PRECIO, que es otra cosa que ganar por casualidad.
  // Los dos candidatos son `kind: upstream`, asi que el desempate por tipo --
  // lo unico que decidia esto antes -- los deja empatados: si el motivo dice
  // "mas barato", el criterio nuevo es el que mando.
  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.ok(
    log.json.log[0].reason.includes('mas barato'),
    'el log dice POR QUE, y el por que es el precio: ' + log.json.log[0].reason
  )
  t.is(r.headers['x-pyrus-cost-estimate-micros'], '0', 'el motor de casa no cuesta dolares')

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// FASE 8 — el precio decide entre dos que COBRAN
//
// El test de arriba tiene un gratis y un pago, y por eso no separa del todo dos
// explicaciones: "gana el barato" y "gana el que no es un tercero". Este pone
// dos proveedores que cobran, con la misma carga y distinto precio. Si gana el
// barato, lo unico que puede haberlo decidido es el precio.
// ---------------------------------------------------------------------------

test('entre dos proveedores que cobran, rutea al mas barato y lo dice', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'caro',
        label: 'Proveedor caro',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'el-caro',
            as: 'dos-que-cobran',
            maxTokens: 256,
            pricePerMTok: { input: 10, output: 20 }
          }
        ]
      },
      {
        id: 'barato',
        label: 'Proveedor barato',
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        apiKeyEnv: 'PYRUS_TEST_KEY',
        models: [
          {
            modelId: 'el-barato',
            as: 'dos-que-cobran',
            maxTokens: 256,
            pricePerMTok: { input: 1, output: 2 }
          }
        ]
      }
    ]
  })
  gw.setUpstreams(ups)
  gw.setUpstreamOptIn(true)

  for (const u of ups) {
    costs.registrarPrecio('upstream:' + u.id, u.precio)
    store.registerUpstream({
      id: u.id,
      modelId: u.anunciadoComo,
      displayName: u.displayName,
      operator: u.label,
      // MISMA capacidad: con la carga empatada, el precio es lo unico que puede
      // decidir. Distinta capacidad haria que ganara por carga y el test no
      // probaria nada.
      maxConcurrentRequests: 4
    })
  }

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'dos-que-cobran', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200)
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Proveedor barato')
  t.is(ultimoPedidoExterno.model, 'el-barato', 'se le pidio al barato, con SU nombre')

  // El costo estimado del que contesto viaja al cliente. 'hola' son 4 bytes ->
  // ceil(4/2) = 2 tokens de entrada a USD 1 el millon, mas 256 de tope de
  // salida a USD 2 el millon: 2 * 1 + 256 * 2 = 514 micros.
  t.is(r.headers['x-pyrus-cost-estimate-micros'], '514', 'el techo del gasto llega al chat')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const reason = log.json.log[0].reason
  t.ok(reason.includes('mas barato'), 'el motivo es el precio: ' + reason)
  t.ok(reason.includes('0.000514'), 'con el numero del elegido: ' + reason)
  t.ok(reason.includes('0.00514'), 'y el del que perdio: ' + reason)

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// El recorrido de candidatos cruza las clases
//
// Antes habia dos caminos: uno con reintento (solo pares) y otro sin ninguno
// (motor local, upstream, mocks). El reintento se frenaba en la frontera: si
// fallaban todos los pares, el modelo de esta maquina no se probaba nunca
// aunque estuviera en la misma lista de candidatos.
// ---------------------------------------------------------------------------

test('un par inalcanzable ya no tapa al candidato local', async (t) => {
  const store = await import('../qvac/store.mjs')

  // Un par que anuncia el MISMO modelo que un mock del registro. El gateway de
  // esta suite corre sin swarm (`serve --demo`, sin --swarm), asi que el par
  // no se puede intentar: es el caso "lanzaste el chat pero no el agente".
  store.upsertFromManifest('ff'.repeat(32), {
    metadata: { operator: 'Par fantasma', tags: ['facturas'] },
    models: [
      { modelId: 'facturas-ar', displayName: 'Facturas AR', qos: { maxConcurrentRequests: 4 } }
    ]
  })

  const candidatos = store.findAllByModelId('facturas-ar')
  t.ok(candidatos.length >= 2, 'hay un par y un mock sirviendo el mismo modelo')
  t.is(candidatos[0].kind, 'peer', 'y el par va primero, que es lo que antes cortaba el camino')

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'antes esto era un 503 agent_offline sin mirar al resto de la lista')
  t.not(
    decodeURIComponent(r.headers['x-pyrus-operator']),
    'Par fantasma',
    'y contesto el otro, no el que no se podia intentar'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.ok(e.intentos && e.intentos.length > 1, 'el rastro guarda los dos intentos')
  t.is(e.intentos[0].code, 'agent_offline', 'y por que fallo el primero')

  store.removeByPeer('ff'.repeat(32), { hard: true })
})

test('sin ningun par alcanzable Y sin candidato local, el 503 sigue diciendo que hacer', async (t) => {
  const store = await import('../qvac/store.mjs')

  store.upsertFromManifest('ee'.repeat(32), {
    metadata: { operator: 'Par solo' },
    models: [{ modelId: 'solo-remoto', qos: { maxConcurrentRequests: 4 } }]
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'solo-remoto', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 503)
  t.is(r.json.error.code, 'agent_offline')
  t.ok(
    r.json.error.message.indexOf('launch your local agent') !== -1,
    'un 503 que solo niega deja al que lo lee sin siguiente paso'
  )

  store.removeByPeer('ee'.repeat(32), { hard: true })
})

test('un upstream caido se saltea y contesta el siguiente candidato', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Dos puertas al mismo modelo: la primera apunta a un puerto donde no hay
  // nadie escuchando -- el caso real de "no levantaste el llama-server" -- y la
  // segunda al proveedor de prueba, que si contesta.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'caido',
        label: 'Motor apagado',
        local: true,
        baseUrl: 'http://127.0.0.1:8897/v1',
        models: [{ modelId: 'x', as: 'con-respaldo' }]
      },
      {
        id: 'vivo',
        label: 'Motor vivo',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'y', as: 'con-respaldo' }]
      }
    ]
  })
  gw.setUpstreams(ups)

  // El caido tiene que ir PRIMERO o el test no ejercita nada: si contesta el
  // vivo de entrada, los tres asserts de abajo pasan igual sin que el reintento
  // haya ocurrido nunca.
  //
  // Antes esto se intentaba con "el caido con MAS capacidad libre" (8 contra 1)
  // y NO ordenaba nada: `cargaDe` es un COCIENTE -- activeRequests sobre
  // maxConcurrent (store.mjs:150) --, asi que 0/8 y 0/1 son los dos CERO. Con la
  // carga empatada, empatan tambien errorRate y lastMs -- las dos filas son
  // nuevas y no tienen historia -- y el orden lo terminaba decidiendo el
  // `jitter: random()` de routing.mjs:102. O sea una moneda: el test fallaba
  // ~1 de cada 2 corridas, y el modo de falla era un TypeError sobre
  // `e.intentos` en vez de un assert, que es peor porque no dice que se rompio.
  //
  // Lo que SI ordena es dejar al vivo sin lugar: 1/1 lo manda al fondo por la
  // regla 1 del sort (los saturados van ultimos), que se evalua antes que
  // cualquier azar. Sigue siendo elegible -- el loop prueba a los saturados
  // igual -, que es exactamente lo que se quiere: el caido primero, el vivo
  // despues.
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'con-respaldo',
    displayName: 'Apagado',
    operator: 'Motor apagado',
    local: true,
    maxConcurrentRequests: 8
  })
  store.registerUpstream({
    id: ups[1].id,
    modelId: 'con-respaldo',
    displayName: 'Vivo',
    operator: 'Motor vivo',
    local: true,
    maxConcurrentRequests: 1
  })
  // El id de la FILA lleva prefijo: `registerUpstream` lo agrega y es con ese
  // con el que el gateway cuenta los slots.
  store.beginRequest('upstream:' + ups[1].id)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-respaldo', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'el fallo del primero no es el fallo del request')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Motor vivo', 'contesto el segundo')
  t.is(r.json.choices[0].message.content, 'hola desde afuera')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.is(e.intentos.length, 2, 'y los dos intentos quedan en el rastro')
  t.is(e.intentos[0].ok, false)
  t.is(e.intentos[1].ok, true)

  store.clearUpstreams()
  gw.setUpstreams([])
})

test('D4 mira lo que vio EL CLIENTE, no lo que genero el proveedor', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // El primer proveedor manda tokens y corta el socket sin cerrar el stream.
  cortaModelo = 'x'

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'cortado',
        label: 'Corta a la mitad',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'x', as: 'se-corta' }]
      },
      {
        id: 'sano',
        label: 'Sano',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'y', as: 'se-corta' }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'se-corta',
    operator: 'Corta a la mitad',
    displayName: 'Cortado',
    local: true,
    maxConcurrentRequests: 8
  })
  store.registerUpstream({
    id: ups[1].id,
    modelId: 'se-corta',
    operator: 'Sano',
    displayName: 'Sano',
    local: true,
    maxConcurrentRequests: 1
  })

  // El orden tiene que ser determinista: con los dos en carga 0 el desempate de
  // pickCandidate es al azar. Se ocupa el unico slot del sano para que quede
  // segundo -- saturado no significa descartado, significa ultimo.
  store.beginRequest('upstream:' + ups[1].id)

  // SIN stream: el contenido se junta y no sale hasta el final, asi que al
  // cliente no le llego un byte y el reintento es legitimo.
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'se-corta', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'se reintenta: el cliente no habia visto nada')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Sano', 'contesto el segundo')
  t.is(
    r.json.choices[0].message.content,
    'hola desde afuera',
    'y la respuesta NO trae pegado el pedazo del que se cayo'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(log.json.log[0].intentos.length, 2, 'los dos intentos quedan en el rastro')

  cortaModelo = null
  store.endRequest('upstream:' + ups[1].id)
  store.clearUpstreams()
  gw.setUpstreams([])
})

test('un 429 del proveedor se trata como saturacion, no como error del request', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // La cuota diaria del primero, agotada. Es el limite que budget.mjs NO puede
  // ver, porque no se mide en dolares: se cuenta en requests por dia.
  cuotaAgotadaModelo = 'sin-cuota'

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'agotado',
        label: 'Sin cuota',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'sin-cuota', as: 'con-cuota', timeoutPrimerChunkMs: 4000 }]
      },
      {
        id: 'conCuota',
        label: 'Con cuota',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'z', as: 'con-cuota' }]
      }
    ]
  })
  gw.setUpstreams(ups)
  for (const u of ups) {
    store.registerUpstream({
      id: u.id,
      modelId: 'con-cuota',
      displayName: u.label,
      operator: u.label,
      local: true,
      maxConcurrentRequests: u.id === ups[0].id ? 4 : 1
    })
  }
  store.beginRequest('upstream:' + ups[1].id) // el otro, segundo y determinista

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-cuota', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'el request se salva con el otro candidato')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Con cuota')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(
    log.json.log[0].intentos[0].code,
    'at_capacity',
    'el 429 se lee como "lleno", no como "roto"'
  )

  // Y queda marcado lleno: el proximo request no vuelve a gastar el intento
  // contra un proveedor que ya dijo que no. S5 de NOTES-SATURACION.md.
  const fila = store.getNode('upstream:' + ups[0].id)
  t.is(
    fila.activeRequests,
    fila.maxConcurrentRequests,
    'marcado saturado hasta que se sepa otra cosa'
  )

  cuotaAgotadaModelo = null
  store.endRequest('upstream:' + ups[1].id)
  store.clearUpstreams()
  gw.setUpstreams([])
})

// ---------------------------------------------------------------------------
// FASE 9 — el 402 en el borde (D8, D9, D10, D16)
//
// D16 decide tres caminos que no se pisan: `local: true` gratis, una API key
// del panel, y -- para el desconocido -- 402. El tercero es la fase: es lo que
// permite que un agente consuma sin registrarse en nada.
//
// El 402 se arma DESPUES de elegir candidato, porque tiene que decir cuanto y a
// quien, y las dos cosas dependen de quien vaya a contestar.
// ---------------------------------------------------------------------------

test('sin credencial y con wallet, el nodo pide pago en vez de negar acceso', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')

  // Antes de tener wallet, un request sin key es 401: no hay a quien pagarle,
  // asi que el unico camino que queda es la credencial.
  gw.setEconomic(null)
  const sinWallet = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinWallet.status, 401, 'sin wallet no se puede cobrar: sigue siendo 401')

  // Con wallet, el mismo request es un 402.
  const direccion = '0x' + 'ab'.repeat(20)
  gw.setEconomic(wallet.economicDe(direccion))

  const r = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 402, 'no le falta credencial: le falta pagar, y son cosas distintas')
  t.is(r.json.x402Version, 2)
  t.ok(Array.isArray(r.json.accepts) && r.json.accepts.length > 0, 'trae al menos una opcion')

  const a = r.json.accepts[0]
  // Los cuatro datos que el DoD pide que el 402 diga.
  t.is(a.payTo, direccion, 'A QUIEN: la wallet de quien va a contestar (D10)')
  t.is(a.network, 'eip155:988', 'EN QUE CADENA: Stable, la unica usable sin verificar Plasma')
  // `amount` y no `maxAmountRequired`: el segundo es el nombre de x402 v1 y es
  // el que sale en media documentacion, pero el cliente de v2 lee `amount`. Con
  // el nombre viejo el cliente firma BigInt(undefined) y ni llega a mandar nada.
  t.is(a.amount, '1000', 'CUANTO: el minimo de USD 0,001 en unidades de USDT0')
  t.absent(a.maxAmountRequired, 'y no se manda el nombre v1, que nadie lee')
  t.ok(a.outputTokenLimit > 0, 'HASTA CUANTOS TOKENS: ' + a.outputTokenLimit + ' (D9)')

  t.is(a.scheme, 'exact', 'D9(a): esquema exact')
  t.ok(a.resource.includes('/v1/chat/completions'), 'y sobre que recurso')
  t.ok(a.extra && a.extra.name, 'con el dominio EIP-712 que el cliente necesita para firmar')

  // La key sigue funcionando: el 402 CONVIVE, no reemplaza (D16).
  const conKey = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conKey.status, 200, 'quien ya tiene key no se entera de nada de esto')

  gw.setEconomic(null)
})

test('el 402 no promete una red cuyo contrato no verifico nadie', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  gw.setEconomic(wallet.economicDe('0x' + 'cd'.repeat(20)))

  // D15 puso Plasma de default, pero x402 no la trae y su direccion de contrato
  // la declaramos nosotros, sin verificar. Sin la confirmacion explicita del
  // operador NO se ofrece: el cliente firmaria una autorizacion contra un
  // contrato que nadie miro.
  delete env[x402.VAR_PLASMA_OK]
  const sinPlasma = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.alike(
    sinPlasma.json.accepts.map((a) => a.network),
    ['eip155:988'],
    'solo Stable, que es la que x402 conoce de fabrica'
  )

  env[x402.VAR_PLASMA_OK] = '1'
  const conPlasma = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.alike(
    conPlasma.json.accepts.map((a) => a.network),
    ['eip155:9745', 'eip155:988'],
    'con la confirmacion entra, y va primera como dice D15'
  )

  delete env[x402.VAR_PLASMA_OK]
  gw.setEconomic(null)
})

// ---------------------------------------------------------------------------
// FASE 9 — pagar de verdad: firmar el X-PAYMENT y recibir tokens
//
// El cliente es el de x402 (`ExactEvmScheme`) firmando con una wallet WDK real.
// Lo unico que NO se ejercita es la cadena: D12 decide que la verificacion es
// sincronica y NO la toca -- se comprueba que la autorizacion este bien firmada
// y diga lo que tiene que decir. Que haya saldo se sabe al liquidar.
//
// Esa es exactamente la propiedad que hace que este test valga sin fondear
// nada: la mitad que protege al proveedor de gastar GPU gratis es offline.
// ---------------------------------------------------------------------------

// Un pagador: wallet WDK de prueba, publica y conocida, que nunca se fondea.
async function pagador() {
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cuenta = await new WM('test test test test test test test test test test test junk', {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount()
  return {
    address: await cuenta.getAddress(),
    signTypedData: (args) => cuenta.signTypedData(args)
  }
}

// Firma el `accepts[0]` de un 402 y devuelve el header X-PAYMENT.
async function firmarPago(desafio, { pisar = {} } = {}) {
  const x402 = await import('../qvac/x402.mjs')
  const { evm } = await x402.cargar()
  const signer = await pagador()
  const req = desafio.accepts[0]
  const esquema = new evm.ExactEvmScheme(signer)
  const p = await esquema.createPaymentPayload(desafio.x402Version, { ...req, ...pisar })
  const sobre = {
    x402Version: p.x402Version,
    scheme: 'exact',
    network: pisar.network || req.network,
    payload: p.payload
  }
  return Buffer.from(JSON.stringify(sobre), 'utf8').toString('base64')
}

test('con el X-PAYMENT firmado, el desconocido recibe tokens', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }

  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  t.is(desafio.status, 402)

  const pago = await firmarPago(desafio.json)
  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  t.is(r.status, 200, 'pago verificado -> se sirve, sin API key de por medio')
  t.ok(r.json.choices[0].message.content.length > 0, 'y contesta algo')

  gw.setEconomic(null)
})

test('un X-PAYMENT manoseado no compra nada', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json

  // 1. Firmado por menos de lo que se pidio.
  const barato = await firmarPago(desafio, { pisar: { amount: '1' } })
  const r1 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': barato }
  })
  t.is(r1.status, 402, 'pagar de menos no alcanza')
  t.ok(String(r1.json.error).includes('se pidieron'), r1.json.error)

  // 2. Firmado a OTRA direccion. Es el ataque que importa: quien reenvia el 402
  //    de otro nodo con su propia wallet adentro se estaria cobrando el trabajo
  //    ajeno -- del lado del pagador, mandar la plata a otro lado.
  const aOtro = await firmarPago(desafio, { pisar: { payTo: '0x' + 'cd'.repeat(20) } })
  const r2 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': aOtro }
  })
  t.is(r2.status, 402, 'una autorizacion a otra direccion no paga a esta')
  t.ok(String(r2.json.error).includes('otra direccion'), r2.json.error)

  // 3. La firma cambiada: el monto de la autorizacion se edita DESPUES de
  //    firmar. Es lo unico que no se puede falsificar, y es el corazon de D12.
  const bueno = await firmarPago(desafio)
  const sobre = JSON.parse(Buffer.from(bueno, 'base64').toString('utf8'))
  sobre.payload.authorization.value = '999999999'
  const editado = Buffer.from(JSON.stringify(sobre), 'utf8').toString('base64')
  const r3 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': editado }
  })
  t.is(r3.status, 402, 'editar la autorizacion despues de firmar la invalida')
  t.ok(String(r3.json.error).includes('firma no corresponde'), r3.json.error)

  // 4. Basura.
  const r4 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': 'no-es-base64-de-nada' }
  })
  t.is(r4.status, 402)

  gw.setEconomic(null)
})

// ---------------------------------------------------------------------------
// FASE 9 — la liquidacion (D12, D14)
//
// El facilitator es falso, igual que el proveedor externo: un bare-http1 local
// que habla el protocolo de x402. Lo real -- x402.semanticpay.io -- mueve plata
// contra una wallet fondeada, asi que no puede estar en `npm test`.
//
// Lo que SI se ejercita de verdad: que se liquide DESPUES de servir, que el
// recibo llegue por el camino que corresponde a cada forma de respuesta, y que
// una liquidacion fallida no se lleve puesta una respuesta que ya salio bien.
// ---------------------------------------------------------------------------

let PUERTO_FACILITATOR = 8897
let servidorFacilitator = null
let ultimoSettle = null
let facilitatorFalla = false

function levantarFacilitatorFalso() {
  return new Promise((resolve) => {
    servidorFacilitator = http.createServer((req, res) => {
      let crudo = ''
      req.on('data', (c) => {
        crudo += c
      })
      req.on('end', () => {
        try {
          ultimoSettle = JSON.parse(crudo)
        } catch (e) {
          ultimoSettle = null
        }
        if (facilitatorFalla) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'el facilitator se cayo' }))
        }
        const reqs = (ultimoSettle && ultimoSettle.paymentRequirements) || {}
        const auth =
          (ultimoSettle &&
            ultimoSettle.paymentPayload &&
            ultimoSettle.paymentPayload.payload &&
            ultimoSettle.paymentPayload.payload.authorization) ||
          {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            transaction: '0x' + 'fe'.repeat(32),
            network: reqs.network || 'eip155:988',
            payer: auth.from || null
          })
        )
      })
    })
    servidorFacilitator.listen(PUERTO_FACILITATOR, '127.0.0.1', () => resolve())
  })
}

// Decodifica el X-PAYMENT-RESPONSE sin reventar si no esta.
//
// Un `Buffer.from(undefined, 'base64')` seguido de JSON.parse tira un
// SyntaxError que ABORTA la corrida, y entonces el test no dice que se rompio
// -- es la misma leccion de B18. Devuelve null y que el assert hable.
function reciboDe(r) {
  const h = r && r.headers && r.headers['x-payment-response']
  if (!h) return null
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
  } catch (e) {
    return null
  }
}

test('el pago se liquida DESPUES de servir, y el recibo llega', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  await levantarFacilitatorFalso()
  ultimoSettle = null
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json
  const pago = await firmarPago(desafio)

  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  t.is(r.status, 200)

  // D12 — sin stream la respuesta se arma entera antes de escribir un byte, asi
  // que el recibo va en el header como manda el spec, SIN desviacion.
  const recibo = reciboDe(r)
  t.ok(recibo, 'X-PAYMENT-RESPONSE en el camino sin stream')
  t.is(recibo && recibo.success, true)
  t.ok(
    recibo && String(recibo.transaction).startsWith('0x'),
    'con el tx hash: ' + (recibo && recibo.transaction)
  )

  // Se liquido contra EL MISMO requisito que se ofrecio, no contra uno
  // recalculado: liquidar contra otros numeros seria cobrar algo distinto de lo
  // que el cliente acepto.
  t.ok(ultimoSettle, 'el facilitator recibio la liquidacion')
  const reqs = (ultimoSettle && ultimoSettle.paymentRequirements) || {}
  t.is(reqs.amount, desafio.accepts[0].amount)
  t.is(reqs.payTo, desafio.accepts[0].payTo)

  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

test('con stream el recibo va como evento SSE, y dice por que no esta en el header', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))

  const cuerpo = {
    model: 'facturas-ar',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json
  const pago = await firmarPago(desafio)

  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  t.is(r.status, 200)

  // En SSE los headers salen ANTES del primer token, asi que ahi no puede ir.
  t.absent(r.headers['x-payment-response'], 'no esta en el header, y no puede estarlo')

  const evento = r.body
    .split('\n\n')
    .map((l) => l.replace(/^data: /, ''))
    .filter((l) => l.indexOf('paymentResponse') !== -1)
    .map((l) => JSON.parse(l))[0]

  t.ok(evento, 'el recibo viaja como evento SSE final')
  t.is(evento && evento.paymentResponse && evento.paymentResponse.success, true)
  // La condicion de D12: la desviacion se tiene que poder descubrir desde la
  // respuesta misma. Un cliente que busque el header y no lo encuentre tiene
  // que enterarse de POR QUE, no quedarse esperando.
  t.ok(
    evento && evento.x402Note && evento.x402Note.indexOf('TTFT') !== -1,
    'y explica la desviacion'
  )
  t.ok(evento && evento.receiptUrl, 'con un lugar de donde recuperarlo')

  // Y ese lugar existe, para el cliente que corto antes del ultimo evento.
  const rec = evento && evento.receiptUrl ? await pedir('GET', evento.receiptUrl) : { status: 0 }
  t.is(rec.status, 200, 'el recibo se puede recuperar despues')
  t.is(rec.json && rec.json.transaction, evento && evento.paymentResponse.transaction)

  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

test('si la liquidacion falla, la respuesta que ya salio no se cae', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))
  facilitatorFalla = true

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json
  const pago = await firmarPago(desafio)

  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  // El cliente ya recibio sus tokens. Ese es el precio de liquidar despues, y
  // esta aceptado por D12: la alternativa es una transaccion on-chain delante
  // del TTFT. Lo que NO puede pasar es que el request se caiga.
  t.is(r.status, 200, 'la respuesta sale igual: el trabajo ya se hizo')
  t.ok(r.json.choices[0].message.content.length > 0)

  const recibo = reciboDe(r)
  t.ok(recibo, 'el recibo llega igual')
  t.is(recibo && recibo.success, false, 'pero el recibo dice que NO se cobro')
  t.ok(recibo && (recibo.errorReason || recibo.errorMessage), 'y por que')

  facilitatorFalla = false
  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

// ---------------------------------------------------------------------------
// FASE 9 / D24, D25, D27 — la atestacion del proveedor, colgada del recibo
//
// El recibo de x402 que los tests de arriba verifican prueba que alguien PAGO.
// Lo que falta es el otro lado: QUE SIRVIO el que cobro. D24 lo cuelga del mismo
// recibo que D12 ya obliga a construir, firmado con la WALLET y no con la clave
// de red -- mismo criterio que la Fase 10 y que manifest-v0.json:84.
//
// En esta fase el artefacto solo se emite y se guarda. Nada lo consume: eso es
// la Fase 10. Es deliberado -- hacia atras no se firma, y cada dia de la Fase 9
// sin esto es historia que no vuelve.
// ---------------------------------------------------------------------------

// El proveedor firma con la cuenta 1, NO con la 0.
//
// La 0 es la del `pagador()` de los tests de arriba. Si las dos puntas usaran la
// misma direccion, un bug que confundiera al que paga con el que cobra pasaria
// desapercibido: todo verificaria igual porque serian el mismo.
async function proveedorFirmante() {
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cuenta = await new WM('test test test test test test test test test test test junk', {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount(1)
  return {
    address: await cuenta.getAddress(),
    firmar: (mensaje) => cuenta.sign(mensaje)
  }
}

// Deja el gateway con wallet Y firmante. Las dos cosas: con direccion y sin
// firmante hay 402 y no hay atestacion, que es un caso legitimo y se prueba
// aparte.
async function conProveedorQueFirma() {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  const p = await proveedorFirmante()
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe(p.address))
  gw.setWalletSigner(p.firmar)
  return p
}

async function soltarProveedor() {
  const gw = await import('../qvac/gateway.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default
  gw.setEconomic(null)
  gw.setWalletSigner(null)
  delete env[x402.VAR_FACILITATOR]
}

// Paga y sirve en un paso: 402, firma, reenvia. Devuelve la respuesta servida.
async function pagarYPedir(cuerpo) {
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  if (desafio.status !== 402) return { desafio, r: desafio }
  const pago = await firmarPago(desafio.json)
  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  return { desafio, r }
}

// El id de la completion, sacado de un cuerpo SSE. Es la clave de /v1/receipts.
function idDeSSE(body) {
  for (const bloque of String(body || '').split('\n\n')) {
    const s = bloque.replace(/^data: /, '').trim()
    if (!s || s === '[DONE]') continue
    try {
      const o = JSON.parse(s)
      if (o && o.id) return o.id
    } catch (e) {
      /* el evento del recibo no trae id: se sigue */
    }
  }
  return null
}

// Un POST que CORTA la conexion apenas ve el primer delta con contenido.
//
// `pedir` lee hasta el final, asi que no sirve para D27 caso 1: el caso es
// justamente el cliente que se va antes. Resuelve con lo que alcanzo a leer.
function pedirYCortar(ruta, opts) {
  const o = opts || {}
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(o.body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
    Object.assign(headers, o.headers || {})

    let data = ''
    let listo = false
    const terminar = () => {
      if (listo) return
      listo = true
      resolve({ body: data })
    }

    const req = http.request(BASE + ruta, { method: 'POST', headers }, (res) => {
      res.on('data', (c) => {
        data += c
        if (!listo && data.indexOf('"content"') !== -1) {
          req.destroy()
          terminar()
        }
      })
      res.on('end', terminar)
      res.on('error', terminar)
    })
    req.on('error', (e) => {
      if (!listo) reject(e)
    })
    req.write(payload)
    req.end()
  })
}

test('D24: el recibo lleva la atestacion de lo que se sirvio, firmada con la wallet', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const p = await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]
  const { r } = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(r.status, 200)

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.status, 200, 'el recibo se recupera por el id de la completion')

  const a = rec.json.attestation
  t.ok(a, 'y lleva la atestacion del proveedor (D24)')

  // La firma es de la WALLET, no de la clave de red, y la verificacion usa la
  // MISMA canonicalizacion que el firmado -- que es la unica forma de que no
  // puedan divergir.
  const v = await at.verificar(a)
  t.ok(v.ok, 'verifica: ' + (v.reason || ''))
  t.is(a.providerPubkey, p.address, 'firmada por la direccion de cobro de este nodo')

  // ESTE es el campo que cierra el agujero de D24: el hash es del TEXTO, y el
  // texto es exactamente el que recibio el cliente.
  t.is(
    a.outputHash,
    at.hashDe(r.json.choices[0].message.content),
    'el outputHash es el de lo que el cliente efectivamente recibio'
  )
  t.is(a.promptHash, at.hashDeMensajes(messages), 'y el promptHash, el de la conversacion entera')

  // Un mock firmado con una wallet real sigue siendo un mock. Que lo diga el
  // artefacto, y no solo el README, es la regla del proyecto sobre los mocks.
  t.is(a.runtime, 'mock', 'el artefacto dice con que se genero: ' + a.runtime)
  t.is(a.finishReason, 'stop')
  t.ok(a.nonce && a.ts > 0, 'con nonce y timestamp')

  await soltarProveedor()
})

test('D24: troceando el stream cambia el conteo del gateway y NO cambia el hash', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  await conProveedorQueFirma()

  // El ataque de D24, montado. El gateway incrementa su contador UNA VEZ POR
  // DELTA con contenido, y quien decide cuantos deltas son es el proveedor: el
  // mismo texto servido de a un caracter infla ese contador sin mentir en
  // ningun campo y sin romper ninguna validacion. No falsea el numero, falsea
  // la señal que el otro cuenta.
  const TEXTO = 'una respuesta cualquiera'
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'troceo',
        label: 'Trocea como quiere',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'tr', as: 'troceo-9', maxTokens: 256 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'troceo-9',
    displayName: 'Troceo',
    operator: 'Trocea como quiere',
    local: true,
    maxConcurrentRequests: 4
  })

  const cuerpo = { model: 'troceo-9', messages: [{ role: 'user', content: 'hola' }] }

  respuestaModelo = { modelo: 'tr', texto: TEXTO, porCaracter: false }
  const entero = await pagarYPedir(cuerpo)
  const recEntero = await pedir('GET', '/v1/receipts/' + entero.r.json.id)
  const logEntero = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]

  respuestaModelo = { modelo: 'tr', texto: TEXTO, porCaracter: true }
  const troceado = await pagarYPedir(cuerpo)
  const recTroceado = await pedir('GET', '/v1/receipts/' + troceado.r.json.id)
  const logTroceado = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]

  t.is(entero.r.json.choices[0].message.content, TEXTO, 'los dos sirvieron el mismo texto')
  t.is(troceado.r.json.choices[0].message.content, TEXTO)

  // El ataque funciona contra el contador: 1 delta contra 24.
  t.is(logEntero.tokens, 1, 'entero: el gateway conto 1')
  t.is(logTroceado.tokens, TEXTO.length, 'troceado: conto ' + TEXTO.length + ' por el mismo texto')

  // Y no funciona contra el hash, que es toda la razon por la que D24 lo pide.
  // Cualquiera puede recontar los tokens desde el texto atestiguado.
  t.is(
    recEntero.json.attestation.outputHash,
    recTroceado.json.attestation.outputHash,
    'el outputHash es el mismo: el texto no depende de en cuantos pedazos viajo'
  )

  respuestaModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D25: el rastro separa prefill de decode, y dice de donde salio cada numero', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // 1. Con `usage` del proveedor: son los tokens REALES, contados por SU
  //    tokenizador. El proveedor falso manda 1000/500 a proposito, numeros que
  //    no coinciden con nada que se pueda contar de este lado.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'd25',
        label: 'Manda usage',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'u', as: 'd25-9', maxTokens: 256 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'd25-9',
    displayName: 'D25',
    operator: 'Manda usage',
    local: true,
    maxConcurrentRequests: 4
  })

  const conUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'd25-9', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conUsage.status, 200)

  const e1 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  t.is(e1.tokensPrefill, 1000, 'prefill del proveedor')
  t.is(e1.tokensDecode, 500, 'decode del proveedor')
  t.is(e1.tokensFuente, 'proveedor', 'y el rastro dice que fue medido, no estimado')

  // Los campos VIEJOS no cambian de significado. Hay panel e historial leyendo
  // `tokens`, y redefinirlo convertiria las entradas anteriores en otra cosa sin
  // que nadie se entere. D25 AGREGA.
  t.is(typeof e1.tokens, 'number', '`tokens` sigue siendo lo que era')
  t.absent(e1.tokens === e1.tokensDecode, 'y sigue sin ser lo mismo que el decode real')

  store.clearUpstreams()
  gw.setUpstreams([])

  // 2. Sin `usage`: lo que queda es una ESTIMACION del prompt y un conteo de
  //    DELTAS, que no son tokens. Decirle 'proveedor' a eso seria hacer creer
  //    que hay una medicion donde hay una cuenta de chunks de SSE.
  const sinUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinUsage.status, 200)

  const e2 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  t.is(e2.tokensFuente, 'gateway', 'un mock no manda usage: la fuente lo dice')
  t.ok(e2.tokensPrefill > 0, 'el prefill sale del estimador del prompt')
  t.is(e2.tokensDecode, e2.tokens, 'y el decode es el conteo de deltas, que es lo unico que hay')
})

test('D9/D27 caso 3: el tope que declara el 402 ahora se APLICA, y dice length', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]

  // Sin tope pedido, el 402 declara el techo del nodo y la respuesta sale
  // entera. Es el control: sin el, un test del tope pasaria aunque el mock
  // contestara corto por su cuenta.
  const libre = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(libre.r.status, 200)
  t.is(libre.r.json.choices[0].finish_reason, 'stop', 'sin tope, termina normal')
  const largoEntero = libre.r.json.choices[0].message.content.length

  // Con tope. El numero que se DECLARA en el accepts[] y el que se APLICA son
  // el mismo: declarar uno y recortar con otro es cobrar por un trabajo
  // distinto del que se acordo.
  const cortado = await pagarYPedir({ model: 'facturas-ar', messages, max_tokens: 4 })
  t.is(cortado.desafio.json.accepts[0].outputTokenLimit, 4, 'el 402 declara el tope')
  t.is(cortado.r.status, 200)

  const texto = cortado.r.json.choices[0].message.content
  t.ok(texto.length > 0, 'algo sirvio')
  t.ok(
    texto.length < largoEntero,
    'y se corto: ' + texto.length + ' contra ' + largoEntero + ' sin tope'
  )

  // La condicion que D9 llama NO NEGOCIABLE. Cobrar por un tope y reportar
  // terminacion normal es mentir en el unico campo que el cliente mira para
  // saber si le falta texto -- y el que mira un agente para decidir si pedir la
  // continuacion.
  t.is(cortado.r.json.choices[0].finish_reason, 'length', 'y lo DICE: length, no stop')

  // D27 caso 3: atestacion COMPLETA, y se cobra.
  const rec = await pedir('GET', '/v1/receipts/' + cortado.r.json.id)
  t.is(rec.json.success, true, 'se cobra: la respuesta termino como se acordo')
  t.is(rec.json.attestation.finishReason, 'length', 'la atestacion dice lo mismo')
  t.is(rec.json.attestation.outputHash, at.hashDe(texto), 'sobre el prefijo servido')

  await soltarProveedor()
})

test('D27 caso 2: el proveedor cae a mitad de stream y NO se cobra', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  await conProveedorQueFirma()

  // Un solo candidato para este modelo: con otro atras el request se salvaria
  // por el reintento y no se estaria probando la caida.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'cae',
        label: 'Se cae a mitad',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'c9', as: 'cae-9', maxTokens: 256 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'cae-9',
    displayName: 'Cae',
    operator: 'Se cae a mitad',
    local: true,
    maxConcurrentRequests: 4
  })

  // El proveedor abre 200, manda un delta, y despues avisa que se rompio con un
  // objeto `error` EN EL CUERPO. Es el modo normal de caerse a mitad cuando los
  // headers ya viajaron -- el status salio antes del primer token y no se puede
  // corregir --, y es el que B15 enseño a detectar.
  //
  // Se usa este y no un `res.destroy()` a proposito: ver la nota de arriba de
  // `pausaModelo`. Un socket destruido despues de una pausa NO llega como falla,
  // asi que un test montado sobre eso probaria lo contrario de lo que dice.
  errorEnStreamModelo = 'c9'
  const cuerpo = {
    model: 'cae-9',
    messages: [{ role: 'user', content: 'hola' }],
    // Con stream, D4 ya no puede reintentar: al cliente le salio un token.
    stream: true
  }
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  t.is(desafio.status, 402)
  const pago = await firmarPago(desafio.json)
  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  const id = idDeSSE(r.body)
  t.ok(id, 'el stream alcanzo a abrir, asi que hay un id')
  t.absent(r.body.indexOf('paymentResponse') !== -1, 'NO hay recibo: no se liquido nada')

  // Este es el DoD de la Fase 9 que mas importa y el que mas facil se rompe:
  // la verificacion protege al proveedor de gastar GPU gratis, la falta de
  // liquidacion protege al cliente de pagar por lo que no recibio.
  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 404, 'y no hay nada que recuperar: no se cobro')

  // D27: ninguna atestacion tampoco. El nodo no puede comprometerse con una
  // respuesta que no termino de entregar.
  t.absent(r.body.indexOf('attestation') !== -1, 'ni atestacion')

  errorEnStreamModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D27 caso 1: el cliente corta, se atestigua el prefijo emitido y SI se cobra', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  await conProveedorQueFirma()

  const PRIMERO = 'lo que el cliente si recibio'
  const SEGUNDO = ' — y esto ya no'

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'pausa',
        label: 'Manda, espera, manda',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'p9', as: 'pausa-9', maxTokens: 256 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'pausa-9',
    displayName: 'Pausa',
    operator: 'Manda, espera, manda',
    local: true,
    maxConcurrentRequests: 4
  })

  pausaModelo = { modelo: 'p9', primero: PRIMERO, segundo: SEGUNDO, ms: 900 }

  const cuerpo = {
    model: 'pausa-9',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  t.is(desafio.status, 402)
  const pago = await firmarPago(desafio.json)

  const parcial = await pedirYCortar('/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  const id = idDeSSE(parcial.body)
  t.ok(id, 'el cliente alcanzo a ver el primer delta antes de irse')
  t.ok(parcial.body.indexOf(PRIMERO) !== -1, 'y ese delta es el primer pedazo')

  // La liquidacion y la firma ocurren DESPUES de que el socket ya se cerro.
  await esperar(1600)

  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 200, 'hay recibo: el trabajo se hizo y el prefijo llego (D27 caso 1)')
  t.is(rec.json.success, true, 'y SI se cobra, hasta ahi')

  const a = rec.json.attestation
  t.ok(a, 'con atestacion PARCIAL')
  t.ok((await at.verificar(a)).ok, 'firmada y verificable como cualquier otra')
  t.is(a.finishReason, 'client_cancelled', 'que dice como termino, sin aplanarlo a stop')

  // Lo que hace verificable a la parcial: el hash es del prefijo que el cliente
  // EFECTIVAMENTE recibio, no el de la respuesta que se hubiera generado. Antes
  // el gateway seguia acumulando en `contenido` lo que llegaba despues del
  // corte, asi que el hash cubria texto que nadie vio.
  t.is(a.outputHash, at.hashDe(PRIMERO), 'sobre el prefijo emitido, no sobre la respuesta entera')
  t.absent(
    a.outputHash === at.hashDe(PRIMERO + SEGUNDO),
    'y NO sobre lo que el proveedor mando despues de que el cliente se fue'
  )

  pausaModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D24: sin firmante NO sale una atestacion, y el recibo dice por que', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  // Con wallet -- asi que se cobra -- y sin firmante. Es el estado real de un
  // nodo cuya passphrase no abrio el keystore: puede anunciar direccion desde el
  // manifiesto viejo y no puede firmar nada.
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))
  gw.setWalletSigner(null)

  const { r } = await pagarYPedir({
    model: 'facturas-ar',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(r.status, 200, 'el request se sirve igual: la atestacion no es una puerta')

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.json.attestation, null, 'y no sale una atestacion sin firma')
  t.ok(rec.json.attestationMissing, 'la ausencia viene con motivo: ' + rec.json.attestationMissing)
  t.ok(
    String(rec.json.attestationMissing).indexOf('firm') !== -1,
    'que dice cual de los motivos posibles fue'
  )

  await soltarProveedor()
})

// ---------------------------------------------------------------------------
// FASE 9 — el DoD contra un PAR, no contra un upstream
//
// Los tres casos de D27 de mas arriba corren contra el asistente externo, que es
// HTTP. El DoD de la Fase 9 habla de "matar EL NODO a mitad de stream", y un
// nodo no es HTTP: es el canal del swarm, con su propio framing y su propio
// chat:cancel. Son dos transportes con garantias distintas y hace falta
// ejercitar los dos.
//
// El swarm falso es el minimo que `streamFromPeer` le pide -- chatRequest,
// cancelChat, y los cuatro callbacks --, y existe sobre todo por UNA propiedad
// que HTTP no puede reproducir: **un chat:cancel tarda un round trip, y el par
// sigue generando mientras tanto**. Los chunks que ya venian en camino llegan
// DESPUES de que el gateway decidio cortar, y lo que se haga con ellos decide si
// el outputHash de D27 caso 1 vale o no.
// ---------------------------------------------------------------------------

const PEER_KEY = 'ee'.repeat(32)
const MODELO_PAR = 'par-9'
const WALLET_DEL_PAR = '0x' + '5c'.repeat(20)

function manifiestoDelPar() {
  return {
    metadata: { operator: 'Par de prueba', tags: ['general'] },
    // D10 — el payTo del 402 sale de ACA, del manifiesto firmado del par, no de
    // una constante nuestra. Es la wallet DEL PAR, no la de este gateway.
    economic: { walletAddress: WALLET_DEL_PAR, chains: ['stable'], settlement: 'batch-receipts' },
    models: [
      { modelId: MODELO_PAR, displayName: 'Modelo del par', qos: { maxConcurrentRequests: 4 } }
    ]
  }
}

// `guion` recibe los callbacks y un objeto con el que puede colgar un chunk
// "en vuelo": el que va a llegar cuando el cancel ya salio.
function swarmFalso(guion) {
  let n = 0
  const enVuelo = new Map()
  return {
    operator: 'Yo mismo',
    identity: { publicKey: Buffer.alloc(32, 7) },
    models: [],
    verifiedPeers: () => [{ peerKey: PEER_KEY }],
    chatRequest(peerKey, pedido, cbs) {
      const id = 'req-' + ++n
      const estado = { cbs, tardio: null }
      enVuelo.set(id, estado)
      // Asincronico como el de verdad: el par contesta despues de que
      // chatRequest devolvio, no adentro.
      const t = setTimeout(() => guion(cbs, estado), 0)
      if (t.unref) t.unref()
      return id
    },
    cancelChat(id) {
      const e = enVuelo.get(id)
      if (!e || e.cortado) return
      e.cortado = true
      // EL PUNTO DE TODO ESTO. En una red real el chat:cancel tarda un round
      // trip y el par no para en seco: lo que ya habia salido llega igual,
      // DESPUES de que este lado decidio cortar. Aca eso es sincronico y
      // deterministico en vez de una carrera.
      if (e.tardio) e.cbs.onChunk(e.tardio)
    }
  }
}

async function conParRegistrado(guion) {
  const store = await import('../qvac/store.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default
  // El facilitator falso se apunta ACA y no en cada test: sin esto `liquidar`
  // sale al de verdad por internet, el test pasa por el motivo equivocado -- el
  // recibo se guarda igual cuando la liquidacion falla -- y ademas `npm test`
  // deja de correr sin red.
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  store.upsertFromManifest(PEER_KEY, manifiestoDelPar())
  gw.setSwarm(swarmFalso(guion))
}

async function soltarPar() {
  const store = await import('../qvac/store.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default
  gw.setSwarm(null)
  store.removeByPeer(PEER_KEY, { hard: true })
  delete env[x402.VAR_FACILITATOR]
}

test('FASE 9 DoD: matar el nodo a mitad de stream NO cobra', async (t) => {
  // El par acepta, manda un token, y se muere. Es la tercera linea del DoD de la
  // Fase 9 y la que el propio roadmap marca como la que mas facil se rompe:
  // la verificacion protege al proveedor de gastar GPU gratis, la FALTA de
  // liquidacion protege al cliente de pagar por lo que no recibio.
  await conParRegistrado((cbs) => {
    cbs.onAccepted()
    cbs.onChunk('empiezo a contestar')
    cbs.onError('el par se cayo', 'peer_gone')
  })

  const cuerpo = {
    model: MODELO_PAR,
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  t.is(desafio.status, 402, 'el 402 sale con la wallet DEL PAR (D10)')
  t.is(desafio.json.accepts[0].payTo, WALLET_DEL_PAR, 'no la de este gateway')

  const pago = await firmarPago(desafio.json)
  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  t.ok(r.body.indexOf('empiezo a contestar') !== -1, 'el cliente vio lo que alcanzo a llegar')
  t.absent(r.body.indexOf('paymentResponse') !== -1, 'y NO hay recibo: no se liquido')

  const id = idDeSSE(r.body)
  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 404, 'no hay nada que recuperar, porque no se cobro')

  await soltarPar()
})

test('D27 caso 1: los chunks que llegan DESPUES del cancel no entran al hash', async (t) => {
  const VISTO = 'esto lo recibio el cliente'
  const TARDIO = ' y esto llego despues del cancel'

  await conParRegistrado((cbs, estado) => {
    cbs.onAccepted()
    cbs.onChunk(VISTO)
    // Cuelga el chunk tardio: sale cuando el gateway mande el chat:cancel.
    estado.tardio = TARDIO
  })

  const cuerpo = {
    model: MODELO_PAR,
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpo })
  t.is(desafio.status, 402)
  const pago = await firmarPago(desafio.json)

  const parcial = await pedirYCortar('/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  const id = idDeSSE(parcial.body)
  t.ok(id, 'el cliente vio el primer chunk y se fue')
  t.absent(parcial.body.indexOf(TARDIO) !== -1, 'el tardio NUNCA se le escribio al cliente')

  await esperar(1200)

  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 200, 'se cobra hasta ahi (D27 caso 1)')
  t.is(rec.json.success, true, 'y la liquidacion salio bien, no solo se guardo el intento')

  // El par NO firma acá: el 402 pago a SU wallet y el que corrio el modelo fue
  // el. Este gateway no puede atestiguar trabajo ajeno.
  t.is(rec.json.attestation, null, 'y este nodo no atestigua lo que sirvio otro (D24)')
  t.ok(
    String(rec.json.attestationMissing).indexOf('Fase 10') !== -1,
    'la ausencia dice de quien es la firma y cuando llega: ' + rec.json.attestationMissing
  )

  // Lo que si se puede verificar de este lado: que el rastro no cuente el chunk
  // tardio. Es el mismo invariante que el outputHash de una parcial servida por
  // este nodo -- lo que se registra es lo que el cliente recibio, no lo que el
  // proveedor siguio mandando despues de que se fue.
  const e = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  t.is(e.finishReason, 'client_cancelled', 'el rastro dice quien corto')
  t.is(e.tokens, 1, 'y conto UN chunk, no dos: el tardio se descarto')

  await soltarPar()
})

// ---------------------------------------------------------------------------
// FASE 9 — QUE LO EMITIDO LLEGUE AL PANEL
//
// Los tests de arriba prueban que el gateway EMITE los cuatro artefactos. Estos
// prueban lo otro, que es lo que faltaba: que ese dato, tal como sale por HTTP,
// llega al panel CON SU SIGNIFICADO. No alcanza con que el HTML se sirva -- eso
// ya lo miraba "los cuatro paneles siguen renderizando", y se seguia sirviendo
// perfecto con los cuatro artefactos invisibles adentro.
//
// Se ejercita `qvac/panel-x402.mjs`, que es literalmente el codigo que pages.mjs
// pega adentro del <script> de cada pagina. Alimentado, aca, con las respuestas
// REALES del gateway y no con fixtures escritos a mano: un fixture que envejece
// mal es exactamente como se pierde de vista que un campo cambio de forma.
// ---------------------------------------------------------------------------

test('FASE 9 visible: el 402 real llega al panel con los CUATRO datos', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const px = await import('../qvac/panel-x402.mjs')

  const direccion = '0x' + 'ab'.repeat(20)
  gw.setEconomic(wallet.economicDe(direccion))

  const r = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 402, 'el nodo pide pago')

  // Antes de esto, el chat aplanaba el 402 a "[error] HTTP 402" y los cuatro
  // datos del DoD se perdian en el camino.
  const v = px.vistaDeDesafio(r.json)
  t.ok(v.esDesafio, 'el panel lo reconoce como un cobro y no como un error')
  const o = v.opciones[0]
  t.is(o.monto, r.json.accepts[0].amount, 'CUANTO, tal como salio del endpoint')
  t.is(o.payTo, direccion, 'A QUIEN')
  t.is(o.red.id, r.json.accepts[0].network, 'EN QUE CADENA, con el CAIP-2 crudo')
  t.is(o.tope, r.json.accepts[0].outputTokenLimit, 'HASTA CUANTOS TOKENS')

  const html = px.htmlDeDesafio(v)
  t.ok(html.indexOf(direccion) !== -1, 'la direccion se dibuja entera, no recortada')
  t.ok(html.indexOf(String(o.tope)) !== -1, 'y el tope tambien')
  t.ok(html.indexOf(o.red.id) !== -1, 'con el id de la red, no solo el nombre')

  gw.setEconomic(null)
})

test('FASE 9 visible: el recibo y la atestacion, con el outputHash comparado', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const p = await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]
  const { r } = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(r.status, 200)

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.status, 200)

  const contenido = r.json.choices[0].message.content
  const vista = px.vistaDeAtestacion(rec.json, { textoRecibido: contenido, messages })

  // ESTO es lo que hace que la atestacion sea evidencia y no un campo: el hash
  // se recomputa en el panel sobre el texto que el cliente recibio. Que el
  // gateway lo haya calculado bien ya se probaba; que una persona lo pueda
  // COMPROBAR mirando, no.
  const out = vista.hashes.filter((h) => h.campo === 'outputHash')[0]
  t.is(out.estado, 'coincide', 'el outputHash recomputado en el panel coincide')
  t.is(out.declarado, rec.json.attestation.outputHash)
  const prompt = vista.hashes.filter((h) => h.campo === 'promptHash')[0]
  t.is(prompt.estado, 'coincide', 'y el promptHash, sobre la conversacion entera')

  // Regla 2: la corrida es en modo --demo, o sea que el texto es inventado y la
  // firma es de una wallet real. El panel tiene que decir las dos cosas.
  t.is(rec.json.attestation.runtime, 'mock', 'el artefacto lo declara')
  t.ok(vista.esMock, 'y el panel lo levanta')
  t.is(vista.providerPubkey, p.address, 'firmada por la direccion de cobro de este nodo')

  const html = px.htmlDeRecibo(rec.json, { textoRecibido: contenido, messages })
  t.ok(html.indexOf('runtime: mock') !== -1, 'un mock se VE como mock en la pantalla')
  t.ok(html.indexOf('coincide') !== -1, 'y la comparacion de hash se dibuja')

  // Regla 4: contra el facilitator falso el tx es 0xfe...fe, y en el explorer no
  // existe. Es el estado REAL de este arbol -- el item del DoD que quedo afuera
  // (0-quater) -- y el panel no lo puede presentar como una transaccion.
  const liq = px.vistaDeLiquidacion(px.liquidacionDe(rec.json))
  t.ok(liq.liquidado, 'el facilitator informo exito')
  t.ok(liq.txSintetico, 'pero el hash es el sello de un facilitator de pruebas')
  t.ok(html.indexOf('facilitator de PRUEBAS') !== -1, 'y eso se dibuja al lado del hash')

  await soltarProveedor()
})

test('FASE 9 visible: la atestacion que falta llega al panel CON el motivo', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const px = await import('../qvac/panel-x402.mjs')
  const env = (await import('bare-env')).default

  // Con wallet -- asi que cobra -- y sin firmante: el estado real de un nodo
  // cuya passphrase no abrio el keystore. No se emite una atestacion sin firma.
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))
  gw.setWalletSigner(null)

  const { r } = await pagarYPedir({
    model: 'facturas-ar',
    messages: [{ role: 'user', content: 'hola' }]
  })
  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.json.attestation, null)

  const vista = px.vistaDeAtestacion(rec.json, {})
  t.absent(vista.hay)
  t.is(vista.motivo, rec.json.attestationMissing, 'el motivo del endpoint viaja SIN resumir')
  t.ok(vista.motivoDeclarado, 'y consta que alguien lo declaro')

  const html = px.htmlDeAtestacion(vista)
  t.ok(html.indexOf(rec.json.attestationMissing) !== -1, 'el motivo se dibuja completo')
  t.absent(html.indexOf('coincide') !== -1, 'y no se afirma nada sobre hashes que no existen')

  await soltarProveedor()
})

test('FASE 9 visible: el rastro llega al panel con el split Y su procedencia', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const px = await import('../qvac/panel-x402.mjs')

  // 1. Un proveedor que manda `usage`: son tokens contados por SU tokenizador.
  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'd25panel',
        label: 'Manda usage',
        local: true,
        baseUrl: 'http://127.0.0.1:' + PUERTO_EXTERNO + '/v1',
        models: [{ modelId: 'u', as: 'd25-panel', maxTokens: 256 }]
      }
    ]
  })
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: 'd25-panel',
    displayName: 'D25 panel',
    operator: 'Manda usage',
    local: true,
    maxConcurrentRequests: 4
  })

  const conUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'd25-panel', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conUsage.status, 200)

  const e1 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  const medido = px.vistaDeConteo(e1)
  t.is(medido.fuente, 'proveedor')
  t.ok(medido.medido, 'el panel lo levanta como medido')
  t.is(medido.prefill, e1.tokensPrefill, 'y muestra los numeros del rastro, no otros')
  t.is(medido.decode, e1.tokensDecode)

  store.clearUpstreams()
  gw.setUpstreams([])

  // 2. Un mock no manda `usage`. Lo que queda es una estimacion del prompt y un
  //    conteo de deltas: NO se puede dibujar igual que lo de arriba.
  const sinUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinUsage.status, 200)

  const e2 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  const estimado = px.vistaDeConteo(e2)
  t.is(estimado.fuente, 'gateway')
  t.absent(estimado.medido, 'un conteo de chunks de SSE no es una medicion')

  t.absent(
    px.htmlDeConteo(medido) === px.htmlDeConteo(estimado),
    'y los dos rastros REALES no se dibujan igual'
  )
  t.ok(px.htmlDeConteo(estimado).indexOf('tono-estimado') !== -1)
  t.ok(px.htmlDeConteo(medido).indexOf('tono-medido') !== -1)

  // D27 tambien viaja en el rastro: sin esto, un corte del cliente y una
  // respuesta completa se ven identicos en el panel.
  t.ok(e2.finishReason, 'el rastro declara como termino: ' + e2.finishReason)
  t.ok(px.textoDeFinishReason(e2.finishReason).length > 0, 'y el panel lo dice en palabras')
})

test('FASE 9 visible: los paneles servidos LLEVAN el codigo que dibuja todo esto', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // El grep que abrio este trabajo: `receipts`, `attestation`, `x402`, `402`,
  // `tokensPrefill`, `tokensDecode`, `tokensFuente`, `finishReason` y
  // `outputHash` daban CERO sobre pages.mjs. Los cuatro artefactos se servian
  // por HTTP y solo se veian con curl.
  //
  // Se mira el HTML SERVIDO y no el modulo: entre los dos hay una interpolacion
  // que puede quedar afuera sin que nada falle, y el panel se serviria igual --
  // completo, y sin nada de la Fase 9 adentro.
  const chat = await pedir('GET', '/')
  const node = await pedir('GET', '/node')
  const admin = await pedir('GET', '/admin')
  for (const p of [chat, node, admin]) t.is(p.status, 200)

  for (const [nombre, p] of [
    ['/', chat],
    ['/node', node],
    ['/admin', admin]
  ]) {
    t.ok(
      p.body.indexOf(px.FUENTE_EMBEBIDA) !== -1,
      nombre + ' lleva embebido el codigo de panel-x402.mjs, entero'
    )
  }

  // Y que ese codigo este CONECTADO a algo, que es lo que el HTML servido puede
  // demostrar y el modulo solo no: pegarlo sin llamarlo seria pasar este test
  // con los paneles igual de ciegos que antes.
  //
  // Se busca cada LUGAR DE LLAMADA y no el nombre de la funcion pelado, y la
  // diferencia no es cosmetica: `FUENTE_EMBEBIDA` contiene las definiciones, o
  // sea que un `indexOf('htmlDeDesafio(')` da positivo aunque nadie la llame
  // nunca. Un test que se satisface con la definicion no vigila el cable.
  //
  // EL LIMITE, dicho: esto comprueba que el cable existe en el HTML servido, no
  // que el navegador lo ejecute. Lo que corre de verdad son las funciones, y eso
  // lo prueba la suite unitaria contra la MISMA fuente que se embebe aca. Un
  // browser headless seria la unica forma de cerrar el ultimo tramo y no entra
  // en este arbol.
  t.ok(chat.body.indexOf('htmlDeDesafio(m.x402)') !== -1, 'el chat dibuja el 402 del turno')
  t.ok(chat.body.indexOf('htmlDeRecibo(m.recibo,') !== -1, 'y el recibo con su atestacion')
  t.ok(chat.body.indexOf('slot.recibo = ev') !== -1, 'guardando el evento SSE final de D12')
  t.ok(
    chat.body.indexOf('vistaDeDesafio(b)') !== -1,
    'y leyendo el cuerpo del 402 en vez de aplanarlo'
  )
  t.ok(
    node.body.indexOf('htmlDeRecibo(await r.json(), ctx)') !== -1,
    '/node dibuja el recibo que busca'
  )
  t.ok(node.body.indexOf('htmlDeConteo(vistaDeConteo(e))') !== -1, '/node pinta el split de D25')
  t.ok(admin.body.indexOf('htmlDeConteo(vistaDeConteo(e))') !== -1, 'y el log de admin tambien')

  // Y esta, que es una propiedad y no un detalle: `GET /v1/receipts/:id` es la
  // UNICA ruta que no pide credencial, porque quien pago por 402 no tiene
  // ninguna -- ese es todo el punto del 402. Si el panel la pidiera con
  // `authFetch`, esconderia esa propiedad detras de un header que no hace falta,
  // y el dia que alguien copie el patron el gate se le colaria a la ruta.
  t.ok(
    node.body.indexOf("await fetch('/v1/receipts/") !== -1,
    '/node busca el recibo SIN credencial, que es la excepcion deliberada a B12'
  )

  // Regla 5: el costo del header es el TECHO estimado -- con SSE los headers
  // salen antes del primer token --, y el chat ya lo decia bien con "up to
  // USD ..." / "no charge". Lo que cambia es que ahora esa regla vive en UN solo
  // lugar, con las vistas nuevas: dos implementaciones de la misma frase es como
  // una de las dos se afloja sin que nadie se entere.
  t.ok(
    chat.body.indexOf('textoDeCostoEstimado(m.cost)') !== -1,
    'el costo del turno usa la misma regla que las vistas nuevas'
  )

  // Los nueve terminos del grep, ahora en el HTML que se sirve.
  const terminos = [
    'attestation',
    'x402',
    '402',
    'tokensPrefill',
    'tokensDecode',
    'tokensFuente',
    'finishReason',
    'outputHash'
  ]
  for (const term of terminos) {
    t.ok(chat.body.indexOf(term) !== -1, 'el chat menciona ' + term)
    t.ok(node.body.indexOf(term) !== -1, '/node menciona ' + term)
  }
  t.ok(node.body.indexOf('receipts') !== -1, '/node menciona receipts')
})

test('D30.4: los errores del facilitator sobreviven al CLIENTE OFICIAL, no solo a un curl', async (t) => {
  // POR QUE ESTE TEST EXISTE, Y POR QUE MIRA CON OTRO CLIENTE.
  //
  // El test de arriba comprueba el JSON crudo con `pedirle`, que es un cliente
  // escrito a mano. Eso alcanza para ver que hay un cuerpo, y NO alcanza para
  // ver si ese cuerpo sirve: `@x402/core` parsea toda respuesta 200 contra un
  // schema de zod, y ahi se pierden cosas que en el crudo se ven perfectas.
  //
  // Pasaba de verdad, en las dos rutas y de dos formas distintas:
  //
  //   /verify  el cuerpo llevaba `errorReason`/`errorMessage` -- los nombres de
  //            SETTLE --, zod los DESCARTA sin quejarse, y el gateway recibia
  //            `{isValid:false}` pelado. El motivo no se perdia en la red: se
  //            perdia en el parseo, que es peor porque no hace ruido.
  //   /settle  el cuerpo no llevaba `transaction` ni `network`, que el schema
  //            exige como string aunque la liquidacion haya fallado. Zod
  //            rechazaba la respuesta ENTERA y el cliente tiraba
  //            `FacilitatorResponseError`, con el motivo real anidado adentro
  //            del texto de otra excepcion.
  //
  // Las dos rompian lo unico que el bloque de errores del facilitator existe
  // para sostener: del otro lado hay un gateway que YA sirvio los tokens -- D12
  // liquida DESPUES -- y que tiene que poder registrar POR QUE no cobro. Ese
  // campo termina en el recibo, en el panel, y es lo que la Fase 10 va a leer
  // para decidir si un fallo se reintenta, se descarta, o acusa a alguien.
  //
  // Por eso el test usa `HTTPFacilitatorClient`: es EL MISMO cliente que usa
  // `x402.liquidar()` en produccion. Un test que valida contra un cliente que no
  // es el que corre es exactamente el agujero que dejo pasar esto.
  const base = 'http://127.0.0.1:' + (PUERTO_FACILITATOR_REAL + 2)
  const f = correrFacilitator({
    PYRUS_FACILITATOR_CLAVE: CLAVE_DE_PRUEBA,
    PYRUS_FACILITATOR_PUERTO: String(PUERTO_FACILITATOR_REAL + 2),
    PYRUS_FACILITATOR_CHAINID: '9746',
    PYRUS_FACILITATOR_RPC: 'http://127.0.0.1:1/no-existe'
  })

  try {
    t.ok(await f.listo('facilitator  http://'), 'arranco: ' + f.salida().slice(0, 200))

    const { HTTPFacilitatorClient } = await import('@x402/core/http')
    const cliente = new HTTPFacilitatorClient({ url: base })

    // Un pago de LA RED CORRECTA -- asi pasa el guardia de red y llega adentro
    // -- pero incompleto, que es lo que hace reventar al facilitator y lleva al
    // camino de error. No hace falta tocar la cadena para provocarlo.
    const pago = { x402Version: 2, scheme: 'exact', network: 'eip155:9746', payload: {} }
    const requisitos = {
      scheme: 'exact',
      network: 'eip155:9746',
      amount: '1000',
      asset: '0x' + '11'.repeat(20),
      payTo: '0x' + 'ab'.repeat(20),
      resource: 'http://127.0.0.1/v1/chat/completions',
      description: '',
      mimeType: 'application/json',
      maxTimeoutSeconds: 300,
      extra: { name: 'x', version: '1' }
    }

    const v = await cliente.verify(pago, requisitos)
    t.absent(v.isValid, 'no da por valido lo que no pudo procesar')
    t.is(v.invalidReason, 'facilitator_error', 'y el MOTIVO llega al cliente')
    t.ok(v.invalidMessage, 'con el detalle adentro: ' + v.invalidMessage)

    // Este es el que tiraba. Se atrapa a proposito en vez de dejar que rompa la
    // corrida: un throw acá se lee como "el test esta roto" y lo que pasa es que
    // el facilitator contesto algo que el cliente no puede leer.
    let s = null
    let tiro = null
    try {
      s = await cliente.settle(pago, requisitos)
    } catch (err) {
      tiro = err
    }
    t.absent(
      tiro,
      'settle no puede tirar: el cliente tiene que poder LEER el fallo. ' +
        ((tiro && tiro.name + ': ' + tiro.message.slice(0, 160)) || '')
    )
    t.absent(s && s.success, 'no dice que cobro')
    t.is(s && s.errorReason, 'facilitator_error', 'y el motivo llega')
    t.ok(s && s.errorMessage, 'con el detalle: ' + (s && s.errorMessage))
    // Los dos campos que el schema exige aunque no haya transaccion. Sin ellos
    // se descarta TODO lo de arriba.
    t.is(typeof (s && s.transaction), 'string', 'transaction presente aunque vacio')
    t.is(s && s.network, 'eip155:9746', 'y la red del PAGO, que es la que sirve para debuggear')
  } finally {
    f.matar()
  }
})

test('cierra el facilitator falso', async (t) => {
  if (servidorFacilitator) servidorFacilitator.close()
  t.pass('apagado')
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

// ---------------------------------------------------------------------------
// D30.4 / D14(b) — EL FACILITATOR SELF-HOSTED
//
// D14 habia elegido el hosted de Semantic "hasta la Fase 10". D30 lo adelanto
// por dos hechos: el hosted devolvia 500/503 en TODOS sus endpoints el
// 2026-08-27, y no soporta 9746 -- ni va a conocer un token que desplegamos
// nosotros. Sin facilitator no hay settlement, asi que sin esto la Fase 10 se
// puede escribir pero no demostrar.
//
// ESTO NO SALE A INTERNET, y no es por suerte: los tres endpoints que se prueban
// (`/supported`, y los dos rechazos) se contestan SIN tocar la cadena. El RPC
// que se le pasa apunta a un puerto donde no hay nada, a proposito -- si alguna
// de estas respuestas necesitara la red, el test colgaria y eso seria la senal.
//
// Corre en un proceso NODE aparte porque el facilitator es Node y no Bare. Eso
// tambien es parte de lo que se prueba: que sea un servicio separado es
// exactamente por que no viola D11 (ver el encabezado de scripts/facilitator.js).
// ---------------------------------------------------------------------------

// 8894 y 8895. NO 8897: ese es el del facilitator FALSO de mas arriba, y aunque
// para entonces ya este cerrado, apoyarse en el orden de los tests para que dos
// servidores no choquen es una intermitencia esperando a que alguien reordene.
let PUERTO_FACILITATOR_REAL = 8894

// Una clave de prueba conocida y publica (la #2 de anvil). NUNCA se fondea, y
// aca ni siquiera firma nada: solo hace falta para que el signer tenga una
// direccion que poner en `/supported`.
const CLAVE_DE_PRUEBA = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

function correrFacilitator(env) {
  const { spawn } = require('bare-subprocess')
  const path = require('bare-path')
  const raiz = path.join(__dirname, '..')

  const hijo = spawn('node', [path.join(raiz, 'scripts', 'facilitator.js')], {
    cwd: raiz,
    env: Object.assign({}, require('bare-env'), env),
    stdio: 'pipe'
  })

  let salida = ''
  hijo.stdout.on('data', (c) => {
    salida += c
  })
  hijo.stderr.on('data', (c) => {
    salida += c
  })

  return {
    hijo,
    salida: () => salida,
    // Se espera a que DIGA que esta escuchando en vez de dormir un rato fijo:
    // un sleep que alcanza en esta maquina no alcanza en la de al lado, y el
    // test se vuelve intermitente en vez de romperse.
    async listo(marca, ms = 20000) {
      const hasta = Date.now() + ms
      while (Date.now() < hasta) {
        if (salida.indexOf(marca) !== -1) return true
        if (hijo.exitCode !== null && hijo.exitCode !== undefined) return false
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    },
    matar() {
      try {
        hijo.kill()
      } catch {}
    }
  }
}

function pedirle(url, metodo, cuerpo) {
  return new Promise((resolve, reject) => {
    const headers = {}
    let payload = null
    if (cuerpo !== undefined && cuerpo !== null) {
      payload = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = http.request(url, { method: metodo, headers }, (res) => {
      let d = ''
      res.on('data', (c) => {
        d += c
      })
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(d)
        } catch {}
        resolve({ status: res.statusCode, json, crudo: d })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('D30.4: el facilitator self-hosted levanta y declara 9746, que ninguno hosted conoce', async (t) => {
  const base = 'http://127.0.0.1:' + PUERTO_FACILITATOR_REAL
  const f = correrFacilitator({
    PYRUS_FACILITATOR_CLAVE: CLAVE_DE_PRUEBA,
    PYRUS_FACILITATOR_PUERTO: String(PUERTO_FACILITATOR_REAL),
    PYRUS_FACILITATOR_CHAINID: '9746',
    // Un RPC que NO existe. Ver el encabezado: si algo de lo que se prueba
    // necesitara la cadena, esto lo delata en vez de esconderlo.
    PYRUS_FACILITATOR_RPC: 'http://127.0.0.1:1/no-existe'
  })

  try {
    t.ok(await f.listo('facilitator  http://'), 'arranco: ' + f.salida().slice(0, 200))

    const sup = await pedirle(base + '/supported', 'GET')
    t.is(sup.status, 200, 'GET /supported contesta 200 -- que es lo que el hosted NO hacia')

    const kinds = (sup.json && sup.json.kinds) || []
    t.ok(
      kinds.some((k) => k.network === 'eip155:9746' && k.scheme === 'exact'),
      'y declara eip155:9746 con esquema exact: ' + JSON.stringify(kinds)
    )

    // LO QUE ANUNCIA TIENE QUE SER LO QUE PUEDE CUMPLIR.
    //
    // `registerExactEvmScheme` no registra solo lo que se le pide: adentro llama
    // a `registerV1` con su propia lista de fabrica, que trae `ethereum`, `base`
    // y demas. Un `/supported` crudo anunciaria MAINNETS que este proceso no
    // puede servir -- el signer y el RPC estan en 9746 -- y que D30 dice que no
    // se tocan. Alguien lee eso, manda un pago, y nadie lo liquida.
    t.is(
      kinds.filter((k) => k.network !== 'eip155:9746').length,
      0,
      'y NADA MAS: no anuncia una sola red que no pueda servir'
    )
    t.absent(
      JSON.stringify(kinds).indexOf('ethereum') !== -1,
      'en particular, ninguna mainnet de la lista de fabrica'
    )

    // El nodo lo apunta con la MISMA variable con la que apunta al hosted, asi
    // que cambiar de uno al otro es configuracion y no codigo (D14 -> D14(b)).
    const x402 = await import('../qvac/x402.mjs')
    t.is(x402.VAR_FACILITATOR, 'PYRUS_X402_FACILITATOR', 'se apunta sin tocar codigo')

    // Un pago de OTRA red se rechaza ANTES de mirar la firma, y con motivo. Que
    // el motivo diga las dos redes es lo que hace debuggeable un settlement que
    // no ocurrio.
    const otraRed = await pedirle(base + '/settle', 'POST', {
      paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:9745', payload: {} },
      paymentRequirements: { network: 'eip155:9745' }
    })
    t.is(otraRed.status, 200)
    t.absent(otraRed.json && otraRed.json.success, 'un pago de mainnet no se liquida aca')
    t.is(otraRed.json && otraRed.json.errorReason, 'unsupported_network')
    t.ok(
      String(otraRed.json.errorMessage).indexOf('eip155:9746') !== -1,
      'y el motivo nombra las dos redes: ' + otraRed.json.errorMessage
    )

    // Y basura no tira un 500 pelado: del otro lado hay un gateway que YA sirvio
    // los tokens (D12 liquida despues) y necesita poder registrar por que no se
    // liquido. Un 500 sin cuerpo se convierte en "settlement_failed" sin motivo.
    //
    // El nombre del campo NO es indistinto, y este assert pedia el equivocado:
    // `/verify` habla `invalidReason`/`invalidMessage` y `/settle` habla
    // `errorReason`/`errorMessage`. Pedir `errorMessage` en una respuesta de
    // verify pasaba mirando el JSON crudo y fallaba donde importa, porque el
    // schema de `@x402/core` descarta las claves de la otra ruta sin quejarse.
    // Eso se ve con el cliente oficial, no con esto -- ver el test de abajo.
    const basura = await pedirle(base + '/verify', 'POST', '{no soy json')
    t.is(basura.status, 200, 'contesta estructurado, no un 500 pelado')
    t.absent(basura.json && basura.json.isValid, 'y no da por valido lo que no pudo leer')
    t.ok(
      basura.json && basura.json.invalidMessage,
      'con el motivo adentro, en el campo que verify declara: ' + basura.crudo.slice(0, 120)
    )
  } finally {
    f.matar()
  }
})

test('D30.4: el facilitator NO se levanta contra mainnet, y no hay flag que lo saltee', async (t) => {
  // Un facilitator es, literalmente, el componente que mueve valor: es el que
  // difunde la transaccion. Si hay un solo lugar donde el guardia de D30 no
  // puede faltar, es este.
  const f = correrFacilitator({
    PYRUS_FACILITATOR_CLAVE: CLAVE_DE_PRUEBA,
    PYRUS_FACILITATOR_PUERTO: String(PUERTO_FACILITATOR_REAL + 1),
    // 9745 es el default de D15, o sea el error mas facil de cometer.
    PYRUS_FACILITATOR_CHAINID: '9745',
    PYRUS_FACILITATOR_RPC: 'http://127.0.0.1:1/no-existe'
  })

  try {
    const arranco = await f.listo('facilitator  http://', 8000)
    t.absent(arranco, 'no levanta contra 9745')
    t.ok(f.salida().indexOf('MAINNET') !== -1, 'y dice por que: ' + f.salida().slice(0, 220))
    t.ok(
      f.salida().indexOf('D30') !== -1,
      'nombrando la decision, para que se pueda discutir en vez de parchear'
    )
  } finally {
    f.matar()
  }
})

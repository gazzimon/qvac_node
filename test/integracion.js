// INTEGRATION tests: they bring up the real gateway and talk to it over HTTP.
//
// They exist because test/index.js tests each module in isolation -- costs
// without budget, routing without store, quota without provider -- and what
// breaks when two branches meet is almost never a module: it's the cable
// between two of them.
//
// Everything runs in ONE process and without network: `createGateway` binds
// 127.0.0.1 and the client is the same bare-http1 the server uses. What needs
// two machines still lives in docs/RUNBOOK-2-MAQUINAS.md, not here.

const test = require('brittle')
const http = require('bare-http1')

// High ports of our own so we don't clash with a node the developer might have
// open on 8787 while the tests run.
//
// THEY'RE CHOSEN PER RUN, and that's not a preference: this suite opens four
// listeners and all four sit in TIME_WAIT when the process exits. On Windows
// that blocks rebinding them for up to two minutes, so TWO RUNS IN A ROW would
// die with "port 8899 already in use".
//
// And they died in the worst possible way: `createGateway` does `Bare.exit(1)`
// on EADDRINUSE -- which is correct for the product, because the operator has
// to find out -- so the process would leave BEFORE the first line of TAP. A
// run with not a single line of output is indistinguishable from a green run
// if you only look at the exit code, and `npm run bug-puesto` -- which chains
// one run per planted bug -- read it as "nobody is watching this bug". It
// happened: three entries from Phase 9 came out as NOT-CAUGHT with the bug
// planted and the test genuinely failing.
//
// The harness now tells that case apart (see `corrio()` in
// scripts/bug-puesto.js). This is the other half: making sure it doesn't
// happen again. A block of ports gets probed and the first one that's fully
// free gets used, which is deterministic -- rotating at random only makes the
// collision less frequent, not impossible.
// The block is reserved CONTIGUOUSLY and not just at the offsets used today:
// the facilitator tests open DERIVED ports (`PUERTO_FACILITATOR_REAL + 1`,
// `+ 2`), and an offset nobody checked is a port that could be taken by
// anything else on the machine. That comes back as this suite's most
// expensive failure: the run that dies before writing a single line of TAP.
const OFFSETS = [4, 5, 6, 7, 8, 9]

const PUERTOS_DESDE = 8800
const PUERTOS_HASTA = 9700

let PORT = 8899
let BASE = 'http://127.0.0.1:' + PORT

function puertoLibre(p) {
  return new Promise((resolve) => {
    const s = http.createServer(() => {})
    s.on('error', () => resolve(false))
    // A listener that never accepted a connection doesn't leave TIME_WAIT
    // behind when it closes, so if this probe binds, the real server will too.
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

// Reserves the whole block in one go: the four listeners have to land
// together, because each test references them by its offset.
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
    'no free block of ports between ' + PUERTOS_DESDE + ' and ' + PUERTOS_HASTA
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
          /* HTML or SSE */
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

// The gateway is brought up ONCE for the whole suite: starting it per test
// would make each one fight over the port with the previous one still closing.
let server = null
let KEY = null

test('brings up the gateway and hands out the panel key', async (t) => {
  const { createGateway } = await import('../qvac/gateway.mjs')

  // Before binding: see the note on PUERTOS_DESDE. Without this, the second
  // run in a row dies without writing a single line of TAP.
  await elegirPuertos()
  server = createGateway({ port: PORT, demo: true })

  // listen is asynchronous: we wait for the first request that answers.
  for (let i = 0; i < 50 && !KEY; i++) {
    try {
      const r = await pedir('GET', '/v1/keys/panel')
      if (r.json && r.json.key) KEY = r.json.key
    } catch (e) {
      await esperar(100)
    }
  }

  t.ok(KEY, 'the key bootstrap does not require a key: without this there would be no first access')
  t.ok(KEY.startsWith('qvac_sk_'), 'with the prefix that apikeys.mjs sets')
})

test('the port probe tells busy apart from free', async (t) => {
  // What this test watches is not a product feature: it's what lets THIS
  // SUITE run twice in a row. See the note on PUERTOS_DESDE above -- the
  // failure mode is the process dying before the first line of TAP, and a run
  // with no output is indistinguishable from a green one if you only look at
  // the exit code.
  //
  // If `puertoLibre` always said yes, `elegirPuertos` would hand back a busy
  // block and the gateway would do `Bare.exit(1)` -- meaning the failure would
  // come back exactly as it was, silently. That's why the probe itself gets
  // tested: it's the piece that can lie without making noise.
  const ocupado = await new Promise((resolve) => {
    const s = http.createServer(() => {})
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const puerto = ocupado.address().port

  t.absent(await puertoLibre(puerto), 'a port with a listener on it is NOT free')

  await new Promise((resolve) => ocupado.close(resolve))
  t.ok(await puertoLibre(puerto), 'and once closed it is again')

  // And that the chosen block is coherent: the four listeners have to land
  // together, because each test references them by its offset and a mixed
  // block would point half the suite at a port from another run.
  const base = PORT - 9
  t.is(PUERTO_EXTERNO, base + 8, 'the external provider, in the same block')
  t.is(PUERTO_FACILITATOR, base + 7, 'the fake facilitator too')
  t.is(PUERTO_FACILITATOR_REAL, base + 4, 'and the D30.4 self-hosted one')
  t.ok(base >= PUERTOS_DESDE && base <= PUERTOS_HASTA, 'within the declared range')

  // And the DERIVED ports also have to land inside the block. The two
  // facilitator tests open `+ 1` and `+ 2` on top of PUERTO_FACILITATOR_REAL:
  // if the block doesn't reserve them, they're ports nobody checked.
  for (const derivado of [
    PUERTO_FACILITATOR_REAL,
    PUERTO_FACILITATOR_REAL + 1,
    PUERTO_FACILITATOR_REAL + 2
  ]) {
    t.ok(
      OFFSETS.indexOf(derivado - base) !== -1,
      'port ' + derivado + ' (offset ' + (derivado - base) + ') is reserved'
    )
  }
})

// ---------------------------------------------------------------------------
// That the surfaces from phases 6.5, 6.6, and 8 answer AT THE SAME TIME. Each
// one came in through a different commit, and this is what no single test
// covers.
// ---------------------------------------------------------------------------

test('the routes from the three phases coexist in the same process', async (t) => {
  const rutas = [
    ['/v1/models', 'OpenAI catalog'],
    ['/v1/nodes', 'marketplace'],
    ['/v1/routing-log', 'routing trail (phase 8)'],
    ['/v1/quota', 'free quota (phase 6.6)']
  ]
  for (const par of rutas) {
    const r = await pedir('GET', par[0], { key: KEY })
    t.is(r.status, 200, par[0] + ' -> 200  (' + par[1] + ')')
  }
})

test('all four panels still render', async (t) => {
  const rutas = ['/', '/node', '/network', '/admin']
  for (const ruta of rutas) {
    const r = await pedir('GET', ruta)
    t.is(r.status, 200, ruta + ' -> 200')
    t.ok(r.body.indexOf('<') !== -1, ruta + ' returns HTML')
  }
})

// ---------------------------------------------------------------------------
// The cable that matters most: a chat has to leave a trail in the routing log
// AND settle in the ledger at the same time. They're two modules that came in
// through different commits and were never exercised together.
// ---------------------------------------------------------------------------

test('a chat leaves a routing trail and settles the budget', async (t) => {
  const antes = await pedir('GET', '/v1/quota', { key: KEY })

  const chat = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(chat.status, 200)
  t.ok(chat.json.choices[0].message.content.length > 0, 'answered something')

  // Phase 8: the decision got written down, with the reason.
  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entradas = Array.isArray(log.json) ? log.json : log.json.log || log.json.entries
  const ultima = entradas[0]
  t.ok(ultima.reason, 'the log says WHY it was chosen: ' + ultima.reason)
  t.ok(ultima.decision, 'and with what load it decided')
  t.is(ultima.decision.elegido, ultima.nodeId, 'the decision points at the node that answered')

  // Phase 6.5: the ledger settled this request. A mock costs zero and that is
  // the truth, not padding -- but the FIELD has to be there, or the phase
  // 8.5 trail starts with a hole in the old entries.
  t.is(typeof ultima.costMicros, 'number', 'the cost got recorded')

  // Phase 6.6: the quota measures what this node GIVES AWAY TO PEERS. A chat
  // of your own doesn't consume anyone's quota, and confusing the two would
  // mean charging the machine's owner for using their own machine.
  const despues = await pedir('GET', '/v1/quota', { key: KEY })
  t.is(
    despues.json.given_tokens,
    antes.json.given_tokens,
    'a chat of your own does not deduct peer quota'
  )
})

// ---------------------------------------------------------------------------
// The gates. Each one was added in a different commit and no unit test
// verifies they stay closed when they all coexist.
// ---------------------------------------------------------------------------

test('routes that spend or mutate still require the key', async (t) => {
  const chat = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(chat.status, 401, 'chat without a key -> 401')

  const conKeyMala = await pedir('POST', '/v1/chat/completions', {
    key: 'qvac_sk_inventada',
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conKeyMala.status, 401, 'a key that does not exist does not pass either')

  // Without a swarm this route short-circuits with 503 before even looking at
  // the key. The 401 is verified with `serve --swarm` (S3 of
  // NOTES-SATURACION.md); what matters here is that an anonymous caller
  // cannot edit the manifest.
  const manifiesto = await pedir('POST', '/v1/swarm/manifest', {
    body: { maxConcurrentRequests: 99 }
  })
  t.ok(
    manifiesto.status === 401 || manifiesto.status === 503,
    'the manifest is not edited anonymously (status ' + manifiesto.status + ')'
  )
})

// ---------------------------------------------------------------------------
// B12 — the routes that only READ also count
//
// B7 put a credential on GET /v1/upstream because, secrets aside, it said who
// the provider is, which models get paid for, and whether there's an account
// on the other end. The reasoning was correct and it was incomplete:
// /v1/nodes returns the same `operator` plus the `pricing`, and
// /v1/routing-log returns `costMicros` -- the spend in dollars, request by
// request -- which is MORE than /v1/upstream ever says. Closing one of the
// three doors and leaving two open protects nothing.
//
// The third, /v1/models, does NOT get closed: it's the OpenAI protocol
// catalog and a client has to be able to read it before having a key. The
// data gets pulled out instead of the door.
// ---------------------------------------------------------------------------

test('routes that only read money or provider also require the key', async (t) => {
  const nodos = await pedir('GET', '/v1/nodes')
  t.is(nodos.status, 401, 'the marketplace says operator and price: it is not public')

  const log = await pedir('GET', '/v1/routing-log')
  t.is(log.status, 401, 'and the trail says how much was spent, which is worse')

  const conKeyMala = await pedir('GET', '/v1/routing-log', { key: 'qvac_sk_inventada' })
  t.is(conKeyMala.status, 401, 'a key that does not exist does not pass either')

  // The other side: with a credential it still answers as usual. A gate that
  // breaks the panel is not a gate, it's a regression.
  const conKey = await pedir('GET', '/v1/nodes', { key: KEY })
  t.is(conKey.status, 200, 'with a key it is still the same marketplace')
  t.ok(Array.isArray(conKey.json.nodes), 'and in the same shape')
})

test('/v1/models stays open but no longer names the provider', async (t) => {
  const r = await pedir('GET', '/v1/models')
  t.is(r.status, 200, 'an OpenAI client discovers the catalog before having a key')
  t.ok(r.json.data.length > 0)

  // `owned_by` used to say "Proveedor de prueba (externo)" and with that
  // anyone who reached the port knew which API this node pays.
  const delatores = r.json.data.filter((m) => m.owned_by !== 'pyrusllm')
  t.is(delatores.length, 0, 'no row names the operator: ' + JSON.stringify(delatores))
})

// ---------------------------------------------------------------------------
// The two request extensions of our own. `local` is old and `node` came in
// with phase 8: what's tested is that they don't step on each other.
// ---------------------------------------------------------------------------

test('the machine pin coexists with local:true', async (t) => {
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
  t.is(fijado.status, 200, 'pinning a machine that exists answers')

  const fantasma = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: {
      model: 'facturas-ar',
      messages: [{ role: 'user', content: 'hola' }],
      node: 'no-existe'
    }
  })
  t.is(fantasma.status, 404, 'and one that does not exist does NOT fall back to another machine')
  t.is(fantasma.json.error.code, 'node_not_found')

  // local:true on a model only served by a local mock is still valid: the
  // filter removes peers, not mocks on this same machine.
  const soloLocal = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: {
      model: 'facturas-ar',
      messages: [{ role: 'user', content: 'h' }],
      local: true
    }
  })
  t.is(soloLocal.status, 200, 'local:true does not break the request')
})

test('provenance headers say which machine answered', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'traductor-en-es', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 200)
  t.ok(r.headers['x-pyrus-operator'], 'X-Pyrus-Operator present')
  t.ok(r.headers['x-pyrus-kind'], 'X-Pyrus-Kind present: ' + r.headers['x-pyrus-kind'])
})

// ---------------------------------------------------------------------------
// D5: never a silent hang. It's the gateway's oldest invariant and the one
// most easily broken when someone adds a new routing branch.
// ---------------------------------------------------------------------------

test('a model nobody serves gives 404 and says which ones DO exist', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'modelo-que-no-existe', messages: [{ role: 'user', content: 'h' }] }
  })
  t.is(r.status, 404)
  t.is(r.json.error.code, 'model_not_found')
  t.ok(
    r.json.error.message.indexOf('disponibles') !== -1,
    'the error is actionable: ' + r.json.error.message.slice(0, 70)
  )
})

// The chat's JS lives inside a template literal, so a stray backtick in a
// comment breaks the whole page without any unit test noticing. This catches
// it: if the page doesn't parse, it doesn't render.
test('the chat selector offers all three modes', async (t) => {
  const r = await pedir('GET', '/')
  t.is(r.status, 200)
  t.ok(r.body.indexOf('this machine only') !== -1, 'mode 1: this machine only')
  t.ok(r.body.indexOf('Auto - best available node') !== -1, 'mode 2: the best one available')
  t.ok(r.body.indexOf('Specific node') !== -1, 'mode 3: one specific machine')
  t.ok(r.body.indexOf('localonly') === -1, 'the checkbox got absorbed into mode 1')
  // One option per MACHINE, not per model: this is what used to make it
  // impossible to choose between two peers serving the same modelId.
  t.ok(r.body.indexOf('function fijables') !== -1, 'the list no longer deduplicates by modelId')
})

// ---------------------------------------------------------------------------
// PHASE 8.5 — the external assistant, end to end
//
// The "external provider" is a real server brought up right here alongside,
// that speaks the same SSE the NVIDIA API does. It's not a client mock: the
// code under test opens a socket, sends the JSON, parses the chunks and reads
// the `usage`. The only thing not exercised against the real provider is
// latency.
//
// Hitting integrate.api.nvidia.com from the test would mean paying dollars to
// run `npm test` and tying the suite to the network and to a credential.
// ---------------------------------------------------------------------------

let PUERTO_EXTERNO = 8898
let servidorExterno = null
let ultimoPedidoExterno = null

// B11: what matters is not the object the client builds but what ARRIVES on
// the other end. A duplicated `authorization` looks identical to a single one
// until you look at it from the server, where it shows up concatenated.
let ultimosHeadersExternos = null

// B2: a provider that does NOT send `usage` is not a rare case, it's the
// protocol default -- `usage` in streaming has to be requested. It gets
// switched off from the test to be able to exercise the failure mode and not
// just the happy path.
let mandaUsage = true

// B3: a provider that accepts the connection and then sends nothing. This is
// the case that used to leave the request hanging forever -- and with it, the
// budget reserve that authorized it.
let seCuelga = false

// Sends tokens and CUTS the socket without [DONE], but ONLY for the model
// named to it. A global flag would also cut the response of the candidate
// that has to save the request, which is exactly what the test wants to see.
let cortaModelo = null

// The provider answers 429 for the model named to it: this is what an
// exhausted daily quota on a free tier looks like from the outside. It's not
// measured in dollars, so the ledger never sees it coming -- all that's left
// is reacting to the rejection.
let cuotaAgotadaModelo = null

// B14 (second half): the provider answers WELL and doesn't send a single
// token of content. Closes clean, with [DONE]. It's not the same as hanging:
// there the clock trips and the 502 goes out through the error path, never
// passing through the empty-200 guard -- which is how this test's first
// attempt passed for the wrong reason.
let sinContenidoModelo = null

// B14: the provider cuts off at the cap and SAYS SO, which is how a request
// with a small `max_tokens` really ends. The finish_reason travels in the
// last chunk and until now was discarded.
let finishReasonFalso = null

// B15: opens with 200, sends a delta, and then an `error` object IN THE BODY.
// This is what a provider does when something breaks after it already sent
// the headers -- the status already went out and can't be corrected -- and
// it's the normal way OpenRouter fails when the provider behind it falls over
// halfway through.
let errorEnStreamModelo = null

// D24 — the provider returns ONE fixed text, and chooses HOW to chunk it.
//
// This is the attack vector D24 closes: the gateway counts one delta at a
// time, and it's the provider that decides how many deltas there are.
// `{ modelo, texto, porCaracter }` serves the same text in two different
// chunkings so we can compare what changes and what doesn't.
let respuestaModelo = null

// D27 case 1 — the provider sends a piece, waits, and sends the rest. The
// pause is the window in which the client cuts off: without it there's no way
// for the test to know that the second piece did NOT make it into the
// witnessed content.
let pausaModelo = null

// An OpenAI-compatible provider in twenty lines: two deltas, a `usage` with
// token counts that do NOT match what's counted on this side -- on purpose,
// to prove settlement uses the provider's numbers -- and the [DONE].
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
        // Header sent and then silence: the socket is still alive, so nobody
        // on the other end finds out on their own. This is what the clock has
        // to cut off.
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
        // D24 — the same text, chunked however the provider wants. It goes
        // out through its own path and ends there: what's being compared is
        // the chunking, and adding `usage` and the other flags below would
        // mix variables.
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

        // D27 cases 1 and 2 — one piece, a pause, and then either the rest or
        // death.
        //
        // The PAUSE is the piece that makes both cases deterministic, and
        // it's not decoration: `cortaModelo` destroys the socket in the same
        // tick it writes, so bare-fetch discards the entire response and
        // fails with NETWORK_ERROR before the gateway manages to read a
        // single delta -- meaning `started` stays false and a 500 with
        // nothing having reached the client, which is ANOTHER case. To test
        // "falls apart HALFWAY" we need to make sure the first half actually
        // arrived.
        if (pausaModelo && ultimoPedidoExterno.model === pausaModelo.modelo) {
          chunk({ choices: [{ delta: { content: pausaModelo.primero } }] })
          const t = setTimeout(() => {
            try {
              if (pausaModelo.corta) return res.destroy()
              chunk({ choices: [{ delta: { content: pausaModelo.segundo } }] })
              res.write('data: [DONE]\n\n')
              res.end()
            } catch (e) {
              /* the client already left: this is exactly the case being tested */
            }
          }, pausaModelo.ms)
          if (t.unref) t.unref()
          return
        }

        // `reasoning_content` in the SAME delta as the content: if the client
        // read it, the model's reasoning would leak out to the chat.
        chunk({
          choices: [{ delta: { reasoning_content: 'primero pienso...', content: 'hola ' } }]
        })
        chunk({ choices: [{ delta: { content: 'desde afuera' } }] })
        // B15: the error arrives AFTER the headers and after some token,
        // which is the only moment it can arrive through the body. The
        // stream closes clean -- [DONE] and all -- so nothing but the
        // `error` object tells this apart from a response that went well.
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
        // The closing chunk with the reason, the way a real provider sends it.
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

test('an external assistant gets configured as just another row in the registry', async (t) => {
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
  t.ok(ups[0].disponible(), 'the credential is read from the environment, not from the config')

  // The price goes against the ROW's id, which is what claveDePrecio() looks at.
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
  t.ok(fila, 'shows up in the marketplace without touching the panel')
  t.is(fila.modelId, MODELO_EXTERNO)

  const modelos = await pedir('GET', '/v1/models')
  t.ok(
    modelos.json.data.some((m) => m.id === MODELO_EXTERNO),
    'and in /v1/models, which is what a third-party client reads'
  )
})

test('without opt-in the prompt does NOT go out to a third party, and the error says how to turn it on', async (t) => {
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
    'the error is actionable: ' + r.json.error.message.slice(0, 60)
  )
})

test('opt-in gets turned on over HTTP and requires a credential', async (t) => {
  // B7: READING the external's status also requires a credential. It doesn't
  // carry secrets -- it sends the name of the environment variable, never its
  // value -- but it says who the provider is and whether there's an account
  // loaded on the other end.
  const leerSinKey = await pedir('GET', '/v1/upstream')
  t.is(leerSinKey.status, 401, 'not even looking at the status is public')

  const leerConKey = await pedir('GET', '/v1/upstream', { key: KEY })
  t.is(leerConKey.status, 200)
  t.ok(leerConKey.json.upstreams[0].apiKeyEnv, 'the NAME of the variable goes out...')
  t.absent(JSON.stringify(leerConKey.json).indexOf('clave-de-prueba') !== -1, '...and never its value')

  const sinKey = await pedir('POST', '/v1/upstream/opt-in', { body: { enabled: true } })
  t.is(sinKey.status, 401, 'authorizing spend cannot be left open to the port')

  const r = await pedir('POST', '/v1/upstream/opt-in', { key: KEY, body: { enabled: true } })
  t.is(r.status, 200)
  t.is(r.json.optIn, true)
  t.is(r.json.upstreams[0].credencial, true)
  t.absent(
    r.json.upstreams[0].apiKey,
    'the status NEVER returns the secret, only the variable name'
  )
  t.is(r.json.upstreams[0].apiKeyEnv, 'PYRUS_TEST_KEY')
})

test('with opt-in the external answers, and the response says it was the external one', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: MODELO_EXTERNO, messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200)
  t.is(r.json.choices[0].message.content, 'hola desde afuera', 'the provider deltas arrive')
  t.is(
    r.json.choices[0].message.content.indexOf('pienso'),
    -1,
    'and the reasoning_content does NOT arrive: it would give away the provider behind'
  )

  // D19: the disclosure goes in the headers, which is what the chat reads.
  t.is(r.headers['x-pyrus-kind'], 'upstream', 'the header says it came from the machine')
  t.is(
    decodeURIComponent(r.headers['x-pyrus-operator']),
    'Proveedor de prueba (externo)',
    'and says who'
  )

  // The output cap is imposed by the node even if the client doesn't send max_tokens.
  t.is(ultimoPedidoExterno.max_tokens, 256, 'without a ceiling the reserve would not cap anything')
  t.is(ultimoPedidoExterno.stream, true)
})

test('the trail registers the external one with what it actually cost', async (t) => {
  const r = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = r.json.log.find((e) => e.target === 'upstream')

  t.ok(entrada, 'routing to the external one stays in the same trail as the rest')
  t.is(entrada.ok, true)
  // 1000 input tokens at USD 1/1M + 500 output at USD 2/1M = 2000 micros.
  // The tokens are the provider's `usage`, NOT the deltas counted on this
  // side: settling with our own would underbill almost the entire request.
  t.is(entrada.costMicros, 2000, 'settled with the provider usage')
})

test('local:true never goes out to a third party, opt-in or not', async (t) => {
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: MODELO_EXTERNO, messages: [{ role: 'user', content: 'hola' }], local: true }
  })

  t.is(r.status, 503)
  t.is(r.json.error.code, 'local_only', 'the lock wins even with opt-in turned on')
})

test('with the budget exhausted it answers local, never the external one', async (t) => {
  const store = await import('../qvac/store.mjs')
  const budget = await import('../qvac/budget.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // An external provider that serves the SAME model as a local candidate: it's
  // the only way there's an alternative to degrade to.
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
  // On purpose: the local mock serves this EXACT SAME modelId. If the price
  // were indexed by model, the local candidate would inherit the external's
  // rate, its reserve would fail just the same, and instead of degrading it
  // would come out as a 402.
  costs.registrarPrecio('upstream:' + ups[0].id, ups[0].precio)
  gw.setUpstreams(ups)
  store.registerUpstream({
    id: ups[0].id,
    modelId: compartido,
    displayName: 'Expensive model',
    operator: 'Proveedor caro (externo)',
    maxConcurrentRequests: 4
  })

  // Saturate the local candidate: without this the external one doesn't even
  // compete (D19).
  const propios = store.listNodes().filter((n) => n.modelId === compartido && n.kind !== 'upstream')
  for (const n of propios) {
    for (let i = 0; i < n.maxConcurrentRequests; i++) store.beginRequest(n.id)
  }

  // The account settlement runs against is NOT the key's nodeId ('panel') but
  // the id of the key registry ENTRY, which is what
  // cuentaDe(req). Setting the cap on the wrong string used to create a
  // phantom account with a zero cap while the real one kept the default USD
  // 20 -- and the test passed for a path it wasn't meant to test.
  const apikeys = await import('../qvac/apikeys.mjs')
  const cuenta = apikeys.keyForNode('panel', 'web panel').id
  t.ok(cuenta, 'the account comes from the key registry, not from the nodeId')

  // Cap at zero: not even enough for one token.
  budget.setCap(cuenta, 0)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: compartido, messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'service is not denied: it degrades')
  t.not(r.headers['x-pyrus-kind'], 'upstream', 'and it was NOT the external one')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = log.json.log[0]
  t.ok(entrada.degradado, 'the degradation is audited, not confused with a normal choice')
  t.ok(
    entrada.reason.indexOf('presupuesto agotado') !== -1,
    'and the reason says why: ' + entrada.reason.slice(0, 60)
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
// B2 and B4 — the two holes through which the cap stopped being a cap
// ---------------------------------------------------------------------------

test('the request to the provider ALWAYS asks for usage, and the config cannot override the cap', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // A hostile config: it asks for ten thousand output tokens and turns off
  // streaming. Both fields are exactly what the node needs to control -- one
  // caps the reserve, the other is the format it knows how to parse.
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

  t.is(ultimoPedidoExterno.max_tokens, 256, 'the node cap wins, not the config one')
  t.is(ultimoPedidoExterno.stream, true, 'the config cannot turn off streaming')
  t.is(
    ultimoPedidoExterno.stream_options.include_usage,
    true,
    'the code itself requests usage: it is not a field that can be forgotten or turned off'
  )
  t.alike(
    ultimoPedidoExterno.chat_template_kwargs,
    { enable_thinking: false },
    'and the rest of the config still passes through: it extends, it does not overwrite'
  )

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// B11 — one provider's credential cannot travel to another one's endpoint
//
// The same criterion as the test above, on the headers instead of the body,
// with one extra twist: here the old defense wasn't absent, it was written
// with the wrong case. `Authorization` doesn't collide with `authorization`,
// so the one from the file and ours BOTH survived and went out concatenated.
//
// That's why the assert looks at what the SERVER received and not the object
// the client built: from this side both versions look fine.
// ---------------------------------------------------------------------------

test('the config cannot send one provider credential to another', async (t) => {
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
          // In LOWERCASE, the way anyone copying a line from a curl command
          // would write it. That detail was the entire bug.
          authorization: 'Bearer CREDENCIAL-DE-OTRO-PROVEEDOR',
          'content-type': 'text/plain',
          // And a legitimate one, to prove the defense doesn't eat everything:
          // OpenRouter's attribution headers still have to get through.
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
    'ONE credential arrives and it is ours: without the fix both used to arrive concatenated'
  )
  t.absent(
    String(ultimosHeadersExternos.authorization).includes('OTRO-PROVEEDOR'),
    'and the one from the file does not travel even stuck at the end'
  )
  t.is(
    ultimosHeadersExternos['content-type'],
    'application/json',
    'the body is JSON even if the file says otherwise'
  )
  t.is(
    ultimosHeadersExternos['http-referer'],
    'https://ejemplo.test',
    'and a legitimate provider header still passes through: it extends, it does not overwrite'
  )

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('a provider that does not send usage is settled by the reserve, not by the deltas', async (t) => {
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
  t.is(r.status, 200, 'the request is answered just the same: this is not a user error')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = log.json.log[0]
  t.is(entrada.target, 'upstream')

  // The reserve: 'hola' is 4 bytes -> ceil(4/2) = 2 input tokens at USD 1 per
  // million, plus the 256-token output cap at USD 2 per million.
  //   2 * 1 + 256 * 2 = 514 micro-dollars.
  //
  // Settling with what's counted on this side would have given 4 micros --
  // two SSE deltas at the output rate, with input free -- 128 times less.
  // That was the hole: not a rounding error, two orders of magnitude per
  // request.
  t.is(entrada.costMicros, 514, 'charged the upper bound that authorized the spend')

  mandaUsage = true
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// B3 — the spend cannot outlive the provider's silence
// ---------------------------------------------------------------------------

test('a provider that hangs does not leave the request hanging', async (t) => {
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
            // 300ms instead of 60s: it's the same clock, all that changes is
            // how long you have to wait to see it work.
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

  t.ok(tardo < 5000, 'it cuts off by the clock, not by the end of the universe: ' + tardo + 'ms')
  t.is(r.status, 502, 'and the request ENDS, with the provider error')

  const despues = budget.usage(cuenta)
  t.is(despues.reserved, antes.reserved, 'the reserve was released: no balance stayed committed')
  t.is(despues.spent, antes.spent, 'and nothing was charged: not a single token arrived')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = log.json.log[0]
  t.is(entrada.ok, false, 'the failure stays in the trail')
  t.is(entrada.costMicros, 0, 'charging the upper bound here would mean charging a request that never happened')

  const nodo = store.listNodes().find((n) => n.id === 'upstream:' + ups[0].id)
  t.is(nodo.activeRequests, 0, 'and the node slot did not stay taken either')

  seCuelga = false
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// B14 — `finish_reason` cannot say `stop` when the cap was the one that cut
//
// D9 declares it NON-NEGOTIABLE, and it's not a formality: `finish_reason` is
// the only field a client looks at to know whether text is missing, and the
// one an agent looks at to decide whether to ask for the continuation.
// Saying `stop` after cutting off at a cap that was also charged for is lying
// in the one place it matters.
//
// The node imposes its own `maxTokens` even if the client doesn't ask for one
// (upstream.mjs), so this happens TODAY, without waiting for Phase 9.
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
    displayName: 'Capped',
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

test('if the provider cut off at the cap, the client reads length and not stop', async (t) => {
  finishReasonFalso = 'length'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/cortado' }, async () => {
    // Without stream: the response is assembled whole and the field travels in the JSON.
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/cortado', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.status, 200)
    t.is(
      r.json.choices[0].finish_reason,
      'length',
      'the response was cut off at the cap and it says so (D9)'
    )

    // And with stream, in the closing chunk, which is where an SSE client reads it.
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
      'the closing chunk says so too, not only the non-stream path'
    )
  })

  finishReasonFalso = null
})

test('a response that ended on its own still says stop', async (t) => {
  finishReasonFalso = 'stop'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/entero' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/entero', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.json.choices[0].finish_reason, 'stop', 'no cutoff, normal termination')
  })

  // And if the provider says nothing, `stop` is reported: it is the default
  // for "nobody said", not a claim about every response.
  finishReasonFalso = null
  await conUpstreamDePrueba(t, { modelId: 'proveedor/mudo-fin' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/mudo-fin', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(r.json.choices[0].finish_reason, 'stop')
  })
})

test('an empty response is 502 also WITHOUT stream, not a 200 with content ""', async (t) => {
  // The other half of B14. The guard used to exist only on the stream side,
  // with the no-stream `return` ahead of it: whoever asked without
  // `stream: true` -- a curl, Open WebUI, the default of any OpenAI SDK --
  // got back a 200 with `content: ""` and `finish_reason: "stop"`. A client
  // had no way to tell it apart from a model that decided to say nothing.
  //
  // The provider answers WELL: 200, opening chunk, [DONE]. Zero content.
  // That's the case that reaches the guard; a hanging one would trip on the
  // clock instead.
  sinContenidoModelo = 'proveedor/vacio'

  await conUpstreamDePrueba(t, { modelId: 'proveedor/vacio' }, async () => {
    const r = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/vacio', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.not(r.status, 200, 'a response without a single token is not a success')
    // Defensive access on purpose: if this fails, the assert above already
    // said it broke, and a TypeError on `error.code` would abort the whole
    // run without reaching the tests that follow. It's the same lesson as
    // B18 -- a test that crashes instead of failing does not say what broke.
    t.is(
      (r.json && r.json.error && r.json.error.code) || null,
      'empty_response',
      'and it says so with its own code'
    )
    t.absent(r.json && r.json.choices, 'no empty choices with finish_reason stop travels back')
  })

  sinContenidoModelo = null
})

// ---------------------------------------------------------------------------
// B6 — the prompt estimate counts BYTES, and until now nobody tested it
//
// `estimarPromptTokens` divides UTF-8 bytes by 2. The previous version
// divided CHARACTERS by 3 and claimed to be an upper bound: that's true in
// English, and false in Chinese, Japanese, Korean, Arabic, or Hindi -- there
// the ratio gets close to 1 token per character and the reserve ended up well
// below the spend, exactly where the comment promised the opposite.
//
// The fix landed with Phase 6.5 and was left WITH NO TEST EXERCISING IT,
// which is why B6 stayed open for three audits. The only assert that came
// close used the prompt 'hola': 4 characters and 4 bytes, ceil(4/3) =
// ceil(4/2) = 2. The same number with the bug and without it.
//
// With 10 CJK characters that's 30 bytes: 15 tokens versus 4. That's the
// difference the test has to see.
// ---------------------------------------------------------------------------

test('a CJK prompt does not underestimate the reserve: bytes are counted, not characters', async (t) => {
  await conUpstreamDePrueba(t, { modelId: 'proveedor/cjk' }, async () => {
    // 10 characters, 30 UTF-8 bytes. Reserve = ceil(30/2) input tokens at USD
    // 1 per million + 256 output cap at USD 2 per million:
    //   15 * 1 + 256 * 2 = 527 micros.
    // Counting characters would give ceil(10/3) = 4 -> 516: almost four times
    // less input, and a short reserve is a cap that gets exceeded.
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
      'bytes/2 over CJK; counting characters would have estimated 516'
    )

    // The contrast that explains why this went unnoticed: with ASCII both
    // criteria give the SAME number, so the test that already existed passed
    // just the same with the bug in place.
    const ascii = await pedir('POST', '/v1/chat/completions', {
      key: KEY,
      body: { model: 'proveedor/cjk', messages: [{ role: 'user', content: 'hola' }] }
    })
    t.is(
      ascii.headers['x-pyrus-cost-estimate-micros'],
      '514',
      'in ASCII both criteria agree: that is why the bug survived'
    )
  })
})

test('a finish reason we do not know travels as-is, it does not flatten to stop', async (t) => {
  // Inventing a known ending for something the provider named differently is
  // the same lie, just smaller. `content_filter` is the real case that
  // matters: a client has to be able to tell "it finished" apart from "they
  // cut it off".
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
// B15 — a 200 does not mean it went well
//
// The HTTP status travels with the headers, meaning before the model
// generates a single token. Anything that breaks AFTER that can't be
// corrected: it travels as an `error` object inside the body, with the
// stream closing clean, [DONE] included. It's the normal way OpenRouter
// fails when the provider behind it falls over halfway through.
//
// The parser only looked at `usage` and `delta.content` and nothing else, so
// the error got discarded like any unknown event. That gave the worst
// possible failure: one that looks identical to working.
// ---------------------------------------------------------------------------

test('an error inside a 200 stream is not reported as a successful response', async (t) => {
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
    displayName: 'Broken halfway',
    operator: 'Proveedor roto a mitad (externo)',
    maxConcurrentRequests: 4
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'proveedor/roto-a-mitad', messages: [{ role: 'user', content: 'hola' }] }
  })

  // What used to happen: 200, `content: ""`, `finish_reason: "stop"`. A
  // client had no way to tell it apart from a model that decided to say
  // nothing.
  t.not(r.status, 200, 'a provider error cannot go out as a valid response')
  t.is(r.status, 502, 'and it is 502, because what failed was a third party machine')
  t.absent(r.json && r.json.choices, 'no empty choices with finish_reason stop travels back')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const entrada = log.json.log[0]
  t.is(entrada.ok, false, 'the failure stays in the trail and not as a successful request')

  errorEnStreamModelo = null
  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

test('an error inside the stream lets it move on to the next candidate', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  errorEnStreamModelo = 'r'

  // Two doors to the same model. The first breaks halfway through the
  // stream; the second answers fine.
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
    displayName: 'Broken',
    operator: 'Se rompe a mitad',
    local: true,
    maxConcurrentRequests: 8
  })
  store.registerUpstream({
    id: ups[1].id,
    modelId: 'con-respaldo-2',
    displayName: 'Healthy',
    operator: 'Contesta bien',
    local: true,
    maxConcurrentRequests: 1
  })
  // Same reason as in the failed-upstream test: with tied load, order is
  // decided by a `random()`. By taking the healthy one's only slot, the
  // broken one goes first deterministically.
  store.beginRequest('upstream:' + ups[1].id)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-respaldo-2', messages: [{ role: 'user', content: 'hola' }] }
  })

  // D4 allows the retry here: without `stream: true` the content is
  // assembled and doesn't go out until the end, so the client still hasn't
  // seen the piece from the one that broke.
  t.is(r.status, 200, 'the first one\'s error is not the request\'s error')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Contesta bien', 'the second one answered')
  t.is(
    r.json.choices[0].message.content,
    'hola desde afuera',
    'and without the piece the broken one managed to generate'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.is(e.intentos.length, 2, 'both attempts stay in the trail')
  t.is(e.intentos[0].ok, false, 'the first one failed even though the provider said 200')
  t.is(e.intentos[1].ok, true)

  errorEnStreamModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
})

test('a local engine behind HTTP answers without a credential and without opt-in', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Opt-in is turned off on purpose: if it applied here, this test would not
  // pass. It's the whole difference between "upstream" and "third party".
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
    displayName: 'Open weights',
    operator: 'Motor local (local)',
    local: true
  })

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'modelo-compartido', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'answers with opt-in off: it is not a third party')
  t.is(r.json.choices[0].message.content, 'hola desde afuera')
  t.is(r.headers['x-pyrus-scope'], 'local', 'and it declares it: the prompt did not leave the machine')
  t.is(r.headers['x-pyrus-kind'], 'upstream', 'even though it was requested over HTTP')

  // No Authorization: the local provider carries no credential and sending an
  // empty one would be worse than sending none.
  t.absent(ultimoPedidoExterno.max_tokens > 128, 'respects its own output cap')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(log.json.log[0].target, 'local', 'and the trail does not count it as external consumption: it was not')

  store.clearUpstreams()
  gw.setUpstreams([])
})

test('with both doors open, the home one answers, not the one that charges', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const costs = await import('../qvac/costs.mjs')
  const gw = await import('../qvac/gateway.mjs')

  const env = (await import('bare-env')).default
  env.PYRUS_TEST_KEY = 'clave-de-prueba'

  // The SAME model through two paths, which is what `as` enables: without
  // that they'd be two different models and would never cross.
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
  gw.setUpstreamOptIn(true) // turned on: even so, the paid one must not win

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
    'two candidates for one model: only now does routing have something to decide'
  )

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'dos-puertas', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200)
  t.is(r.headers['x-pyrus-scope'], 'local', 'the home one wins as long as it has room (D19)')
  t.is(
    ultimoPedidoExterno.model,
    'pesos-abiertos',
    'and it was asked with ITS name, not the advertised one'
  )

  // PHASE 8 — and now it wins BY PRICE, which is a different thing from
  // winning by chance. Both candidates are `kind: upstream`, so the tiebreak
  // by type -- the only thing that used to decide this -- leaves them tied:
  // if the reason says "cheaper", the new criterion is what called it.
  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.ok(
    log.json.log[0].reason.includes('mas barato'),
    'the log says WHY, and the why is the price: ' + log.json.log[0].reason
  )
  t.is(r.headers['x-pyrus-cost-estimate-micros'], '0', 'the home engine does not cost dollars')

  store.clearUpstreams()
  costs.olvidarPreciosExternos()
  gw.setUpstreams([])
  gw.setUpstreamOptIn(false)
})

// ---------------------------------------------------------------------------
// PHASE 8 — price decides between two that CHARGE
//
// The test above has one free and one paid, and so it doesn't fully separate
// two explanations: "the cheap one wins" and "the one that is not a third
// party wins". This one sets up two providers that charge, with the same
// load and different price. If the cheap one wins, the only thing that could
// have decided it is the price.
// ---------------------------------------------------------------------------

test('between two providers that charge, it routes to the cheaper one and says so', async (t) => {
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
  // `onchain-per-job`: liquidacion INMEDIATA por request. El default del
  // proyecto es `batch-receipts` (difiere al lote); eso lo cubre 'un nodo
  // batch-receipts NO liquida por request'. El schema decide, no un flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))

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
  // `onchain-per-job`: liquidacion INMEDIATA por request. El default del
  // proyecto es `batch-receipts` (difiere al lote); eso lo cubre 'un nodo
  // batch-receipts NO liquida por request'. El schema decide, no un flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))

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
  // `onchain-per-job`: liquidacion INMEDIATA por request. El default del
  // proyecto es `batch-receipts` (difiere al lote); eso lo cubre 'un nodo
  // batch-receipts NO liquida por request'. El schema decide, no un flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))
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
  // `onchain-per-job`: estos tests (D12, D24, D25, D27) ejercitan la liquidacion
  // INMEDIATA por request. El default del proyecto es `batch-receipts`, que
  // difiere al lote — eso tiene su propio test ('un nodo batch-receipts NO
  // liquida por request'). El schema decide el modo, no un flag.
  gw.setEconomic(wallet.economicDe(p.address, 'onchain-per-job'))
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
  // `onchain-per-job`: liquidacion INMEDIATA por request. El default del
  // proyecto es `batch-receipts` (difiere al lote); eso lo cubre 'un nodo
  // batch-receipts NO liquida por request'. El schema decide, no un flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))
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
// La wallet del par es REAL: se deriva de una cuenta WDK de prueba (index 2, ni
// el pagador ni el proveedor local). Asi el par puede FIRMAR su atestacion
// parcial y el gateway la puede VERIFICAR contra la wallet del manifiesto —
// que es lo que registrarRuteado exige para colgarla (D27 caso 1).
let _parFirmante = null
async function parFirmante() {
  if (_parFirmante) return _parFirmante
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cuenta = await new WM('test test test test test test test test test test test junk', {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount(2)
  _parFirmante = { address: await cuenta.getAddress(), firmar: (m) => cuenta.sign(m) }
  return _parFirmante
}

// Se llena la primera vez que `conParRegistrado` corre; los tests lo comparan
// contra el `payTo` del 402.
let WALLET_DEL_PAR = '0x' + '5c'.repeat(20)

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

// La atestacion D24 PARCIAL que el par firma sobre el prefijo que alcanzo a
// servir antes de que el cliente cortara. Es lo que su `chat:done` tardio lleva
// de vuelta para que el gateway lo cuelgue del rastro del ruteado.
async function atestacionParcialDelPar({ requestId, contenido, deltas }) {
  const at = await import('../qvac/atestacion.mjs')
  const p = await parFirmante()
  const sinFirmar = at.construir({
    requestId,
    modelId: MODELO_PAR,
    quantization: at.cuantizacionDe(MODELO_PAR),
    runtime: 'llamacpp',
    promptHash: at.hashDe('hola'),
    outputHash: at.hashDe(contenido),
    tokensPrefill: 0,
    tokensDecode: deltas,
    finishReason: 'client_cancelled',
    providerPubkey: p.address
  })
  return at.firmar(sinFirmar, p.firmar)
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
      // FASE 10 / D27 caso 1 — y despues el par manda su `chat:done` tardio: el
      // swarm real mantiene el chat vivo esperandolo (con la atestacion parcial
      // firmada por el par, o el motivo si falta). `e.doneTardio` deja que un
      // test lo defina; por defecto es una ausencia con motivo.
      const t = setTimeout(
        () =>
          e.cbs.onDone(
            e.doneTardio || {
              attestation: null,
              attestationMissing: 'el par corto sin devolver una atestacion (swarm de prueba)'
            }
          ),
        0
      )
      if (t.unref) t.unref()
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
  WALLET_DEL_PAR = (await parFirmante()).address
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

test('D27 caso 1: el chat:done tardio del par trae la atestacion parcial y se cuelga del rastro', async (t) => {
  const VISTO = 'esto lo recibio el cliente'
  const TARDIO = ' y esto llego despues del cancel'

  // Lo que el par firma sobre lo que ALCANZO a servir: VISTO, un delta. El chunk
  // tardio no entra —el cliente no lo recibio—, igual que el outputHash de una
  // parcial servida por este mismo nodo.
  const attParcial = await atestacionParcialDelPar({
    requestId: 'chatcmpl-parcial',
    contenido: VISTO,
    deltas: 1
  })

  await conParRegistrado((cbs, estado) => {
    cbs.onAccepted()
    cbs.onChunk(VISTO)
    // Cuelga el chunk tardio: sale cuando el gateway mande el chat:cancel.
    estado.tardio = TARDIO
    // FASE 10 / D27 caso 1 — y su `chat:done` tardio, con la atestacion firmada.
    // Antes se descartaba porque `cancelChat` borraba el chat en el acto; ahora
    // lo mantiene vivo una ventana corta justo para recibir esto.
    estado.doneTardio = { attestation: attParcial }
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
  t.is(rec.status, 200, 'queda rastro del ruteo (D27 caso 1)')
  // FASE 10 — el handoff: el gateway NO liquida un ruteado, lo cobra el par
  // desde su lote. Por eso no hay `success`/`transaction` de este lado.
  t.is(rec.json.settledBy, 'peer-batch', 'el settlement es del par, diferido')
  t.absent(rec.json.success, 'este gateway no muestra una liquidacion que no hizo')

  // Y AHORA la mitad que faltaba: el `chat:done` tardio del par llego, su
  // atestacion parcial verifico contra la wallet del manifiesto del par, y quedo
  // colgada del rastro del ruteado en vez de un `attestationMissing`.
  t.ok(rec.json.attestation, 'la atestacion parcial del par SI llego al rastro')
  t.is(
    (rec.json.attestation || {}).finishReason,
    'client_cancelled',
    'y dice que corto el cliente (D27)'
  )
  t.is(
    String((rec.json.attestation || {}).providerPubkey || '').toLowerCase(),
    WALLET_DEL_PAR.toLowerCase(),
    'firmada por la wallet DEL PAR, no la de este gateway'
  )
  t.absent(rec.json.attestationMissing, 'ya no hay motivo de ausencia: la atestacion esta')

  // Y el rastro no cuenta el chunk tardio: lo que se registra es lo que el
  // cliente recibio, no lo que el proveedor siguio mandando despues de que se fue.
  const e = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0] || {}
  t.is(e.finishReason, 'client_cancelled', 'el rastro dice quien corto')
  t.is(e.tokens, 1, 'y conto UN chunk, no dos: el tardio se descarto')

  await soltarPar()
})

// ---------------------------------------------------------------------------
// FASE 10 — recibos y lote
//
// La Fase 9 verifica, sirve, y liquida DESPUES (D12). La Fase 10 hace lo mismo
// con el settlement DIFERIDO: los pagos verificados se acumulan y se liquidan de
// a muchos. Estos tests prueban que el gateway acumula lo que sirvio EL, que un
// recibo de un par no entra a NUESTRO lote (D10), que el lote se arma y se
// firma con la wallet, y que el protocolo con el facilitator es el declarado.
//
// La liquidacion inmediata de la Fase 9 no se toca: el lote guarda como salio y
// `liquidarLote` reintenta las que fallaron. Reabre la Fase 9 por la entrada
// `plasma-testnet` que se le agrego a x402.mjs.
// ---------------------------------------------------------------------------

test('FASE 10 / D10: el lote acumula recibos al payTo del NODO, y los de un par NO', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const x402 = await import('../qvac/x402.mjs')
  // El facilitator falso ya esta arriba desde el primer test de settlement y se
  // cierra al final; conProveedorQueFirma apunta VAR_FACILITATOR ahi.
  lote.limpiar()

  const p = await conProveedorQueFirma()

  // Dos requests locales pagados: los sirve este nodo, el payTo es su wallet.
  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const a = await pagarYPedir(cuerpo)
  const b = await pagarYPedir(cuerpo)
  t.is(a.r.status, 200)
  t.is(b.r.status, 200)

  const mios = lote.pendientes()
  t.is(mios.length, 2, 'los dos pagos verificados entraron al lote')
  t.ok(
    mios.every((r) => r.payTo.toLowerCase() === p.address.toLowerCase()),
    'y todos pagan a la wallet de ESTE nodo (D10)'
  )
  t.ok(
    mios.every((r) => r.nonce && r.authorization && r.signature),
    'con la autorizacion EIP-3009 entera'
  )
  t.ok(
    mios.every((r) => r.liquidacion && r.liquidacion.success),
    'y con como salio la liquidacion inmediata'
  )
  t.ok(
    mios.every((r) => r.attestation && r.attestation.signature),
    'y la atestacion de D24 colgada'
  )

  // Ahora un request servido por un PAR: el payTo apunto a SU wallet.
  await soltarProveedor()
  await conParRegistrado((cbs) => {
    cbs.onAccepted()
    cbs.onChunk('respuesta del par')
    cbs.onDone()
  })
  const cuerpoPar = {
    model: MODELO_PAR,
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const desafio = await pedir('POST', '/v1/chat/completions', { body: cuerpoPar })
  t.is(desafio.json.accepts[0].payTo, WALLET_DEL_PAR, 'el 402 paga al par (D10)')
  const pago = await firmarPago(desafio.json)
  await pedir('POST', '/v1/chat/completions', { body: cuerpoPar, headers: { 'X-PAYMENT': pago } })
  await esperar(400)

  t.absent(
    lote.pendientes().some((r) => r.payTo.toLowerCase() === WALLET_DEL_PAR.toLowerCase()),
    'el recibo del par NO entra a nuestro lote: es de el, viaja por Protomux firmado por el'
  )

  await soltarPar()
  lote.limpiar()
})

test('FASE 10: el protocolo nodo<->facilitator es el que x402 declara', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  ultimoSettle = null
  const p = await conProveedorQueFirma()

  await pagarYPedir({ model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] })

  t.ok(ultimoSettle, 'el facilitator recibio la liquidacion')
  const dec = x402.PROTOCOLO_FACILITATOR
  for (const campo of dec.envia) t.ok(campo in ultimoSettle, `manda ${campo}`)
  const pp = ultimoSettle.paymentPayload
  for (const campo of dec.paymentPayload) t.ok(campo in pp, `el paymentPayload trae ${campo}`)
  for (const campo of dec.paymentPayloadPayload) {
    t.ok(campo in pp.payload, `y adentro, ${campo}`)
  }
  t.is(pp.scheme, 'exact')
  t.is(
    pp.network,
    ultimoSettle.paymentRequirements.network,
    'la red del pago y la del requisito coinciden'
  )
  t.is(
    ultimoSettle.paymentRequirements.payTo.toLowerCase(),
    p.address.toLowerCase(),
    'y el requisito liquida contra la wallet del nodo, no una recalculada'
  )

  await soltarProveedor()
})

test('FASE 10: el lote se arma, se firma con la wallet, y se puede liquidar diferido', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const x402 = await import('../qvac/x402.mjs')
  lote.limpiar()
  const p = await conProveedorQueFirma()

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  await pagarYPedir(cuerpo)
  await pagarYPedir(cuerpo)

  // `armar` tira si el acumulador esta vacio -- lo que pasa si el gateway dejo
  // de acumular. Se atrapa para que eso salga como un assert y no como un
  // Uncaught que se lleva puesta la corrida (misma leccion que B18).
  let l = null
  try {
    l = lote.armar({})
  } catch (err) {
    /* l queda null y el assert de abajo habla */
  }
  t.ok(l, 'hay recibos acumulados y el lote se arma')
  if (!l) {
    await soltarProveedor()
    return
  }
  t.is(l.count, 2, 'el lote junta los dos recibos acumulados')
  t.is(l.network, 'eip155:988', 'de una sola red')
  t.is(l.payTo.toLowerCase(), p.address.toLowerCase(), 'a una sola wallet')
  t.is(
    l.totalAmount,
    (BigInt(l.recibos[0].amount) + BigInt(l.recibos[1].amount)).toString(),
    'con el total sumado'
  )

  const firmado = await lote.firmarLote(l, p.firmar)
  t.ok(firmado && firmado.signature.startsWith('0x'), 'lo firma la wallet del nodo')

  const v = await lote.verificarLote(firmado)
  t.ok(v.ok, 'y verifica entero: ' + (v.reason || ''))
  t.is(v.firmante.toLowerCase(), p.address.toLowerCase(), 'el firmante es la wallet del nodo')
  t.is(v.recibosMal.length, 0, 'y las autorizaciones EIP-3009 de adentro recuperan a quien pago')

  // Liquidacion diferida: recorre el lote llamando al MISMO x402.liquidar contra
  // el facilitator falso. Es el flujo de la Fase 9 con el settlement diferido.
  const res = await lote.liquidarLote({ lote: firmado, liquidar: x402.liquidar })
  t.is(res.liquidados.length, 2, 'los dos se liquidan en el lote')
  t.is(res.fallidos.length, 0)
  lote.marcarLiquidados(res.liquidados)
  t.is(
    lote.pendientes({ soloPendientes: true }).length,
    0,
    'y quedan marcados: un corte y reanudar no recobra'
  )

  await soltarProveedor()
  lote.limpiar()
})

test('FASE 10: un nodo batch-receipts NO liquida por request, difiere al lote', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default
  lote.limpiar()
  ultimoSettle = null

  // El nodo con su settlement por DEFECTO — batch-receipts, lo que declara el
  // manifiesto firmado del proyecto. El schema decide: no hay flag.
  const p = await proveedorFirmante()
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  gw.setEconomic(wallet.economicDe(p.address)) // <- settlement: 'batch-receipts'
  gw.setWalletSigner(p.firmar)

  const cuerpo = {
    model: 'facturas-ar',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  }
  const { r } = await pagarYPedir(cuerpo)
  t.is(r.status, 200, 'se sirve igual: el pago se verifico, solo el settlement se difiere')
  t.absent(
    r.headers['x-payment-response'],
    'y no hay X-PAYMENT-RESPONSE: no se liquido por request'
  )
  t.absent(ultimoSettle, 'el facilitator NO recibio ninguna liquidacion por request')

  const evento = r.body
    .split('\n\n')
    .map((l) => l.replace(/^data: /, ''))
    .filter((l) => l.indexOf('settledBy') !== -1)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)[0]
  t.ok(evento, 'el evento SSE final describe el settlement')
  t.is(evento && evento.settledBy, 'batch', 'que es diferido: settledBy = batch')
  t.is(evento && evento.paymentResponse, null, 'sin recibo de liquidacion todavia')
  t.ok(
    evento && evento.x402Note && evento.x402Note.indexOf('batch-receipts') !== -1,
    'y lo explica: ' + (evento && evento.x402Note)
  )
  // La atestacion D24 SI viaja: es independiente del modo de settlement.
  t.ok(evento && evento.attestation && evento.attestation.signature, 'la atestacion D24 igual sale')

  // El recibo quedo en el lote SIN liquidar: es el flush lo que lo cobra.
  const pend = lote.pendientes({ soloPendientes: true })
  t.is(pend.length, 1, 'el pago verificado quedo pendiente en el lote')
  t.is((pend[0] || {}).liquidacion, null, 'sin liquidacion inmediata: eso es el flush')

  // Y el flush lo liquida — el mismo x402.liquidar, ahora en lote.
  const res = await lote.flushTodo({ firmar: p.firmar, liquidar: x402.liquidar })
  t.is((res[0] || {}).liquidados, 1, 'el flush liquida el recibo diferido')
  t.ok(ultimoSettle, 'y RECIEN ahi el facilitator recibe la liquidacion')
  t.is(lote.pendientes({ soloPendientes: true }).length, 0, 'no queda nada pendiente')

  gw.setEconomic(null)
  gw.setWalletSigner(null)
  delete env[x402.VAR_FACILITATOR]
  lote.limpiar()
})

test('FASE 10 / precondicion: x402 arma un accepts[] para plasma-testnet (9746)', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  t.is(x402.CAIP2['plasma-testnet'], 'eip155:9746', 'la red esta en la tabla')

  // Sin ASSET/NAME declarados no se ofrece: un cliente no firma un EIP-712 a medias.
  delete env[x402.VAR_PLASMA_TESTNET_ASSET]
  delete env[x402.VAR_PLASMA_TESTNET_NAME]
  t.is(await x402.activoDe('plasma-testnet'), null, 'sin declarar, la red queda afuera')

  env[x402.VAR_PLASMA_TESTNET_ASSET] = '0x' + 'a1'.repeat(20)
  env[x402.VAR_PLASMA_TESTNET_NAME] = 'PyrusLLM Test USD'
  const activo = (await x402.activoDe('plasma-testnet')) || {}
  t.is(activo.network, 'eip155:9746', 'con ASSET y NAME declarados, la red se ofrece')
  t.is(activo.asset, '0x' + 'a1'.repeat(20))
  t.is(
    activo.name,
    'PyrusLLM Test USD',
    'con el dominio EIP-712 que el cliente necesita para firmar'
  )
  t.ok(
    (await x402.redesDisponibles()).includes('plasma-testnet'),
    'y entra a las redes disponibles'
  )

  delete env[x402.VAR_PLASMA_TESTNET_ASSET]
  delete env[x402.VAR_PLASMA_TESTNET_NAME]
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
  // `onchain-per-job`: liquidacion INMEDIATA por request. El default del
  // proyecto es `batch-receipts` (difiere al lote); eso lo cubre 'un nodo
  // batch-receipts NO liquida por request'. El schema decide, no un flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))
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

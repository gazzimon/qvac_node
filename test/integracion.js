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
    r.json.error.message.indexOf('available') !== -1,
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
// The candidate walk crosses classes
//
// There used to be two paths: one with retry (peers only) and one with none
// (local engine, upstream, mocks). The retry stopped at the boundary: if
// every peer failed, this machine's own model never got tried even if it
// was in the same candidate list.
// ---------------------------------------------------------------------------

test('an unreachable peer no longer blocks the local candidate', async (t) => {
  const store = await import('../qvac/store.mjs')

  // A peer announcing the SAME model as a registry mock. This suite's
  // gateway runs without a swarm (`serve --demo`, no --swarm), so the peer
  // can't be attempted: it's the "you launched the chat but not the agent" case.
  store.upsertFromManifest('ff'.repeat(32), {
    metadata: { operator: 'Par fantasma', tags: ['facturas'] },
    models: [
      { modelId: 'facturas-ar', displayName: 'Facturas AR', qos: { maxConcurrentRequests: 4 } }
    ]
  })

  const candidatos = store.findAllByModelId('facturas-ar')
  t.ok(candidatos.length >= 2, 'there is a peer and a mock serving the same model')
  t.is(candidatos[0].kind, 'peer', 'and the peer goes first, which is what used to block the path')

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'this used to be a 503 agent_offline without looking at the rest of the list')
  t.not(
    decodeURIComponent(r.headers['x-pyrus-operator']),
    'Par fantasma',
    'and the other one answered, not the one that couldn\'t be tried'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.ok(e.intentos && e.intentos.length > 1, 'the trail stores both attempts')
  t.is(e.intentos[0].code, 'agent_offline', 'and why the first one failed')

  store.removeByPeer('ff'.repeat(32), { hard: true })
})

test('with no peer reachable AND no local candidate, the 503 still says what to do', async (t) => {
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
    'a 503 that only refuses leaves whoever reads it with no next step'
  )

  store.removeByPeer('ee'.repeat(32), { hard: true })
})

test('a downed upstream gets skipped and the next candidate answers', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // Two doors to the same model: the first points at a port where nobody is
  // listening -- the real "you didn't bring up llama-server" case -- and the
  // second at the test provider, which does answer.
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

  // The downed one has to go FIRST or the test doesn't exercise anything: if
  // the live one answers right away, the three asserts below still pass
  // without the retry ever having happened.
  //
  // This used to be attempted with "the downed one with MORE free capacity"
  // (8 against 1) and it did NOT order anything: `cargaDe` is a RATIO --
  // activeRequests over maxConcurrent (store.mjs:150) --, so 0/8 and 0/1 are
  // both ZERO. With load tied, errorRate and lastMs tie too -- both rows are
  // new and have no history -- and the order ended up decided by routing.mjs:
  // 102's `jitter: random()`. A coin flip, in other words: the test failed
  // ~1 in every 2 runs, and the failure mode was a TypeError over
  // `e.intentos` instead of a failed assert, which is worse because it
  // doesn't say what broke.
  //
  // What DOES order it is leaving the live one with no room: 1/1 sends it
  // to the back by the sort's rule 1 (saturated ones go last), which gets
  // evaluated before any randomness. It's still eligible -- the loop tries
  // saturated ones too -, which is exactly what's wanted: the downed one
  // first, the live one after.
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
  // The ROW's id carries a prefix: `registerUpstream` adds it, and that's
  // the id the gateway counts slots under.
  store.beginRequest('upstream:' + ups[1].id)

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-respaldo', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'the first one\'s failure is not the request\'s failure')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Motor vivo', 'the second one answered')
  t.is(r.json.choices[0].message.content, 'hola desde afuera')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  const e = log.json.log[0]
  t.is(e.intentos.length, 2, 'and both attempts stay on the trail')
  t.is(e.intentos[0].ok, false)
  t.is(e.intentos[1].ok, true)

  store.clearUpstreams()
  gw.setUpstreams([])
})

test('D4 looks at what the CLIENT saw, not at what the provider generated', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // The first provider sends tokens and cuts the socket without closing the stream.
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

  // The order has to be deterministic: with both at load 0, pickCandidate's
  // tiebreaker is random. The healthy one's only slot gets occupied so it
  // ends up second -- saturated does not mean discarded, it means last.
  store.beginRequest('upstream:' + ups[1].id)

  // WITHOUT streaming: the content gets assembled and doesn't go out until
  // the end, so the client did not receive a single byte and the retry is legitimate.
  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'se-corta', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'it gets retried: the client had seen nothing')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Sano', 'the second one answered')
  t.is(
    r.json.choices[0].message.content,
    'hola desde afuera',
    'and the response does NOT carry the piece from the one that dropped'
  )

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(log.json.log[0].intentos.length, 2, 'both attempts stay on the trail')

  cortaModelo = null
  store.endRequest('upstream:' + ups[1].id)
  store.clearUpstreams()
  gw.setUpstreams([])
})

test('a 429 from the provider is treated as saturation, not as a request error', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // The first one's daily quota, exhausted. It's the limit budget.mjs CANNOT
  // see, because it isn't measured in dollars: it's counted in requests per day.
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
  store.beginRequest('upstream:' + ups[1].id) // the other one, second and deterministic

  const r = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'con-cuota', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 200, 'the request gets saved by the other candidate')
  t.is(decodeURIComponent(r.headers['x-pyrus-operator']), 'Con cuota')

  const log = await pedir('GET', '/v1/routing-log', { key: KEY })
  t.is(
    log.json.log[0].intentos[0].code,
    'at_capacity',
    'the 429 reads as "full", not as "broken"'
  )

  // And it stays marked full: the next request does not spend the attempt
  // again against a provider that already said no. S5 of NOTES-SATURACION.md.
  const fila = store.getNode('upstream:' + ups[0].id)
  t.is(
    fila.activeRequests,
    fila.maxConcurrentRequests,
    'marked saturated until something else is known'
  )

  cuotaAgotadaModelo = null
  store.endRequest('upstream:' + ups[1].id)
  store.clearUpstreams()
  gw.setUpstreams([])
})

// ---------------------------------------------------------------------------
// PHASE 9 — the 402 at the edge (D8, D9, D10, D16)
//
// D16 decides three paths that don't overlap: `local: true` free, a panel
// API key, and -- for the unknown caller -- 402. The third one is the
// phase: it's what lets an agent consume without registering anywhere.
//
// The 402 gets built AFTER choosing a candidate, because it has to say how
// much and to whom, and both depend on who's going to answer.
// ---------------------------------------------------------------------------

test('without a credential and with a wallet, the node asks for payment instead of denying access', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')

  // Before having a wallet, a request without a key is 401: there's nobody
  // to pay, so the only path left is the credential.
  gw.setEconomic(null)
  const sinWallet = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinWallet.status, 401, 'without a wallet nothing can be charged: it stays 401')

  // With a wallet, the same request is a 402.
  const direccion = '0x' + 'ab'.repeat(20)
  gw.setEconomic(wallet.economicDe(direccion))

  const r = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })

  t.is(r.status, 402, 'it isn\'t missing a credential: it\'s missing payment, and those are different things')
  t.is(r.json.x402Version, 2)
  t.ok(Array.isArray(r.json.accepts) && r.json.accepts.length > 0, 'it carries at least one option')

  const a = r.json.accepts[0]
  // The four pieces of data the DoD requires the 402 to state.
  t.is(a.payTo, direccion, 'TO WHOM: the wallet of whoever is going to answer (D10)')
  t.is(a.network, 'eip155:988', 'ON WHICH CHAIN: Stable, the only one usable without verifying Plasma')
  // `amount` and not `maxAmountRequired`: the second is x402 v1's name and
  // the one that shows up in half the documentation, but the v2 client
  // reads `amount`. With the old name the client signs BigInt(undefined)
  // and doesn't even get to send anything.
  t.is(a.amount, '1000', 'HOW MUCH: the USD 0.001 minimum in USDT0 units')
  t.absent(a.maxAmountRequired, 'and the v1 name, which nobody reads, does not get sent')
  t.ok(a.outputTokenLimit > 0, 'UP TO HOW MANY TOKENS: ' + a.outputTokenLimit + ' (D9)')

  t.is(a.scheme, 'exact', 'D9(a): exact scheme')
  t.ok(a.resource.includes('/v1/chat/completions'), 'and over which resource')
  t.ok(a.extra && a.extra.name, 'with the EIP-712 domain the client needs to sign')

  // The key still works: the 402 COEXISTS, it does not replace it (D16).
  const conKey = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(conKey.status, 200, 'whoever already has a key notices none of this')

  gw.setEconomic(null)
})

test('the 402 does not promise a network whose contract nobody verified', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  gw.setEconomic(wallet.economicDe('0x' + 'cd'.repeat(20)))

  // D15 set Plasma as the default, but x402 doesn't ship it and we declare
  // its contract address ourselves, unverified. Without the operator's
  // explicit confirmation it does NOT get offered: the client would be
  // signing an authorization against a contract nobody looked at.
  delete env[x402.VAR_PLASMA_OK]
  const sinPlasma = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.alike(
    sinPlasma.json.accepts.map((a) => a.network),
    ['eip155:988'],
    'only Stable, which is the one x402 knows out of the box'
  )

  env[x402.VAR_PLASMA_OK] = '1'
  const conPlasma = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.alike(
    conPlasma.json.accepts.map((a) => a.network),
    ['eip155:9745', 'eip155:988'],
    'with confirmation it gets in, and goes first as D15 says'
  )

  delete env[x402.VAR_PLASMA_OK]
  gw.setEconomic(null)
})

// ---------------------------------------------------------------------------
// PHASE 9 — actually paying: signing the X-PAYMENT and receiving tokens
//
// The client is x402's own (`ExactEvmScheme`) signing with a real WDK
// wallet. The only thing NOT exercised is the chain: D12 decides that
// verification is synchronous and does NOT touch it -- it checks that the
// authorization is properly signed and says what it has to say. Whether
// there's balance is known when settling.
//
// That's exactly the property that makes this test worth something without
// funding anything: the half that protects the provider from spending free
// GPU is offline.
// ---------------------------------------------------------------------------

// A payer: a well-known public test WDK wallet, never funded.
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

// Signs a 402's `accepts[0]` and returns the X-PAYMENT header.
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

test('with a signed X-PAYMENT, the unknown caller receives tokens', async (t) => {
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

  t.is(r.status, 200, 'payment verified -> it gets served, no API key involved')
  t.ok(r.json.choices[0].message.content.length > 0, 'and it answers something')

  gw.setEconomic(null)
})

test('a tampered X-PAYMENT does not buy anything', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20)))

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json

  // 1. Signed for less than what was requested.
  const barato = await firmarPago(desafio, { pisar: { amount: '1' } })
  const r1 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': barato }
  })
  t.is(r1.status, 402, 'underpaying is not enough')
  t.ok(String(r1.json.error).includes('se pidieron'), r1.json.error)

  // 2. Signed to ANOTHER address. This is the attack that matters: whoever
  //    forwards another node's 402 with their own wallet inside would be
  //    billing themselves for someone else's work -- on the payer's side,
  //    sending the money elsewhere.
  const aOtro = await firmarPago(desafio, { pisar: { payTo: '0x' + 'cd'.repeat(20) } })
  const r2 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': aOtro }
  })
  t.is(r2.status, 402, 'an authorization to another address does not pay this one')
  t.ok(String(r2.json.error).includes('otra direccion'), r2.json.error)

  // 3. The signature changed: the authorization's amount gets edited AFTER
  //    signing. It's the one thing that can't be forged, and it's D12's core.
  const bueno = await firmarPago(desafio)
  const sobre = JSON.parse(Buffer.from(bueno, 'base64').toString('utf8'))
  sobre.payload.authorization.value = '999999999'
  const editado = Buffer.from(JSON.stringify(sobre), 'utf8').toString('base64')
  const r3 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': editado }
  })
  t.is(r3.status, 402, 'editing the authorization after signing invalidates it')
  t.ok(String(r3.json.error).includes('firma no corresponde'), r3.json.error)

  // 4. Garbage.
  const r4 = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': 'no-es-base64-de-nada' }
  })
  t.is(r4.status, 402)

  gw.setEconomic(null)
})

// ---------------------------------------------------------------------------
// PHASE 9 — settlement (D12, D14)
//
// The facilitator is fake, same as the external provider: a local
// bare-http1 that speaks x402's protocol. The real one --
// x402.semanticpay.io -- moves money against a funded wallet, so it can't
// be in `npm test`.
//
// What DOES get genuinely exercised: that it settles AFTER serving, that
// the receipt arrives through the path that matches each response shape,
// and that a failed settlement does not take down a response that already
// went out fine.
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

// Decodes X-PAYMENT-RESPONSE without blowing up if it's absent.
//
// A `Buffer.from(undefined, 'base64')` followed by JSON.parse throws a
// SyntaxError that ABORTS the run, and then the test doesn't say what broke
// -- it's the same B18 lesson. Return null and let the assert speak.
function reciboDe(r) {
  const h = r && r.headers && r.headers['x-payment-response']
  if (!h) return null
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
  } catch (e) {
    return null
  }
}

test('payment settles AFTER serving, and the receipt arrives', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  await levantarFacilitatorFalso()
  ultimoSettle = null
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: IMMEDIATE per-request settlement. The project's
  // default is `batch-receipts` (defers to the batch); that's covered by
  // 'a batch-receipts node does NOT settle per request'. The schema
  // decides, not a flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json
  const pago = await firmarPago(desafio)

  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })
  t.is(r.status, 200)

  // D12 — without streaming the response is fully assembled before writing
  // a single byte, so the receipt goes in the header as the spec mandates,
  // with NO deviation.
  const recibo = reciboDe(r)
  t.ok(recibo, 'X-PAYMENT-RESPONSE on the non-streaming path')
  t.is(recibo && recibo.success, true)
  t.ok(
    recibo && String(recibo.transaction).startsWith('0x'),
    'with the tx hash: ' + (recibo && recibo.transaction)
  )

  // It settled against THE SAME requirement that was offered, not a
  // recalculated one: settling against different numbers would mean
  // charging for something other than what the client accepted.
  t.ok(ultimoSettle, 'the facilitator received the settlement')
  const reqs = (ultimoSettle && ultimoSettle.paymentRequirements) || {}
  t.is(reqs.amount, desafio.accepts[0].amount)
  t.is(reqs.payTo, desafio.accepts[0].payTo)

  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

test('with streaming the receipt goes as an SSE event, and it says why it isn\'t in the header', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: IMMEDIATE per-request settlement. The project's
  // default is `batch-receipts` (defers to the batch); that's covered by
  // 'a batch-receipts node does NOT settle per request'. The schema
  // decides, not a flag.
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

  // With SSE the headers go out BEFORE the first token, so the receipt can't go there.
  t.absent(r.headers['x-payment-response'], 'it is not in the header, and it can\'t be')

  const evento = r.body
    .split('\n\n')
    .map((l) => l.replace(/^data: /, ''))
    .filter((l) => l.indexOf('paymentResponse') !== -1)
    .map((l) => JSON.parse(l))[0]

  t.ok(evento, 'the receipt travels as the final SSE event')
  t.is(evento && evento.paymentResponse && evento.paymentResponse.success, true)
  // D12's condition: the deviation has to be discoverable from the response
  // itself. A client that looks for the header and doesn't find it has to
  // find out WHY, not just keep waiting.
  t.ok(
    evento && evento.x402Note && evento.x402Note.indexOf('TTFT') !== -1,
    'and it explains the deviation'
  )
  t.ok(evento && evento.receiptUrl, 'with a place to retrieve it from')

  // And that place exists, for a client that cuts off before the last event.
  const rec = evento && evento.receiptUrl ? await pedir('GET', evento.receiptUrl) : { status: 0 }
  t.is(rec.status, 200, 'the receipt can be retrieved afterward')
  t.is(rec.json && rec.json.transaction, evento && evento.paymentResponse.transaction)

  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

test('if settlement fails, the response that already went out does not fall over', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: IMMEDIATE per-request settlement. The project's
  // default is `batch-receipts` (defers to the batch); that's covered by
  // 'a batch-receipts node does NOT settle per request'. The schema
  // decides, not a flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))
  facilitatorFalla = true

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const desafio = (await pedir('POST', '/v1/chat/completions', { body: cuerpo })).json
  const pago = await firmarPago(desafio)

  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  // The client already received its tokens. That's the price of settling
  // afterward, and it's accepted by D12: the alternative is an on-chain
  // transaction ahead of the TTFT. What CANNOT happen is the request falling over.
  t.is(r.status, 200, 'the response goes out the same way: the work was already done')
  t.ok(r.json.choices[0].message.content.length > 0)

  const recibo = reciboDe(r)
  t.ok(recibo, 'the receipt still arrives')
  t.is(recibo && recibo.success, false, 'but the receipt says it did NOT get charged')
  t.ok(recibo && (recibo.errorReason || recibo.errorMessage), 'and why')

  facilitatorFalla = false
  gw.setEconomic(null)
  delete env[x402.VAR_FACILITATOR]
})

// ---------------------------------------------------------------------------
// PHASE 9 / D24, D25, D27 — the provider's attestation, hanging off the receipt
//
// The x402 receipt the tests above verify proves someone PAID. What's
// missing is the other side: WHAT the one who got paid actually served.
// D24 hangs it off the same receipt D12 already forces to be built, signed
// with the WALLET and not the network key -- same criterion as Phase 10 and
// as manifest-v0.json:84.
//
// In this phase the artifact only gets emitted and stored. Nothing
// consumes it: that's Phase 10. It's deliberate -- there's no retroactive
// signing, and every day of Phase 9 without this is history that doesn't come back.
// ---------------------------------------------------------------------------

// The provider signs with account 1, NOT with account 0.
//
// 0 is the one the tests above use for `pagador()`. If both ends used the
// same address, a bug that confused payer with payee would go unnoticed:
// everything would still verify because they'd be the same one.
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

// Leaves the gateway with a wallet AND a signer. Both things: with an
// address and no signer there's a 402 and no attestation, which is a
// legitimate case tested separately.
async function conProveedorQueFirma() {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  const p = await proveedorFirmante()
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: these tests (D12, D24, D25, D27) exercise IMMEDIATE
  // per-request settlement. The project's default is `batch-receipts`,
  // which defers to the batch — that has its own test ('a batch-receipts
  // node does NOT settle per request'). The schema decides the mode, not a flag.
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

// Pays and serves in one step: 402, sign, resend. Returns the served response.
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

// The completion's id, pulled from an SSE body. It's the key for /v1/receipts.
function idDeSSE(body) {
  for (const bloque of String(body || '').split('\n\n')) {
    const s = bloque.replace(/^data: /, '').trim()
    if (!s || s === '[DONE]') continue
    try {
      const o = JSON.parse(s)
      if (o && o.id) return o.id
    } catch (e) {
      /* the receipt event doesn't carry an id: keep going */
    }
  }
  return null
}

// A POST that CUTS the connection as soon as it sees the first delta with content.
//
// `pedir` reads to the end, so it's no good for D27 case 1: the case is
// exactly the client that leaves early. Resolves with whatever it managed to read.
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

test('D24: the receipt carries the attestation of what got served, signed with the wallet', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const p = await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]
  const { r } = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(r.status, 200)

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.status, 200, 'the receipt gets retrieved by the completion\'s id')

  const a = rec.json.attestation
  t.ok(a, 'and it carries the provider\'s attestation (D24)')

  // The signature is the WALLET's, not the network key's, and verification
  // uses the SAME canonicalization as signing -- which is the only way they
  // can't diverge.
  const v = await at.verificar(a)
  t.ok(v.ok, 'verifies: ' + (v.reason || ''))
  t.is(a.providerPubkey, p.address, 'signed by this node\'s payout address')

  // THIS is the field that closes D24's hole: the hash is of the TEXT, and
  // the text is exactly what the client received.
  t.is(
    a.outputHash,
    at.hashDe(r.json.choices[0].message.content),
    'the outputHash is that of what the client actually received'
  )
  t.is(a.promptHash, at.hashDeMensajes(messages), 'and the promptHash, that of the whole conversation')

  // A mock signed with a real wallet is still a mock. That the artifact
  // says so, and not just the README, is the project's rule about mocks.
  t.is(a.runtime, 'mock', 'the artifact says what it was generated with: ' + a.runtime)
  t.is(a.finishReason, 'stop')
  t.ok(a.nonce && a.ts > 0, 'with nonce and timestamp')

  await soltarProveedor()
})

test('D24: troceando el stream cambia el conteo del gateway y NO cambia el hash', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  await conProveedorQueFirma()

  // D24's attack, staged. The gateway increments its counter ONCE PER DELTA
  // with content, and it's the provider who decides how many deltas that
  // is: the same text served one character at a time inflates that counter
  // without lying in any field and without breaking any validation. It
  // doesn't falsify the number, it falsifies the signal the other side
  // counts.
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

  t.is(entero.r.json.choices[0].message.content, TEXTO, 'both served the same text')
  t.is(troceado.r.json.choices[0].message.content, TEXTO)

  // The attack works against the counter: 1 delta against 24.
  t.is(logEntero.tokens, 1, 'whole: the gateway counted 1')
  t.is(logTroceado.tokens, TEXTO.length, 'chunked: it counted ' + TEXTO.length + ' for the same text')

  // And it does not work against the hash, which is the entire reason D24
  // requires it. Anyone can recount the tokens from the attested text.
  t.is(
    recEntero.json.attestation.outputHash,
    recTroceado.json.attestation.outputHash,
    'the outputHash is the same: the text does not depend on how many pieces it traveled in'
  )

  respuestaModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D25: the trail separates prefill from decode, and says where each number came from', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')

  // 1. With `usage` from the provider: these are the REAL tokens, counted
  //    by ITS tokenizer. The fake provider sends 1000/500 on purpose, numbers
  //    that don't match anything that can be counted on this side.
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
  t.is(e1.tokensPrefill, 1000, 'the provider\'s prefill')
  t.is(e1.tokensDecode, 500, 'the provider\'s decode')
  t.is(e1.tokensFuente, 'proveedor', 'and the trail says it was measured, not estimated')

  // The OLD fields do not change meaning. There's a panel and history
  // reading `tokens`, and redefining it would turn earlier entries into
  // something else without anyone noticing. D25 ADDS.
  t.is(typeof e1.tokens, 'number', '`tokens` sigue siendo lo que era')
  t.absent(e1.tokens === e1.tokensDecode, 'y sigue sin ser lo mismo que el decode real')

  store.clearUpstreams()
  gw.setUpstreams([])

  // 2. Without `usage`: what's left is an ESTIMATE of the prompt and a
  //    count of DELTAS, which are not tokens. Calling that 'proveedor'
  //    would suggest there's a measurement where there's a count of SSE chunks.
  const sinUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinUsage.status, 200)

  const e2 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  t.is(e2.tokensFuente, 'gateway', 'a mock does not send usage: the source says so')
  t.ok(e2.tokensPrefill > 0, 'the prefill comes from the prompt estimator')
  t.is(e2.tokensDecode, e2.tokens, 'and the decode is the delta count, which is all there is')
})

test('D9/D27 case 3: the cap the 402 declares now gets APPLIED, and it says length', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]

  // Without a requested cap, the 402 declares the node's ceiling and the
  // response comes out whole. This is the control: without it, a cap test
  // would pass even if the mock answered short on its own.
  const libre = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(libre.r.status, 200)
  t.is(libre.r.json.choices[0].finish_reason, 'stop', 'without a cap, it finishes normally')
  const largoEntero = libre.r.json.choices[0].message.content.length

  // With a cap. The number DECLARED in accepts[] and the one APPLIED are
  // the same: declaring one and trimming with another means charging for
  // work different from what was agreed.
  const cortado = await pagarYPedir({ model: 'facturas-ar', messages, max_tokens: 4 })
  t.is(cortado.desafio.json.accepts[0].outputTokenLimit, 4, 'the 402 declares the cap')
  t.is(cortado.r.status, 200)

  const texto = cortado.r.json.choices[0].message.content
  t.ok(texto.length > 0, 'something got served')
  t.ok(
    texto.length < largoEntero,
    'and it got cut off: ' + texto.length + ' against ' + largoEntero + ' without a cap'
  )

  // The condition D9 calls NON-NEGOTIABLE. Charging for a cap and reporting
  // normal termination lies in the only field the client checks to know
  // whether it's missing text -- and the one an agent checks to decide
  // whether to request a continuation.
  t.is(cortado.r.json.choices[0].finish_reason, 'length', 'and it SAYS SO: length, not stop')

  // D27 case 3: COMPLETE attestation, and it gets charged.
  const rec = await pedir('GET', '/v1/receipts/' + cortado.r.json.id)
  t.is(rec.json.success, true, 'it gets charged: the response finished as agreed')
  t.is(rec.json.attestation.finishReason, 'length', 'the attestation says the same')
  t.is(rec.json.attestation.outputHash, at.hashDe(texto), 'over the served prefix')

  await soltarProveedor()
})

test('D27 case 2: the provider drops mid-stream and does NOT get charged', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  await conProveedorQueFirma()

  // A single candidate for this model: with another one behind it the
  // request would get saved by the retry and the failure wouldn't be
  // getting tested.
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

  // The provider opens 200, sends a delta, and then reports it broke with
  // an `error` object IN THE BODY. It's the normal way to fall over mid-way
  // once the headers have already gone out -- the status went out before
  // the first token and can't be corrected --, and it's the one B15 teaches
  // how to detect.
  //
  // This is used on purpose instead of a `res.destroy()`: see the note
  // above `pausaModelo`. A socket destroyed after a pause does NOT arrive
  // as a failure, so a test built on that would prove the opposite of what
  // it claims.
  errorEnStreamModelo = 'c9'
  const cuerpo = {
    model: 'cae-9',
    messages: [{ role: 'user', content: 'hola' }],
    // With streaming, D4 can no longer retry: the client already got a token.
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
  t.ok(id, 'the stream did manage to open, so there is an id')
  t.absent(r.body.indexOf('paymentResponse') !== -1, 'NO receipt: nothing got settled')

  // This is Phase 9's most important DoD, and the easiest one to break:
  // verification protects the provider from spending free GPU, the absence
  // of settlement protects the client from paying for what it did not receive.
  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 404, 'and there is nothing to retrieve: nothing was charged')

  // D27: no attestation either. The node cannot commit to a response it
  // did not finish delivering.
  t.absent(r.body.indexOf('attestation') !== -1, 'nor an attestation')

  errorEnStreamModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D27 case 1: the client cuts off, the emitted prefix gets attested and it DOES get charged', async (t) => {
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
  t.ok(id, 'the client did manage to see the first delta before leaving')
  t.ok(parcial.body.indexOf(PRIMERO) !== -1, 'and that delta is the first piece')

  // Settlement and signing happen AFTER the socket has already closed.
  await esperar(1600)

  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 200, 'there is a receipt: the work got done and the prefix arrived (D27 case 1)')
  t.is(rec.json.success, true, 'and it DOES get charged, up to that point')

  const a = rec.json.attestation
  t.ok(a, 'with a PARTIAL attestation')
  t.ok((await at.verificar(a)).ok, 'signed and verifiable like any other')
  t.is(a.finishReason, 'client_cancelled', 'which says how it finished, without flattening it to stop')

  // What makes the partial one verifiable: the hash is of the prefix the
  // client ACTUALLY received, not the one the whole response would have
  // had. The gateway used to keep accumulating in `contenido` whatever
  // arrived after the cutoff, so the hash covered text nobody saw.
  t.is(a.outputHash, at.hashDe(PRIMERO), 'over the emitted prefix, not over the entire response')
  t.absent(
    a.outputHash === at.hashDe(PRIMERO + SEGUNDO),
    'and NOT over what the provider sent after the client left'
  )

  pausaModelo = null
  store.clearUpstreams()
  gw.setUpstreams([])
  await soltarProveedor()
})

test('D24: without a signer NO attestation comes out, and the receipt says why', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  // With a wallet -- so it gets charged -- and no signer. It's the real
  // state of a node whose passphrase did not open the keystore: it can
  // announce an address from the old manifest and cannot sign anything.
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: IMMEDIATE per-request settlement. The project's
  // default is `batch-receipts` (defers to the batch); that's covered by
  // 'a batch-receipts node does NOT settle per request'. The schema
  // decides, not a flag.
  gw.setEconomic(wallet.economicDe('0x' + 'ab'.repeat(20), 'onchain-per-job'))
  gw.setWalletSigner(null)

  const { r } = await pagarYPedir({
    model: 'facturas-ar',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(r.status, 200, 'the request gets served the same way: the attestation is not a gate')

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.json.attestation, null, 'and no unsigned attestation comes out')
  t.ok(rec.json.attestationMissing, 'the absence comes with a reason: ' + rec.json.attestationMissing)
  t.ok(
    String(rec.json.attestationMissing).indexOf('signer') !== -1,
    'which says which of the possible reasons it was'
  )

  await soltarProveedor()
})

// ---------------------------------------------------------------------------
// PHASE 9 — the DoD against a PEER, not against an upstream
//
// The three D27 cases above run against the external assistant, which is
// HTTP. Phase 9's DoD talks about "killing THE NODE mid-stream", and a node
// is not HTTP: it's the swarm channel, with its own framing and its own
// chat:cancel. These are two transports with different guarantees and both
// need exercising.
//
// The fake swarm is the minimum `streamFromPeer` asks of it -- chatRequest,
// cancelChat, and the four callbacks --, and it exists above all for ONE
// property HTTP can't reproduce: **a chat:cancel takes a round trip, and
// the peer keeps generating in the meantime**. Chunks already in flight
// arrive AFTER the gateway decided to cut, and what gets done with them
// decides whether D27 case 1's outputHash is trustworthy or not.
// ---------------------------------------------------------------------------

const PEER_KEY = 'ee'.repeat(32)
const MODELO_PAR = 'par-9'
// The peer's wallet is REAL: derived from a test WDK account (index 2,
// neither the payer nor the local provider). This way the peer can SIGN
// its partial attestation and the gateway can VERIFY it against the
// manifest's wallet — which is what registrarRuteado requires to attach it (D27 case 1).
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

// Filled in the first time `conParRegistrado` runs; the tests compare it
// against the 402's `payTo`.
let WALLET_DEL_PAR = '0x' + '5c'.repeat(20)

function manifiestoDelPar() {
  return {
    metadata: { operator: 'Par de prueba', tags: ['general'] },
    // D10 — the 402's payTo comes from HERE, from the peer's signed
    // manifest, not from a constant of ours. It's the PEER's wallet, not this gateway's.
    economic: { walletAddress: WALLET_DEL_PAR, chains: ['stable'], settlement: 'batch-receipts' },
    models: [
      { modelId: MODELO_PAR, displayName: 'Modelo del par', qos: { maxConcurrentRequests: 4 } }
    ]
  }
}

// The PARTIAL D24 attestation the peer signs over the prefix it managed to
// serve before the client cut off. It's what its late `chat:done` carries
// back so the gateway can attach it to the routed trail.
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

// `guion` (script) receives the callbacks and an object it can hang an
// "in-flight" chunk off of: the one that's going to arrive once the cancel
// has already gone out.
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
      // Asynchronous like the real thing: the peer answers after
      // chatRequest has returned, not inside it.
      const t = setTimeout(() => guion(cbs, estado), 0)
      if (t.unref) t.unref()
      return id
    },
    cancelChat(id) {
      const e = enVuelo.get(id)
      if (!e || e.cortado) return
      e.cortado = true
      // THE WHOLE POINT OF THIS. On a real network chat:cancel takes a
      // round trip and the peer doesn't stop dead: whatever already went
      // out still arrives, AFTER this side decided to cut. Here that's
      // synchronous and deterministic instead of a race.
      if (e.tardio) e.cbs.onChunk(e.tardio)
      // PHASE 10 / D27 case 1 — and afterward the peer sends its late
      // `chat:done`: the real swarm keeps the chat alive waiting for it
      // (with the peer-signed partial attestation, or the reason if it's
      // missing). `e.doneTardio` lets a test define it; by default it's an
      // absence with a reason.
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
  // The fake facilitator gets pointed HERE and not in each test: without
  // this `liquidar` goes out to the real one over the internet, the test
  // passes for the wrong reason -- the receipt still gets saved when
  // settlement fails -- and on top of that `npm test` stops running without a network.
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

test('PHASE 9 DoD: killing the node mid-stream does NOT charge', async (t) => {
  // The peer accepts, sends a token, and dies. It's Phase 9's DoD third
  // line, and the one the roadmap itself flags as the easiest to break:
  // verification protects the provider from spending free GPU, the ABSENCE
  // of settlement protects the client from paying for what it did not receive.
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
  t.is(desafio.status, 402, 'the 402 comes out with the PEER\'s wallet (D10)')
  t.is(desafio.json.accepts[0].payTo, WALLET_DEL_PAR, 'not this gateway\'s')

  const pago = await firmarPago(desafio.json)
  const r = await pedir('POST', '/v1/chat/completions', {
    body: cuerpo,
    headers: { 'X-PAYMENT': pago }
  })

  t.ok(r.body.indexOf('empiezo a contestar') !== -1, 'the client saw what managed to arrive')
  t.absent(r.body.indexOf('paymentResponse') !== -1, 'and there is NO receipt: nothing settled')

  const id = idDeSSE(r.body)
  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 404, 'there is nothing to retrieve, because nothing was charged')

  await soltarPar()
})

test('D27 case 1: the peer\'s late chat:done carries the partial attestation and gets attached to the trail', async (t) => {
  const VISTO = 'esto lo recibio el cliente'
  const TARDIO = ' y esto llego despues del cancel'

  // What the peer signs over what it MANAGED to serve: VISTO, one delta.
  // The late chunk doesn't count in —the client never received it—, same
  // as the outputHash of a partial served by this same node.
  const attParcial = await atestacionParcialDelPar({
    requestId: 'chatcmpl-parcial',
    contenido: VISTO,
    deltas: 1
  })

  await conParRegistrado((cbs, estado) => {
    cbs.onAccepted()
    cbs.onChunk(VISTO)
    // Hangs the late chunk: goes out when the gateway sends the chat:cancel.
    estado.tardio = TARDIO
    // PHASE 10 / D27 case 1 — and its late `chat:done`, with the signed
    // attestation. It used to get discarded because `cancelChat` deleted
    // the chat on the spot; now it keeps it alive for a short window just to receive this.
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
  t.ok(id, 'the client saw the first chunk and left')
  t.absent(parcial.body.indexOf(TARDIO) !== -1, 'the late one was NEVER written out to the client')

  await esperar(1200)

  const rec = await pedir('GET', '/v1/receipts/' + id)
  t.is(rec.status, 200, 'a trail of the routing remains (D27 case 1)')
  // PHASE 10 — the handoff: the gateway does NOT settle a routed request,
  // the peer charges it from its own batch. That's why there's no
  // `success`/`transaction` on this side.
  t.is(rec.json.settledBy, 'peer-batch', 'the settlement is the peer\'s, deferred')
  t.absent(rec.json.success, 'this gateway does not show a settlement it did not do')

  // AND NOW the half that was missing: the peer's late `chat:done` arrived,
  // its partial attestation verified against the peer's manifest wallet,
  // and it ended up attached to the routed trail instead of an `attestationMissing`.
  t.ok(rec.json.attestation, 'the peer\'s partial attestation DID reach the trail')
  t.is(
    (rec.json.attestation || {}).finishReason,
    'client_cancelled',
    'and it says the client cut off (D27)'
  )
  t.is(
    String((rec.json.attestation || {}).providerPubkey || '').toLowerCase(),
    WALLET_DEL_PAR.toLowerCase(),
    'signed by the PEER\'s wallet, not this gateway\'s'
  )
  t.absent(rec.json.attestationMissing, 'there is no longer a reason for absence: the attestation is there')

  // And the trail does not count the late chunk: what gets logged is what
  // the client received, not what the provider kept sending after it left.
  const e = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0] || {}
  t.is(e.finishReason, 'client_cancelled', 'the trail says who cut off')
  t.is(e.tokens, 1, 'and it counted ONE chunk, not two: the late one got discarded')

  await soltarPar()
})

// ---------------------------------------------------------------------------
// PHASE 10 — receipts and batch
//
// Phase 9 verifies, serves, and settles AFTERWARD (D12). Phase 10 does the
// same with DEFERRED settlement: verified payments accumulate and get
// settled in bulk. These tests prove the gateway accumulates what IT
// served, that a peer's receipt does not enter OUR batch (D10), that the
// batch gets built and signed with the wallet, and that the protocol with
// the facilitator is the declared one.
//
// Phase 9's immediate settlement is not touched: the batch stores how it went and
// `liquidarLote` retries the ones that failed. It reopens Phase 9 for the
// `plasma-testnet` entry added to x402.mjs.
// ---------------------------------------------------------------------------

test('PHASE 10 / D10: the batch accumulates receipts under the NODE\'s payTo, and a peer\'s do NOT', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const x402 = await import('../qvac/x402.mjs')
  // The fake facilitator is already up from the first settlement test and
  // gets closed at the end; conProveedorQueFirma points VAR_FACILITATOR there.
  lote.limpiar()

  const p = await conProveedorQueFirma()

  // Two paid local requests: this node serves them, the payTo is its wallet.
  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  const a = await pagarYPedir(cuerpo)
  const b = await pagarYPedir(cuerpo)
  t.is(a.r.status, 200)
  t.is(b.r.status, 200)

  const mios = lote.pendientes()
  t.is(mios.length, 2, 'both verified payments entered the batch')
  t.ok(
    mios.every((r) => r.payTo.toLowerCase() === p.address.toLowerCase()),
    'and all pay THIS node\'s wallet (D10)'
  )
  t.ok(
    mios.every((r) => r.nonce && r.authorization && r.signature),
    'with the full EIP-3009 authorization'
  )
  t.ok(
    mios.every((r) => r.liquidacion && r.liquidacion.success),
    'and with how the immediate settlement went'
  )
  t.ok(
    mios.every((r) => r.attestation && r.attestation.signature),
    'and the D24 attestation attached'
  )

  // Now a request served by a PEER: the payTo pointed at ITS wallet.
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
  t.is(desafio.json.accepts[0].payTo, WALLET_DEL_PAR, 'the 402 pays the peer (D10)')
  const pago = await firmarPago(desafio.json)
  await pedir('POST', '/v1/chat/completions', { body: cuerpoPar, headers: { 'X-PAYMENT': pago } })
  await esperar(400)

  t.absent(
    lote.pendientes().some((r) => r.payTo.toLowerCase() === WALLET_DEL_PAR.toLowerCase()),
    'the peer\'s receipt does NOT enter our batch: it\'s theirs, it travels over Protomux signed by them'
  )

  await soltarPar()
  lote.limpiar()
})

test('PHASE 10: the node<->facilitator protocol is the one x402 declares', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  ultimoSettle = null
  const p = await conProveedorQueFirma()

  await pagarYPedir({ model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] })

  t.ok(ultimoSettle, 'the facilitator received the settlement')
  const dec = x402.PROTOCOLO_FACILITATOR
  for (const campo of dec.envia) t.ok(campo in ultimoSettle, `sends ${campo}`)
  const pp = ultimoSettle.paymentPayload
  for (const campo of dec.paymentPayload) t.ok(campo in pp, `paymentPayload carries ${campo}`)
  for (const campo of dec.paymentPayloadPayload) {
    t.ok(campo in pp.payload, `and inside it, ${campo}`)
  }
  t.is(pp.scheme, 'exact')
  t.is(
    pp.network,
    ultimoSettle.paymentRequirements.network,
    'the payment\'s network and the requirement\'s match'
  )
  t.is(
    ultimoSettle.paymentRequirements.payTo.toLowerCase(),
    p.address.toLowerCase(),
    'and the requirement settles against the node\'s wallet, not a recalculated one'
  )

  await soltarProveedor()
})

test('PHASE 10: the batch gets built, signed with the wallet, and can settle deferred', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const x402 = await import('../qvac/x402.mjs')
  lote.limpiar()
  const p = await conProveedorQueFirma()

  const cuerpo = { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  await pagarYPedir(cuerpo)
  await pagarYPedir(cuerpo)

  // `armar` throws if the accumulator is empty -- which happens if the
  // gateway stopped accumulating. It gets caught so that comes out as a
  // failed assert and not an Uncaught that takes the run down with it
  // (same lesson as B18).
  let l = null
  try {
    l = lote.armar({})
  } catch (err) {
    /* l stays null and the assert below speaks */
  }
  t.ok(l, 'there are accumulated receipts and the batch gets built')
  if (!l) {
    await soltarProveedor()
    return
  }
  t.is(l.count, 2, 'the batch gathers the two accumulated receipts')
  t.is(l.network, 'eip155:988', 'from a single network')
  t.is(l.payTo.toLowerCase(), p.address.toLowerCase(), 'to a single wallet')
  t.is(
    l.totalAmount,
    (BigInt(l.recibos[0].amount) + BigInt(l.recibos[1].amount)).toString(),
    'with the total summed up'
  )

  const firmado = await lote.firmarLote(l, p.firmar)
  t.ok(firmado && firmado.signature.startsWith('0x'), 'signed by the node\'s wallet')

  const v = await lote.verificarLote(firmado)
  t.ok(v.ok, 'and it verifies whole: ' + (v.reason || ''))
  t.is(v.firmante.toLowerCase(), p.address.toLowerCase(), 'the signer is the node\'s wallet')
  t.is(v.recibosMal.length, 0, 'and the EIP-3009 authorizations inside recover whoever paid')

  // Deferred settlement: walks the batch calling the SAME x402.liquidar
  // against the fake facilitator. It's Phase 9's flow with deferred settlement.
  const res = await lote.liquidarLote({ lote: firmado, liquidar: x402.liquidar })
  t.is(res.liquidados.length, 2, 'both settle within the batch')
  t.is(res.fallidos.length, 0)
  lote.marcarLiquidados(res.liquidados)
  t.is(
    lote.pendientes({ soloPendientes: true }).length,
    0,
    'and they stay marked: a crash-and-resume does not charge again'
  )

  await soltarProveedor()
  lote.limpiar()
})

test('PHASE 10: a batch-receipts node does NOT settle per request, it defers to the batch', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default
  lote.limpiar()
  ultimoSettle = null

  // The node with its DEFAULT settlement — batch-receipts, what the
  // project's signed manifest declares. The schema decides: there's no flag.
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
  t.is(r.status, 200, 'it gets served the same: payment got verified, only settlement is deferred')
  t.absent(
    r.headers['x-payment-response'],
    'and there is no X-PAYMENT-RESPONSE: nothing settled per request'
  )
  t.absent(ultimoSettle, 'the facilitator did NOT receive any per-request settlement')

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
  t.ok(evento, 'the final SSE event describes the settlement')
  t.is(evento && evento.settledBy, 'batch', 'which is deferred: settledBy = batch')
  t.is(evento && evento.paymentResponse, null, 'no settlement receipt yet')
  t.ok(
    evento && evento.x402Note && evento.x402Note.indexOf('batch-receipts') !== -1,
    'and it explains it: ' + (evento && evento.x402Note)
  )
  // The D24 attestation DOES travel: it's independent of the settlement mode.
  t.ok(evento && evento.attestation && evento.attestation.signature, 'the D24 attestation still comes out')

  // The receipt stayed in the batch UNSETTLED: it's the flush that charges it.
  const pend = lote.pendientes({ soloPendientes: true })
  t.is(pend.length, 1, 'the verified payment stayed pending in the batch')
  t.is((pend[0] || {}).liquidacion, null, 'no immediate settlement: that\'s the flush\'s job')

  // And the flush settles it — the same x402.liquidar, now in a batch.
  const res = await lote.flushTodo({ firmar: p.firmar, liquidar: x402.liquidar })
  t.is((res[0] || {}).liquidados, 1, 'the flush settles the deferred receipt')
  t.ok(ultimoSettle, 'and ONLY NOW does the facilitator receive the settlement')
  t.is(lote.pendientes({ soloPendientes: true }).length, 0, 'nothing left pending')

  gw.setEconomic(null)
  gw.setWalletSigner(null)
  delete env[x402.VAR_FACILITATOR]
  lote.limpiar()
})

test('PHASE 10 / precondition: x402 builds an accepts[] for plasma-testnet (9746)', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  t.is(x402.CAIP2['plasma-testnet'], 'eip155:9746', 'the network is in the table')

  // Without ASSET/NAME declared it does not get offered: a client does not sign a half EIP-712.
  delete env[x402.VAR_PLASMA_TESTNET_ASSET]
  delete env[x402.VAR_PLASMA_TESTNET_NAME]
  t.is(await x402.activoDe('plasma-testnet'), null, 'without declaring it, the network stays out')

  env[x402.VAR_PLASMA_TESTNET_ASSET] = '0x' + 'a1'.repeat(20)
  env[x402.VAR_PLASMA_TESTNET_NAME] = 'PyrusLLM Test USD'
  const activo = (await x402.activoDe('plasma-testnet')) || {}
  t.is(activo.network, 'eip155:9746', 'with ASSET and NAME declared, the network gets offered')
  t.is(activo.asset, '0x' + 'a1'.repeat(20))
  t.is(
    activo.name,
    'PyrusLLM Test USD',
    'with the EIP-712 domain the client needs to sign'
  )
  t.ok(
    (await x402.redesDisponibles()).includes('plasma-testnet'),
    'and it enters the available networks'
  )

  delete env[x402.VAR_PLASMA_TESTNET_ASSET]
  delete env[x402.VAR_PLASMA_TESTNET_NAME]
})

// ---------------------------------------------------------------------------
// PHASE 9 — THAT WHAT GETS EMITTED REACHES THE PANEL
//
// The tests above prove the gateway EMITS the four artifacts. These prove
// the other thing, which was missing: that that data, exactly as it goes
// out over HTTP, reaches the panel WITH ITS MEANING. It's not enough for
// the HTML to get served -- that's what "all four panels still render"
// already checked, and it kept serving perfectly with the four artifacts invisible inside.
//
// `qvac/panel-x402.mjs` gets exercised, which is literally the code
// pages.mjs pastes inside each page's <script>. Fed, here, with the
// gateway's REAL responses and not hand-written fixtures: a fixture that
// ages badly is exactly how a field's shape change goes unnoticed.
// ---------------------------------------------------------------------------

test('PHASE 9 visible: the real 402 reaches the panel with the FOUR pieces of data', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const px = await import('../qvac/panel-x402.mjs')

  const direccion = '0x' + 'ab'.repeat(20)
  gw.setEconomic(wallet.economicDe(direccion))

  const r = await pedir('POST', '/v1/chat/completions', {
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(r.status, 402, 'the node asks for payment')

  // Before this, the chat flattened the 402 to "[error] HTTP 402" and the
  // DoD's four pieces of data got lost along the way.
  const v = px.vistaDeDesafio(r.json)
  t.ok(v.esDesafio, 'the panel recognizes it as a charge and not as an error')
  const o = v.opciones[0]
  t.is(o.monto, r.json.accepts[0].amount, 'HOW MUCH, exactly as it came out of the endpoint')
  t.is(o.payTo, direccion, 'TO WHOM')
  t.is(o.red.id, r.json.accepts[0].network, 'ON WHICH CHAIN, with the raw CAIP-2')
  t.is(o.tope, r.json.accepts[0].outputTokenLimit, 'UP TO HOW MANY TOKENS')

  const html = px.htmlDeDesafio(v)
  t.ok(html.indexOf(direccion) !== -1, 'the address gets drawn whole, not truncated')
  t.ok(html.indexOf(String(o.tope)) !== -1, 'and the cap too')
  t.ok(html.indexOf(o.red.id) !== -1, 'with the network\'s id, not just the name')

  gw.setEconomic(null)
})

test('PHASE 9 visible: the receipt and the attestation, with the outputHash compared', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const p = await conProveedorQueFirma()

  const messages = [{ role: 'user', content: 'hola' }]
  const { r } = await pagarYPedir({ model: 'facturas-ar', messages })
  t.is(r.status, 200)

  const rec = await pedir('GET', '/v1/receipts/' + r.json.id)
  t.is(rec.status, 200)

  const contenido = r.json.choices[0].message.content
  const vista = px.vistaDeAtestacion(rec.json, { textoRecibido: contenido, messages })

  // THIS is what makes the attestation evidence and not just a field: the
  // hash gets recomputed in the panel over the text the client received.
  // That the gateway computed it correctly was already tested; that a
  // person can CHECK it by looking, wasn't.
  const out = vista.hashes.filter((h) => h.campo === 'outputHash')[0]
  t.is(out.estado, 'coincide', 'the outputHash recomputed in the panel matches')
  t.is(out.declarado, rec.json.attestation.outputHash)
  const prompt = vista.hashes.filter((h) => h.campo === 'promptHash')[0]
  t.is(prompt.estado, 'coincide', 'and the promptHash, over the whole conversation')

  // Rule 2: the run is in --demo mode, meaning the text is made up and the
  // signature is from a real wallet. The panel has to say both things.
  t.is(rec.json.attestation.runtime, 'mock', 'the artifact declares it')
  t.ok(vista.esMock, 'and the panel flags it')
  t.is(vista.providerPubkey, p.address, 'signed by this node\'s payout address')

  const html = px.htmlDeRecibo(rec.json, { textoRecibido: contenido, messages })
  t.ok(html.indexOf('runtime: mock') !== -1, 'a mock LOOKS like a mock on screen')
  t.ok(html.indexOf('coincide') !== -1, 'and the hash comparison gets drawn')

  // Rule 4: against the fake facilitator the tx is 0xfe...fe, and it does
  // not exist on the explorer. This is this tree's REAL state -- the DoD
  // item that got left out (0-quater) -- and the panel cannot present it as a transaction.
  const liq = px.vistaDeLiquidacion(px.liquidacionDe(rec.json))
  t.ok(liq.liquidado, 'the facilitator reported success')
  t.ok(liq.txSintetico, 'but the hash is a test facilitator\'s stamp')
  t.ok(html.indexOf('facilitator de PRUEBAS') !== -1, 'and that gets drawn next to the hash')

  await soltarProveedor()
})

test('PHASE 9 visible: a missing attestation reaches the panel WITH the reason', async (t) => {
  const gw = await import('../qvac/gateway.mjs')
  const wallet = await import('../qvac/wallet.mjs')
  const x402 = await import('../qvac/x402.mjs')
  const px = await import('../qvac/panel-x402.mjs')
  const env = (await import('bare-env')).default

  // With a wallet -- so it charges -- and no signer: a node's real state
  // when its passphrase did not open the keystore. No unsigned attestation gets emitted.
  env[x402.VAR_FACILITATOR] = 'http://127.0.0.1:' + PUERTO_FACILITATOR
  // `onchain-per-job`: IMMEDIATE per-request settlement. The project's
  // default is `batch-receipts` (defers to the batch); that's covered by
  // 'a batch-receipts node does NOT settle per request'. The schema
  // decides, not a flag.
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
  t.is(vista.motivo, rec.json.attestationMissing, 'the endpoint\'s reason travels WITHOUT summarizing')
  t.ok(vista.motivoDeclarado, 'and it is on record that someone declared it')

  const html = px.htmlDeAtestacion(vista)
  t.ok(html.indexOf(rec.json.attestationMissing) !== -1, 'the reason gets drawn in full')
  t.absent(html.indexOf('coincide') !== -1, 'and nothing gets asserted about hashes that do not exist')

  await soltarProveedor()
})

test('PHASE 9 visible: the trail reaches the panel with the split AND its provenance', async (t) => {
  const store = await import('../qvac/store.mjs')
  const upstream = await import('../qvac/upstream.mjs')
  const gw = await import('../qvac/gateway.mjs')
  const px = await import('../qvac/panel-x402.mjs')

  // 1. A provider that sends `usage`: these are tokens counted by ITS tokenizer.
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
  t.ok(medido.medido, 'the panel flags it as measured')
  t.is(medido.prefill, e1.tokensPrefill, 'and shows the trail\'s numbers, not other ones')
  t.is(medido.decode, e1.tokensDecode)

  store.clearUpstreams()
  gw.setUpstreams([])

  // 2. A mock does not send `usage`. What's left is a prompt estimate and a
  //    delta count: it CANNOT be drawn the same as the above.
  const sinUsage = await pedir('POST', '/v1/chat/completions', {
    key: KEY,
    body: { model: 'facturas-ar', messages: [{ role: 'user', content: 'hola' }] }
  })
  t.is(sinUsage.status, 200)

  const e2 = (await pedir('GET', '/v1/routing-log', { key: KEY })).json.log[0]
  const estimado = px.vistaDeConteo(e2)
  t.is(estimado.fuente, 'gateway')
  t.absent(estimado.medido, 'an SSE chunk count is not a measurement')

  t.absent(
    px.htmlDeConteo(medido) === px.htmlDeConteo(estimado),
    'and the two REAL trails are not drawn the same'
  )
  t.ok(px.htmlDeConteo(estimado).indexOf('tono-estimado') !== -1)
  t.ok(px.htmlDeConteo(medido).indexOf('tono-medido') !== -1)

  // D27 also travels in the trail: without this, a client cutoff and a
  // complete response look identical in the panel.
  t.ok(e2.finishReason, 'the trail declares how it finished: ' + e2.finishReason)
  t.ok(px.textoDeFinishReason(e2.finishReason).length > 0, 'and the panel says it in words')
})

test('PHASE 9 visible: the served panels CARRY the code that draws all of this', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // The grep that opened this work: `receipts`, `attestation`, `x402`,
  // `402`, `tokensPrefill`, `tokensDecode`, `tokensFuente`, `finishReason`
  // and `outputHash` all gave ZERO hits over pages.mjs. The four artifacts
  // got served over HTTP and could only be seen with curl.
  //
  // The SERVED HTML gets checked, not the module: between the two there's
  // an interpolation that can get left out without anything failing, and
  // the panel would keep serving fine -- complete, and with none of Phase 9 inside.
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
      nombre + ' carries panel-x402.mjs\'s code embedded, whole'
    )
  }

  // And that that code is CONNECTED to something, which is what the served
  // HTML can prove and the module alone can't: pasting it without calling
  // it would pass this test with the panels just as blind as before.
  //
  // Each CALL SITE is looked for and not the bare function name, and the
  // difference isn't cosmetic: `FUENTE_EMBEBIDA` contains the definitions,
  // meaning an `indexOf('htmlDeDesafio(')` gives a positive even if nobody
  // ever calls it. A test satisfied by the definition isn't watching the wire.
  //
  // THE LIMIT, stated: this checks that the wire exists in the served
  // HTML, not that the browser executes it. What actually runs are the
  // functions, and that's what the unit suite tests against the SAME
  // source embedded here. A headless browser would be the only way to
  // close the last stretch and it isn't in this tree.
  t.ok(chat.body.indexOf('htmlDeDesafio(m.x402)') !== -1, 'the chat draws the turn\'s 402')
  t.ok(chat.body.indexOf('htmlDeRecibo(m.recibo,') !== -1, 'and the receipt with its attestation')
  t.ok(chat.body.indexOf('slot.recibo = ev') !== -1, 'storing D12\'s final SSE event')
  t.ok(
    chat.body.indexOf('vistaDeDesafio(b)') !== -1,
    'and reading the 402\'s body instead of flattening it'
  )
  t.ok(
    node.body.indexOf('htmlDeRecibo(await r.json(), ctx)') !== -1,
    '/node draws the receipt it looks up'
  )
  t.ok(node.body.indexOf('htmlDeConteo(vistaDeConteo(e))') !== -1, '/node paints D25\'s split')
  t.ok(admin.body.indexOf('htmlDeConteo(vistaDeConteo(e))') !== -1, 'and admin\'s log too')

  // And this one, which is a property and not a detail: `GET
  // /v1/receipts/:id` is the ONLY route that does not ask for a
  // credential, because whoever paid via 402 has none -- that's the
  // entire point of the 402. If the panel requested it with `authFetch`,
  // it would hide that property behind a header that isn't needed, and the
  // day someone copies the pattern the gate would sneak into the route.
  t.ok(
    node.body.indexOf("await fetch('/v1/receipts/") !== -1,
    '/node looks up the receipt WITHOUT a credential, which is the deliberate exception to B12'
  )

  // Rule 5: the header's cost is the estimated CEILING -- with SSE the
  // headers go out before the first token --, and the chat already said it
  // correctly with "up to USD ..." / "no charge". What changes is that now
  // that rule lives in ONE single place, with the new views: two
  // implementations of the same rule is how one of the two drifts without anyone noticing.
  t.ok(
    chat.body.indexOf('textoDeCostoEstimado(m.cost)') !== -1,
    'the turn\'s cost uses the same rule as the new views'
  )

  // The grep's nine terms, now in the served HTML.
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
    t.ok(chat.body.indexOf(term) !== -1, 'the chat mentions ' + term)
    t.ok(node.body.indexOf(term) !== -1, '/node mentions ' + term)
  }
  t.ok(node.body.indexOf('receipts') !== -1, '/node mentions receipts')
})

test('D30.4: the facilitator\'s errors survive the OFFICIAL CLIENT, not just a curl', async (t) => {
  // WHY THIS TEST EXISTS, AND WHY IT CHECKS WITH ANOTHER CLIENT.
  //
  // The test above checks the raw JSON with `pedirle`, which is a
  // hand-written client. That's enough to see there's a body, and NOT
  // enough to see whether that body works: `@x402/core` parses every 200
  // response against a zod schema, and things that look perfect in the raw
  // response get lost there.
  //
  // It genuinely happened, on both routes and in two different ways:
  //
  //   /verify  the body carried `errorReason`/`errorMessage` -- SETTLE's
  //            names --, zod DROPS them without complaining, and the
  //            gateway received a bare `{isValid:false}`. The reason
  //            wasn't lost over the network: it was lost in parsing, which
  //            is worse because it makes no noise.
  //   /settle  the body didn't carry `transaction` or `network`, which the
  //            schema requires as a string even when settlement failed.
  //            Zod rejected the WHOLE response and the client threw
  //            `FacilitatorResponseError`, with the real reason nested
  //            inside another exception's text.
  //
  // Both broke the one thing the facilitator's error block exists to
  // support: on the other side there's a gateway that ALREADY served the
  // tokens -- D12 settles AFTERWARD -- and that has to be able to record
  // WHY it didn't get paid. That field ends up in the receipt, in the
  // panel, and is what Phase 10 will read to decide whether a failure gets
  // retried, discarded, or blamed on someone.
  //
  // That's why the test uses `HTTPFacilitatorClient`: it's THE SAME client
  // `x402.liquidar()` uses in production. A test that validates against a
  // client other than the one that actually runs is exactly the hole that let this through.
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

    // A payment from THE CORRECT NETWORK -- so it passes the network guard
    // and gets in -- but incomplete, which is what makes the facilitator
    // blow up and hits the error path. No need to touch the chain to trigger it.
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
    t.absent(v.isValid, 'it does not treat as valid what it could not process')
    t.is(v.invalidReason, 'facilitator_error', 'and the REASON reaches the client')
    t.ok(v.invalidMessage, 'with the detail inside: ' + v.invalidMessage)

    // This is the one that used to throw. Caught on purpose instead of
    // letting it break the run: a throw here reads as "the test is broken"
    // when what's actually happening is that the facilitator answered with
    // something the client can't read.
    let s = null
    let tiro = null
    try {
      s = await cliente.settle(pago, requisitos)
    } catch (err) {
      tiro = err
    }
    t.absent(
      tiro,
      'settle cannot throw: the client has to be able to READ the failure. ' +
        ((tiro && tiro.name + ': ' + tiro.message.slice(0, 160)) || '')
    )
    t.absent(s && s.success, 'it does not say it got paid')
    t.is(s && s.errorReason, 'facilitator_error', 'and the reason arrives')
    t.ok(s && s.errorMessage, 'with the detail: ' + (s && s.errorMessage))
    // The two fields the schema requires even when there is no
    // transaction. Without them EVERYTHING above gets discarded.
    t.is(typeof (s && s.transaction), 'string', 'transaction present even if empty')
    t.is(s && s.network, 'eip155:9746', 'and the PAYMENT\'s network, which is what\'s useful for debugging')
  } finally {
    f.matar()
  }
})

test('closes the fake facilitator', async (t) => {
  if (servidorFacilitator) servidorFacilitator.close()
  t.pass('shut down')
})

test('closes the test external provider', async (t) => {
  if (servidorExterno) servidorExterno.close()
  t.pass('shut down')
})

test('closes the gateway without leaving the port taken', async (t) => {
  const { shutdownGateway } = await import('../qvac/gateway.mjs')
  await shutdownGateway()
  if (server) server.close()
  t.pass('orderly shutdown')
})

// ---------------------------------------------------------------------------
// D30.4 / D14(b) — THE SELF-HOSTED FACILITATOR
//
// D14 had chosen Semantic's hosted one "until Phase 10". D30 moved it up
// because of two facts: the hosted one was returning 500/503 on ALL its
// endpoints on 2026-08-27, and it doesn't support 9746 -- nor will it ever
// know a token we deployed ourselves. Without a facilitator there is no
// settlement, so without this Phase 10 can be written but not demonstrated.
//
// THIS DOES NOT REACH THE INTERNET, and not by luck: the three endpoints
// under test (`/supported`, and the two rejections) get answered WITHOUT
// touching the chain. The RPC it's given points at a port where there's
// nothing, on purpose -- if any of these responses needed the network, the
// test would hang and that would be the signal.
//
// It runs in a separate NODE process because the facilitator is Node, not
// Bare. That's also part of what's being tested: that it's a separate
// service is exactly why it doesn't violate D11 (see the header of
// scripts/facilitator.js).
// ---------------------------------------------------------------------------

// 8894 and 8895. NOT 8897: that's the FAKE facilitator's from above, and
// even though it's already closed by then, relying on test order so two
// servers don't collide is an intermittent failure waiting for someone to
// reorder them.
let PUERTO_FACILITATOR_REAL = 8894

// A well-known public test key (anvil's #2). NEVER funded, and here it
// doesn't even sign anything: it's only needed so the signer has an
// address to put in `/supported`.
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
    // It waits for it to SAY it's listening instead of sleeping a fixed
    // while: a sleep that's enough on this machine isn't enough on the one
    // next to it, and the test becomes flaky instead of failing outright.
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

test('D30.4: the self-hosted facilitator comes up and declares 9746, which no hosted one knows', async (t) => {
  const base = 'http://127.0.0.1:' + PUERTO_FACILITATOR_REAL
  const f = correrFacilitator({
    PYRUS_FACILITATOR_CLAVE: CLAVE_DE_PRUEBA,
    PYRUS_FACILITATOR_PUERTO: String(PUERTO_FACILITATOR_REAL),
    PYRUS_FACILITATOR_CHAINID: '9746',
    // An RPC that does NOT exist. See the header: if anything under test
    // needed the chain, this exposes it instead of hiding it.
    PYRUS_FACILITATOR_RPC: 'http://127.0.0.1:1/no-existe'
  })

  try {
    t.ok(await f.listo('facilitator  http://'), 'started: ' + f.salida().slice(0, 200))

    const sup = await pedirle(base + '/supported', 'GET')
    t.is(sup.status, 200, 'GET /supported answers 200 -- which the hosted one did NOT')

    const kinds = (sup.json && sup.json.kinds) || []
    t.ok(
      kinds.some((k) => k.network === 'eip155:9746' && k.scheme === 'exact'),
      'and it declares eip155:9746 with an exact scheme: ' + JSON.stringify(kinds)
    )

    // WHAT IT ANNOUNCES HAS TO BE WHAT IT CAN ACTUALLY DELIVER.
    //
    // `registerExactEvmScheme` doesn't register only what it's asked for:
    // internally it calls `registerV1` with its own factory list, which
    // brings `ethereum`, `base` and others. A raw `/supported` would
    // announce MAINNETS this process can't serve -- the signer and the RPC
    // are on 9746 -- and that D30 says don't get touched. Someone reads
    // that, sends a payment, and nobody settles it.
    t.is(
      kinds.filter((k) => k.network !== 'eip155:9746').length,
      0,
      'and NOTHING ELSE: it does not announce a single network it can\'t serve'
    )
    t.absent(
      JSON.stringify(kinds).indexOf('ethereum') !== -1,
      'in particular, no mainnet from the factory list'
    )

    // The node points at it with the SAME variable it uses for the hosted
    // one, so switching from one to the other is configuration, not code (D14 -> D14(b)).
    const x402 = await import('../qvac/x402.mjs')
    t.is(x402.VAR_FACILITATOR, 'PYRUS_X402_FACILITATOR', 'it gets pointed without touching code')

    // A payment from ANOTHER network gets rejected BEFORE looking at the
    // signature, and with a reason. That the reason names both networks is
    // what makes a settlement that never happened debuggable.
    const otraRed = await pedirle(base + '/settle', 'POST', {
      paymentPayload: { x402Version: 2, scheme: 'exact', network: 'eip155:9745', payload: {} },
      paymentRequirements: { network: 'eip155:9745' }
    })
    t.is(otraRed.status, 200)
    t.absent(otraRed.json && otraRed.json.success, 'a mainnet payment does not settle here')
    t.is(otraRed.json && otraRed.json.errorReason, 'unsupported_network')
    t.ok(
      String(otraRed.json.errorMessage).indexOf('eip155:9746') !== -1,
      'and the reason names both networks: ' + otraRed.json.errorMessage
    )

    // And garbage does not throw a bare 500: on the other side there's a
    // gateway that ALREADY served the tokens (D12 settles afterward) and
    // needs to be able to record why it didn't settle. A bodyless 500
    // turns into "settlement_failed" with no reason.
    //
    // The field's name is NOT interchangeable, and this assert used to ask
    // for the wrong one: `/verify` speaks `invalidReason`/`invalidMessage`
    // and `/settle` speaks `errorReason`/`errorMessage`. Asking for
    // `errorMessage` on a verify response passed when looking at the raw
    // JSON and failed where it matters, because `@x402/core`'s schema
    // drops the other route's keys without complaining. That shows up with
    // the official client, not with this -- see the test below.
    const basura = await pedirle(base + '/verify', 'POST', '{no soy json')
    t.is(basura.status, 200, 'it answers structured, not a bare 500')
    t.absent(basura.json && basura.json.isValid, 'and it does not treat as valid what it could not read')
    t.ok(
      basura.json && basura.json.invalidMessage,
      'with the reason inside, in the field verify declares: ' + basura.crudo.slice(0, 120)
    )
  } finally {
    f.matar()
  }
})

test('D30.4: the facilitator does NOT come up against mainnet, and there is no flag to skip it', async (t) => {
  // A facilitator is, literally, the component that moves value: it's the
  // one that broadcasts the transaction. If there's one single place where
  // D30's guard cannot be missing, it's this one.
  const f = correrFacilitator({
    PYRUS_FACILITATOR_CLAVE: CLAVE_DE_PRUEBA,
    PYRUS_FACILITATOR_PUERTO: String(PUERTO_FACILITATOR_REAL + 1),
    // 9745 is D15's default, i.e. the easiest mistake to make.
    PYRUS_FACILITATOR_CHAINID: '9745',
    PYRUS_FACILITATOR_RPC: 'http://127.0.0.1:1/no-existe'
  })

  try {
    const arranco = await f.listo('facilitator  http://', 8000)
    t.absent(arranco, 'it does not come up against 9745')
    t.ok(f.salida().indexOf('MAINNET') !== -1, 'and it says why: ' + f.salida().slice(0, 220))
    t.ok(
      f.salida().indexOf('D30') !== -1,
      'naming the decision, so it can be discussed instead of patched around'
    )
  } finally {
    f.matar()
  }
})

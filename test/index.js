// Tests de QVAC-Node. Corren con `npm test` (brittle sobre bare).
//
// Cubren las dos piezas que no necesitan red ni modelo cargado: la traduccion
// del request de OpenAI (gateway) y la firma del manifiesto (Fase 2-a). Todo
// lo que necesite dos maquinas se verifica con docs/RUNBOOK-2-MAQUINAS.md, no
// desde aca.

const test = require('brittle')

// ---------------------------------------------------------------------------
// Gateway: forma del request de OpenAI
// ---------------------------------------------------------------------------

test('normalizeRequest acepta la forma de OpenAI', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const norm = normalizeRequest({
    model: 'llama1b',
    messages: [
      { role: 'system', content: 'sos conciso' },
      { role: 'user', content: 'hola' }
    ],
    stream: true
  })

  t.absent(norm.error, 'un request valido de OpenAI no da error')
  t.is(norm.model, 'llama1b')
  t.is(norm.stream, true)
  t.alike(
    norm.messages,
    [
      { role: 'system', content: 'sos conciso' },
      { role: 'user', content: 'hola' }
    ],
    'los messages pasan intactos: son el history que recibe el motor'
  )
})

test('normalizeRequest aplana content como array de partes de texto', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Hay clientes que mandan siempre el array de partes, aunque solo lleven
  // texto. Cortar con error ahi los dejaria afuera sin motivo.
  const norm = normalizeRequest({
    model: 'llama1b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hola ' },
          { type: 'text', text: 'mundo' }
        ]
      }
    ]
  })

  t.absent(norm.error)
  t.is(norm.messages[0].content, 'hola mundo')
})

test('normalizeRequest: stream default es false, como en OpenAI', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Sin este caso el gateway defaulteaba a stream:true: un cliente que omite
  // el campo -lo que hace cualquier ejemplo de la doc de OpenAI- recibia SSE
  // donde esperaba un json unico, y su parser fallaba sin explicacion.
  const omitido = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(omitido.stream, false, 'sin el campo stream, no se streamea')

  const explicito = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    stream: false
  })
  t.is(explicito.stream, false, 'stream:false se respeta')

  const streaming = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  })
  t.is(streaming.stream, true, 'stream:true se respeta')
})

test('normalizeRequest acepta la forma corta propia', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const norm = normalizeRequest({ modelId: 'facturas-ar', prompt: 'leeme esta factura' })

  t.absent(norm.error)
  t.is(norm.model, 'facturas-ar')
  t.alike(norm.messages, [{ role: 'user', content: 'leeme esta factura' }])
})

// Casos negativos: cada uno tiene que dar un mensaje que diga QUE falta, no un
// 500 ni un cuelgue. Es lo que separa "el cliente esta mal configurado" de
// "el gateway se rompio".
test('normalizeRequest rechaza requests invalidos con un motivo', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  t.ok(normalizeRequest({}).error, 'un body vacio no pasa')
  t.ok(normalizeRequest({ messages: [] }).error, 'sin model no pasa')
  t.ok(normalizeRequest({ model: 'llama1b' }).error, 'sin messages no pasa')
  t.ok(normalizeRequest({ model: 'llama1b', messages: [] }).error, 'messages vacio no pasa')
  t.ok(
    normalizeRequest({ model: 'llama1b', messages: [{ content: 'hola' }] }).error,
    'un mensaje sin role no pasa'
  )
  t.ok(
    normalizeRequest({ model: 'llama1b', messages: [{ role: 'user', content: 42 }] }).error,
    'content que no es texto no pasa'
  )
  t.ok(normalizeRequest({ modelId: 'facturas-ar' }).error, 'la forma corta sin prompt no pasa')
  t.ok(
    normalizeRequest({ modelId: 'facturas-ar', prompt: '   ' }).error,
    'un prompt en blanco no pasa'
  )
})

// ---------------------------------------------------------------------------
// Manifiesto firmado (Fase 2-a)
// ---------------------------------------------------------------------------

const MODELS = [{ modelId: 'llama1b', displayName: 'Llama 3.2 1B', maxConcurrentRequests: 3 }]

async function manifestMod() {
  return import('../qvac/manifest.mjs')
}

test('JCS ordena las claves y no depende del orden de armado', async (t) => {
  const { canonicalize } = await manifestMod()

  // Es LA propiedad de la que depende toda la firma: dos objetos con el mismo
  // contenido armado en distinto orden tienen que dar los mismos bytes.
  const a = { b: 1, a: 2, c: { z: 3, y: 4 } }
  const b = { c: { y: 4, z: 3 }, a: 2, b: 1 }
  t.is(canonicalize(a), canonicalize(b), 'mismo contenido, mismos bytes')
  t.is(canonicalize(a), '{"a":2,"b":1,"c":{"y":4,"z":3}}', 'claves ordenadas, sin espacios')

  t.is(canonicalize([3, 'a', null, true]), '[3,"a",null,true]')
  t.is(canonicalize({ a: undefined, b: 1 }), '{"b":1}', 'undefined no existe en JSON')

  // JSON.stringify convierte NaN en null en silencio: un precio NaN se
  // firmaria como null y verificaria perfecto.
  t.exception(() => canonicalize({ precio: NaN }), /no finito/, 'NaN corta, no pasa como null')
  t.exception(() => canonicalize({ x: Infinity }), /no finito/)
})

test('un manifiesto firmado verifica contra su propia clave', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const id = createIdentity()
  const manifest = buildManifest({ publicKey: id.publicKey, models: MODELS, operator: 'Nodo A' })

  t.absent(manifest.signature, 'buildManifest no firma: eso es tarea de signManifest')

  const signed = signManifest(manifest, id.secretKey)
  t.ok(signed.signature, 'signManifest agrega la firma')

  const res = verifyManifest(signed, { expectedPublicKey: id.publicKey })
  t.ok(res.ok, 'verifica contra la clave de la conexion')
  t.is(res.reason, null)
  t.absent(res.expired, 'recien emitido, no vencido')
})

// Los casos negativos son el punto de esta pieza. Un verificador que solo se
// probo con manifiestos validos no prueba nada: lo que importa es que RECHACE.
test('un manifiesto manipulado no verifica', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const id = createIdentity()
  const signed = signManifest(
    buildManifest({ publicKey: id.publicKey, models: MODELS }),
    id.secretKey
  )

  // Cambiar el precio despues de firmar es el ataque obvio del marketplace.
  const conPrecioCambiado = JSON.parse(JSON.stringify(signed))
  conPrecioCambiado.models[0].pricing = [{ unit: 'per_request', amount: '1', currency: 'QVAC' }]
  t.absent(verifyManifest(conPrecioCambiado).ok, 'tocar el precio invalida la firma')

  const conModeloAgregado = JSON.parse(JSON.stringify(signed))
  conModeloAgregado.models.push({ modelId: 'gpt-4o-gratis' })
  t.absent(verifyManifest(conModeloAgregado).ok, 'agregar un modelo invalida la firma')

  const conOperadorCambiado = JSON.parse(JSON.stringify(signed))
  conOperadorCambiado.metadata.operator = 'Otro'
  t.absent(verifyManifest(conOperadorCambiado).ok, 'tocar el operador invalida la firma')

  const sinFirma = { ...signed, signature: undefined }
  t.absent(verifyManifest(sinFirma).ok, 'sin firma no pasa')

  const firmaBasura = { ...signed, signature: 'ff'.repeat(64) }
  t.absent(verifyManifest(firmaBasura).ok, 'una firma inventada no pasa')

  t.absent(verifyManifest(null).ok, 'null no pasa')
  t.absent(verifyManifest({}).ok, 'un objeto vacio no pasa')

  // Cada rechazo tiene que explicar POR QUE: en el swarm esto se loguea, y
  // "false" no se puede debuggear a las 3 de la manana.
  t.ok(verifyManifest(conPrecioCambiado).reason, 'el rechazo trae motivo')
})

test('la firma sola no prueba identidad: hay que atarla a la clave de la conexion', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const victima = createIdentity()
  const atacante = createIdentity()

  // El atacante arma un manifiesto con SU clave y lo firma bien. La firma es
  // valida -- prueba que el tiene su propia privada, nada mas.
  const suyo = signManifest(
    buildManifest({ publicKey: atacante.publicKey, models: MODELS, operator: 'Nodo trucho' }),
    atacante.secretKey
  )
  t.ok(verifyManifest(suyo).ok, 'firma valida: sin expectedPublicKey esto pasa')

  // Atado a la clave real del peer, se cae. Es la unica razon por la que el
  // parametro existe.
  const res = verifyManifest(suyo, { expectedPublicKey: victima.publicKey })
  t.absent(res.ok, 'no puede hacerse pasar por otro nodo')
  t.ok(/pero la conexion es de/.test(res.reason), 'el motivo dice que las claves no coinciden')

  // Y firmar con la clave de otro tampoco: no tiene la privada de la victima.
  const robado = signManifest(
    buildManifest({ publicKey: victima.publicKey, models: MODELS }),
    atacante.secretKey
  )
  t.absent(verifyManifest(robado).ok, 'no puede firmar por una clave que no tiene')
})

test('buildManifest rechaza entradas invalidas y marca los mocks', async (t) => {
  const { createIdentity, buildManifest } = await manifestMod()
  const id = createIdentity()

  t.exception(() => buildManifest({ publicKey: 'abc', models: MODELS }), /32 bytes/)
  t.exception(() => buildManifest({ publicKey: id.publicKey, models: [] }), /al menos un modelo/)
  t.exception(
    () => buildManifest({ publicKey: id.publicKey, models: [{ displayName: 'sin id' }] }),
    /modelId/
  )

  // D2 exige que el mock quede marcado donde se pueda VER. Si alguien lo
  // "limpia" en un refactor de ultimo momento, este test lo caza.
  const m = buildManifest({ publicKey: id.publicKey, models: MODELS })
  t.ok(m.economic._mock, 'economic esta marcado como mock')
  t.ok(m.directory._mock, 'directory esta marcado como mock')
  t.is(m.node.endpoint.openaiCompatible, false, 'D1: no hay baseUrl P2P al que apuntar')
})

// ---------------------------------------------------------------------------
// Manifiesto: el directorio deja de ser mock cuando hay un Hyperbee detras
// ---------------------------------------------------------------------------

test('buildManifest firma el directorio real cuando se le pasa uno', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()
  const id = createIdentity()

  const directory = {
    writerPublicKey: 'ab'.repeat(32),
    discoveryKey: 'cd'.repeat(32),
    sequence: 7
  }

  const m = signManifest(
    buildManifest({ publicKey: id.publicKey, models: MODELS, directory }),
    id.secretKey
  )

  t.absent(m.directory._mock, 'sin la marca de mock: el directorio es real')
  t.is(m.directory.writerPublicKey, directory.writerPublicKey)
  t.is(m.directory.sequence, 7)
  t.ok(verifyManifest(m, { expectedPublicKey: id.publicKey }).ok, 'la firma cubre el directorio')

  // Un descriptor mal armado tiene que morir ANTES de firmarse: un manifiesto
  // firmado con una clave que no existe manda al par a replicar la nada, y el
  // error aparece a tres saltos de donde se origino.
  t.exception(
    () =>
      buildManifest({
        publicKey: id.publicKey,
        models: MODELS,
        directory: { ...directory, writerPublicKey: 'nope' }
      }),
    /hex de 32 bytes/
  )
  t.exception(
    () =>
      buildManifest({
        publicKey: id.publicKey,
        models: MODELS,
        directory: { ...directory, sequence: -1 }
      }),
    /entero/
  )
})

test('cambiar el directorio firmado invalida la firma', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()
  const id = createIdentity()

  const m = signManifest(
    buildManifest({
      publicKey: id.publicKey,
      models: MODELS,
      directory: { writerPublicKey: 'ab'.repeat(32), discoveryKey: 'cd'.repeat(32), sequence: 1 }
    }),
    id.secretKey
  )

  // Apuntar el directorio de otro nodo a un Hyperbee propio seria poder
  // reescribirle el marketplace entero a quien confie en ese manifiesto.
  const alterado = { ...m, directory: { ...m.directory, writerPublicKey: 'ff'.repeat(32) } }
  t.absent(verifyManifest(alterado, { expectedPublicKey: id.publicKey }).ok)
})

// ---------------------------------------------------------------------------
// Links de archivos (qvac://)
// ---------------------------------------------------------------------------

test('los links qvac:// van y vuelven sin perder nada', async (t) => {
  const { formatLink, parseLink, drivePath } = await import('../qvac/files.mjs')
  const clave = '3f'.repeat(32)

  const link = formatLink(clave, '/planos/casa.pdf')
  t.is(link, 'qvac://' + clave + '/planos/casa.pdf')

  const vuelta = parseLink(link)
  t.is(vuelta.keyHex, clave)
  t.is(vuelta.path, '/planos/casa.pdf')

  // Sin ruta se asume la raiz: sirve para listar el drive entero.
  t.is(parseLink('qvac://' + clave).path, '/')

  t.exception(() => parseLink('http://ejemplo.com/x.pdf'), /empieza con qvac/)
  t.exception(() => parseLink('qvac://cortito/x.pdf'), /hex de 32 bytes/)

  // En Windows path.join mete backslashes. Sin normalizar, el archivo se sube
  // con backslashes en el nombre y del otro lado no lo encuentra nadie.
  t.is(drivePath('planos\\casa.pdf'), '/planos/casa.pdf')
  t.is(drivePath('//planos//casa.pdf'), '/planos/casa.pdf')
})

// ---------------------------------------------------------------------------
// Directorio Hyperbee + la barrera que lo separa del ruteo
// ---------------------------------------------------------------------------

async function directorioTemporal() {
  const Corestore = require('corestore')
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  const { Directory } = await import('../qvac/directory.mjs')

  // No se usa mkdtempSync: en Windows bare-fs devuelve una ruta extendida
  // y RocksDB le concatena "db/LOG" con barra normal, que despues de ese
  // prefijo es ilegal. El codigo real no pasa por mkdtemp. Ver NOTES.md.
  const dir = path.join(
    os.tmpdir(),
    'qvac-test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  )
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  await store.ready()
  const directory = new Directory(store)
  await directory.ready()

  return {
    directory,
    async close() {
      await directory.close()
      await store.close()
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}

function manifiestoDe(operator, modelIds) {
  return {
    models: modelIds.map((id) => ({
      modelId: id,
      displayName: id,
      qos: { maxConcurrentRequests: 2 }
    })),
    metadata: { operator, tags: ['general'] }
  }
}

test('el directorio guarda pares y los indexa por modelo', async (t) => {
  const { directory, close } = await directorioTemporal()
  const A = 'aa'.repeat(32)
  const B = 'bb'.repeat(32)

  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['facturas-ar', 'llama1b']))
  await directory.recordManifest(B, manifiestoDe('ArqNode', ['llama1b']))
  await directory.flush()

  const pares = await directory.knownPeers()
  t.is(pares.length, 2, 'los dos pares quedaron guardados')

  // El indice secundario por modelo es lo que evita recorrer todos los pares
  // para contestar "quien sirve llama1b".
  const proveedores = await directory.providersOf('llama1b')
  t.is(proveedores.length, 2)
  t.alike(proveedores.map((p) => p.operator).sort(), ['ArqNode', 'FiscalNode'])
  t.is((await directory.providersOf('facturas-ar')).length, 1)

  // Reanunciar con MENOS modelos no puede dejar fantasmas del anuncio anterior.
  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['facturas-ar']))
  await directory.flush()
  const soloB = await directory.providersOf('llama1b')
  t.is(soloB.length, 1, 'el modelo que el par dejo de servir no sigue indexado')
  t.is(soloB[0].operator, 'ArqNode')

  await close()
})

test('el directorio acumula estadisticas y log podable', async (t) => {
  const { directory, close } = await directorioTemporal()
  const A = 'aa'.repeat(32)

  await directory.recordStat(A, { ok: true, ms: 120, tokens: 50 })
  await directory.recordStat(A, { ok: false, ms: 900, tokens: 0 })
  await directory.flush()

  const s = await directory.stats(A)
  t.is(s.requests, 2)
  t.is(s.errors, 1, 'los errores se cuentan aparte: es la base de la reputacion')
  t.is(s.tokens, 50)

  const ahora = Date.now()
  await directory.pushLog({ que: 'viejo' }, { now: ahora - 30 * 24 * 60 * 60 * 1000 })
  await directory.pushLog({ que: 'nuevo' }, { now: ahora })
  await directory.flush()

  const log = await directory.recentLog(10)
  t.is(log.length, 2)
  t.is(log[0].que, 'nuevo', 'el log sale del mas nuevo al mas viejo')

  const podadas = await directory.pruneLog({ now: ahora })
  t.is(podadas, 1, 'la entrada de hace 30 dias se poda')
  t.is((await directory.recentLog(10)).length, 1)

  await close()
})

test('un par del directorio NO puede volverse candidato de ruteo', async (t) => {
  const { directory, close } = await directorioTemporal()
  const store = await import('../qvac/store.mjs')
  const A = 'aa'.repeat(32)

  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['llama1b']))
  await directory.flush()

  store.attachDirectory(directory)
  const n = await store.hydrateFromDirectory()
  t.is(n, 1, 'el par del bee entra a la grilla')

  const filas = store.listNodes().filter((f) => f.modelId === 'llama1b')
  t.is(filas.length, 1)
  t.is(filas[0].kind, 'known', 'entra como conocido, no como par conectado')
  t.is(filas[0].status, 'offline')

  // LA invariante: un manifiesto replicado prueba que alguien dijo algo, no
  // que ese alguien este vivo. D3 no puede tener excepciones ni por accidente.
  t.is(store.findAllByModelId('llama1b').length, 0, 'no es candidato de ruteo')

  // Cuando se conecta de verdad SI lo es.
  store.upsertFromManifest(A, manifiestoDe('FiscalNode', ['llama1b']))
  t.is(store.findAllByModelId('llama1b').length, 1, 'con socket vivo pasa a candidato')

  // Y al caerse la conexion vuelve a ser conocido: deja de rutear en el acto,
  // pero no desaparece del panel.
  store.removeByPeer(A)
  t.is(store.findAllByModelId('llama1b').length, 0, 'deja de ser candidato al instante')
  t.is(store.listNodes().filter((f) => f.modelId === 'llama1b')[0].status, 'offline')

  store.attachDirectory(null)
  await close()
})

// ---------------------------------------------------------------------------
// Fase 6.5 — costos (qvac/costs.mjs)
// ---------------------------------------------------------------------------

test('estimar acota por arriba y real cobra lo generado', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // El turno tipico del ROADMAP: 2000 de entrada, 500 de salida, Sonnet 5 a
  // precio estandar. 2000 * 3 + 500 * 15 = 6000 + 7500 = 13500 micros.
  const usado = costs.real({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    completionTokens: 500
  })
  t.is(usado, 13500, 'USD 0,0135 por turno, el numero que calibra el tope')

  // La estimacion asume que se generan TODOS los maxTokens. Tiene que ser
  // mayor o igual al costo real del mismo request: si no, la reserva se queda
  // corta y el tope se pasa.
  const estimado = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 4096
  })
  t.ok(estimado >= usado, 'la estimacion nunca queda por debajo del costo real')
  t.is(estimado, 6000 + Math.ceil((4096 * 15_000_000) / 1_000_000))
})

test('lo que no esta en la tabla de precios sale cero', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // La inferencia local y la de un par de la red no cuestan dolares. Este
  // camino existe para que el contador tenga UNA sola entrada para todos los
  // targets, en vez de un `if` en el gateway.
  t.is(costs.real({ model: 'llama1b', promptTokens: 9999, completionTokens: 9999 }), 0)
  t.absent(costs.conocido('llama1b'))
  t.ok(costs.conocido('claude-sonnet-5'))
})

test('los montos son enteros y redondean hacia arriba', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // Un token de entrada de Sonnet 5 sale 3 micros exactos; uno de Haiku, 1.
  // Lo que importa del caso chico es que NO devuelva 0: truncar hacia abajo
  // acumula gasto que el contador no ve.
  const unToken = costs.real({ model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 0 })
  t.is(unToken, 1, 'un token no puede costar cero')
  t.ok(Number.isInteger(unToken), 'los montos son enteros, nunca floats')

  // usdAMicros redondea al reves -- hacia abajo -- porque un tope nunca se
  // agranda por un redondeo.
  t.is(costs.usdAMicros(20), 20_000_000)
  t.is(costs.usdAMicros(0.1), 100_000)
  t.is(costs.usdAMicros(-5), 0, 'un tope negativo es cero, no una deuda')
})

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

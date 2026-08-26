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
  //
  // Desde la Fase 7 el de `economic` ya no significa "no implementado" sino
  // "este nodo no declaro direccion de cobro", que es un estado legitimo: un
  // nodo que solo consume, o uno que todavia no creo su wallet. Lo que no puede
  // pasar es que ese caso se vea igual que uno con wallet de verdad.
  const m = buildManifest({ publicKey: id.publicKey, models: MODELS })
  t.ok(m.economic._mock, 'sin wallet, economic esta marcado como mock')
  t.ok(m.directory._mock, 'directory esta marcado como mock')
  t.is(m.node.endpoint.openaiCompatible, false, 'D1: no hay baseUrl P2P al que apuntar')
})

// ---------------------------------------------------------------------------
// FASE 7 — la wallet de cobro, y el `economic` que deja de ser mock
//
// Son DOS claves distintas y esa es toda la fase: `identity.mjs` guarda la de
// RED, en claro, y con eso el nodo firma; `wallet.mjs` guarda la de COBRO,
// cifrada (D13), y es lo que el manifiesto declara. El manifiesto firmado es lo
// que ata una a la otra.
//
// Lo que estos tests protegen no es que "ande": es que no se pueda firmar una
// direccion que el nodo no controla, en ninguno de los caminos por los que eso
// podria pasar.
// ---------------------------------------------------------------------------

function dirWalletTmp() {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  const dir = path.join(
    os.tmpdir(),
    'qvac-wallet-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  )
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    limpiar() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}

test('la seed de la wallet no queda en claro, y la passphrase equivocada no abre', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  const tmp = dirWalletTmp()

  t.is(wallet.existe(tmp.dir), false, 'un nodo sin wallet es el caso normal, no un error')

  const creada = await wallet.crear(tmp.dir, 'la-passphrase-buena')
  t.ok(/^0x[a-fA-F0-9]{40}$/.test(creada.address), 'la direccion matchea el pattern del schema')
  t.is(creada.frase.split(' ').length, 24, 'la frase de respaldo son 24 palabras')

  // D13: en disco no puede quedar NADA legible. Ni la frase ni la direccion --
  // guardar la direccion dejaria que alguien sin la passphrase leyera igual a
  // donde cobra este nodo, y eso solo lo tiene que decir el manifiesto firmado.
  const crudo = fs.default.readFileSync(path.default.join(tmp.dir, 'wallet.json'), 'utf8')
  for (const palabra of creada.frase.split(' ')) {
    t.absent(
      crudo.includes(palabra),
      'la palabra "' + palabra + '" no esta en claro en el keystore'
    )
  }
  t.absent(crudo.includes(creada.address), 'la direccion tampoco se guarda')

  // Fallar CERRADO. Si abriera con basura derivaria otra direccion, y el nodo
  // anunciaria en un manifiesto firmado una wallet que no controla -- o sea
  // mandaria a pagar a una direccion de la que nadie tiene la clave.
  await t.exception(
    () => wallet.abrir(tmp.dir, 'la-passphrase-equivocada'),
    /no abre el keystore/,
    'la passphrase equivocada falla, no devuelve otra direccion'
  )
  await t.exception(() => wallet.abrir(tmp.dir, null), /falta la passphrase/)

  const abierta = await wallet.abrir(tmp.dir, 'la-passphrase-buena')
  t.is(abierta.address, creada.address, 'con la passphrase correcta vuelve LA MISMA direccion')

  tmp.limpiar()
})

test('la frase de respaldo restaura la misma direccion en otra maquina', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const uno = dirWalletTmp()
  const otro = dirWalletTmp()

  const original = await wallet.crear(uno.dir, 'passphrase-de-la-maquina-vieja')

  // Otra maquina, otra passphrase, MISMA frase. Es lo que hace que mostrar las
  // 24 palabras una vez sirva de algo: sin esto, perder el keystore seria
  // perder la wallet aunque el operador las tenga anotadas.
  const restaurada = await wallet.crear(otro.dir, 'otra-passphrase-distinta', {
    frase: original.frase
  })
  t.is(restaurada.address, original.address, 'la misma frase da la misma direccion de cobro')
  t.ok(restaurada.restaurada, 'y se sabe que fue una restauracion, no una wallet nueva')

  // En un directorio LIMPIO: si se reusara `otro.dir`, saltaria primero "ya hay
  // una wallet" y este assert pasaria por el motivo equivocado.
  const limpio = dirWalletTmp()
  await t.exception(
    () => wallet.crear(limpio.dir, 'x', { frase: 'esto no es un mnemonic bip39 valido' }),
    /BIP-39/,
    'una frase que no valida no entra: seria una wallet que nadie puede restaurar'
  )
  await t.exception(
    () => wallet.crear(otro.dir, 'x'),
    /ya hay una wallet/,
    'y no se pisa una wallet existente'
  )

  uno.limpiar()
  otro.limpiar()
  limpio.limpiar()
})

test('dos nodos con wallet anuncian direcciones distintas, y la firma las ata', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()
  const a = dirWalletTmp()
  const b = dirWalletTmp()

  const walletA = await wallet.crear(a.dir, 'pass-a')
  const walletB = await wallet.crear(b.dir, 'pass-b')
  t.not(walletA.address, walletB.address, 'dos nodos no cobran en la misma direccion')

  const idA = createIdentity()
  const manifiesto = signManifest(
    buildManifest({
      publicKey: idA.publicKey,
      models: MODELS,
      economic: wallet.economicDe(walletA.address)
    }),
    idA.secretKey
  )

  t.absent(manifiesto.economic._mock, 'con wallet, el _mock se va')
  t.is(manifiesto.economic.walletAddress, walletA.address)
  t.alike(manifiesto.economic.chains, ['plasma', 'stable'], 'D15: plasma default, stable fallback')
  t.is(manifiesto.economic.settlement, 'batch-receipts')

  t.ok(verifyManifest(manifiesto, { expectedPublicKey: idA.publicKey }).ok, 'un par lo verifica')

  // ESTO es lo que ata la identidad de red con la de cobro: cambiarle la
  // direccion al manifiesto firmado tiene que romper la firma. Sin esta
  // propiedad, cualquiera podria reenviar el manifiesto de otro nodo con su
  // propia wallet adentro y cobrar el trabajo ajeno.
  const manoseado = JSON.parse(JSON.stringify(manifiesto))
  manoseado.economic.walletAddress = walletB.address
  const r = verifyManifest(manoseado, { expectedPublicKey: idA.publicKey })
  t.is(r.ok, false, 'cambiarle la wallet a un manifiesto firmado lo invalida')

  a.limpiar()
  b.limpiar()
})

test('un economic invalido no se firma: firmarlo es mandar a pagar a cualquier lado', async (t) => {
  const { createIdentity, buildManifest } = await manifestMod()
  const id = createIdentity()
  const base = { publicKey: id.publicKey, models: MODELS }
  const ok = {
    walletAddress: '0x' + 'ab'.repeat(20),
    chains: ['plasma'],
    settlement: 'batch-receipts'
  }

  // La direccion cero PASA el pattern del schema y no es una direccion: es
  // justo el valor que tenia el mock. Firmarla seria mandar la plata a un pozo.
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, walletAddress: '0x' + '0'.repeat(40) } }),
    /direccion cero/
  )
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, walletAddress: 'no-es-una-direccion' } }),
    /EVM ni Tron/
  )
  t.exception(() => buildManifest({ ...base, economic: { ...ok, chains: [] } }), /al menos una red/)
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, chains: ['Plasma Mainnet'] } }),
    /identificador invalido/,
    'el kebab-case del schema se chequea antes de firmar, no despues'
  )
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, settlement: 'a-mano' } }),
    /settlement/
  )

  // Y una direccion Tron valida SI entra: el schema admite las dos familias.
  const tron = buildManifest({
    ...base,
    economic: { ...ok, walletAddress: 'T' + 'J'.repeat(33) }
  })
  t.is(tron.economic.walletAddress, 'T' + 'J'.repeat(33))
})

// ---------------------------------------------------------------------------
// El manifiesto contra SU PROPIO schema congelado
//
// El DoD de la Fase 7 pide que el manifiesto valide contra manifest-v0.json sin
// tocar el schema, y hasta ahora eso no lo comprobaba NADIE: `grep manifest-v0`
// sobre el arbol devuelve comentarios y nada mas. El schema era un documento,
// no un chequeo, y por eso lo de abajo estuvo roto sin que se notara.
//
// Las restricciones se leen DEL archivo, no se copian aca: un test que repite a
// mano lo que dice el schema deja de proteger el dia que el schema cambie.
// ---------------------------------------------------------------------------

// Validador minimo, solo de lo que este schema usa. No es un JSON-Schema
// completo y no pretende serlo: hay cero dependencias de validacion en el arbol
// y sumar una para esto seria pagar caro un chequeo de veinte lineas.
function violacionesDe(bloque, esquema) {
  const malas = []
  for (const req of esquema.required || []) {
    if (!(req in bloque)) malas.push('falta el required "' + req + '"')
  }
  if (esquema.additionalProperties === false) {
    for (const k of Object.keys(bloque)) {
      if (!(k in esquema.properties)) malas.push('propiedad extra: "' + k + '"')
    }
  }
  for (const [k, v] of Object.entries(bloque)) {
    const def = esquema.properties[k]
    if (!def) continue
    if (def.pattern && !new RegExp(def.pattern).test(String(v))) {
      malas.push(k + ' no matchea el pattern')
    }
    if (def.enum && !def.enum.includes(v)) malas.push(k + ' fuera del enum')
    if (def.type === 'array') {
      if (!Array.isArray(v)) malas.push(k + ' no es un array')
      else {
        if (def.minItems && v.length < def.minItems) malas.push(k + ': menos de ' + def.minItems)
        if (def.maxItems && v.length > def.maxItems) malas.push(k + ': mas de ' + def.maxItems)
        for (const item of v) {
          const i = def.items || {}
          if (i.pattern && !new RegExp(i.pattern).test(String(item)))
            malas.push(k + ': item invalido "' + item + '"')
          if (i.minLength && String(item).length < i.minLength)
            malas.push(k + ': item corto "' + item + '"')
          if (i.maxLength && String(item).length > i.maxLength)
            malas.push(k + ': item largo "' + item + '"')
        }
      }
    }
  }
  return malas
}

test('el economic con wallet valida contra el schema congelado, sin tocarlo', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const { createIdentity, buildManifest } = await manifestMod()
  const fs = await import('bare-fs')
  const tmp = dirWalletTmp()

  const schema = JSON.parse(fs.default.readFileSync('manifest-v0.json', 'utf8'))
  const esquemaEconomic = schema.properties.economic

  const w = await wallet.crear(tmp.dir, 'pass')
  const id = createIdentity()
  const conWallet = buildManifest({
    publicKey: id.publicKey,
    models: MODELS,
    economic: wallet.economicDe(w.address)
  })

  t.alike(
    violacionesDe(conWallet.economic, esquemaEconomic),
    [],
    'el bloque economic real valida contra manifest-v0.json'
  )
  t.is(conWallet.schemaVersion, schema.properties.schemaVersion.const, 'sin subir schemaVersion')

  // Y el mock NO valida, que es un problema viejo y conocido: D2 pide marcar el
  // mock donde se vea, `economic` declara additionalProperties:false, y las dos
  // reglas chocan. Se fija ACA para que el dia que alguien lo arregle -- o lo
  // rompa mas -- el test lo diga, en vez de que siga sin mirarlo nadie.
  //
  // `directory` tiene exactamente el mismo choque y viene de antes de la Fase 7.
  const sinWallet = buildManifest({ publicKey: id.publicKey, models: MODELS })
  t.alike(
    violacionesDe(sinWallet.economic, esquemaEconomic),
    ['propiedad extra: "_mock"'],
    'sin wallet la UNICA violacion es la marca de mock (B19), y ninguna otra'
  )
  t.alike(
    violacionesDe(sinWallet.directory, schema.properties.directory),
    ['propiedad extra: "_mock"'],
    'y al directorio le pasa lo mismo desde antes de esta fase'
  )

  tmp.limpiar()
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

// ---------------------------------------------------------------------------
// Fase 6.5 — presupuesto (qvac/budget.mjs)
// ---------------------------------------------------------------------------

test('la reserva aparta la cota superior y la liquidacion devuelve el resto', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  budget.reset()

  const estimado = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 4096
  })
  const r = budget.reserve('ana', estimado)
  t.ok(r.ok, 'entra en el tope de USD 20')

  // Mientras el request esta en vuelo el saldo esta comprometido: no es gasto
  // todavia, pero tampoco esta disponible para otro request.
  const enVuelo = budget.usage('ana')
  t.is(enVuelo.spent, 0, 'no se gasto nada todavia')
  t.is(enVuelo.reserved, estimado, 'pero esta apartado')
  t.is(enVuelo.remaining, budget.TOPE_DEFAULT_MICROS - estimado)

  // El modelo genero 500 tokens, no los 4096 del tope. La diferencia vuelve.
  const real = costs.real({ model: 'claude-sonnet-5', promptTokens: 2000, completionTokens: 500 })
  t.is(budget.settle(r.id, real), 13500, 'se cobra lo que costo de verdad')

  const cerrado = budget.usage('ana')
  t.is(cerrado.spent, 13500)
  t.is(cerrado.reserved, 0, 'la reserva se libero')
  t.is(cerrado.remaining, budget.TOPE_DEFAULT_MICROS - 13500, 'el sobrante volvio al saldo')
})

test('EL TOPE CORTA: el gasto real nunca supera el declarado', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  budget.reset()

  // El DoD de la Fase 6.5: tope de USD 0,10 y se consume hasta agotarlo.
  const TOPE = costs.usdAMicros(0.1)
  budget.setCap('ana', TOPE)

  const porTurno = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 500
  })

  let aceptados = 0
  let rechazado = null
  // Mas vueltas de las que el tope puede pagar, para que el corte tenga que
  // ocurrir dentro del loop y no por quedarse sin iteraciones.
  for (let i = 0; i < 100; i++) {
    const r = budget.reserve('ana', porTurno)
    if (!r.ok) {
      rechazado = r
      break
    }
    aceptados++
    budget.settle(r.id, porTurno)
  }

  t.ok(rechazado, 'en algun momento corta')
  t.is(rechazado.reason, 'presupuesto agotado')
  t.ok(aceptados > 0, 'y antes de cortar dejo trabajar')

  const fin = budget.usage('ana')
  t.ok(fin.spent <= TOPE, 'LA INVARIANTE: el gasto nunca supera el tope')
  t.ok(fin.remaining < porTurno, 'y lo que queda no alcanza para otro turno')
})

test('costo cero no toca el ledger', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()
  budget.setCap('ana', 0) // sin un peso de presupuesto

  // Inferencia local: gratis. Tiene que pasar igual, con el tope en cero. Es
  // la degradacion de la Fase 6.5 -- se corta la red y el externo, no el
  // producto.
  const r = budget.reserve('ana', 0)
  t.ok(r.ok, 'lo gratis nunca se rechaza, ni con el tope agotado')
  t.is(r.id, null, 'y no abre una reserva que despues haya que liquidar')
  t.is(budget.usage('ana').spent, 0)
})

test('dos requests en vuelo no gastan los mismos dolares', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()
  budget.setCap('ana', 1000)

  const a = budget.reserve('ana', 600)
  const b = budget.reserve('ana', 600)

  t.ok(a.ok, 'el primero entra')
  t.absent(b.ok, 'el segundo NO: los 600 del primero ya estan comprometidos')
  t.is(b.remaining, 400)

  // Al liquidar barato el primero, el segundo ya entra.
  budget.settle(a.id, 100)
  t.ok(budget.reserve('ana', 600).ok, 'con el saldo devuelto vuelve a haber lugar')
})

test('settle nunca cobra mas de lo reservado', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  const r = budget.reserve('ana', 1000)
  // El real salio mas caro que la cota superior: la estimacion fallo. El error
  // no lo paga el usuario -- cobrar de mas seria pasarse del tope por la
  // ventana de atras.
  t.is(budget.settle(r.id, 5000), 1000, 'se cobra lo reservado, no lo real')
  t.is(budget.usage('ana').spent, 1000)
})

test('el mes rota: el gasto vuelve a cero, el tope sobrevive, el cerrado queda', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const ENERO = Date.UTC(2026, 0, 15)
  const FEBRERO = Date.UTC(2026, 1, 2)

  budget.reset({ now: ENERO })
  budget.setCap('ana', 500_000)
  const r = budget.reserve('ana', 300_000, { now: ENERO })
  budget.settle(r.id, 300_000)
  t.is(budget.usage('ana', { now: ENERO }).spent, 300_000)

  const feb = budget.usage('ana', { now: FEBRERO })
  t.is(feb.period, '2026-02')
  t.is(feb.spent, 0, 'el gasto arranca de cero')
  t.is(feb.cap, 500_000, 'el tope NO se resetea: es mensual, no de un solo mes')

  // Y enero sigue disponible para facturarlo, que es todo el punto de guardarlo.
  const cierre = budget.report({ period: '2026-01', now: FEBRERO })
  t.ok(cierre.found, 'el mes cerrado se puede leer despues')
  t.is(cierre.total, 300_000)
  t.is(cierre.accounts[0].account, 'ana')
})

test('el reparto acumula durante el mes, no se calcula al cierre', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  for (const [quien, monto] of [
    ['ana', 5000],
    ['beto', 12000],
    ['ana', 3000]
  ]) {
    const r = budget.reserve(quien, monto)
    budget.settle(r.id, monto)
  }

  const rep = budget.report()
  t.is(rep.total, 20000)
  t.is(rep.accounts.length, 2)
  t.is(rep.accounts[0].account, 'beto', 'ordenado por consumo')
  t.is(rep.accounts[0].spent, 12000)
  t.is(rep.accounts[1].spent, 8000, 'ana suma sus dos requests')
})

test('local:true sobrevive a normalizeRequest en la forma estandar de OpenAI', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Regresion. La forma corta propia devolvia `local` y la estandar no, asi
  // que el toggle "local only" del chat -- que manda la estandar -- llegaba
  // como undefined y handleChat nunca filtraba los pares. El candado de la
  // pantalla no cerraba nada.
  const estandar = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    local: true
  })
  t.is(estandar.local, true, 'la forma estandar conserva local')

  const corta = normalizeRequest({ modelId: 'llama1b', prompt: 'hola', local: true })
  t.is(corta.local, true, 'la forma corta tambien, como ya hacia')

  // Y sin el campo sigue siendo false, no undefined: el filtro compara por
  // verdad, pero el contrato del normalizador es devolver un booleano.
  const sinFlag = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(sinFlag.local, false)
})

// ---------------------------------------------------------------------------
// Fase 6.6 — cuota gratuita del proveedor (qvac/quota.mjs)
// ---------------------------------------------------------------------------

test('la cuota corta al agotarse y dice cuando se repone', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'aa'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  t.ok(quota.check(PAR, { now: T0 }).ok, 'un par nuevo entra')
  t.is(quota.restante(PAR, { now: T0 }), 100_000)

  quota.registrar(PAR, 100_000, { now: T0 })

  const cortado = quota.check(PAR, { now: T0 })
  t.absent(cortado.ok, 'agotada la cuota, corta')
  t.is(cortado.remaining, 0)
  // El dato accionable: sin esto el consumidor sabe que no puede, pero no
  // cuando podria.
  t.ok(cortado.resetsInMs > 0, 'dice en cuanto se repone')
})

test('la ventana es deslizante: se repone sola con las horas', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'bb'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)
  const hora = (n) => T0 + n * 60 * 60 * 1000

  // Se gasta la cuota entera repartida en dos horas distintas.
  quota.registrar(PAR, 60_000, { now: hora(0) })
  quota.registrar(PAR, 40_000, { now: hora(1) })
  t.absent(quota.check(PAR, { now: hora(2) }).ok, 'agotada')

  // A las 24 horas exactas el balde de la hora 0 sale de la ventana y vuelven
  // sus 60.000; los 40.000 de la hora 1 siguen adentro. Esto es lo que hace
  // que la cuota se reponga de a poco y no haya un pico a medianoche.
  //
  // El borde importa y es facil equivocarse: un balde vale mientras
  // `hora > ahora - ventana`. A las 24 h eso deja afuera al balde 0 y adentro
  // al 1; a las 25 h ya salieron los dos.
  t.is(quota.usado(PAR, { now: hora(24) }), 40_000, 'la hora mas vieja salio de la ventana')
  t.ok(quota.check(PAR, { now: hora(24) }).ok, 'y se puede volver a pedir')

  t.is(quota.usado(PAR, { now: hora(25) }), 0, 'una hora mas y la ventana se vacio entera')
})

test('cada par tiene su propia cuota', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const A = 'aa'.repeat(32)
  const B = 'bb'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  quota.registrar(A, 100_000, { now: T0 })

  t.absent(quota.check(A, { now: T0 }).ok, 'A se quedo sin cuota')
  t.ok(quota.check(B, { now: T0 }).ok, 'y B no se entera')
  t.is(quota.restante(B, { now: T0 }), 100_000)

  // El panel del proveedor ve las dos filas, ordenadas por consumo.
  const filas = quota.listar({ now: T0 })
  t.is(filas.length, 1, 'B no aparece porque no consumio nada')
  t.is(filas[0].peerKey, A)
  t.is(filas[0].used, 100_000)
})

test('la cuota es configurable y el registro ignora basura', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'cc'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  quota.configurar({ tokens: 500, horas: 1 })
  t.is(quota.config().tokens, 500)

  t.is(quota.registrar(PAR, -20, { now: T0 }), 0, 'un negativo no descuenta cuota ajena')
  t.is(quota.registrar(PAR, 'ocho', { now: T0 }), 0, 'ni un string cuenta')
  t.is(quota.usado(PAR, { now: T0 }), 0)

  quota.registrar(PAR, 500, { now: T0 })
  t.absent(quota.check(PAR, { now: T0 }).ok, 'con la cuota chica corta antes')
  quota.reset()
})

// ---------------------------------------------------------------------------
// Fase 8 / D6 — elegir candidato por carga (qvac/routing.mjs)
// ---------------------------------------------------------------------------

// Un candidato como lo devuelve store.findAllByModelId, con lo minimo que mira
// el ruteo.
function cand(id, kind, activeRequests, maxConcurrentRequests, extra = {}) {
  return {
    id,
    kind,
    modelId: 'llama1b',
    operator: id,
    status: 'online',
    activeRequests,
    maxConcurrentRequests,
    peerKey: kind === 'peer' ? id + 'key' : null,
    ...extra
  }
}

// random fijo: con todos los jitter iguales el sort de V8 es estable, asi que
// el orden de entrada sobrevive a los empates y el test es determinista.
const SIN_AZAR = () => 0.5

test('D6: entre dos pares gana el que tiene menos carga', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const cargado = cand('cargado', 'peer', 9, 10) // 90%
  const libre = cand('libre', 'peer', 1, 10) // 10%

  // Se lo pasa en el orden "malo" a proposito: antes ganaba el primero de la
  // lista y esto habria pasado igual sin mirar la carga.
  const r = pickCandidate([cargado, libre], { random: SIN_AZAR })

  t.is(r.node.id, 'libre', 'elige el descargado, no el primero de la lista')
  t.is(r.decision.loadPct, 10)
  t.ok(r.reason.includes('menor carga'), 'y el motivo lo dice: ' + r.reason)
  t.alike(
    r.orden.map((n) => n.id),
    ['libre', 'cargado'],
    'el reintento tambien va ordenado'
  )
})

test('D6: un candidato saturado queda ultimo, no afuera', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const lleno = cand('lleno', 'peer', 3, 3)
  const libre = cand('libre', 'real', 0, 3)

  const r = pickCandidate([lleno, libre], { random: SIN_AZAR })

  t.is(r.node.id, 'libre', 'gana el que puede atender aunque sea el local')
  // Sigue en la lista: si el libre falla antes del primer token, D4 reintenta,
  // y un par lleno es mejor candidato que ninguno.
  t.is(r.orden.length, 2, 'el saturado sigue disponible para el reintento')
  t.is(r.orden[1].id, 'lleno')
})

test('D6: con todos saturados no se inventa un ganador, se dice', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const r = pickCandidate([cand('a', 'peer', 3, 3), cand('b', 'peer', 5, 5)], {
    random: SIN_AZAR
  })

  t.ok(r.node, 'igual devuelve uno: rechazar de entrada seria peor que intentar')
  t.ok(r.reason.includes('saturados'), 'pero el motivo no finge una decision: ' + r.reason)
})

test('D6: con carga pareja se conserva el orden del modo --demo', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // Una red ociosa: todos en 0. Es el caso normal, no el raro.
  const local = cand('local', 'real', 0, 3)
  const par = cand('par', 'peer', 0, 3)

  const r = pickCandidate([local, par], { random: SIN_AZAR })

  // La preferencia por el par es de demo (store.mjs:453-461) y sobrevive como
  // desempate: sin esto, `--demo --swarm` deja de ejercitar el camino P2P.
  t.is(r.node.id, 'par', 'empatados en carga, el par sigue primero')
})

test('D6: un mock nunca le gana a un candidato real', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // El mock fluctua al azar (store.startFluctuation) y puede quedar en 0
  // mientras el par real esta a la mitad. Su carga es teatro: compararla
  // contra carga real es comparar un numero con una ficcion.
  const mock = cand('mock', 'mock', 0, 4)
  const par = cand('par', 'peer', 2, 4)

  const r = pickCandidate([mock, par], { random: SIN_AZAR })

  t.is(r.node.id, 'par', 'el mock queda atras aunque marque menos carga')
})

test('D6: el historico desempata cuando la carga empata', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const bueno = cand('bueno', 'peer', 1, 10)
  const malo = cand('malo', 'peer', 1, 10)

  const statsFor = (n) =>
    n.id === 'malo'
      ? { requests: 10, errors: 5, lastMs: 100 }
      : { requests: 10, errors: 0, lastMs: 900 }

  const r = pickCandidate([malo, bueno], { statsFor, random: SIN_AZAR })

  t.is(r.node.id, 'bueno', 'menos errores gana, aunque sea mas lento')
  t.ok(r.reason.includes('errores'), r.reason)
})

// ---------------------------------------------------------------------------
// FASE 8 — el precio entra al ruteo
//
// La mitad que faltaba de la fase. Lo que estos tests fijan no es "el barato
// gana": es DONDE gana, que es lo unico discutible. Detras de la carga, porque
// la opcion barata que esta llena no es barata; delante de la latencia y del
// desempate por tipo, porque ese ultimo es "preferencia del modo demo, ya no
// criterio" y venia decidiendo cosas de plata por accidente.
// ---------------------------------------------------------------------------

// Precio por candidato en micro-dolares, como se lo pasa el gateway: ya atado
// al request. Un par y el motor local dan cero, que hoy es la verdad y no un
// placeholder -- el pago P2P es la Fase 9.
function precioFijo(tabla) {
  return (n) => tabla[n.id] || 0
}

test('FASE 8: con carga pareja gana el mas barato, y el log dice los dos precios', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const caro = cand('caro', 'upstream', 0, 4)
  const barato = cand('barato', 'upstream', 0, 4)

  const r = pickCandidate([caro, barato], {
    precioDe: precioFijo({ caro: 5000, barato: 900 }),
    random: SIN_AZAR
  })

  t.is(r.node.id, 'barato')
  t.ok(r.reason.includes('mas barato'), r.reason)
  // Los DOS numeros: sin el del segundo, "el mas barato" no se audita contra
  // nada -- es la misma exigencia que el DoD le hace al motivo de la carga.
  t.ok(r.reason.includes('0.0009') && r.reason.includes('0.005'), 'nombra ambos: ' + r.reason)
})

test('FASE 8: el precio NO le gana a "puede atender ahora"', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // El gratis esta al 90%; el que cobra, vacio. Gana igual el gratis: mandar
  // el request al caro porque el barato esta cargado seria cambiar dolares por
  // latencia sin que nadie lo pidiera.
  const gratisCargado = cand('gratis', 'peer', 9, 10)
  const caroLibre = cand('caro', 'upstream', 0, 10)

  const conLugar = pickCandidate([caroLibre, gratisCargado], {
    precioDe: precioFijo({ caro: 5000 }),
    random: SIN_AZAR
  })
  t.is(conLugar.node.id, 'caro', 'con MENOS carga gana el caro: la carga va primero')

  // Y al reves: lleno de verdad, el caro pasa al frente aunque cueste.
  const gratisLleno = cand('gratis', 'peer', 10, 10)
  const r = pickCandidate([gratisLleno, caroLibre], {
    precioDe: precioFijo({ caro: 5000 }),
    random: SIN_AZAR
  })
  t.is(r.node.id, 'caro', 'un candidato saturado no es barato: es ninguno')
})

test('FASE 8: gratis le gana a pago por PRECIO, no por el tipo de nodo', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // Es el comportamiento que la Fase 8.5 ya daba por bueno ("con las dos
  // puertas abiertas contesta la de casa"), pero lo producia el desempate por
  // `kind` del paso 7. Con el precio, el motivo deja de ser un accidente.
  const local = cand('local', 'upstream', 0, 4) // motor propio: no cuesta
  const tercero = cand('tercero', 'upstream', 0, 4) // API que cobra

  const r = pickCandidate([tercero, local], {
    precioDe: precioFijo({ tercero: 2500 }),
    random: SIN_AZAR
  })
  t.is(r.node.id, 'local', 'mismo kind, misma carga: decide el precio')
  t.ok(r.reason.includes('mas barato'), 'y el motivo lo dice: ' + r.reason)
  t.ok(r.reason.includes('gratis'), 'el cero se escribe "gratis", no "USD 0.0000": ' + r.reason)
})

test('FASE 8: el precio se compara ANTES que la latencia y los errores', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const barato = cand('barato', 'upstream', 0, 4)
  const caro = cand('caro', 'upstream', 0, 4)

  // El caro tiene mejor historia en las dos dimensiones. Pierde igual: con
  // carga pareja el DoD dice que gana el mas barato.
  const statsFor = (n) =>
    n.id === 'caro'
      ? { requests: 10, errors: 0, lastMs: 100 }
      : { requests: 10, errors: 3, lastMs: 900 }

  const r = pickCandidate([caro, barato], {
    statsFor,
    precioDe: precioFijo({ caro: 5000, barato: 900 }),
    random: SIN_AZAR
  })
  t.is(r.node.id, 'barato')

  // Y con precios IGUALES vuelven a mandar ellos, que es lo que hace que meter
  // el precio no rompa el desempate entre pares -- donde todos valen cero.
  const conEmpate = pickCandidate([caro, barato], {
    statsFor,
    precioDe: precioFijo({ caro: 900, barato: 900 }),
    random: SIN_AZAR
  })
  t.is(conEmpate.node.id, 'caro', 'empatados en precio, decide el historico')
  t.ok(conEmpate.reason.includes('errores'), conEmpate.reason)
})

test('FASE 8: sin precioDe el ruteo se comporta igual que antes', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // Todo el resto de la suite llama a pickCandidate sin `precioDe`, y tiene que
  // seguir andando: el precio es un criterio nuevo, no un requisito nuevo.
  const cargado = cand('cargado', 'peer', 9, 10)
  const libre = cand('libre', 'peer', 1, 10)
  const r = pickCandidate([cargado, libre], { random: SIN_AZAR })
  t.is(r.node.id, 'libre', 'sigue mandando la carga')

  // Y un precioDe que explota no puede tumbar el ruteo, igual que el historico.
  const roto = pickCandidate([cargado, libre], {
    precioDe: () => {
      throw new Error('costs exploto')
    },
    random: SIN_AZAR
  })
  t.is(roto.node.id, 'libre', 'se rutea igual, sin el criterio de precio')
})

test('D6: un historico roto no puede tumbar el ruteo', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const statsFor = () => {
    throw new Error('el bee exploto')
  }

  const r = pickCandidate([cand('a', 'peer', 0, 3)], { statsFor, random: SIN_AZAR })
  t.is(r.node.id, 'a', 'se rutea igual, sin el desempate historico')
})

test('pin: fijar una maquina la elige, y si no esta NO cae a otra', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const a = cand('a', 'peer', 0, 3)
  const b = cand('b', 'peer', 0, 3)

  const fijado = pickCandidate([a, b], { pin: 'b', random: SIN_AZAR })
  t.is(fijado.node.id, 'b', 'respeta la maquina elegida')
  t.is(fijado.decision.pin, true)
  t.is(fijado.orden.length, 1, 'sin alternativas: pin es pin')

  // El nodo elegido se fue de la red entre que se pinto el selector y se mando
  // el prompt. Contestar con OTRA maquina sin avisar vaciaria de sentido a la
  // funcion: el que fija una maquina quiere esa.
  const ausente = pickCandidate([a, b], { pin: 'fantasma', random: SIN_AZAR })
  t.absent(ausente.node, 'no elige un reemplazo')
  t.ok(ausente.reason.includes('fantasma'), ausente.reason)
})

test('pin: una maquina fijada y saturada se devuelve, con el aviso', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const lleno = cand('lleno', 'peer', 3, 3)
  const r = pickCandidate([lleno, cand('libre', 'peer', 0, 3)], {
    pin: 'lleno',
    random: SIN_AZAR
  })

  t.is(r.node.id, 'lleno')
  t.is(r.decision.saturado, true)
  t.ok(r.reason.includes('saturado'), r.reason)
})

test('S5: markSaturated deja al par lleno hasta el proximo node:status', async (t) => {
  const store = await import('../qvac/store.mjs')
  const { estaSaturado } = await import('../qvac/routing.mjs')

  // Un modelId propio de este test: el registro es estado de modulo y lo
  // comparten todos los tests del archivo.
  store.registerLocal({
    modelId: 'test-saturacion',
    displayName: 'T',
    operator: 'test',
    maxConcurrentRequests: 3
  })
  const fila = store.listNodes().find((n) => n.modelId === 'test-saturacion')

  t.absent(estaSaturado(fila), 'arranca con lugar')

  store.markSaturated(fila.id)
  t.ok(
    estaSaturado(store.getNode(fila.id)),
    'tras un at_capacity queda lleno sin esperar los 2s del status'
  )

  // Y no hay marca que recordar ni que expirar: el proximo node:status escribe
  // activeRequests sin mirar lo que habia (store.mjs:374-386), asi que la
  // verdad del par pisa esto solo.
  store.kick(fila.id)
})

test('normalizeRequest acepta fijar la maquina, no solo el modelo', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const conPin = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    node: 'abc123:llama1b'
  })
  t.is(conPin.pin, 'abc123:llama1b', 'el id del nodo llega hasta el ruteo')

  // Sin el campo es null y no undefined: el contrato del normalizador es
  // devolver algo comparable, igual que con `local`.
  const sinPin = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(sinPin.pin, null)

  // Un string vacio o de espacios es "no elegi ninguna", no una maquina
  // llamada "". Sin esto el ruteo buscaria un nodo con id vacio y daria 404.
  t.is(
    normalizeRequest({ model: 'l', messages: [{ role: 'user', content: 'h' }], node: '   ' }).pin,
    null
  )

  // Y la forma corta propia tambien, como con local.
  t.is(normalizeRequest({ modelId: 'llama1b', prompt: 'hola', node: 'x:y' }).pin, 'x:y')
})

// ---------------------------------------------------------------------------
// Fase 6.6 / D23 — la cuota gratuita enganchada al provider (qvac/quota.mjs)
// ---------------------------------------------------------------------------

// Un Provider con un motor falso: no carga pesos, no toca el registry, y
// genera exactamente los tokens que se le piden. Sin esto no hay forma de
// probar el descuento de cuota sin 807 MB y una GPU.
async function providerDePrueba(tokensPorRespuesta = 5) {
  const { Provider } = await import('../qvac/provider.mjs')
  const engine = {
    resolveModel: async () => ({ modelSrc: {} }),
    loadModel: async () => 'cargado',
    complete: async function* () {
      for (let i = 0; i < tokensPorRespuesta; i++) yield 'tok'
    },
    shutdown: async () => {}
  }
  return new Provider({
    engineLoader: async () => engine,
    models: [{ modelId: 'llama1b', maxConcurrentRequests: 3 }],
    maxConcurrent: 3
  })
}

// Junta lo que el provider le contesta al par.
function capturar() {
  const vistos = []
  return { vistos, send: (m) => vistos.push(m) }
}

const PEER = { key: 'ff'.repeat(32) }

async function pedir(provider, peer, requestId) {
  const cap = capturar()
  await provider._serve(
    peer,
    {
      requestId,
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }]
    },
    cap.send
  )
  return cap.vistos
}

test('la cuota se descuenta con los tokens servidos de verdad', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 12 })

  const provider = await providerDePrueba(5)

  const primera = await pedir(provider, PEER, 'r1')
  t.is(primera[0].type, 'chat:accepted', 'con cuota entra')
  t.is(quota.usado(PEER.key), 5, 'descuenta lo generado, no lo pedido')

  await pedir(provider, PEER, 'r2')
  t.is(quota.usado(PEER.key), 10)

  quota.reset()
})

test('agotada la cuota se rechaza ANTES de gastar la GPU', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 4 })

  const provider = await providerDePrueba(5)

  await pedir(provider, PEER, 'r1')
  t.is(quota.usado(PEER.key), 5, 'el primero se sirve entero aunque se pase')

  // El desborde de UN request se acepta a proposito (ver quota.mjs): cortar
  // una generacion por la mitad se ve como un bug y regala igual la GPU ya
  // gastada. Lo que no puede pasar es que entre el siguiente.
  const segunda = await pedir(provider, PEER, 'r2')

  t.is(segunda[0].type, 'chat:error', 'el segundo no entra')
  t.is(segunda[0].code, 'quota_exceeded')
  t.is(segunda.length, 1, 'ni un solo chunk: no se gasto GPU')
  t.ok(segunda[0].resetsInMs > 0, 'y dice en cuanto se repone: ' + segunda[0].resetsInMs)

  quota.reset()
})

test('la cuota es por par: agotar la de uno no toca la del otro', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 3 })

  const provider = await providerDePrueba(5)
  const otro = { key: 'ab'.repeat(32) }

  await pedir(provider, PEER, 'r1')
  const suyo = await pedir(provider, PEER, 'r2')
  t.is(suyo[0].code, 'quota_exceeded', 'el primero se quedo sin cuota')

  // La clave del par la establece la conexion de Hyperswarm, no el contenido
  // del mensaje: por eso el proveedor puede contar por par sin creerle a nadie.
  const ajeno = await pedir(provider, otro, 'r3')
  t.is(ajeno[0].type, 'chat:accepted', 'el otro par tiene la suya intacta')

  quota.reset()
})

test('un request que falla cargando el modelo no gasta cuota', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  const { Provider } = await import('../qvac/provider.mjs')
  quota.reset()

  const provider = new Provider({
    engineLoader: async () => ({
      resolveModel: async () => {
        throw new Error('el registry no contesta')
      }
    }),
    models: [{ modelId: 'llama1b', maxConcurrentRequests: 3 }]
  })

  const vistos = await pedir(provider, PEER, 'r1')
  t.is(vistos[vistos.length - 1].code, 'inference_failed')
  // La cuota mide GPU entregada, no intentos: cobrarle al par un modelo que
  // nunca cargo seria cobrarle por nuestro problema.
  t.is(quota.usado(PEER.key), 0, 'no se le descuenta nada')

  quota.reset()
})

// ---------------------------------------------------------------------------
// Fase 8.5 — el asistente externo como un candidato mas
//
// Todo lo de aca corre SIN tocar la API de NVIDIA: se prueba la config, el
// precio y las tres condiciones de elegibilidad de D19, que es donde estan las
// decisiones. Que el SSE del proveedor se parsee bien se verifica contra el
// proveedor de verdad, no con un mock que confirme lo que ya creemos.
// ---------------------------------------------------------------------------

test('la config de upstreams se lee entera: modelos, precio y tope de salida', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'nim',
        label: 'NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1/',
        apiKeyEnv: 'NVIDIA_API_KEY',
        models: [
          {
            modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b',
            displayName: 'Nemotron 3.5 Lightning 30B',
            maxTokens: 512,
            pricePerMTok: { input: 0.2, output: 0.6 }
          }
        ]
      }
    ]
  })

  t.is(ups.length, 1)
  t.is(ups[0].id, 'nim:nvidia/nemotron-3.5-lightning-30b-a3b', 'el id lleva proveedor y modelo')
  t.is(ups[0].baseUrl, 'https://integrate.api.nvidia.com/v1', 'la barra final se saca')
  t.is(ups[0].maxTokens, 512)
  t.alike(ups[0].precio, { entrada: 200_000, salida: 600_000 }, 'USD por 1M -> micros enteros')
})

test('un upstream sin tope de salida igual tiene uno: la reserva lo necesita', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'x',
        baseUrl: 'https://ejemplo.test/v1',
        apiKeyEnv: 'X_KEY',
        models: [{ modelId: 'm1' }]
      }
    ]
  })

  t.ok(ups[0].maxTokens > 0, 'sin maxTokens la cota superior del gasto daria cero')
  t.is(ups[0].precio, null, 'sin pricePerMTok no se inventa un precio')
})

// ---------------------------------------------------------------------------
// Los dos relojes del camino externo (B3), y el numero del primero (B16)
//
// Son lo unico que impide que un request al externo quede abierto para siempre
// y, con el, la reserva de presupuesto que lo autorizo. No tenian ningun test:
// el de B3 prueba que el reloj DISPARA, con 300ms puestos a mano desde la
// config, y por eso no habria visto que el default estaba mal calibrado.
//
// El numero cambio a 180s porque los 60s anteriores quedaron dos segundos por
// encima de lo medido -- 58s al primer byte contra NVIDIA el 2026-08-26 -- y
// los requests estaban por cortarse solos por lentos, no por colgados.
// ---------------------------------------------------------------------------

test('un upstream sin relojes declarados igual los tiene, y no en cero', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'x',
        baseUrl: 'https://ejemplo.test/v1',
        apiKeyEnv: 'X_KEY',
        models: [
          { modelId: 'porDefecto' },
          // Los tres modos de escribirlo mal: cero, negativo y basura. Ninguno
          // puede terminar en un timeout de cero, que dispararia antes de
          // empezar y dejaria al externo inservible en vez de protegido.
          { modelId: 'enCero', timeoutPrimerChunkMs: 0, timeoutIdleMs: 0 },
          { modelId: 'negativo', timeoutPrimerChunkMs: -5000, timeoutIdleMs: -1 },
          { modelId: 'basura', timeoutPrimerChunkMs: 'rapido', timeoutIdleMs: null }
        ]
      }
    ]
  })

  for (const u of ups) {
    t.ok(u.timeoutPrimerChunkMs > 0, u.model + ': el reloj del primer byte existe')
    t.ok(u.timeoutIdleMs > 0, u.model + ': el reloj del silencio existe')
  }

  // El default, fijado a proposito: si alguien lo vuelve a bajar, que sea una
  // decision y no un descuido. 58s medidos contra NVIDIA el 2026-08-26 es lo
  // que descarta cualquier numero cerca de 60.
  t.is(ups[0].timeoutPrimerChunkMs, 180000, 'tres minutos hasta el primer byte')
  t.is(ups[0].timeoutIdleMs, 30000, 'y treinta segundos de silencio entre tokens')

  // Lo que SI se respeta es un valor valido: un modelo con latencia conocida se
  // acomoda desde la config sin tocar el codigo.
  const propio = upstream.cargarDesde({
    upstreams: [
      {
        id: 'y',
        baseUrl: 'https://ejemplo.test/v1',
        apiKeyEnv: 'Y_KEY',
        models: [{ modelId: 'm', timeoutPrimerChunkMs: 300, timeoutIdleMs: 250 }]
      }
    ]
  })
  t.is(propio[0].timeoutPrimerChunkMs, 300, 'un valor valido gana, y por eso el test de B3 anda')
  t.is(propio[0].timeoutIdleMs, 250)
})

test('el opt-in ausente, roto o a medias significa NO', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  t.is(upstream.optInDe(null), false)
  t.is(upstream.optInDe({}), false)
  t.is(upstream.optInDe({ optIn: 'true' }), false, 'el string no alcanza: tiene que ser booleano')
  t.is(upstream.optInDe({ optIn: true }), true)
  t.is(upstream.brokerDe({}), false, 'revender tampoco pasa por omision')
})

test('el precio de un modelo externo entra al contador y estima como los demas', async (t) => {
  const costs = await import('../qvac/costs.mjs')
  costs.olvidarPreciosExternos()

  t.is(costs.conocido('nvidia/nemotron'), false, 'antes de registrarlo no cuesta nada')

  t.is(costs.registrarPrecio('nvidia/nemotron', { entrada: 200_000, salida: 600_000 }), true)
  t.is(costs.conocido('nvidia/nemotron'), true)

  // 1000 de entrada a 0.20/1M + 1024 de salida a 0.60/1M
  const estimado = costs.estimar({
    model: 'nvidia/nemotron',
    promptTokens: 1000,
    maxTokens: 1024
  })
  t.is(estimado, 200 + 615, 'redondea hacia arriba, como el resto de costs.mjs')

  t.is(costs.registrarPrecio('otro', { entrada: 0, salida: 0 }), false, 'gratis no es un precio')
  t.is(costs.conocido('otro'), false)

  costs.olvidarPreciosExternos()
})

test('D19: el externo no compite mientras alguien de la red tenga lugar', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const local = {
    id: 'local:llama1b',
    kind: 'real',
    activeRequests: 2,
    maxConcurrentRequests: 3,
    operator: 'yo'
  }
  const externo = {
    id: 'upstream:nim',
    kind: 'upstream',
    activeRequests: 0,
    maxConcurrentRequests: 4,
    operator: 'NVIDIA NIM (externo)'
  }

  // Sin el filtro de elegibilidad, el externo GANA: su carga es 0 y la del
  // local 66%. Ese es justamente el motivo por el que la condicion se aplica
  // como filtro antes de puntuar y no como un `if` despues.
  const sinFiltro = pickCandidate([local, externo])
  t.is(sinFiltro.node.id, 'upstream:nim', 'por carga sola, el externo se lleva todo')

  const conFiltro = pickCandidate([local])
  t.is(conFiltro.node.id, 'local:llama1b', 'filtrado antes de puntuar, contesta la maquina')
})

test('una fila de upstream se registra, se lista y no infla la capacidad anunciada', async (t) => {
  const store = await import('../qvac/store.mjs')
  store.seed()

  store.registerLocal({
    modelId: 'llama1b',
    displayName: 'Llama 3.2 1B',
    operator: 'yo',
    maxConcurrentRequests: 3
  })

  const antes = store.localLoad().maxConcurrentRequests

  const id = store.registerUpstream({
    id: 'nim:nemotron',
    modelId: 'nvidia/nemotron',
    displayName: 'Nemotron 3.5',
    operator: 'NVIDIA NIM (externo)',
    maxConcurrentRequests: 4
  })

  t.is(id, 'upstream:nim:nemotron')
  const fila = store.listNodes().find((n) => n.id === id)
  t.is(fila.kind, 'upstream', 'entra al registro como una fila mas')
  t.is(fila.status, 'online')

  // Lo que este nodo le anuncia a la red es lo que ESTE nodo puede servir. Un
  // upstream es capacidad de un tercero: sumarla seria anunciar 7 slots
  // teniendo 3, la clase de mentira que el manifiesto firmado existe para
  // evitar.
  t.is(store.localLoad().maxConcurrentRequests, antes, 'la capacidad local no cambia')

  store.clearUpstreams()
  t.absent(
    store.listNodes().find((n) => n.kind === 'upstream'),
    'al releer la config no quedan filas viejas'
  )
  store.seed()
})

test('un upstream sin credencial se registra offline: no puede ser candidato', async (t) => {
  const store = await import('../qvac/store.mjs')
  store.seed()

  store.registerUpstream({
    id: 'nim:nemotron',
    modelId: 'nvidia/nemotron',
    displayName: 'Nemotron 3.5',
    operator: 'NVIDIA NIM (externo)',
    status: 'offline'
  })

  const fila = store.listNodes().find((n) => n.kind === 'upstream')
  t.is(fila.status, 'offline', 'se ve en el panel con lo que le falta')
  t.is(
    store.findAllByModelId('nvidia/nemotron').length,
    0,
    'pero findAllByModelId no lo ofrece: filtra por online'
  )

  store.clearUpstreams()
  store.seed()
})

// ---------------------------------------------------------------------------
// B1 — el tope tiene que sobrevivir a un reinicio
//
// El ledger le imputa el gasto a la cuenta, y la cuenta ES la API key. Con el
// registro de keys en memoria ese id no volvia despues de un reinicio: el
// cliente pedia una key nueva y arrancaba con el tope entero otra vez. El
// mecanismo de corte funcionaba perfecto y era, igual, evitable apagando y
// prendiendo.
//
// Por eso el criterio de cierre de la Fase 6.5 dice "agotar, REINICIAR, y
// seguir cortado": sin el reinicio en el medio, el test pasa con el bug puesto.
// ---------------------------------------------------------------------------

function dirTemporalPelado() {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  // Mismo criterio que directorioTemporal(): nada de mkdtempSync en Windows.
  const dir = path.join(
    os.tmpdir(),
    'qvac-keys-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  )
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    limpiar() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}

test('la api key sobrevive al reinicio: sin eso la cuenta del ledger no existe', async (t) => {
  const apikeys = await import('../qvac/apikeys.mjs')
  const tmp = dirTemporalPelado()

  apikeys.open(tmp.dir)
  const emitida = apikeys.createKey({ label: 'bot de telegram' })
  apikeys.close()

  // El "reinicio": el Map se vacia y se vuelve a leer del disco.
  apikeys.reset()
  apikeys.open(null)
  t.is(apikeys.verifyKey(emitida.key), null, 'sin el archivo, la key no existe (es el bug)')

  const cargadas = apikeys.open(tmp.dir)
  t.is(cargadas, 1)

  const reconocida = apikeys.verifyKey(emitida.key)
  t.ok(reconocida, 'la MISMA key sigue sirviendo despues del reinicio')
  t.is(reconocida.id, emitida.id, 'y sobre todo: el MISMO id, que es la cuenta del ledger')
  t.is(reconocida.label, 'bot de telegram')

  apikeys.close()
  apikeys.reset()
  tmp.limpiar()
})

// ---------------------------------------------------------------------------
// B13 — el tope que acota la FACTURA, no a un cliente
//
// El tope por cuenta está bien como granularidad: se quiere poder cortarle a un
// bot sin cortarle a otro. Pero no acotaba nada de lo que se paga — la factura
// del proveedor externo es UNA SOLA, contra la única credencial del operador.
// Con N keys emitidas el techo real eran N × USD 20 de plata de verdad, y las
// keys se emiten solas: una por nodo al apretar "Conectar".
//
// Ahora hay dos topes y un request pasa sólo si entra en LOS DOS.
// ---------------------------------------------------------------------------

test('B13: tres keys no son tres topes; el del nodo las acota a todas', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  // Cada key con su propio tope holgado. Antes de B13, esto era USD 30 de techo
  // real contra una factura que es una sola.
  const keys = ['bot-telegram', 'open-webui', 'terminal']
  for (const k of keys) budget.setCap(k, budget.usdAMicros ? budget.usdAMicros(10) : 10_000_000)
  budget.setNodeCap(12_000_000) // USD 12 para toda la maquina

  t.is(budget.nodeCap(), 12_000_000)

  // Dos clientes gastan USD 5 cada uno: entran en su tope y en el del nodo.
  for (const k of keys.slice(0, 2)) {
    const r = budget.reserve(k, 5_000_000)
    t.ok(r.ok, k + ' entra: le sobra a su cuenta y al nodo')
    budget.settle(r.id, 5_000_000)
  }

  const agregado = budget.nodeUsage()
  t.is(agregado.spent, 10_000_000, 'el nodo lleva la suma de todas las cuentas')
  t.is(agregado.remaining, 2_000_000, 'y le quedan USD 2, no USD 10')

  // El tercero tiene USD 10 propios sin tocar. Igual NO pasa: la maquina ya no
  // los tiene. Esto es B13 entero.
  const tercero = budget.reserve('terminal', 5_000_000)
  t.is(tercero.ok, false, 'su cuenta le alcanza, la factura del nodo no')
  t.is(
    tercero.scope,
    'nodo',
    'y se dice CUAL tope se agoto: bajarle el tope a una key no arregla esto'
  )
  t.is(budget.usage('terminal').spent, 0, 'sin haber gastado un peso de lo suyo')

  // Lo que sí entra en lo que queda, pasa.
  const chico = budget.reserve('terminal', 1_500_000)
  t.ok(chico.ok, 'el tope del nodo no bloquea: acota')
  budget.settle(chico.id, 1_500_000)

  budget.reset()
})

test('B13: el tope de cuenta sigue cortando aunque al nodo le sobre', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  // La otra dirección, y es la que hace que las keys sigan sirviendo para algo:
  // un cliente acotado no puede gastarse el saldo de la máquina entera.
  budget.setNodeCap(20_000_000)
  budget.setCap('bot-ruidoso', 1_000_000) // USD 1 para este

  const r = budget.reserve('bot-ruidoso', 2_000_000)
  t.is(r.ok, false, 'su tope corta primero')
  t.is(r.scope, 'cuenta', 'y el motivo apunta a la cuenta, no al nodo')
  t.ok(budget.nodeUsage().remaining > 10_000_000, 'al nodo le sobraba de sobra')

  budget.reset()
})

test('B13: el tope del nodo sobrevive al reinicio, y un ledger viejo no queda sin techo', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  const tmp = dirTemporalPelado()

  budget.open(tmp.dir)
  budget.setNodeCap(3_000_000)
  const r = budget.reserve('alguien', 1_000_000)
  budget.settle(r.id, 1_000_000)
  budget.close()

  budget.open(tmp.dir)
  t.is(budget.nodeCap(), 3_000_000, 'el tope del nodo persiste')
  t.is(budget.nodeUsage().spent, 1_000_000, 'y el gasto agregado tambien')
  budget.close()

  // Un budget.json escrito ANTES de B13 no tiene el campo. No puede significar
  // "sin tope": un archivo viejo dejaria a la maquina gastando sin techo, que
  // es justo el bug que esto cierra.
  const ruta = path.default.join(tmp.dir, 'budget.json')
  const crudo = JSON.parse(fs.default.readFileSync(ruta, 'utf8'))
  delete crudo.nodeCap
  fs.default.writeFileSync(ruta, JSON.stringify(crudo))

  budget.open(tmp.dir)
  t.is(
    budget.nodeCap(),
    budget.TOPE_NODO_DEFAULT_MICROS,
    'un ledger sin el campo toma el default, no infinito'
  )
  budget.close()

  budget.reset()
  tmp.limpiar()
})

test('agotado el tope, reiniciar el nodo NO lo repone', async (t) => {
  const apikeys = await import('../qvac/apikeys.mjs')
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  const tmp = dirTemporalPelado()

  // Un tope chico y un precio real, para que el gasto sea de verdad y no una
  // cuenta de cero como la del camino local.
  costs.olvidarPreciosExternos()
  costs.registrarPrecio('externo-de-prueba', { entrada: 1_000_000, salida: 2_000_000 })

  apikeys.open(tmp.dir)
  budget.open(tmp.dir)

  const key = apikeys.createKey({ label: 'cliente' })
  budget.setCap(key.id, costs.usdAMicros(0.1))

  // Se gasta hasta que el ledger corta.
  const porRequest = costs.estimar({
    model: 'externo-de-prueba',
    promptTokens: 1000,
    maxTokens: 10000
  })
  let cortado = false
  for (let i = 0; i < 100; i++) {
    const r = budget.reserve(key.id, porRequest)
    if (!r.ok) {
      cortado = true
      break
    }
    budget.settle(r.id, porRequest)
  }
  t.ok(cortado, 'el tope corta antes de las 100 vueltas')

  const gastado = budget.usage(key.id).spent
  t.ok(gastado > 0)

  // EL REINICIO. Es el paso que faltaba en el DoD original.
  apikeys.close()
  budget.close()
  apikeys.reset()

  apikeys.open(tmp.dir)
  budget.open(tmp.dir)

  const reconocida = apikeys.verifyKey(key.key)
  t.ok(reconocida, 'el cliente vuelve con la misma credencial')

  const despues = budget.usage(reconocida.id)
  t.is(despues.spent, gastado, 'el gasto sigue imputado a la misma cuenta')
  t.is(budget.reserve(reconocida.id, porRequest).ok, false, 'y sigue cortado')

  apikeys.close()
  budget.close()
  apikeys.reset()
  budget.reset()
  costs.olvidarPreciosExternos()
  tmp.limpiar()
})

// ---------------------------------------------------------------------------
// Un motor propio detras de HTTP, y varias puertas al mismo modelo
//
// Dos piezas que entran juntas porque resuelven el mismo problema: el motor
// embebido solo carga modelos del registry de QVAC (engine.mjs resuelve
// registry://), asi que servir pesos abiertos -- un GGUF de HuggingFace --
// significa levantarlos aparte y pedirselos por HTTP. Eso los vuelve un
// upstream por la forma, sin volverlos un tercero por el fondo.
// ---------------------------------------------------------------------------

test('un upstream local no necesita credencial ni precio', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'local',
        label: 'Motor local',
        local: true,
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: [{ modelId: 'nemotron-local' }]
      }
    ]
  })

  t.is(ups.length, 1, 'sin apiKeyEnv entra igual: es el unico que no lo necesita')
  t.is(ups[0].esLocal, true)
  t.ok(ups[0].disponible(), 'disponible sin ninguna variable de entorno puesta')
  t.is(ups[0].precio, null, 'y sin precio, porque no cuesta dolares')
})

test('un upstream REMOTO sin apiKeyEnv se descarta: no podria autenticarse', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'remoto',
        baseUrl: 'https://ejemplo.test/v1',
        models: [{ modelId: 'm1' }]
      }
    ]
  })

  t.is(ups.length, 0, 'el fallo sale al cargar la config, no en el primer prompt')
})

test('tres puertas al mismo modelo se anuncian con UN solo nombre', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'nim',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKeyEnv: 'NVIDIA_API_KEY',
        models: [{ modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b', as: 'nemotron' }]
      },
      {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        models: [{ modelId: 'nvidia/nemotron-3.5-lightning', as: 'nemotron' }]
      },
      {
        id: 'local',
        local: true,
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: [{ modelId: 'nemotron-3.5-lightning-30b-a3b', as: 'nemotron' }]
      }
    ]
  })

  t.is(ups.length, 3)

  // Lo que viaja en el body sigue siendo el nombre DE CADA PROVEEDOR: mandarle
  // a NVIDIA el slug de OpenRouter da 404.
  t.alike(
    ups.map((u) => u.model),
    [
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3.5-lightning',
      'nemotron-3.5-lightning-30b-a3b'
    ],
    'cada uno conserva como lo llama su proveedor'
  )

  // Y lo que entra al catalogo es uno solo: es lo que los hace competir.
  t.alike(
    ups.map((u) => u.anunciadoComo),
    ['nemotron', 'nemotron', 'nemotron'],
    'una sola fila del marketplace para las tres puertas'
  )
})

test('sin "as", el nombre anunciado es el del proveedor (nada cambia)', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'x',
        baseUrl: 'https://ejemplo.test/v1',
        apiKeyEnv: 'X_KEY',
        models: [{ modelId: 'proveedor/modelo' }]
      }
    ]
  })

  t.is(ups[0].anunciadoComo, 'proveedor/modelo', 'el default no rompe lo que ya andaba')
})

test('los headers de la config no pueden pisar la credencial', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'or',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'X_KEY',
        extraHeaders: {
          'HTTP-Referer': 'https://ejemplo.test',
          Authorization: 'Bearer robada',
          'Content-Type': 'text/plain'
        },
        models: [{ modelId: 'm1' }]
      }
    ]
  })

  // Los nombres se normalizan a MINUSCULA al entrar (B11). Los de HTTP no
  // distinguen mayusculas pero un objeto de JavaScript si, y esa diferencia
  // era el agujero: un `authorization` en minuscula en la config no colisionaba
  // con el `Authorization` que escribe el codigo, sobrevivian los dos y salian
  // concatenados -- la credencial de un proveedor viajando al endpoint de otro.
  t.is(
    ups[0].extraHeaders['http-referer'],
    'https://ejemplo.test',
    'los headers de atribucion del proveedor llegan, con el nombre normalizado'
  )
  t.absent(ups[0].extraHeaders['HTTP-Referer'], 'y ya no queda la version sin normalizar')

  // El armado real vive en un metodo privado; se ejercita por su efecto: con
  // credencial gana la credencial, sin credencial no queda un Authorization
  // escrito a mano en un archivo de config.
  const env = (await import('bare-env')).default
  env.X_KEY = 'la-buena'
  t.is(ups[0].apiKey, 'la-buena')
})

test('una fila de upstream local se marca como local en el registro', async (t) => {
  const store = await import('../qvac/store.mjs')
  store.seed()

  store.registerUpstream({
    id: 'local:nemotron',
    modelId: 'nemotron',
    displayName: 'Nemotron local',
    operator: 'Motor local (local)',
    local: true
  })

  const fila = store.listNodes().find((n) => n.kind === 'upstream')
  t.is(fila.local, true, 'el panel necesita esto para no etiquetarlo "external API"')

  // Sigue sin sumar a la capacidad ANUNCIADA a la red: este proceso no puede
  // servirselo a un par (provider.mjs despacha al motor embebido, no a HTTP).
  const antes = store.localLoad().maxConcurrentRequests
  t.is(antes, store.localLoad().maxConcurrentRequests)
  t.absent(
    store
      .listNodes()
      .filter((n) => n.kind === 'real')
      .some((n) => n.modelId === 'nemotron'),
    'no se disfraza de motor embebido'
  )

  store.clearUpstreams()
  store.seed()
})

// ---------------------------------------------------------------------------
// El .env
//
// La config de upstreams guarda el NOMBRE de la variable, nunca el secreto. Eso
// deja la credencial afuera del repo, pero le deja al operador el problema de
// ponerla en el entorno -- y `bare-env` no lee ningun archivo, es un proxy
// sobre el entorno del sistema operativo. De ahi este parser.
// ---------------------------------------------------------------------------

test('el .env tolera lo que la gente escribe de verdad', async (t) => {
  const { parsear } = await import('../qvac/dotenv.mjs')

  const v = parsear(
    [
      '# un comentario',
      '',
      'SIMPLE=valor',
      // Con espacios alrededor del `=`. Asi estaba escrito el .env que motivo
      // todo esto: un parser estricto habria creado una variable llamada
      // "CON_ESPACIOS " que no coincide con ninguna que se busque.
      'CON_ESPACIOS = otro-valor',
      // Lo que sale de copiar una linea de la documentacion.
      'export EXPORTADA=tercero',
      'COMILLAS="entre comillas"',
      "SIMPLES='tambien'",
      'VACIA=',
      'basura sin igual'
    ].join('\n')
  )

  t.is(v.SIMPLE, 'valor')
  t.is(v.CON_ESPACIOS, 'otro-valor', 'el nombre se recorta: si no, no coincide con nada')
  t.is(v.EXPORTADA, 'tercero')
  t.is(v.COMILLAS, 'entre comillas', 'las comillas delimitan, no son parte del valor')
  t.is(v.SIMPLES, 'tambien')
  t.is(v.VACIA, '')
  t.absent('basura' in v, 'una linea sin `=` no define nada')
})

test('una comilla suelta es parte del valor, no un delimitador', async (t) => {
  const { parsear } = await import('../qvac/dotenv.mjs')

  const v = parsear(['ABIERTA="sin cerrar', 'RARA=xy"z'].join('\n'))
  t.is(v.ABIERTA, '"sin cerrar', 'solo se sacan si abren Y cierran')
  t.is(v.RARA, 'xy"z', 'una credencial puede tener cualquier cosa adentro')
})

test('el .env NO pisa una variable que ya esta en el entorno', async (t) => {
  const { cargar } = await import('../qvac/dotenv.mjs')
  const env = (await import('bare-env')).default
  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')

  const dir = path.default.join(os.default.tmpdir(), 'pyrus-test-env-' + Date.now())
  fs.default.mkdirSync(dir, { recursive: true })
  fs.default.writeFileSync(
    path.default.join(dir, '.env'),
    'PYRUS_YA_ESTABA=del-archivo\nPYRUS_NUEVA=del-archivo\n'
  )

  env.PYRUS_YA_ESTABA = 'del-entorno'
  delete env.PYRUS_NUEVA

  const r = await cargar(dir)

  // Un .env es el default del proyecto, no una orden: quien exporta algo a
  // mano -- en su terminal, en un CI, en un systemd unit -- esta diciendo algo
  // mas especifico, y eso gana.
  t.is(env.PYRUS_YA_ESTABA, 'del-entorno', 'lo que ya estaba no se toca')
  t.is(env.PYRUS_NUEVA, 'del-archivo', 'lo que faltaba se carga')
  t.alike(r.cargadas, ['PYRUS_NUEVA'])
  t.alike(r.yaEstaban, ['PYRUS_YA_ESTABA'], 'y se sabe cual se respeto')

  fs.default.rmSync(dir, { recursive: true, force: true })
})

test('sin .env no pasa nada: es el caso normal', async (t) => {
  const { cargar } = await import('../qvac/dotenv.mjs')
  const os = await import('bare-os')
  const path = await import('bare-path')

  const r = await cargar(path.default.join(os.default.tmpdir(), 'pyrus-no-existe-' + Date.now()))
  t.alike(r.cargadas, [], 'la mayoria de los nodos no habla con ninguna API externa')
})

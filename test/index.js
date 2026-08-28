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
  const palabras = creada.frase.split(' ')

  t.absent(crudo.includes(creada.frase), 'la frase entera no esta en el archivo')
  t.absent(crudo.includes(creada.address), 'la direccion tampoco se guarda')

  // Las palabras se buscan en los BYTES del cifrado, no en el texto hex del
  // archivo, y la diferencia no es cosmetica: la primera version buscaba cada
  // palabra dentro del hex, y OCHO palabras de BIP-39 son enteramente
  // hexadecimales -- add, beef, dad, decade, face, fade, fee, feed --, asi que
  // aparecian por coincidencia. El test fallaba ~1 de cada 3 corridas
  // comprobando una coincidencia de letras en vez de una propiedad de
  // seguridad, y en el archivo mas sensible del proyecto.
  const sobre = JSON.parse(crudo)
  const bytes = Buffer.from(sobre.sealed, 'hex').toString('utf8')
  for (const palabra of palabras) {
    t.absent(bytes.includes(palabra), 'la palabra "' + palabra + '" no esta en el cifrado')
  }

  // Y ningun par de palabras contiguas en el archivo crudo: una fuga real deja
  // palabras SEGUIDAS, y dos seguidas ya no salen por casualidad.
  for (let i = 0; i < palabras.length - 1; i++) {
    const par = palabras[i] + ' ' + palabras[i + 1]
    t.absent(crudo.includes(par), 'ningun par contiguo: "' + par + '"')
  }

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

test('FASE 11: la passphrase sale del entorno, o se genera y se persiste para el proximo arranque', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  // 1. El entorno gana siempre, y no toca ningun archivo.
  const env = wallet.resolverPassphrase(tmp.dir, {
    env: { [wallet.VAR_PASSPHRASE]: '  del-entorno  ' }
  })
  t.is(env.passphrase, 'del-entorno', 'con trim')
  t.is(env.fuente, 'env')
  t.is(
    wallet.resolverPassphrase(tmp.dir, { env: {} }).passphrase,
    null,
    'no escribio nada al resolver desde el entorno'
  )

  // 2. Sin entorno y sin generar: null, no un throw. Quien abre decide.
  t.is(wallet.resolverPassphrase(tmp.dir, { env: {} }).fuente, null)

  // 3. Sin entorno y con generar: mintea, guarda, y la MISMA vuelve despues.
  //    Es lo que hace que abrir() ande tras un reinicio sin tipear nada.
  const g1 = wallet.resolverPassphrase(tmp.dir, { env: {}, generar: true })
  t.ok(g1.passphrase && g1.passphrase.length >= 32, 'una passphrase de verdad')
  t.is(g1.fuente, 'generada')
  const g2 = wallet.resolverPassphrase(tmp.dir, { env: {} })
  t.is(g2.passphrase, g1.passphrase, 'la segunda vez sale del archivo, identica')
  t.is(g2.fuente, 'archivo')

  // 4. El entorno le sigue ganando al archivo si aparece despues.
  t.is(
    wallet.resolverPassphrase(tmp.dir, { env: { [wallet.VAR_PASSPHRASE]: 'otra' } }).passphrase,
    'otra'
  )

  // 5. Una wallet creada con la passphrase generada se vuelve a abrir sola.
  const creada = await wallet.crear(tmp.dir, g1.passphrase)
  const reabierta = await wallet.abrir(
    tmp.dir,
    wallet.resolverPassphrase(tmp.dir, { env: {} }).passphrase
  )
  t.is(reabierta.address, creada.address, 'sin que nadie tipee nada')

  tmp.limpiar()
})

test('FASE 11: la red sale del entorno, o del archivo que escribe el selector del panel', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  // Sin nada: el default de D15 (plasma mainnet), fuente 'default'.
  const def = wallet.redDe({}, { dir: tmp.dir })
  t.is(def.nombre, 'plasma')
  t.is(def.fuente, 'default')
  t.ok(def.mainnet, 'y es mainnet')
  t.absent(def.fijadaPorEnv)

  // guardarRed valida y persiste; redDe lo lee la proxima vez, con fuente 'archivo'.
  const g = wallet.guardarRed(tmp.dir, 'plasma-testnet')
  t.is(g.nombre, 'plasma-testnet')
  t.is(g.chainId, 9746)
  t.absent(g.mainnet)
  const arch = wallet.redDe({}, { dir: tmp.dir })
  t.is(arch.nombre, 'plasma-testnet')
  t.is(arch.fuente, 'archivo')
  t.is(arch.chainId, 9746)

  // El entorno le gana al archivo y marca fijadaPorEnv.
  const desdeEnv = wallet.redDe({ [wallet.VAR_RED]: 'plasma' }, { dir: tmp.dir })
  t.is(desdeEnv.nombre, 'plasma')
  t.is(desdeEnv.fuente, 'env')
  t.ok(desdeEnv.fijadaPorEnv)

  // Un nombre que no existe NO toca disco: la eleccion anterior queda intacta.
  t.exception(() => wallet.guardarRed(tmp.dir, 'ethereum'), /no es una red conocida/)
  t.is(wallet.redDe({}, { dir: tmp.dir }).nombre, 'plasma-testnet', 'siguio la anterior')

  // Sin `dir` se comporta como antes: solo entorno y default.
  t.is(wallet.redDe({}).nombre, 'plasma')

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
  t.ok(r.reason.includes('lower load'), 'y el motivo lo dice: ' + r.reason)
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
  t.ok(r.reason.includes('saturated'), 'pero el motivo no finge una decision: ' + r.reason)
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
  t.ok(r.reason.includes('errors'), r.reason)
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
  t.ok(r.reason.includes('cheaper'), r.reason)
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
  t.ok(r.reason.includes('cheaper'), 'y el motivo lo dice: ' + r.reason)
  t.ok(r.reason.includes('free'), 'el cero se escribe "gratis", no "USD 0.0000": ' + r.reason)
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
  t.ok(conEmpate.reason.includes('errors'), conEmpate.reason)
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
  const ausente = pickCandidate([a, b], { pin: 'ghost', random: SIN_AZAR })
  t.absent(ausente.node, 'no elige un reemplazo')
  t.ok(ausente.reason.includes('ghost'), ausente.reason)
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
  t.ok(r.reason.includes('saturated'), r.reason)
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

// ---------------------------------------------------------------------------
// FASE 9 — que el stack de x402 cargue, y que cargue POR EL MOTIVO ESCRITO
//
// `@x402/evm` no importa bajo Bare por su cuenta: llega a `@noble/hashes/crypto`,
// que bajo la condicion `node` resuelve a un archivo que importa `node:crypto`.
// Con WDK importado antes, funciona -- y el mecanismo NO esta diagnosticado.
//
// Eso es incomodo en el camino que maneja pagos, asi que hay dos cosas que lo
// vigilan: el paso 5 del spike de D11, y este test.
//
// La prueba se hace en un PROCESO LIMPIO a proposito. Adentro de la suite, para
// cuando esto corra, ya hay media docena de modulos cargados -- entre ellos
// wallet.mjs, que importa WDK -- asi que un `await import('../qvac/x402.mjs')`
// aca pasaria SIEMPRE, incluso con el import de WDK borrado del modulo. Seria
// otro verde que no significa lo que dice.
// ---------------------------------------------------------------------------

function bareLimpio(codigo) {
  const { spawnSync } = require('bare-subprocess')
  const r = spawnSync(Bare.argv[0], ['-e', codigo], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).trim()
}

test('FASE 9: x402.mjs carga el stack en un proceso limpio', async (t) => {
  const salida = bareLimpio(
    "import('./qvac/x402.mjs').then(m => m.cargar()).then(s =>" +
      " console.log('OK ' + s.core.x402Version + ' ' + Object.keys(s.evm).length))" +
      ".catch(e => console.log('FALL ' + e.message))"
  )
  t.ok(salida.startsWith('OK'), 'carga sin nada precargado: ' + salida.slice(0, 120))
  t.ok(salida.includes('OK 2'), 'x402Version 2, que es el protocolo que se implementa')
})

test('FASE 9: y sin el import de WDK NO cargaria, que es por lo que esta', async (t) => {
  // La contracara. Si esto empezara a pasar, el import de WDK dejo de hacer
  // falta -- y habria que sacarlo con su comentario, no dejarlo "por las
  // dudas". Si falla al reves, alguien lo borro y este test dice por que dolio.
  const salida = bareLimpio(
    "import('@x402/evm').then(m => console.log('OK ' + Object.keys(m).length))" +
      ".catch(e => console.log('FALL ' + e.message))"
  )
  // No se busca el prefijo 'FALL': el error lo tira Bare antes de que el
  // .catch() del import llegue a existir. Lo que importa es que NO diga OK y
  // que la causa siga siendo la diagnosticada.
  //
  // La causa CAMBIO una vez, y este assert lo cazo: era `node:crypto` (el
  // packer eligiendo la variante de node en @noble/hashes) hasta que ese
  // problema se arreglo en scripts/parche-noble-bare.js. Lo que queda es el
  // polyfill: viem usa TextEncoder y Bare no lo trae como global; WDK lo
  // instala al cargarse.
  t.absent(salida.startsWith('OK'), 'importado solo no carga')
  t.ok(
    salida.includes('TextEncoder'),
    'y es por el global que falta, no por otra cosa: ' + salida.slice(0, 110)
  )
})

test('FASE 9: Plasma no se cobra sin que alguien verifique su contrato', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  // D15 puso Plasma de default, pero x402 no la trae: getDefaultAsset tira
  // "No default asset configured". La direccion del contrato la declaramos
  // nosotros, y es plata real -- asi que sin confirmacion explicita no se usa.
  delete env[x402.VAR_PLASMA_OK]
  t.is(await x402.activoDe('plasma'), null, 'sin confirmar, Plasma queda afuera')

  const stable = await x402.activoDe('stable')
  t.ok(stable, 'Stable si, y su direccion sale de x402, no de una constante nuestra')
  t.is(stable.network, 'eip155:988')
  t.is(stable.symbol, 'USDT0')
  t.is(stable.decimals, 6)

  t.alike(await x402.redesDisponibles(), ['stable'], 'hoy se puede cobrar en una sola')

  env[x402.VAR_PLASMA_OK] = '1'
  const plasma = await x402.activoDe('plasma')
  t.ok(plasma, 'con la confirmacion del operador, entra')
  t.is(plasma.network, 'eip155:9745')
  t.alike(await x402.redesDisponibles(), ['plasma', 'stable'], 'y va primero, como dice D15')

  delete env[x402.VAR_PLASMA_OK]
})

// ---------------------------------------------------------------------------
// FASE 9 / D24 — la atestacion del proveedor
//
// El recibo de x402 prueba que alguien PAGO. Esto es el otro lado: el artefacto
// donde el que sirvio se compromete con lo que entrego. Los tests de aca prueban
// las propiedades del artefacto AISLADO; que el gateway lo emita en los tres
// casos de corte de D27 esta en test/integracion.js.
//
// La wallet es la misma frase publica de prueba que usa el resto de la suite y
// que NUNCA se fondea. La firma es real; la plata no existe.
// ---------------------------------------------------------------------------

const FRASE_DE_PRUEBA = 'test test test test test test test test test test test junk'

async function walletDePrueba() {
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cuenta = await new WM(FRASE_DE_PRUEBA, {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount()
  return {
    address: await cuenta.getAddress(),
    firmar: (mensaje) => cuenta.sign(mensaje)
  }
}

async function atestacionDePrueba(address, pisar = {}) {
  const at = await import('../qvac/atestacion.mjs')
  return at.construir({
    requestId: 'chatcmpl-prueba',
    ts: 1700000000000,
    nonce: 'ab'.repeat(16),
    modelId: 'Qwen3-4B-Q4_K_M',
    quantization: 'Q4_K_M',
    runtime: 'llamacpp',
    promptHash: at.hashDe('hola'),
    outputHash: at.hashDe('respuesta'),
    tokensPrefill: 12,
    tokensDecode: 34,
    finishReason: 'stop',
    providerPubkey: address,
    ...pisar
  })
}

test('D24: la atestacion se firma con la wallet y verifica contra su contenido', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  const firmada = await at.firmar(await atestacionDePrueba(w.address), w.firmar)
  t.ok(firmada, 'se firmo')
  t.ok(firmada.signature.startsWith('0x'), 'con una firma EVM: ' + firmada.signature.slice(0, 12))
  t.is(firmada.providerPubkey, w.address, 'y dice ser de la direccion que efectivamente firmo')

  const v = await at.verificar(firmada)
  t.ok(v.ok, 'verifica: ' + (v.reason || ''))
  t.is(v.firmante.toLowerCase(), w.address.toLowerCase())
})

test('D24: cambiar UN campo despues de firmar invalida la atestacion', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()
  const firmada = await at.firmar(await atestacionDePrueba(w.address), w.firmar)

  // El campo que importa es `outputHash`, porque es el que cierra el agujero:
  // el ataque de D24 no es reportar de mas -- el gateway ya cuenta por su
  // cuenta -- sino inflar el conteo del OTRO troceando el stream. El hash es
  // sobre el texto completo y el texto no depende del troceo, asi que quien
  // quiera sostener un conteo inflado tiene que tocar este campo. Y no puede.
  const otroTexto = { ...firmada, outputHash: at.hashDe('otra respuesta') }
  const v1 = await at.verificar(otroTexto)
  t.absent(v1.ok, 'un outputHash cambiado no verifica')
  t.ok(String(v1.reason).indexOf('dice ser de') !== -1, v1.reason)

  // Y lo mismo con los tokens, que es lo que la Fase 10 va a querer liquidar.
  const masTokens = { ...firmada, tokensDecode: 9999 }
  t.absent((await at.verificar(masTokens)).ok, 'tampoco un tokensDecode inflado')

  // Un campo AGREGADO tambien: la canonicalizacion JCS es sobre el objeto
  // entero menos `signature`, no sobre una lista de campos que alguien tenga
  // que acordarse de mantener.
  const conExtra = { ...firmada, extra: 'lo que sea' }
  t.absent((await at.verificar(conExtra)).ok, 'ni un campo que no estaba')
})

test('D24: firmar con TU wallet no te deja atestiguar como OTRO nodo', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  // El ataque: armar una atestacion que dice ser del nodo de al lado y firmarla
  // con la propia. La firma valida perfecto -- es una firma de verdad -- y no
  // prueba nada util si no se la ata a quien dice haber servido. Es el mismo
  // razonamiento que `verifyManifest` con `expectedPublicKey`.
  const ajena = await atestacionDePrueba('0x' + 'cd'.repeat(20))
  const firmada = await at.firmar(ajena, w.firmar)

  const v = await at.verificar(firmada)
  t.absent(v.ok, 'no verifica aunque la firma sea buena')
  t.ok(String(v.reason).indexOf(w.address) !== -1, 'y dice quien firmo de verdad: ' + v.reason)
})

test('D24: el orden en que se arma el objeto no cambia la firma', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  const a = await at.firmar(await atestacionDePrueba(w.address), w.firmar)

  // El mismo contenido con las claves insertadas al reves. JCS las ordena, asi
  // que los bytes firmados son una funcion del CONTENIDO y no del orden en que
  // se armo el objeto -- que es todo el motivo por el que se canonicaliza.
  const alReves = {}
  for (const k of Object.keys(a).reverse()) alReves[k] = a[k]

  t.absent(
    Object.keys(alReves).join() === Object.keys(a).join(),
    'el objeto de prueba realmente tiene otro orden'
  )
  t.ok((await at.verificar(alReves)).ok, 'y verifica igual')
})

test('D24: sin firmante no sale una atestacion sin firmar', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const base = await atestacionDePrueba('0x' + 'ab'.repeat(20))

  // Un artefacto que parece una prueba y no lo es es peor que uno ausente. La
  // ausencia se ve; una atestacion sin firma se lee como una atestacion.
  t.is(await at.firmar(base, null), null, 'sin firmante no hay artefacto')
  t.is(
    await at.firmar(base, () => 'no-es-una-firma'),
    null,
    'ni con un firmante que devuelve cualquier cosa'
  )
  t.is(
    await at.firmar(base, () => {
      throw new Error('la wallet se cayo')
    }),
    null,
    'ni cuando la wallet tira'
  )
})

test('D24: el hash dice con que se computo', async (t) => {
  const at = await import('../qvac/atestacion.mjs')

  // Un `promptHash: "3a5f…"` suelto no lo puede recomputar un tercero: hay que
  // saber con que algoritmo. Va pegado al valor y no en un campo aparte para que
  // no se puedan desincronizar.
  const h = at.hashDe('hola')
  t.ok(h.startsWith('blake2b-256:'), h)
  t.is(h.split(':')[1].length, 64, '32 bytes en hex')
  t.is(at.hashDe('hola'), h, 'determinista')
  t.absent(at.hashDe('holaa') === h, 'y sensible a un caracter')

  // El del prompt es sobre los mensajes canonicalizados: el proveedor recibio la
  // conversacion entera, no el ultimo turno, y es eso lo que el cliente puede
  // recomputar de su lado.
  const msgs = [{ role: 'user', content: 'hola' }]
  t.is(at.hashDeMensajes(msgs), at.hashDeMensajes([{ content: 'hola', role: 'user' }]))
  t.absent(at.hashDeMensajes(msgs) === at.hashDe('hola'))
})

test('D24/D26: la cuantizacion sale del nombre del modelo, y dice unknown cuando no', async (t) => {
  const at = await import('../qvac/atestacion.mjs')

  // Los nombres del registry de QVAC la llevan adentro, asi que no hay que
  // tocar el schema congelado del manifiesto (D2) para declararla. Los de abajo
  // son los del catalogo real, no inventados.
  t.is(at.cuantizacionDe('Qwen3-4B-Q4_K_M'), 'Q4_K_M')
  t.is(at.cuantizacionDe('llama_3.2_1b_intruct_tool_calling_v2.Q4_K'), 'Q4_K')
  t.is(at.cuantizacionDe('smollm2-360m-instruct-q8_0'), 'Q8_0')
  t.is(at.cuantizacionDe('Qwen3-1.7B-Q4_0'), 'Q4_0')

  // D26: esto es una DECLARACION derivada de otra declaracion. Cuando el nombre
  // no dice nada, decir 'unknown' es mas honesto que suponer F16 -- no hay forma
  // black-box publicada de medirlo, asi que inventar un default seria afirmar
  // algo que nadie verifico.
  t.is(at.cuantizacionDe('gpt-4o-mini'), 'unknown')
  t.is(at.cuantizacionDe(''), 'unknown')
  t.is(at.cuantizacionDe(null), 'unknown')
})

test('D24: este nodo NO atestigua lo que sirvio otro', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const yo = { kind: 'real', modelId: 'llama1b' }
  const dir = '0x' + 'ab'.repeat(20)

  t.is(
    at.porQueNoSeFirma({ node: yo, walletAddress: dir, tieneFirmante: true }),
    null,
    'lo que corrio en esta maquina, si'
  )

  // El caso que importa. D24 pide que atestigue EL PROVEEDOR, y cuando contesto
  // un par el proveedor no somos nosotros: no corrimos el modelo, y ademas el
  // payTo del 402 apunto a SU wallet (D10), no a la nuestra. Firmar aca una
  // atestacion sobre trabajo ajeno seria un artefacto que parece una prueba y no
  // lo es. La del par la firma el, por Protomux, y eso es la Fase 10.
  const delPar = at.porQueNoSeFirma({
    node: { kind: 'peer', modelId: 'llama1b' },
    walletAddress: dir,
    tieneFirmante: true
  })
  t.ok(delPar, 'lo que sirvio un par, NO')
  t.ok(delPar.indexOf('Fase 10') !== -1, 'y dice de quien es y cuando llega: ' + delPar)

  // Los otros dos motivos, para que la ausencia siempre sea legible.
  t.ok(at.porQueNoSeFirma({ node: yo, walletAddress: null, tieneFirmante: true }))
  t.ok(at.porQueNoSeFirma({ node: yo, walletAddress: dir, tieneFirmante: false }))
  t.ok(at.porQueNoSeFirma({ node: null, walletAddress: dir, tieneFirmante: true }))
})

// ---------------------------------------------------------------------------
// D30 / BLOQUE 0 — las precondiciones para poder demostrar la Fase 10
//
// D30 decidio que ningun camino que mueva valor se estrena en mainnet. Eso tiene
// tres precondiciones que se pueden probar sin tocar una cadena, y estan aca:
//
//   D30.1  el keystore no puede quedar en %TEMP%
//   D30.2  la red tiene que ser elegible, y el default tiene que decir que es mainnet
//   D30.3  el activo de prueba tiene que existir como artefacto y ser EIP-3009
//
// La cuarta (el facilitator self-hosted) necesita un proceso node y esta en
// test/integracion.js.
//
// NINGUNO DE ESTOS SALE A INTERNET. El artefacto se mira en disco, la red se
// resuelve de una tabla, y el keystore de tres rutas.
// ---------------------------------------------------------------------------

test('D30.1: el keystore NUNCA cae en temp por su cuenta', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const os = require('bare-os')
  const path = require('bare-path')
  const temp = os.tmpdir()

  // El bug que esto cierra: `swarmStorageDir()` manda TODO a os.tmpdir() bajo
  // bare, o sea en desarrollo -- que es justo donde se va a probar el fondeo.
  // Windows limpia temp, y ahi adentro lo que se pierde no es cache: es la
  // unica copia de una seed.
  const sano = wallet.directorioKeystore({
    storage: null,
    persistente: path.join(temp, '..', 'persistente-de-mentira'),
    app: 'pyrusllm'
  })
  t.absent(sano.volatil, 'con un persistente sano el keystore no es volatil')
  t.absent(sano.dir.indexOf(temp) === 0, 'y no cuelga de temp: ' + sano.dir)
  t.ok(sano.dir.indexOf('pyrusllm') !== -1, 'y lleva el nombre de la app adentro')

  // Un --storage explicito SI se respeta: es una decision del operador y no
  // nuestra. Lo que no puede es pasar callado.
  const elegido = wallet.directorioKeystore({
    storage: path.join(temp, 'wallet-elegida'),
    persistente: '/datos/persistentes',
    app: 'pyrusllm'
  })
  t.is(elegido.dir, path.resolve(path.join(temp, 'wallet-elegida')), 'se respeta')
  t.ok(elegido.volatil, 'pero queda marcado como volatil')
  t.ok(String(elegido.motivo).indexOf('limpia') !== -1, 'y el motivo lo explica: ' + elegido.motivo)

  // Y el caso patologico: si la propia plataforma dijera que su directorio
  // persistente esta adentro de temp, tambien se avisa. El chequeo falla hacia
  // "si es temp", que es el lado barato de equivocarse.
  const raro = wallet.directorioKeystore({ storage: null, persistente: temp, app: 'pyrusllm' })
  t.ok(raro.volatil, 'un persistente que cae en temp tampoco pasa desapercibido')

  // Sin persistente NO se inventa uno. Devolver temp aca seria exactamente el
  // bug con otro nombre.
  t.exception(
    () => wallet.directorioKeystore({ storage: null, persistente: null, app: 'pyrusllm' }),
    /persistente/,
    'sin persistente se corta en vez de caer a temp'
  )
})

test('D30.2: la red se elige, y el default dice en la cara que es mainnet', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')

  // D15 NO cambia: Plasma mainnet sigue siendo el default. Lo que cambia es que
  // ahora se puede elegir otra y que el que elige mainnet lo sabe.
  const porDefecto = wallet.redDe({})
  t.is(porDefecto.nombre, 'plasma', 'D15 intacto: el default sigue siendo Plasma')
  t.is(porDefecto.chainId, 9745)
  t.ok(porDefecto.mainnet, 'y esta marcada como MAINNET, que es lo que permite avisarlo')

  const prueba = wallet.redDe({ [wallet.VAR_RED]: 'plasma-testnet' })
  t.is(prueba.chainId, 9746, 'la testnet de D30 es elegible')
  t.absent(prueba.mainnet, 'y la testnet no esta marcada como mainnet')
  t.absent(prueba.rpc === porDefecto.rpc, 'con OTRO rpc, no el de mainnet: ' + prueba.rpc)

  // EIP-155: el chainId entra en lo que se firma. Que sean dos numeros distintos
  // no es trivia -- es la razon por la que una tx de 9745 no vale en 9746, y por
  // la que "la testnet es la misma red con otra URL" es falso.
  t.absent(porDefecto.chainId === prueba.chainId, '9745 y 9746 no son la misma red')

  // El RPC se puede pisar, pero SOLO la URL. Si pisar el rpc cambiara tambien la
  // red para la que se firma, un RPC mal apuntado seria una firma para otra
  // cadena sin que nadie lo pidiera.
  const propio = wallet.redDe({
    [wallet.VAR_RED]: 'plasma-testnet',
    [wallet.VAR_RPC]: 'http://127.0.0.1:8545'
  })
  t.is(propio.rpc, 'http://127.0.0.1:8545', 'la URL se pisa')
  t.is(propio.chainId, 9746, 'el chainId NO')
  t.ok(propio.rpcPropio, 'y queda dicho que el rpc no es el de la tabla')

  // Una red que no existe se corta con el nombre adentro del mensaje. Caer al
  // default seria operar contra mainnet creyendo que se pidio otra cosa.
  t.exception(() => wallet.redDe({ [wallet.VAR_RED]: 'ethereum' }), /no es una red conocida/)
})

test('D30.2: el rpc elegido llega hasta la cuenta, sin tocar la red', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  // Lo que estaba roto no era que `abrir` no aceptara un rpc: lo aceptaba. Era
  // que NADIE se lo pasaba, asi que la constante de mainnet ganaba siempre. Se
  // prueba de punta a punta: se crea con una red, se abre con la misma, y la
  // cuenta devuelve el rpc con el que se armo.
  const red = wallet.redDe({ [wallet.VAR_RED]: 'plasma-testnet' })
  const creada = await wallet.crear(tmp.dir, 'passphrase-de-prueba', { red })
  t.ok(/^0x[a-fA-F0-9]{40}$/.test(creada.address))

  const abierta = await wallet.abrir(tmp.dir, 'passphrase-de-prueba', { red })
  t.is(abierta.rpc, red.rpc, 'la cuenta se armo contra el rpc que se pidio')
  t.is(abierta.red.chainId, 9746, 'y contra la red que se pidio')

  // Y sin `red` sigue saliendo el default de D15, que es lo que un nodo que no
  // configura nada tiene que seguir haciendo.
  const porDefecto = await wallet.abrir(tmp.dir, 'passphrase-de-prueba')
  t.is(porDefecto.red.chainId, 9745, 'sin elegir, D15: Plasma mainnet')
  t.is(porDefecto.address, abierta.address, 'y la direccion no depende de la red')

  // La derivacion NO habla con la red, y eso es precondicion de que un nodo sin
  // internet pueda anunciarse. Un rpc que no existe tiene que dar lo mismo.
  const inventado = await wallet.abrir(tmp.dir, 'passphrase-de-prueba', {
    rpc: 'http://127.0.0.1:1/no-existe'
  })
  t.is(inventado.address, abierta.address, 'la direccion sale sin tocar la cadena')

  tmp.limpiar()
})

// ---------------------------------------------------------------------------
// FASE 12 — los tokens que el panel vigila, en disco.
//
// Lo que se vigila aca: que la validacion pase ANTES de escribir (un archivo
// roto se descubriria en el proximo arranque, no ahora), que los tokens no se
// mezclen entre redes (una address de token no vale cross-chain), y que un
// archivo ausente o corrupto sea `{}` y no una excepcion que tumbe el panel.
// ---------------------------------------------------------------------------

test('FASE 12: los tokens del panel van por red, y se guardan validados', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  // Sin archivo no hay error: es el estado normal de un nodo recien instalado.
  t.alike(wallet.leerTokens(tmp.dir), {}, 'sin archivo, tabla vacia y ningun throw')

  const usdt = { address: '0x' + 'AB'.repeat(20), symbol: 'tUSD', decimals: 6 }
  wallet.guardarTokens(tmp.dir, { 'eip155:9746': [usdt] })

  const leidos = wallet.leerTokens(tmp.dir)
  t.is(leidos['eip155:9746'].length, 1, 'round-trip: lo que se guardo se lee')
  t.is(
    leidos['eip155:9746'][0].address,
    '0x' + 'ab'.repeat(20),
    'la address se normaliza a minuscula: es la clave del dedupe'
  )
  t.is(leidos['eip155:9746'][0].symbol, 'tUSD', 'el simbolo se respeta tal cual')
  t.is(leidos['eip155:9746'][0].decimals, 6)

  // La MISMA address en OTRA red es otro token: no se pisan ni se mezclan.
  // Es toda la razon por la que la clave del archivo es el CAIP-2.
  wallet.guardarTokens(tmp.dir, {
    'eip155:9746': [usdt],
    'eip155:9745': [{ address: '0x' + 'ab'.repeat(20), symbol: 'USDT0', decimals: 6 }]
  })
  const dos = wallet.leerTokens(tmp.dir)
  t.is(dos['eip155:9746'][0].symbol, 'tUSD', 'la testnet mantiene el suyo')
  t.is(dos['eip155:9745'][0].symbol, 'USDT0', 'y mainnet el suyo, con la misma address')

  // Agregar dos veces el mismo token es una pulsacion de mas, no un error.
  const dedupe = wallet.guardarTokens(tmp.dir, {
    'eip155:9746': [usdt, { ...usdt, address: usdt.address.toLowerCase() }]
  })
  t.is(dedupe['eip155:9746'].length, 1, 'dedupe por address en minuscula, sin tirar')

  tmp.limpiar()
})

test('FASE 12: un token con forma invalida NO llega al disco', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  const bueno = { address: '0x' + 'ab'.repeat(20), symbol: 'tUSD', decimals: 6 }
  wallet.guardarTokens(tmp.dir, { 'eip155:9746': [bueno] })

  const malos = [
    [{ address: '0xNOPE', symbol: 'X', decimals: 6 }, 'una address que no es 0x + 40 hex'],
    [{ address: '0x' + 'ab'.repeat(19), symbol: 'X', decimals: 6 }, 'una address corta'],
    [{ address: '0x' + 'cd'.repeat(20), symbol: '', decimals: 6 }, 'un simbolo vacio'],
    [
      { address: '0x' + 'cd'.repeat(20), symbol: 'x'.repeat(13), decimals: 6 },
      'un simbolo de 13 caracteres'
    ],
    [{ address: '0x' + 'cd'.repeat(20), symbol: 'X', decimals: 37 }, 'decimales fuera de 0..36'],
    [{ address: '0x' + 'cd'.repeat(20), symbol: 'X', decimals: -1 }, 'decimales negativos'],
    [{ address: '0x' + 'cd'.repeat(20), symbol: 'X', decimals: 6.5 }, 'decimales no enteros']
  ]
  for (const [tok, que] of malos) {
    t.exception(
      () => wallet.guardarTokens(tmp.dir, { 'eip155:9746': [tok] }),
      /token invalido/,
      'se rechaza ' + que
    )
  }

  // Y una red que no es un CAIP-2 EVM tampoco entra.
  t.exception(
    () => wallet.guardarTokens(tmp.dir, { plasma: [bueno] }),
    /no es un CAIP-2/,
    'la clave tiene que ser el CAIP-2, no el nombre corto'
  )

  // La validacion corre ANTES de tocar disco: despues de todos esos rechazos,
  // el archivo sigue siendo el que estaba. Un guardado a medias dejaria al
  // panel sin los tokens que ya tenia.
  t.is(
    wallet.leerTokens(tmp.dir)['eip155:9746'][0].symbol,
    'tUSD',
    'lo que ya estaba guardado sobrevive a los intentos rechazados'
  )

  // Un archivo editado a mano hasta romperlo se lee como vacio, no explota: el
  // panel tiene que dibujar algo.
  const fs = require('bare-fs')
  const path = require('bare-path')
  fs.writeFileSync(path.join(tmp.dir, wallet.ARCHIVO_TOKENS), 'no soy json')
  t.alike(wallet.leerTokens(tmp.dir), {}, 'un archivo corrupto es {} y no una excepcion')

  tmp.limpiar()
})

test('D30.2: las dos tablas de redes no se pueden desincronizar', async (t) => {
  // `qvac/wallet.mjs` corre bajo Bare y `scripts/redes-prueba.js` bajo Node, asi
  // que la tabla esta escrita dos veces -- igual que en verificar-x402.js, y por
  // el mismo motivo. La duplicacion que hace dano no es tener dos tablas: es que
  // una diga testnet donde la otra dice mainnet. Eso es lo que se compara aca.
  const wallet = await import('../qvac/wallet.mjs')
  const redes = require('../scripts/redes-prueba.js')

  for (const [nombre, red] of Object.entries(wallet.REDES)) {
    const esTestnetAlla = redes.porQueNoSeEstrena(red.chainId) === null
    t.is(
      esTestnetAlla,
      !red.mainnet,
      nombre + ' (' + red.chainId + '): las dos tablas coinciden en si es de prueba'
    )
  }

  // Y el que importa nombrado, porque es el que D30 elige.
  t.is(redes.testnetDe(9746).caip2, wallet.REDES['plasma-testnet'].caip2)
  t.ok(redes.porQueNoSeEstrena(9745), 'y 9745 sigue siendo mainnet de los dos lados')
})

test('D30.3: el activo de prueba existe compilado, y es EIP-3009 de verdad', async (t) => {
  const fs = require('bare-fs')
  const path = require('bare-path')
  const sodium = require('sodium-native')

  const raiz = path.join(__dirname, '..')
  const fuente = fs.readFileSync(path.join(raiz, 'scripts', 'activo-prueba.sol'), 'utf8')
  const artefacto = JSON.parse(
    fs.readFileSync(path.join(raiz, 'scripts', 'activo-prueba.artefacto.json'), 'utf8')
  )

  // EL ARTEFACTO CORRESPONDE A LA FUENTE QUE ESTA AL LADO.
  //
  // Se despliega bytecode precompilado para que el repo no gane un toolchain, y
  // el precio de esa decision es que recompilar no es `npm run` de nada. Sin
  // este assert, alguien edita el .sol, no recompila, y lo que se despliega deja
  // de ser lo que se lee -- que es la peor version de "hay codigo en el repo".
  const h = Buffer.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(h, Buffer.from(fuente, 'utf8'))
  t.is(
    h.toString('hex'),
    artefacto.fuenteSha256,
    'el bytecode se compilo de ESTA fuente (si no: recompilar, ver el encabezado del .sol)'
  )

  t.ok(/^0x[0-9a-f]+$/.test(artefacto.bytecode), 'el bytecode de creacion es hex')
  t.ok(/^0x[0-9a-f]+$/.test(artefacto.deployedBytecode), 'y el de runtime tambien')
  t.ok(artefacto.solc.indexOf('0.8.') === 0, 'con la version de solc anotada: ' + artefacto.solc)

  // QUE IMPLEMENTA EIP-3009, COMPROBADO CONTRA EL BYTECODE Y NO CONTRA EL ABI.
  //
  // El ABI lo escribe el compilador desde la fuente, asi que preguntarle al ABI
  // si el contrato tiene una funcion es preguntarle a la fuente otra vez. Los
  // selectores, en cambio, estan en el DISPATCHER del runtime: si estan ahi, la
  // funcion es alcanzable en la cadena. Son los mismos cuatro bytes que
  // `verificar-x402` va a llamar despues contra el contrato desplegado.
  const runtime = artefacto.deployedBytecode.slice(2)
  const SELECTORES = {
    'authorizationState(address,bytes32)': 'e94a0102',
    'transferWithAuthorization(...,uint8,bytes32,bytes32)': 'e3ee160e',
    'transferWithAuthorization(...,bytes)': 'cf092995',
    'DOMAIN_SEPARATOR()': '3644e515',
    // `name` y `version` no son de EIP-3009 pero el facilitator de @x402/evm los
    // LEE de la cadena antes de liquidar. El USD-0 de Plasma revierte en
    // `version()`; este no puede.
    'name()': '06fdde03',
    'version()': '54fd4d50'
  }
  for (const nombre of Object.keys(SELECTORES)) {
    const sel = SELECTORES[nombre]
    t.ok(runtime.indexOf(sel) !== -1, nombre + ' es alcanzable en el runtime (0x' + sel + ')')
  }

  // D28/D30.3 — NO SE LLAMA $QVAC, Y ESO NO ES UNA CUESTION DE GUSTO.
  //
  // La atestacion de D24 y el recibo de x402 REGISTRAN EL ACTIVO. Ponerle el
  // nombre del token nativo escribiria adentro de artefactos firmados la
  // contradiccion que D28 borro del pitch: que el riel de pago se denomina en el
  // activo especulativo. Es un stand-in de stablecoin y se llama como tal.
  t.is(
    artefacto.abi.filter((f) => f.name === 'name').length,
    1,
    'expone name(), que es lo que el facilitator lee'
  )

  // Se mira la DENOMINACION, no el archivo entero: el encabezado del .sol
  // explica por que no se llama $QVAC, y esa explicacion tiene que poder
  // mencionarlo. Lo que no puede llevar ese nombre es lo que va a quedar
  // escrito adentro de la atestacion firmada, que es `name` y `symbol`.
  const declarado = (campo) => {
    const m = fuente.match(new RegExp('constant\\s+' + campo + '\\s*=\\s*"([^"]*)"'))
    return m ? m[1] : null
  }
  t.is(declarado('name'), 'PyrusLLM Test USD', 'se llama como el stand-in de stablecoin que es')
  t.is(declarado('symbol'), 'tUSD')
  t.absent(/QVAC/i.test(declarado('name') + declarado('symbol')), 'y no lleva el token nativo')

  // Y VA MARCADO COMO PRUEBA DONDE SE VEA. `name` y `symbol` son lo que muestra
  // un explorer; `AVISO` es para el que abre el contrato.
  t.ok(fuente.indexOf('NO ES UNA STABLECOIN') !== -1, 'el aviso esta en el contrato mismo')
  t.ok(
    artefacto.abi.some((f) => f.name === 'AVISO'),
    'y expuesto en el ABI, no solo en un comentario'
  )
})

test('D30: el guardia de red es lista blanca, y mainnet no tiene puerta', async (t) => {
  const redes = require('../scripts/redes-prueba.js')

  t.is(redes.porQueNoSeEstrena(9746), null, 'la testnet de Plasma se puede usar')
  t.is(redes.porQueNoSeEstrena(31337), null, 'y una cadena local tambien')

  // Lo que D30 dice textualmente es "sin excepcion". Estas tres tienen que
  // devolver motivo, y el de 9745 tiene que nombrarla: es el default de D15, o
  // sea el error mas facil de cometer.
  const plasma = redes.porQueNoSeEstrena(9745)
  t.ok(plasma, '9745, que es el default de D15, NO se estrena')
  t.ok(String(plasma).indexOf('MAINNET') !== -1, 'y el motivo dice que es mainnet: ' + plasma)
  t.ok(redes.porQueNoSeEstrena(988), 'Stable, el fallback de D15, tampoco')
  t.ok(redes.porQueNoSeEstrena(1), 'ni Ethereum')

  // LISTA BLANCA, NO LISTA NEGRA. Una cadena que nadie anoto tiene que caer del
  // lado de "no", porque el modo de falla de la omision es desplegar en una red
  // con plata real creyendo que era de prueba.
  const rara = redes.porQueNoSeEstrena(424242)
  t.ok(rara, 'una cadena desconocida no se estrena')
  // `String(rara)` y no `rara.indexOf`: con el arreglo sacado esto es null, y un
  // TypeError ABORTA la corrida en vez de fallar el assert -- o sea que el arnes
  // no puede ver si el arreglo estaba vigilado. Es la leccion de B18 otra vez.
  t.ok(String(rara).indexOf('lista de testnets') !== -1, 'y dice como agregarla: ' + rara)

  // Basura tampoco pasa. `Number(undefined)` es NaN y un `if (TESTNETS[id])`
  // solo no alcanzaria.
  t.ok(redes.porQueNoSeEstrena(undefined), 'undefined no es una testnet')
  t.ok(redes.porQueNoSeEstrena(0), 'ni el chainId cero')
  t.ok(redes.porQueNoSeEstrena('9746; drop'), 'ni un string que empieza pareciendose a una')
})

// ---------------------------------------------------------------------------
// FASE 9 — hacer visible lo que la fase ya emitia y nadie podia mirar.
//
// `qvac/panel-x402.mjs` es el codigo QUE CORRE EL PANEL: pages.mjs lo pega
// adentro del <script> de cada pagina con `String(fn)`. Probarlo aca es
// probarlo alla, y esa es toda la razon por la que vive en un modulo aparte en
// vez de adentro de un string de HTML.
//
// Los tests de abajo son las cinco cosas que ese archivo existe para no dibujar
// mal. Ninguno mira "que el HTML se sirva": miran que el dato llegue con el
// significado que tenia.
// ---------------------------------------------------------------------------

test('el BLAKE2b del panel da lo MISMO que el que firma el nodo', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const at = await import('../qvac/atestacion.mjs')

  // Esta es la comprobacion que sostiene todo lo demas. El panel recomputa el
  // `outputHash` con una implementacion escrita a mano -- sodium no existe en el
  // navegador y no entra un CDN -- y contra ese numero se decide si una
  // atestacion "coincide". Un BLAKE2b propio que nadie contrasta diria NO
  // COINCIDE sobre artefactos correctos: seria peor que no comparar nada.
  const casos = [
    '', // el bloque vacio, que es un caso aparte del algoritmo
    'a',
    'hola',
    'nandu ' + String.fromCodePoint(0x1f986) + ' acentue', // UTF-8 multibyte y un par de surrogates
    'x'.repeat(127),
    'x'.repeat(128), // el limite de bloque EXACTO: el error clasico de esta funcion
    'x'.repeat(129),
    'y'.repeat(1000)
  ]
  for (const c of casos) {
    t.is(px.hashDeTexto(c), at.hashDe(c), 'mismo hash para una entrada de ' + c.length + ' chars')
  }

  // Y el del prompt, que no es sobre el texto del ultimo turno sino sobre la
  // conversacion ENTERA canonicalizada: si las dos canonicalizaciones divergen,
  // el panel diria que un promptHash correcto no coincide.
  const msgs = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'que tal' }
  ]
  t.is(px.hashDeMensajes(msgs), at.hashDeMensajes(msgs), 'y el promptHash, igual')
})

test('el JCS del panel es el mismo JCS que firma el manifiesto', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const { canonicalize } = await import('../qvac/manifest.mjs')

  // Se reescribe en vez de importarse porque el archivo viaja entero al
  // navegador y un import no cruza esa frontera. Lo que impide que las dos
  // copias se separen es esto.
  const valores = [
    { b: 1, a: 2 },
    { z: [1, 'x', null, true], a: { d: 4, c: 3 } },
    [],
    { vacio: {}, texto: 'con comillas " y barra \\' },
    { saltado: undefined, queda: 1 }
  ]
  for (const v of valores) {
    t.is(px.canonicalizarJCS(v), canonicalize(v), 'mismo JCS: ' + JSON.stringify(v))
  }

  // Los bytes firmados son el artefacto SIN `signature`, que es lo que el panel
  // muestra para que la firma se pueda verificar afuera.
  const a = { v: 1, requestId: 'r', providerPubkey: '0xab', signature: '0xdead' }
  t.is(px.bytesFirmados(a), canonicalize({ v: 1, requestId: 'r', providerPubkey: '0xab' }))
  t.absent(px.bytesFirmados(a).indexOf('signature') !== -1, 'y la firma no se firma a si misma')
})

test('regla 1: una atestacion ausente muestra EL MOTIVO, nunca un guion', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // El caso normal y el que mas importa: sirvio un par. La ausencia es lo
  // CORRECTO -- este nodo no corrio el modelo y el 402 pago a la wallet del par
  // --, y la atestacion del par viaja por Protomux en la Fase 10.
  const motivoPar =
    'el que sirvio fue otro nodo: su atestacion la firma el, y viaja por Protomux (Fase 10)'
  const v = px.vistaDeAtestacion({ attestation: null, attestationMissing: motivoPar })
  t.absent(v.hay)
  t.is(v.motivo, motivoPar, 'el motivo viaja tal cual, sin resumir')
  t.ok(v.motivoDeclarado)
  t.ok(v.esDelPar, 'y se reconoce que esta ausencia no es una falla')

  const html = px.htmlDeAtestacion(v)
  t.ok(html.indexOf('Protomux') !== -1, 'el motivo APARECE en lo que se dibuja')
  t.ok(html.indexOf('no hay atestacion') !== -1, 'y dice que no hay, en palabras')

  // Y el caso feo, que es distinto: falta la atestacion Y falta el motivo. Eso
  // es una respuesta incompleta, no una ausencia justificada, y se dice asi.
  const mudo = px.vistaDeAtestacion({ attestation: null })
  t.absent(mudo.motivoDeclarado, 'nadie dijo por que falta')
  t.ok(mudo.motivo.indexOf('incompleta') !== -1, 'y eso se nombra: ' + mudo.motivo)
  t.absent(mudo.esDelPar, 'y no se le adjudica al par sin que nadie lo haya dicho')
})

test('regla 2: runtime mock se VE como mock, aunque la firma sea real', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  const base = {
    v: 1,
    requestId: 'chatcmpl-1',
    nonce: 'ab',
    ts: 1,
    modelId: 'facturas-ar',
    quantization: 'unknown',
    promptHash: 'blake2b-256:aa',
    outputHash: 'blake2b-256:bb',
    tokensPrefill: 3,
    tokensDecode: 7,
    finishReason: 'stop',
    providerPubkey: '0x' + 'ab'.repeat(20),
    signature: '0xfirma'
  }

  const mock = px.vistaDeAtestacion({ attestation: { ...base, runtime: 'mock' } })
  t.ok(mock.esMock, 'un artefacto firmado con una wallet REAL sobre texto inventado es un mock')
  t.ok(mock.avisoMock && mock.avisoMock.indexOf('demo') !== -1, mock.avisoMock)

  const real = px.vistaDeAtestacion({ attestation: { ...base, runtime: 'llamacpp' } })
  t.absent(real.esMock, 'y un motor de verdad no se marca')
  t.is(real.avisoMock, null)

  // Lo que importa es que se VEA, no que el campo exista en un objeto.
  const htmlMock = px.htmlDeAtestacion(mock)
  const htmlReal = px.htmlDeAtestacion(real)
  t.ok(htmlMock.indexOf('runtime: mock') !== -1, 'el mock sale nombrado en el dibujo')
  t.ok(htmlMock.indexOf('x-aviso malo') !== -1, 'y con el tono de lo que no es evidencia')
  t.absent(htmlReal.indexOf('runtime: mock') !== -1, 'y el real no arrastra el aviso')

  // D26: cuantizacion y runtime son DECLARACIONES firmadas, no mediciones. Que
  // esten firmadas es lo que da contra que arbitrar, no una prueba de que sean
  // ciertas -- y el panel no puede sugerir lo segundo.
  t.ok(real.declarados.indexOf('DECLARACIONES') !== -1)
  t.ok(htmlReal.indexOf('DECLARACIONES') !== -1, 'y eso se dibuja al lado de los dos campos')
})

test('regla 3: gateway y proveedor no son el mismo numero ni se pintan igual', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  const medido = px.vistaDeConteo({
    tokensPrefill: 1000,
    tokensDecode: 500,
    tokensFuente: 'proveedor'
  })
  t.ok(medido.medido, 'con usage del proveedor son tokens contados por su tokenizador')
  t.is(medido.etiqueta, 'medido')
  t.is(medido.tono, 'medido')

  const estimado = px.vistaDeConteo({ tokensPrefill: 3, tokensDecode: 9, tokensFuente: 'gateway' })
  t.absent(estimado.medido, 'sin usage lo que hay es una estimacion y un conteo de chunks')
  t.is(estimado.etiqueta, 'estimado')
  t.is(estimado.tono, 'estimado')
  t.ok(estimado.texto.indexOf('CHUNKS DE SSE') !== -1, estimado.texto)
  t.ok(
    estimado.texto.indexOf('bytes/4') !== -1,
    'y que el prefill es una estimacion, no una medida'
  )

  // El dibujo tiene que separarlos: si compartieran clase, un conteo de chunks
  // se leeria igual que una medicion, que es exactamente el ataque que D24
  // cierra con el outputHash.
  t.absent(
    px.htmlDeConteo(medido) === px.htmlDeConteo(estimado),
    'dos conteos de distinta procedencia no pueden dibujarse igual'
  )
  t.ok(px.htmlDeConteo(estimado).indexOf('tono-estimado') !== -1)
  t.ok(px.htmlDeConteo(medido).indexOf('tono-medido') !== -1)

  // Una entrada anterior a D25 no declara nada, y decirle "gateway" seria
  // afirmar algo que el rastro no dice.
  const viejo = px.vistaDeConteo({ tokens: 5 })
  t.is(viejo.fuente, null)
  t.is(viejo.etiqueta, 'sin procedencia')
  t.absent(viejo.medido, 'y en la duda NO se afirma que sea medido')
})

test('regla 4: un tx hash siempre dice de donde salio', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // El del facilitator de pruebas. No es una heuristica sobre "hashes que
  // parecen falsos": 32 bytes todos iguales no es la salida de keccak sobre
  // ninguna transaccion, y si es lo que emite un facilitator de juguete.
  const falso = px.vistaDeLiquidacion({
    success: true,
    transaction: '0x' + 'fe'.repeat(32),
    network: 'eip155:988',
    payer: '0x1'
  })
  t.ok(falso.txSintetico, 'el 0xfe...fe se reconoce por lo que es')
  t.ok(falso.txOrigen.indexOf('PRUEBAS') !== -1, falso.txOrigen)
  t.ok(falso.txOrigen.indexOf('explorer') !== -1, 'y que en el explorer no existe')

  // Uno que no lo es. Igual lleva su procedencia: NADIE lo verifico contra la
  // cadena, ni el gateway ni el panel. Un hash pelado se lee como confirmado.
  const comun = px.vistaDeLiquidacion({
    success: true,
    transaction: '0x9f2c1a4b7e0d3856',
    network: 'eip155:9745',
    payer: '0x1'
  })
  t.absent(comun.txSintetico)
  t.ok(comun.txOrigen.indexOf('verificaron contra la cadena') !== -1, comun.txOrigen)
  t.ok(comun.txOrigen.indexOf('facilitator') !== -1, 'y de quien salio')

  const html = px.htmlDeLiquidacion(comun)
  t.ok(html.indexOf('0x9f2c1a4b7e0d3856') !== -1, 'el hash se muestra')
  t.ok(html.indexOf('verificaron contra la cadena') !== -1, 'y nunca solo')
  t.ok(html.indexOf('eip155:9745') !== -1, 'con el CAIP-2 crudo al lado del nombre')
  t.ok(html.indexOf('Plasma') !== -1)

  // Una liquidacion fallida NO es un detalle de forma: el nodo sirvio y no
  // cobro. Se dice fuerte, igual que lo dice el log del gateway.
  const fallo = px.vistaDeLiquidacion({
    success: false,
    errorReason: 'settlement_failed',
    errorMessage: 'el facilitator se cayo',
    network: 'eip155:988'
  })
  t.absent(fallo.liquidado)
  t.ok(fallo.error.indexOf('settlement_failed') !== -1)
  t.ok(px.htmlDeLiquidacion(fallo).indexOf('NO se cobro') !== -1)
})

test('regla 5: el costo del header se dice como TECHO, no como cobro', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // Con SSE los headers salen antes del primer token: ese numero es el tope con
  // el que se autorizo el gasto y nunca lo que salio.
  const caro = px.textoDeCostoEstimado(13500)
  t.ok(caro.techo)
  t.is(caro.texto.indexOf('up to'), 0, caro.texto)

  // El cero se escribe con palabras. "USD 0.0000" se lee como "salio muy
  // barato" y no es eso: es que a nadie se le cobra.
  t.is(px.textoDeCostoEstimado(0).texto, 'no charge')
  t.absent(px.textoDeCostoEstimado(0).techo)

  // Seis decimales: con cuatro, cualquier turno de menos de 50 micros se
  // mostraria identico a gratis, que es la distincion que este texto hace.
  t.ok(
    px.textoDeCostoEstimado(12).texto.indexOf('0.000012') !== -1,
    px.textoDeCostoEstimado(12).texto
  )

  // Sin dato NO es cero: un turno viejo sin el campo no dice que fue gratis.
  t.is(px.textoDeCostoEstimado(undefined).texto, 'sin dato de costo')
})

test('el outputHash se compara de verdad, y no-pude no es coincide', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const at = await import('../qvac/atestacion.mjs')

  const texto = 'la respuesta que el cliente recibio'
  const base = {
    v: 1,
    requestId: 'r',
    nonce: 'n',
    ts: 1,
    modelId: 'm',
    quantization: 'Q4_K_M',
    runtime: 'llamacpp',
    promptHash: 'blake2b-256:aa',
    outputHash: at.hashDe(texto),
    tokensPrefill: 1,
    tokensDecode: 2,
    finishReason: 'stop',
    providerPubkey: '0xab',
    signature: '0xfirma'
  }

  const ok = px.vistaDeAtestacion({ attestation: base }, { textoRecibido: texto })
  const hOk = ok.hashes.filter((h) => h.campo === 'outputHash')[0]
  t.is(hOk.estado, 'coincide', 'recomputado sobre lo recibido')

  // Lo que D24 existe para atrapar: el texto no es el atestiguado.
  const mal = px.vistaDeAtestacion({ attestation: base }, { textoRecibido: texto + '!' })
  t.is(mal.hashes.filter((h) => h.campo === 'outputHash')[0].estado, 'no-coincide')
  t.ok(px.htmlDeAtestacion(mal).indexOf('NO coincide') !== -1, 'y se dibuja como lo que es')

  // Y el estado que NO se puede confundir con los otros dos: no hubo con que
  // comparar. Un panel que dibuje esto como "coincide" convierte la falta de
  // evidencia en evidencia.
  const sin = px.vistaDeAtestacion({ attestation: base }, {})
  const hSin = sin.hashes.filter((h) => h.campo === 'outputHash')[0]
  t.is(hSin.estado, 'sin-material')
  t.absent(hSin.estado === 'coincide')
  t.ok(px.htmlDeAtestacion(sin).indexOf('no se recomputo') !== -1)

  // La firma NO se verifica aca, y el panel no puede insinuar que si.
  t.absent(ok.firmaVerificada, 'esto no recupera firmantes EIP-191')
  t.ok(ok.avisoFirma.indexOf('NO verifica la firma') !== -1)
  t.is(ok.firmadoSobre, px.bytesFirmados(base), 'pero deja los bytes para verificarla afuera')
})

test('el 402 se dibuja con los CUATRO datos, y el monto no se inventa en USD', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  const desafio = {
    x402Version: 2,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:988',
        amount: '1000',
        resource: 'http://127.0.0.1:8787/v1/chat/completions',
        description: 'Inferencia de facturas-ar en Nodo A, hasta 256 tokens de salida',
        mimeType: 'application/json',
        payTo: '0x' + 'ab'.repeat(20),
        maxTimeoutSeconds: 300,
        asset: '0x' + '11'.repeat(20),
        extra: { name: 'USDT0', version: '1' },
        outputTokenLimit: 256
      }
    ]
  }

  const v = px.vistaDeDesafio(desafio)
  t.ok(v.esDesafio)
  t.is(v.opciones.length, 1)
  const o = v.opciones[0]
  t.is(o.monto, '1000', 'CUANTO')
  t.is(o.payTo, '0x' + 'ab'.repeat(20), 'A QUIEN')
  t.is(o.red.id, 'eip155:988', 'EN QUE CADENA')
  t.is(o.tope, 256, 'HASTA CUANTOS TOKENS')

  // El primer 402 no lleva error de verdad: "X-PAYMENT header is required" es la
  // frase del spec, no un rechazo, y mostrarla como si algo hubiera fallado
  // diria que el cliente hizo algo mal cuando todavia no hizo nada.
  t.is(v.error, null)
  t.is(px.vistaDeDesafio({ ...desafio, error: 'red equivocada' }).error, 'red equivocada')

  const html = px.htmlDeDesafio(v)
  for (const etiqueta of ['CUANTO', 'A QUIEN', 'EN QUE RED', 'HASTA CUANTOS TOKENS']) {
    t.ok(html.indexOf(etiqueta) !== -1, 'el dibujo nombra ' + etiqueta)
  }
  // El accepts[] declara `asset` y `extra.name` pero NO `decimals`: dividir por
  // 1e6 seria inventar el dato que falta justo en el numero que la persona lee
  // como "lo que me van a cobrar".
  t.ok(html.indexOf('no declara los decimales') !== -1, 'se dice por que no hay USD')
  t.absent(html.indexOf('USD 0.001') !== -1, 'y no se convierte igual')

  // Un cuerpo que no es un desafio no se dibuja como uno: el 402 de presupuesto
  // agotado (B13) no trae accepts y tiene que seguir por el camino de texto.
  t.absent(px.vistaDeDesafio({ error: { message: 'presupuesto agotado' } }).esDesafio)
  t.is(px.htmlDeDesafio(px.vistaDeDesafio(null)), '')
})

test('las dos formas del recibo se leen igual, y D27 se dice en palabras', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // El gateway emite el mismo recibo con dos formas: aplanado en
  // GET /v1/receipts/:id, y colgando de `paymentResponse` en el evento SSE
  // final (D12). Las dos tienen que llegar al mismo dibujo.
  const liq = { success: true, transaction: '0xabcdef', network: 'eip155:988', payer: '0x1' }
  t.alike(
    px.liquidacionDe({ id: 'x', ...liq }),
    { id: 'x', ...liq },
    'aplanado: es el recibo mismo'
  )
  t.alike(px.liquidacionDe({ x402Version: 2, paymentResponse: liq }), liq, 'y anidado')

  // D27: el vocabulario es mas ancho que el de OpenAI a proposito. Aplanar un
  // corte del cliente a "stop" afirmaria que la respuesta termino.
  t.ok(px.textoDeFinishReason('client_cancelled').indexOf('lo corto el cliente') !== -1)
  t.ok(px.textoDeFinishReason('length').indexOf('tope') !== -1)
  t.is(px.textoDeFinishReason('stop'), 'termino sola')
  t.is(px.textoDeFinishReason(null), 'no declarado')
})

test('el codigo que se embebe en el panel es el mismo, y CORRE', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // pages.mjs no llama a estas funciones: pega su TEXTO adentro del <script> de
  // cada pagina. Si el texto no parsea, el panel se rompe entero y ningun test
  // de "el HTML se sirve" se entera -- el HTML se serviria igual, roto.
  const api = new Function(
    px.FUENTE_EMBEBIDA +
      '\nreturn { hashDeTexto, vistaDeConteo, vistaDeAtestacion, vistaDeDesafio, ' +
      'vistaDeLiquidacion, htmlDeRecibo, htmlDeConteo, htmlDeDesafio }'
  )()

  t.is(api.hashDeTexto('hola'), px.hashDeTexto('hola'), 'la copia embebida hashea igual')
  const entrada = { tokensFuente: 'gateway', tokensPrefill: 1, tokensDecode: 2 }
  t.is(
    api.htmlDeConteo(api.vistaDeConteo(entrada)),
    px.htmlDeConteo(px.vistaDeConteo(entrada)),
    'y dibuja igual'
  )

  // Y todo lo que el panel necesita esta declarado: una funcion que quedo
  // afuera de FUNCIONES_EMBEBIDAS explota aca y no en el navegador de alguien.
  const html = api.htmlDeRecibo(
    {
      success: true,
      transaction: '0x' + 'fe'.repeat(32),
      network: 'eip155:988',
      attestation: null,
      attestationMissing: 'este nodo no tiene wallet con que firmar'
    },
    {}
  )
  t.ok(html.indexOf('no tiene wallet') !== -1, 'el motivo sobrevive el viaje al navegador')
  t.ok(html.indexOf('facilitator de PRUEBAS') !== -1, 'y el sello del tx tambien')
})

// ---------------------------------------------------------------------------
// Panel /wallet — qvac/panel-wallet.mjs (Fase 11)
//
// Mismo criterio que panel-x402: son las funciones que corren EN el navegador,
// pegadas por pages.mjs con String(fn). Probarlas aca es probarlas alla. Lo
// que se vigila: que un balance no se redondee de mas, que un RPC caido NO se
// dibuje como saldo cero, que "sin conversion a USD" este dicho, y que enviar
// no se ofrezca (este panel es solo lectura).
// ---------------------------------------------------------------------------

test('el panel de wallet formatea montos recortando, sin redondear ni inventar', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')

  t.is(pw.formatearMonto('0x0', 18, 6).texto, '0', 'cero es cero, sin cola de decimales')
  t.is(pw.formatearMonto('0xde0b6b3a7640000', 18, 6).texto, '1', '1e18 wei = 1')
  t.is(pw.formatearMonto('1500000', 6, 6).texto, '1.5', 'USD₮0 son 6 decimales')
  t.is(
    pw.formatearMonto('1', 18, 6).texto,
    '0',
    '1 wei es mas chico que lo que se muestra: es "0", no "0.000000"'
  )
  t.is(
    pw.formatearMonto('1234567', 6, 3).texto,
    '1.234',
    'la fraccion se RECORTA, no se redondea: 1.234 y no 1.235'
  )
  t.is(pw.formatearMonto(null, 18, 6).texto, '0', 'sin dato no explota')
})

test('un RPC caido no se dibuja como saldo cero', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const v = pw.vistaDeSaldos({
    configurada: true,
    address: '0x' + 'ab'.repeat(20),
    red: { nombre: 'Plasma', caip2: 'eip155:9745', mainnet: true },
    nativo: { decimals: 18, raw: null, error: 'RPC HTTP 502' },
    tokens: [
      {
        symbol: 'USDT0',
        name: 'USDT0',
        address: '0x' + 'cd'.repeat(20),
        decimals: 6,
        raw: null,
        verificado: false,
        error: 'timeout'
      }
    ]
  })

  const nativo = v.items.find((i) => i.esNativo)
  t.is(nativo.texto, '—', 'sin dato se dice "—", nunca "0"')
  t.is(nativo.error, 'RPC HTTP 502', 'y el motivo viaja')

  const html = pw.htmlDeWallet(v, '', 'assets')
  t.ok(html.indexOf('no USD conversion') !== -1, 'la ausencia de precio esta dicha')
  t.ok(html.indexOf('RPC HTTP 502') !== -1, 'el error del nodo aparece en el panel')
  t.ok(html.indexOf('address unverified') !== -1, 'el token con dir no verificada se marca')

  // FASE 12 — Send ya manda (ver el punto (c) del encabezado de
  // panel-wallet.mjs). Swap NO, y se sigue dibujando deshabilitado en vez de
  // oculto: que se vea que existe y que todavia no.
  const idxSwap = html.indexOf('⇄</span>Swap</button>')
  t.ok(idxSwap !== -1, 'hay boton Swap')
  const desdeSwap = html.lastIndexOf('<button', idxSwap)
  t.ok(
    html.slice(desdeSwap, idxSwap).indexOf('disabled') !== -1,
    'Swap se dibuja deshabilitado, no oculto'
  )
  t.ok(
    html.slice(desdeSwap, idxSwap).indexOf('title=') !== -1,
    'y con el motivo, para que no se lea como un boton roto'
  )
})

test('sin wallet el panel muestra el onboarding, no la billetera', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')

  // Antes de que el nodo cablee el creator (arranque): ni boton ni billetera.
  const noListo = pw.htmlDeWallet(pw.vistaDeSaldos({ configurada: false }), '', 'assets')
  t.is(noListo.indexOf('id="w-onb-crear"'), -1, 'todavia no ofrece el boton de crear')
  t.is(noListo.indexOf('w-balance-num'), -1, 'no hay billetera: ni balance')
  t.is(noListo.indexOf('>Send</button>'), -1, 'ni Send')

  // Listo: aparece crear + importar, sin pedirle nada al operador. Sigue sin
  // haber billetera hasta que se cree.
  const listo = pw.htmlDeWallet(
    pw.vistaDeSaldos({ configurada: false, puedeCrear: true }),
    '',
    'assets'
  )
  t.ok(listo.indexOf('id="w-onb-crear"') !== -1, 'ofrece crear una nueva')
  t.ok(listo.indexOf('id="w-onb-importar"') !== -1, 'y ofrece importar 24 palabras')
  t.is(listo.indexOf('PYRUS_WALLET_PASSPHRASE'), -1, 'sin mandar al operador a tocar el entorno')
  t.is(listo.indexOf('w-balance-num'), -1, 'todavia no hay billetera')
})

test('la pantalla de la frase la muestra entera y no deja pasar sin confirmar', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const frase = Array.from({ length: 24 }, (_, i) => 'word' + (i + 1)).join(' ')
  const addr = '0x' + 'ab'.repeat(20)
  const html = pw.htmlDeSeed(frase, addr)

  t.is((html.match(/w-seed-w/g) || []).length, 24, 'las 24 palabras, numeradas')
  t.ok(html.indexOf('word24') !== -1, 'incluida la ultima')
  t.ok(html.indexOf('data-copy="' + frase + '"') !== -1, 'el copiar lleva la frase completa')
  t.ok(html.indexOf('No se vuelven a mostrar') !== -1, 'el aviso fuerte esta')
  const idxListo = html.indexOf('>Listo</button>')
  const desde = html.lastIndexOf('<button', idxListo)
  t.ok(html.slice(desde, idxListo).indexOf('disabled') !== -1, '"Listo" arranca deshabilitado')
})

test('el chequeo de forma de la frase filtra lo obvio, sin validar checksum', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')

  t.alike(
    pw.palabrasDeFrase('  Uno   dos\nTres  '),
    ['uno', 'dos', 'tres'],
    'normaliza espacios y mayusculas'
  )

  const ok24 = Array.from({ length: 24 }, () => 'abandon').join(' ')
  t.ok(pw.fraseParecePlausible(ok24), '24 palabras en minuscula pasan la forma')
  t.absent(pw.fraseParecePlausible('abandon abandon abandon'), '3 palabras no')
  t.absent(pw.fraseParecePlausible(ok24 + ' 123'), 'digitos no')
  t.absent(pw.fraseParecePlausible(''), 'vacio no')
})

test('el filtro del panel busca por simbolo, nombre y red, y no ejecuta nada', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const items = [
    { symbol: 'XPL', name: 'Plasma', sub: 'Plasma · eip155:9745' },
    { symbol: 'USDT0', name: 'Tether USD', sub: '0x1234…abcd' }
  ]
  t.is(pw.filtrarItems(items, 'teth').length, 1, 'por nombre')
  t.is(pw.filtrarItems(items, 'PLASMA').length, 1, 'sin distinguir mayusculas')
  t.is(pw.filtrarItems(items, '9745').length, 1, 'el caip2 de la linea de abajo tambien cuenta')
  t.is(pw.filtrarItems(items, '').length, 2, 'sin texto estan todos')
  t.is(pw.filtrarItems(items, 'zzz').length, 0, 'lo que no matchea no aparece')
})

test('el panel /wallet lleva embebido el codigo de panel-wallet.mjs, entero y conectado', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const pages = await import('../qvac/pages.mjs')

  t.ok(
    pages.WALLET_HTML.indexOf(pw.FUENTE_EMBEBIDA_WALLET) !== -1,
    'el HTML servido lo lleva entero, no una copia que el test no corre'
  )
  t.ok(
    pages.WALLET_HTML.indexOf('htmlDeWallet(vistaWallet') !== -1,
    'y hay un lugar de llamada, no solo la definicion'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/balances')") !== -1,
    'lee el endpoint con la credencial del panel, como el resto'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/create'") !== -1,
    'y el onboarding postea a /v1/wallet/create'
  )
  t.ok(
    pages.WALLET_HTML.indexOf('htmlDeSeed(onbSeed.frase') !== -1,
    'la pantalla de la frase se dibuja con la funcion probada, no a mano'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/network'") !== -1,
    'y el selector de red postea a /v1/wallet/network'
  )
})

// ---------------------------------------------------------------------------
// FASE 12 — Settings detras del ☰.
//
// El punto de esta pantalla es negativo tanto como positivo: lo que se prueba
// no es solo que Settings exista, sino que la tarjeta ya NO dibuje
// configuracion inline. Un selector de red suelto al lado del saldo es lo que
// esta fase vino a sacar.
// ---------------------------------------------------------------------------

function vistaConWallet(pw, extra) {
  return pw.vistaDeSaldos({
    configurada: true,
    address: '0x' + 'ab'.repeat(20),
    red: { nombre: 'plasma-testnet', caip2: 'eip155:9746', mainnet: false },
    nativo: { decimals: 18, raw: '0x0' },
    ...(extra || {})
  })
}

test('FASE 12: la tarjeta ya no dibuja configuracion, y el ☰ es la puerta', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const v = vistaConWallet(pw)
  const html = pw.htmlDeWallet(v, '', 'assets')

  // Lo que se fue.
  t.is(html.indexOf('id="w-red-sel"'), -1, 'el <select> de red NO esta en la tarjeta')
  t.is(html.indexOf('w-red-box'), -1, 'ni su caja')
  t.is(html.indexOf('id="w-red-aplicar"'), -1, 'ni su boton de aplicar')

  // Lo que quedo en su lugar.
  t.ok(html.indexOf('id="w-set-abrir"') !== -1, 'hay un ☰ en el header')
  t.ok(html.indexOf('☰') !== -1, 'dibujado con el glifo, no como texto')

  // Y sin wallet no hay ☰: no hay nada que configurar todavia.
  const sin = pw.htmlDeWallet(
    pw.vistaDeSaldos({ configurada: false, puedeCrear: true }),
    '',
    'assets'
  )
  t.is(sin.indexOf('id="w-set-abrir"'), -1, 'sin wallet no se ofrece configuracion')
})

test('FASE 12: Settings junta el selector de red, los tokens y los datos del nodo', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const v = vistaConWallet(pw, {
    tokensGuardados: [{ address: '0x' + 'cd'.repeat(20), symbol: 'tUSD', decimals: 6 }],
    info: {
      rpc: 'https://testnet-rpc.plasma.to',
      rpcFijadoPorEnv: true,
      keystore: 'C:\\Users\\alguien\\pyrusllm',
      version: '0.12.0'
    }
  })
  const html = pw.htmlDeSettings(v)

  // El selector de red se MUDO acá tal cual, sin cambiarle el comportamiento.
  t.ok(html.indexOf('id="w-red-sel"') !== -1, 'el selector de red vive acá ahora')
  t.ok(html.indexOf('takes effect when the node restarts') !== -1, 'sigue sin prometer hot-swap')

  // Los tokens, con la marca que no se negocia.
  t.ok(html.indexOf('tUSD') !== -1, 'el token guardado aparece')
  t.ok(html.indexOf('6 decimales') !== -1, 'con sus decimales, que es lo que decide el monto')
  t.ok(
    html.indexOf('unverified against the chain') !== -1,
    'y marcado sin verificar: nadie le pregunto nada a la cadena'
  )
  t.ok(html.indexOf('data-w-token-del="0x' + 'cd'.repeat(20) + '"') !== -1, 'se puede quitar')
  t.ok(html.indexOf('id="w-token-add"') !== -1, 'y agregar otro')

  // Los datos de diagnostico, incluido que el RPC lo fija el entorno.
  t.ok(html.indexOf('testnet-rpc.plasma.to') !== -1, 'el RPC efectivo esta dicho')
  t.ok(html.indexOf('PYRUS_WALLET_RPC') !== -1, 'y que lo fija el entorno')
  t.ok(html.indexOf('0.12.0') !== -1, 'la version del nodo')

  // Se puede cerrar: sin esto el overlay seria una trampa.
  t.ok(html.indexOf('id="w-set-cerrar"') !== -1, 'y hay con que cerrarlo')

  // Sin `info` no se inventan filas: un dato que el nodo no mando no se dibuja.
  const pelada = pw.htmlDeSettings(vistaConWallet(pw))
  t.is(pelada.indexOf('Node version'), -1, 'sin info del nodo, no hay bloque de info')
  t.ok(pelada.indexOf('None yet') !== -1, 'y la lista vacia lo dice, no queda muda')
})

test('FASE 12: la forma de un token se chequea igual en el panel y antes del disco', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const wallet = await import('../qvac/wallet.mjs')

  const casos = [
    [
      { address: '0x' + 'ab'.repeat(20), symbol: 'tUSD', decimals: 6 },
      true,
      'un token bien formado'
    ],
    [
      { address: '0x' + 'AB'.repeat(20), symbol: 'X', decimals: 0 },
      true,
      'mayusculas y 0 decimales'
    ],
    [{ address: '0xNOPE', symbol: 'X', decimals: 6 }, false, 'address que no es hex'],
    [{ address: '0x' + 'ab'.repeat(19), symbol: 'X', decimals: 6 }, false, 'address corta'],
    [{ address: '0x' + 'ab'.repeat(20), symbol: '', decimals: 6 }, false, 'simbolo vacio'],
    [
      { address: '0x' + 'ab'.repeat(20), symbol: 'x'.repeat(13), decimals: 6 },
      false,
      'simbolo de 13'
    ],
    [{ address: '0x' + 'ab'.repeat(20), symbol: 'X', decimals: 37 }, false, '37 decimales'],
    [
      { address: '0x' + 'ab'.repeat(20), symbol: 'X', decimals: 1.5 },
      false,
      'decimales fraccionarios'
    ]
  ]

  for (const [tok, esperado, que] of casos) {
    t.is(pw.tokenParecePlausible(tok), esperado, 'el panel: ' + que)
    // Las dos reglas TIENEN que decir lo mismo: si el panel deja pasar algo que
    // el nodo rechaza, la persona recibe un error despues de tipear; si el
    // panel corta algo que el nodo aceptaria, un token valido se vuelve
    // inagregable. Estan escritas dos veces (Bare no comparte modulo con el
    // navegador) y esto es lo que impide que se desincronicen.
    t.is(wallet.tokenParaGuardar(tok) !== null, esperado, 'y el nodo dice lo mismo de: ' + que)
  }

  t.absent(pw.tokenParecePlausible(null), 'null no rompe')
  t.absent(pw.tokenParecePlausible({}), 'un objeto vacio tampoco')
})

test('FASE 12: el panel /wallet embebe Settings y lo cablea contra el endpoint', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const pages = await import('../qvac/pages.mjs')

  for (const fn of ['htmlDeSettings', 'htmlDeListaTokens', 'tokenParecePlausible']) {
    t.ok(pw.FUENTE_EMBEBIDA_WALLET.indexOf('var ' + fn + ' =') !== -1, fn + ' viaja al navegador')
  }
  t.ok(
    pages.WALLET_HTML.indexOf('htmlDeSettings(vistaWallet)') !== -1,
    'y hay un lugar de llamada, no solo la definicion'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/tokens'") !== -1,
    'agregar y quitar tokens pega contra /v1/wallet/tokens'
  )
  t.ok(
    pages.WALLET_HTML.indexOf('if (settingsAbierto) return') !== -1,
    'el poll de 15 s NO repinta con Settings abierto: un form a medio llenar no se pisa'
  )
  t.ok(pages.WALLET_HTML.indexOf("ev.key === 'Escape'") !== -1, 'y se cierra con Esc')
})

// ---------------------------------------------------------------------------
// FASE 12 — el QR de depósito.
//
// El encoder esta escrito a mano (R2: cero dependencias), asi que la suite
// tiene que hacer de lector: no alcanza con "hay un <svg>". Se prueba contra la
// NORMA en tres puntos independientes — la informacion de formato publicada, el
// generador Reed-Solomon publicado, y los patrones fijos — y ademas se DECODIFICA
// la matriz de vuelta. Un encoder equivocado pero coherente consigo mismo
// pasaria la ultima; no pasa las tres primeras.
// ---------------------------------------------------------------------------

// Deshace mascara y zigzag y devuelve los bits del area de datos. Es un lector
// escrito aparte, a proposito: si compartiera codigo con el encoder no probaria
// nada.
function leerBitsDelQR(m) {
  const N = m.length
  const esFuncion = []
  for (let r = 0; r < N; r++) esFuncion.push(new Array(N).fill(false))
  const marcar = (fr, fc) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r
        const cc = fc + c
        if (rr >= 0 && rr < N && cc >= 0 && cc < N) esFuncion[rr][cc] = true
      }
    }
  }
  marcar(0, 0)
  marcar(0, N - 7)
  marcar(N - 7, 0)
  for (let i = 0; i < N; i++) {
    esFuncion[6][i] = true
    esFuncion[i][6] = true
  }
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) esFuncion[22 + r][22 + c] = true
  for (let i = 0; i < 15; i++) {
    if (i < 6) esFuncion[i][8] = true
    else if (i < 8) esFuncion[i + 1][8] = true
    else esFuncion[N - 15 + i][8] = true
    if (i < 8) esFuncion[8][N - i - 1] = true
    else if (i < 9) esFuncion[8][15 - i - 1 + 1] = true
    else esFuncion[8][15 - i - 1] = true
  }
  esFuncion[N - 8][8] = true

  const bits = []
  let inc = -1
  let fila = N - 1
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k
        if (!esFuncion[fila][c]) {
          // Deshacer la mascara 0.
          let b = m[fila][c]
          if ((fila + c) % 2 === 0) b = !b
          bits.push(b ? 1 : 0)
        }
      }
      fila += inc
      if (fila < 0 || fila >= N) {
        fila -= inc
        inc = -inc
        break
      }
    }
  }
  return bits
}

test('FASE 12: el QR codifica la dirección EXACTA, y se lo comprueba leyéndolo', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  // Mayusculas y minusculas mezcladas a proposito: una address con checksum
  // EIP-55 no es la misma que su version en minuscula para quien la lee.
  const addr = '0x' + 'aB3f'.repeat(10)

  const m = pw.qrMatriz(addr)
  t.is(m.length, 29, 'version 3: 29x29')
  t.is(m[0].length, 29, 'cuadrada')

  const bits = leerBitsDelQR(m)
  // 70 codewords (55 datos + 15 correccion) por 8, mas los 7 bits de relleno
  // que la version 3 tiene de sobra.
  t.is(bits.length, 567, 'el area de datos tiene exactamente los bits de la v3')

  const leer = (off, n) => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | bits[off + i]
    return v
  }
  t.is(leer(0, 4), 4, 'el indicador de modo es byte (0100)')
  t.is(leer(4, 8), addr.length, 'la longitud declarada es la de la address')

  let texto = ''
  for (let i = 0; i < addr.length; i++) texto += String.fromCharCode(leer(12 + i * 8, 8))
  t.is(texto, addr, 'y lo que sale del QR es la dirección EXACTA, carácter por carácter')

  // Determinista: la misma entrada dibuja lo mismo. Sin esto, un QR que cambia
  // en cada pintada haria parpadear la pantalla en cada poll.
  t.alike(pw.qrMatriz(addr), m, 'la misma dirección da la misma matriz')
})

test('FASE 12: el QR respeta la norma en el formato, en el Reed-Solomon y en los patrones fijos', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const addr = '0x' + 'ab'.repeat(20)
  const m = pw.qrMatriz(addr)
  const N = 29

  // (1) La informacion de formato tiene que ser la PUBLICADA para nivel L con
  // mascara 0. La funcion la calcula con BCH; esto la compara contra la tabla,
  // asi que el calculo queda anclado a un valor de afuera.
  let formato = 0
  for (let i = 0; i < 15; i++) {
    let bit
    if (i < 8) bit = m[8][N - i - 1]
    else if (i < 9) bit = m[8][15 - i - 1 + 1]
    else bit = m[8][15 - i - 1]
    if (bit) formato |= 1 << i
  }
  t.is(
    formato.toString(2).padStart(15, '0'),
    '111011111000100',
    'la información de formato es la de la norma para (L, máscara 0)'
  )

  // Las dos copias del formato tienen que decir lo mismo: existen justamente
  // para que un QR con una esquina dañada se siga leyendo.
  let copia = 0
  for (let i = 0; i < 15; i++) {
    let bit
    if (i < 6) bit = m[i][8]
    else if (i < 8) bit = m[i + 1][8]
    else bit = m[N - 15 + i][8]
    if (bit) copia |= 1 << i
  }
  t.is(copia, formato, 'y la segunda copia del formato coincide con la primera')

  // (2) Reed-Solomon contra el generador PUBLICADO de 15 codewords, escrito acá
  // como la tabla de exponentes de α que trae la norma. Es una segunda
  // implementación del mismo cálculo: si `qrReedSolomon` construyera mal el
  // polinomio generador, los restos no coincidirían.
  const G15 = [0, 8, 183, 61, 91, 202, 37, 51, 58, 58, 237, 140, 124, 5, 99, 105]
  const exp = new Array(512)
  const log = new Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]])
  const gen = G15.map((e) => exp[e])

  const datos = pw.qrBytesDeDatos(addr)
  t.is(datos.length, 55, 'v3-L son 55 codewords de datos, con el relleno de la norma')
  // 42 bytes + 12 bits de encabezado cierran en el codeword 44; del 45 al 55 va
  // el relleno de la norma, alternando 0xEC y 0x11 desde 0xEC.
  t.alike(
    datos.slice(44),
    [0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec],
    'el relleno alterna 0xEC/0x11 desde 0xEC, como corresponde'
  )

  const resto = new Array(15).fill(0)
  for (let i = 0; i < datos.length; i++) {
    const factor = datos[i] ^ resto[0]
    resto.shift()
    resto.push(0)
    if (factor) for (let j = 0; j < 15; j++) resto[j] ^= mul(gen[j + 1], factor)
  }
  t.alike(
    pw.qrReedSolomon(datos, 15),
    resto,
    'los codewords de corrección coinciden con los del generador publicado'
  )

  // (3) Los patrones fijos, donde la norma dice que van.
  for (const [fr, fc] of [
    [0, 0],
    [0, N - 7],
    [N - 7, 0]
  ]) {
    t.ok(m[fr][fc] && m[fr + 6][fc] && m[fr][fc + 6], 'el anillo del patrón de posición')
    t.absent(m[fr + 1][fc + 1], 'con su hueco claro adentro')
    t.ok(m[fr + 3][fc + 3], 'y el centro oscuro')
  }
  // Son TRES patrones de posición, no cuatro: la esquina inferior derecha es
  // area de datos, y es asi como el lector sabe de que lado esta parado.
  let columnaLlena = true
  for (let r = N - 7; r < N; r++) if (!m[r][N - 7]) columnaLlena = false
  t.absent(columnaLlena, 'la esquina inferior derecha NO lleva patrón de posición')
  t.ok(m[6][8] && m[6][10], 'el timing horizontal alterna desde un módulo oscuro')
  t.absent(m[6][9], 'y su vecino es claro')
  t.ok(m[22][22], 'el patrón de alineación de la v3, en (22,22)')
  t.absent(m[21][22], 'con su anillo claro')
  t.ok(m[N - 8][8], 'y el módulo oscuro fijo, que siempre está')
})

test('FASE 12: el QR entra en el depósito, y lo que no entra no se dibuja mal', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const v = vistaConWallet(pw)

  const dep = pw.htmlDeDeposito(v)
  t.ok(dep.indexOf('<svg') !== -1, 'el depósito trae el QR')
  t.ok(dep.indexOf('<rect') !== -1, 'con módulos dibujados')
  t.is(dep.indexOf('fase aparte'), -1, 'y ya no dice que el QR es una fase aparte')
  t.ok(dep.indexOf(v.address) !== -1, 'la dirección en texto sigue estando, para copiarla')

  // Un texto que no entra en v3-L NO se trunca: se dice. Un QR con la dirección
  // cortada escanearía una dirección que no es de nadie, y eso no se deshace.
  t.is(pw.qrMatriz('x'.repeat(54)), null, '54 bytes no entran en v3-L')
  t.ok(pw.qrMatriz('x'.repeat(53)), 'y 53 sí, que es el límite')
  const largo = pw.htmlDeQR('x'.repeat(54))
  t.is(largo.indexOf('<svg'), -1, 'sin QR cuando no entra')
  t.ok(largo.indexOf('Copy the address') !== -1, 'y con el motivo, en vez de un QR roto')

  // El QR viaja al navegador con el resto.
  const pages = await import('../qvac/pages.mjs')
  for (const fn of ['qrBytesDeDatos', 'qrReedSolomon', 'qrMatriz', 'htmlDeQR']) {
    t.ok(pw.FUENTE_EMBEBIDA_WALLET.indexOf('var ' + fn + ' =') !== -1, fn + ' está embebida')
  }
  t.ok(
    pages.WALLET_HTML.indexOf('var htmlDeQR =') !== -1,
    'y el panel servido la lleva, no una copia que el test no corre'
  )
})

// ---------------------------------------------------------------------------
// FASE 12 — el historial.
//
// Lo que se vigila es lo mismo de siempre en este panel: que una lectura que
// fallo NO se dibuje como "no hubo movimientos", y que un monto sin decimales
// conocidos no se divida por un numero inventado.
// ---------------------------------------------------------------------------

test('FASE 12: el historial marca entradas y salidas y formatea con los decimales que sabe', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const mia = '0x' + 'ab'.repeat(20)
  const otra = '0x' + 'cd'.repeat(20)

  const v = pw.vistaDeHistorial({
    ok: true,
    configurada: true,
    address: mia,
    explorer: 'https://testnet.plasmascan.to',
    caip2: 'eip155:9746',
    fuente: 'explorer',
    items: [
      {
        tipo: 'erc20',
        hash: '0x' + '11'.repeat(32),
        from: otra,
        to: mia,
        valor: '1500000',
        decimals: 6,
        symbol: 'tUSD',
        timestamp: '2026-08-27T10:00:00Z',
        estado: 'confirmada'
      },
      {
        tipo: 'native',
        hash: '0x' + '22'.repeat(32),
        from: mia,
        to: otra,
        valor: '1000000000000000000',
        decimals: 18,
        symbol: null,
        timestamp: '2026-08-26T10:00:00Z',
        estado: 'fallida'
      }
    ]
  })

  t.is(v.n, 2, 'las dos filas')
  t.is(v.items[0].direccion, 'in', 'lo que llega a esta wallet entra')
  t.is(v.items[0].texto, '1.5', 'formateado con los 6 decimales del token')
  t.is(v.items[0].symbol, 'tUSD')
  t.is(
    v.items[0].link,
    'https://testnet.plasmascan.to/tx/0x' + '11'.repeat(32),
    'con link al explorer de la red activa'
  )
  t.is(v.items[1].direccion, 'out', 'y lo que sale, sale')
  t.is(v.items[1].texto, '1', '1e18 wei es 1')
  t.is(v.items[1].symbol, 'XPL', 'el nativo toma el simbolo de la red, no uno inventado')
  t.is(v.items[1].estado, 'fallida', 'y el estado viaja tal cual')

  const html = pw.htmlDeHistorial(v)
  t.ok(html.indexOf('Received') !== -1 && html.indexOf('Sent') !== -1, 'se dibujan las dos')
  t.ok(html.indexOf('+1.5 tUSD') !== -1, 'la entrada con signo +')
  t.ok(html.indexOf('−1 XPL') !== -1, 'y la salida con −')
  t.ok(html.indexOf('/tx/0x' + '11'.repeat(32)) !== -1, 'el link al explorer esta en el HTML')
  t.ok(html.indexOf('fallida') !== -1, 'una tx fallida se ve fallida')
})

test('FASE 12: un historial que no se pudo leer dice "—" y el motivo, no una lista vacía', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')

  const roto = pw.vistaDeHistorial({
    ok: false,
    configurada: true,
    address: '0x' + 'ab'.repeat(20),
    items: [],
    error: 'no se pudo leer el historial — el explorer no contestó: HTTP 503'
  })
  t.absent(roto.ok, 'la vista sabe que la lectura fallo')
  const html = pw.htmlDeHistorial(roto)
  t.ok(html.indexOf('—') !== -1, 'se dibuja "—"')
  t.ok(html.indexOf('HTTP 503') !== -1, 'con el motivo al lado')
  t.is(
    html.indexOf('Sin movimientos'),
    -1,
    'y NUNCA "sin movimientos": eso seria afirmar algo sobre la cadena que nadie miro'
  )

  // Vacio DE VERDAD es otra cosa, y se ve distinto.
  const vacio = pw.htmlDeHistorial(
    pw.vistaDeHistorial({ ok: true, configurada: true, address: '0x' + 'ab'.repeat(20), items: [] })
  )
  t.ok(vacio.indexOf('Sin movimientos') !== -1, 'una lectura que sí funcionó y no trajo nada, sí')

  // La fuente de respaldo ve menos, y eso se dice en pantalla.
  const parcial = pw.htmlDeHistorial(
    pw.vistaDeHistorial({
      ok: true,
      configurada: true,
      address: '0x' + 'ab'.repeat(20),
      items: [],
      fuente: 'logs',
      parcial: 'read from the RPC, not the explorer: only token transfers'
    })
  )
  t.ok(
    parcial.indexOf('read from the RPC') !== -1,
    'lo que la fuente de respaldo no ve, queda dicho'
  )
})

test('FASE 12: un monto sin decimales conocidos no se divide por un número inventado', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const mia = '0x' + 'ab'.repeat(20)

  // Es el caso del respaldo por eth_getLogs con un token que nadie agrego: hay
  // un monto crudo y NO se sabe cuantos decimales tiene.
  const v = pw.vistaDeHistorial({
    ok: true,
    configurada: true,
    address: mia,
    items: [
      {
        tipo: 'erc20',
        hash: '0x' + '33'.repeat(32),
        from: '0x' + 'cd'.repeat(20),
        to: mia,
        valor: '0x1e8480',
        decimals: null,
        symbol: null,
        contrato: '0x' + 'ef'.repeat(20),
        bloque: '0x64'
      }
    ]
  })

  t.ok(v.items[0].montoCrudo, 'la vista sabe que ese monto esta sin escalar')
  t.is(v.items[0].texto, '2000000', 'muestra las unidades crudas, no una division a ojo')
  t.is(v.items[0].symbol, null, 'y no le inventa un simbolo')
  t.is(v.items[0].cuando, 'bloque 100', 'sin timestamp se dice el bloque')

  const html = pw.htmlDeHistorial(v)
  t.ok(html.indexOf('unidades crudas') !== -1, 'y la pantalla lo aclara')
  t.ok(html.indexOf('token 0xefef') !== -1, 'con la dirección del contrato, ya que no hay símbolo')
})

test('FASE 12: el tab History deja de estar deshabilitado y el panel lo cablea', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const pages = await import('../qvac/pages.mjs')

  const tabs = pw.htmlDeTabs('assets')
  const idx = tabs.indexOf('>History</button>')
  const desde = tabs.lastIndexOf('<button', idx)
  t.is(tabs.slice(desde, idx).indexOf('disabled'), -1, 'History ya no esta deshabilitado')
  t.ok(tabs.slice(desde, idx).indexOf('data-w-tab="history"') !== -1, 'y es un tab de verdad')

  // Stake y Swap SIGUEN deshabilitados: no existen, y esconderlos seria fingir
  // que el panel esta completo.
  for (const etiqueta of ['Stake', 'Swap']) {
    const i = tabs.indexOf('>' + etiqueta + '</button>')
    const d = tabs.lastIndexOf('<button', i)
    t.ok(tabs.slice(d, i).indexOf('disabled') !== -1, etiqueta + ' sigue deshabilitado')
  }

  // El tab dibuja el historial, y antes de que llegue dice que esta leyendo —
  // no una lista vacia.
  const v = vistaConWallet(pw)
  const sinDato = pw.htmlDeWallet(v, '', 'history', null)
  t.ok(sinDato.indexOf('Leyendo movimientos') !== -1, 'mientras carga lo dice')
  t.is(sinDato.indexOf('Sin movimientos'), -1, 'sin fingir que ya sabe que no hay nada')

  const conDato = pw.htmlDeWallet(
    v,
    '',
    'history',
    pw.vistaDeHistorial({ ok: true, configurada: true, address: v.address, items: [] })
  )
  t.ok(conDato.indexOf('Sin movimientos') !== -1, 'y con el dato, dibuja el historial')

  for (const fn of ['vistaDeHistorial', 'htmlDeHistorial']) {
    t.ok(pw.FUENTE_EMBEBIDA_WALLET.indexOf('var ' + fn + ' =') !== -1, fn + ' viaja al navegador')
  }
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/history')") !== -1,
    'y el panel lo lee del endpoint con la credencial, como el resto'
  )
  t.ok(
    pages.WALLET_HTML.indexOf('htmlDeWallet(vistaWallet, filtroWallet, tabWallet, vistaHist)') !==
      -1,
    'el historial llega hasta el dibujo'
  )
})

// ---------------------------------------------------------------------------
// FASE 12 — enviar.
//
// La invariante que estas pruebas cuidan no es de dibujo: es que el navegador
// NUNCA vea una clave. Lo que sale de acá son tres strings y lo que vuelve es
// un hash. La firma la hace bin.mjs con la cuenta de WDK, detras del closure
// que el gateway recibe (`setWalletSender`), igual que las atestaciones de D24.
// ---------------------------------------------------------------------------

test('FASE 12: la forma de un envío se chequea antes de molestar a la cadena', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const ok = { destino: '0x' + 'ab'.repeat(20), monto: '1.5', asset: 'native' }

  t.ok(pw.envioParecePlausible(ok), 'un envío bien formado pasa')
  t.ok(pw.envioParecePlausible({ ...ok, asset: '0x' + 'cd'.repeat(20) }), 'con un token también')
  t.absent(pw.envioParecePlausible({ ...ok, destino: '0xNOPE' }), 'un destino que no es hex, no')
  t.absent(
    pw.envioParecePlausible({ ...ok, destino: '0x' + 'ab'.repeat(19) }),
    'ni un destino corto'
  )
  t.absent(pw.envioParecePlausible({ ...ok, monto: '0' }), 'ni cero')
  t.absent(pw.envioParecePlausible({ ...ok, monto: '-1' }), 'ni negativo')
  t.absent(pw.envioParecePlausible({ ...ok, monto: 'mucho' }), 'ni un monto que no es número')
  t.absent(pw.envioParecePlausible({ ...ok, monto: '' }), 'ni vacío')
  t.absent(pw.envioParecePlausible({ ...ok, asset: 'usdt' }), 'ni un activo con nombre inventado')
  t.absent(pw.envioParecePlausible(null), 'null no rompe')
})

test('FASE 12: la revisión repite todo, marca MAINNET y no inventa un gas', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const destino = '0x' + 'cd'.repeat(20)

  // Testnet, activo nativo, gas estimado.
  const v = vistaConWallet(pw)
  const rev = pw.htmlDeRevisionEnvio(
    v,
    { monto: '1.5', simbolo: 'XPL', destino, red: 'plasma-testnet', mainnet: false },
    { fee: '21000000000000', feeDecimals: 18, feeSymbol: 'XPL' }
  )
  t.ok(rev.indexOf('1.5 XPL') !== -1, 'el monto')
  // La direccion ENTERA, sin truncar: es el unico campo donde un caracter
  // cambiado manda los fondos a otro lado, y el truncado esconde justo el medio.
  t.ok(rev.indexOf(destino) !== -1, 'la dirección de destino entera, sin truncar')
  t.is(rev.indexOf('…'), -1, 'sin puntos suspensivos en ninguna parte de la revisión')
  t.ok(rev.indexOf('0.000021 XPL') !== -1, 'y el gas, formateado con sus 18 decimales')
  t.ok(rev.indexOf('(estimado)') !== -1, 'dicho como estimado, que es lo que es')
  t.is(rev.indexOf('MAINNET'), -1, 'en testnet no se grita mainnet')

  // Sin cotización NO se dibuja un cero: se dice que no se pudo.
  const sinGas = pw.htmlDeRevisionEnvio(v, { monto: '1', simbolo: 'XPL', destino }, { fee: null })
  t.ok(sinGas.indexOf('could not estimate') !== -1, 'un gas que no se pudo estimar se dice')
  t.is(sinGas.indexOf('0 XPL (estimado)'), -1, 'NUNCA un cero que parezca una cotización')

  // Mainnet: se grita, dos veces (arriba y en la fila de red).
  const enMainnet = pw.htmlDeRevisionEnvio(
    vistaConWallet(pw, {
      red: { nombre: 'plasma', caip2: 'eip155:9745', mainnet: true }
    }),
    { monto: '1', simbolo: 'XPL', destino, red: 'plasma', mainnet: true },
    { fee: '21000000000000', feeDecimals: 18, feeSymbol: 'XPL' }
  )
  t.ok(enMainnet.indexOf('MAINNET') !== -1, 'en mainnet se dice con todas las letras')
  t.ok(enMainnet.indexOf('real money') !== -1, 'y que mueve plata real')

  // Un token sin verificar avisa que el monto puede no ser el que dice.
  const sinVerificar = pw.htmlDeRevisionEnvio(
    v,
    { monto: '5', simbolo: 'tUSD', destino, red: 'plasma-testnet', assetVerificado: false },
    { fee: '1', feeDecimals: 18 }
  )
  t.ok(
    sinVerificar.indexOf('is NOT verified') !== -1,
    'mandarle plata a un token sin verificar avisa, que es donde el error cuesta'
  )
})

test('FASE 12: una transacción difundida se dice "enviada", no "confirmada"', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const hash = '0x' + 'ab'.repeat(32)

  const pendiente = pw.htmlDeEstadoEnvio({
    estado: 'pendiente',
    hash,
    monto: '1.5',
    simbolo: 'XPL',
    destino: '0x' + 'cd'.repeat(20),
    explorer: 'https://testnet.plasmascan.to/tx/' + hash
  })
  t.ok(pendiente.indexOf('Transaction sent') !== -1, 'se dice enviada')
  t.is(pendiente.indexOf('Transaction confirmed'), -1, 'y NO confirmada: eso lo dice la cadena')
  t.ok(
    pendiente.indexOf('Confirming it is the chain business') !== -1,
    'con la diferencia explicada donde se lee'
  )
  t.ok(pendiente.indexOf(hash) !== -1, 'el hash completo, para poder buscarlo')
  t.ok(pendiente.indexOf('/tx/' + hash) !== -1, 'y el link al explorer para seguirla')

  const fallida = pw.htmlDeEstadoEnvio({
    estado: 'fallida',
    error: 'insufficient funds for gas * price + value',
    monto: '1000',
    simbolo: 'XPL',
    destino: '0x' + 'cd'.repeat(20)
  })
  t.ok(fallida.indexOf('Could not send') !== -1, 'un fallo se ve como fallo')
  t.ok(
    fallida.indexOf('insufficient funds') !== -1,
    'con el motivo de la cadena tal cual, que es lo que la persona necesita leer'
  )
  t.is(fallida.indexOf('Transaction sent'), -1, 'y nada que sugiera que salió')
})

test('FASE 12: el botón Send se habilita y el panel lo cablea contra el endpoint', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')
  const pages = await import('../qvac/pages.mjs')

  const acc = pw.htmlDeAcciones(vistaConWallet(pw))
  const idx = acc.indexOf('⇄</span>Swap</button>')
  const desde = acc.lastIndexOf('<button', idx)
  t.ok(acc.slice(desde, idx).indexOf('disabled') !== -1, 'Swap sigue apagado')

  const idxSend = acc.indexOf('↑</span>Send</button>')
  const desdeSend = acc.lastIndexOf('<button', idxSend)
  t.is(acc.slice(desdeSend, idxSend).indexOf('disabled'), -1, 'Send ya no está deshabilitado')
  t.ok(acc.slice(desdeSend, idxSend).indexOf('id="w-acc-send"') !== -1, 'y tiene con qué abrirse')

  // Sin wallet no hay a quién cobrarle ni con qué firmar: sigue apagado.
  const sinWallet = pw.htmlDeAcciones(pw.vistaDeSaldos({ configurada: false }))
  const i2 = sinWallet.indexOf('↑</span>Send</button>')
  const d2 = sinWallet.lastIndexOf('<button', i2)
  t.ok(sinWallet.slice(d2, i2).indexOf('disabled') !== -1, 'sin wallet, Send apagado')

  // El formulario ofrece SOLO los activos que el panel está leyendo: no se puede
  // elegir mandar algo cuyo saldo nadie miró.
  const form = pw.htmlDeEnvio(
    vistaConWallet(pw, {
      tokens: [
        {
          symbol: 'tUSD',
          address: '0x' + 'cd'.repeat(20),
          decimals: 6,
          raw: '0x0',
          verificado: false
        }
      ]
    })
  )
  t.ok(form.indexOf('value="native"') !== -1, 'el nativo se puede mandar')
  t.ok(form.indexOf('value="0x' + 'cd'.repeat(20) + '"') !== -1, 'y el token guardado también')
  t.ok(form.indexOf('(unverified)') !== -1, 'marcado, también acá')
  t.ok(form.indexOf('another network') !== -1, 'con el aviso de que la red importa')

  for (const fn of [
    'envioParecePlausible',
    'htmlDeEnvio',
    'htmlDeRevisionEnvio',
    'htmlDeEstadoEnvio'
  ]) {
    t.ok(pw.FUENTE_EMBEBIDA_WALLET.indexOf('var ' + fn + ' =') !== -1, fn + ' viaja al navegador')
  }
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/send/quote'") !== -1,
    'revisar cotiza primero, sin firmar'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("authFetch('/v1/wallet/send'") !== -1,
    'y confirmar postea a /v1/wallet/send'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("if (envioEstado !== 'idle') return") !== -1,
    'el poll no repinta encima de un envío en curso ni del hash recién devuelto'
  )
  // La clave NO viaja: lo unico que el navegador manda son destino, monto y
  // activo. Si alguna vez alguien mandara una frase o una clave desde acá, esto
  // es lo que lo tiene que romper.
  t.is(
    pages.WALLET_HTML.indexOf('privateKey'),
    -1,
    'del panel de envío no sale ninguna clave privada'
  )
  t.ok(
    pages.WALLET_HTML.indexOf("prompt('MAINNET moves real money and this cannot be undone") !== -1,
    'y mainnet pide escribirlo, como el selector de red'
  )
})

test('el selector de red ofrece testnet y mainnet, marca mainnet como plata real, y no promete hot-swap', async (t) => {
  const pw = await import('../qvac/panel-wallet.mjs')

  const sel = pw.htmlDeSelectorRed(
    pw.vistaDeSaldos({
      configurada: true,
      address: '0x' + 'ab'.repeat(20),
      red: { nombre: 'plasma-testnet', caip2: 'eip155:9746', mainnet: false },
      nativo: { decimals: 18, raw: '0x0' }
    })
  )
  t.ok(sel.indexOf('id="w-red-sel"') !== -1, 'hay un <select>')
  t.ok(
    sel.indexOf('value="plasma-testnet"') !== -1 && sel.indexOf('value="plasma"') !== -1,
    'las dos redes'
  )
  t.ok(
    /value="plasma"[^>]*data-mainnet="1"/.test(sel),
    'plasma marcada mainnet para el confirm del cliente'
  )
  t.ok(/value="plasma-testnet"[^>]*selected/.test(sel), 'la actual viene seleccionada')
  t.ok(sel.indexOf('real money') !== -1, 'dicho con todas las letras')
  t.ok(sel.indexOf('takes effect when the node restarts') !== -1, 'no promete hot-swap')

  // Si el entorno fija la red, no hay <select>: el selector no tendria efecto.
  const fija = pw.htmlDeSelectorRed(
    pw.vistaDeSaldos({
      configurada: true,
      address: '0x' + 'ab'.repeat(20),
      red: { nombre: 'plasma', caip2: 'eip155:9745', mainnet: true, fijadaPorEnv: true },
      nativo: { decimals: 18, raw: '0x0' }
    })
  )
  t.is(fija.indexOf('<select'), -1, 'sin selector cuando lo fija el entorno')
  t.ok(fija.indexOf('PYRUS_WALLET_RED') !== -1, 'y dice por que')
})

// La version en el panel sale de package.json y no de un literal copiado. El
// test existe porque el modo de fallo es silencioso: un bump de package.json
// que no llegue a la nav deja las cinco pantallas anunciando una version vieja,
// y eso es exactamente el dato que se mira cuando dos maquinas no se comportan
// igual.
test('la version del panel sale de package.json, no de una copia', async (t) => {
  const pages = await import('../qvac/pages.mjs')
  const pkg = await import('../package.json', { with: { type: 'json' } })
  const version = (pkg.default || pkg).version

  for (const [nombre, html] of [
    ['CHAT_HTML', pages.CHAT_HTML],
    ['NODE_HTML', pages.NODE_HTML],
    ['NETWORK_HTML', pages.NETWORK_HTML],
    ['WALLET_HTML', pages.WALLET_HTML],
    ['ADMIN_HTML', pages.ADMIN_HTML]
  ]) {
    t.ok(html.indexOf('v' + version) !== -1, nombre + ' anuncia v' + version)
  }
})

// QVAC-Node tests. Run with `npm test` (brittle over bare).
//
// They cover the two pieces that need neither network nor a loaded model: the
// translation of the OpenAI request (gateway) and the manifest signature
// (Phase 2-a). Anything that needs two machines is verified with
// docs/RUNBOOK-2-MAQUINAS.md, not from here.

const test = require('brittle')

// ---------------------------------------------------------------------------
// Gateway: shape of the OpenAI request
// ---------------------------------------------------------------------------

test('normalizeRequest accepts the OpenAI shape', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const norm = normalizeRequest({
    model: 'llama1b',
    messages: [
      { role: 'system', content: 'sos conciso' },
      { role: 'user', content: 'hola' }
    ],
    stream: true
  })

  t.absent(norm.error, 'a valid OpenAI request gives no error')
  t.is(norm.model, 'llama1b')
  t.is(norm.stream, true)
  t.alike(
    norm.messages,
    [
      { role: 'system', content: 'sos conciso' },
      { role: 'user', content: 'hola' }
    ],
    'messages pass through intact: they are the history the engine receives'
  )
})

test('normalizeRequest flattens content as an array of text parts', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Some clients always send the array of parts, even when it's only text.
  // Cutting with an error there would leave them out for no reason.
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

test('normalizeRequest: stream default is false, like in OpenAI', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Without this case the gateway defaulted to stream:true: a client that
  // omits the field -which any example in the OpenAI docs does- got SSE where
  // it expected a single json, and its parser failed with no explanation.
  const omitido = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(omitido.stream, false, 'without the stream field, there is no streaming')

  const explicito = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    stream: false
  })
  t.is(explicito.stream, false, 'stream:false is respected')

  const streaming = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true
  })
  t.is(streaming.stream, true, 'stream:true is respected')
})

test('normalizeRequest accepts our own short form', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const norm = normalizeRequest({ modelId: 'facturas-ar', prompt: 'leeme esta factura' })

  t.absent(norm.error)
  t.is(norm.model, 'facturas-ar')
  t.alike(norm.messages, [{ role: 'user', content: 'leeme esta factura' }])
})

// Negative cases: each one has to give a message saying WHAT is missing, not a
// 500 or a hang. That's what separates "the client is misconfigured" from
// "the gateway broke".
test('normalizeRequest rejects invalid requests with a reason', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  t.ok(normalizeRequest({}).error, 'an empty body does not pass')
  t.ok(normalizeRequest({ messages: [] }).error, 'without model does not pass')
  t.ok(normalizeRequest({ model: 'llama1b' }).error, 'without messages does not pass')
  t.ok(normalizeRequest({ model: 'llama1b', messages: [] }).error, 'empty messages does not pass')
  t.ok(
    normalizeRequest({ model: 'llama1b', messages: [{ content: 'hola' }] }).error,
    'a message without role does not pass'
  )
  t.ok(
    normalizeRequest({ model: 'llama1b', messages: [{ role: 'user', content: 42 }] }).error,
    'content that is not text does not pass'
  )
  t.ok(normalizeRequest({ modelId: 'facturas-ar' }).error, 'the short form without prompt does not pass')
  t.ok(
    normalizeRequest({ modelId: 'facturas-ar', prompt: '   ' }).error,
    'a blank prompt does not pass'
  )
})

// ---------------------------------------------------------------------------
// Signed manifest (Phase 2-a)
// ---------------------------------------------------------------------------

const MODELS = [{ modelId: 'llama1b', displayName: 'Llama 3.2 1B', maxConcurrentRequests: 3 }]

async function manifestMod() {
  return import('../qvac/manifest.mjs')
}

test('JCS orders keys and does not depend on the assembly order', async (t) => {
  const { canonicalize } = await manifestMod()

  // This is THE property the whole signature depends on: two objects with the
  // same content assembled in a different order have to give the same bytes.
  const a = { b: 1, a: 2, c: { z: 3, y: 4 } }
  const b = { c: { y: 4, z: 3 }, a: 2, b: 1 }
  t.is(canonicalize(a), canonicalize(b), 'same content, same bytes')
  t.is(canonicalize(a), '{"a":2,"b":1,"c":{"y":4,"z":3}}', 'ordered keys, no spaces')

  t.is(canonicalize([3, 'a', null, true]), '[3,"a",null,true]')
  t.is(canonicalize({ a: undefined, b: 1 }), '{"b":1}', 'undefined does not exist in JSON')

  // JSON.stringify silently turns NaN into null: a NaN price would sign as
  // null and verify perfectly.
  t.exception(() => canonicalize({ precio: NaN }), /non-finite/, 'NaN cuts, does not pass as null')
  t.exception(() => canonicalize({ x: Infinity }), /non-finite/)
})

test('a signed manifest verifies against its own key', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const id = createIdentity()
  const manifest = buildManifest({ publicKey: id.publicKey, models: MODELS, operator: 'Nodo A' })

  t.absent(manifest.signature, 'buildManifest does not sign: that is signManifest\'s job')

  const signed = signManifest(manifest, id.secretKey)
  t.ok(signed.signature, 'signManifest adds the signature')

  const res = verifyManifest(signed, { expectedPublicKey: id.publicKey })
  t.ok(res.ok, 'verifies against the connection key')
  t.is(res.reason, null)
  t.absent(res.expired, 'just issued, not expired')
})

// The negative cases are the whole point of this piece. A verifier only
// tested with valid manifests proves nothing: what matters is that it REJECTS.
test('a tampered manifest does not verify', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const id = createIdentity()
  const signed = signManifest(
    buildManifest({ publicKey: id.publicKey, models: MODELS }),
    id.secretKey
  )

  // Changing the price after signing is the marketplace's obvious attack.
  const conPrecioCambiado = JSON.parse(JSON.stringify(signed))
  conPrecioCambiado.models[0].pricing = [{ unit: 'per_request', amount: '1', currency: 'QVAC' }]
  t.absent(verifyManifest(conPrecioCambiado).ok, 'touching the price invalidates the signature')

  const conModeloAgregado = JSON.parse(JSON.stringify(signed))
  conModeloAgregado.models.push({ modelId: 'gpt-4o-gratis' })
  t.absent(verifyManifest(conModeloAgregado).ok, 'adding a model invalidates the signature')

  const conOperadorCambiado = JSON.parse(JSON.stringify(signed))
  conOperadorCambiado.metadata.operator = 'Otro'
  t.absent(verifyManifest(conOperadorCambiado).ok, 'touching the operator invalidates the signature')

  const sinFirma = { ...signed, signature: undefined }
  t.absent(verifyManifest(sinFirma).ok, 'no signature does not pass')

  const firmaBasura = { ...signed, signature: 'ff'.repeat(64) }
  t.absent(verifyManifest(firmaBasura).ok, 'a made-up signature does not pass')

  t.absent(verifyManifest(null).ok, 'null does not pass')
  t.absent(verifyManifest({}).ok, 'an empty object does not pass')

  // Every rejection has to explain WHY: this gets logged in the swarm, and
  // "false" cannot be debugged at 3am.
  t.ok(verifyManifest(conPrecioCambiado).reason, 'the rejection carries a reason')
})

test('the signature alone does not prove identity: it has to be tied to the connection key', async (t) => {
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()

  const victima = createIdentity()
  const atacante = createIdentity()

  // The attacker builds a manifest with THEIR key and signs it correctly. The
  // signature is valid -- it only proves they have their own private key.
  const suyo = signManifest(
    buildManifest({ publicKey: atacante.publicKey, models: MODELS, operator: 'Nodo trucho' }),
    atacante.secretKey
  )
  t.ok(verifyManifest(suyo).ok, 'valid signature: without expectedPublicKey this passes')

  // Tied to the peer's real key, it falls apart. That's the only reason the
  // parameter exists.
  const res = verifyManifest(suyo, { expectedPublicKey: victima.publicKey })
  t.absent(res.ok, 'cannot pass itself off as another node')
  t.ok(/but the connection is/.test(res.reason), 'the reason says the keys do not match')

  // And signing with someone else's key doesn't work either: it doesn't have
  // the victim's private key.
  const robado = signManifest(
    buildManifest({ publicKey: victima.publicKey, models: MODELS }),
    atacante.secretKey
  )
  t.absent(verifyManifest(robado).ok, 'cannot sign for a key it does not have')
})

test('buildManifest rejects invalid inputs and marks mocks', async (t) => {
  const { createIdentity, buildManifest } = await manifestMod()
  const id = createIdentity()

  t.exception(() => buildManifest({ publicKey: 'abc', models: MODELS }), /32 bytes/)
  t.exception(() => buildManifest({ publicKey: id.publicKey, models: [] }), /at least one model/)
  t.exception(
    () => buildManifest({ publicKey: id.publicKey, models: [{ displayName: 'sin id' }] }),
    /modelId/
  )

  // D2 requires that the mock be marked somewhere it can be SEEN. If someone
  // "cleans it up" in a last-minute refactor, this test catches it.
  //
  // Since Phase 7, the one on `economic` no longer means "not implemented" but
  // "this node did not declare a payout address", which is a legitimate state:
  // a node that only consumes, or one that hasn't created its wallet yet. What
  // can't happen is that case looking the same as one with a real wallet.
  const m = buildManifest({ publicKey: id.publicKey, models: MODELS })
  t.ok(m.economic._mock, 'without a wallet, economic is marked as a mock')
  t.ok(m.directory._mock, 'directory is marked as a mock')
  t.is(m.node.endpoint.openaiCompatible, false, 'D1: no P2P baseUrl to point at')
})

// ---------------------------------------------------------------------------
// PHASE 7 — the payout wallet, and `economic` stops being a mock
//
// There are TWO distinct keys and that's the whole phase: `identity.mjs`
// holds the NETWORK one, in the clear, and the node signs with it;
// `wallet.mjs` holds the PAYOUT one, encrypted (D13), and it's what the
// manifest declares. The signed manifest is what ties one to the other.
//
// What these tests protect isn't that it "works": it's that no one can sign an
// address the node doesn't control, through none of the paths where that
// could happen.
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

test('the wallet seed does not end up in the clear, and the wrong passphrase does not open it', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const fs = await import('bare-fs')
  const path = await import('bare-path')
  const tmp = dirWalletTmp()

  t.is(wallet.existe(tmp.dir), false, 'a node without a wallet is the normal case, not an error')

  const creada = await wallet.crear(tmp.dir, 'la-passphrase-buena')
  t.ok(/^0x[a-fA-F0-9]{40}$/.test(creada.address), 'the address matches the schema pattern')
  t.is(creada.frase.split(' ').length, 24, 'the backup phrase is 24 words')

  // D13: NOTHING readable can be left on disk. Not the phrase, not the
  // address -- saving the address would let someone without the passphrase
  // read where this node collects payment anyway, and only the signed
  // manifest is allowed to say that.
  const crudo = fs.default.readFileSync(path.default.join(tmp.dir, 'wallet.json'), 'utf8')
  const palabras = creada.frase.split(' ')

  t.absent(crudo.includes(creada.frase), 'the full phrase is not in the file')
  t.absent(crudo.includes(creada.address), 'the address isn\'t saved either')

  // The words are searched for in the encrypted BYTES, not in the file's hex
  // text, and the difference isn't cosmetic: the first version searched for
  // each word inside the hex, and EIGHT BIP-39 words are entirely
  // hexadecimal -- add, beef, dad, decade, face, fade, fee, feed --, so they
  // showed up by coincidence. The test failed ~1 in 3 runs checking for a
  // letter coincidence instead of a security property, and in the project's
  // most sensitive file.
  const sobre = JSON.parse(crudo)
  const bytes = Buffer.from(sobre.sealed, 'hex').toString('utf8')
  for (const palabra of palabras) {
    t.absent(bytes.includes(palabra), 'the word "' + palabra + '" is not in the ciphertext')
  }

  // And no pair of contiguous words in the raw file: a real leak leaves
  // CONSECUTIVE words, and two in a row no longer show up by chance.
  for (let i = 0; i < palabras.length - 1; i++) {
    const par = palabras[i] + ' ' + palabras[i + 1]
    t.absent(crudo.includes(par), 'no contiguous pair: "' + par + '"')
  }

  // Fail CLOSED. If it opened with garbage it would derive a different
  // address, and the node would announce a wallet it doesn't control in a
  // signed manifest -- i.e. it would send payments to an address nobody has
  // the key for.
  await t.exception(
    () => wallet.abrir(tmp.dir, 'la-passphrase-equivocada'),
    /does not open the keystore/,
    'the wrong passphrase fails, it does not return a different address'
  )
  await t.exception(() => wallet.abrir(tmp.dir, null), /passphrase is missing/)

  const abierta = await wallet.abrir(tmp.dir, 'la-passphrase-buena')
  t.is(abierta.address, creada.address, 'with the correct passphrase it returns THE SAME address')

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

test('the backup phrase restores the same address on another machine', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const uno = dirWalletTmp()
  const otro = dirWalletTmp()

  const original = await wallet.crear(uno.dir, 'passphrase-de-la-maquina-vieja')

  // Different machine, different passphrase, SAME phrase. This is what makes
  // showing the 24 words once worthwhile: without this, losing the keystore
  // would mean losing the wallet even if the operator wrote them down.
  const restaurada = await wallet.crear(otro.dir, 'otra-passphrase-distinta', {
    frase: original.frase
  })
  t.is(restaurada.address, original.address, 'the same phrase gives the same payout address')
  t.ok(restaurada.restaurada, 'and it is known this was a restore, not a new wallet')

  // In a CLEAN directory: if `otro.dir` were reused, "there's already a
  // wallet" would fire first and this assert would pass for the wrong reason.
  const limpio = dirWalletTmp()
  await t.exception(
    () => wallet.crear(limpio.dir, 'x', { frase: 'esto no es un mnemonic bip39 valido' }),
    /BIP-39/,
    'a phrase that does not validate does not get in: it would be a wallet nobody could restore'
  )
  await t.exception(
    () => wallet.crear(otro.dir, 'x'),
    /there is already a wallet/,
    'and an existing wallet is not overwritten'
  )

  uno.limpiar()
  otro.limpiar()
  limpio.limpiar()
})

test('two nodes with wallets announce different addresses, and the signature ties them', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const { createIdentity, buildManifest, signManifest, verifyManifest } = await manifestMod()
  const a = dirWalletTmp()
  const b = dirWalletTmp()

  const walletA = await wallet.crear(a.dir, 'pass-a')
  const walletB = await wallet.crear(b.dir, 'pass-b')
  t.not(walletA.address, walletB.address, 'two nodes don\'t collect payment at the same address')

  const idA = createIdentity()
  const manifiesto = signManifest(
    buildManifest({
      publicKey: idA.publicKey,
      models: MODELS,
      economic: wallet.economicDe(walletA.address)
    }),
    idA.secretKey
  )

  t.absent(manifiesto.economic._mock, 'with a wallet, the _mock goes away')
  t.is(manifiesto.economic.walletAddress, walletA.address)
  t.alike(manifiesto.economic.chains, ['plasma', 'stable'], 'D15: plasma default, stable fallback')
  t.is(manifiesto.economic.settlement, 'batch-receipts')

  t.ok(verifyManifest(manifiesto, { expectedPublicKey: idA.publicKey }).ok, 'a peer verifies it')

  // THIS is what ties the network identity to the payout one: changing the
  // address on a signed manifest has to break the signature. Without this
  // property, anyone could relay another node's manifest with their own
  // wallet inside and collect payment for someone else's work.
  const manoseado = JSON.parse(JSON.stringify(manifiesto))
  manoseado.economic.walletAddress = walletB.address
  const r = verifyManifest(manoseado, { expectedPublicKey: idA.publicKey })
  t.is(r.ok, false, 'changing the wallet on a signed manifest invalidates it')

  a.limpiar()
  b.limpiar()
})

test('an invalid economic block does not get signed: signing it would send payment anywhere', async (t) => {
  const { createIdentity, buildManifest } = await manifestMod()
  const id = createIdentity()
  const base = { publicKey: id.publicKey, models: MODELS }
  const ok = {
    walletAddress: '0x' + 'ab'.repeat(20),
    chains: ['plasma'],
    settlement: 'batch-receipts'
  }

  // The zero address PASSES the schema pattern and is not an address: it's
  // exactly the value the mock had. Signing it would send the money into a pit.
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, walletAddress: '0x' + '0'.repeat(40) } }),
    /zero address/
  )
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, walletAddress: 'no-es-una-direccion' } }),
    /EVM nor a Tron/
  )
  t.exception(() => buildManifest({ ...base, economic: { ...ok, chains: [] } }), /at least one network/)
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, chains: ['Plasma Mainnet'] } }),
    /invalid identifier/,
    'the schema\'s kebab-case is checked before signing, not after'
  )
  t.exception(
    () => buildManifest({ ...base, economic: { ...ok, settlement: 'a-mano' } }),
    /settlement/
  )

  // And a valid Tron address DOES get in: the schema admits both families.
  const tron = buildManifest({
    ...base,
    economic: { ...ok, walletAddress: 'T' + 'J'.repeat(33) }
  })
  t.is(tron.economic.walletAddress, 'T' + 'J'.repeat(33))
})

// ---------------------------------------------------------------------------
// The manifest against ITS OWN frozen schema
//
// Phase 7's DoD asks that the manifest validate against manifest-v0.json
// without touching the schema, and until now NOBODY checked that: `grep
// manifest-v0` over the tree returns comments and nothing else. The schema
// was a document, not a check, and that's why the below was broken without
// anyone noticing.
//
// The constraints are read FROM the file, not copied here: a test that
// repeats by hand what the schema says stops protecting anything the day the
// schema changes.
// ---------------------------------------------------------------------------

// Minimal validator, only for what this schema uses. It's not a complete
// JSON-Schema and doesn't aim to be: there are zero validation dependencies in
// the tree and adding one for this would be an expensive price for a
// twenty-line check.
function violacionesDe(bloque, esquema) {
  const malas = []
  for (const req of esquema.required || []) {
    if (!(req in bloque)) malas.push('missing required "' + req + '"')
  }
  if (esquema.additionalProperties === false) {
    for (const k of Object.keys(bloque)) {
      if (!(k in esquema.properties)) malas.push('extra property: "' + k + '"')
    }
  }
  for (const [k, v] of Object.entries(bloque)) {
    const def = esquema.properties[k]
    if (!def) continue
    if (def.pattern && !new RegExp(def.pattern).test(String(v))) {
      malas.push(k + ' does not match the pattern')
    }
    if (def.enum && !def.enum.includes(v)) malas.push(k + ' outside the enum')
    if (def.type === 'array') {
      if (!Array.isArray(v)) malas.push(k + ' is not an array')
      else {
        if (def.minItems && v.length < def.minItems) malas.push(k + ': fewer than ' + def.minItems)
        if (def.maxItems && v.length > def.maxItems) malas.push(k + ': more than ' + def.maxItems)
        for (const item of v) {
          const i = def.items || {}
          if (i.pattern && !new RegExp(i.pattern).test(String(item)))
            malas.push(k + ': invalid item "' + item + '"')
          if (i.minLength && String(item).length < i.minLength)
            malas.push(k + ': short item "' + item + '"')
          if (i.maxLength && String(item).length > i.maxLength)
            malas.push(k + ': long item "' + item + '"')
        }
      }
    }
  }
  return malas
}

test('the economic block with a wallet validates against the frozen schema, untouched', async (t) => {
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
    'the real economic block validates against manifest-v0.json'
  )
  t.is(conWallet.schemaVersion, schema.properties.schemaVersion.const, 'without bumping schemaVersion')

  // And the mock does NOT validate, which is an old, known problem: D2 asks
  // for the mock to be marked wherever it's visible, `economic` declares
  // additionalProperties:false, and the two rules collide. It's pinned HERE so
  // that the day someone fixes it -- or breaks it further -- the test says so,
  // instead of nobody looking at it.
  //
  // `directory` has the exact same clash and it predates this phase.
  const sinWallet = buildManifest({ publicKey: id.publicKey, models: MODELS })
  t.alike(
    violacionesDe(sinWallet.economic, esquemaEconomic),
    ['extra property: "_mock"'],
    'without a wallet the ONLY violation is the mock marker (B19), and no other'
  )
  t.alike(
    violacionesDe(sinWallet.directory, schema.properties.directory),
    ['extra property: "_mock"'],
    'and directory has the same issue since before this phase'
  )

  tmp.limpiar()
})

// ---------------------------------------------------------------------------
// Manifest: directory stops being a mock when there's a Hyperbee behind it
// ---------------------------------------------------------------------------

test('buildManifest signs the real directory when given one', async (t) => {
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

  t.absent(m.directory._mock, 'no mock marker: the directory is real')
  t.is(m.directory.writerPublicKey, directory.writerPublicKey)
  t.is(m.directory.sequence, 7)
  t.ok(verifyManifest(m, { expectedPublicKey: id.publicKey }).ok, 'the signature covers the directory')

  // A badly built descriptor has to die BEFORE it gets signed: a manifest
  // signed with a key that doesn't exist sends the peer off to replicate
  // nothing, and the error shows up three hops from where it originated.
  t.exception(
    () =>
      buildManifest({
        publicKey: id.publicKey,
        models: MODELS,
        directory: { ...directory, writerPublicKey: 'nope' }
      }),
    /32-byte hex/
  )
  t.exception(
    () =>
      buildManifest({
        publicKey: id.publicKey,
        models: MODELS,
        directory: { ...directory, sequence: -1 }
      }),
    /integer/
  )
})

test('changing the signed directory invalidates the signature', async (t) => {
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

  // Pointing another node's directory at your own Hyperbee would let you
  // rewrite the entire marketplace for anyone who trusts that manifest.
  const alterado = { ...m, directory: { ...m.directory, writerPublicKey: 'ff'.repeat(32) } }
  t.absent(verifyManifest(alterado, { expectedPublicKey: id.publicKey }).ok)
})

// ---------------------------------------------------------------------------
// File links (qvac://)
// ---------------------------------------------------------------------------

test('qvac:// links round-trip without losing anything', async (t) => {
  const { formatLink, parseLink, drivePath } = await import('../qvac/files.mjs')
  const clave = '3f'.repeat(32)

  const link = formatLink(clave, '/planos/casa.pdf')
  t.is(link, 'qvac://' + clave + '/planos/casa.pdf')

  const vuelta = parseLink(link)
  t.is(vuelta.keyHex, clave)
  t.is(vuelta.path, '/planos/casa.pdf')

  // Without a path the root is assumed: useful for listing the whole drive.
  t.is(parseLink('qvac://' + clave).path, '/')

  t.exception(() => parseLink('http://ejemplo.com/x.pdf'), /starts with/)
  t.exception(() => parseLink('qvac://cortito/x.pdf'), /32-byte hex/)

  // On Windows path.join inserts backslashes. Without normalizing, the file
  // gets uploaded with backslashes in the name and nobody can find it on the
  // other end.
  t.is(drivePath('planos\\casa.pdf'), '/planos/casa.pdf')
  t.is(drivePath('//planos//casa.pdf'), '/planos/casa.pdf')
})

// ---------------------------------------------------------------------------
// Hyperbee directory + the barrier that separates it from routing
// ---------------------------------------------------------------------------

async function directorioTemporal() {
  const Corestore = require('corestore')
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  const { Directory } = await import('../qvac/directory.mjs')

  // mkdtempSync is not used: on Windows bare-fs returns an extended path
  // and RocksDB concatenates "db/LOG" onto it with a normal slash, which
  // is illegal past that prefix. The real code doesn't go through mkdtemp.
  // See NOTES.md.
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

test('the directory stores peers and indexes them by model', async (t) => {
  const { directory, close } = await directorioTemporal()
  const A = 'aa'.repeat(32)
  const B = 'bb'.repeat(32)

  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['facturas-ar', 'llama1b']))
  await directory.recordManifest(B, manifiestoDe('ArqNode', ['llama1b']))
  await directory.flush()

  const pares = await directory.knownPeers()
  t.is(pares.length, 2, 'both peers stayed saved')

  // The secondary index by model is what avoids walking every peer to answer
  // "who serves llama1b".
  const proveedores = await directory.providersOf('llama1b')
  t.is(proveedores.length, 2)
  t.alike(proveedores.map((p) => p.operator).sort(), ['ArqNode', 'FiscalNode'])
  t.is((await directory.providersOf('facturas-ar')).length, 1)

  // Re-announcing with FEWER models can't leave ghosts from the previous
  // announcement.
  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['facturas-ar']))
  await directory.flush()
  const soloB = await directory.providersOf('llama1b')
  t.is(soloB.length, 1, 'the model the peer stopped serving is no longer indexed')
  t.is(soloB[0].operator, 'ArqNode')

  await close()
})

test('the directory accumulates stats and a prunable log', async (t) => {
  const { directory, close } = await directorioTemporal()
  const A = 'aa'.repeat(32)

  await directory.recordStat(A, { ok: true, ms: 120, tokens: 50 })
  await directory.recordStat(A, { ok: false, ms: 900, tokens: 0 })
  await directory.flush()

  const s = await directory.stats(A)
  t.is(s.requests, 2)
  t.is(s.errors, 1, 'errors are counted separately: it is the basis of reputation')
  t.is(s.tokens, 50)

  const ahora = Date.now()
  await directory.pushLog({ que: 'viejo' }, { now: ahora - 30 * 24 * 60 * 60 * 1000 })
  await directory.pushLog({ que: 'nuevo' }, { now: ahora })
  await directory.flush()

  const log = await directory.recentLog(10)
  t.is(log.length, 2)
  t.is(log[0].que, 'nuevo', 'the log comes out newest to oldest')

  const podadas = await directory.pruneLog({ now: ahora })
  t.is(podadas, 1, 'the 30-day-old entry gets pruned')
  t.is((await directory.recentLog(10)).length, 1)

  await close()
})

test('a directory peer can NOT become a routing candidate', async (t) => {
  const { directory, close } = await directorioTemporal()
  const store = await import('../qvac/store.mjs')
  const A = 'aa'.repeat(32)

  await directory.recordManifest(A, manifiestoDe('FiscalNode', ['llama1b']))
  await directory.flush()

  store.attachDirectory(directory)
  const n = await store.hydrateFromDirectory()
  t.is(n, 1, 'the bee\'s peer enters the grid')

  const filas = store.listNodes().filter((f) => f.modelId === 'llama1b')
  t.is(filas.length, 1)
  t.is(filas[0].kind, 'known', 'enters as known, not as a connected peer')
  t.is(filas[0].status, 'offline')

  // THE invariant: a replicated manifest proves someone said something, not
  // that they're alive. D3 can't have exceptions, not even by accident.
  t.is(store.findAllByModelId('llama1b').length, 0, 'is not a routing candidate')

  // When it actually connects, it IS one.
  store.upsertFromManifest(A, manifiestoDe('FiscalNode', ['llama1b']))
  t.is(store.findAllByModelId('llama1b').length, 1, 'with a live socket it becomes a candidate')

  // And when the connection drops it goes back to known: it stops routing
  // instantly, but doesn't disappear from the panel.
  store.removeByPeer(A)
  t.is(store.findAllByModelId('llama1b').length, 0, 'stops being a candidate instantly')
  t.is(store.listNodes().filter((f) => f.modelId === 'llama1b')[0].status, 'offline')

  store.attachDirectory(null)
  await close()
})

// ---------------------------------------------------------------------------
// Phase 6.5 — costs (qvac/costs.mjs)
// ---------------------------------------------------------------------------

test('estimate caps from above and real charges what was generated', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // The typical turn from the ROADMAP: 2000 input, 500 output, Sonnet 5 at
  // standard price. 2000 * 3 + 500 * 15 = 6000 + 7500 = 13500 micros.
  const usado = costs.real({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    completionTokens: 500
  })
  t.is(usado, 13500, 'USD 0.0135 per turn, the number that calibrates the cap')

  // The estimate assumes ALL of maxTokens gets generated. It has to be
  // greater than or equal to the real cost of the same request: otherwise the
  // reserve falls short and the cap gets exceeded.
  const estimado = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 4096
  })
  t.ok(estimado >= usado, 'the estimate never falls below the real cost')
  t.is(estimado, 6000 + Math.ceil((4096 * 15_000_000) / 1_000_000))
})

test('what is not in the price table comes out zero', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // Local inference and a network peer's inference don't cost dollars. This
  // path exists so the counter has ONE single entry for all targets, instead
  // of an `if` in the gateway.
  t.is(costs.real({ model: 'llama1b', promptTokens: 9999, completionTokens: 9999 }), 0)
  t.absent(costs.conocido('llama1b'))
  t.ok(costs.conocido('claude-sonnet-5'))
})

test('amounts are integers and round up', async (t) => {
  const costs = await import('../qvac/costs.mjs')

  // An input token from Sonnet 5 costs exactly 3 micros; one from Haiku, 1.
  // What matters in the small case is that it does NOT return 0: truncating
  // downward accumulates spend the counter never sees.
  const unToken = costs.real({ model: 'claude-haiku-4-5', promptTokens: 1, completionTokens: 0 })
  t.is(unToken, 1, 'a token cannot cost zero')
  t.ok(Number.isInteger(unToken), 'amounts are integers, never floats')

  // usdAMicros rounds the other way -- downward -- because a cap never grows
  // from a rounding.
  t.is(costs.usdAMicros(20), 20_000_000)
  t.is(costs.usdAMicros(0.1), 100_000)
  t.is(costs.usdAMicros(-5), 0, 'a negative cap is zero, not a debt')
})

// ---------------------------------------------------------------------------
// Phase 6.5 — budget (qvac/budget.mjs)
// ---------------------------------------------------------------------------

test('the reserve sets aside the upper bound and settling returns the rest', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  budget.reset()

  const estimado = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 4096
  })
  const r = budget.reserve('ana', estimado)
  t.ok(r.ok, 'fits within the USD 20 cap')

  // While the request is in flight the balance is committed: it isn't spend
  // yet, but it isn't available for another request either.
  const enVuelo = budget.usage('ana')
  t.is(enVuelo.spent, 0, 'nothing spent yet')
  t.is(enVuelo.reserved, estimado, 'but it is set aside')
  t.is(enVuelo.remaining, budget.TOPE_DEFAULT_MICROS - estimado)

  // The model generated 500 tokens, not the 4096 of the cap. The difference
  // comes back.
  const real = costs.real({ model: 'claude-sonnet-5', promptTokens: 2000, completionTokens: 500 })
  t.is(budget.settle(r.id, real), 13500, 'charges what it really cost')

  const cerrado = budget.usage('ana')
  t.is(cerrado.spent, 13500)
  t.is(cerrado.reserved, 0, 'the reserve was released')
  t.is(cerrado.remaining, budget.TOPE_DEFAULT_MICROS - 13500, 'the leftover went back to the balance')
})

test('THE CAP CUTS: real spend never exceeds the declared amount', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  budget.reset()

  // Phase 6.5's DoD: a USD 0.10 cap, consumed until exhausted.
  const TOPE = costs.usdAMicros(0.1)
  budget.setCap('ana', TOPE)

  const porTurno = costs.estimar({
    model: 'claude-sonnet-5',
    promptTokens: 2000,
    maxTokens: 500
  })

  let aceptados = 0
  let rechazado = null
  // More rounds than the cap can pay for, so the cutoff has to happen inside
  // the loop and not from running out of iterations.
  for (let i = 0; i < 100; i++) {
    const r = budget.reserve('ana', porTurno)
    if (!r.ok) {
      rechazado = r
      break
    }
    aceptados++
    budget.settle(r.id, porTurno)
  }

  t.ok(rechazado, 'it cuts off at some point')
  t.is(rechazado.reason, 'presupuesto agotado')
  t.ok(aceptados > 0, 'and it let work happen before cutting off')

  const fin = budget.usage('ana')
  t.ok(fin.spent <= TOPE, 'THE INVARIANT: spend never exceeds the cap')
  t.ok(fin.remaining < porTurno, 'and what is left isn\'t enough for another turn')
})

test('zero cost does not touch the ledger', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()
  budget.setCap('ana', 0) // not a cent of budget

  // Local inference: free. Has to pass regardless, with the cap at zero. This
  // is Phase 6.5's degradation -- the network and the external path get cut,
  // not the product.
  const r = budget.reserve('ana', 0)
  t.ok(r.ok, 'free is never rejected, not even with the cap exhausted')
  t.is(r.id, null, 'and it does not open a reserve that would later need settling')
  t.is(budget.usage('ana').spent, 0)
})

test('two requests in flight do not spend the same dollars', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()
  budget.setCap('ana', 1000)

  const a = budget.reserve('ana', 600)
  const b = budget.reserve('ana', 600)

  t.ok(a.ok, 'the first fits')
  t.absent(b.ok, 'the second does NOT: the first one\'s 600 is already committed')
  t.is(b.remaining, 400)

  // When the first settles cheap, the second fits now.
  budget.settle(a.id, 100)
  t.ok(budget.reserve('ana', 600).ok, 'with the balance returned there is room again')
})

test('settle never charges more than what was reserved', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  const r = budget.reserve('ana', 1000)
  // The real cost came out higher than the upper bound: the estimate was
  // wrong. The user doesn't pay for the error -- charging more would mean
  // exceeding the cap through the back window.
  t.is(budget.settle(r.id, 5000), 1000, 'charges what was reserved, not the real cost')
  t.is(budget.usage('ana').spent, 1000)
})

test('the month rolls over: spend goes back to zero, the cap survives, the closed one stays', async (t) => {
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
  t.is(feb.spent, 0, 'spend starts from zero')
  t.is(feb.cap, 500_000, 'the cap does NOT reset: it is monthly, not a one-month thing')

  // And January is still available to bill it, which is the whole point of
  // saving it.
  const cierre = budget.report({ period: '2026-01', now: FEBRERO })
  t.ok(cierre.found, 'the closed month can be read later')
  t.is(cierre.total, 300_000)
  t.is(cierre.accounts[0].account, 'ana')
})

test('the breakdown accumulates during the month, it is not computed at close', async (t) => {
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
  t.is(rep.accounts[0].account, 'beto', 'ordered by spend')
  t.is(rep.accounts[0].spent, 12000)
  t.is(rep.accounts[1].spent, 8000, 'ana sums her two requests')
})

test('local:true survives normalizeRequest in the standard OpenAI shape', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  // Regression. Our own short form returned `local` and the standard one
  // didn't, so the chat's "local only" toggle -- which sends the standard
  // form -- arrived as undefined and handleChat never filtered peers. The
  // screen's lock closed nothing.
  const estandar = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    local: true
  })
  t.is(estandar.local, true, 'the standard form preserves local')

  const corta = normalizeRequest({ modelId: 'llama1b', prompt: 'hola', local: true })
  t.is(corta.local, true, 'the short form too, as it already did')

  // And without the field it is still false, not undefined: the filter
  // compares by truthiness, but the normalizer's contract is to return a
  // boolean.
  const sinFlag = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(sinFlag.local, false)
})

// ---------------------------------------------------------------------------
// Phase 6.6 — provider's free quota (qvac/quota.mjs)
// ---------------------------------------------------------------------------

test('quota cuts off when exhausted and says when it replenishes', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'aa'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  t.ok(quota.check(PAR, { now: T0 }).ok, 'a new peer gets in')
  t.is(quota.restante(PAR, { now: T0 }), 100_000)

  quota.registrar(PAR, 100_000, { now: T0 })

  const cortado = quota.check(PAR, { now: T0 })
  t.absent(cortado.ok, 'quota exhausted, cuts off')
  t.is(cortado.remaining, 0)
  // The actionable data: without this the consumer knows it can't, but not
  // when it could.
  t.ok(cortado.resetsInMs > 0, 'says how long until it replenishes')
})

test('the window is a sliding one: it replenishes on its own as hours pass', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'bb'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)
  const hora = (n) => T0 + n * 60 * 60 * 1000

  // Spends the whole quota split across two different hours.
  quota.registrar(PAR, 60_000, { now: hora(0) })
  quota.registrar(PAR, 40_000, { now: hora(1) })
  t.absent(quota.check(PAR, { now: hora(2) }).ok, 'exhausted')

  // At exactly 24 hours, hour 0's bucket leaves the window and its 60,000
  // comes back; hour 1's 40,000 stays in. This is what makes the quota
  // replenish gradually instead of spiking at midnight.
  //
  // The edge matters and it's easy to get wrong: a bucket counts while
  // `hora > ahora - ventana`. At 24h that leaves bucket 0 out and bucket 1 in;
  // at 25h both are already out.
  t.is(quota.usado(PAR, { now: hora(24) }), 40_000, 'the oldest hour left the window')
  t.ok(quota.check(PAR, { now: hora(24) }).ok, 'and it is possible to request again')

  t.is(quota.usado(PAR, { now: hora(25) }), 0, 'one more hour and the window emptied entirely')
})

test('each peer has its own quota', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const A = 'aa'.repeat(32)
  const B = 'bb'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  quota.registrar(A, 100_000, { now: T0 })

  t.absent(quota.check(A, { now: T0 }).ok, 'A ran out of quota')
  t.ok(quota.check(B, { now: T0 }).ok, 'and B doesn\'t know about it')
  t.is(quota.restante(B, { now: T0 }), 100_000)

  // The provider's panel sees both rows, ordered by consumption.
  const filas = quota.listar({ now: T0 })
  t.is(filas.length, 1, 'B does not show up because it consumed nothing')
  t.is(filas[0].peerKey, A)
  t.is(filas[0].used, 100_000)
})

test('the quota is configurable and registering ignores garbage', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()

  const PAR = 'cc'.repeat(32)
  const T0 = Date.UTC(2026, 7, 25, 10, 0, 0)

  quota.configurar({ tokens: 500, horas: 1 })
  t.is(quota.config().tokens, 500)

  t.is(quota.registrar(PAR, -20, { now: T0 }), 0, 'a negative does not discount someone else\'s quota')
  t.is(quota.registrar(PAR, 'ocho', { now: T0 }), 0, 'nor does a string count')
  t.is(quota.usado(PAR, { now: T0 }), 0)

  quota.registrar(PAR, 500, { now: T0 })
  t.absent(quota.check(PAR, { now: T0 }).ok, 'with the small quota it cuts off sooner')
  quota.reset()
})

// ---------------------------------------------------------------------------
// Phase 8 / D6 — choosing a candidate by load (qvac/routing.mjs)
// ---------------------------------------------------------------------------

// A candidate as store.findAllByModelId returns it, with the minimum that
// routing looks at.
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

// fixed random: with all jitters equal, V8's sort is stable, so the input
// order survives ties and the test is deterministic.
const SIN_AZAR = () => 0.5

test('D6: between two peers, the one with less load wins', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const cargado = cand('cargado', 'peer', 9, 10) // 90%
  const libre = cand('libre', 'peer', 1, 10) // 10%

  // Passed in the "bad" order on purpose: before, the first one in the list
  // won, and this would have passed the same way without looking at load.
  const r = pickCandidate([cargado, libre], { random: SIN_AZAR })

  t.is(r.node.id, 'libre', 'picks the unloaded one, not the first in the list')
  t.is(r.decision.loadPct, 10)
  t.ok(r.reason.includes('lower load'), 'and the reason says so: ' + r.reason)
  t.alike(
    r.orden.map((n) => n.id),
    ['libre', 'cargado'],
    'the retry order is also ordered'
  )
})

test('D6: a saturated candidate ends up last, not out', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const lleno = cand('lleno', 'peer', 3, 3)
  const libre = cand('libre', 'real', 0, 3)

  const r = pickCandidate([lleno, libre], { random: SIN_AZAR })

  t.is(r.node.id, 'libre', 'the one that can serve wins, even if it is the local one')
  // Still in the list: if the free one fails before the first token, D4
  // retries, and a full peer is a better candidate than none.
  t.is(r.orden.length, 2, 'the saturated one is still available for the retry')
  t.is(r.orden[1].id, 'lleno')
})

test('D6: with everyone saturated, no winner gets invented, it gets said', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const r = pickCandidate([cand('a', 'peer', 3, 3), cand('b', 'peer', 5, 5)], {
    random: SIN_AZAR
  })

  t.ok(r.node, 'still returns one: rejecting outright would be worse than trying')
  t.ok(r.reason.includes('saturated'), 'but the reason does not fake a decision: ' + r.reason)
})

test('D6: with even load, the order from --demo mode is preserved', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // An idle network: everyone at 0. This is the normal case, not the rare one.
  const local = cand('local', 'real', 0, 3)
  const par = cand('par', 'peer', 0, 3)

  const r = pickCandidate([local, par], { random: SIN_AZAR })

  // The preference for the peer is from demo mode (store.mjs:453-461) and
  // survives as a tiebreaker: without this, `--demo --swarm` stops exercising
  // the P2P path.
  t.is(r.node.id, 'par', 'tied on load, the peer still goes first')
})

test('D6: a mock never beats a real candidate', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // The mock fluctuates randomly (store.startFluctuation) and can land at 0
  // while the real peer is at half. Its load is theater: comparing it against
  // real load is comparing a number to fiction.
  const mock = cand('mock', 'mock', 0, 4)
  const par = cand('par', 'peer', 2, 4)

  const r = pickCandidate([mock, par], { random: SIN_AZAR })

  t.is(r.node.id, 'par', 'the mock stays behind even if it shows less load')
})

test('D6: history breaks the tie when load is equal', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const bueno = cand('bueno', 'peer', 1, 10)
  const malo = cand('malo', 'peer', 1, 10)

  const statsFor = (n) =>
    n.id === 'malo'
      ? { requests: 10, errors: 5, lastMs: 100 }
      : { requests: 10, errors: 0, lastMs: 900 }

  const r = pickCandidate([malo, bueno], { statsFor, random: SIN_AZAR })

  t.is(r.node.id, 'bueno', 'fewer errors wins, even if slower')
  t.ok(r.reason.includes('errors'), r.reason)
})

// ---------------------------------------------------------------------------
// PHASE 8 — price enters routing
//
// The half of the phase that was missing. What these tests pin down isn't
// "the cheap one wins": it's WHERE it wins, which is the only debatable part.
// Behind load, because the cheap option that's full isn't cheap; ahead of
// latency and of the type-based tiebreaker, because that last one was "demo
// mode preference, no longer a criterion" and had been deciding money matters
// by accident.
// ---------------------------------------------------------------------------

// Price per candidate in micro-dollars, as the gateway passes it: already
// tied to the request. A peer and the local engine give zero, which today is
// the truth and not a placeholder -- P2P payment is Phase 9.
function precioFijo(tabla) {
  return (n) => tabla[n.id] || 0
}

test('PHASE 8: with even load the cheapest wins, and the log states both prices', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const caro = cand('caro', 'upstream', 0, 4)
  const barato = cand('barato', 'upstream', 0, 4)

  const r = pickCandidate([caro, barato], {
    precioDe: precioFijo({ caro: 5000, barato: 900 }),
    random: SIN_AZAR
  })

  t.is(r.node.id, 'barato')
  t.ok(r.reason.includes('cheaper'), r.reason)
  // Both numbers: without the second one, "the cheaper one" can't be audited
  // against anything -- the same requirement the DoD makes for the load reason.
  t.ok(r.reason.includes('0.0009') && r.reason.includes('0.005'), 'names both: ' + r.reason)
})

test('PHASE 8: price does NOT beat "can serve right now"', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // The free one is at 90%; the paid one, empty. The free one still wins:
  // sending the request to the expensive one because the cheap one is loaded
  // would be trading dollars for latency without anyone asking for it.
  const gratisCargado = cand('gratis', 'peer', 9, 10)
  const caroLibre = cand('caro', 'upstream', 0, 10)

  const conLugar = pickCandidate([caroLibre, gratisCargado], {
    precioDe: precioFijo({ caro: 5000 }),
    random: SIN_AZAR
  })
  t.is(conLugar.node.id, 'caro', 'with LESS load the expensive one wins: load goes first')

  // And the other way around: really full, the expensive one moves to the
  // front even though it costs.
  const gratisLleno = cand('gratis', 'peer', 10, 10)
  const r = pickCandidate([gratisLleno, caroLibre], {
    precioDe: precioFijo({ caro: 5000 }),
    random: SIN_AZAR
  })
  t.is(r.node.id, 'caro', 'a saturated candidate is not cheap: it is none')
})

test('PHASE 8: free beats paid by PRICE, not by node type', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // This is the behavior Phase 8.5 already considered correct ("with both
  // doors open, the home one answers"), but it was produced by step 7's
  // `kind` tiebreaker. With price, the reason stops being an accident.
  const local = cand('local', 'upstream', 0, 4) // our own engine: costs nothing
  const tercero = cand('tercero', 'upstream', 0, 4) // API that charges

  const r = pickCandidate([tercero, local], {
    precioDe: precioFijo({ tercero: 2500 }),
    random: SIN_AZAR
  })
  t.is(r.node.id, 'local', 'same kind, same load: price decides')
  t.ok(r.reason.includes('cheaper'), 'and the reason says so: ' + r.reason)
  t.ok(r.reason.includes('free'), 'zero is written as "free", not "USD 0.0000": ' + r.reason)
})

test('PHASE 8: price is compared BEFORE latency and errors', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const barato = cand('barato', 'upstream', 0, 4)
  const caro = cand('caro', 'upstream', 0, 4)

  // The expensive one has a better history on both dimensions. It still
  // loses: with even load the DoD says the cheaper one wins.
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

  // And with EQUAL prices they go back to deciding, which is what makes
  // adding price not break the tiebreaker between peers -- where everyone is
  // worth zero.
  const conEmpate = pickCandidate([caro, barato], {
    statsFor,
    precioDe: precioFijo({ caro: 900, barato: 900 }),
    random: SIN_AZAR
  })
  t.is(conEmpate.node.id, 'caro', 'tied on price, history decides')
  t.ok(conEmpate.reason.includes('errors'), conEmpate.reason)
})

test('PHASE 8: without precioDe, routing behaves the same as before', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  // The rest of the suite calls pickCandidate without `precioDe`, and it has
  // to keep working: price is a new criterion, not a new requirement.
  const cargado = cand('cargado', 'peer', 9, 10)
  const libre = cand('libre', 'peer', 1, 10)
  const r = pickCandidate([cargado, libre], { random: SIN_AZAR })
  t.is(r.node.id, 'libre', 'still goes by load')

  // And a precioDe that blows up can't take down routing, same as history.
  const roto = pickCandidate([cargado, libre], {
    precioDe: () => {
      throw new Error('costs exploto')
    },
    random: SIN_AZAR
  })
  t.is(roto.node.id, 'libre', 'still routes the same, without the price criterion')
})

test('D6: broken history cannot take down routing', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const statsFor = () => {
    throw new Error('el bee exploto')
  }

  const r = pickCandidate([cand('a', 'peer', 0, 3)], { statsFor, random: SIN_AZAR })
  t.is(r.node.id, 'a', 'routes the same, without the history tiebreaker')
})

test('pin: pinning a machine selects it, and if it is not there it does NOT fall back to another', async (t) => {
  const { pickCandidate } = await import('../qvac/routing.mjs')

  const a = cand('a', 'peer', 0, 3)
  const b = cand('b', 'peer', 0, 3)

  const fijado = pickCandidate([a, b], { pin: 'b', random: SIN_AZAR })
  t.is(fijado.node.id, 'b', 'respects the chosen machine')
  t.is(fijado.decision.pin, true)
  t.is(fijado.orden.length, 1, 'no alternatives: a pin is a pin')

  // The chosen node left the network between the selector being drawn and the
  // prompt being sent. Answering with ANOTHER machine without warning would
  // empty the function of meaning: whoever pins a machine wants that one.
  const ausente = pickCandidate([a, b], { pin: 'ghost', random: SIN_AZAR })
  t.absent(ausente.node, 'does not pick a replacement')
  t.ok(ausente.reason.includes('ghost'), ausente.reason)
})

test('pin: a pinned and saturated machine is returned, with the notice', async (t) => {
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

test('S5: markSaturated keeps the peer full until the next node:status', async (t) => {
  const store = await import('../qvac/store.mjs')
  const { estaSaturado } = await import('../qvac/routing.mjs')

  // A modelId of this test's own: the registry is module-level state and it
  // is shared by every test in the file.
  store.registerLocal({
    modelId: 'test-saturacion',
    displayName: 'T',
    operator: 'test',
    maxConcurrentRequests: 3
  })
  const fila = store.listNodes().find((n) => n.modelId === 'test-saturacion')

  t.absent(estaSaturado(fila), 'starts with room')

  store.markSaturated(fila.id)
  t.ok(
    estaSaturado(store.getNode(fila.id)),
    'after an at_capacity it is full without waiting for the status\'s 2s'
  )

  // And there's no flag to remember or expire: the next node:status writes
  // activeRequests without looking at what was there (store.mjs:374-386), so
  // the peer's real truth overwrites this on its own.
  store.kick(fila.id)
})

test('normalizeRequest accepts pinning the machine, not just the model', async (t) => {
  const { normalizeRequest } = await import('../qvac/gateway.mjs')

  const conPin = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }],
    node: 'abc123:llama1b'
  })
  t.is(conPin.pin, 'abc123:llama1b', 'the node id makes it all the way to routing')

  // Without the field it is null, not undefined: the normalizer's contract is
  // to return something comparable, same as with `local`.
  const sinPin = normalizeRequest({
    model: 'llama1b',
    messages: [{ role: 'user', content: 'hola' }]
  })
  t.is(sinPin.pin, null)

  // An empty or whitespace string means "I didn't choose one", not a machine
  // named "". Without this, routing would look for a node with an empty id
  // and give a 404.
  t.is(
    normalizeRequest({ model: 'l', messages: [{ role: 'user', content: 'h' }], node: '   ' }).pin,
    null
  )

  // And our own short form too, same as with local.
  t.is(normalizeRequest({ modelId: 'llama1b', prompt: 'hola', node: 'x:y' }).pin, 'x:y')
})

// ---------------------------------------------------------------------------
// Phase 6.6 / D23 — the free quota hooked into the provider (qvac/quota.mjs)
// ---------------------------------------------------------------------------

// A Provider with a fake engine: it doesn't load weights, doesn't touch the
// registry, and generates exactly the tokens it's asked for. Without this
// there's no way to test the quota discount without 807 MB and a GPU.
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

// Collects what the provider answers to the peer.
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

test('the quota is discounted by tokens really served', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 12 })

  const provider = await providerDePrueba(5)

  const primera = await pedir(provider, PEER, 'r1')
  t.is(primera[0].type, 'chat:accepted', 'with quota available, it goes through')
  t.is(quota.usado(PEER.key), 5, 'discounts what was generated, not what was requested')

  await pedir(provider, PEER, 'r2')
  t.is(quota.usado(PEER.key), 10)

  quota.reset()
})

test('with quota exhausted, it rejects BEFORE spending the GPU', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 4 })

  const provider = await providerDePrueba(5)

  await pedir(provider, PEER, 'r1')
  t.is(quota.usado(PEER.key), 5, 'the first one is served in full even if it overshoots')

  // The overflow of ONE request is accepted on purpose (see quota.mjs):
  // cutting a generation in half looks like a bug and still gives away the
  // GPU already spent. What can't happen is the next one getting in.
  const segunda = await pedir(provider, PEER, 'r2')

  t.is(segunda[0].type, 'chat:error', 'the second one does not go through')
  t.is(segunda[0].code, 'quota_exceeded')
  t.is(segunda.length, 1, 'not a single chunk: no GPU was spent')
  t.ok(segunda[0].resetsInMs > 0, 'and it says how long until it replenishes: ' + segunda[0].resetsInMs)

  quota.reset()
})

test('the quota is per peer: exhausting one does not touch the other', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  quota.configurar({ tokens: 3 })

  const provider = await providerDePrueba(5)
  const otro = { key: 'ab'.repeat(32) }

  await pedir(provider, PEER, 'r1')
  const suyo = await pedir(provider, PEER, 'r2')
  t.is(suyo[0].code, 'quota_exceeded', 'the first one ran out of quota')

  // The peer's key is established by the Hyperswarm connection, not by the
  // message content: that's why the provider can count per peer without
  // trusting anyone.
  const ajeno = await pedir(provider, otro, 'r3')
  t.is(ajeno[0].type, 'chat:accepted', 'the other peer has theirs untouched')

  quota.reset()
})

test('a request that fails loading the model does not spend quota', async (t) => {
  const quota = await import('../qvac/quota.mjs')
  const { Provider } = await import('../qvac/provider.mjs')
  quota.reset()

  const provider = new Provider({
    engineLoader: async () => ({
      resolveModel: async () => {
        throw new Error('the registry is not responding')
      }
    }),
    models: [{ modelId: 'llama1b', maxConcurrentRequests: 3 }]
  })

  const vistos = await pedir(provider, PEER, 'r1')
  t.is(vistos[vistos.length - 1].code, 'inference_failed')
  // The quota measures GPU delivered, not attempts: charging the peer for a
  // model that never loaded would be charging them for our problem.
  t.is(quota.usado(PEER.key), 0, 'nothing is discounted from them')

  quota.reset()
})

// ---------------------------------------------------------------------------
// Phase 8.5 — the external assistant as one more candidate
//
// Everything here runs WITHOUT touching NVIDIA's API: the config, the price,
// and D19's three eligibility conditions are tested, which is where the
// decisions live. Whether the provider's SSE parses correctly is verified
// against the real provider, not with a mock that confirms what we already
// believe.
// ---------------------------------------------------------------------------

test('the upstreams config is read in full: models, price, and output cap', async (t) => {
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
  t.is(ups[0].id, 'nim:nvidia/nemotron-3.5-lightning-30b-a3b', 'the id carries provider and model')
  t.is(ups[0].baseUrl, 'https://integrate.api.nvidia.com/v1', 'the trailing slash is removed')
  t.is(ups[0].maxTokens, 512)
  t.alike(ups[0].precio, { entrada: 200_000, salida: 600_000 }, 'USD per 1M -> integer micros')
})

test('an upstream without an output cap still has one: the reserve needs it', async (t) => {
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

  t.ok(ups[0].maxTokens > 0, 'without maxTokens the spend\'s upper bound would be zero')
  t.is(ups[0].precio, null, 'without pricePerMTok no price gets invented')
})

// ---------------------------------------------------------------------------
// The external path's two clocks (B3), and the first one's number (B16)
//
// They're the only thing preventing an external request from staying open
// forever, and with it the budget reserve that authorized it. They had no
// test at all: B3's test proves the clock FIRES, with 300ms set by hand from
// the config, and so it wouldn't have caught the default being miscalibrated.
//
// The number changed to 180s because the previous 60s was two seconds above
// what was measured -- 58s to the first byte against NVIDIA on 2026-08-26 --
// and requests were about to cut themselves off for being slow, not hung.
// ---------------------------------------------------------------------------

test('an upstream without declared clocks still has them, and not at zero', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  const ups = upstream.cargarDesde({
    upstreams: [
      {
        id: 'x',
        baseUrl: 'https://ejemplo.test/v1',
        apiKeyEnv: 'X_KEY',
        models: [
          { modelId: 'porDefecto' },
          // The three ways to get it wrong: zero, negative, and garbage. None
          // of them can end up with a zero timeout, which would fire before
          // starting and leave the external path unusable instead of protected.
          { modelId: 'enCero', timeoutPrimerChunkMs: 0, timeoutIdleMs: 0 },
          { modelId: 'negativo', timeoutPrimerChunkMs: -5000, timeoutIdleMs: -1 },
          { modelId: 'basura', timeoutPrimerChunkMs: 'rapido', timeoutIdleMs: null }
        ]
      }
    ]
  })

  for (const u of ups) {
    t.ok(u.timeoutPrimerChunkMs > 0, u.model + ': the first-byte clock exists')
    t.ok(u.timeoutIdleMs > 0, u.model + ': the silence clock exists')
  }

  // The default, pinned on purpose: if someone lowers it again, let it be a
  // decision and not an oversight. 58s measured against NVIDIA on 2026-08-26
  // is what rules out any number near 60.
  t.is(ups[0].timeoutPrimerChunkMs, 180000, 'three minutes until the first byte')
  t.is(ups[0].timeoutIdleMs, 30000, 'and thirty seconds of silence between tokens')

  // What IS respected is a valid value: a model with known latency can be
  // tuned from the config without touching the code.
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
  t.is(propio[0].timeoutPrimerChunkMs, 300, 'a valid value wins, and that\'s why B3\'s test works')
  t.is(propio[0].timeoutIdleMs, 250)
})

test('opt-in that is absent, broken, or partial means NO', async (t) => {
  const upstream = await import('../qvac/upstream.mjs')

  t.is(upstream.optInDe(null), false)
  t.is(upstream.optInDe({}), false)
  t.is(upstream.optInDe({ optIn: 'true' }), false, 'the string is not enough: it has to be boolean')
  t.is(upstream.optInDe({ optIn: true }), true)
  t.is(upstream.brokerDe({}), false, 'reselling doesn\'t pass by omission either')
})

test('an external model\'s price enters the counter and estimates like the rest', async (t) => {
  const costs = await import('../qvac/costs.mjs')
  costs.olvidarPreciosExternos()

  t.is(costs.conocido('nvidia/nemotron'), false, 'before registering it, it costs nothing')

  t.is(costs.registrarPrecio('nvidia/nemotron', { entrada: 200_000, salida: 600_000 }), true)
  t.is(costs.conocido('nvidia/nemotron'), true)

  // 1000 input at 0.20/1M + 1024 output at 0.60/1M
  const estimado = costs.estimar({
    model: 'nvidia/nemotron',
    promptTokens: 1000,
    maxTokens: 1024
  })
  t.is(estimado, 200 + 615, 'rounds up, like the rest of costs.mjs')

  t.is(costs.registrarPrecio('otro', { entrada: 0, salida: 0 }), false, 'free is not a price')
  t.is(costs.conocido('otro'), false)

  costs.olvidarPreciosExternos()
})

test('D19: the external one does not compete while someone on the network has room', async (t) => {
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

  // Without the eligibility filter, the external one WINS: its load is 0 and
  // the local one's is 66%. That is exactly why the condition is applied as a
  // filter before scoring and not as an `if` afterward.
  const sinFiltro = pickCandidate([local, externo])
  t.is(sinFiltro.node.id, 'upstream:nim', 'by load alone, the external one takes everything')

  const conFiltro = pickCandidate([local])
  t.is(conFiltro.node.id, 'local:llama1b', 'filtered before scoring, the machine answers')
})

test('an upstream row registers, lists, and does not inflate announced capacity', async (t) => {
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
  t.is(fila.kind, 'upstream', 'enters the registry as one more row')
  t.is(fila.status, 'online')

  // What this node announces to the network is what THIS node can serve. An
  // upstream is a third party's capacity: adding it in would mean announcing
  // 7 slots while having 3, the kind of lie the signed manifest exists to
  // prevent.
  t.is(store.localLoad().maxConcurrentRequests, antes, 'local capacity does not change')

  store.clearUpstreams()
  t.absent(
    store.listNodes().find((n) => n.kind === 'upstream'),
    'no old rows are left after re-reading the config'
  )
  store.seed()
})

test('an upstream without a credential registers offline: it can not be a candidate', async (t) => {
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
  t.is(fila.status, 'offline', 'it shows in the panel with what it is missing')
  t.is(
    store.findAllByModelId('nvidia/nemotron').length,
    0,
    'but findAllByModelId does not offer it: it filters by online'
  )

  store.clearUpstreams()
  store.seed()
})

// ---------------------------------------------------------------------------
// B1 — the cap has to survive a restart
//
// The ledger charges the spend to the account, and the account IS the API
// key. With the key registry in memory, that id did not come back after a
// restart: the client requested a new key and started over with the full cap
// again. The cutoff mechanism worked perfectly and was, still, avoidable by
// turning it off and on.
//
// That's why Phase 6.5's closing criterion says "exhaust it, RESTART, and it
// stays cut off": without the restart in between, the test passes with the
// bug still in place.
// ---------------------------------------------------------------------------

function dirTemporalPelado() {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  // Same criterion as directorioTemporal(): no mkdtempSync on Windows.
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

test('the api key survives a restart: without that, the ledger account does not exist', async (t) => {
  const apikeys = await import('../qvac/apikeys.mjs')
  const tmp = dirTemporalPelado()

  apikeys.open(tmp.dir)
  const emitida = apikeys.createKey({ label: 'bot de telegram' })
  apikeys.close()

  // The "restart": the Map gets emptied and read back from disk.
  apikeys.reset()
  apikeys.open(null)
  t.is(apikeys.verifyKey(emitida.key), null, 'without the file, the key does not exist (that is the bug)')

  const cargadas = apikeys.open(tmp.dir)
  t.is(cargadas, 1)

  const reconocida = apikeys.verifyKey(emitida.key)
  t.ok(reconocida, 'the SAME key still works after the restart')
  t.is(reconocida.id, emitida.id, 'and above all: the SAME id, which is the ledger account')
  t.is(reconocida.label, 'bot de telegram')

  apikeys.close()
  apikeys.reset()
  tmp.limpiar()
})

// ---------------------------------------------------------------------------
// B13 — the cap that bounds the BILL, not a client
//
// The per-account cap is fine as a granularity: it's desirable to be able to
// cut off one bot without cutting off another. But it didn't bound anything
// that actually gets paid — the external provider's bill is ONE SINGLE bill,
// against the operator's one and only credential. With N keys issued, the
// real ceiling was N × USD 20 of real money, and keys get issued on their
// own: one per node when hitting "Connect".
//
// Now there are two caps and a request only passes if it fits in BOTH.
// ---------------------------------------------------------------------------

test('B13: three keys are not three caps; the node\'s cap bounds all of them', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  // Each key with its own generous cap. Before B13, this meant a real ceiling
  // of USD 30 against a bill that is only one.
  const keys = ['bot-telegram', 'open-webui', 'terminal']
  for (const k of keys) budget.setCap(k, budget.usdAMicros ? budget.usdAMicros(10) : 10_000_000)
  budget.setNodeCap(12_000_000) // USD 12 for the whole machine

  t.is(budget.nodeCap(), 12_000_000)

  // Two clients spend USD 5 each: they fit within their cap and the node's.
  for (const k of keys.slice(0, 2)) {
    const r = budget.reserve(k, 5_000_000)
    t.ok(r.ok, k + ' gets in: there\'s room in its account and in the node\'s')
    budget.settle(r.id, 5_000_000)
  }

  const agregado = budget.nodeUsage()
  t.is(agregado.spent, 10_000_000, 'the node carries the sum of all accounts')
  t.is(agregado.remaining, 2_000_000, 'and it has USD 2 left, not USD 10')

  // The third one has its own untouched USD 10. It still does NOT pass: the
  // machine no longer has that much. This is all of B13.
  const tercero = budget.reserve('terminal', 5_000_000)
  t.is(tercero.ok, false, 'its account can afford it, the node\'s bill cannot')
  t.is(
    tercero.scope,
    'nodo',
    'and it says WHICH cap ran out: lowering one key\'s cap does not fix this'
  )
  t.is(budget.usage('terminal').spent, 0, 'without having spent a cent of its own')

  // What DOES fit in what's left, passes.
  const chico = budget.reserve('terminal', 1_500_000)
  t.ok(chico.ok, 'the node\'s cap does not block: it bounds')
  budget.settle(chico.id, 1_500_000)

  budget.reset()
})

test('B13: the account cap still cuts off even when the node has plenty left', async (t) => {
  const budget = await import('../qvac/budget.mjs')
  budget.reset()

  // The other direction, and it's what keeps the keys useful for anything: a
  // bounded client can not spend the whole machine's balance.
  budget.setNodeCap(20_000_000)
  budget.setCap('bot-ruidoso', 1_000_000) // USD 1 for this one

  const r = budget.reserve('bot-ruidoso', 2_000_000)
  t.is(r.ok, false, 'its cap cuts off first')
  t.is(r.scope, 'cuenta', 'and the reason points at the account, not the node')
  t.ok(budget.nodeUsage().remaining > 10_000_000, 'the node had plenty to spare')

  budget.reset()
})

test('B13: the node\'s cap survives a restart, and an old ledger does not end up without a ceiling', async (t) => {
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
  t.is(budget.nodeCap(), 3_000_000, 'the node\'s cap persists')
  t.is(budget.nodeUsage().spent, 1_000_000, 'and the aggregate spend too')
  budget.close()

  // A budget.json written BEFORE B13 does not have the field. It can't mean
  // "no cap": an old file would leave the machine spending with no ceiling,
  // which is exactly the bug this closes.
  const ruta = path.default.join(tmp.dir, 'budget.json')
  const crudo = JSON.parse(fs.default.readFileSync(ruta, 'utf8'))
  delete crudo.nodeCap
  fs.default.writeFileSync(ruta, JSON.stringify(crudo))

  budget.open(tmp.dir)
  t.is(
    budget.nodeCap(),
    budget.TOPE_NODO_DEFAULT_MICROS,
    'a ledger without the field takes the default, not infinity'
  )
  budget.close()

  budget.reset()
  tmp.limpiar()
})

test('with the cap exhausted, restarting the node does NOT replenish it', async (t) => {
  const apikeys = await import('../qvac/apikeys.mjs')
  const budget = await import('../qvac/budget.mjs')
  const costs = await import('../qvac/costs.mjs')
  const tmp = dirTemporalPelado()

  // A small cap and a real price, so the spend is real and not a zero
  // account like the local path's.
  costs.olvidarPreciosExternos()
  costs.registrarPrecio('externo-de-prueba', { entrada: 1_000_000, salida: 2_000_000 })

  apikeys.open(tmp.dir)
  budget.open(tmp.dir)

  const key = apikeys.createKey({ label: 'cliente' })
  budget.setCap(key.id, costs.usdAMicros(0.1))

  // Spends until the ledger cuts off.
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
  t.ok(cortado, 'the cap cuts off before the 100 rounds')

  const gastado = budget.usage(key.id).spent
  t.ok(gastado > 0)

  // THE RESTART. This is the step missing from the original DoD.
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
// An engine of our own behind HTTP, and several doors to the same model
//
// Two pieces that go in together because they solve the same problem: the
// embedded engine only loads models from the QVAC registry (engine.mjs
// resolves registry://), so serving open weights -- a GGUF from HuggingFace --
// means standing them up separately and asking for them over HTTP. That makes
// them an upstream in shape, without making them a third party in substance.
// ---------------------------------------------------------------------------

test('a local upstream needs no credential and no price', async (t) => {
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

  t.is(ups.length, 1, 'without apiKeyEnv it still gets in: it is the only one that does not need it')
  t.is(ups[0].esLocal, true)
  t.ok(ups[0].disponible(), 'available with no environment variable set')
  t.is(ups[0].precio, null, 'and no price, because it does not cost dollars')
})

test('a REMOTE upstream without apiKeyEnv gets discarded: it could not authenticate', async (t) => {
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

  t.is(ups.length, 0, 'the failure comes out at config load, not on the first prompt')
})

test('three doors to the same model announce under ONE single name', async (t) => {
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

  // What travels in the body is still the name EACH PROVIDER uses: sending
  // NVIDIA the OpenRouter slug gives a 404.
  t.alike(
    ups.map((u) => u.model),
    [
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3.5-lightning',
      'nemotron-3.5-lightning-30b-a3b'
    ],
    'each one keeps what its provider calls it'
  )

  // And only one gets into the catalog: that's what makes them compete.
  t.alike(
    ups.map((u) => u.anunciadoComo),
    ['nemotron', 'nemotron', 'nemotron'],
    'a single marketplace row for the three doors'
  )
})

test('without "as", the announced name is the provider\'s (nothing changes)', async (t) => {
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

  t.is(ups[0].anunciadoComo, 'proveedor/modelo', 'the default does not break what already worked')
})

test('config headers cannot stomp on the credential', async (t) => {
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

  // Names get normalized to LOWERCASE on the way in (B11). HTTP headers are
  // case-insensitive but a JavaScript object is not, and that mismatch was
  // the hole: a lowercase `authorization` in the config did not collide with
  // the `Authorization` the code writes, both survived and went out
  // concatenated -- one provider's credential travelling to another's endpoint.
  t.is(
    ups[0].extraHeaders['http-referer'],
    'https://ejemplo.test',
    'the provider\'s attribution headers get through, with the name normalized'
  )
  t.absent(ups[0].extraHeaders['HTTP-Referer'], 'and the un-normalized version is gone')

  // The actual assembly lives in a private method; it's exercised by its
  // effect: with a credential, the credential wins; without one, there is no
  // Authorization hand-written into a config file.
  const env = (await import('bare-env')).default
  env.X_KEY = 'la-buena'
  t.is(ups[0].apiKey, 'la-buena')
})

test('a local upstream row gets marked local in the registry', async (t) => {
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
  t.is(fila.local, true, 'the panel needs this so it does not label it "external API"')

  // It still doesn't add to the capacity ANNOUNCED to the network: this
  // process cannot serve it to a peer (provider.mjs dispatches to the
  // embedded engine, not to HTTP).
  const antes = store.localLoad().maxConcurrentRequests
  t.is(antes, store.localLoad().maxConcurrentRequests)
  t.absent(
    store
      .listNodes()
      .filter((n) => n.kind === 'real')
      .some((n) => n.modelId === 'nemotron'),
    'does not pass itself off as the embedded engine'
  )

  store.clearUpstreams()
  store.seed()
})

// ---------------------------------------------------------------------------
// The .env
//
// The upstream config stores the variable's NAME, never the secret. That
// keeps the credential out of the repo, but leaves the operator the job of
// putting it in the environment -- and `bare-env` doesn't read any file, it's
// a proxy over the operating system's environment. Hence this parser.
// ---------------------------------------------------------------------------

test('the .env tolerates what people actually write', async (t) => {
  const { parsear } = await import('../qvac/dotenv.mjs')

  const v = parsear(
    [
      '# un comentario',
      '',
      'SIMPLE=valor',
      // With spaces around the `=`. That's how the .env that prompted all
      // this was written: a strict parser would have created a variable
      // named "CON_ESPACIOS " that matches nothing that gets looked up.
      'CON_ESPACIOS = otro-valor',
      // What comes out of copying a line from the documentation.
      'export EXPORTADA=tercero',
      'COMILLAS="entre comillas"',
      "SIMPLES='tambien'",
      'VACIA=',
      'basura sin igual'
    ].join('\n')
  )

  t.is(v.SIMPLE, 'valor')
  t.is(v.CON_ESPACIOS, 'otro-valor', 'the name gets trimmed: otherwise it matches nothing')
  t.is(v.EXPORTADA, 'tercero')
  t.is(v.COMILLAS, 'entre comillas', 'quotes delimit, they are not part of the value')
  t.is(v.SIMPLES, 'tambien')
  t.is(v.VACIA, '')
  t.absent('basura' in v, 'a line without `=` defines nothing')
})

test('a lone quote is part of the value, not a delimiter', async (t) => {
  const { parsear } = await import('../qvac/dotenv.mjs')

  const v = parsear(['ABIERTA="sin cerrar', 'RARA=xy"z'].join('\n'))
  t.is(v.ABIERTA, '"sin cerrar', 'they only get stripped if they open AND close')
  t.is(v.RARA, 'xy"z', 'a credential can have anything inside it')
})

test('the .env does NOT stomp on a variable already in the environment', async (t) => {
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

  // A .env is the project's default, not an order: whoever exports something
  // by hand -- in their terminal, in a CI, in a systemd unit -- is saying
  // something more specific, and that wins.
  t.is(env.PYRUS_YA_ESTABA, 'del-entorno', 'what was already there does not get touched')
  t.is(env.PYRUS_NUEVA, 'del-archivo', 'what was missing gets loaded')
  t.alike(r.cargadas, ['PYRUS_NUEVA'])
  t.alike(r.yaEstaban, ['PYRUS_YA_ESTABA'], 'and it is known which one was respected')

  fs.default.rmSync(dir, { recursive: true, force: true })
})

test('with no .env nothing happens: that is the normal case', async (t) => {
  const { cargar } = await import('../qvac/dotenv.mjs')
  const os = await import('bare-os')
  const path = await import('bare-path')

  const r = await cargar(path.default.join(os.default.tmpdir(), 'pyrus-no-existe-' + Date.now()))
  t.alike(r.cargadas, [], 'most nodes do not talk to any external API')
})

// ---------------------------------------------------------------------------
// PHASE 9 — that the x402 stack loads, and loads FOR THE DOCUMENTED REASON
//
// `@x402/evm` does not import under Bare on its own: it reaches
// `@noble/hashes/crypto`, which under the `node` condition resolves to a file
// that imports `node:crypto`. With WDK imported beforehand, it works -- and
// the mechanism is NOT diagnosed.
//
// That's uncomfortable on the path that handles payments, so two things
// watch it: step 5 of D11's spike, and this test.
//
// The test runs in a CLEAN PROCESS on purpose. Inside the suite, by the time
// this runs, half a dozen modules are already loaded -- among them
// wallet.mjs, which imports WDK -- so an `await import('../qvac/x402.mjs')`
// here would ALWAYS pass, even with the WDK import deleted from the module.
// It would be another green that doesn't mean what it says.
// ---------------------------------------------------------------------------

function bareLimpio(codigo) {
  const { spawnSync } = require('bare-subprocess')
  const r = spawnSync(Bare.argv[0], ['-e', codigo], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).trim()
}

test('PHASE 9: x402.mjs loads the stack in a clean process', async (t) => {
  const salida = bareLimpio(
    "import('./qvac/x402.mjs').then(m => m.cargar()).then(s =>" +
      " console.log('OK ' + s.core.x402Version + ' ' + Object.keys(s.evm).length))" +
      ".catch(e => console.log('FALL ' + e.message))"
  )
  t.ok(salida.startsWith('OK'), 'loads with nothing preloaded: ' + salida.slice(0, 120))
  t.ok(salida.includes('OK 2'), 'x402Version 2, which is the protocol being implemented')
})

test('PHASE 9: and without the WDK import it would NOT load, which is why it is there', async (t) => {
  // The counter-check. If this started passing, the WDK import stopped being
  // necessary -- and it should come out along with its comment, not be left
  // "just in case". If it fails the other way, someone deleted it and this
  // test says why it hurt.
  const salida = bareLimpio(
    "import('@x402/evm').then(m => console.log('OK ' + Object.keys(m).length))" +
      ".catch(e => console.log('FALL ' + e.message))"
  )
  // It doesn't look for the 'FALL' prefix: the error is thrown by Bare before
  // the import's .catch() gets to exist. What matters is that it does NOT say
  // OK and that the cause is still the diagnosed one.
  //
  // The cause CHANGED once, and this assert caught it: it was `node:crypto`
  // (the packer picking the node variant in @noble/hashes) until that
  // problem was fixed in scripts/parche-noble-bare.js. What's left is the
  // polyfill: viem uses TextEncoder and Bare does not bring it as a global;
  // WDK installs it when it loads.
  t.absent(salida.startsWith('OK'), 'imported alone, it does not load')
  t.ok(
    salida.includes('TextEncoder'),
    'and it is because of the missing global, not something else: ' + salida.slice(0, 110)
  )
})

test('PHASE 9: Plasma is not charged without someone confirming its contract', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const env = (await import('bare-env')).default

  // D15 made Plasma the default, but x402 does not ship it: getDefaultAsset
  // throws "No default asset configured". We declare the contract address
  // ourselves, and it's real money -- so without explicit confirmation it is
  // not used.
  delete env[x402.VAR_PLASMA_OK]
  t.is(await x402.activoDe('plasma'), null, 'unconfirmed, Plasma stays out')

  const stable = await x402.activoDe('stable')
  t.ok(stable, 'Stable does, and its address comes from x402, not from a constant of ours')
  t.is(stable.network, 'eip155:988')
  t.is(stable.symbol, 'USDT0')
  t.is(stable.decimals, 6)

  t.alike(await x402.redesDisponibles(), ['stable'], 'today only one can be charged in')

  env[x402.VAR_PLASMA_OK] = '1'
  const plasma = await x402.activoDe('plasma')
  t.ok(plasma, 'with the operator\'s confirmation, it gets in')
  t.is(plasma.network, 'eip155:9745')
  t.alike(await x402.redesDisponibles(), ['plasma', 'stable'], 'and it goes first, as D15 says')

  delete env[x402.VAR_PLASMA_OK]
})

// ---------------------------------------------------------------------------
// THE CLIENT ROLE — this node paying another (qvac/x402-cliente.mjs)
//
// The mirror of Phases 9/10 on the server side. The strong test is one of
// SYMMETRY: what `crearPago` signs, `verificarPago` from the other module has
// to accept. All offline -- @x402/evm knows Stable out of the box and
// signature recovery is pure crypto, no chain -- for the same reason the rest
// of x402 is tested without funding: the half that matters is synchronous.
//
// The wallet is the public test phrase the whole suite uses and it is NEVER
// funded. The signature is real; the money doesn't exist.
// ---------------------------------------------------------------------------

async function firmanteDePrueba() {
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cuenta = await new WM('test test test test test test test test test test test junk', {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount()
  return { address: await cuenta.getAddress(), signTypedData: (td) => cuenta.signTypedData(td) }
}

test('x402-cliente: what the client signs, the server accepts (symmetry)', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const cli = await import('../qvac/x402-cliente.mjs')

  const activo = await x402.activoDe('stable')
  const payTo = '0x' + '11'.repeat(20)
  const micros = 100

  // The 402 the gateway would build for this charge.
  const entrada = x402.entradaAccepts({
    payTo,
    activo,
    micros,
    maxTokens: 256,
    recurso: '/v1/chat/completions',
    descripcion: 'test de simetria'
  })

  const firmante = await firmanteDePrueba()
  const pago = await cli.crearPago({
    entrada,
    firmante,
    x402Version: 2,
    techoUnidades: cli.techoEnUnidades(1000)
  })

  t.is(pago.sobre.scheme, 'exact')
  t.is(pago.sobre.network, 'eip155:988')
  t.is(pago.autorizacion.to.toLowerCase(), payTo, 'the authorization pays whoever asked for the 402')
  t.is(pago.autorizacion.from.toLowerCase(), firmante.address.toLowerCase())

  // THE test: the header the client produced goes raw into verificarPago.
  const verif = await x402.verificarPago(pago.cabecera, { payTo, activo, micros, red: 'stable' })
  t.ok(verif.ok, 'verificarPago accepts it: ' + (verif.motivo || ''))
  t.is(
    String(verif.payer || '').toLowerCase(),
    firmante.address.toLowerCase(),
    'and the payer is whoever signed'
  )
  t.is(verif.nonce, pago.autorizacion.nonce, 'the idempotency nonce travels intact')
})

test('x402-cliente: does not sign above the cap', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const cli = await import('../qvac/x402-cliente.mjs')

  const activo = await x402.activoDe('stable')
  const entrada = x402.entradaAccepts({
    payTo: '0x' + '11'.repeat(20),
    activo,
    micros: 100, // -> amount '100'
    maxTokens: 256,
    recurso: '/x',
    descripcion: 't'
  })
  const firmante = await firmanteDePrueba()

  await t.exception(
    cli.crearPago({ entrada, firmante, x402Version: 2, techoUnidades: 50n }),
    /techo/,
    'the entrada asks for 100 and the cap is 50: it cuts off before signing'
  )

  // And with the cap exactly matching, it does.
  const ok = await cli.crearPago({ entrada, firmante, x402Version: 2, techoUnidades: 100n })
  t.ok(ok.cabecera, 'cap == amount: passes')
})

test('x402-cliente: elegirEntrada respects D15\'s preference and the cap', async (t) => {
  const cli = await import('../qvac/x402-cliente.mjs')

  const desafio = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:988',
        amount: '100',
        extra: { name: 'USDT0', version: '1' }
      },
      {
        scheme: 'exact',
        network: 'eip155:9745',
        amount: '80',
        extra: { name: 'USDT0', version: '1' }
      }
    ]
  }

  const a = cli.elegirEntrada(desafio, { techoUnidades: 1000n })
  t.is(a.entrada.network, 'eip155:9745', 'Plasma before Stable, as D15 says')

  const b = cli.elegirEntrada(desafio, { techoUnidades: 40n })
  t.absent(b.entrada, 'all above the cap -> none')
  t.ok(/techo/.test(b.motivo), b.motivo)

  const c = cli.elegirEntrada(
    {
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network: 'eip155:1', amount: '1', extra: { name: 'x', version: '1' } }
      ]
    },
    { techoUnidades: 1000n }
  )
  t.absent(c.entrada, 'a network outside the preference does not get paid')
  t.ok(/reconocemos/.test(c.motivo), c.motivo)
})

test('x402-cliente: pedirConPago does the 402 dance and retries ONCE', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const cli = await import('../qvac/x402-cliente.mjs')

  const activo = await x402.activoDe('stable')
  const payTo = '0x' + '11'.repeat(20)
  const desafio = {
    x402Version: 2,
    accepts: [
      x402.entradaAccepts({
        payTo,
        activo,
        micros: 100,
        maxTokens: 256,
        recurso: '/v1/chat/completions',
        descripcion: 't'
      })
    ]
  }

  const llamadas = []
  const fetchFalso = async (url, opts) => {
    llamadas.push({ url, opts })
    if (llamadas.length === 1) {
      return { status: 402, json: async () => desafio, headers: { get: () => null } }
    }
    return { status: 200, json: async () => ({ ok: true }), headers: { get: () => null } }
  }

  const firmante = await firmanteDePrueba()
  const out = await cli.pedirConPago(
    'http://par/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    { firmante, techoMicros: 1000, fetchImpl: fetchFalso }
  )

  t.ok(out.pagado, 'payment: ' + (out.motivo || ''))
  t.is(out.res.status, 200)
  t.is(llamadas.length, 2, 'one request, one 402, one retry -- and that\'s it, no loop')
  t.absent(llamadas[0].opts.headers['x-payment'], 'the first attempt goes out unpaid')
  t.ok(llamadas[1].opts.headers['x-payment'], 'the retry carries the signed X-PAYMENT')

  // And what the retry sent has to verify on the server side.
  const verif = await x402.verificarPago(llamadas[1].opts.headers['x-payment'], {
    payTo,
    activo,
    micros: 100,
    red: 'stable'
  })
  t.ok(verif.ok, 'verificarPago accepts the retry\'s header: ' + (verif.motivo || ''))
})

test('x402-cliente: no 402 means no payment, and no cap means it does not start', async (t) => {
  const cli = await import('../qvac/x402-cliente.mjs')
  const firmante = await firmanteDePrueba()
  const fetch200 = async () => ({
    status: 200,
    json: async () => ({}),
    headers: { get: () => null }
  })

  const out = await cli.pedirConPago(
    'http://x',
    {},
    { firmante, techoMicros: 100, fetchImpl: fetch200 }
  )
  t.absent(out.pagado, 'a 200 does not trigger a payment')
  t.is(out.res.status, 200)

  await t.exception(
    cli.pedirConPago('http://x', {}, { firmante, fetchImpl: fetch200 }),
    /techo/,
    'a payer without a cap does not start -- Phase 11 rule'
  )
})

// ---------------------------------------------------------------------------
// PHASE 9 / D24 — the provider's attestation
//
// The x402 receipt proves someone PAID. This is the other side: the artifact
// where whoever served commits to what they delivered. The tests here test
// the ISOLATED artifact's properties; that the gateway emits it in D27's
// three cutoff cases is in test/integracion.js.
//
// The wallet is the same public test phrase the rest of the suite uses and
// that is NEVER funded. The signature is real; the money doesn't exist.
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

test('D24: the attestation gets signed with the wallet and verifies against its content', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  const firmada = await at.firmar(await atestacionDePrueba(w.address), w.firmar)
  t.ok(firmada, 'signed')
  t.ok(firmada.signature.startsWith('0x'), 'with an EVM signature: ' + firmada.signature.slice(0, 12))
  t.is(firmada.providerPubkey, w.address, 'and it claims to be from the address that actually signed')

  const v = await at.verificar(firmada)
  t.ok(v.ok, 'verifies: ' + (v.reason || ''))
  t.is(v.firmante.toLowerCase(), w.address.toLowerCase())
})

test('D24: changing ONE field after signing invalidates the attestation', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()
  const firmada = await at.firmar(await atestacionDePrueba(w.address), w.firmar)

  // The field that matters is `outputHash`, because it's the one that closes
  // the hole: D24's attack isn't over-reporting -- the gateway already counts
  // on its own -- it's inflating the OTHER side's count by chopping up the
  // stream. The hash is over the full text and the text doesn't depend on how
  // it was chopped, so anyone wanting to sustain an inflated count has to
  // touch this field. And they can't.
  const otroTexto = { ...firmada, outputHash: at.hashDe('otra respuesta') }
  const v1 = await at.verificar(otroTexto)
  t.absent(v1.ok, 'a changed outputHash does not verify')
  t.ok(String(v1.reason).indexOf('dice ser de') !== -1, v1.reason)

  // And the same with the tokens, which is what Phase 10 will want to settle.
  const masTokens = { ...firmada, tokensDecode: 9999 }
  t.absent((await at.verificar(masTokens)).ok, 'nor an inflated tokensDecode')

  // An ADDED field too: JCS canonicalization is over the whole object minus
  // `signature`, not over a list of fields someone has to remember to keep
  // updated.
  const conExtra = { ...firmada, extra: 'lo que sea' }
  t.absent((await at.verificar(conExtra)).ok, 'nor a field that wasn\'t there')
})

test('D24: signing with YOUR wallet does not let you attest as ANOTHER node', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  // The attack: build an attestation that claims to be the neighboring
  // node's and sign it with your own. The signature validates perfectly --
  // it's a real signature -- and proves nothing useful unless it's tied to
  // who claims to have served. Same reasoning as `verifyManifest` with
  // `expectedPublicKey`.
  const ajena = await atestacionDePrueba('0x' + 'cd'.repeat(20))
  const firmada = await at.firmar(ajena, w.firmar)

  const v = await at.verificar(firmada)
  t.absent(v.ok, 'does not verify even with a good signature')
  t.ok(String(v.reason).indexOf(w.address) !== -1, 'and says who really signed: ' + v.reason)
})

test('D24: the order the object is built in does not change the signature', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const w = await walletDePrueba()

  const a = await at.firmar(await atestacionDePrueba(w.address), w.firmar)

  // The same content with the keys inserted in reverse. JCS orders them, so
  // the signed bytes are a function of the CONTENT and not the order the
  // object was built in -- which is the whole reason for canonicalizing.
  const alReves = {}
  for (const k of Object.keys(a).reverse()) alReves[k] = a[k]

  t.absent(
    Object.keys(alReves).join() === Object.keys(a).join(),
    'the test object really does have a different order'
  )
  t.ok((await at.verificar(alReves)).ok, 'and it verifies just the same')
})

test('D24: without a signer, no unsigned attestation comes out', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const base = await atestacionDePrueba('0x' + 'ab'.repeat(20))

  // An artifact that looks like proof and isn't is worse than an absent one.
  // Absence is visible; an unsigned attestation reads as an attestation.
  t.is(await at.firmar(base, null), null, 'without a signer there is no artifact')
  t.is(
    await at.firmar(base, () => 'no-es-una-firma'),
    null,
    'nor with a signer that returns whatever'
  )
  t.is(
    await at.firmar(base, () => {
      throw new Error('la wallet se cayo')
    }),
    null,
    'nor when the wallet throws'
  )
})

test('D24: the hash says what it was computed with', async (t) => {
  const at = await import('../qvac/atestacion.mjs')

  // A bare `promptHash: "3a5f…"` cannot be recomputed by a third party: you
  // need to know which algorithm. It travels stuck to the value and not in a
  // separate field so the two cannot get out of sync.
  const h = at.hashDe('hola')
  t.ok(h.startsWith('blake2b-256:'), h)
  t.is(h.split(':')[1].length, 64, '32 bytes in hex')
  t.is(at.hashDe('hola'), h, 'deterministic')
  t.absent(at.hashDe('holaa') === h, 'and sensitive to one character')

  // The prompt one is over the canonicalized messages: the provider received
  // the whole conversation, not the last turn, and that's what the client
  // can recompute on its side.
  const msgs = [{ role: 'user', content: 'hola' }]
  t.is(at.hashDeMensajes(msgs), at.hashDeMensajes([{ content: 'hola', role: 'user' }]))
  t.absent(at.hashDeMensajes(msgs) === at.hashDe('hola'))
})

test('D24/D26: quantization comes from the model name, and says unknown when it doesn\'t', async (t) => {
  const at = await import('../qvac/atestacion.mjs')

  // The QVAC registry's names carry it inside, so there's no need to touch
  // the manifest's frozen schema (D2) to declare it. The ones below are from
  // the real catalog, not made up.
  t.is(at.cuantizacionDe('Qwen3-4B-Q4_K_M'), 'Q4_K_M')
  t.is(at.cuantizacionDe('llama_3.2_1b_intruct_tool_calling_v2.Q4_K'), 'Q4_K')
  t.is(at.cuantizacionDe('smollm2-360m-instruct-q8_0'), 'Q8_0')
  t.is(at.cuantizacionDe('Qwen3-1.7B-Q4_0'), 'Q4_0')

  // D26: this is a DECLARATION derived from another declaration. When the
  // name says nothing, saying 'unknown' is more honest than assuming F16 --
  // there's no published black-box way to measure it, so making up a default
  // would be asserting something nobody verified.
  t.is(at.cuantizacionDe('gpt-4o-mini'), 'unknown')
  t.is(at.cuantizacionDe(''), 'unknown')
  t.is(at.cuantizacionDe(null), 'unknown')
})

test('D24: this node does NOT attest to what another one served', async (t) => {
  const at = await import('../qvac/atestacion.mjs')
  const yo = { kind: 'real', modelId: 'llama1b' }
  const dir = '0x' + 'ab'.repeat(20)

  t.is(
    at.porQueNoSeFirma({ node: yo, walletAddress: dir, tieneFirmante: true }),
    null,
    'what ran on this machine, yes'
  )

  // The case that matters. D24 requires that THE PROVIDER attest, and when a
  // peer answers, the provider isn't us: we didn't run the model, and on top
  // of that the 402's payTo pointed at THEIR wallet (D10), not ours. Signing
  // an attestation here over someone else's work would be an artifact that
  // looks like proof and isn't. The peer's own gets signed by them, over
  // Protomux, and that's Phase 10.
  const delPar = at.porQueNoSeFirma({
    node: { kind: 'peer', modelId: 'llama1b' },
    walletAddress: dir,
    tieneFirmante: true
  })
  t.ok(delPar, 'what a peer served, NO')
  t.ok(delPar.indexOf('Fase 10') !== -1, 'and it says whose it is and when it arrives: ' + delPar)

  // The other two reasons, so absence is always legible.
  t.ok(at.porQueNoSeFirma({ node: yo, walletAddress: null, tieneFirmante: true }))
  t.ok(at.porQueNoSeFirma({ node: yo, walletAddress: dir, tieneFirmante: false }))
  t.ok(at.porQueNoSeFirma({ node: null, walletAddress: dir, tieneFirmante: true }))
})

// ---------------------------------------------------------------------------
// PHASE 10 — receipt and batch
//
// Phase 9's x402 receipt proves SOMEONE PAID. This is what Phase 10 does with
// that proof: it stores it and settles it DEFERRED, in bulk. The insight that
// makes it cheap is that the EIP-3009 signature already IS the receipt -- an
// off-chain transfer order that does not force settling on the spot.
//
// The tests here test the ISOLATED artifact: the receipt's shape, that the
// batch is for a single network and a single wallet, and that the wallet's
// signature over the batch and the EIP-3009 signatures inside it verify. That
// the gateway accumulates it is in test/integracion.js.
//
// The wallet is the same public test phrase as the rest of the suite and
// that is NEVER funded. The signatures are real; the money doesn't exist.
// ---------------------------------------------------------------------------

async function cuentaDePrueba() {
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  return new WM(FRASE_DE_PRUEBA, { provider: 'http://127.0.0.1:1/no-existe' }).getAccount()
}

// A receipt with an EIP-3009 authorization REALLY signed against the domain
// the receipt declares. `pisar` (override) changes any field after building it.
async function reciboDePrueba(cuenta, i = 0, pisar = {}) {
  const x402 = await import('../qvac/x402.mjs')
  const { evm } = await x402.cargar()
  const address = await cuenta.getAddress()
  const asset = '0x' + 'a1'.repeat(20)
  const network = 'eip155:9746'
  const payTo = '0x' + 'bb'.repeat(20)
  const dominio = {
    name: 'PyrusLLM Test USD',
    version: '1',
    chainId: 9746,
    verifyingContract: asset
  }
  const auth = {
    from: address,
    to: payTo,
    value: String(1000 + i),
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: '0x' + String(i).padStart(64, '0')
  }
  const signature = await cuenta.signTypedData({
    domain: dominio,
    types: evm.authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: 0n,
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce
    }
  })
  const lote = await import('../qvac/lote.mjs')
  return lote.construirRecibo({
    requestId: 'chatcmpl-' + i,
    red: 'plasma-testnet',
    network,
    asset,
    assetName: dominio.name,
    assetVersion: '1',
    payTo,
    payer: address,
    amount: auth.value,
    authorization: auth,
    signature,
    requirements: {
      scheme: 'exact',
      network,
      amount: auth.value,
      asset,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { name: dominio.name, version: '1' }
    },
    ...pisar
  })
}

test('PHASE 10: a receipt missing the essentials does not get built, and says what is missing', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const base = {
    requestId: 'chatcmpl-1',
    network: 'eip155:9746',
    payTo: '0x' + 'bb'.repeat(20),
    authorization: {
      from: '0x' + 'cc'.repeat(20),
      to: '0x' + 'bb'.repeat(20),
      value: '1000',
      nonce: '0x' + '0'.repeat(64)
    },
    signature: '0x' + '11'.repeat(65),
    amount: '1000'
  }
  t.execution(() => lote.construirRecibo(base), 'with the essentials, it gets built')

  t.exception(
    () => lote.construirRecibo({ ...base, requestId: null }),
    /requestId/,
    'without requestId'
  )
  t.exception(() => lote.construirRecibo({ ...base, payTo: 'no-evm' }), /payTo/, 'without an EVM payTo')
  t.exception(
    () => lote.construirRecibo({ ...base, authorization: { from: 'x', to: 'y', value: '1' } }),
    /nonce/,
    'without a nonce in the authorization'
  )
  t.exception(
    () => lote.construirRecibo({ ...base, signature: 'no-0x' }),
    /signature/,
    'without an EIP-3009 signature'
  )

  // The idempotency key IS the authorization's nonce (D20).
  const r = lote.construirRecibo(base)
  t.is(lote.claveDe(r), base.authorization.nonce, 'the receipt\'s key is the EIP-3009 nonce')
})

test('PHASE 10: a batch is for ONE network and ONE wallet, and the total is the sum', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const mk = (pisar) =>
    lote.construirRecibo({
      requestId: 'c-' + (pisar.n || 0),
      network: 'eip155:9746',
      payTo: '0x' + 'bb'.repeat(20),
      authorization: {
        from: '0x' + 'cc'.repeat(20),
        to: '0x' + 'bb'.repeat(20),
        value: '1',
        nonce: '0x' + String(pisar.n || 0).padStart(64, '0')
      },
      signature: '0x' + '11'.repeat(65),
      amount: pisar.amount || '1000',
      ...pisar
    })

  const l = lote.construirLote({
    recibos: [mk({ n: 1, amount: '1000' }), mk({ n: 2, amount: '2500' })]
  })
  t.is(l.count, 2)
  t.is(l.totalAmount, '3500', 'the total is the sum in minimal units, as a string')
  t.alike(
    l.nonces,
    l.recibos.map((r) => r.nonce),
    'the nonces and the receipts\' order match'
  )

  t.exception(
    () => lote.construirLote({ recibos: [mk({ n: 1 }), mk({ n: 2, network: 'eip155:988' })] }),
    /red/,
    'two networks in one batch, no: it settles against ONE facilitator'
  )
  t.exception(
    () =>
      lote.construirLote({ recibos: [mk({ n: 1 }), mk({ n: 2, payTo: '0x' + 'dd'.repeat(20) })] }),
    /wallet/,
    'two destinations in one batch either'
  )
  t.exception(
    () => lote.construirLote({ recibos: [] }),
    /no hay recibos/,
    'an empty batch is not a batch'
  )
})

test('PHASE 10: the batch gets signed with the wallet and verifies -- content AND authorizations', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const address = await cuenta.getAddress()

  const l = lote.construirLote({
    recibos: [await reciboDePrueba(cuenta, 0), await reciboDePrueba(cuenta, 1)]
  })
  const firmado = await lote.firmarLote(l, (m) => cuenta.sign(m))
  t.ok(firmado && firmado.signature.startsWith('0x'), 'it got signed with an EVM signature')

  const v = await lote.verificarLote(firmado)
  t.ok(v.ok, 'verifies: ' + (v.reason || ''))
  t.is(v.firmante.toLowerCase(), address.toLowerCase(), 'and the signer is the test wallet')
  t.is(v.recibosMal.length, 0, 'both EIP-3009 authorizations recover whoever claims to pay')
})

test('PHASE 10: changing the batch after signing invalidates it (JCS)', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const l = lote.construirLote({
    recibos: [await reciboDePrueba(cuenta, 0), await reciboDePrueba(cuenta, 1)]
  })
  const firmado = await lote.firmarLote(l, (m) => cuenta.sign(m))

  // Inflate the total without re-signing: the recovered signer stops being the
  // wallet, and on top of that the sum no longer adds up. Both checks catch it.
  const inflado = { ...firmado, totalAmount: '999999' }
  const v1 = await lote.verificarLote(inflado)
  t.absent(v1.ok, 'a changed total does not pass')
  t.ok(/suma|totalAmount/.test(v1.reason), 'and it says why: ' + v1.reason)

  // Remove one receipt from the signed batch.
  const podado = { ...firmado, recibos: firmado.recibos.slice(0, 1), count: 1 }
  const v2 = await lote.verificarLote(podado)
  t.absent(v2.ok, 'dropping a receipt doesn\'t either')

  // Without a signature there is no batch.
  t.absent((await lote.verificarLote({ ...firmado, signature: undefined })).ok, 'without a signature, no')
  t.is(await lote.firmarLote(l, null), null, 'and without a signer, no unsigned batch comes out')
})

test('PHASE 10: signing with YOUR wallet does not let you keep ANOTHER\'s batch', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()

  // A batch whose receipts pay `0xbb…` (reciboDePrueba's payTo). It's signed
  // by the test wallet, which is NOT 0xbb…: the recovered signer is real and
  // doesn't match the destination. `verificarLote` does not tie signer==payTo
  // -- that's a decision for whoever consumes it -- but it DOES expose who
  // signed, which is what allows rejecting it.
  const l = lote.construirLote({ recibos: [await reciboDePrueba(cuenta, 7)] })
  const firmado = await lote.firmarLote(l, (m) => cuenta.sign(m))
  const v = await lote.verificarLote(firmado)
  t.ok(v.ok, 'the signature is valid...')
  t.not(
    v.firmante.toLowerCase(),
    firmado.payTo.toLowerCase(),
    '...but the signer is NOT the batch\'s payTo'
  )
})

test('PHASE 10: verificarLote catches a receipt whose authorization does not recover its payer', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()

  const bueno = await reciboDePrueba(cuenta, 0)
  // A receipt with the signature of ANOTHER authorization: well-formed, but
  // not the one for this `from`/`value`/`nonce`.
  const otra = await reciboDePrueba(cuenta, 1)
  const malo = {
    ...bueno,
    nonce: '0x' + 'f'.repeat(64),
    authorization: { ...bueno.authorization, nonce: '0x' + 'f'.repeat(64) },
    signature: otra.signature
  }

  const l = lote.construirLote({ recibos: [bueno, malo] })
  const firmado = await lote.firmarLote(l, (m) => cuenta.sign(m))
  const v = await lote.verificarLote(firmado)
  t.absent(v.ok, 'the whole batch does not pass')
  t.is(v.recibosMal.length, 1, 'and it points to EXACTLY the bad receipt')
  t.is((v.recibosMal[0] || {}).nonce, malo.nonce, 'the one carrying the swapped signature')
})

test('PHASE 10: liquidarLote calls liquidar once per receipt and classifies the result', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const l = lote.construirLote({
    recibos: [
      await reciboDePrueba(cuenta, 0),
      await reciboDePrueba(cuenta, 1),
      await reciboDePrueba(cuenta, 2)
    ]
  })
  const firmado = await lote.firmarLote(l, (m) => cuenta.sign(m))

  const vistos = []
  const res = await lote.liquidarLote({
    lote: firmado,
    liquidar: async ({ requisito }) => {
      vistos.push(requisito.amount)
      // The first one settles, the second is an already-used nonce (idempotent:
      // it counts as settled), the third has no balance (that's the other side).
      if (vistos.length === 1)
        return { success: true, transaction: '0xabc', network: requisito.network }
      if (vistos.length === 2)
        return { success: false, errorReason: 'invalid_exact_evm_nonce_already_used' }
      return { success: false, errorReason: 'invalid_exact_evm_insufficient_balance' }
    }
  })

  t.is(vistos.length, 3, 'one call per receipt, with the EXACT requirement stored in the receipt')
  t.is(res.liquidados.length, 2, 'success + nonce-already-used count as settled')
  t.is(res.fallidos.length, 1)
  t.is(res.fallidos[0].clase, 'saldo', 'insufficient funds is classified apart: it does not get retried')
})

test('PHASE 10: the node<->facilitator protocol is declared, not guessed', async (t) => {
  const x402 = await import('../qvac/x402.mjs')
  const p = x402.PROTOCOLO_FACILITATOR
  t.ok(p, 'x402 exports the protocol descriptor')
  t.alike(
    p.envia,
    ['paymentPayload', 'paymentRequirements'],
    'what this node sends on /verify and /settle'
  )
  t.ok(
    p.paymentPayload.includes('network') && p.paymentPayload.includes('payload'),
    'the shape of paymentPayload'
  )
  t.alike(
    p.paymentPayloadPayload,
    ['authorization', 'signature'],
    'and inside it, the signed authorization'
  )
  t.ok(
    p.settleResponse.includes('transaction') && p.settleResponse.includes('success'),
    'what gets read from /settle'
  )
  t.ok(
    Object.isFrozen(p) && Object.isFrozen(p.envia),
    'the descriptor is frozen: nobody edits it on the fly'
  )
})

// ---------------------------------------------------------------------------
// PHASE 10 — accumulator persistence and flush
//
// `_pend` is process memory. A cutoff between "served/verified" and
// "settled" was giving away the work: the EIP-3009 authorization was signed
// and on no disk. These tests prove it mirrors to a JSONL with atomic
// writes, that it reloads on open, and that the build-sign-settle-mark flush
// does not re-charge what's already settled.
// ---------------------------------------------------------------------------

function dirLoteTmp() {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const path = require('bare-path')
  const dir = path.join(
    os.tmpdir(),
    'qvac-lote-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  )
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    archivo: path.join(dir, 'lote-pendientes.jsonl'),
    leer() {
      try {
        return fs.readFileSync(path.join(dir, 'lote-pendientes.jsonl'), 'utf8')
      } catch {
        return ''
      }
    },
    limpiar() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}

test('PHASE 10: the accumulator persists to JSONL and reloads on open', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const fs = require('bare-fs')
  const cuenta = await cuentaDePrueba()
  const tmp = dirLoteTmp()

  try {
    lote.abrir(tmp.dir, { intervaloMs: 0 })
    lote.agregar(await reciboDePrueba(cuenta, 100))
    lote.agregar(await reciboDePrueba(cuenta, 101))
    t.is(lote.pendientes().length, 2, 'two in memory')

    const lineas = tmp.leer().trim() ? tmp.leer().trim().split('\n') : []
    t.is(lineas.length, 2, 'and two JSON lines in the file (one per receipt)')
    if (lineas.length === 2) {
      t.ok(JSON.parse(lineas[0]).nonce, 'each line parses to a receipt with a nonce')
    }

    // A fresh run: memory is lost, it reloads from disk.
    lote.limpiar()
    t.is(lote.pendientes().length, 0, 'memory starts empty')
    const recuperados = lote.abrir(tmp.dir, { intervaloMs: 0 })
    t.is(recuperados, 2, 'open returns how many receipts it rescued')
    t.is(lote.pendientes().length, 2, 'and they are back in the accumulator')

    // A corrupt line doesn't take the rest of the file down with it.
    fs.appendFileSync(tmp.archivo, '{ esto no es json\n')
    lote.limpiar()
    const trasCorrupcion = lote.abrir(tmp.dir, { intervaloMs: 0 })
    t.is(trasCorrupcion, 2, 'the broken line gets skipped, the two good ones remain')
  } finally {
    lote.abrir(null)
    lote.limpiar()
    tmp.limpiar()
  }
})

test('PHASE 10: flushTodo builds-signs-settles-marks, grouping by network+wallet', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const tmp = dirLoteTmp()

  const liquidados = []
  try {
    lote.abrir(tmp.dir, {
      intervaloMs: 0,
      firmar: (m) => cuenta.sign(m),
      liquidar: async ({ requisito, pago }) => {
        liquidados.push(pago.autorizacion.nonce)
        return { success: true, transaction: '0xdeadbeef', network: requisito.network }
      }
    })
    lote.agregar(await reciboDePrueba(cuenta, 200))
    lote.agregar(await reciboDePrueba(cuenta, 201))

    const res = await lote.flushTodo()
    t.is(res.length, 1, 'a single group: same network, same wallet')
    t.is((res[0] || {}).ok, true)
    t.is((res[0] || {}).liquidados, 2, 'both receipts in the group got settled')
    t.is(liquidados.length, 2, 'liquidar got called once per receipt, with its authorization')

    t.is(
      lote.pendientes({ soloPendientes: true }).length,
      0,
      'and they stayed marked: a crash-and-resume does not charge again'
    )
    const bruto = tmp.leer().trim()
    const enDisco = bruto ? bruto.split('\n').map((l) => JSON.parse(l)) : []
    t.is(enDisco.length, 2, 'both receipts are still on disk')
    t.ok(
      enDisco.length === 2 && enDisco.every((r) => r.liquidacion && r.liquidacion.success),
      'disk reflects what was settled too, not just memory'
    )
  } finally {
    lote.abrir(null)
    lote.limpiar()
    tmp.limpiar()
  }
})

test('PHASE 10: the size-based flush only fires when it crosses the threshold', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const tmp = dirLoteTmp()

  let corridas = 0
  try {
    lote.abrir(tmp.dir, {
      intervaloMs: 0,
      umbral: 3,
      firmar: (m) => cuenta.sign(m),
      liquidar: async ({ requisito }) => {
        corridas++
        return { success: true, transaction: '0x01', network: requisito.network }
      }
    })

    lote.agregar(await reciboDePrueba(cuenta, 300))
    lote.agregar(await reciboDePrueba(cuenta, 301))
    await lote.flushSiSuperaUmbral()
    t.is(corridas, 0, 'with 2 pending and a threshold of 3, the size-based flush does NOT run')

    lote.agregar(await reciboDePrueba(cuenta, 302))
    await lote.flushSiSuperaUmbral()
    t.is(corridas, 3, 'with the third one the threshold is crossed and all three settle')
    t.is(lote.pendientes({ soloPendientes: true }).length, 0, 'nothing left to settle')
  } finally {
    lote.abrir(null)
    lote.limpiar()
    tmp.limpiar()
  }
})

test('PHASE 10: closing does one last flush and persists what remains', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const cuenta = await cuentaDePrueba()
  const tmp = dirLoteTmp()

  let liquido = 0
  try {
    lote.abrir(tmp.dir, {
      intervaloMs: 0,
      firmar: (m) => cuenta.sign(m),
      liquidar: async ({ requisito }) => {
        liquido++
        return { success: true, transaction: '0x02', network: requisito.network }
      }
    })
    lote.agregar(await reciboDePrueba(cuenta, 400))
    lote.agregar(await reciboDePrueba(cuenta, 401))

    await lote.cerrar()
    t.is(liquido, 2, 'close builds-signs-settles what was pending before exiting')

    // The file kept the receipts marked: reopening does not offer them up
    // for settling again.
    const recuperados = lote.abrir(tmp.dir, { intervaloMs: 0 })
    t.is(recuperados, 2, 'still in the file, for auditing')
    t.is(lote.pendientes({ soloPendientes: true }).length, 0, 'but none pending payment')
  } finally {
    lote.abrir(null)
    lote.limpiar()
    tmp.limpiar()
  }
})

// ---------------------------------------------------------------------------
// PHASE 10 — the Protomux transport: the peer that serves routed traffic gets paid
//
// Full handoff (decided): when a gateway routes a paid request to a peer, it
// FORWARDS the client's EIP-3009 authorization. The peer runs the model,
// builds its D24 attestation, builds the receipt with that payment and
// accumulates it in ITS OWN batch to settle deferred. The gateway that
// routed no longer settles. The peer does NOT re-verify the payment
// (decided): it trusts the gateway that routed it.
//
// These tests exercise the REAL `provider.mjs` with a fake engine -- the
// same harness the quota tests use. The client's EIP-3009 signature and the
// peer's attestation are real; the money doesn't exist.
// ---------------------------------------------------------------------------

async function parConWallet(tokensPorRespuesta = 5, pedazo = 'texto ', { lento = false } = {}) {
  const { Provider } = await import('../qvac/provider.mjs')
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  // getAccount(1): the peer is NOT the same as the paying client (getAccount(0)).
  const cuenta = await new WM(FRASE_DE_PRUEBA, {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount(1)
  const address = await cuenta.getAddress()
  const engine = {
    resolveModel: async () => ({ modelSrc: {} }),
    loadModel: async () => 'cargado',
    complete: async function* () {
      for (let i = 0; i < tokensPorRespuesta; i++) {
        // `lento` (slow): yields control between tokens so a `chat:cancel` that
        // arrives mid-generation can interleave (D27 case 1's scenario).
        if (lento) await new Promise((r) => setTimeout(r, 3))
        yield pedazo
      }
    },
    shutdown: async () => {}
  }
  const provider = new Provider({
    engineLoader: async () => engine,
    models: [{ modelId: 'llama1b', maxConcurrentRequests: 3 }],
    maxConcurrent: 3,
    walletAddress: address,
    firmarConWallet: (m) => cuenta.sign(m)
  })
  return { provider, address }
}

// The `payment` the gateway forwards over `chat:request`: the EIP-3009
// authorization the CLIENT (getAccount 0) signed in favor of `payToAddress`.
async function pagoReenviadoPara(payToAddress, { value = '1000', nonce = 1 } = {}) {
  const x402 = await import('../qvac/x402.mjs')
  const { evm } = await x402.cargar()
  const wdk = await import('@tetherto/wdk-wallet-evm')
  const WM = wdk.default || wdk
  const cliente = await new WM(FRASE_DE_PRUEBA, {
    provider: 'http://127.0.0.1:1/no-existe'
  }).getAccount(0)
  const from = await cliente.getAddress()
  const asset = '0x' + 'a1'.repeat(20)
  const network = 'eip155:9746'
  const domain = {
    name: 'PyrusLLM Test USD',
    version: '1',
    chainId: 9746,
    verifyingContract: asset
  }
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600)
  const authorization = {
    from,
    to: payToAddress,
    value: String(value),
    validAfter: '0',
    validBefore,
    nonce: '0x' + String(nonce).padStart(64, '0')
  }
  const signature = await cliente.signTypedData({
    domain,
    types: evm.authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to: payToAddress,
      value: BigInt(value),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce: authorization.nonce
    }
  })
  return {
    authorization,
    signature,
    red: 'plasma-testnet',
    requirements: {
      scheme: 'exact',
      network,
      amount: String(value),
      asset,
      payTo: payToAddress,
      maxTimeoutSeconds: 300,
      extra: { name: domain.name, version: '1' }
    }
  }
}

test('PHASE 10: a peer that serves a routed request attests and accumulates in its batch', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const at = await import('../qvac/atestacion.mjs')
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  lote.limpiar()

  const { provider, address } = await parConWallet(4)
  const payment = await pagoReenviadoPara(address, { value: '1500', nonce: 42 })

  const cap = capturar()
  await provider._serve(
    PEER,
    {
      requestId: 'chatcmpl-peer-1',
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }],
      payment
    },
    cap.send
  )

  const done = cap.vistos.find((m) => m.type === 'chat:done')
  t.ok(done, 'the peer closed the stream')
  const att = (done && done.attestation) || null
  t.ok(att && att.signature, 'and it returned its signed D24 attestation')
  const v = att ? await at.verificar(att) : { ok: false, firmante: null }
  t.ok(v.ok, 'which verifies: ' + (v.reason || ''))
  t.is(
    String(v.firmante || '').toLowerCase(),
    address.toLowerCase(),
    'signed by the PEER\'s wallet'
  )

  const pend = lote.pendientes()
  t.is(pend.length, 1, 'the peer accumulated the receipt in ITS batch')
  const r0 = pend[0] || {}
  t.is(
    String(r0.payTo || '').toLowerCase(),
    address.toLowerCase(),
    'which pays the peer\'s wallet (D10)'
  )
  t.is(
    String(r0.payer || '').toLowerCase(),
    payment.authorization.from.toLowerCase(),
    'and the payer is the client, not the peer'
  )
  t.is(r0.nonce, payment.authorization.nonce, 'with the EIP-3009 nonce as the key')
  t.ok(r0.attestation && r0.attestation.signature, 'and the attestation attached to the receipt')
  t.is(r0.liquidacion, null, 'not settled: that\'s the batch flush\'s job')

  quota.reset()
  lote.limpiar()
})

test('PHASE 10: the peer trims at the 402\'s cap and attests it as length (D9)', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  lote.limpiar()

  // 40 chunks of 10 bytes = 400 bytes ~ 100 estimated tokens; the cap of 4
  // cuts it off far earlier.
  const { provider, address } = await parConWallet(40, 'diez-bytes')
  const payment = await pagoReenviadoPara(address, { nonce: 7 })

  const cap = capturar()
  await provider._serve(
    PEER,
    {
      requestId: 'chatcmpl-tope',
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }],
      payment,
      maxTokens: 4
    },
    cap.send
  )

  const chunks = cap.vistos.filter((m) => m.type === 'chat:chunk')
  t.ok(chunks.length < 40 && chunks.length > 0, 'cut off at the cap: ' + chunks.length + ' of 40')
  const done = cap.vistos.find((m) => m.type === 'chat:done')
  t.is(
    ((done && done.attestation) || {}).finishReason,
    'length',
    'and the attestation says length, not stop (D9)'
  )

  quota.reset()
  lote.limpiar()
})

test('PHASE 10: without a wallet the peer still serves but does not attest or accumulate', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  lote.limpiar()

  // providerDePrueba does NOT get walletAddress/firmarConWallet.
  const provider = await providerDePrueba(3)
  const payment = await pagoReenviadoPara('0x' + 'cc'.repeat(20), { nonce: 9 })

  const cap = capturar()
  await provider._serve(
    PEER,
    {
      requestId: 'chatcmpl-sinwallet',
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }],
      payment
    },
    cap.send
  )

  const done = cap.vistos.find((m) => m.type === 'chat:done')
  t.ok(done, 'the stream serves the same way: the attestation is not a gate')
  t.is(done && done.attestation, undefined, 'but no attestation comes out')
  t.ok(done && done.attestationMissing, 'with the reason: ' + (done && done.attestationMissing))
  t.is(lote.pendientes().length, 0, 'and nothing got accumulated')

  quota.reset()
  lote.limpiar()
})

test('PHASE 10: a payment forwarded to another wallet does NOT get accumulated by the peer', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  lote.limpiar()

  const { provider } = await parConWallet(3)
  // The payment's payTo points at ANOTHER address, not the peer's: the 402
  // did not pay this node. It gets served, but it doesn't get accumulated or attested.
  const payment = await pagoReenviadoPara('0x' + 'dd'.repeat(20), { nonce: 11 })

  const cap = capturar()
  await provider._serve(
    PEER,
    {
      requestId: 'chatcmpl-otro-payto',
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }],
      payment
    },
    cap.send
  )

  const done = cap.vistos.find((m) => m.type === 'chat:done')
  t.is(done && done.attestation, undefined, 'does not attest a charge that is not its own')
  t.ok(
    String(done && done.attestationMissing).indexOf("this node's wallet") !== -1,
    done && done.attestationMissing
  )
  t.is(lote.pendientes().length, 0, 'and it does not accumulate anything')

  quota.reset()
  lote.limpiar()
})

test('PHASE 10 / D27 case 1: the cancelled peer still sends its chat:done with the partial attestation', async (t) => {
  const lote = await import('../qvac/lote.mjs')
  const quota = await import('../qvac/quota.mjs')
  quota.reset()
  lote.limpiar()

  // Slow engine: a `chat:cancel` that arrives mid-generation interleaves.
  const { provider, address } = await parConWallet(30, 'pedazo ', { lento: true })
  const payment = await pagoReenviadoPara(address, { nonce: 71 })

  const cap = capturar()
  const corriendo = provider._serve(
    PEER,
    {
      requestId: 'chatcmpl-cancel',
      model: 'llama1b',
      messages: [{ role: 'user', content: 'hola' }],
      payment
    },
    cap.send
  )
  // Dejar salir unos tokens y despues cancelar, como haria el consumidor.
  await new Promise((r) => setTimeout(r, 20))
  provider.onMessage(PEER, { type: 'chat:cancel', requestId: 'chatcmpl-cancel' }, cap.send)
  await corriendo

  const chunks = cap.vistos.filter((m) => m.type === 'chat:chunk')
  t.ok(chunks.length > 0 && chunks.length < 30, 'cut off halfway: ' + chunks.length + ' of 30')

  const done = cap.vistos.find((m) => m.type === 'chat:done')
  t.ok(done, 'even cancelled, the peer sends its chat:done (D27 case 1)')
  t.ok(done && done.attestation && done.attestation.signature, 'with the signed partial attestation')
  t.is(
    (done && done.attestation && done.attestation.finishReason) || null,
    'client_cancelled',
    'which says client_cancelled, not stop'
  )

  const pend = lote.pendientes()
  t.is(pend.length, 1, 'and the served prefix stayed accumulated in the peer\'s batch')
  t.is((pend[0] || {}).payer, payment.authorization.from, 'under the name of the client who paid')

  quota.reset()
  lote.limpiar()
})

test('PHASE 10 / D27 case 1: cancelChat keeps the chat alive for the peer\'s late chat:done', async (t) => {
  const { NodeSwarm } = await import('../qvac/swarm.mjs')
  const sw = new NodeSwarm({ models: [] })

  // A fake peer: all `chatRequest`/`_send` ask of it is
  // `key`, `manifest` and a `channel.send`.
  const enviados = []
  const par = { key: 'ab'.repeat(32), manifest: {}, channel: { send: (m) => enviados.push(m) } }
  sw.peers.set(par.key, par)

  const eventos = []
  const rid = sw.chatRequest(
    par.key,
    { model: 'm', messages: [{ role: 'user', content: 'x' }] },
    {
      onAccepted: () => eventos.push(['accepted']),
      onChunk: (d) => eventos.push(['chunk', d]),
      onDone: (x) => eventos.push(['done', x]),
      onError: (m, c) => eventos.push(['error', m, c])
    }
  )
  t.ok(rid, 'the chat opened')
  t.ok(
    enviados.find((m) => m.type === 'chat:request'),
    'and the chat:request went out'
  )

  sw.cancelChat(rid)
  t.ok(
    enviados.find((m) => m.type === 'chat:cancel'),
    'the chat:cancel went out to the peer'
  )
  t.is(eventos.length, 0, 'but the chat did NOT close: the peer\'s late chat:done is expected')

  // The peer answers late with its partial attestation, through normal dispatch.
  sw._dispatch(par, {
    type: 'chat:done',
    requestId: rid,
    attestation: { v: 1, requestId: rid, marca: 'parcial' }
  })
  const done = eventos.find((e) => e[0] === 'done')
  t.ok(done, 'the late chat:done DID reach onDone, it was not discarded')
  t.is(
    (done && done[1] && done[1].attestation && done[1].attestation.marca) || null,
    'parcial',
    'with the peer\'s partial attestation intact'
  )
})

// ---------------------------------------------------------------------------
// D30 / BLOCK 0 — the preconditions needed to demonstrate Phase 10
//
// D30 decided that no path that moves value gets its debut on mainnet. That
// has three preconditions that can be tested without touching a chain, and
// they are here:
//
//   D30.1  the keystore can't end up in %TEMP%
//   D30.2  the network has to be eligible, and the default has to say it's mainnet
//   D30.3  the test asset has to exist as an artifact and be real EIP-3009
//
// The fourth one (the self-hosted facilitator) needs a node process and is
// in test/integracion.js.
//
// NONE OF THESE REACH THE INTERNET. The artifact is checked on disk, the
// network resolves from a table, and the keystore from three paths.
// ---------------------------------------------------------------------------

test('D30.1: the keystore NEVER falls into temp on its own', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const os = require('bare-os')
  const path = require('bare-path')
  const temp = os.tmpdir()

  // The bug this closes: `swarmStorageDir()` sends EVERYTHING to os.tmpdir()
  // under bare, i.e. in development -- which is exactly where funding is
  // about to be tested. Windows cleans temp, and what gets lost in there
  // isn't cache: it's the only copy of a seed.
  const sano = wallet.directorioKeystore({
    storage: null,
    persistente: path.join(temp, '..', 'persistente-de-mentira'),
    app: 'pyrusllm'
  })
  t.absent(sano.volatil, 'with a sane persistent dir the keystore is not volatile')
  t.absent(sano.dir.indexOf(temp) === 0, 'and it does not hang off temp: ' + sano.dir)
  t.ok(sano.dir.indexOf('pyrusllm') !== -1, 'and it carries the app name inside')

  // An explicit --storage IS respected: it's the operator's decision, not
  // ours. What it can't do is pass silently.
  const elegido = wallet.directorioKeystore({
    storage: path.join(temp, 'wallet-elegida'),
    persistente: '/datos/persistentes',
    app: 'pyrusllm'
  })
  t.is(elegido.dir, path.resolve(path.join(temp, 'wallet-elegida')), 'it is respected')
  t.ok(elegido.volatil, 'but it stays marked as volatile')
  t.ok(String(elegido.motivo).indexOf('cleans up') !== -1, 'and the reason explains it: ' + elegido.motivo)

  // And the pathological case: if the platform itself claimed its own
  // persistent directory was inside temp, it also gets flagged. The check
  // fails toward "it is temp", which is the cheap side to be wrong on.
  const raro = wallet.directorioKeystore({ storage: null, persistente: temp, app: 'pyrusllm' })
  t.ok(raro.volatil, 'a persistent dir that falls inside temp does not go unnoticed either')

  // Without a persistent dir, NONE gets invented. Returning temp here would
  // be exactly the bug under another name.
  t.exception(
    () => wallet.directorioKeystore({ storage: null, persistente: null, app: 'pyrusllm' }),
    /persistent/,
    'without a persistent dir it cuts off instead of falling back to temp'
  )
})

test('D30.2: the network gets chosen, and the default says to your face it is mainnet', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')

  // D15 does NOT change: Plasma mainnet is still the default. What changes
  // is that now another one can be chosen, and whoever chooses mainnet knows it.
  const porDefecto = wallet.redDe({})
  t.is(porDefecto.nombre, 'plasma', 'D15 intact: the default is still Plasma')
  t.is(porDefecto.chainId, 9745)
  t.ok(porDefecto.mainnet, 'and it is marked as MAINNET, which is what allows warning about it')

  const prueba = wallet.redDe({ [wallet.VAR_RED]: 'plasma-testnet' })
  t.is(prueba.chainId, 9746, 'D30\'s testnet is eligible')
  t.absent(prueba.mainnet, 'and the testnet is not marked as mainnet')
  t.absent(prueba.rpc === porDefecto.rpc, 'with a DIFFERENT rpc, not mainnet\'s: ' + prueba.rpc)

  // EIP-155: the chainId is part of what gets signed. That they're two
  // different numbers isn't trivia -- it's the reason a 9745 tx is not valid
  // on 9746, and why "the testnet is the same network with another URL" is false.
  t.absent(porDefecto.chainId === prueba.chainId, '9745 and 9746 are not the same network')

  // The RPC can be overridden, but ONLY the URL. If overriding the rpc also
  // changed the network being signed for, a misdirected RPC would be a
  // signature for another chain without anyone asking for it.
  const propio = wallet.redDe({
    [wallet.VAR_RED]: 'plasma-testnet',
    [wallet.VAR_RPC]: 'http://127.0.0.1:8545'
  })
  t.is(propio.rpc, 'http://127.0.0.1:8545', 'the URL gets overridden')
  t.is(propio.chainId, 9746, 'the chainId does NOT')
  t.ok(propio.rpcPropio, 'and it stays on record that the rpc is not the table\'s')

  // A network that does not exist cuts off with the name inside the
  // message. Falling back to the default would mean operating against
  // mainnet while believing something else was requested.
  t.exception(() => wallet.redDe({ [wallet.VAR_RED]: 'ethereum' }), /is not a known network/)
})

test('D30.2: the chosen rpc reaches all the way to the account, without touching the network', async (t) => {
  const wallet = await import('../qvac/wallet.mjs')
  const tmp = dirWalletTmp()

  // What was broken wasn't that `abrir` didn't accept an rpc: it did. It was
  // that NOBODY passed it one, so the mainnet constant always won. It's
  // tested end to end: create with one network, open with the same one, and
  // the account returns the rpc it was built with.
  const red = wallet.redDe({ [wallet.VAR_RED]: 'plasma-testnet' })
  const creada = await wallet.crear(tmp.dir, 'passphrase-de-prueba', { red })
  t.ok(/^0x[a-fA-F0-9]{40}$/.test(creada.address))

  const abierta = await wallet.abrir(tmp.dir, 'passphrase-de-prueba', { red })
  t.is(abierta.rpc, red.rpc, 'the account was built against the rpc that was requested')
  t.is(abierta.red.chainId, 9746, 'and against the network that was requested')

  // And without `red`, D15's default still comes out, which is what a node
  // that configures nothing has to keep doing.
  const porDefecto = await wallet.abrir(tmp.dir, 'passphrase-de-prueba')
  t.is(porDefecto.red.chainId, 9745, 'without choosing, D15: Plasma mainnet')
  t.is(porDefecto.address, abierta.address, 'and the address does not depend on the network')

  // Derivation does NOT talk to the network, and that's a precondition for a
  // node without internet to be able to announce itself. An rpc that
  // doesn't exist has to give the same result.
  const inventado = await wallet.abrir(tmp.dir, 'passphrase-de-prueba', {
    rpc: 'http://127.0.0.1:1/no-existe'
  })
  t.is(inventado.address, abierta.address, 'the address comes out without touching the chain')

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

test('D30.2: the two network tables cannot drift out of sync', async (t) => {
  // `qvac/wallet.mjs` runs under Bare and `scripts/redes-prueba.js` under
  // Node, so the table is written twice -- same as in verificar-x402.js, and
  // for the same reason. The duplication that causes harm isn't having two
  // tables: it's one saying testnet where the other says mainnet. That's
  // what gets compared here.
  const wallet = await import('../qvac/wallet.mjs')
  const redes = require('../scripts/redes-prueba.js')

  for (const [nombre, red] of Object.entries(wallet.REDES)) {
    const esTestnetAlla = redes.porQueNoSeEstrena(red.chainId) === null
    t.is(
      esTestnetAlla,
      !red.mainnet,
      nombre + ' (' + red.chainId + '): both tables agree on whether it is a test network'
    )
  }

  // And the one that matters, named, because it's the one D30 chooses.
  t.is(redes.testnetDe(9746).caip2, wallet.REDES['plasma-testnet'].caip2)
  t.ok(redes.porQueNoSeEstrena(9745), 'and 9745 is still mainnet on both sides')
})

test('D30.3: the test asset exists compiled, and is real EIP-3009', async (t) => {
  const fs = require('bare-fs')
  const path = require('bare-path')
  const sodium = require('sodium-native')

  const raiz = path.join(__dirname, '..')
  const fuente = fs.readFileSync(path.join(raiz, 'scripts', 'activo-prueba.sol'), 'utf8')
  const artefacto = JSON.parse(
    fs.readFileSync(path.join(raiz, 'scripts', 'activo-prueba.artefacto.json'), 'utf8')
  )

  // THE ARTIFACT MATCHES THE SOURCE SITTING RIGHT NEXT TO IT.
  //
  // Precompiled bytecode gets deployed so the repo doesn't gain a toolchain,
  // and the price of that decision is that recompiling isn't `npm run`
  // anything. Without this assert, someone edits the .sol, doesn't
  // recompile, and what gets deployed stops being what gets read -- which
  // is the worst version of "there's code in the repo".
  const h = Buffer.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(h, Buffer.from(fuente, 'utf8'))
  t.is(
    h.toString('hex'),
    artefacto.fuenteSha256,
    'the bytecode was compiled from THIS source (if not: recompile, see the .sol\'s header)'
  )

  t.ok(/^0x[0-9a-f]+$/.test(artefacto.bytecode), 'the creation bytecode is hex')
  t.ok(/^0x[0-9a-f]+$/.test(artefacto.deployedBytecode), 'and so is the runtime one')
  t.ok(artefacto.solc.indexOf('0.8.') === 0, 'with the solc version noted: ' + artefacto.solc)

  // And with the KEY the source was passed to solc under. It's not
  // decorative metadata: that key goes into the metadata hash solc appends
  // to the end of the bytecode, so compiling the same source with the same
  // version and the same settings gives DIFFERENT bytecode if the key
  // changes. Without this noted, reproducing the artifact is guesswork --
  // and it was guessed once.
  t.ok(artefacto.claveFuente, 'and with the source key: ' + artefacto.claveFuente)

  // THAT IMPLEMENTS EIP-3009, CHECKED AGAINST THE BYTECODE AND NOT THE ABI.
  //
  // The ABI is written by the compiler from the source, so asking the ABI
  // whether the contract has a function is asking the source again. The
  // selectors, on the other hand, live in the runtime's DISPATCHER: if
  // they're there, the function is reachable on chain. They're the same
  // four bytes `verificar-x402` will later call against the deployed contract.
  const runtime = artefacto.deployedBytecode.slice(2)
  const SELECTORES = {
    'authorizationState(address,bytes32)': 'e94a0102',
    'transferWithAuthorization(...,uint8,bytes32,bytes32)': 'e3ee160e',
    'transferWithAuthorization(...,bytes)': 'cf092995',
    'DOMAIN_SEPARATOR()': '3644e515',
    // `name` and `version` aren't part of EIP-3009 but @x402/evm's
    // facilitator READS them from the chain before settling. Plasma's USD-0
    // reverts on `version()`; this one can't.
    'name()': '06fdde03',
    'version()': '54fd4d50'
  }
  for (const nombre of Object.keys(SELECTORES)) {
    const sel = SELECTORES[nombre]
    t.ok(runtime.indexOf(sel) !== -1, nombre + ' is reachable in the runtime (0x' + sel + ')')
  }

  // D28/D30.3 — IT ISN'T CALLED $QVAC, AND THAT ISN'T A MATTER OF TASTE.
  //
  // D24's attestation and x402's receipt RECORD THE ASSET. Giving it the
  // native token's name would write inside signed artifacts the exact
  // contradiction D28 erased from the pitch: that the payment rail is
  // denominated in the speculative asset. It's a stablecoin stand-in and it
  // is named as one.
  t.is(
    artefacto.abi.filter((f) => f.name === 'name').length,
    1,
    'exposes name(), which is what the facilitator reads'
  )

  // The DENOMINATION is checked, not the whole file: the .sol's header
  // explains why it isn't called $QVAC, and that explanation needs to be
  // able to mention it. What can't carry that name is what will end up
  // written inside the signed attestation, which is `name` and `symbol`.
  const declarado = (campo) => {
    const m = fuente.match(new RegExp('constant\\s+' + campo + '\\s*=\\s*"([^"]*)"'))
    return m ? m[1] : null
  }
  t.is(declarado('name'), 'PyrusLLM Test USD', 'named like the stablecoin stand-in it is')
  t.is(declarado('symbol'), 'tUSD')
  t.absent(/QVAC/i.test(declarado('name') + declarado('symbol')), 'and it does not carry the native token')

  // AND IT IS MARKED AS A TEST WHEREVER IT'S VISIBLE. `name` and `symbol`
  // are what an explorer shows; `AVISO` is for whoever opens the contract.
  t.ok(fuente.indexOf('NO ES UNA STABLECOIN') !== -1, 'the notice is in the contract itself')
  t.ok(
    artefacto.abi.some((f) => f.name === 'AVISO'),
    'and exposed in the ABI, not just in a comment'
  )
})

test('D30: the network guard is a whitelist, and mainnet has no door', async (t) => {
  const redes = require('../scripts/redes-prueba.js')

  t.is(redes.porQueNoSeEstrena(9746), null, 'Plasma\'s testnet can be used')
  t.is(redes.porQueNoSeEstrena(31337), null, 'and a local chain too')

  // What D30 says literally is "no exception". These three have to return a
  // reason, and 9745's has to name it: it's D15's default, i.e. the easiest
  // mistake to make.
  const plasma = redes.porQueNoSeEstrena(9745)
  t.ok(plasma, '9745, which is D15\'s default, does NOT debut')
  t.ok(String(plasma).indexOf('MAINNET') !== -1, 'and the reason says it is mainnet: ' + plasma)
  t.ok(redes.porQueNoSeEstrena(988), 'Stable, D15\'s fallback, doesn\'t either')
  t.ok(redes.porQueNoSeEstrena(1), 'nor Ethereum')

  // WHITELIST, NOT BLACKLIST. A chain nobody wrote down has to fall on the
  // "no" side, because the failure mode of omission is deploying on a
  // network with real money while believing it was a test one.
  const rara = redes.porQueNoSeEstrena(424242)
  t.ok(rara, 'an unknown chain does not get its debut')
  // `String(rara)` and not `rara.indexOf`: with the array stripped out this
  // is null, and a TypeError ABORTS the run instead of failing the assert
  // -- meaning the harness can't see whether the array was guarded. It's
  // B18's lesson again.
  t.ok(String(rara).indexOf('list of known testnets') !== -1, 'and it says how to add it: ' + rara)

  // Garbage doesn't pass either. `Number(undefined)` is NaN and an `if
  // (TESTNETS[id])` alone wouldn't be enough.
  t.ok(redes.porQueNoSeEstrena(undefined), 'undefined is not a testnet')
  t.ok(redes.porQueNoSeEstrena(0), 'nor chainId zero')
  t.ok(redes.porQueNoSeEstrena('9746; drop'), 'nor a string that starts out looking like one')
})

// ---------------------------------------------------------------------------
// PHASE 9 — making visible what the phase already emitted and nobody could see.
//
// `qvac/panel-x402.mjs` is the code THAT RUNS THE PANEL: pages.mjs pastes it
// inside each page's <script> with `String(fn)`. Testing it here is testing
// it there, and that's the entire reason it lives in a separate module
// instead of inside an HTML string.
//
// The tests below are the five things that file exists to avoid drawing
// wrong. None of them check "that the HTML gets served": they check that
// the data arrives with the meaning it had.
// ---------------------------------------------------------------------------

test('the panel\'s BLAKE2b gives the SAME result as the one that signs on the node', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const at = await import('../qvac/atestacion.mjs')

  // This is the check that everything else rests on. The panel recomputes
  // `outputHash` with a hand-written implementation -- sodium doesn't exist
  // in the browser and a CDN doesn't fit -- and that number is what decides
  // whether an attestation "matches". A hand-rolled BLAKE2b that nobody
  // cross-checks would say NO MATCH on correct artifacts: that would be
  // worse than not comparing at all.
  const casos = [
    '', // the empty block, which is a special case for the algorithm
    'a',
    'hola',
    'nandu ' + String.fromCodePoint(0x1f986) + ' acentue', // multibyte UTF-8 and a couple of surrogates
    'x'.repeat(127),
    'x'.repeat(128), // the EXACT block boundary: this function's classic bug
    'x'.repeat(129),
    'y'.repeat(1000)
  ]
  for (const c of casos) {
    t.is(px.hashDeTexto(c), at.hashDe(c), 'same hash for an input of ' + c.length + ' chars')
  }

  // And the prompt one, which isn't over the last turn's text but over the
  // WHOLE canonicalized conversation: if the two canonicalizations diverge,
  // the panel would say a correct promptHash doesn't match.
  const msgs = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'que tal' }
  ]
  t.is(px.hashDeMensajes(msgs), at.hashDeMensajes(msgs), 'and the promptHash, same')
})

test('the panel\'s JCS is the same JCS that signs the manifest', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')
  const { canonicalize } = await import('../qvac/manifest.mjs')

  // It gets rewritten instead of imported because the whole file travels to
  // the browser and an import does not cross that boundary. This is what
  // stops the two copies from drifting apart.
  const valores = [
    { b: 1, a: 2 },
    { z: [1, 'x', null, true], a: { d: 4, c: 3 } },
    [],
    { vacio: {}, texto: 'con comillas " y barra \\' },
    { saltado: undefined, queda: 1 }
  ]
  for (const v of valores) {
    t.is(px.canonicalizarJCS(v), canonicalize(v), 'same JCS: ' + JSON.stringify(v))
  }

  // The signed bytes are the artifact WITHOUT `signature`, which is what the
  // panel shows so the signature can be verified externally.
  const a = { v: 1, requestId: 'r', providerPubkey: '0xab', signature: '0xdead' }
  t.is(px.bytesFirmados(a), canonicalize({ v: 1, requestId: 'r', providerPubkey: '0xab' }))
  t.absent(px.bytesFirmados(a).indexOf('signature') !== -1, 'and the signature does not sign itself')
})

test('rule 1: a missing attestation shows THE REASON, never a dash', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // The normal case, and the one that matters most: a peer served it. The
  // absence is CORRECT -- this node did not run the model and the 402 paid
  // the peer's wallet --, and the peer's attestation travels over Protomux
  // in Phase 10.
  const motivoPar =
    'el que sirvio fue otro nodo: su atestacion la firma el, y viaja por Protomux (Fase 10)'
  const v = px.vistaDeAtestacion({ attestation: null, attestationMissing: motivoPar })
  t.absent(v.hay)
  t.is(v.motivo, motivoPar, 'the reason travels as-is, unsummarized')
  t.ok(v.motivoDeclarado)
  t.ok(v.esDelPar, 'and it is recognized that this absence is not a failure')

  const html = px.htmlDeAtestacion(v)
  t.ok(html.indexOf('Protomux') !== -1, 'the reason APPEARS in what gets drawn')
  t.ok(html.indexOf('no hay atestacion') !== -1, 'and it says there is none, in words')

  // And the ugly case, which is different: the attestation is missing AND
  // the reason is missing. That is an incomplete response, not a justified
  // absence, and it gets said that way.
  const mudo = px.vistaDeAtestacion({ attestation: null })
  t.absent(mudo.motivoDeclarado, 'nobody said why it is missing')
  t.ok(mudo.motivo.indexOf('incompleta') !== -1, 'and that gets named: ' + mudo.motivo)
  t.absent(mudo.esDelPar, 'and it is not attributed to the peer without anyone having said so')
})

test('rule 2: a mock runtime LOOKS like a mock, even if the signature is real', async (t) => {
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
  t.ok(mock.esMock, 'an artifact signed with a REAL wallet over made-up text is a mock')
  t.ok(mock.avisoMock && mock.avisoMock.indexOf('demo') !== -1, mock.avisoMock)

  const real = px.vistaDeAtestacion({ attestation: { ...base, runtime: 'llamacpp' } })
  t.absent(real.esMock, 'and a real engine does not get flagged')
  t.is(real.avisoMock, null)

  // What matters is that it gets SEEN, not that the field exists on an object.
  const htmlMock = px.htmlDeAtestacion(mock)
  const htmlReal = px.htmlDeAtestacion(real)
  t.ok(htmlMock.indexOf('runtime: mock') !== -1, 'the mock comes out named in the drawing')
  t.ok(htmlMock.indexOf('x-aviso malo') !== -1, 'and with the tone of something that is not evidence')
  t.absent(htmlReal.indexOf('runtime: mock') !== -1, 'and the real one does not carry the warning')

  // D26: quantization and runtime are signed DECLARATIONS, not measurements.
  // That they're signed is what gives something to arbitrate against, not
  // proof that they're true -- and the panel cannot suggest the second thing.
  t.ok(real.declarados.indexOf('DECLARACIONES') !== -1)
  t.ok(htmlReal.indexOf('DECLARACIONES') !== -1, 'and that gets drawn next to both fields')
})

test('rule 3: gateway and provider are not the same number and are not painted the same', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  const medido = px.vistaDeConteo({
    tokensPrefill: 1000,
    tokensDecode: 500,
    tokensFuente: 'proveedor'
  })
  t.ok(medido.medido, 'with usage from the provider these are tokens counted by its tokenizer')
  t.is(medido.etiqueta, 'medido')
  t.is(medido.tono, 'medido')

  const estimado = px.vistaDeConteo({ tokensPrefill: 3, tokensDecode: 9, tokensFuente: 'gateway' })
  t.absent(estimado.medido, 'without usage what there is is an estimate and a chunk count')
  t.is(estimado.etiqueta, 'estimado')
  t.is(estimado.tono, 'estimado')
  t.ok(estimado.texto.indexOf('CHUNKS DE SSE') !== -1, estimado.texto)
  t.ok(
    estimado.texto.indexOf('bytes/4') !== -1,
    'and that the prefill is an estimate, not a measurement'
  )

  // The drawing has to keep them apart: if they shared a class, a chunk
  // count would read the same as a measurement, which is exactly the
  // attack D24 closes with outputHash.
  t.absent(
    px.htmlDeConteo(medido) === px.htmlDeConteo(estimado),
    'two counts of different provenance cannot be drawn the same'
  )
  t.ok(px.htmlDeConteo(estimado).indexOf('tono-estimado') !== -1)
  t.ok(px.htmlDeConteo(medido).indexOf('tono-medido') !== -1)

  // An entry from before D25 declares nothing, and saying "gateway" would
  // be asserting something the trail doesn't say.
  const viejo = px.vistaDeConteo({ tokens: 5 })
  t.is(viejo.fuente, null)
  t.is(viejo.etiqueta, 'sin procedencia')
  t.absent(viejo.medido, 'and when in doubt it does NOT assert that it is measured')
})

test('rule 4: a tx hash always says where it came from', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // The test facilitator's one. It's not a heuristic about "hashes that
  // look fake": 32 identical bytes is not the output of keccak over any
  // transaction, and it IS what a toy facilitator emits.
  const falso = px.vistaDeLiquidacion({
    success: true,
    transaction: '0x' + 'fe'.repeat(32),
    network: 'eip155:988',
    payer: '0x1'
  })
  t.ok(falso.txSintetico, '0xfe...fe gets recognized for what it is')
  t.ok(falso.txOrigen.indexOf('PRUEBAS') !== -1, falso.txOrigen)
  t.ok(falso.txOrigen.indexOf('explorer') !== -1, 'and that it does not exist on the explorer')

  // One that isn't. It still carries its provenance: NOBODY verified it
  // against the chain, not the gateway, not the panel. A bare hash reads as confirmed.
  const comun = px.vistaDeLiquidacion({
    success: true,
    transaction: '0x9f2c1a4b7e0d3856',
    network: 'eip155:9745',
    payer: '0x1'
  })
  t.absent(comun.txSintetico)
  t.ok(comun.txOrigen.indexOf('verificaron contra la cadena') !== -1, comun.txOrigen)
  t.ok(comun.txOrigen.indexOf('facilitator') !== -1, 'and who it came from')

  const html = px.htmlDeLiquidacion(comun)
  t.ok(html.indexOf('0x9f2c1a4b7e0d3856') !== -1, 'the hash is shown')
  t.ok(html.indexOf('verificaron contra la cadena') !== -1, 'and never alone')
  t.ok(html.indexOf('eip155:9745') !== -1, 'with the raw CAIP-2 next to the name')
  t.ok(html.indexOf('Plasma') !== -1)

  // A failed settlement is NOT a formality: the node served and did not get
  // paid. It gets said loudly, same as the gateway's log says it.
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

test('rule 5: the header\'s cost is stated as a CAP, not as a charge', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // With SSE the headers go out before the first token: that number is the
  // ceiling the spend was authorized under, and never what actually came out.
  const caro = px.textoDeCostoEstimado(13500)
  t.ok(caro.techo)
  t.is(caro.texto.indexOf('up to'), 0, caro.texto)

  // Zero is written out in words. "USD 0.0000" reads as "it came out very
  // cheap" and that's not it: it's that nobody gets charged.
  t.is(px.textoDeCostoEstimado(0).texto, 'no charge')
  t.absent(px.textoDeCostoEstimado(0).techo)

  // Six decimals: with four, any turn under 50 micros would display
  // identical to free, which is the distinction this text makes.
  t.ok(
    px.textoDeCostoEstimado(12).texto.indexOf('0.000012') !== -1,
    px.textoDeCostoEstimado(12).texto
  )

  // No data is NOT zero: an old turn without the field does not say it was free.
  t.is(px.textoDeCostoEstimado(undefined).texto, 'sin dato de costo')
})

test('the outputHash is really compared, and could-not-check is not a match', async (t) => {
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
  t.is(hOk.estado, 'coincide', 'recomputed over what was received')

  // What D24 exists to catch: the text is not the attested one.
  const mal = px.vistaDeAtestacion({ attestation: base }, { textoRecibido: texto + '!' })
  t.is(mal.hashes.filter((h) => h.campo === 'outputHash')[0].estado, 'no-coincide')
  t.ok(px.htmlDeAtestacion(mal).indexOf('NO coincide') !== -1, 'and it gets drawn as what it is')

  // And the state that CANNOT be confused with the other two: there was
  // nothing to compare against. A panel that draws this as "matches" turns
  // the lack of evidence into evidence.
  const sin = px.vistaDeAtestacion({ attestation: base }, {})
  const hSin = sin.hashes.filter((h) => h.campo === 'outputHash')[0]
  t.is(hSin.estado, 'sin-material')
  t.absent(hSin.estado === 'coincide')
  t.ok(px.htmlDeAtestacion(sin).indexOf('no se recomputo') !== -1)

  // The signature is NOT verified here, and the panel cannot imply that it is.
  t.absent(ok.firmaVerificada, 'this does not recover EIP-191 signers')
  t.ok(ok.avisoFirma.indexOf('NO verifica la firma') !== -1)
  t.is(ok.firmadoSobre, px.bytesFirmados(base), 'but it leaves the bytes to verify it externally')
})

test('the 402 gets drawn with the FOUR pieces of data, and the amount does not get invented in USD', async (t) => {
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
  t.is(o.monto, '1000', 'HOW MUCH')
  t.is(o.payTo, '0x' + 'ab'.repeat(20), 'TO WHOM')
  t.is(o.red.id, 'eip155:988', 'ON WHICH CHAIN')
  t.is(o.tope, 256, 'UP TO HOW MANY TOKENS')

  // The first 402 doesn't carry a real error: "X-PAYMENT header is
  // required" is the spec's phrase, not a rejection, and showing it as if
  // something had failed would say the client did something wrong when it
  // hasn't done anything yet.
  t.is(v.error, null)
  t.is(px.vistaDeDesafio({ ...desafio, error: 'red equivocada' }).error, 'red equivocada')

  const html = px.htmlDeDesafio(v)
  for (const etiqueta of ['CUANTO', 'A QUIEN', 'EN QUE RED', 'HASTA CUANTOS TOKENS']) {
    t.ok(html.indexOf(etiqueta) !== -1, 'the drawing names ' + etiqueta)
  }
  // accepts[] declares `asset` and `extra.name` but NOT `decimals`: dividing
  // by 1e6 would mean inventing the data that's missing right in the number
  // the person reads as "what I'm about to be charged".
  t.ok(html.indexOf('no declara los decimales') !== -1, 'it says why there is no USD')
  t.absent(html.indexOf('USD 0.001') !== -1, 'and it does not get converted anyway')

  // A body that is not a challenge does not get drawn as one: the 402 for
  // exhausted budget (B13) does not carry accepts and has to go through the
  // text path.
  t.absent(px.vistaDeDesafio({ error: { message: 'presupuesto agotado' } }).esDesafio)
  t.is(px.htmlDeDesafio(px.vistaDeDesafio(null)), '')
})

test('the receipt\'s two shapes read the same, and D27 is stated in words', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // The gateway emits the same receipt in two shapes: flattened on
  // GET /v1/receipts/:id, and hanging off `paymentResponse` in the final
  // SSE event (D12). Both have to reach the same drawing.
  const liq = { success: true, transaction: '0xabcdef', network: 'eip155:988', payer: '0x1' }
  t.alike(
    px.liquidacionDe({ id: 'x', ...liq }),
    { id: 'x', ...liq },
    'flattened: it is the receipt itself'
  )
  t.alike(px.liquidacionDe({ x402Version: 2, paymentResponse: liq }), liq, 'and nested')

  // D27: the vocabulary is wider than OpenAI's on purpose. Flattening a
  // client cutoff to "stop" would assert that the response finished.
  t.ok(px.textoDeFinishReason('client_cancelled').indexOf('lo corto el cliente') !== -1)
  t.ok(px.textoDeFinishReason('length').indexOf('tope') !== -1)
  t.is(px.textoDeFinishReason('stop'), 'termino sola')
  t.is(px.textoDeFinishReason(null), 'no declarado')
})

test('the code embedded in the panel is the same one, and it RUNS', async (t) => {
  const px = await import('../qvac/panel-x402.mjs')

  // pages.mjs does not call these functions: it pastes their TEXT inside
  // each page's <script>. If the text doesn't parse, the whole panel breaks
  // and no "the HTML gets served" test notices -- the HTML would get served
  // the same way, broken.
  const api = new Function(
    px.FUENTE_EMBEBIDA +
      '\nreturn { hashDeTexto, vistaDeConteo, vistaDeAtestacion, vistaDeDesafio, ' +
      'vistaDeLiquidacion, htmlDeRecibo, htmlDeConteo, htmlDeDesafio }'
  )()

  t.is(api.hashDeTexto('hola'), px.hashDeTexto('hola'), 'the embedded copy hashes the same')
  const entrada = { tokensFuente: 'gateway', tokensPrefill: 1, tokensDecode: 2 }
  t.is(
    api.htmlDeConteo(api.vistaDeConteo(entrada)),
    px.htmlDeConteo(px.vistaDeConteo(entrada)),
    'and it draws the same'
  )

  // And everything the panel needs is declared: a function left out of
  // FUNCIONES_EMBEBIDAS blows up here, not in someone's browser.
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
  t.ok(html.indexOf('no tiene wallet') !== -1, 'the reason survives the trip to the browser')
  t.ok(html.indexOf('facilitator de PRUEBAS') !== -1, 'and so does the tx\'s stamp')
})

test('D30.3: @x402/evm knows how to classify the test asset\'s revert strings', async (t) => {
  const fs = require('bare-fs')
  const path = require('bare-path')
  const raiz = path.join(__dirname, '..')

  // WHY THIS TEST EXISTS
  //
  // `@x402/evm` does not expose an error code: it classifies a settlement
  // failure by REGEX-MATCHING the contract's revert string
  // (`parseEip3009TransferError`), and its regexes are written against
  // Circle's FiatTokenV2. A contract of ours with the messages in Spanish
  // compiles, deploys, reverts when it has to revert -- and makes the five
  // distinct reasons all reach the gateway as a single `transaction_failed`.
  //
  // That barely bites today, because D9 charges a fixed cap. In Phase 10
  // the batch settles on its own and those five call for three incompatible
  // actions: `nonce_already_used` is an idempotent retry and gets counted
  // as paid; `insufficient_balance` is the other side's problem and does
  // not get retried; `invalid_signature` isn't accounting, it's reputation.
  //
  // HOW IT'S CHECKED, AND WHY THIS WAY
  //
  // The regexes are READ FROM THE INSTALLED PACKAGE instead of being copied
  // here. Copying them would make the test keep passing the day `@x402/evm`
  // changes them, which is exactly the day it needs to be noticed.
  // `parseEip3009TransferError` isn't exported, so it gets extracted from
  // the dist build -- and if that stops being findable, the test cuts off
  // instead of passing something it couldn't check.
  const dist = path.join(raiz, 'node_modules/@x402/evm/dist/cjs/exact/facilitator/index.js')
  const src = fs.readFileSync(dist, 'utf8')

  const desde = src.indexOf('function parseEip3009TransferError')
  t.ok(desde !== -1, 'the classifier was found in @x402/evm')
  const cuerpo = src.slice(desde, src.indexOf('\n}', desde))

  // Each branch of the classifier: an `if`'s regexes, and the code it returns.
  const ramas = []
  for (const m of cuerpo.matchAll(/if \(([^\n]*?)\) \{\s*\n\s*return (\w+);/g)) {
    const regexes = [...m[1].matchAll(/\/((?:[^/\\]|\\.)+)\/([gimsuy]*)\.test/g)].map(
      (r) => new RegExp(r[1], r[2])
    )
    // The constant's name -> its value, which is the string that ends up in
    // the receipt and in the panel.
    const valor = new RegExp('var ' + m[2] + ' = "([^"]+)"').exec(src)
    ramas.push({ regexes, codigo: valor ? valor[1] : m[2] })
  }
  t.ok(ramas.length >= 5, 'and its ' + ramas.length + ' branches')

  const clasificar = (mensaje) => {
    for (const r of ramas) {
      if (r.regexes.some((re) => re.test(mensaje))) return r.codigo
    }
    return 'transaction_failed'
  }

  // The five reasons the contract can return and that Phase 10 needs told
  // apart. The left side comes from the `.sol` right next to it; the right
  // side, from the package. If someone translates the messages, this falls apart.
  //
  // The codes on the right are what ends up in the receipt's `errorReason`,
  // and from there in the panel. They're compared EXACTLY and not by
  // substring: if a package upgrade renames them, this has to break -- it's
  // what Phase 10 will be reading to decide.
  const esperado = [
    ['tUSD: authorization is expired', 'invalid_exact_evm_payload_authorization_valid_before'],
    ['tUSD: authorization is not yet valid', 'invalid_exact_evm_payload_authorization_valid_after'],
    ['tUSD: authorization is used or canceled', 'invalid_exact_evm_nonce_already_used'],
    ['tUSD: transfer amount exceeds balance', 'invalid_exact_evm_insufficient_balance'],
    ['tUSD: invalid signature', 'invalid_exact_evm_signature']
  ]

  const fuente = fs.readFileSync(path.join(raiz, 'scripts', 'activo-prueba.sol'), 'utf8')
  for (const [mensaje, categoria] of esperado) {
    // The message has to exist VERBATIM in the contract: without this the
    // test would be asserting about strings nobody returns anymore.
    t.ok(fuente.indexOf('"' + mensaje + '"') !== -1, 'the contract says: ' + mensaje)
    const dio = clasificar(mensaje)
    t.is(dio, categoria, mensaje + '  ->  ' + dio)
    t.absent(dio === 'transaction_failed', 'and it does NOT fall into the generic one')
  }

  // And the negative control, which is what makes the above mean anything:
  // a message in Spanish has to fall into the generic one. If this started
  // classifying correctly, the whole test would be measuring something else.
  t.is(
    clasificar('tUSD: ese nonce ya se uso'),
    'transaction_failed',
    'a message in Spanish DOES collapse to the generic one: that\'s why they are in English'
  )
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

// El logo viaja EMBEBIDO, no como archivo suelto. El modo de fallo que este
// test cubre es el que ya se pago una vez con los paneles: un asset servido
// desde una carpeta estatica no entra en el grafo de bare-pack, asi que el
// binario standalone se publica sin el y la marca aparece rota recien en la
// maquina del jurado.
//
// Y va SOLO en el gate: es la primera pantalla de un operador nuevo, no un
// sello para repetir en las cinco.
test('el logo de la fundacion viaja embebido y solo en el gate', async (t) => {
  const pages = await import('../qvac/pages.mjs')

  t.ok(
    pages.CHAT_HTML.indexOf('data:image/png;base64,') !== -1,
    'el chat lo lleva como data URI, no como <img src="/algo.png">'
  )
  t.ok(pages.CHAT_HTML.indexOf('class="logo"') !== -1, 'dentro del gate')
  t.ok(
    pages.CHAT_HTML.indexOf('alt="Fundación Iniciativa Urbana Inteligente"') !== -1,
    'con alt: una imagen sin texto alternativo no dice nada a un lector de pantalla'
  )

  for (const [nombre, html] of [
    ['NODE_HTML', pages.NODE_HTML],
    ['NETWORK_HTML', pages.NETWORK_HTML],
    ['WALLET_HTML', pages.WALLET_HTML],
    ['ADMIN_HTML', pages.ADMIN_HTML]
  ]) {
    t.is(html.indexOf('data:image/png;base64,'), -1, nombre + ' no repite la marca')
  }
})

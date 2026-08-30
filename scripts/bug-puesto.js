#!/usr/bin/env node
'use strict'

// Undoes each fix, runs the suite, and checks that it BREAKS the test that
// watches it. Restores the file no matter what.
//
// -----------------------------------------------------------------------------
// WHY IT EXISTS
//
// The rule that came out of B18: **a green run is not evidence of anything if
// the test doesn't fail when the fix is removed.** Two passes of section
// 0-ter claimed a "green suite" over a suite that was failing half the time,
// and no test broke to flag it.
//
// A passing test proves two things at once and doesn't distinguish between
// them: that the fix works, and that the test looks where it's supposed to
// look. The only way to tell them apart is to put the bug back and watch the
// right assert fall. That used to be done by hand, once, on the day the test
// was written -- meaning the evidence lived in that person's head and was
// lost right there. Here it's written down and can be run again.
//
// FOUR OUTCOMES, and the middle two are the most informative:
//
//   OK         broke, and broke the expected test.
//   OTHER TEST broke, but something else fell: the fix is coupled to
//              something else, or the test believed to watch it doesn't.
//   NO BREAK   nobody watches it. The fix has no safety net, and "the suite
//              passes" says nothing about it.
//   NO RUN     the suite didn't start. This is NOT a result about the fix:
//              it's the absence of one, and it counts as a failure for that
//              very reason. Without this fourth outcome, a suite that died
//              before the first test would get reported as NO BREAK -- i.e.
//              this harness inventing the same failure mode it exists to
//              catch. See `corrio()`.
//
// -----------------------------------------------------------------------------
// HOW TO ADD ONE
//
// One entry per fix, with the EXACT text from the tree in `de`. If the anchor
// doesn't exist it's reported as NO ANCHOR instead of passing silently -- a
// refactor that moves the line has to break this, not make it decorative.
//
//   npm run bug-puesto
//
// Takes as long as N runs of the suite (~30 s each).

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const RAIZ = path.resolve(__dirname, '..')

const BUGS = [
  // ---- PHASE 9 / D9 -------------------------------------------------------
  {
    n: 'D9: the cap declared in the 402 stops being applied',
    file: 'qvac/gateway.mjs',
    de: 'if (topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {',
    a: 'if (false && topeCobrado > 0 && estimarTokensDeSalida(contenido) >= topeCobrado) {',
    suite: 'integracion',
    espera: ['D9/D27 caso 3', 'y se corto']
  },

  // ---- PHASE 9 / D27 ------------------------------------------------------
  {
    n: 'D27 case 1: what arrives AFTER the cutoff gets accumulated again',
    file: 'qvac/gateway.mjs',
    de: '    if (cancelado || cortadoPorTope) return\n',
    a: '    if (cortadoPorTope) return\n',
    suite: 'integracion',
    espera: ['el tardio se descarto', 'conto UN chunk']
  },
  {
    n: 'D27 case 1: a cutoff on OUR side gets read again as a provider failure',
    file: 'qvac/gateway.mjs',
    de: '    if (signal.aborted && started) {\n      return { ok: true, started, cortado: true, code: null, message: null }\n    }',
    a: '',
    suite: 'integracion',
    espera: ['D27 caso 1']
  },
  {
    n: 'D27 case 2: settles even though the attempt failed',
    file: 'qvac/gateway.mjs',
    de: '    if (ultimo && ultimo.ok) {',
    a: '    if (ultimo) {',
    suite: 'integracion',
    espera: ['D27 caso 2', 'no puede salir como respuesta valida']
  },

  // ---- PHASE 9 / D25 ------------------------------------------------------
  {
    n: 'D25: the count source is always claimed as measured',
    file: 'qvac/gateway.mjs',
    de: "    tokensFuente: decodeReal && prefillReal ? 'proveedor' : 'gateway'",
    a: "    tokensFuente: 'proveedor'",
    suite: 'integracion',
    espera: ['D25', 'la fuente lo dice']
  },

  // ---- PHASE 9 / D24 ------------------------------------------------------
  {
    n: 'D24: the attestation stops being tied to who claims to have served',
    file: 'qvac/atestacion.mjs',
    de: "  if (firmante.toLowerCase() !== String(atestacion.providerPubkey || '').toLowerCase()) {",
    a: '  if (false) {',
    suite: 'unit',
    espera: ['firmar con TU wallet']
  },
  {
    n: 'D24: a subset gets signed instead of the whole artifact',
    file: 'qvac/atestacion.mjs',
    de: '  const { signature, ...resto } = atestacion // eslint-disable-line no-unused-vars\n  return canonicalize(resto)',
    a: '  return canonicalize({ requestId: atestacion.requestId })',
    suite: 'unit',
    espera: ['cambiar UN campo']
  },
  {
    n: 'D24: with no signer it still goes out, unsigned',
    file: 'qvac/atestacion.mjs',
    de: "  if (typeof firmarMensaje !== 'function') return null",
    a: "  if (typeof firmarMensaje !== 'function') return { ...atestacion }",
    suite: 'unit',
    espera: ['sin firmante no']
  },
  {
    n: 'D24: this node attests again to what a peer served',
    file: 'qvac/atestacion.mjs',
    de: "  if (node.kind === 'peer') {",
    a: '  if (false) {',
    suite: 'unit',
    espera: ['lo que sirvio un par, NO']
  },
  // ---- D30 / BLOCK 0 ----------------------------------------------------
  //
  // D30's preconditions. None of these is new functionality: they're the four
  // spots where something could get lost or sent to the wrong network, and
  // that's why what needs checking isn't that they "work" but that someone's
  // watching.
  {
    n: 'D30.1: the keystore goes back to %TEMP%, which is where D30 pulled it from',
    file: 'qvac/wallet.mjs',
    de: '  const dir = app ? path.join(persistente, app) : path.resolve(String(persistente))',
    a: '  const dir = app ? path.join(temp, app) : path.resolve(String(temp))',
    suite: 'unit',
    espera: ['no cuelga de temp', 'no es volatil']
  },
  {
    n: 'D30.1: with no persistent dir it falls back to temp instead of cutting off',
    file: 'qvac/wallet.mjs',
    de: "    throw new Error('wallet: no hay directorio persistente donde poner el keystore')",
    a: '    persistente = temp',
    suite: 'unit',
    espera: ['sin persistente se corta']
  },
  {
    n: 'D30.2: the chosen rpc stops mattering (mainnet wins again)',
    file: 'qvac/wallet.mjs',
    de: '  const url = rpc || elegida.rpc',
    a: '  const url = REDES[RED_DEFAULT].rpc',
    suite: 'unit',
    espera: ['contra el rpc que se pidio']
  },
  {
    n: 'D30.2: mainnet stops being marked as mainnet',
    file: 'qvac/wallet.mjs',
    de: "    explorer: 'https://plasmascan.to',\n    mainnet: true",
    a: "    explorer: 'https://plasmascan.to',\n    mainnet: false",
    suite: 'unit',
    espera: ['marcada como MAINNET', 'las dos tablas coinciden']
  },
  {
    n: 'D30.3: the artifact stops matching the source sitting next to it',
    file: 'scripts/activo-prueba.sol',
    de: 'string public constant symbol = "tUSD";',
    a: 'string public constant symbol = "tUSDX";',
    suite: 'unit',
    espera: ['se compilo de ESTA fuente']
  },
  {
    n: 'D30: the network guard goes from whitelist to "anything goes"',
    file: 'scripts/redes-prueba.js',
    de: '  if (TESTNETS[id]) return null',
    a: '  return null',
    suite: 'unit',
    espera: ['NO se estrena', 'una cadena desconocida no se estrena']
  },
  {
    // Without the guard the facilitator ALSO doesn't start against 9745 -- it
    // falls over further down, when `testnetDe` returns null. That's defense
    // in depth and it's fine, but what's lost is the REASON: instead of "D30
    // says no", the operator sees a TypeError. That's why what this anchor
    // watches is the message, which is the part that actually disappears.
    n: 'D30.4: the facilitator stops saying WHY it won\'t start against mainnet',
    file: 'scripts/facilitator.js',
    de: "  if (motivo) throw new Error('NO SE LEVANTA. ' + motivo)",
    a: "  if (false) throw new Error('NO SE LEVANTA. ' + motivo)",
    suite: 'integracion',
    espera: ['y dice por que', 'nombrando la decision']
  },
  {
    n: 'D30.4: the facilitator advertises factory-default mainnets again',
    file: 'scripts/facilitator.js',
    de: '    const kinds = ((soportado && soportado.kinds) || []).filter((k) => k.network === red.caip2)',
    a: '    const kinds = (soportado && soportado.kinds) || []',
    suite: 'integracion',
    espera: [
      'no anuncia una sola red que no pueda servir',
      'ninguna mainnet de la lista de fabrica'
    ]
  },

  // ---- PHASE 9 VISIBLE — the four artifacts, viewable ------------------
  //
  // These don't watch whether the phase EMITS anything -- that's already
  // covered above. They watch that what's emitted reaches the screen WITH ITS
  // MEANING, which is a different and quieter failure mode: the panel keeps
  // getting served whole, the suite stays green, and what's lost is the only
  // way a person has to check a mock, an absence, or a hash.
  {
    n: 'panel: the panel\'s BLAKE2b breaks at the block boundary',
    file: 'qvac/panel-x402.mjs',
    de: '  while (n - i > 128) {',
    a: '  while (n - i >= 128) {',
    suite: 'unit',
    espera: ['mismo hash para una entrada de 128 chars']
  },
  {
    n: 'panel rule 1: the missing attestation loses the reason',
    file: 'qvac/panel-x402.mjs',
    de: '      escaparHtml(v.motivo) +',
    a: "      '—' +",
    suite: 'unit',
    espera: ['el motivo APARECE en lo que se dibuja']
  },
  {
    n: 'panel rule 2: a mock runtime stops looking like a mock',
    file: 'qvac/panel-x402.mjs',
    de: "  const esMock = runtime === 'mock' || runtime.indexOf('mock') === 0",
    a: '  const esMock = false',
    suite: 'unit',
    espera: ['un artefacto firmado con una wallet REAL', 'el mock sale nombrado en el dibujo']
  },
  {
    n: 'panel rule 3: a gateway count gets claimed as measured',
    file: 'qvac/panel-x402.mjs',
    de: "  if (fuente === 'proveedor') {",
    a: '  if (fuente !== null) {',
    suite: 'unit',
    espera: ['sin usage lo que hay es una estimacion', 'dos conteos de distinta procedencia']
  },
  {
    n: 'panel rule 4: the test facilitator\'s tx passes as legit',
    file: 'qvac/panel-x402.mjs',
    de: '  const todosIguales =\n    bytes.length > 1 &&',
    a: '  const todosIguales =\n    false &&',
    suite: 'unit',
    espera: ['se reconoce por lo que es']
  },
  {
    n: 'panel: "couldn\'t compare" gets drawn as if it matched',
    file: 'qvac/panel-x402.mjs',
    de: "      estado: 'sin-material',",
    a: "      estado: 'coincide',",
    suite: 'unit',
    espera: ['should be equal']
  },
  {
    n: 'panel: the code stops traveling to the chat (the panel is served blind)',
    file: 'qvac/pages.mjs',
    de: '${ESC}\n${FUENTE_EMBEBIDA}\n${MODAL_JS}\n${CHAT_JS}',
    a: '${ESC}\n${MODAL_JS}\n${CHAT_JS}',
    suite: 'integracion',
    espera: ['lleva embebido el codigo de panel-x402.mjs']
  },
  {
    n: 'panel: the chat stops drawing the turn\'s 402',
    file: 'qvac/pages.mjs',
    de: "          (m.x402 ? htmlDeDesafio(m.x402) : '') +",
    a: "          '' +",
    suite: 'integracion',
    espera: ['el chat dibuja el 402 del turno']
  },
  {
    n: 'panel: the chat drops the receipt\'s SSE event',
    file: 'qvac/pages.mjs',
    de: '              slot.recibo = ev',
    a: '              slot.recibo = null',
    suite: 'integracion',
    espera: ['guardando el evento SSE final de D12']
  },
  {
    n: 'panel: the /node trace loses D25\'s split',
    file: 'qvac/pages.mjs',
    de: '      const conteo = htmlDeConteo(vistaDeConteo(e))',
    a: "      const conteo = ''",
    suite: 'integracion',
    espera: ['pinta el split de D25']
  },
  {
    n: 'panel: the receipt is requested WITH credentials, and loses the 402 exception',
    file: 'qvac/pages.mjs',
    de: "        const r = await fetch('/v1/receipts/' + encodeURIComponent(id))",
    a: "        const r = await authFetch('/v1/receipts/' + encodeURIComponent(id))",
    suite: 'integracion',
    espera: ['SIN credencial', 'excepcion deliberada a B12']
  },
  {
    n: 'panel rule 5: the turn\'s cost gets its own formula back',
    file: 'qvac/pages.mjs',
    de: "partes.push('<span class=\"cost\">' + esc(textoDeCostoEstimado(m.cost).texto) + '</span>')",
    a: "partes.push('<span class=\"cost\">USD ' + m.cost / 1000000 + '</span>')",
    suite: 'integracion',
    espera: ['la misma regla que las vistas nuevas']
  },

  // ---- THE HARNESS ITSELF ----------------------------------------------------
  //
  // The port probe isn't a product feature: it's what lets the integration
  // suite run twice in a row, which is the condition for this harness to mean
  // anything. If it lies, `elegirPuertos` hands out a busy block, the gateway
  // does `Bare.exit(1)`, and the run exits without a single line of TAP --
  // which is the case that `corrio()` now reports as NO RUN instead of as NO
  // BREAK.
  {
    n: 'harness: the port probe says a busy port is free',
    file: 'test/integracion.js',
    de: "    s.on('error', () => resolve(false))",
    a: "    s.on('error', () => resolve(true))",
    suite: 'integracion',
    espera: ['un puerto con un listener encima NO esta libre']
  },

  // ---- D30.4 / THE FACILITATOR ANSWERS WITH SOMETHING THE CLIENT CAN READ -----
  //
  // All three watch the same principle through different paths: on the other
  // side there's a gateway that ALREADY served the tokens (D12 settles LATER)
  // and needs to be able to record WHY it didn't charge. That field ends up
  // in the receipt, in the panel, and is what Phase 10 will read to decide
  // whether a failure gets retried, discarded, or blamed on someone.
  //
  // All three FAIL SILENTLY if nobody looks with the official client: the
  // response looks perfect in the raw JSON and breaks on parsing.
  {
    n: 'facilitator: /verify answers with settle\'s field names',
    file: 'scripts/facilitator.js',
    de: '  const errorDeVerify = (motivo, mensaje) => ({\n    isValid: false,\n    invalidReason: motivo,\n    invalidMessage: mensaje\n  })',
    a: '  const errorDeVerify = (motivo, mensaje) => ({\n    isValid: false,\n    errorReason: motivo,\n    errorMessage: mensaje\n  })',
    suite: 'integracion',
    espera: ['y el MOTIVO llega al cliente', 'en el campo que verify declara']
  },
  {
    n: 'facilitator: /settle omits transaction and network, and the client discards everything',
    file: 'scripts/facilitator.js',
    de: "    transaction: '',\n    network: network || ''",
    a: "    network: network || ''",
    suite: 'integracion',
    espera: ['settle no puede tirar', 'transaction presente aunque vacio']
  },
  {
    n: 'facilitator: the catch goes back to answering one shape for both routes',
    file: 'scripts/facilitator.js',
    de: "      if (ruta === '/settle') {\n        return responder(res, 200, errorDeSettle('facilitator_error', message, redDelPago))\n      }",
    a: '',
    suite: 'integracion',
    espera: ['settle no puede tirar']
  },
  {
    n: 'harness: the port block stops reserving the facilitator\'s derived ones',
    file: 'test/integracion.js',
    de: 'const OFFSETS = [4, 5, 6, 7, 8, 9]',
    a: 'const OFFSETS = [4, 7, 8, 9]',
    suite: 'integracion',
    espera: ['esta reservado']
  },

  // ---- D30.3 / THE ASSET SPEAKS THE LANGUAGE THE TOOLING CLASSIFIES -----
  //
  // A note on what these two entries prove and what they don't: any edit to
  // the `.sol` file ALSO breaks the artifact's SHA-256 assert, which is
  // correct and is another guard. So seeing the expected test fall doesn't
  // prove that test is the ONLY one watching -- it proves that translating a
  // revert string can't pass silently, which is the property that matters.
  {
    n: 'asset: a revert string goes back to Spanish and stops being classified',
    file: 'scripts/activo-prueba.sol',
    de: '        require(block.timestamp < validBefore, "tUSD: authorization is expired");',
    a: '        require(block.timestamp < validBefore, "tUSD: la autorizacion ya vencio");',
    suite: 'unit',
    espera: ['el contrato dice: tUSD: authorization is expired']
  },
  {
    n: 'asset: insufficient balance stops being distinguished from a generic failure',
    file: 'scripts/activo-prueba.sol',
    de: '        require(saldo >= value, "tUSD: transfer amount exceeds balance");',
    a: '        require(saldo >= value, "tUSD: saldo insuficiente");',
    suite: 'unit',
    espera: ['el contrato dice: tUSD: transfer amount exceeds balance']
  },
  {
    n: 'asset: the artifact stops saying which source key it was compiled with',
    file: 'scripts/activo-prueba.artefacto.json',
    de: '  "claveFuente": "activo-prueba.sol",\n',
    a: '',
    suite: 'unit',
    espera: ['y con la clave de fuente']
  },

  // ---- PHASE 10 / RECEIPTS AND BATCH ----------------------------------------
  //
  // Deferred settlement is the same flow as Phase 9 with the settlement
  // postponed (D12). What can break silently: accumulating what we did NOT
  // serve, or approving a batch without checking the signatures inside -- both
  // failures look identical to it working until someone settles.
  {
    n: 'Phase 10: the gateway stops accumulating in the batch what it served',
    file: 'qvac/gateway.mjs',
    de: '    if (paraMi) {',
    a: '    if (false && paraMi) {',
    suite: 'integracion',
    espera: ['los dos pagos verificados entraron al lote']
  },
  {
    n: 'Phase 10: a batch stops requiring a single network and a single wallet',
    file: 'qvac/lote.mjs',
    de: '  const unicos = [...porNonce.values()]\n  mismoDestino(unicos)',
    a: '  const unicos = [...porNonce.values()]',
    suite: 'unit',
    espera: ['dos redes en un lote no', 'dos destinos en un lote tampoco']
  },
  {
    n: 'Phase 10: verificarLote stops checking each receipt\'s EIP-3009 authorization',
    file: 'qvac/lote.mjs',
    de: '    const motivo = await verificarAutorizacion(r, viem, evm)\n    if (motivo) recibosMal.push({ nonce: r.nonce, reason: motivo })',
    a: '    void r',
    suite: 'unit',
    espera: ['senala EXACTAMENTE el recibo malo']
  },
  {
    n: 'Phase 10: a batch altered after signing still passes',
    file: 'qvac/lote.mjs',
    de: "  if (sumar(lote.recibos) !== String(lote.totalAmount)) {\n    return { ok: false, reason: 'el totalAmount no es la suma de los recibos', firmante }\n  }",
    a: '',
    suite: 'unit',
    espera: ['un total cambiado no pasa']
  },
  {
    n: 'Phase 10: x402 stops building an accepts[] for plasma-testnet (9746)',
    file: 'qvac/x402.mjs',
    de: "  if (red === 'plasma-testnet') {",
    a: "  if (false && red === 'plasma-testnet') {",
    suite: 'integracion',
    espera: ['con ASSET y NAME declarados, la red se ofrece']
  },

  // ---- PHASE 10 / PERSISTENCE AND ACCUMULATOR FLUSH ----------------------
  //
  // `_pend` is process memory. What breaks silently: the accumulator doesn't
  // get mirrored to disk (a cutoff between serving and settling gives away
  // the charge for free), or doesn't reload on startup, or the flush doesn't
  // mark what was settled (and resuming charges again), or the size/close
  // trigger doesn't run.
  {
    n: 'Phase 10: the accumulator no longer writes atomically to disk',
    file: 'qvac/lote.mjs',
    de: '    fs.renameSync(tmp, _archivo)',
    a: '    void tmp',
    suite: 'unit',
    espera: ['dos lineas JSON en el archivo']
  },
  {
    n: 'Phase 10: pending items from a previous run don\'t reload',
    file: 'qvac/lote.mjs',
    de: '          if (k) _pend.set(k, r)',
    a: '          void r',
    suite: 'unit',
    espera: ['abrir devuelve cuantos recibos rescato']
  },
  {
    n: 'Phase 10: the flush doesn\'t mark what was settled and resuming charges again',
    file: 'qvac/lote.mjs',
    de: '      marcarLiquidados(res.liquidados)\n      resultados.push({',
    a: '      void res\n      resultados.push({',
    suite: 'unit',
    espera: ['un corte y reanudar no vuelve a cobrar', 'lo liquidado, no solo la memoria']
  },
  {
    n: 'Phase 10: the size-based flush stops checking the threshold and always runs',
    file: 'qvac/lote.mjs',
    de: '  if (contar({ soloPendientes: true }) < _umbral) return null',
    a: '  if (false) return null',
    suite: 'unit',
    espera: ['el flush por tamano NO corre']
  },
  {
    n: 'Phase 10: close stops draining the batch before exiting',
    file: 'qvac/lote.mjs',
    de: '  if (flush && _liquidar) {',
    a: '  if (false && flush && _liquidar) {',
    suite: 'unit',
    espera: ['el close arma-firma-liquida lo pendiente']
  },

  // ---- PHASE 10 / TRANSPORT OVER PROTOMUX -----------------------------------
  //
  // The handoff: a routed request is charged by THE PEER that ran the model,
  // not the gateway. What breaks silently: the peer serves and doesn't
  // accumulate (free work), or the gateway keeps settling a routed request
  // (double charge path), or the cap doesn't arrive and the attestation
  // attests to more than it should.
  {
    n: 'Phase 10: the peer serves a routed request and does NOT accumulate the receipt',
    file: 'qvac/provider.mjs',
    de: '      lote.agregar(recibo)',
    a: '      void recibo',
    suite: 'unit',
    espera: ['el par acumulo el recibo en SU lote']
  },
  {
    n: 'Phase 10: the gateway settles again a request that a peer served',
    file: 'qvac/gateway.mjs',
    de: "  if (node && node.kind === 'peer') {",
    a: "  if (false && node && node.kind === 'peer') {",
    suite: 'integracion',
    espera: ['el settlement es del par, diferido']
  },
  {
    n: 'Phase 10: the peer stops trimming at the 402\'s cap',
    file: 'qvac/provider.mjs',
    de: "        if (tope > 0 && Buffer.byteLength(contenido, 'utf8') / 4 >= tope) {",
    a: '        if (false) {',
    suite: 'unit',
    espera: ['corto en el tope', 'la atestacion dice length']
  },
  {
    n: 'Phase 10: the peer attests to a charge whose payTo isn\'t its wallet',
    file: 'qvac/provider.mjs',
    de: "      if (String(p.requirements.payTo || '').toLowerCase() !== this.walletAddress.toLowerCase()) {",
    a: '      if (false) {',
    suite: 'unit',
    espera: ['no atestigua un cobro que no es suyo', 'no acumula nada']
  },

  // ---- PHASE 10 / D27 CASE 1 — THE PEER'S ATTESTATION ARRIVES AFTER THE CUTOFF ---
  //
  // The client cuts off, the peer ALREADY served a prefix and attests to it.
  // What breaks silently: `cancelChat` deletes the chat on the spot and the
  // peer's late `chat:done` gets discarded (the trace ends up with
  // attestationMissing even though the peer did charge for its prefix), or
  // the peer doesn't even send that `chat:done` when it got canceled.
  {
    n: 'Phase 10 / D27 case 1: cancelChat goes back to deleting the chat on the spot',
    file: 'qvac/swarm.mjs',
    de: '    chat._graceTimer = setTimeout(() => {\n      if (this._chats.get(requestId) !== chat) return\n',
    a: '    this._chats.delete(requestId)\n    chat._graceTimer = setTimeout(() => {\n      if (this._chats.get(requestId) !== chat) return\n',
    suite: 'unit',
    espera: ['el chat:done tardio SI llego a onDone, no se descarto']
  },
  {
    n: 'Phase 10 / D27 case 1: the canceled peer doesn\'t send its chat:done with the attestation',
    file: 'qvac/provider.mjs',
    de: '      } else if (msg.payment && deltas > 0) {',
    a: '      } else if (false) {',
    suite: 'unit',
    espera: ['aun cancelado, el par manda su chat:done', 'quedo acumulado en el lote del par']
  },

  // ---- PHASE 10 / batch-receipts SETTLEMENT ACTUALLY DEFERS LOCALLY -------
  //
  // A node whose manifest declares `batch-receipts` does NOT settle per
  // request: the schema decides that, not a flag. What breaks silently: the
  // gateway keeps settling per request even though the manifest says
  // batch-receipts (double charge path when the flush also runs, and an
  // on-chain tx per request that the mode exists to avoid).
  {
    n: 'Phase 10: a batch-receipts node settles per request again',
    file: 'qvac/gateway.mjs',
    de: "  const diferido = !!(economicPropio && economicPropio.settlement === 'batch-receipts')",
    a: '  const diferido = false',
    suite: 'integracion',
    espera: [
      'el facilitator NO recibio ninguna liquidacion por request',
      'que es diferido: settledBy = batch'
    ]
  },

  // ---- PHASE 11 GROUNDWORK — qvac/x402-cliente.mjs (the PAYER role) --------
  //
  // This module is NOT part of Phase 10: it's the groundwork for Phase 11's
  // budgeted payer (commit 3e8c764). Its five tests live in the unit suite;
  // these anchors cover them one by one. What breaks silently: signing a
  // payment the server rejects, signing above the cap, paying on a network we
  // don't recognize, not resending the X-PAYMENT on retry, or starting a
  // payer with no cap.
  {
    n: 'Phase 11 groundwork: the payment the client signs stops verifying server-side',
    file: 'qvac/x402-cliente.mjs',
    de: '    network: entrada.network,\n    payload: p.payload',
    a: "    network: 'eip155:1',\n    payload: p.payload",
    suite: 'unit',
    espera: ['verificarPago lo acepta']
  },
  {
    n: 'Phase 11 groundwork: crearPago stops cutting off above the cap',
    file: 'qvac/x402-cliente.mjs',
    de: '  if (techoUnidades != null && BigInt(entrada.amount) > BigInt(techoUnidades)) {',
    a: '  if (false) {',
    suite: 'unit',
    espera: ['se corta antes de firmar']
  },
  {
    n: 'Phase 11 groundwork: elegirEntrada stops respecting D15\'s preference',
    file: 'qvac/x402-cliente.mjs',
    de: "export const ORDEN_PREFERENCIA = ['plasma', 'plasma-testnet', 'stable']",
    a: "export const ORDEN_PREFERENCIA = ['stable', 'plasma-testnet', 'plasma']",
    suite: 'unit',
    espera: ['Plasma antes que Stable']
  },
  {
    n: 'Phase 11 groundwork: the 402 dance\'s retry goes out without the signed X-PAYMENT',
    file: 'qvac/x402-cliente.mjs',
    de: "    headers: { ...headersBase, 'x-payment': pago.cabecera }",
    a: '    headers: { ...headersBase }',
    suite: 'unit',
    espera: ['el reintento lleva el X-PAYMENT firmado']
  },
  {
    n: 'Phase 11 groundwork: a payer with no cap starts up again',
    file: 'qvac/x402-cliente.mjs',
    de: "  throw new Error(\n    'x402-cliente: falta el techo de gasto (techoMicros o techoUnidades). ' +\n      'Un pagador sin límite no arranca — es la regla de la Fase 11.'\n  )",
    a: '  return 1n',
    suite: 'unit',
    espera: ['un pagador sin techo no arranca']
  }
]

function unaCorrida(suite) {
  try {
    return execSync('npm run test:' + suite, { cwd: RAIZ, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    // A red suite exits with exit != 0: that's the EXPECTED case here, not an error.
    return (e.stdout || '') + (e.stderr || '')
  }
}

// A run that DID NOT START is not a green run, and the difference matters
// more here than anywhere else: this harness reads "no `not ok` came out" as
// "nobody watches this fix". Meaning a suite that didn't even get to run
// would be reported as a coverage gap that doesn't exist -- and conversely, a
// real gap can hide behind the same symptom.
//
// This actually happens, it's not hypothetical: `test:integracion` binds
// 127.0.0.1:8899, and between two runs in a row the port stays in TIME_WAIT.
// The second one dies with "port 8899 already in use" BEFORE the first test,
// without a single TAP line. With Phase 9's entries the harness went on to
// chain five integration runs in a row and the false "NO BREAK" showed up in
// three of them.
//
// The mark that it ran is the TAP plan (`1..N`): brittle writes it when it
// finishes enumerating, and it doesn't exist if the process died earlier.
function corrio(salida) {
  return /^1\.\.\d+/m.test(salida) || /^# tests = /m.test(salida)
}

function dormir(ms) {
  // Synchronous on purpose: this whole script is, and adding async here would
  // force the loop that restores files in a `finally` to become async too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function correr(suite) {
  // Three attempts, waiting for the port's TIME_WAIT to clear. If it still
  // doesn't start, the last output is returned and `main` reports it as NO
  // RUN -- never as if the suite had passed.
  let salida = ''
  for (let i = 0; i < 3; i++) {
    if (i > 0) dormir(5000)
    salida = unaCorrida(suite)
    if (corrio(salida)) return salida
  }
  return salida
}

// Failing asserts come out INDENTED under their test and only the container
// comes out flush left. Anchoring flush left would lose the indented ones,
// which are usually the ones that say what actually broke.
function loQueRompio(salida) {
  return (salida.match(/not ok \d+ - .*/g) || []).map(
    (l) => l.replace(/^\s*not ok \d+ - /, '').split(' #')[0]
  )
}

function main() {
  const soloEstos = process.argv.slice(2)
  const lista = soloEstos.length
    ? BUGS.filter((b) => soloEstos.some((s) => b.n.toLowerCase().includes(s.toLowerCase())))
    : BUGS

  if (lista.length === 0) {
    console.error('[bug-puesto] no fix matches ' + JSON.stringify(soloEstos))
    process.exit(1)
  }

  console.log(`[bug-puesto] ${lista.length} fix(es), one suite run per each\n`)

  let fallos = 0
  for (const b of lista) {
    const ruta = path.join(RAIZ, b.file)
    const original = fs.readFileSync(ruta, 'utf8')

    // An anchor that no longer exists is NOT skipped silently: a refactor
    // that moves the line has to break this. Otherwise the harness ends up
    // always passing and stops meaning anything -- which is the same failure
    // mode it exists to catch.
    if (original.indexOf(b.de) === -1) {
      console.log('NO ANCHOR  ' + b.n)
      console.log('           the `de` text is no longer in ' + b.file)
      fallos++
      continue
    }

    fs.writeFileSync(ruta, original.replace(b.de, b.a), 'utf8')
    let salida = ''
    try {
      salida = correr(b.suite)
    } finally {
      // No matter what. A harness that can leave the tree with a bug still in
      // it is worse than not having one.
      fs.writeFileSync(ruta, original, 'utf8')
    }

    const rotos = loQueRompio(salida)
    const elCorrecto = b.espera.some((e) => rotos.some((l) => l.indexOf(e) !== -1))

    if (!corrio(salida)) {
      // The fourth outcome, and the only one that says nothing about the
      // fix: the suite didn't get to run. It's counted as a failure because
      // being left without evidence isn't the same as having it.
      console.log('NO RUN     ' + b.n)
      console.log('           the suite didn\'t manage to start in 3 attempts; this says nothing')
      console.log('           about the fix. Last lines:')
      for (const l of salida.trim().split('\n').slice(-3)) console.log('           | ' + l.trim())
      fallos++
    } else if (rotos.length && elCorrecto) {
      console.log('OK         ' + b.n)
      console.log('           broke: ' + rotos.join(' | ').slice(0, 140))
    } else if (rotos.length) {
      console.log('OTHER TEST ' + b.n)
      console.log('           expected: ' + b.espera.join(' / '))
      console.log('           broke:    ' + rotos.join(' | ').slice(0, 200))
      fallos++
    } else {
      console.log('NO BREAK   ' + b.n)
      console.log('           <-- nobody watches this fix: the suite passes with the bug in place')
      fallos++
    }
  }

  console.log('')
  if (fallos === 0) {
    console.log(`[bug-puesto] all ${lista.length} fixes have someone watching them`)
    process.exit(0)
  }
  console.log(`[bug-puesto] ${fallos} of ${lista.length} UNWATCHED`)
  process.exit(1)
}

main()

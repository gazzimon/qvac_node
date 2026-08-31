// Local measurement: how many DISTINCT wallet addresses have PAID this node
// for inference, over x402 (Phase 9/10).
//
// WHY THIS IS A SEPARATE FILE FROM `lote.mjs`
//
// `lote.mjs`'s accumulator (`_pend`) is a QUEUE for the next settlement
// batch, capped at `MAX_PENDIENTES` (500) and pruned by dropping the OLDEST
// entries once that's exceeded -- that's the right behavior for its job
// (feed the next flush), but it means a node with enough traffic silently
// loses older payers from that view. This file answers a different
// question -- "how many distinct wallets has this node EVER been paid by"
// -- and needs its own small, non-evicting-by-volume record to answer it
// honestly. Same atomic-JSON pattern as budget.mjs/apikeys.mjs/
// network-stats.mjs, not the queue lote.mjs uses.
//
// WHAT A "PAYER" IS HERE, AND WHAT IT ISN'T
//
// A payer is the EVM address in `authorization.from` of a verified EIP-3009
// payment this node was the `payTo` of (see provider.mjs and gateway.mjs's
// `paraMi` branch) -- money this node was actually paid, not money it paid
// out. It's a stronger signal than a bare Hyperswarm public key
// (network-stats.mjs): a keypair is free to mint, an address that PAID had
// to move real funds. It is still NOT a verified human identity -- nothing
// stops one person from paying out of many addresses, or several people
// from sharing one. Never present this as "unique users", only as "unique
// paying wallets".
//
// WHAT THIS DOES NOT SEE
//
// Same limitation as network-stats.mjs, and for the same reason: nothing in
// the protocol gossips who paid whom across the marketplace. This is what
// THIS node was paid, not a network-wide total -- there's no aggregation
// service, and adding one is a separate, bigger decision than this file.
//
// No IP, hostname, MAC address or geolocation is ever stored here -- only
// the payer address the payment authorization already carries in the clear.

import fs from 'bare-fs'
import path from 'bare-path'

const VERSION = 1
const DEFAULT_MAX_PAYERS = 20000

const DIA_MS = 24 * 60 * 60 * 1000
const SEMANA_MS = 7 * DIA_MS
const MES_MS = 30 * DIA_MS

// EIP-55 checksum casing varies by wallet software; the identity is the
// lowercased address (same normalization lote.mjs/gateway.mjs already use
// when comparing addresses).
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

let estado = null // { version, payers: { [payerId]: PayerRecord } }
let archivo = null
let maxPayersConfigurado = DEFAULT_MAX_PAYERS

function estadoVacio() {
  return { version: VERSION, payers: {} }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function guardar() {
  if (!archivo) return
  const tmp = archivo + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2))
    fs.renameSync(tmp, archivo)
  } catch (err) {
    console.error(`[payer-stats] could not save the registry: ${(err && err.message) || err}`)
    console.error('[payer-stats] running IN MEMORY: it resets with the process')
    archivo = null
  }
}

export function load(dir) {
  const ruta = path.join(dir, 'payer-stats.json')
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'))
  } catch {
    return null
  }
}

export function save() {
  guardar()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// `dir` should be the PERSISTENT wallet dir (D30.1, same as lote.mjs's
// accumulator) -- not swarmStorageDir(), which can be temp under `bare` in
// dev. `null` => everything in memory (tests, and a node with no wallet).
export function open(dir, { maxPayers = DEFAULT_MAX_PAYERS } = {}) {
  archivo = dir ? path.join(dir, 'payer-stats.json') : null
  maxPayersConfigurado =
    Number.isFinite(maxPayers) && maxPayers > 0 ? Math.floor(maxPayers) : DEFAULT_MAX_PAYERS
  estado = estadoVacio()

  if (archivo) {
    try {
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'))
      if (crudo && crudo.version === VERSION && crudo.payers && typeof crudo.payers === 'object') {
        estado.payers = crudo.payers
      } else if (crudo) {
        console.error(`[payer-stats] ${archivo} is from another version, starting fresh`)
      }
    } catch {
      // Doesn't exist yet, or is corrupt: first boot either way.
    }
  }

  return { loaded: Object.keys(estado.payers).length }
}

export function close() {
  if (estado) guardar()
  estado = null
  archivo = null
}

// For tests: clean memory, no disk.
export function reset() {
  archivo = null
  estado = estadoVacio()
  maxPayersConfigurado = DEFAULT_MAX_PAYERS
}

function asegurarAbierto() {
  if (!estado) estado = estadoVacio()
  return estado
}

// Same defense as network-stats.mjs: bounds storage against unbounded
// growth. Minting a fresh, funded EVM address per payment is far more
// expensive than a Hyperswarm keypair, but the cap costs nothing to keep.
function evictarSiHaceFalta() {
  const ids = Object.keys(estado.payers)
  if (ids.length < maxPayersConfigurado) return

  let peor = null
  for (const id of ids) {
    if (!peor || estado.payers[id].lastSeen < estado.payers[peor].lastSeen) peor = id
  }
  if (peor) delete estado.payers[peor]
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// `provider.mjs` and `gateway.mjs` are the only intended callers, right
// after a receipt they're the `payTo` of gets accumulated in `lote.mjs`.
// Does NOT re-verify the payment: that already happened (x402.verificarPago
// / verifyManifest's sibling checks) before the receipt was built.
export function observePayment({ payer, network = null, timestamp = Date.now() } = {}) {
  if (typeof payer !== 'string' || !EVM_ADDRESS_RE.test(payer)) {
    return { ok: false, reason: 'invalid payer address' }
  }

  const s = asegurarAbierto()
  const payerId = payer.toLowerCase()
  let fila = s.payers[payerId]

  if (!fila) {
    evictarSiHaceFalta()
    fila = {
      payerId,
      firstSeen: timestamp,
      lastSeen: timestamp,
      payments: 1,
      networks: network ? [network] : []
    }
    s.payers[payerId] = fila
  } else {
    fila.lastSeen = Math.max(fila.lastSeen, timestamp)
    fila.payments += 1
    if (network && !fila.networks.includes(network)) fila.networks.push(network)
  }

  guardar()
  return { ok: true, payerId }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function getPayer(payerId) {
  const fila = asegurarAbierto().payers[typeof payerId === 'string' ? payerId.toLowerCase() : '']
  return fila ? { ...fila, networks: [...fila.networks] } : null
}

export function listPayers() {
  return Object.values(asegurarAbierto().payers)
    .map((p) => ({ ...p, networks: [...p.networks] }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}

export function getPayerStats({ now = Date.now() } = {}) {
  const filas = Object.values(asegurarAbierto().payers)

  let unique24h = 0
  let unique7d = 0
  let unique30d = 0
  let totalPayments = 0

  for (const fila of filas) {
    const edad = now - fila.lastSeen
    if (edad <= DIA_MS) unique24h++
    if (edad <= SEMANA_MS) unique7d++
    if (edad <= MES_MS) unique30d++
    totalPayments += fila.payments
  }

  return {
    unique24h,
    unique7d,
    unique30d,
    totalEverSeen: filas.length,
    totalPayments
  }
}

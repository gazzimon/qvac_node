// Elegir a QUE candidato se le manda un request. Cierra D6.
//
// Vive aparte de store.mjs y de gateway.mjs a proposito: el store es estado
// (quien existe y como esta), el gateway es HTTP (como se contesta), y esto es
// una decision. Sacarla afuera la hace testeable sin levantar un swarm ni un
// servidor -- que es lo unico que permite probar "con dos pares, uno al 90% y
// otro al 10%, gana el segundo" sin dos maquinas.
//
// Todo lo de aca adentro es PURO: no lee el registro, no mira el reloj salvo
// que se lo pasen, no tiene efectos. Recibe la lista de candidatos que
// `store.findAllByModelId` ya filtro por modelo y por online.
//
// Hasta ahora el gateway tomaba `candidatos[0]` y el orden venia de un rank
// fijo por `kind` puesto para que el modo --demo ejercitara el camino P2P
// (store.mjs:435-443). Eso se conserva como DESEMPATE, no como criterio: con
// carga pareja el orden es el de siempre, y el demo sigue mostrando lo que
// mostraba.

// Los mocks del modo --demo fluctuan al azar (store.startFluctuation) porque
// tienen que verse vivos en el video sin que nadie les mande nada. Esa carga es
// teatro, y compararla contra la carga real de un par seria comparar un numero
// con una ficcion: un mock "al 10%" no esta menos ocupado que un par al 50%,
// no esta ocupado en absoluto.
//
// Por eso el mock no compite por carga: queda SIEMPRE despues de cualquier
// candidato real. Es la unica forma de que el ruteo por carga no se coma la
// unica garantia que el modo demo necesita.
const RANK_KIND = { peer: 0, real: 1, upstream: 2, mock: 3 }

function rankKind(node) {
  return RANK_KIND[node.kind] ?? 9
}

function esMock(node) {
  return node.kind === 'mock'
}

// Carga normalizada 0..1. Un nodo sin capacidad declarada se trata como lleno:
// no se puede afirmar que tiene lugar.
export function cargaDe(node) {
  const max = Number(node.maxConcurrentRequests)
  if (!Number.isFinite(max) || max <= 0) return 1
  const activos = Number(node.activeRequests) || 0
  return Math.min(Math.max(activos / max, 0), 1)
}

export function estaSaturado(node) {
  const max = Number(node.maxConcurrentRequests)
  if (!Number.isFinite(max) || max <= 0) return true
  return (Number(node.activeRequests) || 0) >= max
}

// El historico por par que `directory.recordStat` ya viene guardando en cada
// request y que hasta ahora no alimentaba ninguna decision (ver
// NOTES-SATURACION.md). Se recibe inyectado como funcion para no acoplar esto
// al Hyperbee: el gateway sabe de donde sacarlo, esto no tiene por que.
//
// Forma esperada: { requests, errors, lastMs } | null
function penalidadHistorica(node, statsFor) {
  if (typeof statsFor !== 'function') return { errorRate: 0, lastMs: null }
  let s = null
  try {
    s = statsFor(node)
  } catch {
    // Un historico roto no puede tumbar el ruteo: se rutea sin el.
    return { errorRate: 0, lastMs: null }
  }
  if (!s) return { errorRate: 0, lastMs: null }

  const requests = Number(s.requests) || 0
  const errors = Number(s.errors) || 0
  const errorRate = requests > 0 ? Math.min(errors / requests, 1) : 0
  const lastMs = Number.isFinite(Number(s.lastMs)) ? Number(s.lastMs) : null
  return { errorRate, lastMs }
}

// Ordena los candidatos de mejor a peor. Devuelve objetos nuevos con el detalle
// de por que quedaron donde quedaron -- es lo que despues termina en el log de
// ruteo, para que la decision se pueda auditar en vez de adivinar.
export function scoreCandidates(candidatos, { statsFor = null, random = Math.random } = {}) {
  const scored = candidatos.map((node, i) => {
    const { errorRate, lastMs } = penalidadHistorica(node, statsFor)
    return {
      node,
      id: node.id,
      kind: node.kind,
      operator: node.operator,
      orden: i, // posicion original: sostiene el desempate estable
      saturado: estaSaturado(node),
      mock: esMock(node),
      carga: cargaDe(node),
      loadPct: Math.round(cargaDe(node) * 100),
      errorRate,
      lastMs,
      rank: rankKind(node),
      // Empates EXACTOS de carga son la regla, no la excepcion: una red
      // ociosa tiene a todos en 0. Sin desempate al azar, todos los
      // consumidores que decidan en la misma ventana de 2s -- el intervalo de
      // node:status, swarm.mjs:48 -- eligen al mismo par y lo saturan entre
      // todos. El jitter rompe la estampida sin que nadie tenga que
      // coordinarse con nadie (S4 de NOTES-SATURACION.md).
      jitter: random()
    }
  })

  scored.sort((a, b) => {
    // 1. Los que pueden atender ahora, antes que los llenos.
    if (a.saturado !== b.saturado) return a.saturado ? 1 : -1
    // 2. Cualquier candidato real antes que cualquier mock.
    if (a.mock !== b.mock) return a.mock ? 1 : -1
    // 3. El que tiene mas lugar. ESTE es D6.
    if (a.carga !== b.carga) return a.carga - b.carga
    // 4. Con carga pareja, el que viene fallando menos.
    if (a.errorRate !== b.errorRate) return a.errorRate - b.errorRate
    // 5. Y despues el que viene contestando mas rapido.
    if (a.lastMs !== b.lastMs) {
      if (a.lastMs === null) return 1
      if (b.lastMs === null) return -1
      return a.lastMs - b.lastMs
    }
    // 6. El orden historico por kind: preferencia del modo demo, ya no criterio.
    if (a.rank !== b.rank) return a.rank - b.rank
    // 7. Empate exacto: al azar, para no mandar todos al mismo.
    return a.jitter - b.jitter
  })

  return scored
}

// El motivo en castellano que va al log. No es decoracion: el DoD de la Fase 8
// pide que el log diga POR QUE se eligio, y "primer candidato" -lo unico que se
// podia decir antes- no es un por que.
function motivoDe(mejor, scored) {
  if (!mejor) return 'sin candidatos'
  if (scored.length === 1) return 'unico candidato'

  const libres = scored.filter((s) => !s.saturado)
  if (libres.length === 0) return `los ${scored.length} candidatos estan saturados`

  const segundo = scored[1]
  if (mejor.carga !== segundo.carga) {
    return `menor carga (${mejor.loadPct}% vs ${segundo.loadPct}%) entre ${scored.length} candidatos`
  }
  if (segundo.saturado) {
    return `unico candidato con lugar de ${scored.length}`
  }
  if (mejor.errorRate !== segundo.errorRate) {
    return `carga pareja (${mejor.loadPct}%), menos errores historicos`
  }
  if (mejor.lastMs !== segundo.lastMs && mejor.lastMs !== null) {
    return `carga pareja (${mejor.loadPct}%), mejor latencia historica (${mejor.lastMs}ms)`
  }
  if (mejor.rank !== segundo.rank) {
    return `carga pareja (${mejor.loadPct}%), preferencia por tipo (${mejor.kind})`
  }
  return `carga pareja (${mejor.loadPct}%) entre ${scored.length} candidatos, desempate al azar`
}

// La API que usa el gateway.
//
//   pickCandidate(candidatos)  ->  { node, reason, orden, scored, decision }
//
// `orden` es la lista de nodos ya ordenada: el loop de reintento de
// handleRemoteChat la recorre tal cual, asi que el segundo intento tambien
// respeta la carga en vez de volver al orden de llegada.
//
// `pin` fija una maquina concreta (extension propia `node` de
// /v1/chat/completions). Si el nodo fijado no esta entre los candidatos se
// devuelve node:null con el motivo -- NO se cae de vuelta al mejor disponible:
// elegir una maquina y recibir la respuesta de otra sin enterarse vacia de
// sentido a la funcion.
export function pickCandidate(candidatos, { statsFor = null, random = Math.random, pin = null } = {}) {
  const lista = Array.isArray(candidatos) ? candidatos : []

  if (lista.length === 0) {
    return { node: null, reason: 'sin candidatos', orden: [], scored: [], decision: null, pin }
  }

  if (pin) {
    const fijado = lista.find((n) => n.id === pin)
    if (!fijado) {
      return {
        node: null,
        reason: `el nodo fijado (${pin}) no esta entre los candidatos`,
        orden: [],
        scored: [],
        decision: null,
        pin
      }
    }
    const saturado = estaSaturado(fijado)
    return {
      node: fijado,
      // Un pin saturado se devuelve IGUAL, con el aviso: el que fija una
      // maquina pide esa maquina, y el gateway decide si la intenta o corta.
      reason: saturado
        ? `nodo fijado por el cliente (saturado: ${fijado.activeRequests}/${fijado.maxConcurrentRequests})`
        : 'nodo fijado por el cliente',
      orden: [fijado],
      scored: [],
      decision: { elegido: fijado.id, pin: true, saturado, alternativas: [] },
      pin
    }
  }

  const scored = scoreCandidates(lista, { statsFor, random })
  const mejor = scored[0]
  const reason = motivoDe(mejor, scored)

  return {
    node: mejor.node,
    reason,
    orden: scored.map((s) => s.node),
    scored,
    decision: {
      elegido: mejor.id,
      pin: false,
      loadPct: mejor.loadPct,
      alternativas: scored.slice(1, 4).map((s) => ({
        id: s.id,
        operator: s.operator,
        kind: s.kind,
        loadPct: s.loadPct,
        saturado: s.saturado
      }))
    },
    pin: null
  }
}

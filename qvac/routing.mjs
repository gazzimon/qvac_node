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

// FASE 8 — cuanto costaria ESTE request en ESTE candidato, en micro-dolares.
//
// Se recibe inyectado por la misma razon que `statsFor`: esto es una decision
// pura y no tiene por que saber que existe costs.mjs, ni el prompt, ni el tope
// de salida con el que se estima. El gateway, que si sabe las tres cosas, pasa
// una funcion ya atada al request.
//
// La unidad es micro-dolares enteros, la misma de costs.mjs y budget.mjs, y por
// eso es COMPARABLE entre candidatos de clases distintas -- que era la mitad de
// esta fase. Un par y el motor local dan CERO, y ese cero no es un placeholder:
// es la verdad de hoy, porque el pago P2P es la Fase 9. Un upstream da el precio
// que declaro el operador en su config.
function precioDeCandidato(node, precioDe) {
  if (typeof precioDe !== 'function') return 0
  try {
    const n = Number(precioDe(node))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    // Un precio que no se puede calcular no puede tumbar el ruteo: se rutea
    // sin el, igual que con el historico roto.
    return 0
  }
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
export function scoreCandidates(
  candidatos,
  { statsFor = null, precioDe = null, random = Math.random } = {}
) {
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
      precio: precioDeCandidato(node, precioDe),
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
    // 4. FASE 8 — con carga pareja, el MAS BARATO gana.
    //
    // Va DESPUES de la carga y no antes, y eso es la fase entera: el precio no
    // puede ganarle a "puede atender ahora". Mandarle un request a la opcion
    // barata que esta llena es cambiar dolares por latencia sin que nadie lo
    // haya pedido, y la respuesta que no llega no es barata: es ninguna.
    //
    // Va ANTES de errorRate y de la latencia, que es lo que pide el DoD ("con
    // carga pareja, el mas barato gana"), y en la practica eso cuesta menos de
    // lo que parece: hoy TODOS los pares y el motor local valen cero, asi que
    // esta comparacion solo separa gratis de pago. Entre pares -- que es donde
    // errorRate y la latencia importan -- siguen empatados en precio y deciden
    // ellos, igual que antes.
    //
    // Y esto reemplaza un accidente por un criterio. Que "la de casa le gane a
    // la que cobra" ya pasaba, pero lo producia el desempate por `kind` del
    // paso 7 -- que el propio archivo declara "preferencia del modo demo, ya no
    // criterio". Andaba por el orden en que alguien escribio un objeto.
    if (a.precio !== b.precio) return a.precio - b.precio
    // 5. Con carga y precio parejos, el que viene fallando menos.
    if (a.errorRate !== b.errorRate) return a.errorRate - b.errorRate
    // 6. Y despues el que viene contestando mas rapido.
    if (a.lastMs !== b.lastMs) {
      if (a.lastMs === null) return 1
      if (b.lastMs === null) return -1
      return a.lastMs - b.lastMs
    }
    // 7. El orden historico por kind: preferencia del modo demo, ya no criterio.
    if (a.rank !== b.rank) return a.rank - b.rank
    // 8. Empate exacto: al azar, para no mandar todos al mismo.
    return a.jitter - b.jitter
  })

  return scored
}

// Micro-dolares para el ojo humano del log. `gratis` y no `USD 0.0000` porque
// son cosas distintas: uno dice que no cuesta plata, el otro que cuesta poca.
// Y la diferencia entre un par de la red y una API que cobra es exactamente
// esa.
function formatMicros(micros) {
  const n = Number(micros) || 0
  if (n <= 0) return 'free'
  return 'USD ' + (n / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

// The reason that goes into the log. It is not decoration: the Phase 8 DoD
// requires the log to say WHY a node was chosen, and "first candidate" -all
// that could be said before- is not a why.
function motivoDe(mejor, scored) {
  if (!mejor) return 'no candidates'
  if (scored.length === 1) return 'only candidate'

  const libres = scored.filter((s) => !s.saturado)
  if (libres.length === 0) return `all ${scored.length} candidates are saturated`

  const segundo = scored[1]
  if (mejor.carga !== segundo.carga) {
    return `lower load (${mejor.loadPct}% vs ${segundo.loadPct}%) among ${scored.length} candidates`
  }
  if (segundo.saturado) {
    return `only candidate with room, of ${scored.length}`
  }
  // FASE 8 — el DoD pide que el log diga POR QUE, y "mas barato" es un por que
  // que antes no se podia dar. Se nombran los DOS numeros: sin el del segundo,
  // "el mas barato" no se puede auditar contra nada.
  //
  // Se compara `<` y no `!==`, y eso no es una precaucion teorica: con `!==`
  // esta rama afirmaba "mas barato" por el solo hecho de que los precios
  // difirieran, ASUMIENDO que el sort ya habia ordenado por precio. Sacando el
  // criterio del sort, el log seguia diciendo "mas barato" y nombraba como
  // ganador al MAS CARO -- un motivo que se contradice con su propio numero.
  // Un motivo tiene que afirmar un hecho, no repetir lo que el sort deberia
  // haber hecho.
  if (mejor.precio < segundo.precio) {
    return (
      `even load (${mejor.loadPct}%), cheaper: ` +
      `${formatMicros(mejor.precio)} vs ${formatMicros(segundo.precio)} estimated`
    )
  }
  if (mejor.errorRate !== segundo.errorRate) {
    return `even load (${mejor.loadPct}%), fewer historical errors`
  }
  if (mejor.lastMs !== segundo.lastMs && mejor.lastMs !== null) {
    return `even load (${mejor.loadPct}%), better historical latency (${mejor.lastMs}ms)`
  }
  if (mejor.rank !== segundo.rank) {
    return `even load (${mejor.loadPct}%), preference by kind (${mejor.kind})`
  }
  return `even load (${mejor.loadPct}%) among ${scored.length} candidates, random tie-break`
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
export function pickCandidate(
  candidatos,
  { statsFor = null, precioDe = null, random = Math.random, pin = null } = {}
) {
  const lista = Array.isArray(candidatos) ? candidatos : []

  if (lista.length === 0) {
    return { node: null, reason: 'no candidates', orden: [], scored: [], decision: null, pin }
  }

  if (pin) {
    const fijado = lista.find((n) => n.id === pin)
    if (!fijado) {
      return {
        node: null,
        reason: `the pinned node (${pin}) is not among the candidates`,
        orden: [],
        scored: [],
        decision: null,
        pin
      }
    }
    const saturado = estaSaturado(fijado)
    return {
      node: fijado,
      // A saturated pin is returned ANYWAY, with the warning: whoever pins a
      // machine is asking for that machine, and the gateway decides whether to
      // try it or bail.
      reason: saturado
        ? `node pinned by the client (saturated: ${fijado.activeRequests}/${fijado.maxConcurrentRequests})`
        : 'node pinned by the client',
      orden: [fijado],
      scored: [],
      decision: { elegido: fijado.id, pin: true, saturado, alternativas: [] },
      pin
    }
  }

  const scored = scoreCandidates(lista, { statsFor, precioDe, random })
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

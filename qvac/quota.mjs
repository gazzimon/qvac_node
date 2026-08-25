// La cuota gratuita que este nodo le regala a cada par. Fase 6.6 / D23.
//
// Es el gemelo de budget.mjs y conviene leerlos juntos, porque la simetria es
// el punto:
//
//                     budget.mjs              quota.mjs
//   que mide          dolares                 tokens de salida
//   de quien          la cuenta que consume   el par que pide
//   quien lo lleva    el gateway (consumidor) el proveedor (quien presta GPU)
//   ventana           mes calendario          24 h deslizantes
//   al agotarse       degrada a local         rechaza y el consumidor degrada
//
// Los dos siguen el principio de D18: EL CONTADOR VIVE DEL LADO QUE PAGA. Alla
// el que paga es el que gasta dolares; aca es el que presta la GPU y la luz.
//
// -----------------------------------------------------------------------------
// POR QUE ACA Y NO EN EL GATEWAY
//
// El gateway es del consumidor. Pedirle que respete la cuota del proveedor es
// poner al zorro a cuidar el gallinero: cualquiera que edite su propio gateway
// consume gratis sin limite, y la cuota pasa a ser decorativa.
//
// El proveedor, en cambio, sabe quien le esta pidiendo sin tener que creerle a
// nadie: la clave del par la establece la conexion de Hyperswarm, no el
// contenido del mensaje. Es la misma propiedad en la que se apoya
// verifyManifest para atar un manifiesto a un socket.
//
// -----------------------------------------------------------------------------
// POR QUE VENTANA DESLIZANTE Y NO "POR DIA"
//
// Un corte a medianoche crea un pico de trafico a las 00:01 y castiga al que
// empezo 23:50: consume su cuota entera y diez minutos despues le regalan otra.
// Con ventana deslizante la cuota se repone de a poco, sola, y no hay un
// instante privilegiado en el dia.
//
// La ventana se implementa con BALDES POR HORA, no con la lista de cada
// request. Un balde por hora son 24 numeros por par -- memoria acotada aunque
// un par mande un millon de requests. El precio es la granularidad: la ventana
// efectiva es de entre 23 y 24 horas, no exactamente 24. Se elige a proposito,
// y se dice aca en vez de que alguien lo descubra midiendo.
// -----------------------------------------------------------------------------

// D23: 100.000 tokens de SALIDA cada 24 h, por par.
//
// De salida y no de entrada porque son los que cuestan GPU: el prompt se
// procesa una vez y es barato, la generacion es token por token. Contar la
// entrada complicaria el numero sin cambiar quien paga que.
export const CUOTA_TOKENS = 100_000
export const VENTANA_HORAS = 24

const MS_POR_HORA = 60 * 60 * 1000

// peerKey (hex) -> Map<indiceDeHora, tokens>
const baldes = new Map()

let cuotaTokens = CUOTA_TOKENS
let ventanaHoras = VENTANA_HORAS

// El indice absoluto de la hora en la que cae `now`. Absoluto y no "hora del
// dia": con 0..23 los baldes de hoy y los de ayer colisionan, y un par que
// consumio ayer a las 15 arrastraria ese numero a las 15 de hoy.
function horaDe(now) {
  return Math.floor(now / MS_POR_HORA)
}

function baldesDe(peerKey) {
  let m = baldes.get(peerKey)
  if (!m) {
    m = new Map()
    baldes.set(peerKey, m)
  }
  return m
}

// Se poda al leer, no con un timer. Un timer no corre si el proceso estuvo
// apagado, y ademas mantendria vivo el Map de un par que no vuelve nunca. Al
// podar en la lectura, un par inactivo no cuesta CPU y su entrada se limpia
// sola la proxima vez que aparece.
function podar(m, now) {
  const corte = horaDe(now) - ventanaHoras
  for (const h of m.keys()) {
    if (h <= corte) m.delete(h)
  }
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export function usado(peerKey, { now = Date.now() } = {}) {
  const m = baldesDe(peerKey)
  podar(m, now)
  let total = 0
  for (const v of m.values()) total += v
  return total
}

export function restante(peerKey, { now = Date.now() } = {}) {
  return Math.max(0, cuotaTokens - usado(peerKey, { now }))
}

// Devuelve { ok, reason, ... } en vez de un booleano, por la misma razon que
// verifyManifest: el proveedor tiene que poder mandarle al consumidor un
// mensaje que explique que paso y en cuanto se repone.
export function check(peerKey, { now = Date.now() } = {}) {
  const usadoAhora = usado(peerKey, { now })
  const queda = Math.max(0, cuotaTokens - usadoAhora)

  if (queda > 0) return { ok: true, used: usadoAhora, remaining: queda, quota: cuotaTokens }

  return {
    ok: false,
    reason: `cuota gratuita agotada: ${usadoAhora}/${cuotaTokens} tokens en las ultimas ${ventanaHoras} h`,
    used: usadoAhora,
    remaining: 0,
    quota: cuotaTokens,
    // Cuando vuelve a haber algo. Es el dato accionable: sin esto el
    // consumidor solo sabe que no puede, no cuando podria.
    resetsInMs: msHastaQueSeLibere(peerKey, now)
  }
}

// Cuanto falta para que el balde mas viejo salga de la ventana. Es el primer
// instante en el que la cuota deja de estar en cero.
function msHastaQueSeLibere(peerKey, now) {
  const m = baldesDe(peerKey)
  podar(m, now)
  if (m.size === 0) return 0
  const masViejo = Math.min(...m.keys())
  const saleEn = (masViejo + ventanaHoras + 1) * MS_POR_HORA
  return Math.max(0, saleEn - now)
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

// Se llama DESPUES de servir, con los tokens que se generaron de verdad.
//
// A diferencia de budget.mjs no hay reserva: aca no se puede rechazar a mitad
// de camino sin cortarle el stream a alguien, y D4 dice que un stream empezado
// no se corta. El chequeo va antes de empezar y el registro despues de
// terminar; el desborde de un solo request -- servir hasta 4096 tokens
// habiendo tenido 1 de cuota -- se acepta a proposito. Es acotado por
// `max_tokens`, y la alternativa es cortar generaciones por la mitad, que se
// ve como un bug y regala igual la GPU que ya se gasto.
export function registrar(peerKey, tokens, { now = Date.now() } = {}) {
  const n = Math.max(0, Math.floor(Number(tokens) || 0))
  if (n === 0) return 0

  const m = baldesDe(peerKey)
  podar(m, now)
  const h = horaDe(now)
  m.set(h, (m.get(h) || 0) + n)
  return n
}

// ---------------------------------------------------------------------------
// Vista y configuracion
// ---------------------------------------------------------------------------

// Lo que muestra el panel del proveedor: cuanto regalo y a quien.
export function listar({ now = Date.now() } = {}) {
  const filas = []
  for (const [peerKey, m] of baldes) {
    podar(m, now)
    if (m.size === 0) {
      // Un par que no consumio nada en la ventana no ocupa lugar ni en la
      // memoria ni en la pantalla.
      baldes.delete(peerKey)
      continue
    }
    let total = 0
    for (const v of m.values()) total += v
    filas.push({
      peerKey,
      used: total,
      remaining: Math.max(0, cuotaTokens - total),
      quota: cuotaTokens
    })
  }
  return filas.sort((a, b) => b.used - a.used)
}

export function configurar({ tokens = null, horas = null } = {}) {
  if (Number.isFinite(tokens) && tokens >= 0) cuotaTokens = Math.floor(tokens)
  if (Number.isFinite(horas) && horas > 0) ventanaHoras = Math.floor(horas)
  return { tokens: cuotaTokens, horas: ventanaHoras }
}

export function config() {
  return { tokens: cuotaTokens, horas: ventanaHoras }
}

export function reset() {
  baldes.clear()
  cuotaTokens = CUOTA_TOKENS
  ventanaHoras = VENTANA_HORAS
}

// De un directorio a trozos embebibles. La mitad "sabe de archivos" del RAG.
//
// No toca la red ni el indice: entra una ruta, salen objetos { id, content,
// source, lines }. Por eso se puede probar sin API key y sin hypercore.
//
// -----------------------------------------------------------------------------
// CADA TROZO DICE DE DONDE SALIO
//
// El chunker por defecto de @qvac/rag corta por parrafos, que para prosa esta
// bien y para codigo es malo: parte una funcion al medio y el agente recupera
// un fragmento que no puede citar.
//
// Aca cada trozo lleva pegada arriba una linea `// archivo:desde-hasta`. Eso
// hace dos cosas: le da al agente un `file:line` clickeable, y mete el nombre
// del archivo DENTRO del texto que se embebe, con lo cual "que hace
// provider.mjs" recupera provider.mjs aunque el cuerpo no diga su propio
// nombre en ningun lado.
//
// -----------------------------------------------------------------------------
// NINGUN SECRETO ENTRA AL INDICE
//
// El indice vive en un hypercore que el swarm replica. Un secreto que entra
// aca no queda en esta maquina: se le sirve a cualquier par que pida el
// indice, y borrarlo del disco propio no lo borra de los que ya lo copiaron.
//
// La lista blanca de extensiones ya deja afuera .env, pero eso protege del
// archivo esperado, no del secreto pegado en un README o en un comentario. Por
// eso ADEMAS cada trozo se revisa contra patrones de credencial conocidos y se
// descarta entero si matchea. Descartar de mas es barato; una key replicada
// por P2P no se puede deshacer.
// -----------------------------------------------------------------------------

import fs from 'bare-fs'
import path from 'bare-path'

// Solo lo que sabemos leer. Es lista blanca y no lista negra a proposito: un
// formato nuevo que nadie penso entra como "no indexado", no como "indexado a
// ver que pasa".
export const EXTENSIONES = ['.mjs', '.js', '.json', '.md', '.sh', '.ps1', '.txt', '.yml', '.yaml']

// Directorios que nunca se recorren.
export const EXCLUIR_DIR = [
  'node_modules', '.git', 'build', 'out', 'data', 'deck', 'brand', 'landing',
  '.playwright-mcp', 'old', 'logs', 'dist', 'coverage', '.claude'
]

// Archivos que nunca se leen, aunque la extension pase.
export const EXCLUIR_ARCHIVO = [
  '.env', '.env.local', '.env.production', 'package-lock.json',
  'identity.json', 'consent.json', 'upstreams.json'
]

// Patrones de credencial. No pretenden ser exhaustivos -- son los que este
// proyecto tiene cerca -- pero cada uno que se agrega es un modo de fuga que
// deja de existir.
const SECRETOS = [
  /nvapi-[A-Za-z0-9_\-]{20,}/,          // NVIDIA NIM
  /sk-[A-Za-z0-9]{32,}/,                 // OpenAI
  /sk-ant-[A-Za-z0-9_\-]{20,}/,          // Anthropic
  /qvac_sk_[A-Za-z0-9_\-]{20,}/,         // las propias de este gateway
  /gh[pousr]_[A-Za-z0-9]{30,}/,          // GitHub
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // claves privadas
  /xox[baprs]-[A-Za-z0-9-]{10,}/         // Slack
]

export function pareceSecreto(texto) {
  for (const re of SECRETOS) if (re.test(texto)) return true
  return false
}

// Tamano objetivo de un trozo, en caracteres. No en tokens: contarlos exige el
// tokenizador del modelo, que del lado remoto no tenemos. Se apunta bajo para
// que el trozo entre comodo en cualquier ventana.
const OBJETIVO_CHARS = 1400
const MINIMO_CHARS = 80

function esDirectorioExcluido(nombre) {
  return EXCLUIR_DIR.indexOf(nombre) !== -1 || nombre.startsWith('.')
}

// Recorre una raiz y devuelve los archivos indexables, con su ruta relativa.
export function recolectar(raiz, { extensiones = EXTENSIONES, maxBytes = 512 * 1024 } = {}) {
  const out = []

  function caminar(dir) {
    let entradas = []
    try {
      entradas = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const nombre of entradas) {
      const completo = path.join(dir, nombre)
      let st
      try {
        st = fs.statSync(completo)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!esDirectorioExcluido(nombre)) caminar(completo)
        continue
      }
      if (EXCLUIR_ARCHIVO.indexOf(nombre) !== -1) continue
      if (extensiones.indexOf(path.extname(nombre)) === -1) continue
      // Un archivo enorme casi siempre es generado (un bundle, un dump) y
      // embeberlo gasta cuota sin agregar señal.
      if (st.size > maxBytes) continue
      out.push({ ruta: completo, rel: path.relative(raiz, completo).split('\\').join('/'), bytes: st.size })
    }
  }

  caminar(raiz)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

// Corta un archivo en trozos que respetan los limites naturales del texto.
//
// Para markdown: los encabezados. Para codigo: los bloques separados por linea
// en blanco, que en este repo coinciden con las declaraciones de nivel
// superior y -- mas importante -- con los comentarios largos que explican POR
// QUE, que es justo lo que un agente quiere recuperar.
export function trozar(rel, contenido, { objetivo = OBJETIVO_CHARS } = {}) {
  const lineas = contenido.split('\n')
  const esMarkdown = rel.endsWith('.md')

  const bloques = []
  let actual = []
  let desde = 1

  const cerrar = (hasta) => {
    if (actual.length === 0) return
    const texto = actual.join('\n')
    if (texto.trim().length >= MINIMO_CHARS) bloques.push({ desde, hasta, texto })
    actual = []
  }

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]
    const nro = i + 1

    // Un encabezado markdown abre trozo nuevo aunque el anterior sea corto: la
    // seccion es la unidad de sentido del documento.
    const corteFuerte = esMarkdown && /^#{1,4}\s/.test(linea) && actual.length > 0
    if (corteFuerte) {
      cerrar(nro - 1)
      desde = nro
    }

    actual.push(linea)

    const largo = actual.join('\n').length
    if (largo >= objetivo) {
      // Se busca hacia atras una linea en blanco para no partir al medio de
      // una funcion. Si no hay ninguna cerca, se corta donde toca.
      let corte = actual.length
      for (let j = actual.length - 1; j > actual.length - 25 && j > 1; j--) {
        if (actual[j].trim() === '') { corte = j; break }
      }
      const resto = actual.slice(corte)
      actual = actual.slice(0, corte)
      cerrar(desde + actual.length - 1)
      desde = nro - resto.length + 1
      actual = resto
    }
  }
  cerrar(lineas.length)

  return bloques.map((b) => {
    // El encabezado va DENTRO del texto embebido, no solo en la metadata: es
    // lo que hace que buscar por nombre de archivo funcione.
    const cabecera = '// ' + rel + ':' + b.desde + '-' + b.hasta
    return {
      id: rel + ':' + b.desde,
      content: cabecera + '\n' + b.texto,
      source: rel,
      lines: b.desde + '-' + b.hasta
    }
  })
}

// El pipeline entero: raiz -> trozos listos para embeber, con los secretos
// afuera. Devuelve tambien lo que descarto, para poder decirlo en vez de
// perderlo en silencio.
export function corpusDe(raiz, opts = {}) {
  const archivos = recolectar(raiz, opts)
  const trozos = []
  const descartados = []

  for (const a of archivos) {
    let contenido
    try {
      contenido = fs.readFileSync(a.ruta, 'utf8')
    } catch {
      continue
    }
    // Un archivo con un secreto adentro no entra NI PARCIALMENTE: si la key
    // esta en la linea 3, el trozo 7 puede seguir siendo inocente, pero
    // adivinar cual es cual es exactamente el tipo de decision que no hay que
    // tomar con credenciales.
    if (pareceSecreto(contenido)) {
      descartados.push({ rel: a.rel, motivo: 'parece contener una credencial' })
      continue
    }
    for (const t of trozar(a.rel, contenido, opts)) trozos.push(t)
  }

  return { trozos, archivos: archivos.length, descartados }
}

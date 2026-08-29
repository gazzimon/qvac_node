// El jail: qué archivos puede tocar un worker y qué herramientas puede llamar.
//
// Se chequea acá y no en el prompt porque el prompt es una sugerencia y esto es
// una condición. El contenido de un archivo del repo o la salida de un test son
// entradas de origen desconocido: pueden traer instrucciones.

import path from 'path'

export const HERRAMIENTAS_PROHIBIDAS = new Set([
  'delete_directory',
  'move_file',
  'chmod',
  'sudo',
  'fetch'
])

export const HERRAMIENTAS_BASE = [
  'read_file',
  'write_file',
  'list_dir',
  'search_files',
  'git_status',
  'git_diff',
  'git_add',
  'git_commit'
]

export class ViolacionDeAlcance extends Error {
  constructor(motivo, detalle) {
    super(`${motivo}: ${detalle}`)
    this.motivo = motivo
  }
}

// Normaliza a la forma del ticket: siempre relativa, siempre con '/'.
export function normalizar(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

// Resuelve la ruta contra el workspace y confirma que no se escapó. Un
// `../../etc/passwd` sale del workspace después de resolverse, no antes: por eso
// se compara la ruta ABSOLUTA y no el string que llegó.
export function resolverEnWorkspace(workspace, filePath) {
  const raiz = path.resolve(workspace)
  const abs = path.resolve(raiz, normalizar(filePath))
  const dentro = abs === raiz || abs.startsWith(raiz + path.sep)
  if (!dentro) {
    throw new ViolacionDeAlcance('fuga del workspace', filePath)
  }
  return abs
}

// La allowlist del ticket es por archivo exacto o por prefijo de directorio.
// `src/db.js` no habilita `src/db.js.bak`, y `src/` sí habilita todo lo de
// adentro: la diferencia la marca la barra.
export function rutaPermitida(filePath, allowedFiles) {
  const objetivo = normalizar(filePath)
  return allowedFiles.some((permitido) => {
    const p = normalizar(permitido)
    if (objetivo === p) return true
    const prefijo = p.endsWith('/') ? p : p + '/'
    return objetivo.startsWith(prefijo)
  })
}

export function validarEscritura(workspace, filePath, allowedFiles) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    throw new ViolacionDeAlcance('ticket sin allowedFiles', filePath)
  }
  const abs = resolverEnWorkspace(workspace, filePath)
  if (!rutaPermitida(filePath, allowedFiles)) {
    throw new ViolacionDeAlcance('ruta fuera del ticket', filePath)
  }
  return abs
}

// La lectura es más ancha que la escritura a propósito: un worker necesita ver
// el resto del repo para escribir código coherente, pero no puede modificarlo.
// El límite de lectura sigue siendo el workspace.
export function validarLectura(workspace, filePath) {
  return resolverEnWorkspace(workspace, filePath)
}

export function validarHerramienta(nombre, allowedTools = HERRAMIENTAS_BASE) {
  if (HERRAMIENTAS_PROHIBIDAS.has(nombre)) {
    throw new ViolacionDeAlcance('herramienta prohibida', nombre)
  }
  if (!allowedTools.includes(nombre)) {
    throw new ViolacionDeAlcance('herramienta fuera de la allowlist', nombre)
  }
  return true
}

// El registro de violaciones es una métrica, no un log de debug: es el número
// que dice cuántas veces una entrada de origen desconocido logró que el agente
// intentara salirse de su alcance.
export class RegistroDeViolaciones {
  constructor() {
    this.entradas = []
  }

  registrar(ticketId, err) {
    this.entradas.push({
      ts: new Date().toISOString(),
      ticketId,
      motivo: err.motivo || 'desconocido',
      detalle: err.message
    })
  }

  total() {
    return this.entradas.length
  }

  porMotivo() {
    const conteo = {}
    for (const e of this.entradas) conteo[e.motivo] = (conteo[e.motivo] || 0) + 1
    return conteo
  }
}

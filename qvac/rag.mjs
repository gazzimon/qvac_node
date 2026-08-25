// El indice vectorial del nodo. Junta el embebedor (embeddings.mjs) con el
// corpus (rag-corpus.mjs) y los guarda en un hypercore.
//
// -----------------------------------------------------------------------------
// POR QUE @qvac/rag Y NO OTRA COSA
//
// Ya estaba instalado y sin estrenar: viene como dependencia de
// @qvac/bare-sdk. Trae RAG + HyperDBAdapter, que guarda el indice IVF sobre un
// Corestore -- el mismo que swarm.mjs ya replica por cada socket.
//
// Eso es lo que hace barata la parte que importa: el indice no es un archivo
// local que hay que exportar y mandar, es un hypercore. Otro nodo lo abre
// read-only con su clave y busca sin haber ingestado nada, por el mismo stream
// multiplexado que ya lleva el directorio y los drives.
//
// -----------------------------------------------------------------------------
// UN SOLO CORESTORE POR PROCESO
//
// corestore.mjs toma un lock de RocksDB: dos Corestore sobre el mismo path y
// el segundo no abre. Este modulo NUNCA abre uno propio -- recibe el que ya
// existe. Quien no tiene uno (el CLI con el nodo apagado) lo abre con
// `openStore` y se lo pasa, y el CLI con el nodo PRENDIDO ni lo intenta: le
// habla por HTTP al gateway, que es el que tiene el lock.
//
// -----------------------------------------------------------------------------
// EL MODELO DE EMBEDDING ES PARTE DEL INDICE
//
// Dos modelos distintos producen vectores que no se pueden comparar: la
// busqueda no falla, devuelve cualquier cosa con un score de aspecto normal.
// Por eso el modelo se guarda con el indice y buscar con otro se RECHAZA en
// vez de degradarse en silencio.
//
// Y ojo con los scores: query y passage se embeben distinto a proposito (ver
// embeddings.mjs), asi que los cosenos absolutos son bajos -- 0.18 a 0.52 en
// las pruebas -- aunque el orden sea correcto. Sirve el ranking, NO un umbral
// fijo. Un `if (score > 0.7)` copiado de otro proyecto deja el indice mudo.
// -----------------------------------------------------------------------------

import { crearEmbedderHttp, verificar } from './embeddings.mjs'
import { corpusDe } from './rag-corpus.mjs'

const DB_NAME = 'pyrus-rag-v1'

let rag = null
let adapter = null
let embedder = null
let meta = null

export function estaAbierto() {
  return rag !== null
}

export function info() {
  if (!rag) return { abierto: false }
  return {
    abierto: true,
    db: DB_NAME,
    model: meta.model,
    dimension: meta.dimension,
    key: meta.key || null
  }
}

// Abre el indice sobre un Corestore YA ABIERTO. No abre uno propio: ver la
// nota de arriba sobre el lock.
export async function abrir(corestore, { embedderOpts = {} } = {}) {
  if (rag) return { rag, adapter, meta }

  const { RAG, HyperDBAdapter } = await import('@qvac/rag')

  embedder = crearEmbedderHttp(embedderOpts)
  // Se verifica ANTES de tocar el disco: fallar por una credencial vencida a
  // la mitad de ingestar 700 trozos deja el indice a medio llenar.
  const chequeo = await verificar(embedder)

  adapter = new HyperDBAdapter({ store: corestore, dbName: DB_NAME })

  rag = new RAG({
    // La funcion atada a `passage`: es la que usa ingest(). Las consultas van
    // por otro camino (ver buscar) justamente para no compartir un modo
    // mutable entre dos operaciones concurrentes.
    embeddingFunction: (t) => embedder.paraDocumentos(t),
    dbAdapter: adapter
  })
  await rag.ready()

  let key = null
  try {
    key = adapter.core && adapter.core.key ? adapter.core.key.toString('hex') : null
  } catch {
    // Sin clave el indice sigue sirviendo local; lo unico que se pierde es
    // poder ofrecerselo a un par.
  }

  meta = { model: chequeo.model, dimension: chequeo.dimension, key }
  return { rag, adapter, meta }
}

export async function cerrar() {
  if (rag) await rag.close().catch(() => {})
  rag = null
  adapter = null
  embedder = null
  meta = null
}

// Ingesta un directorio entero. Devuelve el resumen, incluido lo que NO entro:
// un archivo descartado por parecer una credencial tiene que decirse, no
// desaparecer.
export async function ingestar(raiz, { onProgress = null } = {}) {
  if (!rag) throw new Error('el indice no esta abierto')

  const { trozos, archivos, descartados } = corpusDe(raiz)
  if (trozos.length === 0) {
    return { archivos, trozos: 0, guardados: 0, descartados, model: meta.model }
  }

  // Se embebe y se guarda en tandas: una sola llamada con 700 trozos arma un
  // body enorme y, si falla, no queda nada.
  const TANDA = 32
  let guardados = 0

  for (let i = 0; i < trozos.length; i += TANDA) {
    const tanda = trozos.slice(i, i + TANDA)
    const vectores = await embedder.paraDocumentos(tanda.map((t) => t.content))

    const docs = tanda.map((t, j) => ({
      id: t.id,
      content: t.content,
      embedding: vectores[j],
      embeddingModelId: meta.model,
      metadata: { source: t.source, lines: t.lines }
    }))

    const res = await rag.saveEmbeddings(docs)
    for (const r of res) if (r.status === 'fulfilled') guardados++

    if (onProgress) onProgress(Math.min(i + TANDA, trozos.length), trozos.length)
  }

  return { archivos, trozos: trozos.length, guardados, descartados, model: meta.model }
}

// Busca. NO usa rag.search(): esa embebe la consulta con la misma funcion que
// los documentos, y este modelo distingue query de passage. Se embebe a mano
// con el modo correcto y se le pasa el vector al adapter.
export async function buscar(consulta, { topK = 5 } = {}) {
  if (!rag) throw new Error('el indice no esta abierto')
  if (typeof consulta !== 'string' || consulta.trim() === '') {
    throw new Error('la consulta tiene que ser un texto no vacio')
  }

  // Si el indice se construyo con otro modelo, los vectores no son
  // comparables. Se corta con un motivo en vez de devolver ruido con cara de
  // resultado.
  const guardado = await adapter.getConfig().catch(() => null)
  if (guardado && guardado.embeddingModelId && guardado.embeddingModelId !== meta.model) {
    throw new Error(
      'el indice se construyo con "' + guardado.embeddingModelId + '" y ahora se busca con "' +
      meta.model + '": hay que reindexar antes de poder buscar'
    )
  }

  const vector = await embedder.paraConsultas(consulta)
  const crudos = await adapter.search(consulta, vector, { topK })

  return crudos.map((r) => {
    // La cabecera `// archivo:desde-hasta` que puso el chunker: se devuelve
    // parseada para que el que consume no tenga que volver a leerla, pero se
    // deja en el contenido porque es parte de lo que se embebio.
    const m = /^\/\/ (\S+):(\d+-\d+)\n/.exec(r.content || '')
    return {
      id: r.id,
      score: r.score,
      source: m ? m[1] : null,
      lines: m ? m[2] : null,
      content: r.content
    }
  })
}

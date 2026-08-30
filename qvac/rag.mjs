// The node's vector index. Combines the embedder (embeddings.mjs) with the
// corpus (rag-corpus.mjs) and stores them in a hypercore.
//
// -----------------------------------------------------------------------------
// WHY @qvac/rag AND NOT SOMETHING ELSE
//
// It was already installed and unused: it comes as a dependency of
// @qvac/bare-sdk. It brings RAG + HyperDBAdapter, which stores the IVF index
// on a Corestore -- the same one swarm.mjs already replicates per socket.
//
// That's what makes the part that matters cheap: the index isn't a local
// file you have to export and send, it's a hypercore. Another node opens it
// read-only with its key and searches without having ingested anything,
// over the same multiplexed stream that already carries the directory and
// the drives.
//
// -----------------------------------------------------------------------------
// ONE SINGLE CORESTORE PER PROCESS
//
// corestore.mjs takes a RocksDB lock: two Corestores on the same path and
// the second one doesn't open. This module NEVER opens its own -- it
// receives the one that already exists. Whoever doesn't have one (the CLI
// with the node off) opens it with `openStore` and passes it in, and the CLI
// with the node ON doesn't even try: it talks HTTP to the gateway, which is
// the one holding the lock.
//
// -----------------------------------------------------------------------------
// THE EMBEDDING MODEL IS PART OF THE INDEX
//
// Two different models produce vectors that can't be compared: the search
// doesn't fail, it returns anything with a normal-looking score. That's why
// the model gets saved with the index and searching with a different one is
// REJECTED instead of silently degrading.
//
// And watch out for the scores: query and passage are embedded differently
// on purpose (see embeddings.mjs), so the absolute cosines are low -- 0.18
// to 0.52 in testing -- even when the ordering is correct. What matters is
// the ranking, NOT a fixed threshold. An `if (score > 0.7)` copied from
// another project leaves the index mute.
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

// Opens the index on an ALREADY-OPEN Corestore. Doesn't open its own: see
// the note above about the lock.
export async function abrir(corestore, { embedderOpts = {} } = {}) {
  if (rag) return { rag, adapter, meta }

  const { RAG, HyperDBAdapter } = await import('@qvac/rag')

  embedder = crearEmbedderHttp(embedderOpts)
  // Verified BEFORE touching the disk: failing on an expired credential
  // halfway through ingesting 700 chunks leaves the index half-filled.
  const chequeo = await verificar(embedder)

  adapter = new HyperDBAdapter({ store: corestore, dbName: DB_NAME })

  rag = new RAG({
    // The function bound to `passage`: it's the one ingest() uses. Queries
    // go through a different path (see buscar) specifically so as not to
    // share a mutable mode between two concurrent operations.
    embeddingFunction: (t) => embedder.paraDocumentos(t),
    dbAdapter: adapter
  })
  await rag.ready()

  let key = null
  try {
    key = adapter.core && adapter.core.key ? adapter.core.key.toString('hex') : null
  } catch {
    // Without a key the index still serves locally; the only thing lost is
    // being able to offer it to a peer.
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

// Ingests an entire directory. Returns the summary, including what did NOT
// get in: a file discarded for looking like a credential has to be reported,
// not disappeared.
export async function ingestar(raiz, { onProgress = null } = {}) {
  if (!rag) throw new Error('the index is not open')

  const { trozos, archivos, descartados } = corpusDe(raiz)
  if (trozos.length === 0) {
    return { archivos, trozos: 0, guardados: 0, descartados, model: meta.model }
  }

  // Embedded and saved in batches: a single call with 700 chunks builds a
  // huge body and, if it fails, nothing is left.
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

// Searches. Does NOT use rag.search(): that embeds the query with the same
// function as the documents, and this model distinguishes query from
// passage. It's embedded by hand with the right mode and the vector is
// passed to the adapter.
export async function buscar(consulta, { topK = 5 } = {}) {
  if (!rag) throw new Error('the index is not open')
  if (typeof consulta !== 'string' || consulta.trim() === '') {
    throw new Error('the query must be non-empty text')
  }

  // If the index was built with a different model, the vectors aren't
  // comparable. It bails out with a reason instead of returning noise that
  // looks like a result.
  const guardado = await adapter.getConfig().catch(() => null)
  if (guardado && guardado.embeddingModelId && guardado.embeddingModelId !== meta.model) {
    throw new Error(
      'the index was built with "' + guardado.embeddingModelId + '" and is now being searched with "' +
      meta.model + '": you need to reindex before you can search'
    )
  }

  const vector = await embedder.paraConsultas(consulta)
  const crudos = await adapter.search(consulta, vector, { topK })

  return crudos.map((r) => {
    // The `// file:from-to` header the chunker put there: it's returned
    // parsed so the consumer doesn't have to read it again, but it's left in
    // the content because it's part of what got embedded.
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

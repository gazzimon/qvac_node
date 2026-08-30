// From a directory to embeddable chunks. The "knows about files" half of RAG.
//
// Doesn't touch the network or the index: a path goes in, objects
// { id, content, source, lines } come out. That's why it can be tested
// without an API key and without hypercore.
//
// -----------------------------------------------------------------------------
// EVERY CHUNK SAYS WHERE IT CAME FROM
//
// @qvac/rag's default chunker splits by paragraph, which is fine for prose
// and bad for code: it splits a function in half and the agent retrieves a
// fragment it can't cite.
//
// Here every chunk has a `// file:from-to` line stuck on top. That does two
// things: it gives the agent a clickable `file:line`, and it puts the file
// name INSIDE the text that gets embedded, so "what does provider.mjs do"
// retrieves provider.mjs even if the body never mentions its own name
// anywhere.
//
// -----------------------------------------------------------------------------
// NO SECRET GOES INTO THE INDEX
//
// The index lives in a hypercore the swarm replicates. A secret that gets in
// here doesn't stay on this machine: it gets served to any peer that
// requests the index, and deleting it from your own disk doesn't delete it
// from the peers that already copied it.
//
// The extension allowlist already keeps out .env, but that protects against
// the expected file, not against a secret pasted into a README or a comment.
// That's why every chunk is ALSO checked against known credential patterns
// and discarded entirely if it matches. Over-discarding is cheap; a key
// replicated over P2P can't be undone.
// -----------------------------------------------------------------------------

import fs from 'bare-fs'
import path from 'bare-path'

// Only what we know how to read. It's an allowlist and not a denylist on
// purpose: a new format nobody thought of counts as "not indexed", not as
// "indexed, let's see what happens".
export const EXTENSIONES = ['.mjs', '.js', '.json', '.md', '.sh', '.ps1', '.txt', '.yml', '.yaml']

// Directories that never get walked.
export const EXCLUIR_DIR = [
  'node_modules', '.git', 'build', 'out', 'data', 'deck', 'brand', 'landing',
  '.playwright-mcp', 'old', 'logs', 'dist', 'coverage', '.claude'
]

// Files that never get read, even if the extension passes.
export const EXCLUIR_ARCHIVO = [
  '.env', '.env.local', '.env.production', 'package-lock.json',
  'identity.json', 'consent.json', 'upstreams.json'
]

// Credential patterns. Not meant to be exhaustive -- they're the ones this
// project has nearby -- but every one that gets added is a leak vector that
// stops existing.
const SECRETOS = [
  /nvapi-[A-Za-z0-9_\-]{20,}/,          // NVIDIA NIM
  /sk-[A-Za-z0-9]{32,}/,                 // OpenAI
  /sk-ant-[A-Za-z0-9_\-]{20,}/,          // Anthropic
  /qvac_sk_[A-Za-z0-9_\-]{20,}/,         // this gateway's own keys
  /gh[pousr]_[A-Za-z0-9]{30,}/,          // GitHub
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // private keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/         // Slack
]

export function pareceSecreto(texto) {
  for (const re of SECRETOS) if (re.test(texto)) return true
  return false
}

// Target size of a chunk, in characters. Not tokens: counting those requires
// the model's tokenizer, which we don't have on the remote side. Aimed low
// so the chunk fits comfortably in any window.
const OBJETIVO_CHARS = 1400
const MINIMO_CHARS = 80

function esDirectorioExcluido(nombre) {
  return EXCLUIR_DIR.indexOf(nombre) !== -1 || nombre.startsWith('.')
}

// Walks a root and returns the indexable files, with their relative path.
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
      // A huge file is almost always generated (a bundle, a dump) and
      // embedding it burns quota without adding signal.
      if (st.size > maxBytes) continue
      out.push({ ruta: completo, rel: path.relative(raiz, completo).split('\\').join('/'), bytes: st.size })
    }
  }

  caminar(raiz)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

// Splits a file into chunks that respect the text's natural boundaries.
//
// For markdown: headings. For code: blocks separated by blank lines, which
// in this repo line up with top-level declarations and -- more importantly
// -- with the long comments that explain WHY, which is exactly what an agent
// wants to retrieve.
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

    // A markdown heading opens a new chunk even if the previous one is
    // short: the section is the document's unit of meaning.
    const corteFuerte = esMarkdown && /^#{1,4}\s/.test(linea) && actual.length > 0
    if (corteFuerte) {
      cerrar(nro - 1)
      desde = nro
    }

    actual.push(linea)

    const largo = actual.join('\n').length
    if (largo >= objetivo) {
      // Looks backward for a blank line to avoid splitting a function in
      // half. If there's none nearby, it cuts wherever it lands.
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
    // The heading goes INSIDE the embedded text, not just in the metadata:
    // that's what makes searching by file name work.
    const cabecera = '// ' + rel + ':' + b.desde + '-' + b.hasta
    return {
      id: rel + ':' + b.desde,
      content: cabecera + '\n' + b.texto,
      source: rel,
      lines: b.desde + '-' + b.hasta
    }
  })
}

// The whole pipeline: root -> chunks ready to embed, with secrets kept out.
// Also returns what it discarded, so it can be reported instead of getting
// silently lost.
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
    // A file with a secret inside doesn't get in AT ALL, not even partially:
    // if the key is on line 3, chunk 7 might still be innocent, but guessing
    // which is which is exactly the kind of call you shouldn't make with
    // credentials.
    if (pareceSecreto(contenido)) {
      descartados.push({ rel: a.rel, motivo: 'appears to contain a credential' })
      continue
    }
    for (const t of trozar(a.rel, contenido, opts)) trozos.push(t)
  }

  return { trozos, archivos: archivos.length, descartados }
}

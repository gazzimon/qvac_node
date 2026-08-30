// A `.env` for the node, no dependencies.
//
// WHY IT EXISTS
//
// The upstreams config stores the NAME of an environment variable, never the
// secret (see upstream.mjs). That keeps the secret out of the repo and out of
// the signed manifest, which is what was wanted -- but it leaves the operator
// with the problem of putting it in the environment, and on Windows that
// means remembering a `$env:X = "..."` in every new terminal. The real
// consequence is a node that boots with the upstream DISABLED and a person
// who doesn't understand why.
//
// `bare-env` is a thin proxy over the OS environment (`os.getEnv`): it
// doesn't read any file. So this is needed.
//
// WHAT IT DOESN'T DO
//
// It doesn't override a variable that's ALREADY in the environment. A `.env`
// is the project's default, not an order: whoever exports something by hand
// in their terminal -- or in a CI, or in a systemd unit -- is saying
// something more specific, and that wins.
//
// And it never prints values. Names, yes, because those are exactly what the
// operator needs to see to understand what got loaded.

import env from 'bare-env'

// Text of the file goes in, `{ NAME: value }` comes out. Pure and with no
// side effects, so the parser can be tested without writing a file anywhere.
//
// Tolerates what people actually write:
//
//   - `export FOO=bar`, which is what you get from copying a line out of the
//     docs;
//   - `FOO = bar`, with spaces around the `=` (that's how the .env that
//     prompted all this was written, and a strict parser would have created
//     a variable named "FOO " that matches nothing anyone looks up);
//   - quotes around the value, single or double;
//   - comments with `#`, and blank lines.
//
// What it does NOT tolerate: multiline values. A credential doesn't need them
// and supporting them forces a stateful parser that then has to be maintained.
export function parsear(texto) {
  const out = {}
  for (const cruda of String(texto || '').split(/\r?\n/)) {
    const linea = cruda.trim()
    if (linea === '' || linea.startsWith('#')) continue

    const corte = linea.indexOf('=')
    if (corte === -1) continue

    let nombre = linea.slice(0, corte).trim()
    if (nombre.startsWith('export ')) nombre = nombre.slice(7).trim()
    if (nombre === '') continue

    let valor = linea.slice(corte + 1).trim()
    // Quotes delimit, they aren't part of the value. Only if they open AND
    // close: a single quote is part of the credential, however odd that is.
    const comilla = valor[0]
    if ((comilla === '"' || comilla === "'") && valor.length > 1 && valor.endsWith(comilla)) {
      valor = valor.slice(1, -1)
    }

    out[nombre] = valor
  }
  return out
}

// Loads `<dir>/.env` into the process environment. Returns the NAMES of what
// it actually loaded -- not the values -- so startup can report it.
//
// The file not existing is the normal case and isn't reported: most nodes
// don't talk to any external API. A file that exists but can't be read IS
// reported, because that means someone meant to configure something.
export async function cargar(dir) {
  let crudo = null
  try {
    const fs = await import('bare-fs')
    const path = await import('bare-path')
    crudo = fs.default.readFileSync(path.default.join(dir, '.env'), 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`  [env] could not read .env: ${err.message || err}`)
    }
    return { cargadas: [], yaEstaban: [] }
  }

  const cargadas = []
  const yaEstaban = []
  for (const [nombre, valor] of Object.entries(parsear(crudo))) {
    // The real environment wins. See the note in the header.
    if (env[nombre] !== undefined && env[nombre] !== '') {
      yaEstaban.push(nombre)
      continue
    }
    env[nombre] = valor
    cargadas.push(nombre)
  }
  return { cargadas, yaEstaban }
}

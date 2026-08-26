// Un `.env` para el nodo, sin dependencias.
//
// POR QUE EXISTE
//
// La config de upstreams guarda el NOMBRE de una variable de entorno, nunca el
// secreto (ver upstream.mjs). Eso deja el secreto afuera del repo y afuera del
// manifiesto firmado, que es lo que se queria -- pero deja al operador con el
// problema de ponerla en el entorno, y en Windows eso significa acordarse de un
// `$env:X = "..."` en cada terminal nueva. La consecuencia real es un nodo que
// arranca con el upstream DESACTIVADO y una persona que no entiende por que.
//
// `bare-env` es un proxy fino sobre el entorno del sistema operativo
// (`os.getEnv`): no lee ningun archivo. Asi que hace falta esto.
//
// LO QUE NO HACE
//
// No pisa una variable que YA este en el entorno. Un `.env` es el default del
// proyecto, no una orden: quien exporta algo a mano en su terminal -- o en un
// CI, o en un systemd unit -- esta diciendo algo mas especifico, y eso gana.
//
// Y no imprime valores nunca. Los nombres si, porque son justamente lo que el
// operador necesita ver para entender que cargo.

import env from 'bare-env'

// Entra el texto del archivo, sale { NOMBRE: valor }. Puro y sin efectos, para
// poder probar el parser sin escribir un archivo en ningun lado.
//
// Tolera lo que la gente escribe de verdad:
//
//   - `export FOO=bar`, que es lo que sale de copiar una linea de la doc;
//   - `FOO = bar`, con espacios alrededor del `=` (asi estaba escrito el .env
//     que motivo todo esto, y un parser estricto habria creado una variable
//     llamada "FOO " que no coincide con ninguna que se busque);
//   - comillas alrededor del valor, simples o dobles;
//   - comentarios con `#`, y lineas vacias.
//
// Lo que NO tolera: valores multilinea. Una credencial no los necesita y
// soportarlos obliga a un parser con estados que despues hay que mantener.
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
    // Las comillas delimitan, no forman parte del valor. Solo si abren Y
    // cierran: una sola comilla es parte de la credencial, por raro que sea.
    const comilla = valor[0]
    if ((comilla === '"' || comilla === "'") && valor.length > 1 && valor.endsWith(comilla)) {
      valor = valor.slice(1, -1)
    }

    out[nombre] = valor
  }
  return out
}

// Carga `<dir>/.env` al entorno del proceso. Devuelve los NOMBRES de lo que
// efectivamente cargo -- no los valores -- para que el arranque pueda decirlo.
//
// Que el archivo no exista es el caso normal y no se avisa: la mayoria de los
// nodos no habla con ninguna API externa. Un archivo que existe pero no se
// puede leer si se avisa, porque ahi alguien quiso configurar algo.
export async function cargar(dir) {
  let crudo = null
  try {
    const fs = await import('bare-fs')
    const path = await import('bare-path')
    crudo = fs.default.readFileSync(path.default.join(dir, '.env'), 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`  [env] no se pudo leer .env: ${err.message || err}`)
    }
    return { cargadas: [], yaEstaban: [] }
  }

  const cargadas = []
  const yaEstaban = []
  for (const [nombre, valor] of Object.entries(parsear(crudo))) {
    // El entorno real gana. Ver la nota del encabezado.
    if (env[nombre] !== undefined && env[nombre] !== '') {
      yaEstaban.push(nombre)
      continue
    }
    env[nombre] = valor
    cargadas.push(nombre)
  }
  return { cargadas, yaEstaban }
}

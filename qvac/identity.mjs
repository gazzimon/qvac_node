// Identidad persistente del nodo: el par de claves Ed25519 con el que firma su
// manifiesto y con el que se presenta en el swarm (son el mismo, ver la nota de
// verifyManifest en manifest.mjs).
//
// Se persiste porque una clave nueva en cada arranque significa que el nodo es
// un desconocido distinto cada vez: nadie puede reconocerlo entre sesiones y la
// palabra "verificable" del pitch se queda sin sujeto. Lo que se verifica es
// que ESTE nodo, el de siempre, firmo lo que dice.

import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'

// Se guarda la SEMILLA de 32 bytes, no el par entero: el par se deriva de ella
// y guardar la privada completa es guardar el doble de material sensible para
// nada.
export function loadOrCreateIdentity(dir) {
  const file = path.join(dir, 'identity.json')

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof raw.seed === 'string' && raw.seed.length === 64) {
      return { ...crypto.keyPair(Buffer.from(raw.seed, 'hex')), file, created: false }
    }
    // El archivo existe pero no sirve. Se avisa y se genera uno nuevo en vez de
    // morir: un nodo sin identidad legible igual puede laburar, y tirar el
    // proceso por esto dejaria la demo muerta sin motivo.
    console.error(`[identity] ${file} ilegible, se genera una identidad nueva`)
  } catch {
    // No existe todavia: primer arranque.
  }

  const seed = crypto.randomBytes(32)
  const keyPair = crypto.keyPair(seed)

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ seed: seed.toString('hex') }, null, 2))
  } catch (err) {
    // Si no se puede escribir, el nodo sigue con una identidad efimera. Se dice
    // en voz alta: cambia el significado de lo que se verifica.
    console.error(`[identity] no se pudo guardar la identidad: ${(err && err.message) || err}`)
    console.error('[identity] el nodo corre con una clave EFIMERA (cambia al reiniciar)')
    return { ...keyPair, file: null, created: true }
  }

  return { ...keyPair, file, created: true }
}

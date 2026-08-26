// El stack de x402, cargado de la única forma en que funciona bajo Bare.
// Fase 9 del ROADMAP_FASE7-X402 (D8, D9, D10, D14, D15).
//
// -----------------------------------------------------------------------------
// POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO ES UN `import` SUELTO
//
// `@x402/evm` NO IMPORTA BAJO BARE POR SU CUENTA. La cadena es:
//
//     @x402/evm  ->  @noble/hashes/crypto
//
// y `@noble/hashes` exporta ese subpath CONDICIONALMENTE:
//
//     "./crypto": { "node": { "import": "./esm/cryptoNode.js" }, ... }
//
// Bare matchea la condición `node`, cae en `cryptoNode.js`, y ese archivo
// importa `node:crypto`, que bajo Bare no existe. Es R1 otra vez, escondido dos
// niveles abajo en el árbol de dependencias.
//
// Con `@tetherto/wdk-wallet-evm` importado ANTES, funciona. Y alcanza con
// importarlo: no hace falta derivar ninguna cuenta ni abrir ninguna wallet.
//
// **EL MECANISMO EXACTO NO ESTÁ DIAGNOSTICADO.** Se sabe QUÉ pasa, no POR QUÉ.
// Eso es incómodo en el camino que maneja pagos, así que en vez de dejarlo como
// un `import` de arriba de archivo que alguien va a reordenar en un refactor de
// imports —y la falla aparecería tres saltos más allá, como un MODULE_NOT_FOUND
// que no dice nada de x402—, vive acá, con el porqué al lado y con dos cosas
// que lo vigilan:
//
//   - el paso 5 de `scripts/spike-d11-wdk-bare.mjs`, que mide si `@x402/evm`
//     importa AISLADO lanzando un proceso bare limpio (hoy falla, y está bien
//     que falle: falla el spike, no la fase);
//   - un test de la suite que carga ESTE módulo en un proceso limpio.
//
// El día que `@noble/hashes` o Bare cambien, uno de los dos se rompe y dice
// exactamente qué se rompió.
//
// -----------------------------------------------------------------------------
// D15 — LAS CADENAS, Y LA QUE X402 NO CONOCE
//
// D15 decidió Plasma (`eip155:9745`) como default y Stable (`eip155:988`) como
// fallback. Pero `@x402/evm` sólo trae Stable de fábrica:
//
//     getDefaultAsset('eip155:988')   -> USDT0, 6 decimales
//     getDefaultAsset('eip155:9745')  -> throw: "No default asset configured"
//
// Así que el activo de Plasma hay que declararlo nosotros, y ese es exactamente
// el tipo de dato que no se inventa: es la dirección de un contrato a la que se
// le va a mandar plata real. Ver `ACTIVOS` abajo.

import env from 'bare-env'

// -----------------------------------------------------------------------------
// Las cadenas
// -----------------------------------------------------------------------------

// CAIP-2 de cada red que este nodo puede aceptar, en el orden de preferencia de
// D15. Los nombres cortos son los que viajan en `economic.chains` del
// manifiesto (kebab-case, ver wallet.mjs).
export const CAIP2 = {
  plasma: 'eip155:9745',
  stable: 'eip155:988'
}

// El activo con el que se cobra en cada red.
//
// El de Stable NO se escribe acá: se le pide a `@x402/evm`, que lo trae de
// fábrica. Duplicar una dirección de contrato que el paquete ya conoce es
// crear una segunda fuente de verdad para un dato que, si se desincroniza,
// manda plata a otro lado.
//
// El de Plasma sí hay que declararlo, porque x402 no lo tiene. Y acá está el
// límite honesto: la dirección de abajo es la que usó el spike de D11
// (`scripts/spike-d11-wdk-bare.mjs`, dominio EIP-712 de la firma), y **no está
// verificada contra la cadena**. Por eso `activoDe()` no la devuelve sin más:
// exige que el operador confirme, porque el modo de falla es mandar USD₮ a un
// contrato equivocado y eso no tiene vuelta atrás.
const PLASMA_USDT0_SIN_VERIFICAR = {
  asset: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
  name: 'USDT0',
  version: '1',
  decimals: 6,
  symbol: 'USDT0'
}

// La variable con la que el operador declara que verificó la dirección de
// Plasma contra el explorer. Sin esto, Plasma queda fuera y se cobra en Stable.
export const VAR_PLASMA_OK = 'PYRUS_X402_PLASMA_ASSET_VERIFICADO'

// -----------------------------------------------------------------------------
// La carga
// -----------------------------------------------------------------------------

let cache = null

// Carga el stack, en orden. Devuelve `{ core, evm }`.
//
// Es async y con cache: el import de WDK cuesta, y esto lo llama el camino de
// un request. La segunda vez sale de memoria.
export async function cargar() {
  if (cache) return cache

  // ESTE IMPORT NO SE MUEVE Y NO SE BORRA. Ver el encabezado: sin él, el de
  // abajo tira MODULE_NOT_FOUND sobre `node:crypto` y el error no menciona
  // x402 por ningún lado.
  await import('@tetherto/wdk-wallet-evm')

  const core = await import('@x402/core')
  const evm = await import('@x402/evm')

  cache = { core, evm }
  return cache
}

// El activo con el que se cobra en `red` ('plasma' | 'stable'), o null si esa
// red no se puede usar todavía.
//
// Devolver null en vez de tirar es deliberado: que Plasma no esté disponible
// no es un error del programa, es una configuración incompleta, y el llamador
// tiene que poder caer a Stable —que es exactamente lo que D15 llama fallback—
// en vez de quedarse sin cobrar.
export async function activoDe(red) {
  const { evm } = await cargar()
  const id = CAIP2[red]
  if (!id) return null

  if (red === 'plasma') {
    // Sin la confirmación explícita del operador, Plasma no se usa. El default
    // es no cobrar en una red cuya dirección de contrato no verificó nadie.
    if (env[VAR_PLASMA_OK] !== '1') return null
    return { network: id, ...PLASMA_USDT0_SIN_VERIFICAR }
  }

  try {
    return { network: id, ...evm.getDefaultAsset(id) }
  } catch {
    return null
  }
}

// Las redes que este nodo puede aceptar HOY, en orden de preferencia. Puede ser
// más corta que `wallet.CHAINS`: el manifiesto declara en qué redes el nodo
// quiere cobrar, esto dice en cuáles efectivamente puede.
export async function redesDisponibles() {
  const out = []
  for (const red of ['plasma', 'stable']) {
    if (await activoDe(red)) out.push(red)
  }
  return out
}

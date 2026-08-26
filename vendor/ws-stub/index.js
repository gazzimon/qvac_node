// Stub de `ws`.
//
// Lo declara viem para su transporte WebSocket, a traves de `isows`, que hace
// `import * as WebSocket_ from 'ws'` y lee `.WebSocket`. Este proyecto usa el
// transporte HTTP y nunca lo instancia -- pero `bare-pack` recorre el grafo
// ESTATICO, no el que se ejecuta, asi que igual lo sigue y se cae:
// `ws/lib/stream.js` importa `stream`, que bajo Bare no existe (es
// `bare-stream`).
//
// El stub tiene que ser ESM con exports NOMBRADOS: con `module.exports = X` de
// CommonJS, Bare no expone `WebSocket` como named export y el binario arranca
// con "The requested module 'ws' does not provide an export named 'WebSocket'".
//
// Si alguien intenta usarlo de verdad, falla ACA y con un mensaje que dice por
// que, en vez de con un MODULE_NOT_FOUND tres saltos mas alla.

function noDisponible() {
  throw new Error(
    'ws no esta disponible en este build: el transporte WebSocket de viem no ' +
      'se empaqueta bajo Bare. Usa el transporte HTTP. Ver vendor/ws-stub/'
  )
}

export class WebSocket {
  constructor() {
    noDisponible()
  }
}

export class WebSocketServer {
  constructor() {
    noDisponible()
  }
}

export const Server = WebSocketServer
export const Receiver = noDisponible
export const Sender = noDisponible
export const createWebSocketStream = noDisponible

export default WebSocket

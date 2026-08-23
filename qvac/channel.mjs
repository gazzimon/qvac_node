// El canal de control del protocolo QVAC, sobre Protomux.
//
// Reemplaza al FramedStream que envolvia el socket crudo. El motivo no es
// estetico: FramedStream se ADUEÑA del stream, y `corestore.replicate(socket)`
// necesita ese mismo stream para multiplexar la replicacion de hypercores.
// Con FramedStream, las dos cosas no entran en la misma conexion y habria que
// abrir una segunda -- que es exactamente lo que D1 del ROADMAP decidio no
// hacer.
//
// Protomux multiplexa canales por (protocolo, id) sobre un solo stream. Este
// modulo abre el canal `qvac/node/v0`, que transporta los MISMOS mensajes JSON
// que antes iban por FramedStream: la tabla de D1 no cambia, cambia el framing.
//
// ORDEN DE APERTURA -- importa y es sutil:
//
//   Protomux.from(socket) devuelve `socket.userData` si ya hay un mux ahi, y
//   si no crea uno NUEVO sin guardarlo. `corestore.replicate(socket)` hace lo
//   mismo por su lado (via Hypercore.createProtocolStream, que si lo guarda en
//   userData). Si el canal de control se abre sin dejar el mux en userData,
//   corestore crea un SEGUNDO mux sobre el mismo socket y los dos escriben
//   frames intercalados en el mismo stream: la conexion se rompe de una forma
//   ilegible desde afuera.
//
//   Por eso `attachMux` guarda el mux en userData antes que nada, y tanto el
//   canal como la replicacion salen de ahi.
//
// TAMAÑO MAXIMO DE FRAME: el cap de 16 MiB que daba `bits: 24` en FramedStream
// no se pierde. NoiseSecretStream (el socket de Hyperswarm) frena en
// MAX_ATOMIC_WRITE = 0xffffff, que son los mismos 16 MiB, y lo hace una capa
// mas abajo -- antes de que Protomux llegue a reservar nada.

import Protomux from 'protomux'
import c from 'compact-encoding'

export const PROTOCOL = 'qvac/node/v0'

// Deja el mux en `socket.userData` y lo devuelve. Todo lo que quiera hablar
// sobre este socket -- el canal de control, la replicacion del corestore --
// tiene que pasar por aca primero.
export function attachMux(socket) {
  const mux = Protomux.from(socket)
  if (!socket.userData) socket.userData = mux
  return mux
}

// Abre el canal de control. Devuelve `null` si ya habia uno sobre este socket
// (protomux no permite dos canales con el mismo protocolo e id), que es un
// error de programa, no de red: quien llama tiene que tratarlo como tal.
export function openChannel(socket, { onmessage = () => {}, onclose = () => {} } = {}) {
  const mux = attachMux(socket)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onclose
  })

  if (channel === null) return null

  // UN solo tipo de mensaje que lleva el objeto JSON entero, en vez de un
  // mensaje de protomux por cada `type` del protocolo. Es deliberado: los
  // mensajes de un canal se aparean POR ORDEN DE REGISTRO entre las dos
  // puntas, asi que una tabla de mensajes tipados obliga a que las dos
  // versiones del nodo registren exactamente los mismos, en el mismo orden.
  // Con el OTA corriendo, dos nodos en versiones distintas es el caso NORMAL,
  // no el raro. Un solo mensaje JSON hace que agregar un `type` nuevo sea
  // compatible hacia atras: el nodo viejo lo ignora en `_dispatch` y sigue.
  const message = channel.addMessage({
    encoding: c.json,
    onmessage
  })

  channel.open()

  return {
    channel,
    send(msg) {
      // El canal puede haberse cerrado entre el check del que llama y este
      // write. Igual que el `try` del `_send` viejo: el 'close' del socket ya
      // limpia, aca no hay nada que hacer.
      try {
        message.send(msg)
      } catch {}
    },
    close() {
      try {
        channel.close()
      } catch {}
    }
  }
}

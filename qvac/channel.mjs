// The QVAC protocol's control channel, over Protomux.
//
// Replaces the FramedStream that used to wrap the raw socket. The reason
// isn't aesthetic: FramedStream TAKES OWNERSHIP of the stream, and
// `corestore.replicate(socket)` needs that same stream to multiplex hypercore
// replication. With FramedStream, the two things don't fit on the same
// connection and a second one would have to be opened -- which is exactly
// what D1 of the ROADMAP decided not to do.
//
// Protomux multiplexes channels by (protocol, id) over a single stream. This
// module opens the `qvac/node/v0` channel, which carries the SAME JSON
// messages that used to go over FramedStream: D1's table doesn't change, the
// framing does.
//
// OPENING ORDER -- matters and is subtle:
//
//   Protomux.from(socket) returns `socket.userData` if there's already a mux
//   there, and if not creates a NEW one without saving it. `corestore.replicate(socket)`
//   does the same thing on its side (via Hypercore.createProtocolStream, which
//   DOES save it in userData). If the control channel is opened without
//   leaving the mux in userData, corestore creates a SECOND mux on the same
//   socket and both write interleaved frames on the same stream: the
//   connection breaks in a way that's unreadable from the outside.
//
//   That's why `attachMux` saves the mux in userData before anything else,
//   and both the channel and the replication come from there.
//
// MAXIMUM FRAME SIZE: the 16 MiB cap that `bits: 24` used to give in
// FramedStream isn't lost. NoiseSecretStream (Hyperswarm's socket) caps at
// MAX_ATOMIC_WRITE = 0xffffff, which is the same 16 MiB, and does it a layer
// below -- before Protomux even gets to reserve anything.

import Protomux from 'protomux'
import c from 'compact-encoding'

export const PROTOCOL = 'qvac/node/v0'

// Leaves the mux in `socket.userData` and returns it. Anything that wants to
// talk over this socket -- the control channel, the corestore replication --
// has to go through here first.
export function attachMux(socket) {
  const mux = Protomux.from(socket)
  if (!socket.userData) socket.userData = mux
  return mux
}

// Opens the control channel. Returns `null` if there was already one on this
// socket (protomux doesn't allow two channels with the same protocol and id),
// which is a program error, not a network one: the caller has to treat it as
// such.
export function openChannel(socket, { onmessage = () => {}, onclose = () => {} } = {}) {
  const mux = attachMux(socket)

  const channel = mux.createChannel({
    protocol: PROTOCOL,
    onclose
  })

  if (channel === null) return null

  // A SINGLE message type carrying the whole JSON object, instead of one
  // protomux message per protocol `type`. This is deliberate: a channel's
  // messages get paired up BY REGISTRATION ORDER between the two ends, so a
  // table of typed messages would force both node versions to register
  // exactly the same ones, in the same order. With OTA running, two nodes on
  // different versions is the NORMAL case, not the rare one. A single JSON
  // message makes adding a new `type` backward compatible: the old node
  // ignores it in `_dispatch` and keeps going.
  const message = channel.addMessage({
    encoding: c.json,
    onmessage
  })

  channel.open()

  return {
    channel,
    send(msg) {
      // The channel may have closed between the caller's check and this
      // write. Same as the old `_send`'s `try`: the socket's 'close' already
      // cleans up, there's nothing to do here.
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

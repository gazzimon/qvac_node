const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')
const ReadyResource = require('ready-resource')

module.exports = class App extends ReadyResource {
  constructor({ dir, app, updates, updateDelay, version, upgrade, name }) {
    super()

    this.dir = dir
    this.app = app
    this.updates = updates
    this.updateDelay = updateDelay
    this.version = version
    this.upgrade = upgrade
    this.name = name

    this.IPC = null
    this.pipe = null
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('./workers/main.js'), [
      String(this.updates),
      this.version,
      this.upgrade,
      this.name,
      this.dir,
      this.app || '',
      String(this.updateDelay)
    ])
    this.pipe = new FramedStream(this.IPC)

    this.pipe.on('data', (data) => this._onmessage(data))
    this.pipe.on('error', (err) => this.emit('error', err))
    this.IPC.on('error', (err) => this.emit('error', err))
    this.IPC.on('exit', (code) => {
      if (code === 0 || this.closing !== null || this.closed) return
      this.emit('error', new Error(`Updates worker exited with code ${code}`))
    })
  }

  _close() {
    const pipe = this.pipe
    const IPC = this.IPC

    this.pipe = null
    this.IPC = null

    pipe?.destroy()
    IPC?.destroy()
  }

  _onmessage(data) {
    const message = data.toString()

    if (message === 'updating') {
      this.emit('updating')
      return
    }

    if (message === 'updated') {
      this.emit('updated')
      this._send('pear:applyUpdate')
      return
    }

    if (message === 'pear:updateApplied') {
      this.emit('update-applied')
      return
    }

    // El pipe es de strings planos, asi que los mensajes con payload van con
    // prefijo. Se parsean antes de caer en el 'message' generico.
    if (message.startsWith('progress:')) {
      let stats = null
      try {
        stats = JSON.parse(message.slice('progress:'.length))
      } catch {
        return // un progreso ilegible no justifica tirar abajo el updater
      }
      this.emit('updating-progress', stats)
      return
    }

    if (message.startsWith('updater-error:')) {
      // Se emite como evento propio y NO como 'error': un fallo del updater
      // no debe matar un nodo que esta sirviendo tokens. Se reporta y se sigue.
      this.emit('updater-error', new Error(message.slice('updater-error:'.length)))
      return
    }

    this.emit('message', message)
  }

  _send(message) {
    if (this.pipe === null) return
    this.pipe.write(message)
  }

  async exit(code = 0) {
    Bare.exitCode = code
    await this.close()
  }
}

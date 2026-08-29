// El estado que sobrevive al proceso: un JSONL append-only, igual que el
// acumulador de lotes de la Fase 10.
//
// Append-only y no un JSON reescrito: un cron que se corta a mitad de una
// escritura deja el archivo trunco, y con un JSON entero eso significa perder
// todo el historial. Con líneas, una línea rota se descarta y el resto vive.

import fs from 'fs'
import path from 'path'

export const EVENTOS = {
  CORRIDA_INICIO: 'corrida:inicio',
  CORRIDA_FIN: 'corrida:fin',
  TICKET_ASIGNADO: 'ticket:asignado',
  TICKET_HECHO: 'ticket:hecho',
  TICKET_FALLIDO: 'ticket:fallido',
  CI_VERDE: 'ci:verde',
  CI_ROJO: 'ci:rojo',
  VIOLACION: 'violacion'
}

export class Estado {
  constructor(rutaLog) {
    this.ruta = rutaLog
    this.eventos = []
    this.cargar()
  }

  cargar() {
    if (!fs.existsSync(this.ruta)) return 0

    const contenido = fs.readFileSync(this.ruta, 'utf8')
    let descartadas = 0

    for (const linea of contenido.split('\n')) {
      if (!linea.trim()) continue
      try {
        this.eventos.push(JSON.parse(linea))
      } catch {
        descartadas++ // línea trunca de una corrida que se cortó escribiendo
      }
    }

    return descartadas
  }

  agregar(tipo, datos = {}) {
    const evento = { ts: new Date().toISOString(), tipo, ...datos }
    this.eventos.push(evento)

    const dir = path.dirname(this.ruta)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(this.ruta, JSON.stringify(evento) + '\n')

    return evento
  }

  // Un ticket está hecho si su último evento lo dice. Se lee el historial
  // completo en vez de mantener un contador porque el contador se pierde con el
  // proceso y el historial no.
  estadoDeTickets() {
    const estado = {}
    for (const e of this.eventos) {
      if (!e.ticketId) continue
      if (e.tipo === EVENTOS.TICKET_ASIGNADO) estado[e.ticketId] = 'asignado'
      if (e.tipo === EVENTOS.CI_ROJO) estado[e.ticketId] = 'ci-rojo'
      if (e.tipo === EVENTOS.TICKET_FALLIDO) estado[e.ticketId] = 'fallido'
      if (e.tipo === EVENTOS.TICKET_HECHO) estado[e.ticketId] = 'hecho'
    }
    return estado
  }

  hechos() {
    const estado = this.estadoDeTickets()
    return Object.keys(estado).filter((id) => estado[id] === 'hecho')
  }

  // Lo que quedó a mitad: asignado y sin cerrar. Es lo que el cron del día
  // siguiente tiene que retomar en vez de rehacer desde cero.
  pendientes() {
    const estado = this.estadoDeTickets()
    return Object.keys(estado).filter((id) => estado[id] !== 'hecho')
  }

  intentosDe(ticketId) {
    return this.eventos.filter((e) => e.ticketId === ticketId && e.tipo === EVENTOS.TICKET_ASIGNADO)
      .length
  }

  ultimaCorrida() {
    for (let i = this.eventos.length - 1; i >= 0; i--) {
      if (this.eventos[i].tipo === EVENTOS.CORRIDA_INICIO) return this.eventos[i]
    }
    return null
  }

  // La señal de convergencia: cuántos tickets cierra cada corrida. Dos corridas
  // seguidas cerrando cero es el sistema girando en falso, y es el momento de
  // avisarle a una persona en vez de seguir gastando.
  resumenPorCorrida() {
    const corridas = []
    let actual = null

    for (const e of this.eventos) {
      if (e.tipo === EVENTOS.CORRIDA_INICIO) {
        actual = { inicio: e.ts, hechos: 0, fallidos: 0, violaciones: 0 }
        corridas.push(actual)
      }
      if (!actual) continue
      if (e.tipo === EVENTOS.TICKET_HECHO) actual.hechos++
      if (e.tipo === EVENTOS.TICKET_FALLIDO) actual.fallidos++
      if (e.tipo === EVENTOS.VIOLACION) actual.violaciones++
      if (e.tipo === EVENTOS.CORRIDA_FIN) actual.fin = e.ts
    }

    return corridas
  }

  estancado(ventana = 2) {
    const corridas = this.resumenPorCorrida()
    if (corridas.length < ventana) return false
    return corridas.slice(-ventana).every((c) => c.hechos === 0)
  }
}

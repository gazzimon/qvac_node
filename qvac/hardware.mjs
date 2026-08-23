// Deteccion de hardware para restringir que modelos ofrece este nodo.
//
// Corre del lado del proceso `qvac-node` que ya esta vivo en la maquina del
// proveedor -no es el navegador ejecutando nada, es el propio Bare leyendo su
// sistema operativo con `bare-os`, que ya es dependencia del proyecto. Cero
// paquetes nuevos, cero scraping de terceros: el limite real para correr un
// LLM local es la RAM disponible, y QVAC lo documenta explicito ("a 4B model
// at Q4 needs roughly 4 GB, 8B wants ~8GB") -- mismo criterio, sin depender de
// una base de datos externa que no fue pensada para esto (ver ROADMAP/NOTES
// sobre por que no se scrapeo canirun.ai: es para GPUs de juegos, no para
// cuanta RAM pide un modelo cuantizado).

import os from 'bare-os'
import { MODEL_INFO } from './models.mjs'

// Margen para el SO, el runtime de Bare y el contexto de inferencia -- no es
// solo el archivo de pesos. Sin este margen, un modelo "justo justo" del
// tamano de la RAM total carga y despues el proceso se queda sin memoria a
// mitad de una respuesta larga.
const RAM_OVERHEAD_GB = 1.5

export function systemInfo() {
  const bytesToGB = (b) => Math.round((b / 1024 ** 3) * 10) / 10
  return {
    totalMemGB: bytesToGB(os.totalmem()),
    freeMemGB: bytesToGB(os.freemem()),
    cpus: typeof os.availableParallelism === 'function' ? os.availableParallelism() : 1,
    platform: os.platform(),
    arch: os.arch()
  }
}

// Un modelo "entra" si sus pesos mas el margen no superan la RAM TOTAL de la
// maquina (no la libre en este instante: la libre fluctua con lo que el SO
// tenga cacheado y subestimaria maquinas sanas). El margen es lo que absorbe
// esa diferencia.
export function fitsInMemory(sizeGB, totalMemGB) {
  return sizeGB + RAM_OVERHEAD_GB <= totalMemGB
}

// Catalogo completo + cual entra en ESTA maquina, para que el panel Proveedor
// arme el selector sin tener que repetir la cuenta del lado del cliente.
export function availableModels(totalMemGB = systemInfo().totalMemGB) {
  return Object.entries(MODEL_INFO).map(([alias, info]) => ({
    alias,
    displayName: info.displayName,
    params: info.params,
    sizeGB: Math.round(info.sizeGB * 100) / 100,
    fits: fitsInMemory(info.sizeGB, totalMemGB)
  }))
}

// Hardware detection to restrict which models this node offers.
//
// Runs on the side of the `qvac-node` process that's already alive on the
// provider's machine -this isn't a browser running anything, it's Bare
// itself reading its own operating system with `bare-os`, already a project
// dependency. Zero new packages, zero scraping third parties: the real limit
// for running a local LLM is available RAM, and QVAC documents it explicitly
// ("a 4B model at Q4 needs roughly 4 GB, 8B wants ~8GB") -- same criterion,
// with no dependency on an external database that wasn't built for this (see
// ROADMAP/NOTES on why canirun.ai wasn't scraped: it's for gaming GPUs, not
// for how much RAM a quantized model needs).

import os from 'bare-os'
import { MODEL_INFO } from './models.mjs'

// Margin for the OS, the Bare runtime, and the inference context -- not just
// the weights file. Without this margin, a model that's a tight fit for total
// RAM loads and then the process runs out of memory partway through a long
// response.
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

// A model "fits" if its weights plus the margin don't exceed the machine's
// TOTAL RAM (not what's free right now: free memory fluctuates with whatever
// the OS has cached and would underestimate healthy machines). The margin is
// what absorbs that difference.
export function fitsInMemory(sizeGB, totalMemGB) {
  return sizeGB + RAM_OVERHEAD_GB <= totalMemGB
}

// Full catalog + which ones fit on THIS machine, so the Provider panel can
// build the selector without repeating the calculation on the client side.
export function availableModels(totalMemGB = systemInfo().totalMemGB) {
  return Object.entries(MODEL_INFO).map(([alias, info]) => ({
    alias,
    displayName: info.displayName,
    params: info.params,
    sizeGB: Math.round(info.sizeGB * 100) / 100,
    fits: fitsInMemory(info.sizeGB, totalMemGB)
  }))
}

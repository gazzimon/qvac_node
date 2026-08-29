// Gate de CI: ejecutar tests y validar que pasen.
// Retorna { passed, stdout, stderr, ticketId, duration }

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function runCI(workspace, ticket, { timeout = 30000 } = {}) {
  if (!ticket || !ticket.id) {
    throw new Error('runCI: ticket must have id')
  }

  const start = Date.now()

  try {
    const { stdout, stderr } = await execAsync('npm test', {
      cwd: workspace,
      timeout,
      maxBuffer: 1024 * 1024 * 10 // 10MB
    })

    const duration = Date.now() - start

    return {
      passed: true,
      stdout,
      stderr,
      ticketId: ticket.id,
      duration,
      status: 'ok'
    }
  } catch (err) {
    const duration = Date.now() - start

    // exit code != 0 means tests failed
    if (err.killed) {
      return {
        passed: false,
        stdout: err.stdout || '',
        stderr: `Timeout after ${timeout}ms`,
        ticketId: ticket.id,
        duration,
        status: 'timeout'
      }
    }

    return {
      passed: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || 'unknown error',
      ticketId: ticket.id,
      duration,
      status: 'failed',
      exitCode: err.code
    }
  }
}

export async function detectChanges(drive, ticket, lastCheckpoint = null) {
  // Enumera archivos en Hyperdrive para el ticket
  // Retorna lista de archivos modificados desde lastCheckpoint

  if (!drive || typeof drive.readdir !== 'function') {
    throw new Error('detectChanges: drive must be a Hyperdrive instance')
  }

  const changed = []

  try {
    for (const allowedPath of ticket.allowedFiles) {
      try {
        // Intenta stat; si existe, lo registra como changed
        await drive.stat(allowedPath)
        changed.push(allowedPath)
      } catch {
        // File doesn't exist, skip
      }
    }
  } catch (err) {
    console.error(`detectChanges error: ${err.message}`)
  }

  return changed
}

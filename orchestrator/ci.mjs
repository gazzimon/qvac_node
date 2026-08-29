// The CI gate: run the tests and decide whether a ticket closes.
//
// This is the only signal in the loop that the model does not produce. A ticket
// is done because `npm test` went green, not because the worker said so.

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function runCI(workspace, ticket, { timeout = 30000 } = {}) {
  if (!ticket || !ticket.id) {
    throw new Error('runCI: ticket must have an id')
  }

  const start = Date.now()

  try {
    const { stdout, stderr } = await execAsync('npm test', {
      cwd: workspace,
      timeout,
      maxBuffer: 1024 * 1024 * 10
    })

    return {
      passed: true,
      stdout,
      stderr,
      ticketId: ticket.id,
      duration: Date.now() - start,
      status: 'ok'
    }
  } catch (err) {
    const duration = Date.now() - start

    // A timeout and a failing suite are not the same thing, and the caller has
    // to be able to tell them apart: one says the tests are broken, the other
    // says they never finished.
    if (err.killed) {
      return {
        passed: false,
        stdout: err.stdout || '',
        stderr: `Timed out after ${timeout}ms`,
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

// Which of a ticket's declared files actually made it into the drive.
export async function detectChanges(drive, ticket) {
  if (!drive || typeof drive.entry !== 'function') {
    throw new Error('detectChanges: drive must be a Hyperdrive instance')
  }

  const changed = []

  for (const allowedPath of ticket.allowedFiles) {
    const key = '/' + String(allowedPath).replace(/^\/+/, '')
    try {
      if (await drive.entry(key)) changed.push(allowedPath)
    } catch {
      // Not present yet; nothing to report for this path.
    }
  }

  return changed
}

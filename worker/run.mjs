// Worker: monta Hyperdrive compartido, inicia MCPs, llama al gateway.
//
// Uso:
//   node worker/run.mjs \
//     --gateway http://localhost:8787 \
//     --drive-key abc123… \
//     --ticket db \
//     --allowed-files "src/db.js,tests/db.test.js" \
//     --max-steps 10

import fs from 'fs'
import path from 'path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { spawn } from 'child_process'

export class Worker {
  constructor(opts = {}) {
    this.gateway = opts.gateway || 'http://localhost:8787'
    this.driveKey = opts.driveKey
    this.ticket = opts.ticket
    this.allowedFiles = (opts.allowedFiles || '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f)
    this.maxSteps = parseInt(opts.maxSteps) || 10
    this.maxTokens = parseInt(opts.maxTokens) || 5000
    this.storageDir = opts.storage || path.join(process.cwd(), '.qvac', 'worker')
    this.workdir = opts.workspace || path.join(process.cwd(), 'worktree')

    this.drive = null
    this.mcpServers = []
    this.taskLog = []
  }

  async init() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }

    if (!fs.existsSync(this.workdir)) {
      fs.mkdirSync(this.workdir, { recursive: true })
    }

    console.log(`[worker/${this.ticket}] storage: ${this.storageDir}`)
    console.log(`[worker/${this.ticket}] workspace: ${this.workdir}`)

    // Abre Corestore y Hyperdrive
    const store = new Corestore(this.storageDir)
    await store.ready()

    if (!this.driveKey) {
      throw new Error('driveKey required')
    }

    const keyBuf = Buffer.from(this.driveKey, 'hex')
    this.drive = new Hyperdrive(store, keyBuf)
    await this.drive.ready()

    console.log(`[worker/${this.ticket}] mounted Hyperdrive: ${this.driveKey.slice(0, 16)}…`)

    // Inicia MCPs
    await this.startMCPServers()

    console.log(`[worker/${this.ticket}] ready for spec`)
  }

  async startMCPServers() {
    // Inicia @modelcontextprotocol/server-filesystem
    console.log(`[worker/${this.ticket}] starting MCP servers...`)

    // Por ahora es mock; en producción llamaría a spawn()
    // const fsServer = spawn('npx', [
    //   '@modelcontextprotocol/server-filesystem',
    //   '--allowed-dirs', this.workdir
    // ])

    console.log(`[worker/${this.ticket}] (mock) MCP filesystem ready`)
    console.log(`[worker/${this.ticket}] (mock) MCP git ready`)
  }

  validatePath(filePath) {
    // Chequea que el archivo esté en allowedFiles y dentro del workspace
    const allowed = this.allowedFiles.some((af) => filePath.startsWith(af))
    if (!allowed) {
      throw new Error(`path ${filePath} not in allowedFiles`)
    }

    const abs = path.resolve(this.workdir, filePath)
    if (!abs.startsWith(this.workdir)) {
      throw new Error(`path escape detected: ${filePath}`)
    }

    return true
  }

  async writeFile(filePath, content) {
    this.validatePath(filePath)

    const fullPath = path.join(this.workdir, filePath)
    const dir = path.dirname(fullPath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(fullPath, content, 'utf8')

    // También escribe a Hyperdrive para sync P2P
    await this.drive.writeFile('/' + filePath, content)

    this.taskLog.push({
      ts: new Date().toISOString(),
      action: 'write',
      path: filePath,
      bytes: content.length
    })

    console.log(`[worker/${this.ticket}] wrote ${filePath} (${content.length} bytes)`)
  }

  async callGateway(spec) {
    // Llama al gateway con el spec del ticket

    console.log(`[worker/${this.ticket}] calling gateway...`)

    const systemPrompt = `You are a code builder. Complete this task:

${spec}

Files you can write: ${this.allowedFiles.join(', ')}
Max iterations: ${this.maxSteps}
Max tokens: ${this.maxTokens}

Output only code blocks:
\`\`\`file path=src/example.js
// code here
\`\`\`

Do not explain, just write the code.`

    const body = {
      model: 'llama-2-70b-chat',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: spec
        }
      ],
      stream: false,
      max_tokens: this.maxTokens
    }

    try {
      const res = await fetch(`${this.gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (!res.ok) {
        throw new Error(`gateway returned ${res.status}`)
      }

      const data = await res.json()
      const responseText = data.choices?.[0]?.message?.content || ''

      console.log(`[worker/${this.ticket}] gateway responded, parsing blocks...`)
      await this.parseAndWriteBlocks(responseText)

      return { ok: true, responseText }
    } catch (err) {
      console.error(`[worker/${this.ticket}] gateway error:`, err.message)
      return { ok: false, error: err.message }
    }
  }

  async parseAndWriteBlocks(text) {
    // Parsea bloques ```file path=... y escribe archivos

    const blockRegex = /```file\s+path=([^\n]+)\n([\s\S]*?)```/g
    let match

    while ((match = blockRegex.exec(text)) !== null) {
      const filePath = match[1].trim()
      const content = match[2]

      try {
        await this.writeFile(filePath, content)
      } catch (err) {
        console.error(`[worker/${this.ticket}] write error:`, err.message)
      }
    }
  }

  async start() {
    console.log(`[worker/${this.ticket}] starting...`)

    try {
      await this.init()

      // Mock: no llamamos realmente al gateway en prueba inicial
      // await this.callGateway(this.ticket)

      this.logStatus()
      console.log(`[worker/${this.ticket}] done`)
    } catch (err) {
      console.error(`[worker/${this.ticket}] error:`, err.message)
      throw err
    }
  }

  logStatus() {
    const logFile = path.join(this.storageDir, `${this.ticket}-log.jsonl`)
    const logContent = this.taskLog.map((e) => JSON.stringify(e)).join('\n')
    fs.writeFileSync(logFile, logContent + '\n')
    console.log(`[worker/${this.ticket}] log: ${logFile}`)
  }
}

async function main() {
  const opts = {}
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gateway') opts.gateway = argv[++i]
    if (argv[i] === '--drive-key') opts.driveKey = argv[++i]
    if (argv[i] === '--ticket') opts.ticket = argv[++i]
    if (argv[i] === '--allowed-files') opts.allowedFiles = argv[++i]
    if (argv[i] === '--max-steps') opts.maxSteps = argv[++i]
    if (argv[i] === '--max-tokens') opts.maxTokens = argv[++i]
    if (argv[i] === '--storage') opts.storage = argv[++i]
    if (argv[i] === '--workspace') opts.workspace = argv[++i]
  }

  const worker = new Worker(opts)
  await worker.start()
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { Worker }

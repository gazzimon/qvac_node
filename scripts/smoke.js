#!/usr/bin/env node
'use strict'

// Smoke test del artefacto que se publica: ¿este binario sirve un token?
//
// Existe por un incidente concreto. El binario `linux-x64` se publico release
// tras release sin poder cargar NINGUN modelo: el empaquetado standalone
// registra solo el backend Vulkan y nunca enumera las variantes de CPU, asi que
// `--gpu-layers 0` -la configuracion recomendada en iGPU- falla siempre. Ver
// NOTES.md, "Nodo Linux 24/7".
//
// No se descubrio en meses porque `release.js` compila los cinco targets, los
// stagea y los publica SIN EJECUTAR NINGUNO. Compilar no es funcionar. Este
// script cierra ese agujero: si el binario no produce un token, el release para.
//
//   node scripts/smoke.js                     el binario del host, en ./out
//   node scripts/smoke.js --bin <ruta>        otro binario (p.ej. el instalado)
//   node scripts/smoke.js --gpu-layers 0      pasandole flags al CLI
//   node scripts/smoke.js --timeout 900       mas margen en frio
//
// LIMITE HONESTO: solo puede probar binarios que corran en ESTA maquina. Los
// otros cuatro targets son cross-compilados y aca no se ejecutan. Cubrirlos
// exige una matriz de CI (ubuntu/macos/windows) donde cada sistema corra el
// suyo, o correr esto a mano en cada maquina antes de publicar.

const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const root = path.resolve(__dirname, '..')
const isWindows = os.platform() === 'win32'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i === -1 ? def : argv[i + 1]
}

const hostTarget = `${os.platform()}-${os.arch()}`
const defaultBin = path.join(root, 'out', hostTarget, isWindows ? 'pyrusllm.exe' : 'pyrusllm')
const bin = path.resolve(flag('--bin', defaultBin))

// Generoso a proposito: en frio son 808 MB de pesos por hypercore. Lo que se
// busca cazar es "no sirve un token", no "tardo mucho".
const timeoutMs = Number(flag('--timeout', 600)) * 1000
const gpuLayers = flag('--gpu-layers', null)
const prompt = flag('--prompt', 'ping')

function fallar(porque, detalle) {
  console.error(`\n  SMOKE FAIL — ${porque}`)
  if (detalle) console.error('\n' + detalle.trimEnd() + '\n')
  process.exit(1)
}

if (!fs.existsSync(bin)) {
  fallar(`no existe el binario ${bin}`, 'Compilalo con `npm run make` o pasa --bin <ruta>.')
}

// El binario NO puede escribir a un pipe de libuv: se cuelga para siempre.
// Documentado en NOTES.md, "BUG: el binario se cuelga si stdout es un pipe".
// Por eso la salida va a un archivo y se lee al final, igual que en soak.js.
const salida = path.join(os.tmpdir(), `pyrusllm-smoke-${process.pid}.log`)
const fd = fs.openSync(salida, 'w+')

const args = ['prompt', prompt, '--quiet']
if (gpuLayers !== null) args.push('--gpu-layers', String(gpuLayers))

console.log(`\n  smoke: ${bin}`)
console.log(`  args : ${args.join(' ')}`)
console.log(`  timeout: ${timeoutMs / 1000}s\n`)

const arranque = Date.now()
const child = spawn(bin, args, { cwd: root, stdio: ['ignore', fd, fd] })

let matado = false
const reloj = setTimeout(() => {
  matado = true
  child.kill('SIGKILL')
}, timeoutMs)

child.on('error', (err) => {
  clearTimeout(reloj)
  fs.closeSync(fd)
  fallar(`no se pudo ejecutar el binario: ${err.message}`)
})

child.on('exit', (code) => {
  clearTimeout(reloj)
  const wallMs = Date.now() - arranque
  fs.closeSync(fd)

  const texto = fs.readFileSync(salida, 'utf8')
  fs.unlinkSync(salida)

  if (matado) {
    fallar(`colgado: no termino en ${timeoutMs / 1000}s, hubo que matarlo`, texto)
  }
  if (code !== 0) {
    fallar(`exit code ${code}`, texto)
  }

  // Otro nodo vivo tiene tomado el lock del registry. NO es una falla del
  // artefacto y no puede reportarse como tal: solo hay un proceso por
  // directorio de storage, asi que el smoke exige que el nodo este bajado.
  if (/could not be locked/i.test(texto)) {
    fallar(
      'hay otro nodo corriendo: el registry esta lockeado',
      'Bajalo antes de correr el smoke (`systemctl stop pyrusllm`, o Ctrl+C\n' +
        'en la terminal del `serve`) y volve a intentar. Esto NO dice nada\n' +
        'sobre si el binario funciona.'
    )
  }

  // Un exit 0 no alcanza. El CLI puede terminar limpio habiendo impreso el
  // error de carga: es exactamente lo que hacia el binario linux-x64.
  if (/fallo la inferencia|failed to load model|Failed to initialize model/i.test(texto)) {
    fallar('el binario arranco pero NO pudo cargar el modelo', texto)
  }

  // Con --quiet la unica salida es la respuesta. Si no hay texto util, no hubo
  // token, y un nodo que no produce tokens no es un nodo.
  const respuesta = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
  if (respuesta.length === 0) {
    fallar('el binario termino con exit 0 pero no produjo ningun token', texto)
  }

  console.log(`  respuesta: ${respuesta.slice(0, 120)}`)
  console.log(`\n  SMOKE OK — token servido en ${(wallMs / 1000).toFixed(1)}s\n`)
})

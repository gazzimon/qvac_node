# Login demo por rol (Cliente / Proveedor / Admin)

Fecha: 2026-08-23
Branch: feature/login-landing
Contexto: hoy `qvac/gateway.mjs` sirve `/`, `/proveedor` y `/admin` sin
ningún gate — cualquiera que llegue a la URL entra directo. No existe
concepto de usuario ni de sesión en el proyecto; lo único parecido es
`qvac/apikeys.mjs`, que emite API keys efímeras para consumir el gateway
OpenAI-compatible desde AFUERA del panel (Telegram, terminal, etc.), no
para loguear a un humano en el navegador.

## Objetivo

Un login que:

1. Protege **todo el sitio** — sin sesión válida, cualquier ruta de panel
   redirige a `/login`.
2. Tiene **3 combinaciones fijas** (usuario/contraseña), una por rol:
   Cliente, Proveedor, Admin. Sin base de datos, sin registro.
3. Redirige después de loguear al panel que corresponde al rol.
4. Sirve para grabar un video de demo: tiene que andar de forma
   confiable, sin pedir nada que no esté preseteado.

## Fuera de alcance (decidido explícitamente)

- **Que un Proveedor también opere como Cliente.** Mencionado como no
  decidido todavía. Este diseño no lo resuelve: cada sesión tiene
  exactamente un rol, fijo desde el login.
- **Contraseñas hasheadas o backend de usuarios real.** Los 3 combos
  viven como constantes en el código fuente. Son credenciales de demo,
  públicas en el repo — la sección "Seguridad" de abajo es explícita
  sobre qué implica y qué no implica esto.
- **Recuperación de contraseña, registro, roles adicionales o
  jerarquía entre roles** (ej. que Admin pueda entrar a `/proveedor`
  sin re-loguearse). Cada rol ve únicamente su panel.
- **Rate limiting / bloqueo por intentos fallidos.** Con 3 combos fijos
  y uso interno para una demo, no hay superficie que proteger contra
  fuerza bruta que valga la pena en este alcance.
- **Tocar `qvac/pages.mjs`.** Ahí vive el `NAV`/`STYLE` compartido por
  los 3 paneles existentes, y es archivo activo de otra persona del
  equipo en paralelo — cualquier edit ahí es candidato a conflicto de
  merge. Consecuencia directa: `LOGIN_HTML` vive en un módulo nuevo,
  propio, y no hay link de "Salir" inyectado en los paneles existentes
  (ver sección 5).

## 1. Flujo

```
GET  /login          -> formulario usuario/contraseña (sin sesión)
                      -> si YA hay sesión válida, redirige directo al
                         panel de su rol (evita loguear dos veces)
POST /login           -> valida contra los 3 combos fijos (JSON body)
                      -> ok: crea sesión, setea cookie, responde
                         { ok: true, redirect } y el form navega ahí
                      -> error: responde 401 { ok: false }, el form
                         muestra el mensaje sin recargar

GET  /logout           -> borra la sesión (memoria + cookie), 302 a /login
                      -> sin link en los paneles: se visita a mano

GET  /                -> requiere sesión con rol "cliente"
GET  /proveedor        -> requiere sesión con rol "proveedor"
GET  /admin             -> requiere sesión con rol "admin"
                      -> sin sesión, o rol que no matchea: 302 a /login
```

No hay jerarquía: una sesión de Admin que pide `/proveedor` también
rebota a `/login`, igual que una sin sesión. Simplifica el chequeo a una
sola comparación de string por ruta.

## 2. Credenciales fijas

Constantes en `qvac/auth.mjs`, no en variables de entorno (para que
"anda con datos preseteados" no dependa de configurar nada antes de
grabar):

| rol       | usuario     | contraseña |
| --------- | ----------- | ---------- |
| cliente   | `cliente`   | `demo123`  |
| proveedor | `proveedor` | `demo123`  |
| admin     | `admin`     | `demo123`  |

## 3. `qvac/auth.mjs` (nuevo módulo)

Mismo patrón que `qvac/apikeys.mjs`: Map en memoria, token aleatorio con
`hypercore-crypto` (ya en el árbol de dependencias), comparación en
tiempo constante para el password. Se resetea con el proceso — para una
demo alcanza, y evita tener que limpiar estado entre corridas.

```js
import crypto from 'hypercore-crypto'

const USERS = {
  cliente:   { password: 'demo123', role: 'cliente' },
  proveedor: { password: 'demo123', role: 'proveedor' },
  admin:     { password: 'demo123', role: 'admin' }
}

const sessions = new Map() // token -> { role, createdAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h, alcanza y sobra para una demo

function randomToken() { /* igual a randomToken() de apikeys.mjs */ }
function equalConstantTime(a, b) { /* copiado de apikeys.mjs */ }

export function login(usuario, password) {
  const entry = USERS[usuario]
  if (!entry || !equalConstantTime(entry.password, String(password || ''))) return null
  const token = randomToken(24)
  sessions.set(token, { role: entry.role, createdAt: Date.now() })
  return token
}

export function verifySession(token) {
  const s = token && sessions.get(token)
  if (!s) return null
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return null
  }
  return s.role
}

export function logout(token) {
  sessions.delete(token)
}
```

## 4. Cambios en `qvac/gateway.mjs`

- Parsear la cookie `qvac_session` del header `Cookie` (no hay lib de
  cookies en el árbol; un split simple alcanza — mismo criterio "sin
  dependencia nueva para algo de 3 líneas" que el resto del gateway).
- Antes de servir `/`, `/proveedor`, `/admin`: `verifySession(token)` y
  comparar el rol devuelto contra el rol que exige esa ruta. Si no
  matchea, `302 Location: /login`.
- `GET /login`: si ya hay sesión válida, `302` directo a su panel (no
  vuelve a mostrar el form). Si no, sirve `LOGIN_HTML`.
- `POST /login`: lee el body con `readJsonBody` (ya existe en el
  gateway, se reusa tal cual — evita escribir un parser de
  `x-www-form-urlencoded` nuevo) — `{ usuario, password }` — y llama a
  `auth.login(...)`. Si falla, `401 { ok: false }`. Si funciona, setea
  `Set-Cookie: qvac_session=<token>; HttpOnly; SameSite=Lax;
  Max-Age=86400; Path=/` y responde `200 { ok: true, redirect }`. El
  form de `LOGIN_HTML` hace el `fetch` y navega con
  `window.location = redirect`.
- `GET /logout`: borra la sesión, `Set-Cookie` con `Max-Age=0` para
  limpiarla del browser, `302` a `/login`. `GET` en vez de `POST` a
  propósito: sin link en el panel (ver sección 5), tiene que poder
  visitarse pegando la URL a mano durante la demo.

## 5. `qvac/auth-pages.mjs` (nuevo): `LOGIN_HTML`

Archivo separado de `pages.mjs` a propósito (ver "Fuera de alcance").
Exporta una única constante `LOGIN_HTML`: documento HTML completo,
autocontenido, con su propio `<style>` mínimo (mismo look dark —
`#0f1115` de fondo, `#4a7dfc` de acento— copiado a mano, no importado,
para no crear ninguna dependencia hacia `pages.mjs`). Contenido: form
con `usuario`, `password`, botón "Ingresar"; el submit hace `fetch` a
`POST /login` y muestra "usuario o contraseña incorrectos" inline si la
respuesta es `{ ok: false }`, sin recargar la página.

No hay link de "Salir" en los paneles existentes (requeriría tocar el
`NAV` compartido de `pages.mjs`). `GET /logout` queda como ruta directa
para visitar a mano durante la demo — sin botón, sin dependencia del
archivo protegido.

## 6. Seguridad — qué da y qué no da esto

Da: cookie `HttpOnly` (no accesible desde JS, mitiga XSS robando la
sesión), `SameSite=Lax` (mitiga CSRF básico), token de sesión aleatorio
criptográfico (no adivinable), comparación de password en tiempo
constante (no filtra el prefijo correcto por timing).

No da, a propósito, y hay que decirlo en voz alta: las 3 contraseñas
son texto plano en el código fuente del repo, que es público. Esto NO
es un sistema de auth para proteger algo real — es un gate de demo que
se comporta como uno real (redirige de verdad, no se puede bypassear
pegando la URL) pero cuyo secreto no es secreto. Si el producto necesita
login real más adelante, este módulo se reemplaza entero por uno con
usuarios persistidos y contraseñas hasheadas; no es una base sobre la
que crece ese sistema.

## Testing

- `qvac/auth.mjs` es puro (sin HTTP): test unitario de `login` con
  combo correcto/incorrecto por cada rol, y de `verifySession` con
  token válido/inexistente/expirado.
- Gateway: un test de integración (estilo `test/index.js` existente)
  que pega a `/admin` sin cookie y espera `302` a `/login`, loguea por
  `POST /login` con las credenciales de admin, reusa la cookie devuelta
  y confirma `200` en `/admin`.

## 7. Estado: listo para integrar

`qvac/auth.mjs` y `qvac/auth-pages.mjs` ya están escritos, probados
aislados (sin `gateway.mjs`) y funcionan. Lo único que falta es
enchufarlos al router — y `gateway.mjs` está fuera de mi alcance ahora
mismo (ver [[qvac-node-protected-files]]). Esto es exactamente lo que
hay que pegar ahí, en 4 puntos:

**1. Import**, junto a los otros `import * as ...`:

```js
import * as auth from './auth.mjs'
```

**2. Helpers**, cerca de `sendHtml` (mismo archivo, misma zona de la
sección "Forma OpenAI" donde ya viven `sendJson`/`sendError`):

```js
function sendRedirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders })
  res.end()
}

// Un solo par nombre=valor alcanza: los atributos (Path, HttpOnly...)
// los pone el SERVIDOR via Set-Cookie, no vuelven en el header Cookie.
function parseCookie(req, nombre) {
  const header = req.headers['cookie'] || req.headers['Cookie']
  if (!header) return null
  for (const par of header.split(';')) {
    const i = par.indexOf('=')
    if (i === -1) continue
    if (par.slice(0, i).trim() === nombre) return par.slice(i + 1).trim()
  }
  return null
}

const SESSION_COOKIE = 'qvac_session'
function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`
}
const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
const ROLE_PATH = { cliente: '/', proveedor: '/proveedor', admin: '/admin' }

function requireRole(req, res, role) {
  const token = parseCookie(req, SESSION_COOKIE)
  const sessionRole = auth.verifySession(token)
  if (sessionRole !== role) { sendRedirect(res, '/login'); return false }
  return true
}
```

**3. Rutas**, arriba de todo en `onRequest`, ANTES de las 3 rutas
existentes (`/`, `/proveedor`, `/admin` — a esas tres solo se les
agrega el `if (!requireRole(...)) return` como primera línea del
bloque):

```js
if (req.method === 'GET' && pathname === '/login') {
  const sessionRole = auth.verifySession(parseCookie(req, SESSION_COOKIE))
  if (sessionRole) return sendRedirect(res, ROLE_PATH[sessionRole])
  const { LOGIN_HTML } = await import('./auth-pages.mjs')
  return sendHtml(res, LOGIN_HTML)
}
if (req.method === 'POST' && pathname === '/login') {
  const body = await readJsonBody(req)
  const token = auth.login(body.usuario, body.password)
  if (!token) return sendJson(res, 401, { ok: false })
  const role = auth.verifySession(token)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(token) })
  return res.end(JSON.stringify({ ok: true, redirect: ROLE_PATH[role] }))
}
if (req.method === 'GET' && pathname === '/logout') {
  auth.logout(parseCookie(req, SESSION_COOKIE))
  return sendRedirect(res, '/login', { 'Set-Cookie': CLEAR_SESSION_COOKIE })
}
if (req.method === 'GET' && pathname === '/') {
  if (!requireRole(req, res, 'cliente')) return
  // ... resto sin cambios
}
if (req.method === 'GET' && pathname === '/proveedor') {
  if (!requireRole(req, res, 'proveedor')) return
  // ... resto sin cambios
}
if (req.method === 'GET' && pathname === '/admin') {
  if (!requireRole(req, res, 'admin')) return
  // ... resto sin cambios
}
```

**4. (opcional, cosmético)** un log más en el `server.listen(...)`:
`console.log('  [gateway] login: http://localhost:' + port + '/login')`.

Con esto aplicado, `qvac-node serve --demo` ya pide login antes de
mostrar cualquier panel.

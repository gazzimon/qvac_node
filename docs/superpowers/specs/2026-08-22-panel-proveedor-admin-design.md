# Panel Proveedor (alta de nodo) + Panel Admin (analytics y baneo)

Fecha: 2026-08-22
Branch: fase-2-marketplace-paneles
Contexto: marketplace simulado de un solo proceso (`gateway.mjs` + `store.mjs` +
`pages.mjs`), sin P2P real todavía — ver `ROADMAP_FASE2-6.md` (Fase 2/3).

## Objetivo

- **Proveedor**: puede dar de alta su propio nodo desde el panel, con un
  formulario de nombre, descripción (a qué se dedica) y precio que quiere
  cobrar — hoy solo puede editar nodos que ya vienen precargados en
  `store.seed()`.
- **Cliente**: sin cambios.
- **Admin**: gana una franja de totales (analytics básico) y un "superpoder"
  de baja permanente de un nodo por ser malicioso, distinto del toggle
  online/offline que ya existe y que el proveedor puede revertir solo.

## Fuera de alcance

- Autenticación/sesión por proveedor (quién es "dueño" de qué nodo). El panel
  proveedor sigue siendo, como hoy, un selector sobre TODOS los nodos — nada
  de login en este track.
- Persistencia entre reinicios del proceso. Todo sigue en memoria, mismo
  criterio que ya documenta `store.mjs`. Un nodo creado por un proveedor o un
  ban desaparecen si el gateway se reinicia.
- Inferencia real para nodos creados por el proveedor — son `kind: 'mock'`,
  igual que los nodos de demo actuales.
- Gráficos/visualizaciones en el admin — la franja de analytics es texto/
  números, sin librerías de charting (coherente con el resto de los paneles:
  HTML/CSS/JS embebido, sin build).

## 1. Modelo de datos (`store.mjs`)

- `status` pasa a admitir tres valores: `'online' | 'offline' | 'banned'`
  (hoy solo los primeros dos).
- Nuevo campo `banReason` (string | null) — solo tiene sentido cuando
  `status === 'banned'`.
- `kick(id)` (que hoy es un alias de `setStatus(id, 'offline')`) se separa de
  la funcionalidad de baneo. Funciones nuevas:
  - `banNode(id, reason)` → `status: 'banned'`, guarda `banReason`. No-op si
    ya está baneado (se devuelve el nodo tal cual, sin pisar el motivo
    existente).
  - `unbanNode(id)` → vuelve a `status: 'online'`, `banReason: null`.
- `setStatus(id, status)` (el toggle que ya usa el proveedor) pasa a
  **rechazar** el cambio si el nodo actual está `banned` — devuelve `null`
  igual que cuando el nodo no existe, y el gateway lo traduce a un 403 con
  mensaje claro (ver sección 2).
- `addNode({ displayName, description, pricing })`:
  - genera `id` y `modelId` como slug de `displayName` + sufijo aleatorio
    corto (para evitar colisiones sin depender de que el proveedor tipee un
    id único).
  - `kind: 'mock'`, `operator: displayName` (no hay concepto de "operador"
    separado del nombre del nodo en este track), `status: 'online'`,
    `activeRequests: 0`, `tools: []`.
  - `tags`: derivados por heurística simple de palabras clave de la
    descripción (reutilizando el mismo espíritu que los mocks existentes);
    si no matchea ninguna, `tags: ['general']`.
  - `maxConcurrentRequests`: valor fijo razonable (ej. `4`) — no se le pide
    al proveedor en el form.
  - guarda también la `description` cruda en el nodo (campo nuevo,
    `description: string`), porque la usa el generador de respuesta mock
    (sección 5) y potencialmente el detalle del panel proveedor.

## 2. Endpoints (`gateway.mjs`)

- `POST /v1/nodes` — crea un nodo. Body `{ displayName, description,
  pricing }`; 400 si falta `displayName` o `pricing`. Devuelve el nodo
  creado (forma `toPublic`, incluyendo el `id`/`modelId` generados).
- `POST /v1/nodes/:id/ban` — body `{ reason }` (400 si falta o está vacío).
  404 si el nodo no existe. Devuelve el nodo actualizado.
- `POST /v1/nodes/:id/unban` — sin body. 404 si no existe. Devuelve el nodo
  actualizado.
- `POST /v1/nodes/:id` (ya existe, pricing/status) — sin cambios de forma,
  pero si `hasStatus` y el nodo está `banned`, responde 403:
  `{ error: 'nodo baneado por el admin, no lo podés reactivar vos' }` en vez
  de aplicar el cambio.
- `GET /v1/models` (ya existe) — sin cambios de forma. Nodos `banned` viajan
  con `status: 'banned'`; el panel cliente los trata igual que `offline`
  (no habilita conectar), sin mostrar `banReason` a clientes — ese campo solo
  se expone en las respuestas de admin/proveedor sobre su propio nodo.

## 3. Panel Proveedor (`pages.mjs` → `PROVEEDOR_HTML`)

Arriba del `<select>` existente, bloque nuevo "Agregar mi nodo a la red":

- Campo **Nombre** (texto, ej. "Traductor Legal").
- Campo **Descripción** (textarea, "¿A qué se dedica tu nodo?").
- Campo **Precio que querés cobrar** (texto libre, mismo formato que
  `pricing` ya usa, ej. "0.002 QVAC / 1K tok").
- Botón "Publicar nodo" → `POST /v1/nodes`. Al responder OK: refresca la
  lista, selecciona automáticamente el nodo recién creado (`current = nuevo
  id`) y limpia el formulario.

En el detalle (`buildShell`/`renderDetail`), si `n.status === 'banned'`:
  - se muestra un aviso: `Este nodo fue dado de baja por el admin: <motivo>`.
  - el botón de toggle online/offline se deshabilita (`disabled`), en vez de
    ocultarse — así queda claro que existe pero no se puede tocar.

## 4. Panel Admin (`pages.mjs` → `ADMIN_HTML`)

**Franja de totales**, arriba de la tabla existente. Tarjetas (reusando la
clase `.card` ya definida en `STYLE`):

- Nodos totales.
- Online / Offline / Baneados (tres números, calculados client-side sobre la
  respuesta ya existente de `/v1/models` — sin endpoint nuevo).
- Requests servidos: tamaño del log de ruteo (`/v1/routing-log`, ya existe;
  documentar que el número se trunca a `MAX_LOG=30` como ya hace el log, sin
  agregar un contador acumulado nuevo en este track).

**Acciones por fila**, reemplazando el botón único actual:

- Nodo `online` u `offline` (no baneado): dos botones, "Tirar/Reactivar"
  (el toggle que ya existe) + "Banear" nuevo.
- "Banear" abre un modal chico (reusando `.modal-overlay`/`.modal` que ya
  define `STYLE`) con un `<input>` de motivo y confirmar → `POST
  /v1/nodes/:id/ban`.
- Nodo `banned`: la columna de estado muestra el motivo
  (`baneado — <banReason>`), y la única acción disponible es "Levantar
  baneo" → `POST /v1/nodes/:id/unban`. El botón de toggle online/offline no
  se muestra para este nodo.

## 5. Respuesta mock para nodos creados por el proveedor (`gateway.mjs`)

`MOCK_REPLIES` sigue existiendo tal cual para los 3 nodos de demo curados a
mano. Para nodos sin entrada en ese mapa (todos los creados por el form), el
fallback deja de ser el genérico `'Respuesta simulada.'` y pasa a construirse
con el nombre y la descripción del propio nodo:

```
Respuesta simulada de "{displayName}" ({descripción recortada}): esto
representa lo que este proveedor ofrece responder a "{prompt recortado}".
(Respuesta simulada — este nodo es una demo.)
```

Mismo patrón de honestidad que ya usa el resto del archivo (`truncate()`,
aclaración final entre paréntesis) — no hay generación "inteligente" por
keyword-matching como los 3 mocks curados, es un template derivado de lo que
el proveedor mismo escribió.

## Testing

- `store.mjs`: casos de `addNode` (slug/id únicos, tags por defecto),
  `banNode`/`unbanNode` (incluyendo no-op sobre ya-baneado), `setStatus`
  rechazando sobre un nodo baneado.
- `gateway.mjs`: los 3 endpoints nuevos (happy path + 400/403/404), y que
  `POST /v1/nodes/:id` con `status` sobre un nodo baneado devuelva 403 sin
  tocar el nodo.
- Manual/UI: alta de nodo desde proveedor aparece en cliente y admin: ban
  desde admin bloquea el toggle en proveedor y desaparece de "disponibles"
  en cliente; unban lo revierte.

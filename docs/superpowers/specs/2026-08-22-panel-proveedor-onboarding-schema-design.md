# Panel Proveedor: onboarding a la red P2P + edición del manifiesto

Fecha: 2026-08-22
Branch: main (ux-panel)
Contexto: marketplace P2P real (`qvac/swarm.mjs`, `qvac/manifest.mjs`,
`qvac/provider.mjs`), no el marketplace simulado del track anterior.

## Objetivo

`qvac/pages.mjs` → `PROVEEDOR_HTML` hoy solo deja editar `pricing` (texto
libre) y togglear online/offline sobre un `<select>` de TODOS los nodos de
`/v1/nodes`. No hay:

1. Ninguna instrucción de cómo pasar de "tengo el panel abierto" a "soy
   proveedor real de la red" (el gateway puede correr sin `--swarm`).
2. Edición de `displayName`, `tags`, `modelId` o `maxConcurrentRequests` del
   manifiesto — solo `pricing`.

## Fuera de alcance (decidido explícitamente)

- **Ejecutar comandos desde el navegador.** Un browser no puede spawnear
  procesos en la máquina del usuario por sandboxing — ningún cambio de
  arquitectura lo resuelve. El bloque de onboarding muestra el comando +
  botón "Copiar" (mismo patrón ya usado en el modal de Hermes/Open WebUI del
  panel Cliente), nunca lo ejecuta server-side.
- **Distribución vía npm.** El plan inicial del hackathon fija `pear install`
  como único canal de distribución — es criterio de juzgado del track. Un
  visitante sin nada instalado igual tiene que correr un comando local en
  algún momento (límite físico: ninguna web instala software ni abre puertos
  de red en la máquina de otro), así que npm no automatiza nada que
  `pear install` no automatice ya.
- **Modelos fuera del catálogo (`qvac/models.mjs`).** El selector de modelo
  solo lista los alias definidos ahí (hoy `smol` y `llama1b`, ambos ≤1B). No
  se acepta un nombre de registry arbitrario por texto libre.

## 1. Bloque de onboarding

`GET /v1/nodes` agrega un campo `swarm` al lado de `nodes`:

- `swarm: null` si este proceso corrió sin `--swarm`.
- `swarm: { operator, publicKey, verifiedPeers }` si está anunciado en la red.

En el panel, si `swarm === null`, arriba de todo aparece un bloque:

> **Este panel todavía no está anunciado en la red P2P.**
> Para que tu máquina entre a la red de inferencia, corré:
> ```
> qvac-node serve --swarm --operator "tu nombre"
> ```
> [Copiar comando]

Si `swarm` no es null, el bloque no se renderiza — el resto del panel queda
igual que hoy.

## 2. Campos editables nuevos

Al lado de `pricing` (que ya se edita), se agregan:

- **displayName** (texto libre, igual UX que pricing: se guarda al blur del
  input, el poll no pisa lo que se está tipeando).
- **tags** (texto separado por comas, se parsea a array al guardar).
- **maxConcurrentRequests** (número).
- **modelo** (`<select>` con las opciones de `MODELS`, ver "fuera de alcance").

Los tres primeros se guardan directo. El modelo pasa por el modal de
confirmación (sección 3) porque dispara una carga de pesos real, no un simple
cambio de metadata.

## 3. Confirmación al cambiar de modelo

Antes de mandar el cambio, un modal (reutiliza `.modal-overlay`/`.modal`
ya definidos en `STYLE`):

> **Cambiar el modelo de este nodo**
> Vas a pasar de `<modelo actual>` a `<modelo nuevo>`. Puede tardar varios
> segundos —o fallar por falta de memoria— mientras el nodo sigue
> respondiendo con el modelo viejo. Si falla, se mantiene el modelo actual.
> [Cancelar] [Confirmar cambio]

Solo el modelo pasa por este modal. `displayName`/`tags`/
`maxConcurrentRequests` se guardan sin confirmación extra.

## 4. Arquitectura: re-firmar y re-anunciar el manifiesto

`NodeSwarm.manifest()` hoy cachea el manifiesto firmado para siempre
(`if (!this._manifest) { this._manifest = signManifest(...) }`). Cambia a:

- `NodeSwarm.updateAnnouncement({ displayName, tags, maxConcurrentRequests,
  modelId })`: actualiza los campos internos (`this.operator`/`this.models`
  ya existen; `displayName` es nuevo), invalida `this._manifest` (`= null`),
  re-firma con la MISMA identidad (`this.identity`, no cambia la clave), y
  reenvía `manifest:announce` a **todas las conexiones abiertas** (no solo a
  las futuras).
- Si el `modelId` cambia:
  1. Se responde de inmediato `{ status: 'loading', modelId }` — no se
     bloquea el request esperando la carga.
  2. `Provider._ensureModel(modelId)` (ya soporta múltiples modelos cacheados
     por id, arreglado en la sesión anterior) carga el nuevo en background.
     El modelo viejo sigue sirviendo requests en vuelo mientras tanto.
  3. Si la carga falla: NO se anuncia el modelo nuevo — el manifiesto se
     re-firma con el modelId anterior, y el panel refleja el error via poll.
  4. Si la carga tiene éxito: recién ahí se actualiza `provider.models` +
     `nodeSwarm.models` en conjunto y se re-anuncia — nunca queda un estado
     donde el manifiesto promete un modelo que el `Provider.serves()`
     todavía no acepta.
- `GET /v1/swarm/manifest`: devuelve el estado actual (`ready`/`loading`/
  `error` + el manifiesto público) para que el panel haga poll después de
  pedir un cambio de modelo.
- `POST /v1/swarm/manifest`: body `{ displayName?, tags?,
  maxConcurrentRequests?, modelId? }`, dispara `updateAnnouncement`. 503 si
  `swarmRef` no existe (mismo criterio que `/v1/files/*`).

## Testing

- `swarm.mjs`: `updateAnnouncement` invalida el cache del manifiesto, re-firma
  con la misma identidad, y (con un swarm de prueba de 2 nodos) el segundo
  nodo recibe el `manifest:announce` actualizado sin reconectar.
- `provider.mjs`: cambiar de modelo no interrumpe un request en vuelo sobre
  el modelo anterior; una carga fallida no dispara el re-anuncio.
- Manual: abrir `/proveedor` sin `--swarm` muestra el bloque de onboarding;
  con `--swarm`, no aparece; editar displayName/tags se refleja en el panel
  Cliente y Admin sin reiniciar el proceso.

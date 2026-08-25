# PyrusLLM

**Un marketplace de inferencia de IA sin datacenter en el medio.**

PyrusLLM convierte cualquier computadora en un proveedor de inferencia: instala
un CLI que se actualiza solo por OTA P2P, y al instalarse hace que la máquina
entre a una red viva de nodos. Cada nodo corre un LLM local con QVAC y se
anuncia con un manifiesto firmado; un gateway compatible con la API de OpenAI
enruta cada request hacia el proveedor disponible, y cualquier cliente OpenAI
—tu terminal, un bot de Telegram, Open WebUI— le habla sin modificar una línea.

Para quien compra inferencia, es una factura más baja y sin intermediario
centralizado. Para quien la vende, es monetizar cómputo que hoy está ocioso.
El protocolo es el mismo de un lado y del otro: no hay servidor propietario en
el medio, ni un tercero que se quede con el margen.

Hackathon CRECIMIENTO / Aleph 2026 — Pears Track.

---

## Instalación

**Una línea, sin dependencias previas.** El binario trae el motor de inferencia
adentro: no hace falta Node, ni npm, ni Pear.

```bash
# macOS y Linux
curl -fsSL https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/gazzimon/qvac_node/main/install.ps1 | iex
```

Detecta plataforma, baja el binario del
[release](https://github.com/gazzimon/qvac_node/releases/latest), verifica el
checksum, lo instala **sin sudo ni UAC** (`~/.local/bin` o `%LOCALAPPDATA%`) y
lo arranca: la app abre sola en el navegador.

**Instalación por Pear**, que además da updates OTA automáticos:

```bash
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
pyrusllm
```

Sin `npm install` del proyecto, sin build, sin repo que clonar: el canal de
distribución **es** la red P2P. La copia instalada se actualiza sola, en ~10 s,
sin que el usuario haga nada.

## Uso

```bash
pyrusllm                                             # abre la app en el navegador
pyrusllm prompt "¿Qué es una red peer-to-peer?"     # inferencia 100% local, sin abrir nada
pyrusllm serve --swarm --operator "Mi Nodo"          # arranca ya unido a la red, sin pasar por la puerta
pyrusllm peers --operator "Mi Nodo" --timeout 90     # verificar que se descubre con otro nodo
pyrusllm send ./plano.pdf                            # publicar un archivo (link qvac://)
pyrusllm fetch qvac://<clave>/plano.pdf              # bajarlo en la otra máquina
```

**`pyrusllm` a secas levanta la app en `http://localhost:8787` y abre el
navegador.** El updater OTA sigue corriendo abajo: es además, no en vez de.
Flags de la raíz: `--port <n>`, `--no-open` (no abrir el navegador) y
`--no-serve` (solo el updater, sin app).

### La puerta

La app abre en el **chat**, y arranca con el nodo apagado: lo primero que se ve
es **Launch local agent**. Lanzarlo une la máquina al swarm en caliente —sin
reiniciar el proceso— y abre el chat.

**Sin agente lanzado no se llega a la red**: el selector no ofrece `Auto` ni
nodos remotos, y `/v1/chat/completions` responde 503 `agent_offline` si el único
candidato era un par. **El modelo local nunca se bloquea**: esa es la única
excepción, y existe para que el primer arranque no sea una pared sin nada atrás.

### Las tres vistas

| Ruta | Qué es |
| --- | --- |
| `/` | **Chat.** Multi-turno, markdown, streaming. Cada respuesta dice qué máquina la produjo. |
| `/node` | **My Node.** Tu propia máquina como proveedor: estado, carga, precio, modelo. |
| `/network` | **Network.** La grilla del marketplace: todos los nodos, con precio y carga. |
| `/admin` | Log de ruteo y controles de caos. |

`/proveedor` y `/cliente` redirigen a las rutas nuevas.

### API

```
GET  /v1/models                 catálogo, formato OpenAI estricto
POST /v1/chat/completions       { model, messages[], stream } -> SSE o JSON
GET  /v1/agent                  estado del agente local (offline|launching|live|error)
POST /v1/agent/launch           unirse al swarm en caliente
GET  /v1/nodes                  vista rica del marketplace
POST /v1/connection/:id         credencial para un cliente externo
GET  /v1/files · POST /upload · POST /fetch     archivos entre nodos (Hyperdrive)
```

Dos extensiones propias sobre `/v1/chat/completions`, que ningún cliente de
OpenAI manda y que omitidas no cambian nada:

- **`local: true`** en el body fuerza que el prompt no salga de esta máquina.
- La respuesta trae headers **`X-Pyrus-Operator`**, **`-Kind`** y **`-Model`**
  con quién contestó. Van en headers y no en el cuerpo a propósito: meter un
  campo propio adentro de un `chat.completion.chunk` ensuciaría el formato de
  OpenAI, que es justo lo que este gateway promete respetar.

El botón **Conectar** de cada nodo en `/network` emite una API key y muestra los
pasos para Telegram, WhatsApp, terminal, Hermes Agent u Open WebUI — el mismo
nodo, hablado desde afuera del panel, sin camino privilegiado.

El botón **Archivos** de cada nodo abre un modal de **solo lectura**: lista lo
que ese nodo publica y deja copiar el link `qvac://`. La carga y la descarga
**no tienen UI todavía** —`/v1/files/upload` y `/v1/files/fetch` existen en el
gateway, pero ningún botón del panel las llama—; hoy se hacen por CLI con
`send`/`fetch`, como en el bloque de arriba.

Detalles de por qué (Protomux sobre una sola conexión, D1–D7, el updater OTA en
su propio hilo, verificación con dos máquinas) están en [NOTES.md](NOTES.md).
El plan por fases, en [ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md).

## Estado

- **Fases 0–3 (distribución, inferencia local, gateway, manifiesto firmado,
  swarm P2P, chat sobre el canal P2P): cerradas.** `pear install` → primer
  token, ~24 s. Verificado cross-máquina.
- **Persistencia y archivos: cerrado.** Directorio Hyperbee (los nodos se
  acuerdan de a quién vieron aunque no esté online ahora) + Hyperdrive
  (`send`/`fetch`/`files`).
- **Fase 4 (el install es la demo): construida**, falta cronometrar el
  swarm-join aparte del install en la segunda máquina.
- **Distribución sin dependencias: cerrado.** Binarios standalone para 5
  plataformas publicados en
  [v0.10.0](https://github.com/gazzimon/qvac_node/releases/tag/v0.10.0), más
  instaladores de una línea. Ya no hace falta Node ni Pear para probar la app.
- **Chat-first y puerta de lanzamiento: cerrado.** La app abre en el chat, el
  agente se lanza desde la propia página (join al swarm en caliente, sin
  reiniciar el proceso) y la red exige tenerlo lanzado.
- **Fase 6 (ledger y liquidación): fuera de alcance** de este track — necesita
  Autobase y decisiones de gobernanza, no solo código.

**Qué es simulado**, para que nadie lo descubra solo:

- `serve` arranca con el registro **vacío**. `--demo` lo puebla con 1 nodo real
  + 3 mocks marcados como `simulado`.
- `economic` del manifiesto es mock (wallet en ceros, con `_mock: true`
  explícito). WDK, recibos y liquidación no están implementados. `directory`
  **no** es mock: ahí se firma la clave real del Hyperbee.
- Elegir nodo por carga (D6) no está implementado; se prefiere el par remoto
  sobre el local y, entre varios, el primero. `Auto` en el chat es eso, no una
  subasta: el precio todavía no participa del ruteo.
- **El precio no es comparable todavía.** Viaja estructurado en el manifiesto,
  pero lo llena una constante: todos los nodos anuncian el mismo número. Por eso
  el chat no muestra cuánto costó cada respuesta — un costo inventado sería peor
  que ninguno.
- Las API keys viven en memoria del proceso: no persisten, sin scopes.
- El login por rol (`qvac/auth.mjs`) **no está conectado a ninguna ruta**: es
  código muerto, no un gate.
- Los instaladores están verificados en Windows; los caminos de macOS y Linux
  están escritos pero no ejecutados end-to-end.
- El nodo que infiere ve el prompt en texto plano. El claim es "ninguna
  corporación centralizada agrega tus datos a escala", no "nadie más lo ve":
  el cifrado E2E está fuera de alcance.

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 · `bare-http1` 4.5.8 ·
`protomux` 3.11 + `corestore` 7.12 + `hyperbee` 2.27 + `hyperdrive` 13.3

## Licencia

Apache-2.0 · [gazzimon](https://github.com/gazzimon)

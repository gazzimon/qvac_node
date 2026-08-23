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

```bash
npm i -g pear
pear install pear://8f789f6hsf4ghymku5eqwqmbqiubiigp8xpy6boiymunnbyznpny
pyrusllm --help
```

Sin `npm install` del proyecto, sin build, sin repo que clonar: el canal de
distribución **es** la red P2P. El binario trae el motor de inferencia adentro
y se actualiza solo, en ~10 s, sin que el usuario haga nada.

## Uso

```bash
pyrusllm prompt "¿Qué es una red peer-to-peer?"     # inferencia 100% local
pyrusllm serve --swarm --operator "Mi Nodo"          # gateway + proveedor, se une a la red
pyrusllm peers --operator "Mi Nodo" --timeout 90     # verificar que se descubre con otro nodo
pyrusllm send ./plano.pdf                            # publicar un archivo (link qvac://)
pyrusllm fetch qvac://<clave>/plano.pdf              # bajarlo en la otra máquina
```

`serve --swarm` levanta gateway y proveedor en un solo proceso, en
`http://localhost:8787`, con tres paneles (`/` cliente, `/proveedor`,
`/admin`) y la API:

```
GET  /v1/models                 catálogo, formato OpenAI estricto
POST /v1/chat/completions       { model, messages[], stream } -> SSE o JSON
GET  /v1/nodes                  vista rica del marketplace
POST /v1/connection/:id         credencial para un cliente externo
GET  /v1/files · POST /upload · POST /fetch     archivos entre nodos (Hyperdrive)
```

El botón **Conectar** de cada nodo en el panel emite una API key y muestra los
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
- **Fase 6 (ledger y liquidación): fuera de alcance** de este track — necesita
  Autobase y decisiones de gobernanza, no solo código.

**Qué es simulado**, para que nadie lo descubra solo:

- `serve` arranca con el registro **vacío**. `--demo` lo puebla con 1 nodo real
  + 3 mocks marcados como `simulado`.
- `economic` del manifiesto es mock (wallet en ceros, con `_mock: true`
  explícito). WDK, recibos y liquidación no están implementados. `directory`
  **no** es mock: ahí se firma la clave real del Hyperbee.
- Elegir nodo por carga (D6) no está implementado; se prefiere el par remoto
  sobre el local y, entre varios, el primero.
- Las API keys viven en memoria del proceso: no persisten, sin scopes.
- El nodo que infiere ve el prompt en texto plano. El claim es "ninguna
  corporación centralizada agrega tus datos a escala", no "nadie más lo ve":
  el cifrado E2E está fuera de alcance.

## Desarrollo

```bash
npm install
npm start          # local con bare, sin updates
npm test           # brittle-bare test/index.js
npm run release     # build + stage, las 5 plataformas
```

| Archivo | Qué resuelve |
| --- | --- |
| [bin.mjs](bin.mjs) | CLI: `prompt`, `serve`, `peers`, `send`, `fetch`, `files` |
| [qvac/engine.mjs](qvac/engine.mjs) | LLM local sobre `@qvac/llm-llamacpp` |
| [qvac/manifest.mjs](qvac/manifest.mjs) | Ed25519 sobre JCS, firma y verificación |
| [qvac/swarm.mjs](qvac/swarm.mjs) | topic, Protomux, `chat:*` |
| [qvac/directory.mjs](qvac/directory.mjs) | Hyperbee de manifiestos vistos |
| [qvac/files.mjs](qvac/files.mjs) | Hyperdrive, links `qvac://` |
| [qvac/gateway.mjs](qvac/gateway.mjs) | HTTP, ruteo, SSE en formato OpenAI |
| [qvac/pages.mjs](qvac/pages.mjs) | los tres paneles |
| [workers/main.js](workers/main.js) | updater OTA, en su propio hilo |

## Stack

`bare` 1.31 · `pear-runtime` 1.3.1 · `hyperswarm` 4.17 · `hypercore` 11.35 ·
`@qvac/bare-sdk` 0.17.1 + `@qvac/llm-llamacpp` 0.46.0 · `bare-http1` 4.5.8 ·
`protomux` 3.11 + `corestore` 7.12 + `hyperbee` 2.27 + `hyperdrive` 13.3

## Licencia

Apache-2.0 · [gazzimon](https://github.com/gazzimon)

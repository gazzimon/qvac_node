# PyrusLLM — Roadmap Fase 7→12 · x402, liquidación y capa agéntica

Asume las Fases 0–4 cerradas y el estado que declara el [README](README.md):
distribución P2P, inferencia local, gateway compatible con OpenAI, manifiesto
firmado, swarm, persistencia y archivos. Este documento arranca donde el
[ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md) se detiene: la Fase 6 (ledger y
liquidación) quedó fuera de alcance por track, y con ella quedaron sin dueño
tres deudas que el propio README enumera — `economic` es mock, el precio no es
comparable, y el precio no participa del ruteo.

**Regla del documento, heredada del anterior:** cada decisión tiene contexto,
opciones consideradas y **la que recomiendo**. No quedan preguntas abiertas para
resolver bajo presión. Si el equipo prefiere la otra opción, lo importante es
que quede escrita _una_ antes de tocar código, no cuál.

**Regla de honestidad, también heredada:** todo mock nuevo se marca donde se
vea — en el código que lo arma, en el README y en el propio artefacto. Un
`X-PAYMENT-RESPONSE` con un tx hash inventado sería exactamente la falla que se
ve idéntica a que funcione, y es la única forma de perder por deshonestidad en
vez de por alcance.

---

## 0 · De qué se parte

Lo que ya está construido y sobre lo que se apoya todo lo que sigue:

| Pieza | Estado | Por qué importa acá |
| --- | --- | --- |
| `handleChat` en [qvac/gateway.mjs:702](qvac/gateway.mjs#L702) | Cerrado | **Único plano HTTP del sistema.** Es el punto de inserción del 402, y es uno solo. |
| Bloque `economic` en [qvac/manifest.mjs](qvac/manifest.mjs) | Mock marcado (`_mock`) | El schema **ya previó WDK**. No hay que subir `schemaVersion`. |
| [manifest-v0.json:84](manifest-v0.json#L84) | Congelado | Dice textualmente que `economic.walletAddress` es la identidad de COBRO y firma los recibos, y que es **distinta** de la clave de red. El diseño ya está escrito. |
| `pushLog` en [qvac/gateway.mjs:855](qvac/gateway.mjs#L855) | Cerrado | Ya cuenta `tokens`, `ttftMs`, `ms` por request. **La medición del cobro ya existe**, falta ponerle precio. |
| [qvac/apikeys.mjs](qvac/apikeys.mjs) | En memoria, sin scopes | Auth actual por `Authorization: Bearer`. x402 no lo reemplaza: convive (D16). |
| Protomux en [qvac/swarm.mjs](qvac/swarm.mjs) | Cerrado | `manifest:announce` / `node:status` / `chat:request`. Sumar tipos de pago es agregar casos, no protocolo nuevo. |
| [qvac/identity.mjs](qvac/identity.mjs) | Cerrado | Guarda la semilla de red **en claro**. Suficiente para una clave de red; insuficiente para una wallet (D13). |
| [old/PROMPT_CAPA-AGENTICA_DESCARTADO.md](old/PROMPT_CAPA-AGENTICA_DESCARTADO.md) | Diseñado, **no implementado** | La capa agéntica está pensada entera y descartada solo por elegibilidad del hackathon. Es recuperable tal cual (Fase 11). |
| [deck/TrustGap.dc.html](deck/TrustGap.dc.html) y [deck/Enclave.dc.html](deck/Enclave.dc.html) | Escrito | Ya plantean el problema del centro que ve las dos puntas y la forma del trabajo confidencial. Es la base del Track V. |

**Deudas declaradas en el README que este roadmap cierra:** `economic` mock, el
precio no comparable, el precio ausente del ruteo, y la Fase 6 sin dueño.

---

## 0-bis · Las cuatro restricciones que deciden el diseño

Estas no son decisiones: son hechos del entorno. Todo lo de abajo sale de acá.

### R1 — Corremos `bare`, no Node

`bin.mjs` corre bajo `bare` y el árbol de dependencias es `bare-*`.
**`@x402/express` es inutilizable**: el gateway es `bare-http1`, no hay Express
ni middleware chain. Lo que sí sirve es `@x402/core` + `@x402/evm`, que son
agnósticos de framework, cableados a mano al handler.

Queda por verificar que corran bajo Bare — dependen de criptografía secp256k1 y
probablemente de `viem`. Es el riesgo #1 y tiene un spike propio (D11). El
camino oficial de escape existe y es de Tether:
[`@tetherto/pear-wrk-wdk`](https://github.com/tetherto/pear-wrk-wdk), un worklet
Bare que corre el stack WDK en un hilo aparte con puente HRPC — exactamente la
forma que el proyecto ya usa para el updater OTA.

### R2 — x402 es HTTP; el transporte interno no lo es

D1 del roadmap anterior decidió Protomux sobre Hyperswarm, sin `baseUrl`
alcanzable. Entonces hay **dos planos de pago distintos y no se mezclan**:

- **Plano externo (HTTP):** cliente → gateway. Ahí vive el 402 y el `X-PAYMENT`.
- **Plano interno (P2P):** gateway → proveedor. Ahí viaja un **recibo firmado**,
  no un pago.

Confundirlos lleva a intentar meter HTTP dentro del canal P2P, que es
precisamente lo que D1 descartó por escrito.

### R3 — El costo real se conoce *después* de responder

El esquema `exact` de x402 cobra un monto fijo declarado **antes**. Un LLM no
sabe cuántos tokens va a generar. Esto no tiene solución elegante: hay que
elegir (D9), y la elección hay que declararla en el 402 para que sea honesta.

### R4 — Con `stream: true`, el recibo llega tarde

x402 devuelve el settlement en el header `X-PAYMENT-RESPONSE`, pero en SSE los
headers salen **antes** del primer token. Liquidar antes de streamear mete la
latencia de una transacción on-chain delante del TTFT, que es la métrica del
pitch. Ver D12.

---

## 1 · Decisiones bloqueantes

Numeración continuada del roadmap anterior, que llegó hasta D7.

### D8. Dónde vive el 402

**Problema:** el pago tiene que ocurrir en algún punto del camino
cliente → gateway → proveedor, y solo un tramo de ese camino habla HTTP.

**Opciones:** (a) en el gateway, sobre `/v1/chat/completions`; (b) en cada nodo
proveedor.

**Decisión: (a), el gateway.** Es el único que habla HTTP. El nodo proveedor no
tiene puerto alcanzable desde afuera — esa es toda la razón por la que existe
D1. Ponerle 402 al nodo obligaría a inventar un transporte HTTP sobre el canal
P2P, que es trabajo nuevo para resolver un problema que ya está resuelto del
otro lado.

**Impacto si no se decide:** alguien intenta cobrar en el nodo, descubre a mitad
de camino que no hay dónde escuchar, y el trabajo se tira.

---

### D9. Esquema de cobro (R3)

**Problema:** `exact` cobra un monto fijo declarado antes de generar. El costo
real depende de los tokens de salida, que no se conocen hasta terminar.

**Opciones:** (a) `exact` por request a precio fijo con `max_tokens` acotado;
(b) saldo prepago descontado por uso real; (c) cobro ex-post por tokens reales.

**Decisión: (a) en la Fase 9, (b) en la Fase 10.** (c) no existe en el esquema
`exact` de x402 y construirlo sería salirse del stack. (a) es honesto **si el
402 declara el tope**: el `accepts[]` dice "hasta N tokens de salida por $X" y
el gateway aplica ese `max_tokens` aunque el cliente no lo mande. (b) es lo que
el schema ya llama `prepaid-balance` y es el modo correcto para un agente que
hace 200 llamadas.

**Condición no negociable:** si el gateway recorta la respuesta por el tope, el
`finish_reason` tiene que decir `length`, no `stop`. Cobrar por un tope y
reportar terminación normal es mentir en el único campo que el cliente mira.

**Impacto si no se decide:** el precio del 402 se elige en vivo y termina siendo
un número inventado que no corresponde a nada.

---

### D10. Quién cobra: el gateway o el proveedor

**Problema:** el `payTo` del 402 tiene que apuntar a una dirección. Puede ser la
del gateway (que después reparte) o la del proveedor elegido.

**Opciones:** (a) el gateway cobra y liquida al proveedor; (b) `payTo` apunta
**directo a la wallet del par elegido**.

**Decisión: (b), y no es solo técnico.** El README promete *"ni un tercero que
se quede con el margen"*. Si el gateway cobra y reparte, el proyecto es
OpenRouter con más pasos, y el argumento entero del pitch se cae. Con `payTo`
directo, el gateway arma el 402 con la wallet que vino en el manifiesto
**firmado** del proveedor — y la firma Ed25519 sobre JCS es justamente lo que
prueba que esa wallet pertenece a ese nodo. La pieza que hace esto posible ya
está construida desde la Fase 2.

**Consecuencia que hay que aceptar:** el gateway no puede garantizar el cobro de
nadie más que de sí mismo cuando sirve local. Es correcto: no es un custodio.

**Impacto si no se decide:** se implementa el camino cómodo (el gateway cobra) y
después es un refactor con implicancias de producto, no de código.

---

### D11. Runtime de la wallet (R1)

**Problema:** WDK y `@x402/*` están escritos para Node. Este proyecto corre bajo
Bare y se distribuye como binario standalone que **no requiere Node instalado**.

**Opciones:** (a) `@tetherto/wdk-wallet-evm` directo bajo Bare; (b) worklet
`@tetherto/pear-wrk-wdk`; (c) sidecar Node.

**Decisión: spike de 2h que decide entre (a) y (b). (c) solo si las dos
fallan.** El spike es concreto y su resultado es binario:

```
1. bare -e "import('@tetherto/wdk-wallet-evm').then(m => console.log(Object.keys(m)))"
2. derivar una cuenta desde una seed phrase de prueba
3. firmar un EIP-3009 transferWithAuthorization OFFLINE (sin red, sin RPC)
4. lo mismo para @x402/core y @x402/evm
```

Si los cuatro pasan, es (a). Si fallan por dependencias nativas o de
`node:crypto`, es (b) — que además es el camino oficial de Tether para
exactamente este caso. (c) rompe la promesa de "el binario trae todo adentro":
sería un retroceso de producto, no solo de código, y hay que decirlo en el
README si se llega ahí.

**Impacto si no se decide:** es la decisión que define el calendario de las
Fases 7 a 12 enteras. **Se corre antes que cualquier otra cosa de este
roadmap.**

---

### D12. El recibo en modo stream (R4)

**Problema:** en SSE los headers salen antes del primer token, y el settlement
de x402 viaja en un header.

**Opciones:** (a) liquidar antes del primer chunk y mandar
`X-PAYMENT-RESPONSE` normal; (b) **verificar** antes (barato, sin blockchain),
servir, **liquidar después**, y emitir el recibo como **evento SSE final** más
un `GET /v1/receipts/:id` para recuperarlo.

**Decisión: (b), documentando la desviación del spec.** (a) mete la latencia de
una transacción on-chain delante del TTFT, que es el número que el proyecto
mide, publica y usa para vender. La verificación —que es la parte que protege al
proveedor de gastar GPU gratis— sí es sincrónica y no toca la cadena.

En el camino **no-stream** no hay problema: `X-PAYMENT-RESPONSE` normal, porque
la respuesta se arma entera antes de escribir nada.

**Condición:** la desviación se documenta en el README y en la respuesta misma.
Un cliente x402 estándar que no encuentre el header tiene que poder enterarse de
por qué, no quedarse esperando.

**Impacto si no se decide:** se implementa (a) sin pensarlo, el TTFT de la demo
se triplica, y el mejor número del proyecto desaparece.

---

### D13. Custodia de la seed de la wallet

**Problema:** [qvac/identity.mjs](qvac/identity.mjs) guarda la semilla de 32
bytes **en claro** en `identity.json`. Para una clave de red está perfecto —
comprometerla permite suplantar a un nodo, no robar plata. Para una wallet con
USD₮ real, no alcanza.

**Decisión: seed de wallet separada, nunca derivada de la identidad de red**,
cifrada en reposo o delegada al secret manager de WDK. El schema congelado ya
declara que son dos claves distintas ([manifest-v0.json:84](manifest-v0.json#L84));
la decisión acá es que esa separación **también existe en disco**, no solo en el
documento.

**Regla operativa:** no se fondea ninguna wallet hasta que esto esté hecho. No
es una tarea de endurecimiento posterior — es la precondición de la Fase 9.

**Impacto si no se decide:** se fondea una wallet cuya clave está en claro en el
directorio de datos de una app que se distribuye por P2P.

---

### D14. Facilitator

**Problema:** el settlement necesita un facilitator que verifique firmas y
empuje las transacciones.

**Opciones:** (a) el hosted de Semantic (`x402.semanticpay.io`);
(b) self-hosted con `@semanticio/wdk-wallet-evm-x402-facilitator`.

**Decisión: (a) hasta la Fase 10.** El self-hosted está **en beta** según la
propia documentación, necesita una wallet adicional fondeada con gas nativo, y
agrega un componente que el equipo no controla al camino crítico de la primera
demo que cobra de verdad.

**Lo que hay que decir en voz alta:** la documentación de WDK aclara que Tether
*"does not endorse, operate, or assume legal or financial responsibility for any
third-party facilitator"*. Eso va en el README junto al resto de las
advertencias, no escondido.

**Cuándo se revisa:** en la Fase 10, o antes si D17 se activa.

---

### D15. Chain

**Problema:** x402 requiere una EVM con USD₮0 desplegado y soporte de EIP-3009.

**Decisión: Plasma (`eip155:9745`) como default, Stable (`eip155:988`) como
fallback.** Fees casi nulos, finalidad casi instantánea, y son las dos que el
facilitator hosted soporta. `chains: ['plasma', 'stable']` pasa el pattern
kebab-case del schema **sin tocarlo**, que era la condición de D2.

**Nota sobre plata real:** Plasma no es una testnet. Se empieza con montos de
$0.001 y una wallet con USD 2. El riesgo está acotado por el monto, no por el
entorno, y eso hay que saberlo antes de la primera corrida (riesgo #2).

---

### D16. Convivencia con las API keys

**Problema:** [qvac/apikeys.mjs](qvac/apikeys.mjs) ya autentica clientes
externos. Un segundo mecanismo de acceso puede volverse contradictorio.

**Decisión: tres caminos que no se pisan.**

| Camino | Condición | Qué pasa |
| --- | --- | --- |
| `local: true` | siempre | Gratis, sin red, sin pago. La excepción del README se mantiene. |
| `Authorization: Bearer qvac_sk_…` | key emitida por el panel | Cuenta con saldo prepago (Fase 10). |
| Sin key ni saldo | default | **402.** |

El 402 es el **default para desconocidos**, que es exactamente lo que un agente
necesita para consumir sin registrarse en nada. Las keys siguen siendo el camino
del humano que ya configuró un bot y no quiere volver a pensar en esto.

---

### D17. Dónde vive la liquidación si VELA entra

**Problema:** WDK recomienda Plasma con facilitator hosted (D15). VELA vive en
Base Sepolia y en Horizen Chain, un L3 sobre Base. Si el Exitpoint de VELA tiene
que disparar el pago, la liquidación tiene que estar donde VELA puede tocarla.

**Decisión: no se cierra ahora.** Se cierra recién si Horizen acepta el early
access. Hasta entonces, Plasma + hosted, que es más barato de probar y no
compromete nada.

**Lo que ya se sabe para cuando haya que cerrarla:** el facilitator self-hosted
soporta cualquier EVM con USD₮0 desplegado, así que mover la liquidación a Base
es posible — al precio de activar D14(b), que está en beta. Es un costo
conocido, no una incógnita.

**Impacto si no se decide a tiempo:** se construye la liquidación en una cadena
y hay que rehacerla en otra. Por eso el Track V no toca la liquidación hasta que
esta decisión esté cerrada.

---

## 2 · Fases

### Fase 7 — Desmockear `economic` (~1 día)

Wallet real generada por WDK, `walletAddress` dentro del manifiesto **firmado**,
el `_mock` afuera, y `/node` mostrando la dirección de cobro del propio nodo.

**No se cobra nada todavía.** Esta fase solo hace que el manifiesto diga la
verdad.

**DoD:**

- Dos nodos anuncian direcciones distintas y un par remoto verifica la firma.
- El manifiesto valida contra `manifest-v0.json` **sin tocar el schema**.
- El README pierde la línea que dice que `economic` es mock.
- D13 está implementado: la seed de la wallet no está en claro.

---

### Fase 8 — Precio comparable y precio que rutea (~1 día)

El precio deja de ser una constante igual en todos los nodos. Se deriva del
benchmark real que [qvac/provider.mjs:243](qvac/provider.mjs#L243) ya calcula
(tokens/s, TTFT) y entra al ruteo junto con la carga, cerrando D6 del roadmap
anterior, que sigue pendiente.

**DoD:**

- `Auto` elige por precio y latencia, y el log de ruteo **dice por qué** — no
  "primero de N candidatos".
- El chat muestra el costo estimado de cada respuesta.
- El README pierde las dos líneas de "el precio no es comparable" y "elegir nodo
  por carga no está implementado".

**Esta fase vale sola.** Si x402 se cae entero por D11, la 7 y la 8 siguen
siendo trabajo bueno que cierra deudas declaradas.

---

### Fase 9 — x402 en el borde (~2-3 días) ← el hito técnico

`402 Payment Required` sobre `/v1/chat/completions`, con el `accepts[]` armado
desde el manifiesto firmado del nodo elegido (D10), `X-PAYMENT` verificado
contra el facilitator antes de gastar GPU, y settlement posterior a la respuesta
(D12).

**DoD:**

- Un `curl` sin pago recibe un 402 legible que dice cuánto, a quién, en qué
  cadena y **hasta cuántos tokens** (D9).
- El mismo request con `@x402/fetch` devuelve tokens y un tx hash **visible en
  el explorer de Plasma**.
- Matar el nodo a mitad de stream no cobra: la verificación protege al
  proveedor, la falta de settlement protege al cliente.

---

### Fase 10 — Recibos y liquidación en lote (~2 días)

El recibo firmado por la wallet (no por la clave de red) viaja por Protomux al
proveedor, que los acumula. Cierra `settlement: 'batch-receipts'`, que el schema
declara desde el día uno.

**El insight que hace que esto sea barato:** la firma EIP-3009 **ya es el
recibo**. Es una autorización firmada off-chain que no obliga a liquidar en el
momento. Verificar sincrónico → servir → liquidar en lote es el mismo flujo de
la Fase 9 con el settlement diferido, no un mecanismo nuevo.

**Y esto es lo que mata la Fase 6:** con liquidación on-chain no hace falta un
ledger multi-escritor propio. Autobase sale del roadmap. Es alcance que se
borra, no que se agrega.

---

### Fase 11 — La capa agéntica que paga (~2-3 días) ← el pitch

Se rescata [old/PROMPT_CAPA-AGENTICA_DESCARTADO.md](old/PROMPT_CAPA-AGENTICA_DESCARTADO.md)
tal como está —agente documental, extracción validada con zod, confianza por
campo, `needs_review` explícito, `eval` publicando los fallos— y se le suma lo
que antes no podía tener: **presupuesto**.

```
pyrusllm agent ./facturas --budget 0.50
```

Gasta USD₮ real contra nodos que nunca vio, y el audit trail dice cuánto costó
cada campo extraído y qué máquina lo cobró.

Acá se juntan las dos mitades del proyecto: **un agente autónomo que compra
inferencia de proveedores desconocidos, sin registrarse en ninguno, pagando por
HTTP.** El agente no necesita correr bajo Bare —habla el protocolo de OpenAI
como cualquier cliente—, así que esta fase no toca el pipeline de distribución.

**DoD:** el agente se queda sin presupuesto a mitad de un lote y **para**,
diciendo cuánto procesó y cuánto le faltó. Un agente que se pasa del presupuesto
es peor que uno que no arranca.

---

### Fase 12 — MCP toolkit (~1-2 días, opcional)

`@tetherto/wdk-mcp-toolkit` expone la wallet del nodo como herramientas MCP
(balance, send, swap) con elicitations para aprobación humana explícita antes de
cualquier broadcast. Encaja con `security.toolCallPolicy` del manifiesto, que
hoy está en `allowlist` con la lista vacía.

Es upside, no criterio. Se corta primero si aprieta el reloj.

---

## 3 · Track V — VELA / Horizen (paralelo, no camino crítico)

### Por qué VELA no puede tocar la inferencia

VELA es WASM dentro de **AWS Nitro Enclaves**. Tres problemas, en orden de
gravedad:

1. **Contradice la tesis.** El README promete *"un marketplace de inferencia sin
   datacenter en el medio"*. Meter el cómputo en un enclave de Amazon es poner
   el datacenter en el medio. Quien lea las dos cosas juntas lo nota.
2. **No hay GPU ni forma de cargar los pesos.** Nitro Enclaves no tiene
   aceleración, y QVAC/`llama-cpp` es nativo, no WASM. Portar el motor a WASM
   attestado no es integrar: es otro proyecto.
3. **No hay streaming.** VELA es `request → cola en Entrypoint → ejecuta →
   attestation → Exitpoint`: un ciclo on-chain por job. El producto vende TTFT y
   SSE.

[deck/Enclave.dc.html](deck/Enclave.dc.html) ya lo dice mejor: *"matching… sits
on the latency critical path. A round trip to the enclave per request may simply
not be viable."*

### Dónde VELA sí vale

El agujero real de la arquitectura no es la inferencia: es **quién computa
cuánto se le debe a cada proveedor sin ver todo**. Hoy ese lugar está vacío, y
la Fase 6 fue el intento de llenarlo. Un nodo que reporta 900 tokens cuando
sirvió 400 no tiene hoy quién lo contradiga — `recordPeerResult` en
[qvac/store.mjs:469](qvac/store.mjs#L469) le cree.

Los tres jobs que van adentro son deterministas y asíncronos, o sea que caben en
la forma nativa de VELA (*"the WASM-job-with-onchain-settlement shape"*, según
el propio deck):

| Job | Qué resuelve | Reemplaza a |
| --- | --- | --- |
| **metering** | recomputa el consumo desde el transcripto, no desde lo que el nodo afirma | nada — hoy no existe |
| **settlement** | agrega recibos por proveedor y liquida en lote | Fase 6 / Autobase |
| **reputation** | puntaje desde recibos firmados y spot-checks aleatorios | el mock de reputación |

### Fases del track

| # | Qué | Depende de |
| --- | --- | --- |
| **V1** | **Aplicación a Horizen con el deck como está.** Las slides 05 y 06 ya plantean el problema y proponen la clave efímera por request, marcado como *"the open question we bring, not a promise"*. Esa postura es la correcta y **no necesita código de VELA para aplicar**. | nada — ya está escrito |
| **V2** | Metering en enclave: recomputar el consumo desde el transcripto | Fase 10 + acceso a VELA + D17 |
| **V3** | Settlement y reputación en enclave | V2 |

**La acción que bloquea todo lo demás:** VELA está en closed beta y se entra por
formulario de early access. Es la única parte del calendario que **no depende
del equipo**. Se aplica primero y se sigue con las Fases 7–9 mientras tanto —
V2 y V3 no arrancan sin esa aprobación, y las fases del camino crítico no la
necesitan.

---

## 4 · x402 frente a "solo carga de crédito"

Queda escrito acá porque es la pregunta que va a volver.

Lo que decide el asunto es **quién paga**:

- Un **humano** carga crédito: abre una pantalla, conecta una wallet, aprueba.
  Eso no necesita x402.
- Un **agente** no puede hacer nada de eso. No tiene pantalla, ni cuenta, ni con
  quién registrarse.

Y el punto que cierra la discusión: **la red es de proveedores desconocidos.**
El descubrimiento es P2P y cualquiera entra al swarm mañana. Si la única forma
de pagar es cargar crédito, hay que cargar crédito **con cada nodo nuevo que
aparece** — o poner a alguien que agregue el saldo de todos. Ese alguien es
exactamente el intermediario que el README dice que no existe. **No hay tercera
opción.**

Las dos cosas terminan siendo la misma pieza en dos escalas:

| Caso | Mecanismo | Qué es en el stack |
| --- | --- | --- |
| Cliente ocasional, un request | x402 `exact`, se liquida | la puerta |
| Agente, 200 requests | una autorización firmada mayor = **el crédito**, medido por uso | el pasillo |

La carga de crédito es correcta, y se **funda con una firma x402** en vez de con
un registro. Eso es lo que la mantiene sin intermediario.

**Sobre "no inventemos nada":** x402 **es** el camino oficial de WDK
(`docs.wdk.tether.io/ai/x402/`, sobre `@tetherto/wdk-wallet-evm`). Un flujo de
cobro propio sería el invento.

---

## 5 · Riesgos

| # | Riesgo | Cómo se mide | Plan B |
| --- | --- | --- | --- |
| 1 | **WDK/x402 no corre bajo Bare** | El spike de D11, cuatro pasos, resultado binario | Worklet `pear-wrk-wdk` → sidecar Node como último recurso, declarado en el README |
| 2 | **Plata real en mainnet** (Plasma no es testnet) | Montos de $0.001 y una wallet con USD 2 | Facilitator self-hosted contra una EVM testnet con USD₮0 |
| 3 | El settle falla **después** de que el nodo ya gastó GPU | Contar fallos de settle en el log de ruteo | Verificación estricta previa + montos chicos; la reputación por par ya existe en `recordPeerResult` |
| 4 | La seed de la wallet queda en claro como la de red | Revisión de D13 antes de fondear nada | No fondear hasta que esté cifrada. No es negociable |
| 5 | Dependencia de un facilitator de terceros que Tether **no** respalda | — | Self-hosted, ya presupuestado en la Fase 10 |
| 6 | VELA no da early access, o lo da tarde | Aplicar primero y seguir sin esperar | El Track V es paralelo justamente por esto: nada del camino crítico lo espera |

---

## 6 · Lo que sale del alcance

- **Autobase / ledger multi-escritor propio.** La Fase 10 lo vuelve innecesario:
  la liquidación es on-chain. Es la mejor noticia de este análisis — alcance que
  se borra.
- **Cobrar por `/v1/files/fetch`.** Es el mismo mecanismo pero duplica la
  superficie de prueba sin agregar nada al pitch. Después de la Fase 12, si
  acaso.
- **Inferencia dentro del enclave.** Por las tres razones de la sección 3.

---

## 7 · Tabla resumen — orden de ejecución

| Orden | Qué | Por qué ahí |
| --- | --- | --- |
| 0 | **Aplicar al early access de VELA** | Es lo único que no controlamos. Se dispara y se sigue trabajando |
| 1 | **Spike de D11** | Define el calendario de las seis fases siguientes |
| 2 | Fase 7 — desmockear `economic` (incluye D13) | Precondición de todo cobro |
| 3 | Fase 8 — precio comparable y que rutea | Vale sola aunque x402 se caiga |
| 4 | Fase 9 — x402 en el borde | El hito técnico |
| 5 | Fase 10 — recibos y lote | Mata la Fase 6 |
| 6 | Fase 11 — capa agéntica con presupuesto | El pitch |
| 7 | Fase 12 — MCP toolkit | Upside; se corta primero |
| — | V2/V3 — enclave | Cuando haya acceso y D17 esté cerrada |

### Decisiones a cerrar

| #   | Decisión | Bloquea |
| --- | --- | --- |
| D8  | El 402 vive en el gateway, no en el nodo | Fase 9 |
| D9  | `exact` con tope declarado (Fase 9) → prepago (Fase 10); `finish_reason: length` si se recorta | Fase 9 |
| D10 | `payTo` directo a la wallet del proveedor, tomada del manifiesto firmado | Fase 9 |
| D11 | Runtime de la wallet: spike decide entre Bare directo y worklet | **Fases 7–12** |
| D12 | Verificar sincrónico, liquidar después, recibo como evento SSE final | Fase 9 |
| D13 | Seed de wallet separada de la de red y cifrada; no fondear antes | Fase 7 |
| D14 | Facilitator hosted hasta la Fase 10 | Fase 9 |
| D15 | Plasma default, Stable fallback; `chains` kebab-case sin tocar el schema | Fase 7 |
| D16 | Tres caminos de acceso: local gratis, key con saldo, desconocido con 402 | Fase 9 |
| D17 | Cadena de liquidación si VELA entra — **se cierra recién con el early access** | V2 |

---

## 8 · Item abierto

**La fecha de cierre de la aplicación a Horizen no está en este documento porque
no la sé.** Cambia un solo orden, no el plan:

- **Cierra en menos de dos semanas:** las Fases 7 y 8 se hacen igual (valen
  solas, y desmockear `economic` refuerza la aplicación), la Fase 9 se corre, y
  el esfuerzo va a pulir la narrativa del enclave para V1.
- **Hay más aire:** el orden de la sección 7 queda tal cual.

Es lo único de este roadmap que espera un dato de afuera.

---

## Fuentes

- [WDK — x402](https://docs.wdk.tether.io/ai/x402/) · [Node.js & Bare Quickstart](https://docs.wdk.tether.io/start-building/nodejs-bare-quickstart/) · [Arquitectura del SDK](https://docs.wdk.tether.io/sdk/get-started/) · [MCP Toolkit](https://docs.wdk.tether.io/ai/mcp-toolkit/) · [Agent Skills](https://docs.wdk.tether.io/ai/agent-skills/)
- [tetherto/pear-wrk-wdk](https://github.com/tetherto/pear-wrk-wdk)
- [Horizen Labs — VELA](https://horizenlabs.io/vela/) · [docs.horizen.io/vela](https://docs.horizen.io/vela/introduction) · [HorizenOfficial/vela](https://github.com/HorizenOfficial/vela)

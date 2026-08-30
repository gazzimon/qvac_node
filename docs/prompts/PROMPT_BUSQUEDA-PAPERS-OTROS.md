# Búsqueda de papers — versiones para otros modelos

Complemento de [PROMPT_BUSQUEDA-PAPERS.md](PROMPT_BUSQUEDA-PAPERS.md), que está
afinado para Perplexity. Acá va lo mismo adaptado al resto.

**Las 14 preguntas son idénticas en todas las versiones, a propósito.** Es lo que
permite comparar respuestas entre herramientas y detectar cuál inventó y cuál
encontró de verdad: si tres modelos traen el mismo paper para A1, existe; si cada
uno trae uno distinto y ninguno se repite, sospechá de los tres.

---

## 1 · Prompt portable

Sirve en ChatGPT Deep Research, Gemini Deep Research, Claude con investigación
activada, Grok DeepSearch y DeepSeek. Pide más que la versión de Perplexity
porque estas herramientas corren más tiempo: acá además se les exige criterio,
no solo recolección.

```
Necesito una revisión de literatura para decisiones de ingeniería. Papers
académicos revisables — arXiv, IEEE, ACM, USENIX, MLSys, NeurIPS/ICML, NDSS,
IEEE S&P, CCS, PETS. No blogs, no whitepapers de proyectos cripto, no notas de
prensa. Rango 2023 en adelante, salvo que algo anterior siga siendo el estado
del arte; en ese caso incluilo y aclarálo.

No me hagas preguntas de aclaración antes de empezar: todo lo que necesitás
saber está abajo. Si algo queda ambiguo, elegí la interpretación más útil para
un equipo que tiene que decidir qué construir, y decí qué asumiste.

## CONTEXTO

Diseño un marketplace descentralizado de inferencia LLM. Nodos P2P que anuncian
un manifiesto firmado, gateway compatible con el protocolo de OpenAI, pagos por
HTTP con stablecoin, y la intención de mover la capa económica —matching,
medición de consumo, liquidación y reputación— adentro de un entorno de ejecución
confiable (TEE), de modo que ni el operador del protocolo pueda vincular quién
pidió qué con quién lo respondió. Los proveedores son hardware heterogéneo y
ocioso: máquinas que se apagan, mienten sobre su capacidad y se van a mitad de
un pedido.

## YA ANALIZADO — no los traigas de vuelta ni los resumas

- arXiv 2510.02395 (PolyLink) — evaluación de calidad con cross-encoder +
  LLM-as-a-Judge, comité de validadores con VRF y slashing.
- arXiv 2501.14784 (DeServe) — serving batch en alta latencia, KV cache
  offloading, verificación optimista con arbitraje.
- arXiv 2503.04521 (AERIA) — subasta de precio uniforme para inferencia en el
  edge, con incentive compatibility y envy-freeness probadas.
- arXiv 2601.09961 (DCBM) — buyback-and-burn como controlador PID.

Los cuatro dejan sin resolver lo mismo: el matching entre pedido y proveedor
sigue teniendo un dueño que ve las dos puntas, y ninguno aborda la privacidad del
pedido.

## PREGUNTAS

### BLOQUE A — Matching confidencial (máxima prioridad)

A1. Emparejar pedidos con proveedores dentro de un TEE o con cómputo multiparte,
    de forma que el coordinador no pueda vincular solicitante con proveedor.
    Buscá también fuera de IA: matching confidencial en dark pools, ride-hailing
    con privacidad, ad exchanges privados. Me importa la latencia medida y si el
    clearing es por lote o por pedido.

A2. Subastas donde el subastador no aprende las pujas — sealed-bid con MPC o TEE.
    Con overhead y escala reales: cuántos pujadores, cuántos milisegundos.

A3. Tensión entre resistencia a DoS y no-enlazabilidad. Rate limiting anónimo,
    credenciales anónimas, Privacy Pass, rate-limiting nullifiers: proteger al
    proveedor sin identificar al cliente.

### BLOQUE B — Verificación sin re-ejecutar

B1. Verificar QUÉ MODELO se ejecutó, no si la respuesta es buena. Conozco TOPLOC
    (2501.16007) y SPEX (2503.18899), basados en locality-sensitive hashing sobre
    activaciones. ¿Hay algo posterior o mejor? También: fingerprinting de modelos,
    watermarking sobre logits, detección de sustitución por un modelo más chico o
    más cuantizado.

B2. Verificar CUÁNTOS TOKENS se sirvieron, cuando el proveedor reporta el número
    y tiene incentivo a inflarlo. Medición trustless de consumo, facturación con
    pruebas.

B3. Sondas de respuesta conocida inyectadas en tráfico real para auditar
    proveedores: diseño, tasa de muestreo óptima, y cómo evitar que el proveedor
    las distinga del tráfico legítimo. Mirá también crowdsourcing con gold
    standard questions y auditoría de trabajadores en plataformas.

### BLOQUE C — Mercado, precios y confiabilidad

C1. Dobles subastas para recursos de cómputo heterogéneos. Cómo esquivan la
    imposibilidad de Myerson-Satterthwaite: qué propiedad sacrifican y con cuánta
    pérdida de eficiencia medida.

C2. Modelos de costo y unidades de facturación para serving de LLM
    autorregresivo. El paper de subastas que leí usa "FLOPS asignados", que asume
    una sola pasada forward y no aplica: la inferencia autorregresiva son r
    pasadas secuenciales limitadas por ancho de banda de memoria, y el KV cache
    consume memoria proporcional al contexto.

C3. Scheduling con proveedores intermitentes y poco confiables. Churn-tolerant
    scheduling, replicación especulativa, SLA probabilístico sobre infraestructura
    voluntaria.

C4. Cascadas de modelos y routing LLM: modelo chico primero, escalar al grande
    solo si la confianza es baja. Estimación de confianza, ahorro medido, pérdida
    de calidad medida.

### BLOQUE D — Inferencia confidencial y economía real

D1. Estado del arte 2024–2026 de inferencia LLM sobre hardware confidencial CON
    GPU: NVIDIA H100/H200 en modo confidential computing, Intel TDX, AMD SEV-SNP.
    Necesito overhead medido contra el mismo hardware sin CC, y qué queda expuesto
    igual. Descartá FHE y MPC salvo que haya números practicables en modelos de
    7B o más.

D2. Evidencia empírica sobre denominación en stablecoin frente a token nativo en
    redes DePIN o de cómputo compartido: efecto sobre retención de operadores,
    volatilidad del ingreso y adopción. Me interesan sobre todo estudios que
    comparen las dos, no que modelen una.

D3. Costos y márgenes reales de servir modelos abiertos sobre GPU de consumo en
    2025–2026: precios spot, punto de equilibrio, comparación contra APIs
    comerciales. Datos actualizados — lo que tengo usa precios de 2024.

D4. Pagos nativos de HTTP para APIs consumidas por agentes: x402, HTTP 402,
    micropagos por request, autorizaciones firmadas off-chain estilo EIP-3009 con
    liquidación en lote. ¿Hay análisis académico, o solo especificaciones?

## CÓMO QUIERO EL RESULTADO

Agrupado por bloque y pregunta. Por trabajo:

- Título — venue y año — arXiv ID o DOI — link
- Qué resuelve, en dos o tres líneas
- EL NÚMERO QUE IMPORTA: la métrica cuantitativa central. Si el paper no mide
  nada, decilo — es información, no una omisión tuya.
- Repo, si tiene
- Qué le falta para aplicar a mi caso

Y tres cosas que la mayoría de las revisiones omiten y yo necesito:

1. **Contradicciones.** Si dos papers reportan números incompatibles sobre lo
   mismo, marcálo y decí cuál tiene mejor metodología.
2. **Calidad de la evidencia.** Distinguí lo medido sobre hardware real de lo
   simulado, y lo que tiene código público de lo que no. Marcá los papers cuyos
   resultados no puede reproducir nadie.
3. **Los huecos.** Cerrá con la lista de preguntas donde NO encontraste
   literatura relevante, con una línea de por qué creés que no existe. Un hueco
   real es tan útil para mí como diez papers: significa que ahí no hay estado del
   arte que alcanzar.

Terminá con los tres trabajos que leerías primero si solo tuvieras tiempo para
tres, y por qué esos.

No inventes citas. Si no encontrás algo, decí que no lo encontraste.
```

---

## 2 · Ajustes por modelo

Pequeñas líneas para **anteponer** al prompt portable. El resto no cambia.

### ChatGPT Deep Research

Suele abrir con preguntas de aclaración. Contestalas de antemano:

```
Si ibas a preguntarme para acotar: (1) el objetivo es decidir qué construir, no
publicar; (2) priorizá papers con números medidos y código público por sobre
cobertura amplia; (3) inglés y español; (4) si tenés que elegir, profundizá el
bloque A antes que el resto.
```

### Gemini Deep Research

Muestra un plan antes de ejecutar. Pedile que lo respete:

```
Cuando armes el plan de investigación, hacé un paso por cada pregunta numerada
(A1…D4) y no fusiones bloques. Si un paso no da resultados, dejálo en el informe
como "sin literatura encontrada" en vez de sacarlo del plan.
```

### Claude con investigación

Es donde más rinde pedirle criterio:

```
Además de encontrar los trabajos, evaluálos. Si un paper reclama un resultado que
sus propios números no sostienen, decilo. Si la sección de experimentos está
escrita en tiempo futuro, o si la comparación es contra un baseline débil en vez
de contra el estado del arte, marcálo — encontré exactamente esos dos problemas
en uno de los cuatro papers que ya leí, y no quiero repetirlo.
```

### Grok / DeepSeek / otros con web

```
Verificá que cada link exista antes de citarlo. Preferí páginas de arXiv o del
venue antes que agregadores. Si no podés confirmar que un paper existe, no lo
incluyas.
```

---

## 3 · Consultas crudas para buscadores académicos

**Elicit, Consensus, SciSpace, Semantic Scholar, Google Scholar y la búsqueda de
arXiv no toman prosa** — toman palabras clave. Estas son las consultas por
pregunta, listas para pegar. Suelen dar mejor cobertura que cualquier modelo,
porque buscan sobre el corpus y no sobre el índice de un buscador web.

### Bloque A

| # | Consulta |
| - | -------- |
| A1 | `privacy-preserving matching trusted execution environment marketplace` |
| A1 | `oblivious matching enclave order book dark pool` |
| A1 | `privacy-preserving ride-hailing matching cryptographic protocol` |
| A2 | `sealed-bid auction secure multiparty computation performance overhead` |
| A2 | `privacy-preserving auction trusted execution environment benchmark` |
| A3 | `anonymous rate limiting credentials denial of service` |
| A3 | `anonymous blocklisting Nymble Privacy Pass tokens` |
| A3 | `rate-limiting nullifier anonymous spam prevention` |

### Bloque B

| # | Consulta |
| - | -------- |
| B1 | `verifiable inference locality sensitive hashing activations LLM` |
| B1 | `large language model fingerprinting identification substitution` |
| B1 | `detecting quantized model substitution inference provider` |
| B2 | `verifiable metering usage accounting cloud billing untrusted provider` |
| B2 | `proof of serving tokens inference billing verification` |
| B3 | `gold standard questions quality control crowdsourcing workers` |
| B3 | `honeypot tasks auditing untrusted workers platform` |

### Bloque C

| # | Consulta |
| - | -------- |
| C1 | `truthful double auction cloud computing resources budget balance` |
| C1 | `double auction mechanism heterogeneous edge computing efficiency loss` |
| C2 | `LLM inference cost model KV cache memory bandwidth pricing` |
| C2 | `serving cost prediction autoregressive decoding GPU seconds billing` |
| C3 | `churn tolerant scheduling volunteer computing unreliable nodes` |
| C3 | `speculative replication straggler mitigation distributed inference` |
| C4 | `LLM cascade routing cost quality tradeoff confidence threshold` |
| C4 | `model routing small large language model escalation savings` |

### Bloque D

| # | Consulta |
| - | -------- |
| D1 | `confidential computing GPU H100 large language model inference overhead` |
| D1 | `NVIDIA confidential computing benchmark transformer performance` |
| D1 | `Intel TDX AMD SEV-SNP GPU confidential inference evaluation` |
| D2 | `DePIN token incentive operator retention empirical study` |
| D2 | `cryptocurrency payment volatility gig platform labor supply` |
| D3 | `open-weight LLM self-hosting total cost ownership versus API` |
| D4 | `HTTP 402 micropayments agent API machine-to-machine` |
| D4 | `EIP-3009 transfer with authorization batch settlement` |

**Truco para arXiv:** las consultas de arriba sirven en
`arxiv.org/list` con el buscador de texto completo, pero rinde más filtrar por
categoría. Las que aplican acá son `cs.CR` (seguridad), `cs.DC` (distribuido),
`cs.GT` (teoría de juegos y mecanismos), `cs.LG` y `cs.AI`. Los cuatro papers
que ya tenés caen en `cs.CR`, `cs.DC` y `cs.GT` — la ausencia de `cs.CR` con
matching confidencial en tu lista es, en sí misma, la señal que estamos yendo a
buscar.

---

## 4 · Cómo triangular

Corré al menos dos herramientas de distinta familia — una de búsqueda web
(Perplexity, ChatGPT DR) y una académica (Elicit, Semantic Scholar). Después:

- **Papel que aparece en las dos** → existe, vale abrirlo.
- **Papel que aparece en una sola, con arXiv ID** → verificalo antes de citarlo.
- **Papel sin ID verificable** → tratalo como inexistente hasta probar lo contrario.
- **Pregunta sin resultados en ninguna** → es un hueco real de la literatura, y
  para el pitch vale más que un paper: significa que no hay estado del arte que
  alcanzar en esa casilla.

Cuando tengas resultados, pasámelos y los cruzo contra
[SINTESIS-PAPERS-PyrusLLM.html](SINTESIS-PAPERS-PyrusLLM.html): qué confirma, qué
contradice, y si mueve el orden de implementación o alguna de las siete
decisiones abiertas.

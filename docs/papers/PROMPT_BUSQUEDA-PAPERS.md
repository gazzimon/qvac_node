# Prompt para Perplexity — ampliar cobertura de papers

Pegar en **Perplexity con Deep Research activado** (o Labs). Está escrito para que
devuelva papers con cita verificable, no resúmenes de blogs.

Si el resultado viene flojo, correrlo por bloques: un bloque por consulta, en el
orden A → B → C → D. El bloque A es el que más importa.

---

## El prompt

```
Actuá como un investigador haciendo una revisión de literatura para un equipo de
ingeniería. Necesito papers académicos revisables, no notas de blog ni whitepapers
de proyectos cripto. Priorizá arXiv, IEEE, ACM, USENIX, NeurIPS/ICML/MLSys, NDSS,
IEEE S&P, CCS y PETS. Rango: 2023 en adelante, salvo que un trabajo anterior siga
siendo el estado del arte, en cuyo caso incluilo y decilo.

## Contexto

Estoy diseñando un marketplace descentralizado de inferencia LLM. La arquitectura
actual: nodos P2P (Hyperswarm) que anuncian un manifiesto firmado con Ed25519,
un gateway compatible con el protocolo de OpenAI, pagos por HTTP con x402 sobre
stablecoin, y la intención de mover la capa económica —matching, medición de
consumo, liquidación y reputación— adentro de un TEE (WASM sobre AWS Nitro
Enclaves), de modo que ni el operador del protocolo pueda vincular quién pidió
qué a quién lo respondió.

Ya analicé estos cuatro trabajos. NO me los vuelvas a traer, y NO gastes espacio
resumiéndolos:

1. PolyLink — arXiv 2510.02395 — protocolo TIQE de evaluación de calidad con
   cross-encoder + LLM-as-a-Judge, comité de validadores con VRF y slashing.
2. DeServe — arXiv 2501.14784 — serving batch en redes de alta latencia, KV cache
   offloading, microbatch scheduling, verificación optimista con arbitraje.
3. AERIA — arXiv 2503.04521 — subasta de precio uniforme para inferencia DNN en
   el edge, con incentive compatibility y envy-freeness probadas.
4. DCBM — arXiv 2601.09961 — buyback-and-burn como controlador PID para
   estabilizar el token de una red de IA descentralizada.

Los cuatro dejan sin resolver lo mismo: **el matching entre pedido y proveedor
sigue teniendo un dueño que ve las dos puntas**, y ninguno aborda la privacidad
del pedido. Eso es lo que quiero cubrir, más otras preguntas que quedaron
abiertas.

## Lo que necesito

Contestá los bloques en orden. Para cada pregunta: si existe literatura, dame los
trabajos; **si no existe, decilo explícitamente** — que un problema no tenga
literatura es un hallazgo útil para mí, no un fracaso de la búsqueda. No
inventes citas ni rellenes con trabajos tangenciales.

### BLOQUE A — Matching confidencial (máxima prioridad)

A1. Emparejamiento de pedidos con proveedores dentro de un TEE, o mediante
    cómputo multiparte, de forma que el coordinador no pueda vincular al
    solicitante con el proveedor. Buscá también fuera de IA: order matching
    confidencial en dark pools, ride-hailing con privacidad, ad exchanges
    privados. Me interesa especialmente la latencia medida y si el clearing se
    hace por lote o por pedido.

A2. Subastas seguras y de preservación de privacidad, donde el subastador no
    aprende las pujas. Sealed-bid auctions con MPC o TEE, con números reales de
    overhead y escala (cuántos pujadores, cuántos ms).

A3. Tensión entre resistencia a DoS y no-enlazabilidad. Uno de los papers que
    leí presenta como ventaja anti-DoS que cada tarea use siempre el mismo par de
    peers, lo que es máxima enlazabilidad. Busco: rate limiting anónimo,
    credenciales anónimas, Privacy Pass, tokens de un solo uso, pruebas de trabajo
    para proteger proveedores sin identificar clientes.

### BLOQUE B — Verificación sin re-ejecutar

B1. Verificar **qué modelo se ejecutó realmente** (no si la respuesta es buena).
    Conozco TOPLOC (2501.16007) y SPEX (2503.18899), que usan locality-sensitive
    hashing sobre activaciones. ¿Hay algo posterior o mejor? Me interesan también
    fingerprinting de modelos, watermarking a nivel de logits, y detección de
    sustitución por un modelo más chico o más cuantizado.

B2. Verificar de forma confiable **cuántos tokens se sirvieron**, cuando el
    proveedor es quien reporta el número y tiene incentivo a inflarlo. Medición
    trustless de consumo, metering verificable, protocolos de facturación con
    pruebas.

B3. Sondas de respuesta conocida (canarios) inyectadas en tráfico real para
    auditar proveedores: diseño, tasa de muestreo óptima, y cómo evitar que el
    proveedor las distinga del tráfico legítimo. Buscá también en crowdsourcing
    con gold standard questions y en auditoría de trabajadores en plataformas.

### BLOQUE C — Mercado, precios y confiabilidad

C1. Dobles subastas (compradores y vendedores pujando a la vez) para recursos de
    cómputo heterogéneos. Me interesa cómo esquivan la imposibilidad de
    Myerson-Satterthwaite: qué propiedad sacrifican y con qué pérdida de
    eficiencia medida.

C2. Modelos de costo y unidades de facturación para serving de LLM
    autorregresivo. El paper de subastas que leí usa "FLOPS asignados", que asume
    una sola pasada forward y no aplica: la inferencia autorregresiva son r pasadas
    secuenciales limitadas por ancho de banda de memoria, y el KV cache consume
    memoria proporcional al contexto. Busco trabajos que modelen el costo real
    (tokens, GPU-segundos, memoria de KV cache) para fijar precios.

C3. Scheduling y routing con proveedores **intermitentes y poco confiables** —
    máquinas que se apagan, se van a mitad de un pedido, o mienten sobre su
    capacidad. Churn-tolerant scheduling, replicación especulativa, SLA
    probabilístico sobre infraestructura voluntaria.

C4. Cascadas de modelos y routing LLM: correr un modelo chico primero y escalar
    al grande solo si la confianza es baja. Me interesan estimación de confianza
    para decidir el escalado, ahorro medido, y pérdida de calidad medida.

### BLOQUE D — Inferencia confidencial y economía real

D1. Estado del arte 2024–2026 de **inferencia LLM sobre hardware confidencial con
    GPU**: NVIDIA H100/H200 en modo confidential computing, Intel TDX, AMD SEV-SNP
    con GPU pasada al enclave. Necesito overhead medido (throughput y latencia
    contra el mismo hardware sin CC) y qué queda expuesto igual. Descartá FHE y
    MPC para inferencia salvo que alguien haya publicado números practicables para
    modelos de 7B o más.

D2. Evidencia empírica sobre **denominación en stablecoin frente a token nativo**
    en redes DePIN o de cómputo compartido: efecto sobre la retención de
    operadores, sobre la volatilidad del ingreso, y sobre la adopción. Me interesa
    especialmente cualquier estudio que compare las dos y no solo modele una.

D3. Costos reales y márgenes de servir modelos abiertos sobre GPU de consumo en
    2025–2026: precios spot, punto de equilibrio, comparaciones contra APIs
    comerciales. Datos actualizados, porque el paper que tengo usa precios de 2024.

D4. Pagos nativos de HTTP para APIs consumidas por agentes: x402, HTTP 402,
    micropagos por request, autorizaciones firmadas off-chain estilo EIP-3009 y
    liquidación en lote. ¿Hay análisis académico, o solo especificaciones?

## Formato de salida

Agrupado por bloque y pregunta. Para cada trabajo:

- **Título** — venue y año — identificador (arXiv ID o DOI) — link
- Qué resuelve, en dos o tres líneas
- **El número que importa**: la métrica cuantitativa central (latencia, overhead,
  precisión, costo). Si el paper no mide nada, decilo — es información.
- Si tiene código público, el repo
- **Qué le falta** para aplicar a mi caso

Cerrá con dos listas:

1. Las preguntas donde **no encontraste literatura relevante**, con una línea de
   por qué creés que no existe.
2. Los tres trabajos que leerías primero si tuvieras tiempo para tres, y por qué.
```

---

## Después de correrlo

Pasame el resultado y lo cruzo contra lo que ya está en
[SINTESIS-PAPERS-PyrusLLM.html](SINTESIS-PAPERS-PyrusLLM.html): lo que confirme,
lo que contradiga, y si algo cambia el orden de implementación o alguna de las
siete decisiones abiertas.

Las respuestas de A1, A2 y D1 son las que pueden mover el plan. A1 y A2 definen
si el clearing por ventana adentro del enclave es tan barato como sugiere el
paper de subastas. D1 define si la última promesa pendiente —que el nodo tampoco
pueda leer el prompt— tiene camino técnico hoy o sigue siendo Fase N.

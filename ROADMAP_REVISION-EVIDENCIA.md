# PyrusLLM — Revisión del roadmap por evidencia externa

Tercero de la cadena. El [ROADMAP_FASE2-6.md](ROADMAP_FASE2-6.md) fijó el
transporte y el manifiesto; el [ROADMAP_FASE7-X402.md](ROADMAP_FASE7-X402.md)
fijó el cobro y la capa agéntica. **Este no los reemplaza: modifica piezas
concretas de ese segundo documento a partir de una revisión de literatura.**

**Qué toca, y nada más:**

| Pieza                | Qué le pasa                                                          |
| -------------------- | -------------------------------------------------------------------- |
| Fase 9               | Gana dos ítems de DoD (D24, D25). No cambia su objetivo ni su alcance |
| Fase 10              | Gana dos ítems de DoD (D24, D27)                                     |
| **Fase 10.5**        | **Nueva.** Sondas de identidad de modelo                             |
| V1                   | Gana un argumento medido                                             |
| V2                   | Deja de ser diseño en blanco: consume un artefacto que ya existirá    |
| **Fase 13**          | **Nueva.** Cascada de modelos. Después de la 11.5, no antes          |
| Fases 6.5 – 8.5      | **No se tocan.** Están cerradas y se quedan quietas                  |

**Reglas heredadas, las tres:** cada decisión tiene contexto, opciones y la que
recomiendo. Todo mock se marca donde se vea. Las fases se delegan; las decisiones
no.

**Y una cuarta, que sale de esta revisión y no de ninguna fase:** una cita cuyo
link resuelve no está verificada. Hay que leer el título. Tres de las citas que
llegaron en esta ronda tenían identificadores de arXiv válidos que apuntaban a
papers de otro tema — econometría, ética de algoritmos y lingüística. La única
verificación que cuenta es abrir el paper.

---

## 0 · De qué se parte

Cuatro papers leídos completos y una ronda de búsqueda asistida. El detalle
está en [SINTESIS-PAPERS-PyrusLLM.html](SINTESIS-PAPERS-PyrusLLM.html). Acá va
solo lo que mueve una fase.

### Lo verificado contra arXiv

| Trabajo                                                                        | El número                                                              | Qué mueve                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| **Token Inflation** — [arXiv:2605.30040](https://arxiv.org/abs/2605.30040)     | **1.469 %** de inflación de tokens sin detección; 50,85 % por tokenización | **D24**, V1, V2               |
| **UCCI** — [arXiv:2605.18796](https://arxiv.org/abs/2605.18796)                | **31 %** de ahorro (IC 95 %: 27–35 %), 75 000 queries en H100           | Fase 13                       |
| **Confidential LLM Inference** — [arXiv:2509.18886](https://arxiv.org/abs/2509.18886) | H100 CC: **4–8 %** de throughput. **HBM y NVLink sin cifrar**           | El límite honesto de privacidad |
| **Hopper CC** — [arXiv:2409.03992](https://arxiv.org/abs/2409.03992)           | **< 7 %** en queries típicas; el cuello es el PCIe                      | Ídem                          |

### Lo citado y no verificado, que igual cambia un alcance

- [arXiv:2504.04715](https://arxiv.org/abs/2504.04715) — los detectores basados
  en texto **no** detectan sustitución por cuantización con presupuestos de
  muestreo realistas. Es la base de **D26**, y hay que abrirlo antes de
  comprometer la Fase 10.5.

### Lo que NO respalda nada, y queda escrito para que nadie lo levante después

Una segunda ronda de búsqueda devolvió papers con números perfectos para
exactamente los huecos que la primera declaró vacíos. Tres verificados, tres
falsos:

| Cita que circuló                            | Qué hay en ese identificador       |
| ------------------------------------------- | ---------------------------------- |
| `2502.04112` "PoEx: Verifiable Token Metering" | Econometría — modelos factoriales  |
| `2411.05210` "Benchmarking CC on H100"      | Ética de algoritmos                |
| `2502.11890` "Economics of Consumer GPU"    | Taxonomía de errores gramaticales  |

**No existe un esquema publicado de medición criptográfica de tokens con 2,3 %
de overhead.** Si alguien lo propone en una discusión futura citando "PoEx", esto
es la respuesta. El camino real para el metering es el enclave, o sea **V2**.

### Los cinco huecos, confirmados por dos vías

Matching confidencial de inferencia · medición trustless de tokens · sondas
indistinguibles · scheduling tolerante a churn · stablecoin contra token nativo
con datos.

Una búsqueda dijo "no encontré". La otra **tuvo que inventarlos**. Un modelo
alucina donde no hay nada que recuperar, así que la fabricación marca el vacío
con la misma precisión que la ausencia. **Para el pitch: no es que no buscamos
bien. No existe.**

---

## 1 · Decisiones nuevas

Numeración continúa la del documento anterior, que llegó hasta D23. Las cuatro
son del dueño del proyecto.

### D24. El recibo lleva dos firmas, no una

**Problema.** La Fase 10 dice, con razón, que _"la firma EIP-3009 **ya es** el
recibo"_. Pero esa firma cubre **una sola dirección**: el cliente autorizando el
pago. No hay ningún artefacto donde el **proveedor** atestigüe qué sirvió.

**El ataque que este roadmap describía primero, y que resultó no aplicar.**
Token Inflation mide **1.469 % de inflación promedio sin detección** en el conteo
de tokens de razonamiento, y **50,85 %** aprovechando ambigüedad de tokenización:
un cobro honesto de USD 100 convertido en USD 1.569 sobre la misma consulta.
Pero ese ataque supone que **el proveedor reporta el número que se factura**, y
en el camino P2P de este proyecto **eso no pasa**. En
[qvac/gateway.mjs:726](qvac/gateway.mjs#L726), `costoDelIntento` factura al par
con el conteo **propio** del gateway:

```js
if (!esTercero(node)) return costs.real({ completionTokens: tokens })
```

El `usage` del proveedor solo se usa para terceros (Claude, OpenRouter). Al par
no se le cree el número. **Bien.**

**El ataque que sí aplica, y que es la razón real de esta decisión.** El propio
comentario de esa función lo deja escrito: _"son chunks de SSE, no tokens"_. El
gateway incrementa `tokens` una vez por delta con contenido
([gateway.mjs:934](qvac/gateway.mjs#L934)) — y **quién decide cómo se trocea el
stream es el par**. Un proveedor que emite un carácter por delta en vez de un
token por delta infla el conteo del gateway sin mentir en ningún campo y sin
romper ninguna validación: no falsea el número, **falsea la señal que el otro
cuenta**.

Es la misma familia que Token Inflation con otro vector, y el papel que juega la
tokenización allá lo juega el troceo acá. Contra eso, **el `outputHash` cierra el
agujero**: el hash es sobre el texto completo, y el texto no depende de en
cuántos pedazos viajó. Cualquiera puede recontar los tokens desde el texto
atestiguado, con el tokenizador que corresponda al `modelId` declarado.

**Cuándo se vuelve explotable, exactamente.** No mientras D9 cobre un **tope fijo
declarado**: inflar el conteo no cambia lo que se cobra. Se vuelve explotable en
la **Fase 10**, cuando el lote pasa a acumular consumo real. Pero el artefacto
tiene que nacer antes — ver la razón 2 de abajo.

**Y el agujero que el roadmap anterior ya declaraba sigue en pie para lo que no
es facturación:** _"un nodo que reporta 900 tokens cuando sirvió 400 no tiene hoy
quién lo contradiga — `recordPeerResult` le cree."_ Ahí no hay hash de nada, y es
lo que alimenta reputación y ruteo.

**Opciones.** (a) Dejarlo para V2, que es donde vive el metering. (b) Emitir la
atestación desde la Fase 9, colgada del recibo que **D12 ya obliga a construir**.

**Decisión: (b).** Dos razones y ninguna es la urgencia.

1. **Es casi gratis ahora.** D12 ya te hace construir el recibo como evento SSE
   final más `GET /v1/receipts/:id`. Agregarle campos a un artefacto que igual
   vas a construir cuesta una fracción de construirlo aparte después.
2. **No se retrofittea.** Los requests que ya pasaron no se firman
   retroactivamente. Cada día de la Fase 9 sin esto es historia no auditable que
   no vuelve — y es justo la historia sobre la que la Fase 10 va a querer
   liquidar.

**El artefacto.** Firmado con la wallet, **no** con la clave de red — mismo
criterio que la Fase 10 y que dice `manifest-v0.json:84`:

```
{
  requestId, nonce, ts,
  modelId,                  // el mismo que anuncia el manifiesto firmado
  quantization, runtime,    // declarados; ver D26 sobre qué los sostiene
  promptHash, outputHash,
  tokensPrefill, tokensDecode,   // ver D25
  finishReason,
  providerPubkey, signature
}
```

**Impacto si no se decide:** la Fase 10 liquida sobre lo que el nodo afirma, sin
un artefacto que lo comprometa, y V2 arranca sin insumo — tiene que inventar el
formato y no puede recomputar nada hacia atrás.

---

### D25. La medición separa prefill de decode

**Problema.** D22 fijó un precio plano por millón de tokens. El costo real tiene
dos regímenes con estructuras distintas: el **prefill** procesa el prompt en
paralelo y está limitado por cómputo; el **decode** genera token a token y está
limitado por ancho de banda de memoria. Y el KV cache ocupa memoria proporcional
al contexto **durante toda** la generación.

Una tarifa única mezcla tres costos que no escalan igual. Es también el defecto
que descarta el modelo de costos de AERIA para nuestro caso: su `T = FLOPs/FLOPS`
asume una sola pasada forward.

> **Nota sobre la evidencia.** Esta idea llegó atribuida a un paper llamado
> "FlexServe" que **no verifiqué y que probablemente no existe** — vino en la
> misma tanda que las tres citas falsas. El razonamiento es correcto por
> separado y se sostiene solo; la cita no. Queda anotado así a propósito.

**Opciones.** (a) Cambiar el precio a dos dimensiones ahora. (b) **Registrar**
las dos dimensiones ahora y dejar el precio plano hasta tener datos propios.

**Decisión: (b).** Cambiar el precio es una decisión de negocio que no tiene con
qué informarse todavía; registrar es barato y es la única forma de conseguir con
qué. `pushLog` en [qvac/gateway.mjs:855](qvac/gateway.mjs#L855) ya cuenta
`tokens`, `ttftMs` y `ms` — la separación está casi al alcance de lo que ya se
registra. **D22 no se toca.**

**Nota de proceso, y hay que leerla antes de escribir código.** Esto **agrega**
campos; no cambia la matemática de ruteo, que la Fase 8 cerró con el precio del
ledger en micro-dólares. Pero si al implementarlo resulta que toca la superficie
de la Fase 8, entonces **por la regla del documento anterior esa fase se reabre**
y se vuelve a cerrar con lo que aparezca. Mejor declararlo ahora que descubrirlo
en un commit.

**Impacto si no se decide:** la Fase 10 congela la contabilidad en una sola
dimensión, y volver atrás significa rehacer el ledger.

---

### D26. Alcance de la verificación de identidad de modelo

**Problema.** La aplicación dice que _"a node declares which model it runs, and
that declaration has to be provable"_. La propuesta inicial fueron sondas de
respuesta conocida. La literatura acota qué pueden probar.

- **Sustitución de modelo** (anuncia 14B, sirve 1.5B): el fingerprinting anda.
- **Sustitución por cuantización** (mismo modelo, menos bits): según
  [arXiv:2504.04715](https://arxiv.org/abs/2504.04715), los detectores basados
  en texto son **inefectivos** con presupuestos de muestreo realistas. **No hay
  solución black-box publicada.**

**Decisión.** Alcance partido, y declarado como tal:

| Qué se verifica          | Con qué                                                |
| ------------------------ | ------------------------------------------------------ |
| Identidad del modelo     | **Sondas** (Fase 10.5)                                 |
| Cuantización y runtime   | **Declaración firmada + stake + arbitraje** (D24, Fase 10) |

O sea: la cuantización se cubre **económicamente**, no técnicamente. Es
exactamente el rol que DeServe le da a la verificación optimista, y es más
honesto que prometer una detección que hoy nadie sabe hacer.

**Condición.** Abrir y leer `2504.04715` antes de comprometer la Fase 10.5. Es
la única cita de este documento que no verifiqué y de la que depende un alcance.

**Impacto si no se decide:** se construyen sondas esperando que detecten
cuantización, no lo hacen, y el descubrimiento llega después de haberlo
prometido por escrito.

---

### D27. Qué se firma cuando el stream muere a la mitad

**Problema.** Si el cliente aborta en el token 142, ¿qué queda firmado? D12 ya
resolvió la **forma** (verificar sincrónico, servir, liquidar después) y D4 del
roadmap anterior resolvió el **reintento** (solo antes del primer chunk). Falta
el artefacto.

**Es un hueco real de la literatura** — ninguna de las dos búsquedas encontró un
estándar de auditoría no repudiable para streaming interrumpido.

**Decisión.** Tres casos, y el que decide es **quién cortó**:

| Corte                       | Atestación                                        | Cobro                    |
| --------------------------- | ------------------------------------------------- | ------------------------ |
| Cliente (`chat:cancel`, D1) | Parcial, sobre el prefijo emitido                 | **Sí**, hasta ese punto  |
| Proveedor (caída, D4)       | Ninguna                                           | **No** — el DoD de la Fase 9 ya lo dice |
| Tope de tokens (D9)         | Completa, con `finishReason: length`              | **Sí**, hasta el tope    |

La atestación parcial lleva el hash del prefijo efectivamente emitido, no el de
la respuesta que se hubiera generado. Eso la hace verificable contra lo que el
cliente recibió.

**Impacto si no se decide:** el caso más frecuente del uso real —alguien cierra
la pestaña— queda sin registro auditable, y es justo donde un proveedor
deshonesto tiene margen para reclamar tokens que nadie recibió.

---

### D28. Qué se denomina en qué

**Problema.** Esta no es una decisión pendiente: es una **contradicción entre lo
construido y lo prometido**, y hay que resolverla en una dirección u otra.

Lo que el código ya hace:

| Pieza                                                    | Denominación                        |
| -------------------------------------------------------- | ----------------------------------- |
| El precio que rutea (Fase 8, cerrada)                    | **micro-dólares**, desde el ledger  |
| Liquidación (D15)                                        | Plasma / Stable — rieles de stablecoin |
| [qvac/manifest.mjs:108](qvac/manifest.mjs#L108)          | `settlement: 'batch-receipts'`      |

Lo que la aplicación promete: _"earns **$QVAC** for every request it serves via
an x402 payment"_.

**La economía operativa ya está denominada en dólares y liquida sobre
stablecoin.** El token del pitch no aparece en ningún camino de código.

**Opciones.** (a) Llevar la economía operativa al token nativo, para que el
código haga lo que dice el pitch. (b) Dejar la economía operativa en stable y
acotar el token nativo a la capa de incentivos, corrigiendo el pitch.

**Decisión: (b).** El proveedor planifica contra su factura de luz, no contra el
mercado: cobrar en un activo volátil le traslada un riesgo que no puede cubrir, y
es exactamente el problema que DCBM intenta resolver con un controlador PID
después de haberlo creado con la denominación. Separadas las dos capas, la
volatilidad golpea la especulativa y no la operativa, y no hace falta ninguna
maquinaria de estabilización.

| Capa                                                                 | Denominación   |
| -------------------------------------------------------------------- | -------------- |
| Riel de pago — lo que el usuario paga, lo que el proveedor cobra     | **stablecoin** |
| Activo de incentivo — staking, bonos de reputación, slashing, gobernanza, subsidio de arranque | token nativo   |

**Lo que hay que cambiar es el texto, no el código.** El código ya está del lado
correcto. Corregir en `PyrusLLM-application.md` la línea de `$QVAC` para que
describa el riel real, y dejar el token nombrado donde efectivamente va a vivir.

**Honestidad sobre la evidencia:** ninguna de las dos rondas de búsqueda encontró
un solo estudio empírico que compare retención de operadores entre pagar en
stablecoin y pagar en token nativo — y la segunda **inventó uno**, con cifras de
42 % contra 6,1 %. Esta decisión se sostiene en razonamiento, no en datos.
Presentarla así.

**Impacto si no se decide:** el pitch promete un flujo económico que el código no
implementa, y eso lo encuentra cualquiera que abra el repo.

---

### D29. Verificación optimista, sin comité

**Problema.** Estaba supuesto en dos lugares de este documento sin estar decidido
en ninguno: D24 propone atestación más stake, que es el esquema optimista, y D26
dice textualmente que la cuantización se cubre _"como DeServe le da a la
verificación optimista"_. Por la regla del documento anterior, eso es justo lo que
no puede quedar implícito.

**Opciones.** (a) Comité permanente de validadores con stake que puntúa cada
lote, estilo TIQE. (b) Verificación optimista: el proveedor firma, el camino
honesto no cuesta nada, y solo hay arbitraje en disputa.

**Decisión: (b), con el enclave como árbitro.** Tres razones:

1. **El comité cuesta un tercio de los ingresos, para siempre.** PolyLink reserva
   β = 0,3 para validadores en cada lote. Contradice de frente la propia frase de
   la aplicación: _"the margin stays with whoever contributes the actual
   compute"_.
2. **El comité tampoco resuelve el problema que importa.** Puntuar calidad no
   detecta un conteo inflado ni un troceo manipulado (D24). Se paga el tax y el
   agujero queda igual.
3. **Ya hay verificación del lado del comprador, y funciona sin tax.** El gateway
   cuenta sus propios deltas (D24), y `qvac/routing.mjs` ya penaliza al que falla
   y al lento. Un comité sería una tercera capa arriba de algo que anda.

Y la pieza que en DeServe queda abierta —el módulo de arbitraje, que ellos dejan
**enchufable porque no tienen con qué llenarlo**— acá la llena el enclave: no
hace falta bisección estilo opML ni pruebas ZK, el TEE adjudica sobre la
atestación de D24.

**Lo que esto implica, y conviene tenerlo escrito:** las garantías de calidad son
**estadísticas y reputacionales, no por request**. La verificación ocurre después
de responder. Decirlo así es más creíble que prometer verificación previa, y es
lo único que el estado del arte sostiene.

**Impacto si no se decide:** alguien propone un comité de validadores en una
discusión futura —es lo que hace el paper más parecido a este proyecto— y no hay
nada escrito que explique por qué se descartó.

---

## 2 · Modificaciones a las fases

### Fase 9 — x402 en el borde · **el objetivo no cambia**

Se le suman dos ítems de DoD. **Costo estimado: +0,5 día** sobre los 2-3 ya
planificados.

- El recibo de D12 lleva además la **atestación del proveedor** (D24), firmada
  con la wallet.
- `pushLog` registra **prefill y decode por separado** (D25). D22 sin tocar.

_Nada de esto se consume todavía._ En la Fase 9 el artefacto solo se emite y se
guarda. Es deliberado: se emite antes de que haga falta, porque después no se
puede emitir hacia atrás.

### Fase 10 — Recibos y liquidación en lote

- El lote acumula **las dos firmas**, no solo la autorización EIP-3009 (D24).
- Implementa los **tres casos de corte** de D27.

### Fase 10.5 — Sondas de identidad de modelo · **nueva** (~1 día)

Un porcentaje del tráfico son prompts con respuesta conocida, inyectados por el
gateway. Son indistinguibles del tráfico real **porque el pedido ya llega
desacoplado de la identidad** — que es la propiedad que PolyLink no puede tener,
con su servidor de API visible.

**Va después de la Fase 10**, no antes: necesita el recibo firmado como base
contra la cual comparar.

**DoD:**

- Un nodo que sirve un modelo distinto al que anuncia es detectado y su
  reputación cae, con el evento en el log de ruteo.
- El README publica la tasa de muestreo y **el alcance acotado de D26** —
  incluyendo que la cuantización no se detecta así. Mismo criterio que ya se
  aplica a la tasa de acierto del agente: se publica lo que no funciona.

### Fase 13 — Cascada de modelos · **nueva**, después de la 11.5 (~2 días)

Modelo chico primero, escalar al grande si la confianza es baja. UCCI mide
**31 % de ahorro** (IC 95 %: 27–35 %) sobre 75 000 queries reales en H100, con
código.

**Después de la 11.5, no antes.** La 11.5 no es opcional y no se saltea; esto sí
es margen.

⚠️ **No reabre la Fase 8.** El ruteo por precio y carga está cerrado. La cascada
es un mecanismo distinto —escalado por confianza dentro de un mismo pedido— y por
eso es fase nueva y no una corrección de aquella.

---

## 3 · Track V

### V1 — Aplicación a Horizen · **gana el mejor argumento que tenía el proyecto**

El deck plantea el problema del centro que ve las dos puntas. Ahora hay un
segundo problema, **medido y citable**, que el enclave resuelve y nada más
resuelve: el proveedor puede inflar el conteo de tokens un **1.469 %** sin que
nadie lo note, y el paper que lo demuestra nombra la atestación en enclave como
la salida.

Eso convierte el argumento de _"queremos que no puedan confiar en nosotros"_ en
_"hay un fraude medido de tres cifras que solo el cómputo confidencial cierra"_.
Es más fuerte, y ya no es una postura: es una cita.

**Sigue siendo lo único con reloj externo.** La §8 del roadmap anterior dice que
la fecha de cierre no se sabe. Esto son ~2 horas de edición del deck y **debería
salir antes de abrir la Fase 9**.

### V2 — Metering en enclave · **deja de ser diseño en blanco**

Con D24 implementado, V2 no tiene que inventar formato ni empezar de cero:
recomputa el consumo contra un artefacto firmado que ya lleva meses acumulándose.

Sigue dependiendo de acceso a VELA y de D17.

---

## 4 · El límite honesto de la privacidad, actualizado

Corresponde al README y a la aplicación, no a una fase.

El claim vigente —_"ninguna corporación centralizada agrega tus datos a
escala"_— sigue siendo correcto y sigue siendo el que hay que decir. Lo que
cambia es que ahora se puede decir algo **más** sobre el paso siguiente, con
números:

- **Hay camino técnico.** Inferencia LLM sobre GPU con cómputo confidencial: el
  overhead medido es **4–8 %** de throughput en H100 CC, y **< 7 %** para
  consultas típicas. Deja de ser aspiración.
- **Con dos límites que hay que decir en la misma frase.** En H100, **la memoria
  HBM no está cifrada y la comunicación NVLink entre GPUs tampoco**. Para un solo
  GPU el modelo de amenaza cierra; para un modelo repartido entre varios, no.
- **Y un tercero, independiente:** los **tiempos entre tokens** filtran longitud
  y estructura del texto aunque todo lo demás esté cifrado. Un observador de red
  infiere cuánto se escribió y cuánto se respondió.

Nada de esto se arregla en este roadmap. Se **dice**, que es la disciplina que el
proyecto ya aplica a los mocks y a la tasa de acierto.

---

## 5 · Tabla resumen — orden de ejecución

| Orden | Qué                                                | Cuándo                         | Costo      |
| ----- | -------------------------------------------------- | ------------------------------ | ---------- |
| **0** | **V1 — Token Inflation al deck de Horizen**        | **Antes de abrir la Fase 9**   | ~2 h       |
| **0'**| **Corregir dos claims** (D26 y §4) en README y aplicación | Antes de abrir la Fase 9  | ~1 h       |
| 1     | Fase 9 + D24 + D25                                 | Siguiente, ya desbloqueada     | 2-3 d +0,5 |
| 2     | Fase 10 + D24 + D27                                | Después de la 9                | ~2 d       |
| 3     | **Fase 10.5 — sondas** (nueva)                     | Después de la 10               | ~1 d       |
| 4     | Fase 11 — capa agéntica                            | Sin cambios                    | 2-3 d      |
| 5     | Fase 11.5 — evaluación adversarial                 | Pegada a la 11. No es opcional | 1-2 d      |
| 6     | Fase 12 — MCP toolkit                              | Upside; se corta primero       | 1-2 d      |
| 7     | **Fase 13 — cascada** (nueva)                      | Después de la 11.5             | ~2 d       |
| —     | V2 — metering en enclave                           | Con acceso a VELA y D17        | —          |

### Decisiones a cerrar

| #   | Decisión                                                        | Tipo                     | Bloquea            |
| --- | --------------------------------------------------------------- | ------------------------ | ------------------ |
| D24 | Atestación del proveedor en el recibo, desde la Fase 9          | **arquitectura + seguridad** | Fase 9, 10, V2 |
| D25 | Registrar prefill y decode por separado; precio plano sin tocar | modelo de datos          | Fase 9, Fase 10    |
| D26 | Sondas para identidad; cuantización por stake y arbitraje       | **negocio + seguridad**  | Fase 10.5          |
| D27 | Tres casos de corte, decididos por quién cortó                  | arquitectura             | Fase 10            |
| D28 | Riel de pago en stable; token nativo solo para incentivos. Corrige el texto, no el código | **negocio**    | La aplicación      |
| D29 | Verificación optimista con el enclave como árbitro; sin comité  | **arquitectura + negocio** | Fase 10, V2      |

---

## 6 · Lo que esta revisión NO propone

- **No** construir metering criptográfico propio. El esquema que circuló con
  2,3 % de overhead no existe. El camino es V2.
- **No** implementar la subasta. Primero precio de reserva por proveedor; la
  subasta cuando haya volumen que la justifique.
- **No** estabilización del token. El propio teorema del paper que la propone la
  prohíbe con liquidez delgada: la ganancia de planta es `α = 2/y`, y con un pool
  chico el controlador entra en la región inestable.
- **No** tocar las Fases 6.5 a 8.5, salvo que D25 fuerce reabrir la 8 — y en ese
  caso, declarándolo.

---

## 7 · Item abierto

**Una sola cita de este documento sostiene un alcance y no está verificada:**
[arXiv:2504.04715](https://arxiv.org/abs/2504.04715), que es la base de D26. Si al
abrirla resulta que dice otra cosa, D26 se rehace y con ella el DoD de la
Fase 10.5. Todo lo demás de este documento se apoya en papers abiertos y
confirmados uno por uno.

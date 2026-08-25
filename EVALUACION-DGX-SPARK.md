# Estudio económico — NVIDIA DGX Spark como nodo PyrusLLM

Este documento responde una sola pregunta: **¿en cuánto tiempo se recupera la
plata de este equipo?** No analiza reventa de hardware — para eso está el
Modelo B de [EVALUACION-ECONOMICA.md](EVALUACION-ECONOMICA.md). Acá el equipo
se compra para operarlo.

Todos los números salen de
[`scripts/eval-dgx-spark.py`](scripts/eval-dgx-spark.py). Cambiar un supuesto
ahí y correr el script recalcula el documento entero.

## Supuestos

| Parámetro | Valor |
| --- | --- |
| Precio de lista (Amazon) | USD 4.799,99 (4.749,99 con Amazon Visa) |
| Nacionalización en Argentina | +35% → USD 6.480 |
| Tipo de cambio | ARS 1.600 / USD |
| Costo eléctrico | ARS 135/kWh |
| Consumo bajo carga / en reposo | 150 W / 45 W (fuente de 240 W) |
| Ancho de banda de memoria (GB10) | 273 GB/s sobre 128 GB LPDDR5x |
| Eficiencia de ancho de banda asumida | 75% |
| Horizonte / tasa de descuento | 36 meses / 12% anual USD |

## Los precios del token (lo que faltaba para calcular)

Precios de la API de Anthropic, USD por millón de tokens (**MTok**):

| Modelo | Entrada | Salida |
| --- | ---: | ---: |
| Claude Opus 5 | 5,00 | 25,00 |
| Claude Sonnet 5 | 3,00 | 15,00 |
| Claude Haiku 4.5 | 1,00 | 5,00 |

Como referencia del otro extremo del mercado: los tokens de modelos **abiertos**
(Llama, Qwen, gpt-oss) se venden en agregadores a un orden de **USD 0,10–0,60
por MTok de salida** — dos órdenes de magnitud menos. Ese es el número que
define si vender inferencia como commodity tiene sentido o no. *Los precios de
Anthropic son de tarifario; los de mercado abierto son de referencia y conviene
verificarlos antes de cerrar cualquier número comercial.*

El cálculo de abajo usa el **precio de salida** como unidad de valor, porque en
el Spark el prefill (entrada) es barato y el decode (salida) es el que ocupa el
equipo.

---

## 1. Capacidad — cuántos tokens produce el equipo

El decode lee los pesos del modelo **una vez por token generado**. Entonces
`tok/s ≈ ancho de banda útil / tamaño del modelo`. Con 273 GB/s × 75% ≈ 205 GB/s:

| Modelo (cuantizado a 4 bits) | GB en memoria | tok/s 1 flujo | tok/s lote ×8 |
| --- | ---: | ---: | ---: |
| Llama 3.1 8B | 4,7 | 44 | 261 |
| Qwen3 32B | 18,0 | 11 | 51 |
| gpt-oss-120b (MoE, ~5B activos) | 3,5 leídos | 58 | 176 |
| Llama 3.3 70B | 40,0 | 5 | 18 |

**Estos son cálculos de límite físico, no mediciones sobre el equipo.** El
número real va a ser menor. Hasta no tener el Spark en la mano y correr un
benchmark, tratarlos como techo optimista.

Dos lecturas importantes:

- **El batching es lo que hace rentable un nodo.** Un pedido a la vez desperdicia
  el equipo; ocho pedidos concurrentes comparten la misma lectura de pesos y
  multiplican el throughput agregado 3–6×.
- **Los 128 GB unificados son el verdadero diferencial, no la velocidad.** Una
  placa gamer de USD 2.000 tiene 24 GB y más ancho de banda: es más rápida en
  modelos chicos y directamente **no puede cargar** un 120B. El Spark compra
  *tamaño de modelo*, no *velocidad*.

El resto del análisis usa un caso base conservador de **50 tok/s de salida
sostenidos** (un 30B con lote moderado).

## 2. Costo marginal — cuánto cuesta el token propio

| tok/s sostenidos | MTok/mes | USD/MTok (solo luz) | USD/MTok (luz + CAPEX a 36m) |
| ---: | ---: | ---: | ---: |
| 20 | 51,8 | 0,176 | 2,748 |
| **50** | **129,6** | **0,070** | **1,099** |
| 120 | 311,0 | 0,029 | 0,458 |
| 300 | 777,6 | 0,012 | 0,183 |

**La electricidad es irrelevante.** A 50 tok/s el token propio cuesta 7 centavos
de dólar por millón en luz — contra 5 dólares de Haiku. El costo real del token
local es casi todo **amortización de CAPEX dividida por utilización**. Que es
otra forma de decir: el equipo apagado es infinitamente caro por token.

## 3. Payback — meses para recuperar USD 4.800

Filas: qué fracción del tiempo el equipo está realmente generando tokens que
alguien paga. Columnas: a cuánto se valora el MTok de salida.

| Utilización | commodity 0,30 | USD 1 | Haiku 5 | Sonnet 15 | Opus 25 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5% (1,2 h/día) | nunca | >20 años | 164 m | 51 m | 30 m |
| 10% (2,4 h/día) | >20 años | >20 años | 78 m | 25 m | 15 m |
| 25% (6 h/día) | >20 años | 171 m | 30 m | 10 m | **6 m** |
| 50% (12 h/día) | >20 años | 82 m | 15 m | **5 m** | **3 m** |
| 100% (24 h/día) | 161 m | 40 m | **8 m** | **2 m** | **1 m** |

**La variable dominante no es el hardware: es la utilización.** El mismo equipo
va de "nunca se paga" a "se paga en 3 meses" sin cambiar una sola pieza.

## 4. Escenarios completos (36 meses, 12% anual)

| Escenario | tok/s | Util. | USD/MTok | Neto/mes | Payback | VAN 12% | TIR anual |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Uso personal (1 dev) | 50 | 8% | 5 | 49 | 99 m | −3.324 | neg |
| Equipo chico (8 personas) | 50 | 35% | 5 | 222 | 22 m | +1.938 | 44% |
| Vender commodity 24/7 | 50 | 90% | 0,30 | 27 | 181 m | −3.995 | neg |
| **Nodo privacidad (clínica)** | 50 | 35% | 15 | **675** | **7 m** | **+15.716** | 379% |
| Nodo privacidad, nacionalizado | 50 | 35% | 15 | 675 | 10 m | +14.036 | 217% |

### Qué dice cada escenario

- **Uso personal: no cierra.** Un desarrollador solo no genera 130 MTok/mes. A
  USD 4.800 de CAPEX, comprar el equipo para uso propio es una decisión de
  soberanía o de gusto, no de finanzas — hay que decirlo así.
- **Vender tokens como commodity: no cierra nunca.** Hay que mover **16.000
  MTok** para recuperar la inversión a USD 0,30. A saturación continua son
  **10 años**. Competir por precio contra un datacenter con H100 amortizadas es
  una pelea perdida, y el número lo confirma.
- **Equipo chico compartido: cierra, apretado.** 22 meses. Es el caso honesto y
  verificable: 8 personas sustituyendo su gasto en un modelo tier-Haiku.
- **Nodo de privacidad: es el único caso que cierra holgado.** Y no cierra
  porque el Spark sea rápido — cierra porque el comprador no está pagando
  *capacidad*, está pagando *que el dato no salga del edificio*. Para una
  clínica, un estudio jurídico o un organismo público, la alternativa a
  USD 15/MTok no es USD 0,30/MTok: es **no poder usar IA sobre ese dato**.

## 5. Punto de equilibrio en tokens

| Valor del token | MTok para recuperar USD 4.800 | Días a 50 tok/s saturado |
| --- | ---: | ---: |
| commodity 0,30 | 16.000 | 3.704 |
| USD 1 | 4.800 | 1.111 |
| Haiku 5 | 960 | 222 |
| Sonnet 15 | 320 | 74 |
| Opus 25 | 192 | 44 |

Dividir los días por la utilización real. Al 25%, la fila de Haiku pasa de 222
a 888 días.

---

## Riesgos y lo que no está probado

- **Los tok/s son estimaciones teóricas, no mediciones.** Todo el estudio se
  apoya en un techo calculado por ancho de banda. Es el primer número que hay
  que reemplazar con un benchmark real sobre el equipo, y va a bajar.
- **Valuar el token local a precio de Sonnet 5 es una decisión comercial, no
  técnica.** Un modelo abierto de 30B en el Spark **no rinde como Sonnet 5**. El
  escenario "nodo privacidad" no dice que la calidad sea equivalente: dice que
  para cierto dato regulado el sustituto no existe a ningún precio, y ahí el
  precio lo fija la restricción, no el benchmark. Si el comprador compara
  calidad contra calidad, ese escenario se cae.
- **Los precios de API bajan.** El costo por token de los proveedores viene
  cayendo sostenidamente; el ahorro que hoy justifica el equipo puede ser menor
  a mitad del horizonte de 36 meses. El CAPEX, en cambio, ya está pagado.
- **No hay valor residual en el modelo.** A 36 meses el equipo vale algo. No se
  computó — el cálculo es conservador por ese lado.
- **La utilización asumida no está medida.** Es el supuesto que más mueve el
  resultado y el único que no se puede estimar desde una especificación técnica:
  hay que observar un nodo real en producción.
- **No hay capa de liquidación implementada.** El campo `economic` del manifiesto
  sigue marcado como mock (`_mock: true`) — ver [README](README.md#estado).
  Cualquier ingreso por vender inferencia a la red es, hoy, una proyección sin
  código detrás.

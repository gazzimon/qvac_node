# Evaluación económica-financiera — PyrusLLM

Este documento analiza la economía del proyecto desde los dos lados de la
cadena: quien **opera un nodo** (ahorra en su factura de IA) y quien
**importa y revende** el hardware (margen comercial). Los dos modelos son
independientes — un mismo comprador puede ser solo operador, y un revendedor
no necesariamente usa la máquina como nodo.

**Supuestos base**, válidos para todo el documento salvo que se indique lo
contrario:

| Parámetro | Valor |
| --- | --- |
| Tipo de cambio | ARS 1.600 / USD |
| Tasa de descuento | 12% anual en USD |
| Horizonte de proyección | 36 meses |
| Consumo del equipo (24/7) | 43,2 kWh/mes (~60 W) |
| Costo eléctrico | ARS 135/kWh → USD 3,65/mes |

Todos los cálculos son reproducibles: están en
[`scripts/eval-economica.py`](scripts/eval-economica.py).

---

## Modelo A — Operador del nodo (ahorro)

Un comprador reemplaza parte de su gasto en APIs de IA por inferencia propia
o de la red, a un precio de adquisición de **USD 1.650** (nuestro precio de
venta, consistente con el Modelo B más abajo).

| Concepto | Valor |
| --- | ---: |
| CAPEX (precio de compra) | USD 1.650,00 |
| Factura de IA actual | USD 100,00 / mes |
| Factura de IA con el nodo | USD 20,00 / mes |
| **Ahorro bruto** | **USD 80,00 / mes** |
| Costo eléctrico | USD 3,65 / mes |
| **Beneficio neto** | **USD 76,36 / mes** |

### Indicadores (36 meses, 12% anual)

| Indicador | Valor |
| --- | ---: |
| **Payback** | **21,6 meses** (1,8 años) |
| Beneficio neto acumulado (36m) | USD 1.099 |
| ROI simple (36m) | 67% |
| **VAN @ 12%** | **USD 669** |
| **TIR anualizada** | **44%** |

### Sensibilidad — payback en meses, según factura actual y plan nuevo

| Plan nuevo ↓ / Factura actual → | USD 50 | USD 75 | **USD 100** | USD 150 | USD 200 |
| --- | ---: | ---: | ---: | ---: | ---: |
| USD 10 | 45,4 | 26,9 | 19,1 | 12,1 | 8,9 |
| **USD 20** | 62,6 | 32,1 | **21,6** | 13,1 | 9,4 |
| USD 30 | 100,9 | 39,9 | 24,9 | 14,2 | 9,9 |

**Lectura:** el caso se sostiene para quien ya gasta USD 75+/mes en IA. Por
debajo de ese piso el payback supera los 3 años y el proyecto pierde sentido
económico frente a seguir pagando la API. Este análisis **excluye** cualquier
ingreso por vender inferencia a terceros — es el piso del caso, no el techo.

---

## Modelo B — Revendedor / importador (margen)

Cascada de costos para importar el hardware y venderlo en MercadoLibre
Argentina.

| Concepto | USD |
| --- | ---: |
| Precio exterior (FOB) | 750,00 |
| + Costos de importación (35%) | 262,50 |
| **= Costo puesto en Argentina** | **1.012,50** |
| + Costo MercadoLibre (ARS 500.000) | 312,50 |
| **= Costo total por unidad** | **1.325,00** |
| Precio de venta | 1.650,00 |
| **Ganancia por unidad** | **325,00** |

**Margen sobre venta: 19,7%** · **Markup sobre costo puesto: 32,1%**

### Despliegue de una inversión de USD 2.500

El capital financia inventario; el costo de MercadoLibre se descuenta de la
venta, no se prepaga.

| | |
| --- | ---: |
| Unidades que financia | **2** |
| Capital usado | USD 2.025 |
| Capital ocioso (buffer) | USD 475 |
| Ganancia del primer lote | **USD 650** |
| **ROI sobre inversión total** | **26,0%** |
| ROI sobre capital desplegado | 32,1% |

### Cashflow del primer lote

| Momento | Flujo |
| --- | ---: |
| t0 — compra + importación | −USD 2.025 |
| t1 — venta de 2 unidades (neta de ML) | +USD 2.675 |
| **Neto** | **+USD 650** |

### Reinversión compuesta (supuesto: 60 días por ciclo)

*El ciclo de 60 días es un supuesto de trabajo — tiempo de importación más
venta — no un dato medido. Ajustarlo cambia todos los valores de esta tabla.*

| Ciclo | Mes | Unidades | Capital inicial | Capital final | Ganancia |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 2 | 2.500 | 3.150 | +650 |
| 2 | 4 | 3 | 3.150 | 4.125 | +975 |
| 3 | 6 | 4 | 4.125 | 5.425 | +1.300 |
| 4 | 8 | 5 | 5.425 | 7.050 | +1.625 |
| 5 | 10 | 6 | 7.050 | 9.000 | +1.950 |
| 6 | 12 | 8 | 9.000 | **11.600** | +2.600 |

En 12 meses reinvirtiendo todo: USD 2.500 → USD 11.600 (×4,6), sobre 30
unidades acumuladas vendidas. Es el techo teórico bajo demanda ilimitada, no
una proyección de ventas.

---

## Riesgos y lo que no está probado

- **El margen del 19,7% es ajustado.** Un movimiento del tipo de cambio, una
  suba arancelaria o una promoción agresiva de la competencia en MercadoLibre
  lo reduce rápido. Es un negocio de rotación, no de margen alto por unidad.
- **El modelo de reinversión asume demanda ilimitada** a cada ciclo. No hay
  dato de velocidad de venta real que lo sostenga todavía.
- **El Modelo A no incluye ingresos por vender inferencia a la red.** El
  campo `economic` del manifiesto está marcado como mock (`_mock: true`) en
  el propio protocolo — ver [README](README.md#estado). No hay capa de
  liquidación implementada, así que cualquier ingreso adicional por ese lado
  es upside no cuantificado, no parte de este cálculo.
- **Los dos modelos comparten el mismo precio de venta (USD 1.650)** a
  propósito, para que sean consistentes entre sí: es lo que paga el operador
  del Modelo A y lo que cobra el revendedor del Modelo B.

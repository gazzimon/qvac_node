#!/usr/bin/env python3
"""
Recalcula todos los numeros de EVALUACION-ECONOMICA.md a partir de los
supuestos declarados ahi. Cambiar un valor aca y correr el script reproduce
la tabla correspondiente -- ningun numero del documento esta escrito a mano
sin este script atras.

Uso: python scripts/eval-economica.py
"""

def npv(rate_m, flows):
    return sum(f / (1 + rate_m) ** t for t, f in enumerate(flows))


def irr(flows, lo=1e-6, hi=1.0):
    # busqueda binaria: npv(r) es monotona decreciente en r para estos flujos
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(mid, flows) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


FX = 1600.0
TASA_ANUAL = 0.12
r_m = (1 + TASA_ANUAL) ** (1 / 12) - 1
H = 36

KWH_MES = 43.2
ARS_KWH = 135.0
LUZ = KWH_MES * ARS_KWH / FX

print("=" * 70)
print("MODELO A -- OPERADOR DEL NODO (ahorro)")
print("=" * 70)

CAPEX_OPERADOR = 1650.0
FACTURA_ACTUAL = 100.0
FACTURA_NUEVA = 20.0
AHORRO_BRUTO = FACTURA_ACTUAL - FACTURA_NUEVA
NETO_OPERADOR = AHORRO_BRUTO - LUZ

print(f"CAPEX                  : USD {CAPEX_OPERADOR:,.2f}")
print(f"Ahorro bruto            : USD {AHORRO_BRUTO:,.2f} /mes")
print(f"Costo electrico         : USD {LUZ:,.2f} /mes")
print(f"Beneficio neto          : USD {NETO_OPERADOR:,.2f} /mes")

flows = [-CAPEX_OPERADOR] + [NETO_OPERADOR] * H
pb = CAPEX_OPERADOR / NETO_OPERADOR
van = npv(r_m, flows)
tir_m = irr(flows)
tir_a = (1 + tir_m) ** 12 - 1
total = NETO_OPERADOR * H

print(f"Payback                 : {pb:.1f} meses ({pb / 12:.2f} anios)")
print(f"Beneficio neto {H}m      : USD {total - CAPEX_OPERADOR:,.0f}")
print(f"ROI simple {H}m          : {(total - CAPEX_OPERADOR) / CAPEX_OPERADOR * 100:,.0f}%")
print(f"VAN @{TASA_ANUAL*100:.0f}%              : USD {van:,.0f}")
print(f"TIR anualizada          : {tir_a * 100:,.0f}%")

print()
print("Sensibilidad -- payback en meses")
print("  factura actual ->    50     75    100    150    200")
for nuevo in (10, 20, 30):
    fila = f"  plan nuevo USD {nuevo:>3} "
    for viejo in (50, 75, 100, 150, 200):
        neto = (viejo - nuevo) - LUZ
        fila += f"{CAPEX_OPERADOR / neto:>7.1f}" if neto > 0 else "    n/a"
    print(fila)

print()
print("=" * 70)
print("MODELO B -- REVENDEDOR / IMPORTADOR (margen)")
print("=" * 70)

COMPRA_EXT = 750.0
IMPORT_PCT = 0.35
ML_ARS = 500_000.0
PRECIO_VENTA = 1650.0
INVERSION = 2500.0
DIAS_POR_CICLO = 60

import_costo = COMPRA_EXT * IMPORT_PCT
costo_puesto = COMPRA_EXT + import_costo
ml_usd = ML_ARS / FX
costo_total_unit = costo_puesto + ml_usd
ganancia_unit = PRECIO_VENTA - costo_total_unit

print(f"Costo puesto en Argentina : USD {costo_puesto:,.2f}")
print(f"Costo MercadoLibre        : USD {ml_usd:,.2f}  (ARS {ML_ARS:,.0f})")
print(f"Costo total por unidad    : USD {costo_total_unit:,.2f}")
print(f"Ganancia por unidad       : USD {ganancia_unit:,.2f}")
print(f"Margen sobre venta        : {ganancia_unit / PRECIO_VENTA * 100:.1f}%")
print(f"Markup sobre costo puesto : {ganancia_unit / costo_puesto * 100:.1f}%")

unidades = int(INVERSION // costo_puesto)
usado = unidades * costo_puesto
buffer_ = INVERSION - usado
ingresos = unidades * PRECIO_VENTA
ml_total = unidades * ml_usd
ganancia_total = ingresos - ml_total - usado

print(f"\nInversion USD {INVERSION:,.0f} financia : {unidades} unidades")
print(f"Capital usado / buffer    : USD {usado:,.0f} / USD {buffer_:,.0f}")
print(f"Ganancia del primer lote  : USD {ganancia_total:,.0f}")
print(f"ROI sobre inversion total : {ganancia_total / INVERSION * 100:.1f}%")
print(f"ROI sobre capital desplegado: {ganancia_total / usado * 100:.1f}%")

print(f"\nReinversion compuesta (supuesto {DIAS_POR_CICLO} dias/ciclo):")
capital = INVERSION
for ciclo in range(1, 7):
    u = int(capital // costo_puesto)
    if u == 0:
        break
    used = u * costo_puesto
    ingreso_neto = u * (PRECIO_VENTA - ml_usd)
    g = ingreso_neto - used
    nuevo = capital + g
    mes = ciclo * DIAS_POR_CICLO // 30
    print(f"  ciclo {ciclo} (mes {mes:>2}): {u} u | {capital:>9,.0f} -> {nuevo:>9,.0f}  (+{g:,.0f})")
    capital = nuevo

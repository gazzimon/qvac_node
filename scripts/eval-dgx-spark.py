#!/usr/bin/env python3
"""
Estudio economico del NVIDIA DGX Spark como nodo PyrusLLM.

Pregunta que responde: cuanto tarda en recuperarse la inversion del equipo,
en funcion de (a) cuantos tokens produce por segundo, (b) que fraccion del
tiempo esta realmente produciendo, y (c) a cuanto se valora cada token.

Todos los supuestos estan declarados arriba. Cambiar un valor y correr el
script recalcula EVALUACION-DGX-SPARK.md entero.

Uso: python scripts/eval-dgx-spark.py
"""

# ----------------------------------------------------------------------
# SUPUESTOS
# ----------------------------------------------------------------------
FX            = 1600.0    # ARS / USD
ARS_KWH       = 135.0     # tarifa electrica
TASA_ANUAL    = 0.12      # descuento en USD
H             = 36        # horizonte, meses
SEG_MES       = 30 * 24 * 3600

PRECIO_AMAZON = 4799.99   # precio de lista (USD 4.749,99 con Amazon Visa)
IMPORT_PCT    = 0.35      # nacionalizacion formal en Argentina

W_CARGA       = 150.0     # consumo bajo inferencia sostenida (fuente: 240 W)
W_IDLE        = 45.0      # consumo en reposo, encendido 24/7

# Ancho de banda de memoria del GB10: es EL cuello de botella del decode.
BW_GBS        = 273.0     # GB/s, LPDDR5x unificada 128 GB
EFICIENCIA    = 0.75      # fraccion del ancho de banda teorico que se logra

# Precios de la API de Anthropic (USD / millon de tokens de salida)
API_OUT = {
    "Haiku 4.5":  5.0,
    "Sonnet 5":  15.0,
    "Opus 5":    25.0,
}
# Precio de mercado de tokens de modelos abiertos (commodity, agregadores)
PRECIO_COMMODITY = 0.30

r_m = (1 + TASA_ANUAL) ** (1 / 12) - 1


def npv(rate_m, flows):
    return sum(f / (1 + rate_m) ** t for t, f in enumerate(flows))


def irr(flows, lo=1e-9, hi=1.0):
    for _ in range(300):
        mid = (lo + hi) / 2
        if npv(mid, flows) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def luz(util):
    """Costo electrico mensual en USD para una utilizacion dada."""
    kwh = (W_CARGA * util + W_IDLE * (1 - util)) * 720 / 1000
    return kwh * ARS_KWH / FX


W = 74
print("=" * W)
print("NVIDIA DGX SPARK COMO NODO -- ESTUDIO DE RECUPERO")
print("=" * W)

CAPEX_MANO = PRECIO_AMAZON
CAPEX_NAC  = PRECIO_AMAZON * (1 + IMPORT_PCT)
print(f"CAPEX comprado afuera        : USD {CAPEX_MANO:>9,.2f}")
print(f"CAPEX nacionalizado (+{IMPORT_PCT*100:.0f}%)   : USD {CAPEX_NAC:>9,.2f}")
print(f"Amortizacion lineal a {H}m    : USD {CAPEX_MANO/H:>9,.2f} /mes  "
      f"(nac.: {CAPEX_NAC/H:,.2f})")
print(f"Electricidad 24/7 al 100%    : USD {luz(1.0):>9,.2f} /mes")
print(f"Electricidad 24/7 al 10%     : USD {luz(0.1):>9,.2f} /mes")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("1. CAPACIDAD -- cuantos tokens/s produce el equipo")
print("=" * W)
print("Estimacion por ancho de banda: el decode lee los pesos del modelo una")
print("vez por token, asi que tok/s ~= (BW util) / (bytes del modelo).")
print(f"BW util = {BW_GBS:.0f} GB/s x {EFICIENCIA:.0%} = {BW_GBS*EFICIENCIA:.0f} GB/s")
print()
print(f"{'Modelo (cuant. 4 bit)':<26}{'GB':>7}{'tok/s 1 flujo':>15}{'tok/s lote x8':>15}")
print("-" * W)
modelos = [
    ("Llama 3.1 8B",           4.7,  6.0),
    ("Qwen3 32B",             18.0,  4.5),
    ("gpt-oss-120b (MoE)",     3.5,  3.0),   # ~5,1B activos: lee poco por token
    ("Llama 3.3 70B",         40.0,  3.5),
]
for nombre, gb, mult in modelos:
    single = BW_GBS * EFICIENCIA / gb
    print(f"{nombre:<26}{gb:>7.1f}{single:>15.0f}{single*mult:>15.0f}")
print()
print("El lote (batching) es lo que hace rentable un nodo: varios pedidos")
print("concurrentes comparten la misma lectura de pesos.")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("2. COSTO MARGINAL -- cuanto cuesta el token propio")
print("=" * W)
print(f"{'tok/s sostenidos':>18}{'MTok/mes':>12}{'USD/MTok (luz)':>18}"
      f"{'USD/MTok (+CAPEX 36m)':>24}")
print("-" * W)
for tps in (20, 50, 120, 300):
    mtok = tps * SEG_MES / 1e6
    c_luz = luz(1.0) / mtok
    c_tot = (luz(1.0) + CAPEX_MANO / H) / mtok
    print(f"{tps:>18}{mtok:>12.1f}{c_luz:>18.3f}{c_tot:>24.3f}")
print()
print("Referencia API (USD/MTok de salida): " +
      ", ".join(f"{k} {v:.0f}" for k, v in API_OUT.items()) +
      f", commodity abierto ~{PRECIO_COMMODITY:.2f}")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("3. PAYBACK -- meses para recuperar USD {:,.0f}".format(CAPEX_MANO))
print("=" * W)
TPS_BASE = 50.0
CAP_MES = TPS_BASE * SEG_MES / 1e6   # MTok de salida al mes, saturado
print(f"Caso base: {TPS_BASE:.0f} tok/s de salida sostenidos "
      f"= {CAP_MES:.1f} MTok/mes a saturacion plena.")
print()
precios = [PRECIO_COMMODITY, 1.0, 5.0, 15.0, 25.0]
enc = ["commodity", "USD 1", "Haiku 5", "Sonnet 15", "Opus 25"]
print(f"{'Utilizacion':<14}" + "".join(f"{e:>12}" for e in enc))
print("-" * W)
for util in (0.05, 0.10, 0.25, 0.50, 1.00):
    fila = f"{util:>10.0%} ({util*24:>4.1f} h/d)"
    fila = f"{util:<4.0%} ({util*24:>4.1f} h/dia)".ljust(14)
    for p in precios:
        neto = CAP_MES * util * p - luz(util)
        if neto <= 0:
            fila += f"{'nunca':>12}"
        else:
            pb = CAPEX_MANO / neto
            fila += f"{pb:>11.0f}m" if pb <= 240 else f"{'>20 anios':>12}"
    print(fila)
print()
print("Lectura: la variable dominante NO es el hardware, es cuantas horas")
print("por dia el equipo esta realmente produciendo tokens que alguien paga.")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("4. ESCENARIOS COMPLETOS (36 meses, 12% anual)")
print("=" * W)
escenarios = [
    # nombre,                    tok/s, util, USD/MTok, capex
    ("Uso personal (1 dev)",       50, 0.08,  5.0, CAPEX_MANO),
    ("Equipo chico (8 personas)",  50, 0.35,  5.0, CAPEX_MANO),
    ("Vender commodity 24/7",      50, 0.90,  0.30, CAPEX_MANO),
    ("Nodo privacidad (clinica)",  50, 0.35, 15.0, CAPEX_MANO),
    ("Nodo privacidad nacionaliz", 50, 0.35, 15.0, CAPEX_NAC),
]
print(f"{'Escenario':<30}{'Neto/mes':>11}{'Payback':>10}{'VAN 12%':>11}{'TIR a.':>9}")
print("-" * W)
for nombre, tps, util, precio, capex in escenarios:
    cap = tps * SEG_MES / 1e6
    neto = cap * util * precio - luz(util)
    flows = [-capex] + [neto] * H
    van = npv(r_m, flows)
    if neto > 0:
        pb = capex / neto
        pb_s = f"{pb:.0f}m" if pb <= 240 else ">20a"
    else:
        pb_s = "nunca"
    tir_a = (1 + irr(flows)) ** 12 - 1 if van > 0 else 0.0
    tir_s = f"{tir_a*100:.0f}%" if van > 0 else "neg"
    print(f"{nombre:<30}{neto:>11,.0f}{pb_s:>10}{van:>11,.0f}{tir_s:>9}")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("5. PUNTO DE EQUILIBRIO -- tokens totales a vender/ahorrar")
print("=" * W)
print(f"{'Valor del token':<22}{'MTok para recuperar':>22}{'dias a 50 tok/s':>18}")
print("-" * W)
for nombre, p in [("commodity 0,30", PRECIO_COMMODITY), ("USD 1", 1.0),
                  ("Haiku 5", 5.0), ("Sonnet 15", 15.0), ("Opus 25", 25.0)]:
    mtok = CAPEX_MANO / p
    dias = mtok * 1e6 / (TPS_BASE * 86400)
    print(f"{nombre:<22}{mtok:>22,.0f}{dias:>18,.0f}")
print()
print("(dias = a saturacion continua; dividir por la utilizacion real)")

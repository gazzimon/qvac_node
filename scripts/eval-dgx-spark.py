#!/usr/bin/env python3
"""
Economic study of the NVIDIA DGX Spark as a PyrusLLM node.

Question it answers: how long does it take to recoup the machine's
investment, as a function of (a) how many tokens it produces per second,
(b) what fraction of the time it's actually producing, and (c) how much
each token is valued at.

All assumptions are declared above. Changing a value and running the
script recalculates docs/EVALUACION-DGX-SPARK.md entirely.

Usage: python scripts/eval-dgx-spark.py
"""

# ----------------------------------------------------------------------
# ASSUMPTIONS
# ----------------------------------------------------------------------
FX            = 1600.0    # ARS / USD
ARS_KWH       = 135.0     # electricity rate
TASA_ANUAL    = 0.12      # USD discount rate
H             = 36        # horizon, months
SEG_MES       = 30 * 24 * 3600

PRECIO_AMAZON = 4799.99   # list price (USD 4,749.99 with Amazon Visa)
IMPORT_PCT    = 0.35      # formal import/nationalization in Argentina

W_CARGA       = 150.0     # consumption under sustained inference (rated: 240 W)
W_IDLE        = 45.0      # idle consumption, powered on 24/7

# GB10 memory bandwidth: it's THE decode bottleneck.
BW_GBS        = 273.0     # GB/s, unified 128 GB LPDDR5x
EFICIENCIA    = 0.75      # fraction of theoretical bandwidth actually achieved

# Anthropic API prices (USD / million output tokens)
API_OUT = {
    "Haiku 4.5":  5.0,
    "Sonnet 5":  15.0,
    "Opus 5":    25.0,
}
# Market price for open-model tokens (commodity, aggregators)
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
    """Monthly electricity cost in USD for a given utilization."""
    kwh = (W_CARGA * util + W_IDLE * (1 - util)) * 720 / 1000
    return kwh * ARS_KWH / FX


W = 74
print("=" * W)
print("NVIDIA DGX SPARK AS A NODE -- PAYBACK STUDY")
print("=" * W)

CAPEX_MANO = PRECIO_AMAZON
CAPEX_NAC  = PRECIO_AMAZON * (1 + IMPORT_PCT)
print(f"CAPEX bought abroad          : USD {CAPEX_MANO:>9,.2f}")
print(f"CAPEX nationalized (+{IMPORT_PCT*100:.0f}%)     : USD {CAPEX_NAC:>9,.2f}")
print(f"Straight-line amortization {H}m: USD {CAPEX_MANO/H:>9,.2f} /mo  "
      f"(nat.: {CAPEX_NAC/H:,.2f})")
print(f"Electricity 24/7 at 100%     : USD {luz(1.0):>9,.2f} /mo")
print(f"Electricity 24/7 at 10%      : USD {luz(0.1):>9,.2f} /mo")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("1. CAPACITY -- how many tokens/s the machine produces")
print("=" * W)
print("Bandwidth-based estimate: decode reads the model's weights once per")
print("token, so tok/s ~= (usable BW) / (model bytes).")
print(f"usable BW = {BW_GBS:.0f} GB/s x {EFICIENCIA:.0%} = {BW_GBS*EFICIENCIA:.0f} GB/s")
print()
print(f"{'Model (4-bit quant)':<26}{'GB':>7}{'tok/s 1 stream':>15}{'tok/s batch x8':>15}")
print("-" * W)
modelos = [
    ("Llama 3.1 8B",           4.7,  6.0),
    ("Qwen3 32B",             18.0,  4.5),
    ("gpt-oss-120b (MoE)",     3.5,  3.0),   # ~5.1B active: reads little per token
    ("Llama 3.3 70B",         40.0,  3.5),
]
for nombre, gb, mult in modelos:
    single = BW_GBS * EFICIENCIA / gb
    print(f"{nombre:<26}{gb:>7.1f}{single:>15.0f}{single*mult:>15.0f}")
print()
print("Batching is what makes a node profitable: several concurrent")
print("requests share the same weight read.")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("2. MARGINAL COST -- how much the token itself costs")
print("=" * W)
print(f"{'sustained tok/s':>18}{'MTok/mo':>12}{'USD/MTok (elec.)':>18}"
      f"{'USD/MTok (+CAPEX 36m)':>24}")
print("-" * W)
for tps in (20, 50, 120, 300):
    mtok = tps * SEG_MES / 1e6
    c_luz = luz(1.0) / mtok
    c_tot = (luz(1.0) + CAPEX_MANO / H) / mtok
    print(f"{tps:>18}{mtok:>12.1f}{c_luz:>18.3f}{c_tot:>24.3f}")
print()
print("API reference (USD/MTok output): " +
      ", ".join(f"{k} {v:.0f}" for k, v in API_OUT.items()) +
      f", open commodity ~{PRECIO_COMMODITY:.2f}")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("3. PAYBACK -- months to recoup USD {:,.0f}".format(CAPEX_MANO))
print("=" * W)
TPS_BASE = 50.0
CAP_MES = TPS_BASE * SEG_MES / 1e6   # MTok output per month, saturated
print(f"Base case: {TPS_BASE:.0f} sustained output tok/s "
      f"= {CAP_MES:.1f} MTok/mo at full saturation.")
print()
precios = [PRECIO_COMMODITY, 1.0, 5.0, 15.0, 25.0]
enc = ["commodity", "USD 1", "Haiku 5", "Sonnet 15", "Opus 25"]
print(f"{'Utilization':<14}" + "".join(f"{e:>12}" for e in enc))
print("-" * W)
for util in (0.05, 0.10, 0.25, 0.50, 1.00):
    fila = f"{util:>10.0%} ({util*24:>4.1f} h/d)"
    fila = f"{util:<4.0%} ({util*24:>4.1f} h/day)".ljust(14)
    for p in precios:
        neto = CAP_MES * util * p - luz(util)
        if neto <= 0:
            fila += f"{'never':>12}"
        else:
            pb = CAPEX_MANO / neto
            fila += f"{pb:>11.0f}m" if pb <= 240 else f"{'>20 years':>12}"
    print(fila)
print()
print("Reading: the dominant variable is NOT the hardware, it's how many hours")
print("per day the machine is actually producing tokens that someone pays for.")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("4. FULL SCENARIOS (36 months, 12% annual)")
print("=" * W)
escenarios = [
    # name,                       tok/s, util, USD/MTok, capex
    ("Personal use (1 dev)",       50, 0.08,  5.0, CAPEX_MANO),
    ("Small team (8 people)",      50, 0.35,  5.0, CAPEX_MANO),
    ("Sell commodity 24/7",        50, 0.90,  0.30, CAPEX_MANO),
    ("Privacy node (clinic)",      50, 0.35, 15.0, CAPEX_MANO),
    ("Privacy node, nationalized", 50, 0.35, 15.0, CAPEX_NAC),
]
print(f"{'Scenario':<30}{'Net/mo':>11}{'Payback':>10}{'NPV 12%':>11}{'IRR a.':>9}")
print("-" * W)
for nombre, tps, util, precio, capex in escenarios:
    cap = tps * SEG_MES / 1e6
    neto = cap * util * precio - luz(util)
    flows = [-capex] + [neto] * H
    van = npv(r_m, flows)
    if neto > 0:
        pb = capex / neto
        pb_s = f"{pb:.0f}m" if pb <= 240 else ">20y"
    else:
        pb_s = "never"
    tir_a = (1 + irr(flows)) ** 12 - 1 if van > 0 else 0.0
    tir_s = f"{tir_a*100:.0f}%" if van > 0 else "neg"
    print(f"{nombre:<30}{neto:>11,.0f}{pb_s:>10}{van:>11,.0f}{tir_s:>9}")

# ----------------------------------------------------------------------
print()
print("=" * W)
print("5. BREAK-EVEN POINT -- total tokens to sell/save")
print("=" * W)
print(f"{'Token value':<22}{'MTok to recoup':>22}{'days at 50 tok/s':>18}")
print("-" * W)
for nombre, p in [("commodity 0.30", PRECIO_COMMODITY), ("USD 1", 1.0),
                  ("Haiku 5", 5.0), ("Sonnet 15", 15.0), ("Opus 25", 25.0)]:
    mtok = CAPEX_MANO / p
    dias = mtok * 1e6 / (TPS_BASE * 86400)
    print(f"{nombre:<22}{mtok:>22,.0f}{dias:>18,.0f}")
print()
print("(days = at continuous saturation; divide by actual utilization)")

# Contexto para agentes — PyrusLLM

Nodo de inferencia LLM distribuido por Pear. Runtime **Bare** (no Node en
producción), gateway compatible con OpenAI, manifiesto firmado Ed25519, pagos
x402 sobre stablecoin.

## Fuentes de verdad — leer estas, en este orden

| Tema | Archivo |
| --- | --- |
| Estado real del proyecto (qué anda, qué es mock) | [`README.md`](README.md) |
| Números medidos (peso de install, TTFT, tps) | [`NOTES.md`](NOTES.md) |
| Carga, capacidad y ruteo | [`NOTES-SATURACION.md`](NOTES-SATURACION.md) |
| Plan vigente (Fase 7→13: x402, liquidación, capa agéntica) | [`ROADMAP_FASE7-X402.md`](ROADMAP_FASE7-X402.md) |
| Correcciones al plan por evidencia externa | [`ROADMAP_REVISION-EVIDENCIA.md`](ROADMAP_REVISION-EVIDENCIA.md) |
| Schema del manifiesto (**congelado — no editar**) | `manifest-v0.json` — lo valida `test/index.js` con path relativo a la raíz |

Código: `bin.mjs` (entrypoint) → `app.js` → `qvac/`. Tests en `test/`, scripts de
`npm` en `scripts/`.

## NO usar como fuente — contexto superado

| Ruta | Qué es |
| --- | --- |
| `old/**` | Descartes crudos (gitignored). Nunca es fuente. |
| `archivo/**` | Histórico versionado: se consulta, no se trabaja. Playbook del hackathon, runbook original, capturas de demo viejas. |
| `docs/roadmap/ROADMAP_FASE2-6.md` | Fases 0–6 **cerradas**. Solo por los enlaces entrantes. |
| `docs/entregables/`, `docs/papers/`, `docs/aplicacion/` | Outputs (pitch, síntesis de papers, application). No son diseño vigente. |
| `docs/economia/` | Estudios reproducibles vía `scripts/eval-*.py`. Insumo, no plan. |

Regla: si algo de `docs/` o `archivo/` contradice al `README.md` o al roadmap
activo, gana el `README.md`.

## Convención de orden (6S)

- Material que deja de estar vigente → `archivo/` (versionado) u `old/`
  (gitignored). **Nunca se deja contexto muerto en la raíz.**
- La raíz solo tiene: los 5 docs de la tabla de arriba, `manifest-v0.json`,
  código y config. Nada de `.html`/`.docx`/`.png` sueltos: nacen en `docs/`.
- Cuando una fase cierra: su roadmap recibe el banner `ESTADO: CERRADO` con
  enlace al que lo reemplaza, y se mueve a `docs/roadmap/` en el mismo commit.
- `build/`, `out/`, `.playwright-mcp/` son regenerables (`npm run make`) y no se
  versionan.

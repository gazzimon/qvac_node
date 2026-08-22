# Prompt para verificar si Fase 2 está terminada

Pegá todo lo que sigue en una sesión nueva de Claude Code, parada en el repo y
en la rama que dice tener Fase 2.

---

Tenés que **verificar** si la Fase 2 de este proyecto está terminada. No la
implementes, no la arregles: verificá y dictaminá.

## Regla de oro

**Evidencia, no afirmaciones.** El nombre de la rama, el mensaje del commit, el
README y los comentarios del código no son evidencia de nada. Ya pasó una vez:
una rama llamada `fase-2-marketplace-paneles` no tenía una sola línea de Fase 2.

Cada punto del checklist se responde con una de tres cosas:

- **SÍ** + el comando que lo demuestra y su salida real
- **NO** + qué falta
- **PARCIAL** + qué anda y qué no

Si no pudiste ejecutar algo, decí "no verificado" — nunca lo des por bueno.

## Qué es Fase 2 acá

La Definition of Done está en `ROADMAP_FASE2-6.md` y es literal:

> Dos nodos en máquinas distintas se descubren en el topic e intercambian
> manifiestos verificados, sobre el mismo canal `FramedStream` que va a
> transportar requests de inferencia en Fase 3.

Leé la sección "Fase 2" completa del ROADMAP antes de empezar: las decisiones
D1, D2, D3 y D6 son parte del contrato.

## Checklist

**0. ¿Existe algo?** Barato y descarta el caso "ni empezó":

```bash
grep -rlE "hyperswarm|FramedStream|signManifest|verifyManifest|node:status" \
  --include="*.mjs" --include="*.js" . | grep -v node_modules
```

Si no aparece nada, Fase 2 está al 0% y el resto del checklist sobra.

**1. Manifiesto**

- ¿Se arma un manifiesto que valida contra `manifest-v0.json`?
- D2 exige que `economic` y `directory` tengan valores mock **marcados como
  tales** en el código y en el README. ¿Están marcados, o parecen reales?
- ¿Portado a zod 4?

**2. Firma**

- `signManifest` / `verifyManifest` con Ed25519 sobre JCS (RFC 8785).
- **Tiene que haber test de caso negativo.** Corré el test. Si no existe,
  fabricá vos un manifiesto con un campo alterado y confirmá que
  `verifyManifest` lo rechaza. Una firma que nunca se probó fallando no está
  verificada.

**3. Swarm**

- Topic fijo hardcodeado, vía `hyperswarm`.
- Cada conexión envuelta en `FramedStream` — **el mismo canal** que Fase 3 va a
  usar para `chat:request`/`chat:chunk`, no una conexión aparte.
- El nodo publica su manifiesto firmado al conectarse con un par.
- Un manifiesto que no verifica se descarta **antes de leer nada más**.

**4. D6 — `node:status`**

- ¿El nodo emite `{ activeRequests, maxConcurrentRequests }` periódicamente por
  ese mismo canal?

**5. D3 — candidatos por estado de socket**

- Los pares vivos/muertos se determinan por el socket, **no** por un `expiresAt`
  ni por un flag que setea un admin.

**6. D7 — medición**

- ¿Está medido y anotado en `NOTES.md` el tiempo desde `topic.join()` hasta la
  primera conexión de peer?

**7. La DoD de verdad**

Levantá **dos procesos** y comprobá que se descubren e intercambian manifiestos
verificados. Reportá la salida cruda.

Pasarlo en una sola máquina es **necesario pero no suficiente**: la DoD dice
"máquinas distintas". Si solo pudiste probar local, el veredicto es PARCIAL.

## Trampas de este repo (todas medidas, no teóricas)

Te van a hacer reportar verde algo roto:

1. **`pear install` sale con código 0 después de imprimir `Failed`.** Y deja un
   binario truncado, ejecutable, que no arranca. Nunca uses `$?` ni `test -x`
   como prueba de install: la prueba es que el binario **corra** y devuelva
   `v\d+\.\d+\.\d+`.
2. **El `ping` de Windows cuenta "Host inalcanzable" como paquete recibido.**
   Reporta 0% de pérdida con el host muerto. Contá respuestas reales:
   `ping -n 10 <ip> | grep -c "TTL="`.
3. **El binario standalone se cuelga para siempre si su stdout es un pipe de
   libuv** (`spawn` de Node con `stdio: 'pipe'`). Consola, archivo y pipes de
   shell andan. Si lanzás el binario desde un script Node, mandá la salida a un
   **archivo**. Si no, vas a reportar "colgado" sobre código sano.
4. **Si algo del P2P falla, la causa es la red hasta que se demuestre lo
   contrario.** Ya se perdió un día entero buscándolo en el código. El AP
   corporativo Fortinet aísla clientes y rompe el P2P; el hotspot del iPhone
   funciona. Medí antes de acusar al código.
5. **`sdk.plugins()` no es idempotente**: llamarla dos veces tira
   `PLUGIN_ALREADY_REGISTERED`.

## Cómo reportar

Terminá con una tabla y un veredicto de una línea:

| ítem | estado | evidencia |
| ---- | ------ | --------- |

Y después: **¿la DoD de Fase 2 está cumplida, sí o no?** Si es "no", decí cuál
es el trabajo mínimo que falta — sin ampliar el alcance.

No arregles nada sin que te lo pidan.

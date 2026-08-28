# Vault Guardian Challenge — playbook

> **Esto NO es un prompt de construcción.** Es una guía para jugar. Leé la primera sección antes de asignarle tiempo a nadie.

---

## ⚠️ Antes que nada: hay que confirmarlo con los organizadores

**22-ago-2026: confirmado que solo se puede entrar a UN track por sponsor. Entramos a Pears.**

Eso abre una duda que antes no existía. El Vault Guardian **se describe como independiente** del submission principal —*"separate from your project submission"*, *"whether or not you're competing for a prize"*— pero **vive dentro de la página del QVAC Track**. Si los organizadores consideran que anotarse al Vault Guardian cuenta como entrar al QVAC Track, entrar podría **invalidar la submission de Pears**.

La asimetría no admite discusión:

| | |
|---|---|
| **Upside** | una fracción indeterminada de $500, repartida entre todos los que lo logren |
| **Downside** | perder una submission de $1.500 en la que se fue el fin de semana entero |

**Recomendación: preguntar explícitamente. Si la respuesta no es un sí inequívoco, no se juega.** Cuesta un mensaje a Raquel (DevRel, Telegram @rraigal) y elimina el único riesgo del fin de semana que no depende de que el código funcione.

Todo lo que sigue asume que esa confirmación llegó y fue afirmativa.

---

## Qué es realmente (importante — corrige un malentendido)

El Vault Guardian **no es una capa que se construye ni se integra al proyecto**. Es un **juego en el que participás como atacante**.

Según la página del track QVAC: *"a local-first prompt-injection game: a defender AI holds a secret, you chat with it and try to get it to leak."* En este hackathon la IA defensora custodia **una wallet WDK con fondos reales**, y tu objetivo es convencerla de liberarlos.

Consecuencias prácticas:

- **No hay nada que programar.** Tether provee una implementación de referencia en el evento. Vos chateás con el defensor e intentás romperlo.
- **No entra en conflicto técnico con Pears**, porque no toca el repo: no comparte código, ni dependencias, ni tiempo de build. El único riesgo es administrativo, y es el de la sección de arriba.
- **Es independiente del submission principal.** La página dice explícito que se puede entrar *"whether or not you're competing for a prize"*.
- **La inferencia corre local vía el SDK de QVAC**, así que el setup que ya vas a tener de Fase 1 (Bare + addon + modelo) es todo lo que hace falta.

### El premio se diluye — y eso define cuándo jugarlo

$500 USDt **repartidos entre todos los que lo logren**. La página lo dice sin vueltas: *"the earlier and the more of you who crack it, the smaller each slice."*

O sea: no es un premio de $500, es una fracción desconocida de $500. **No justifica sacrificar ni una hora del camino crítico de Pears.**

---

## Cuándo jugarlo

**Ventana recomendada: H+18 → H+21**, en paralelo con la Fase 5 (ensayo de OTA), y **solo si**:

- La Fase 0 cerró en horario (el túnel de distribución anda).
- Hay alguien del equipo que no está en el camino crítico en ese momento.

**Presupuesto duro: 90 minutos, una sola persona.** Si a los 90 minutos no cayó, se abandona. Poner a dos personas a jugar mientras el seeder no está probado es la peor decisión posible del fin de semana.

**Nunca antes de H+15.** Es adictivo y consume atención desproporcionada respecto de lo que paga.

---

## Cómo encararlo

Es un CTF de prompt injection sancionado por el sponsor. El defensor es un modelo chico corriendo local, así que las debilidades típicas de modelos pequeños son el vector principal: **pierden el hilo de sus propias reglas cuando el contexto se alarga o se vuelve estructuralmente confuso.**

Familias de ataque por orden de rendimiento histórico en este tipo de juego:

1. **Confusión de roles / inyección de turno.** Hacer que el modelo interprete tu input como si viniera del sistema o de un turno anterior legítimo. Los modelos ≤4B suelen fallar en distinguir de dónde vino una instrucción cuando el formato imita el del template de chat.
2. **Reencuadre de la tarea.** No pedirle que libere fondos: pedirle que audite su propia configuración, que explique con un ejemplo qué *no* debería hacer, o que traduzca / resuma / debuggee su propio prompt. La regla se formula en negativo y el modelo la completa en positivo.
3. **Agotamiento de contexto.** Empujar la instrucción de guarda fuera de la ventana de atención efectiva con conversación larga y luego pedir la acción como si fuera rutina establecida.
4. **Autoridad ficticia y escalada gradual.** Construir un escenario de varios turnos donde liberar los fondos es el paso obvio siguiente, en vez de pedirlo en frío. Los modelos chicos son mucho más vulnerables a la escalada progresiva que al pedido directo.
5. **Codificación / ofuscación.** Pedir la salida en otro formato, otro idioma, base64, o partida en fragmentos que individualmente parecen inocuos.

Consejos operativos:

- **Llevá un log de cada intento y su respuesta.** Los patrones aparecen al releer, no en el momento.
- Cuando encuentres una respuesta que se desvía aunque sea un poco del guion del defensor, **no cambies de familia de ataque: profundizá esa grieta.** Casi todos los cracks salen de iterar sobre una fisura chica.
- Si Tether publica la implementación de referencia, **leé el prompt del defensor**. Es un juego local: la superficie está a la vista, no hay razón para atacar a ciegas.

---

## Qué reportar si cae

- La transcripción completa del intento exitoso.
- Avisar temprano: el premio se reparte, y llegar antes no lo agranda, pero llegar tarde con muchos ganadores lo achica igual. No hay ventaja en sentarse sobre el resultado.
- **No mezclarlo con el submission de Pears.** Son entregas separadas; meter el Vault Guardian en el README de QVAC-Node solo confunde al jurado del track.

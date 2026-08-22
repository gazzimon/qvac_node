# Runbook: prueba en 2 máquinas + loop de robustez

Cierra los dos agujeros que quedaban:

- **Fase 0:** OTA sobre una segunda máquina limpia.
- **Fase 1:** tiempo de `pear install` → primer token.

Estado al escribir esto: **v0.10.0 publicada** en el link, verlink `5969`,
`win32-arm64` purgado. Las 5 plataformas restantes están arriba.

---

## Máquina 1 (esta, Windows) — seeder

El seeder tiene que estar **corriendo** todo el tiempo que la máquina 2 instale.
Si se cae, el install de la otra máquina se queda en `0 B/s`.

```bash
npm run seed
```

Tiene que decir `^_^ announced` y `drive length 5969`. Dejalo en una terminal
aparte y no la cierres.

**Antes de nada, medí el enlace hacia la máquina 2 — pero NO mires el % de
pérdida.**

```bash
ping -n 10 <ip-de-la-maquina-2>
```

El `ping` de Windows **miente en el resumen**: si la IP no existe, tu propia
máquina contesta `Host de destino inaccesible` y esas respuestas se cuentan
como **recibidas**. Medido en esta red: 8 enviados, 8 recibidos, **0% perdidos**
— con el host totalmente inalcanzable. Un umbral de "menos de 5% de pérdida"
da luz verde en falso.

Lo que hay que mirar es si aparece `TTL=`, que solo sale en una respuesta de
eco real:

```bash
ping -n 10 <ip-de-la-maquina-2> | grep -c "TTL="
```

- **0** → no hay respuestas reales. Miralo con `arp -a`: si la IP no figura, no
  hay nada ahí (IP equivocada, máquina dormida o en otra red). Si figura con MAC
  pero igual no responde, el AP está bloqueando tráfico entre clientes.
- **cerca de 10** → enlace sano.

Y siempre pingueá el gateway como control (`ping -n 5 <gateway>`): si el
gateway responde perfecto y la otra máquina no, el problema es el camino
**entre clientes**, no tu wifi.

**Que el ping entre clientes falle NO cancela la prueba.** Hyperswarm no
necesita ruta directa en la LAN: puede conectar por hole-punching a través de
la DHT mientras las dos máquinas tengan internet. Muchos APs corporativos
bloquean ICMP entre clientes y dejan pasar UDP igual. Si el ping falla,
intentá el `pear install` igual — el veredicto real lo da el install, no el
ping. El caso documentado en [NOTES.md](../NOTES.md) fue distinto: ahí el
enlace se degradaba **bajo carga** y el install moría en `0B/s`.

---

## Máquina 2 (MacBook Air) — install + inferencia

No clona el repo. Copiale **un solo archivo**, `scripts/verify-node2.sh`, y:

```bash
bash verify-node2.sh
```

Hace 8 pasos y cada uno dice OK o FALLA:

| paso | qué prueba                                           |
| ---- | ---------------------------------------------------- |
| 0    | Internet real (no alcanza el link wifi)              |
| 1–2  | Node y CLI de Pear                                   |
| 3    | `pear install` desde el link, cronometrado           |
| 4    | versión instalada                                    |
| 5    | **inferencia local** + `pear install` → primer token |
| 6    | GPU vs `--gpu-layers 0` en esa máquina               |
| 7    | si el argv rompe los acentos en esa plataforma       |

En Windows la máquina 2 usa `scripts/verify-node2.ps1`.

### Ojo con el paso 5: 807 MB de modelo

La primera inferencia baja los pesos por hypercore. **No los baja de nuestro
seeder**, los baja del swarm del registry de QVAC — o sea que depende de
internet, no del enlace entre las dos máquinas. Es un modo de falla distinto al
del install.

**Pre-calentá la Mac antes de la demo**, con buena conexión:

```bash
~/qvac-node-test/qvac-node prompt "hola"
```

Una vez cacheado en `~/.qvac/models`, no vuelve a bajar. Hacer esto delante del
jurado con la wifi de la sala es jugar a la ruleta.

---

## La mitad OTA (cierra Fase 0)

Con la máquina 2 ya instalada:

1. **Máquina 2:** dejá el nodo corriendo.
   ```bash
   ~/qvac-node-test/qvac-node
   ```
2. **Máquina 1:** publicá una versión nueva.
   ```bash
   npm version 0.11.0 --no-git-tag-version
   npm run release
   ```
3. **Máquina 2:** tienen que aparecer líneas `[updater]` **sin tocar nada**.

Si aparecen, Fase 0 queda cerrada de verdad y no simulada.

**Esperá más de 60 segundos entre arrancar el nodo y publicar.** Si publicás
dentro del primer minuto, el update entra por el período de gracia y no probás
nada: el jitter es justamente lo que hay que verificar. Está explicado en
[NOTES.md](../NOTES.md), sección "TRAMPA DEL OTA".

---

## Loop de robustez (máquina 1)

```bash
npm run soak                              # 5 prompts sobre el binario local
node scripts/soak.js --runs 10            # más vueltas
node scripts/soak.js --gpu-layers 0       # el modo que vas a usar en la demo
node scripts/soak.js --install --runs 3   # incluye pear install desde el link
node scripts/soak.js --bin ~/qvac-node-test/qvac-node   # contra el instalado
```

Corre el ciclo N veces y reporta **la distribución, no el mejor caso**. Existe
porque los tres modos de falla que arruinan una demo no se ven en una corrida
sola:

1. **El proceso no termina.** `unloadModel` deja arriba el swarm, el registry
   client y el corestore a propósito. Si `close()` falla alguna vez, el CLI
   responde y se queda colgado con el cursor titilando.
2. **El registry timeoutea.** Resolver el modelo pega contra el swarm de QVAC:
   con wifi mala eso falla de a ratos, no siempre.
3. **El install se cuelga en 0 B/s.**

Un FAIL no es opinión: es exit code ≠ 0, salida sin primer token, respuesta
sospechosamente corta, o un proceso que hubo que matar por timeout. Sale con
exit 1 si hubo alguna falla, así que sirve en CI.

Además avisa si el TTFT máximo es 3x la mediana: una mediana buena con
dispersión alta es una demo que a veces se ve mal.

Ya corrido en la máquina 1, **7/7 OK**, con el seeder arriba: TTFT mediana
0.58 s, dispersión 1.2x. Los números están en [NOTES.md](../NOTES.md).

> **No lo conviertas a `stdio: 'pipe'`.** El soak escribe la salida del hijo a
> un archivo a propósito: el binario **se cuelga para siempre** si stdout es un
> pipe de libuv. Lo encontró este mismo soak (3/3 colgadas a los 600 s) y está
> documentado en NOTES.md. Es el bug que Fase 2 se va a comer si el gateway
> lee stdout de los nodos en vez de usar IPC.

---

## Orden sugerido

1. Soak local con `--gpu-layers 0`, 10 vueltas. Si hay fallas, se arreglan
   antes de tocar la máquina 2. (Ya corrido con 7: 7/7 OK.)
2. Seeder arriba (`npm run seed`). Medir ping a la máquina 2.
3. Máquina 2: `verify-node2.sh`. Anotar los números del paso 5 y 6.
4. Pre-calentar el modelo en la máquina 2.
5. Esperar >60 s y hacer la prueba OTA.
6. Volcar los números a [NOTES.md](../NOTES.md).

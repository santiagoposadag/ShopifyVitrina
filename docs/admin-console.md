# Panel de administración

Todas las conversaciones que ha tenido este despliegue, lo que el asistente
realmente **hizo** dentro de cada turno, los leads que escaló — y los controles
para que un humano tome una conversación y responda él mismo.

## Por qué existe

Las palabras solas no responden la pregunta que uno tiene sobre un asistente con
permiso de cambiar precios y borrar productos en una tienda en vivo. Una
respuesta que dice *"listo, quedó en $80.000"* se lee exactamente igual si:

- la escritura ocurrió,
- una regla de negocio la rechazó, o
- nunca se intentó y el modelo lo dio por hecho.

En `conversation_messages` esas tres son la misma fila. La diferencia vive en
`conversation_tool_calls`, y esta consola es lo que la muestra al lado del
mensaje que la explica.

## Qué se guarda

Dos tablas, unidas por `turn_key` — la clave que comparten todos los mensajes
respondidos por un mismo turno.

| Tabla | Una fila por | Contenido |
|---|---|---|
| `conversation_messages` | mensaje | dirección, cuerpo, tipo (`text`/`media`), turno |
| `conversation_tool_calls` | llamada a herramienta | nombre, argumentos (JSON), resultado, `ok`/`error`, duración, orden dentro del turno |

Las llamadas se capturan en `buildToolServer` (`server/src/tools/registry.ts`),
envolviendo el handler de cada herramienta. Es el único punto por donde pasan
todas, así que una herramienta nueva queda trazada sin que nadie tenga que
acordarse de trazarla.

**Se captura el resultado exacto que se le entrega al modelo**, antes de que
ningún transporte lo toque — no se re-parsean los bloques `tool_result` del
stream del SDK. Lo que el stream sí tiene y esto no: una llamada que el modelo
*pidió* pero que nunca se ejecutó (rechazada por `canUseTool`, o inválida contra
el esquema de la herramienta). Esas nunca llegan a un handler; `runtime.ts` ya
registra esa rama en el log.

### Límites

Los resultados se recortan a 16.000 caracteres y los argumentos a 4.000, con un
marcador explícito (`… [truncado: N caracteres más]`). En operación normal nada
se recorta: lo más grande que devuelve cualquier herramienta de este build es una
búsqueda de catálogo o un listado de productos, y ambos caben con holgura. El
tope existe contra un resultado patológico, no como presupuesto.

### `ok` no significa "funcionó"

`outcome` solo tiene dos valores y el tercero falta a propósito. Un rechazo por
regla de negocio (`factory.ts` `failure`) le devuelve texto al modelo igual que
un éxito, así que nada en el envoltorio puede distinguirlos sin adivinar sobre
las palabras. `error` significa que el handler **lanzó**, que es la única
distinción mecánica. El rechazo sigue siendo visible: está en `result`, textual.

## Acceso: el dueño se lo pide a sí mismo por WhatsApp

**No hay ninguna credencial durable de administrador.** El dueño escribe una
palabra al número del negocio y recibe un enlace que caduca solo.

```
Dueño → "panel"
Vitrina → 🔐 Tu acceso al panel de administración:
          https://luminiere.pasiolum.com/admin#t=…
          Ábrelo en los próximos 15 minutos o deja de servir;
          una vez abierto dura 12 horas.
```

Por qué así, y no una credencial permanente: **el token viaja por un chat de
WhatsApp**, que está respaldado, sincronizado con WhatsApp Web y es legible por
cualquiera que tenga el teléfono. Una credencial permanente entregada por ese
canal convierte un mensaje reenviado en acceso permanente a los datos de todos
los clientes. Por eso todo token aquí tiene una fecha de muerte.

**Dos plazos, un solo secreto.** Antes del primer uso, `expires_at` es la
ventana para *abrirlo*: 15 minutos, porque un enlace sin abrir dentro de un chat
es la exposición que este diseño existe para acotar, y uno de la semana pasada
tiene que estar muerto. La primera petición autenticada lo marca como abierto y
extiende el plazo a 12 horas de sesión.

**No es de un solo uso, y decirlo importa más que la función:** un enlace
interceptado y abierto dentro de la ventana da la misma sesión que habría
tenido el dueño. Lo que la ventana compra es que los enlaces viejos no valgan
nada, no que uno vivo sea seguro. Para eso está `revoke`.

### Quién puede pedirlo

Solo un teléfono que la tabla `assignments` diga que es `owner`. La
intercepción es **determinista y corre antes de cualquier turno del agente** —
no es una herramienta. Un modelo que decide cuándo emitir una credencial es un
modelo al que se le puede hablar para que la emita, y además quedaría guardada
en `conversation_messages`, que se lee desde la misma consola que abre.

El match es sobre el **mensaje completo**, nunca una subcadena: `panel`,
`admin`, `consola`, `panel admin`, `acceso admin`. "Abre el panel de la camisa
negra" habla de un producto y no dispara nada.

En el historial queda registrado que se respondió, pero **no el enlace**:

```
🔐 (enlace de acceso al panel enviado por WhatsApp; no se guarda en el historial)
```

### Administrar el acceso

```bash
docker compose --profile ops run --rm admin-access list
docker compose --profile ops run --rm admin-access list --all
docker compose --profile ops run --rm admin-access revoke 7
docker compose --profile ops run --rm admin-access revoke-phone 573001112233

# BREAK GLASS: emitir desde la terminal cuando WhatsApp no está disponible
docker compose --profile ops run --rm admin-access issue 573001112233
```

`issue` existe solo para la falla que el camino normal no sobrevive: WhatsApp
caído, el bridge desvinculado, o Meta rechazando envíos. Emite **el mismo tipo
de sesión**, con los mismos plazos y la misma revocación — solo cambia
`issued_via`, para que una sesión emitida desde una terminal se vea como tal en
el listado. No reintroduce una credencial durable: quien puede correr ese
comando ya tiene la base de datos.

**Quitarle el rol de dueño a alguien no le quita la sesión que ya tiene**, porque
una sesión es un token y no una consulta de rol. Son dos pasos:
`role-assignments set <phone> customer` y `admin-access revoke-phone <phone>`.

El token viaja en el **fragmento** de la URL (`/admin#t=<token>`), nunca en un
query string: el servidor corre con `logger: true`, así que `?t=` escribiría una
credencial viva en el log de peticiones en cada carga de página. Un fragmento no
llega al servidor en ningún navegador.

## Escalamiento: qué pasa cuando el agente no puede cerrar

El agente de ventas captura un lead cuando el checkout no puede resolver algo —
agotado, no lo tenemos, pedido al por mayor, precio negociado. Antes eso era una
fila que nadie leía, en una conversación que el agente seguía atendiendo.

Ahora:

1. **`save_lead` deduplica.** Un cliente que pregunta tres veces por lo mismo es
   *una* promesa de contacto, no tres. El match es `(teléfono, tipo, producto)`
   y solo contra leads abiertos — uno cerrado ya fue respondido, así que
   preguntar de nuevo es una solicitud nueva.
2. **Se avisa al dueño por WhatsApp**, una sola vez, con el teléfono, el
   producto y la nota. El aviso **no lleva enlace**: adjuntarlo emitiría una
   sesión que nadie pidió, en cada lead. El dueño escribe "panel" cuando puede.
3. **El lead queda atado al turno exacto** que lo produjo (`conversation_key`,
   `agent_id`, `turn_key`), así que desde el panel se abre la conversación que
   lo originó en vez de buscarla por número.
4. **El lead tiene ciclo de vida**: `new → in_progress → closed`, con quién lo
   tomó. `list_leads` muestra los pendientes por defecto y el estado en cada
   línea. Reabrir un lead **borra** quién lo tenía: un lead que nadie está
   atendiendo no debe seguir nombrando a alguien.

## Tomar la conversación

Desde el hilo, **Tomar la conversación** pausa el agente para esa conversación
—y solo para esa— y habilita el cuadro de respuesta. Mientras esté pausada:

- Los mensajes del cliente **se siguen registrando** y se ven en el panel. Lo
  que no ocurre es un turno: sin llamada al modelo, sin herramientas, sin
  respuesta.
- Tus mensajes salen **desde el número del negocio** y quedan grabados con
  `sent_by` apuntándote. Ese campo es lo único que distingue las palabras de un
  humano de las de un modelo.
- **No se puede escribir sin pausar primero.** La ruta responde 409 en vez de
  pausar por su cuenta: un traspaso implícito es uno que nadie recuerda
  deshacer, y sin la pausa tus mensajes y los del agente se entrelazan y el
  cliente recibe dos voces respondiendo lo mismo.

**Nada se despausa solo**, a propósito. Un temporizador que reanudara el bot lo
haría a mitad de un intercambio, con el humano a media frase y sin forma de
notarlo. El costo es la falla contraria —una conversación olvidada en pausa— y
esa sí es visible: el índice la marca y reporta cuántas hay.

**Al devolverla, la sesión del agente se descarta.** Mientras el humano la tuvo,
el agente no corrió turnos, así que su transcript termina en el momento de la
pausa y no contiene nada de lo que se habló. Retomarlo pondría al agente a
continuar con confianza desde un punto que todos los demás ya dejaron atrás.
Empezar de cero también pierde contexto, pero lo dice en vez de inventarlo.

## Lo que un enlace filtrado entrega

Hay que ser directo al respecto, porque es mucho más de lo que entrega un enlace
de la consola de pruebas:

- el número de teléfono completo de cada cliente,
- cada mensaje que enviaron y cada respuesta que recibieron,
- cada operación de catálogo hecha en su nombre, con argumentos y resultados.

Esos clientes son terceros que no fueron parte de ninguna decisión de este
despliegue, y sus datos están cubiertos por la **Ley 1581**. Sumado a que la
retención hoy es indefinida (`docs/DEUDA.md` #7), el alcance de un enlace solo
crece con el tiempo.

Lo que **sí** puede escribir, y es todo: pausar una conversación, devolverla, y
enviar un mensaje dentro de ella. Cada una nombra **una** conversación o **un**
lead. No cambia roles, no toca el catálogo, no borra conversaciones y no emite
credenciales.

Una versión anterior de esta consola era de solo lectura y lo decía como
propiedad estructural. Ganó esas tres escrituras porque lo que fue construida
para revelar —un cliente escalado a un humano— se podía **ver y no actuar**: el
agente seguía respondiendo por encima de la persona que debía ayudarlo.

## Tres tablas de credenciales, ninguna superconjunto de otra

| Tabla | Qué otorga | Vive |
|---|---|---|
| `admin_sessions` | leer todas las conversaciones y responder dentro de una | horas |
| `test_roster` | que **un** teléfono cambie su **propio** rol | hasta borrarla |
| `agent_registry` | hablar **como** un agente en `POST /agents/:id/messages` | hasta borrarla |

Están separadas justamente para que ninguna contenga a otra. Unificar la búsqueda
de tokens convertiría cada enlace de pruebas en un lector de todas las
conversaciones de los clientes, y eso sería invisible desde el código de
cualquiera de las dos consolas. `server/test/admin-sessions.test.ts` lo fija con
tests cruzados en las tres direcciones.

## Borrado

`purge-sessions` borra las palabras, el rastro de herramientas **y el historial
de traspasos** de cada conversación de cliente que purga, con el mismo alcance
por agente. Los traspasos van con lo demás porque `paused_by` y `reason` son
notas que un humano escribió *sobre* un cliente con nombre. También
alcanza las conversaciones cuya fila de sesión ya expiró — antes no podía, y eso
las hacía indelebles (era la deuda #8).

```bash
docker compose --profile purge run --rm purge-sessions
```

Reporta `purgedMessages`, `purgedToolCalls` y `purgedOrphanPairs` por separado: un
turno normal es un mensaje y nueve llamadas a herramientas, así que un total
único se leería como si se hubiera dicho mucho más de lo que se dijo.

## Rutas

| Ruta | Qué hace |
|---|---|
| `GET /admin` | la página (sin autenticar; el token está en el fragmento) |
| `GET /admin/conversations?limit=&offset=` | índice, actividad más reciente primero, con las pausadas marcadas |
| `GET /admin/conversation?key=&agent=` | un hilo, agrupado por turno, con su estado e historial de traspasos |
| `POST /admin/conversation/pause` | toma la conversación; el agente queda en silencio para ella |
| `POST /admin/conversation/release` | la devuelve al agente y descarta su sesión |
| `POST /admin/conversation/message` | envía un mensaje como el negocio (409 si no está pausada) |
| `GET /admin/leads?include_handled=` | leads, pendientes por defecto |
| `POST /admin/lead/status` | mueve un lead por su ciclo de vida |

`agent` es obligatorio y no opcional-con-default: un teléfono sostiene una
conversación distinta con cada persona (inventario y ventas), y un lector que
omitiera el alcance recibiría las dos entrelazadas en una conversación que nunca
ocurrió.

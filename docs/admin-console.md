# Consola de administración

Una vista de **solo lectura** de todas las conversaciones que ha tenido este
despliegue, y de lo que el asistente realmente **hizo** dentro de cada turno.

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

## Acceso

La autenticación es una búsqueda en la tabla `admin_roster`. **Una tabla vacía no
autentica a nadie** y `GET /admin` responde 404 en todas sus rutas, incluida la
página sin autenticar — "sin filas" no debe distinguirse de "no desplegado". No
hay una segunda variable que lo habilite, por la misma razón que no la hay en la
puerta de agentes: dos interruptores para una cosa es como uno termina en la
posición equivocada.

```bash
# En la terminal de Coolify (o donde corra el contenedor)
docker compose --profile ops run --rm admin-credentials list
docker compose --profile ops run --rm admin-credentials add santiago --label "Portátil"
docker compose --profile ops run --rm admin-credentials rotate santiago
docker compose --profile ops run --rm admin-credentials remove santiago

# Local
npm run admin -w server -- list
```

`add` imprime el enlace **una sola vez**. Solo se guarda su SHA-256, así que un
enlace perdido se reemplaza con `rotate`, nunca se consulta. `remove` revoca en
la siguiente petición de ese enlace, sin reiniciar nada.

El token viaja en el **fragmento** de la URL (`/admin#t=<token>`), nunca en un
query string: el servidor corre con `logger: true`, así que `?t=` escribiría una
credencial viva en el log de peticiones en cada carga de página. Un fragmento no
llega al servidor en ningún navegador.

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

Lo que **no** entrega: no hay ninguna ruta de escritura en esta superficie. No
cambia roles, no toca el catálogo y no borra conversaciones. El radio de
explosión de una credencial es "vio cosas", no "cambió cosas", y eso es
estructural — no hay función que lo haga — no una regla que alguien recuerde.

## Tres tablas de credenciales, ninguna superconjunto de otra

| Tabla | Qué otorga |
|---|---|
| `admin_roster` | leer todas las conversaciones |
| `test_roster` | que **un** teléfono cambie su **propio** rol |
| `agent_registry` | hablar **como** un agente en `POST /agents/:id/messages` |

Están separadas justamente para que ninguna contenga a otra. Unificar la búsqueda
de tokens convertiría cada enlace de pruebas en un lector de todas las
conversaciones de los clientes, y eso sería invisible desde el código de
cualquiera de las dos consolas. `server/test/admin-roster.test.ts` lo fija con
tests cruzados en las tres direcciones.

## Borrado

`purge-sessions` borra las palabras **y** el rastro de herramientas de cada
conversación de cliente que purga, con el mismo alcance por agente. También
alcanza las conversaciones cuya fila de sesión ya expiró — antes no podía, y eso
las hacía indelebles (era la deuda #8).

```bash
docker compose --profile purge run --rm purge-sessions
```

Reporta `purgedMessages`, `purgedToolCalls` y `purgedOrphanPairs` por separado: un
turno normal es un mensaje y nueve llamadas a herramientas, así que un total
único se leería como si se hubiera dicho mucho más de lo que se dijo.

## Rutas

| Ruta | Qué devuelve |
|---|---|
| `GET /admin` | la página (sin autenticar; el token está en el fragmento) |
| `GET /admin/conversations?limit=&offset=` | índice, actividad más reciente primero |
| `GET /admin/conversation?key=&agent=` | un hilo, agrupado por turno |

`agent` es obligatorio y no opcional-con-default: un teléfono sostiene una
conversación distinta con cada persona (inventario y ventas), y un lector que
omitiera el alcance recibiría las dos entrelazadas en una conversación que nunca
ocurrió.

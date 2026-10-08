# whatsapp-cloud-api

Conector para la **WhatsApp Business Cloud API** de Meta, extraído de Vitrina
(`server/src/whatsapp/cloud.ts`, `server/src/inbox/cloud.ts`, `server/src/inbox/webhook.ts`)
y sin nada propio de ese proyecto: no hay Shopify, ni agente, ni roles, ni SQLite, ni Fastify.
Cero dependencias de runtime: solo `node:crypto` y `fetch` (Node ≥ 20).

```
src/
  client.ts    WhatsAppCloudClient: sendText, sendTemplate, markAsRead, downloadMedia
               + WhatsAppApiError, isAllowedMediaHost, splitText, templateParam
  webhook.ts   verifySignature, handleVerification (GET), parseWebhook (POST)
  types.ts     InboundMessage, StatusUpdate, TemplateMessage, CloudApiConfig
examples/
  node-http.ts bot de eco con node:http puro — el cableado completo en ~100 líneas
test/          22 tests con un fetch falso (sin red)
```

```sh
npm install
npm test            # vitest
npm run typecheck   # tsc
npm run example     # requiere las 4 variables de abajo
```

Para llevarlo a otro proyecto basta copiar `src/` (o la carpeta entera).

## Uso

```ts
import { WhatsAppCloudClient, parseWebhook, verifySignature, handleVerification, SIGNATURE_HEADER } from "./src/index.js";

const wa = new WhatsAppCloudClient({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  // graphVersion: "v23.0", graphBaseUrl, userAgent — opcionales
});

// GET /webhook  → handshake
const { status, body } = handleVerification(query, process.env.WHATSAPP_VERIFY_TOKEN!);
// responder `body` como text/plain con `status`

// POST /webhook → firma sobre el cuerpo CRUDO, luego parseo
if (!verifySignature(rawBody, headers[SIGNATURE_HEADER], process.env.WHATSAPP_APP_SECRET!)) return 401;
const { messages, statuses, errors } = parseWebhook(JSON.parse(rawBody));
// guardar (dedupe por message.id) → responder 200 → procesar fuera del request

await wa.sendText(msg.from, "hola", { replyTo: msg.id });
await wa.sendTemplate(msg.from, { name: "aviso", language: "es", bodyParams: [templateParam(nota)], buttonUrlSuffix: "abc123" });
const { data, mimeType } = await wa.downloadMedia(msg.media!.id, AbortSignal.timeout(15_000));
```

En Fastify, Express, etc. lo único delicado es conseguir el cuerpo crudo antes de que el
framework lo parsee (en Vitrina: `addContentTypeParser("application/json", { parseAs: "string" })`;
en Express: `express.raw({ type: "application/json" })`).

## Las reglas que no se ven en el código y rompen en silencio

Cada una costó un fallo real en Vitrina.

1. **Firma sobre los bytes crudos.** `X-Hub-Signature-256` es HMAC-SHA256 del cuerpo exacto,
   con el **app secret** (no con el verify token: son secretos distintos). Re-serializar el JSON
   reordena claves y todas las firmas fallan.
2. **Responder 200 rápido.** Meta reintenta un webhook lento y, si insiste, **desactiva la
   suscripción**. Guardar → ACK → trabajar. Nunca descargar media dentro del handler: son dos
   round trips por archivo y un POST puede traer una ráfaga entera.
3. **Un POST trae muchos mensajes.** `entry[].changes[].value.messages[]`. Leer solo el primero
   pierde el resto de la ráfaga. `parseWebhook` los devuelve todos, en orden.
4. **Dedupe por `message.id` (wamid), obligatorio.** Meta reenvía. Un hash del cuerpo como clave
   no sirve: varios mensajes del mismo POST compartirían clave. Por eso el parser descarta un
   mensaje sin id. La clave debe persistirse (UNIQUE) **antes** del ACK.
5. **El orden no está garantizado.** Si importa (una ráfaga de fotos), ordenar por
   `timestamp` — resolución de segundos, así que hay empates; desempatar por llegada.
6. **Media es un id, no una URL.** `GET /{media-id}` devuelve una URL que **caduca en ~5 min**:
   guarda el id, resuelve la URL al descargar. El token solo se envía a hosts de Meta
   (`isAllowedMediaHost`) — la URL sale de una respuesta y ese token puede escribir como el
   negocio. El CDN responde 403 sin `User-Agent`.
7. **Ventana de 24 h.** Texto libre solo dentro de 24 h desde el último mensaje de la persona;
   fuera, error **131047** y únicamente pasa una **plantilla aprobada**
   (`err.outsideServiceWindow`). Patrón útil: intentar y, si falla así, caer a plantilla.
8. **Los `statuses` llegan a la misma URL.** Un envío que Meta aceptó (HTTP 200) y luego no pudo
   entregar **solo aparece como un `status: "failed"`**. Regístralos.
9. **Texto > 4096 caracteres → error 131009.** `sendText` lo parte por párrafos y envía en
   secuencia. Ojo: cada trozo se cobra como un mensaje.
10. **Parámetros de plantilla:** posicionales, nunca vacíos, sin saltos de línea, tabs ni muchos
    espacios seguidos — Meta rechaza el **envío** (132012), no la plantilla. Usa `templateParam`.
    El parámetro del botón URL es **solo el sufijo**: Meta concatena la base aprobada.
11. **Nombre e idioma de plantilla son configuración**, no literales: la plantilla existe por
    idioma y el código debe coincidir exactamente (si no, 132001).
12. **Filtrar por `object` y `field`.** El parser ignora todo lo que no sea
    `whatsapp_business_account` / `messages`, así que suscribir campos de más no rompe nada.

## Configuración en Meta (runbook)

| Variable | De dónde sale |
| --- | --- |
| `WHATSAPP_APP_SECRET` | App → App settings → Basic → App secret |
| `WHATSAPP_VERIFY_TOKEN` | la inventas tú (`openssl rand -hex 16`) |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API setup → **Phone number ID** (no es el número) |
| `WHATSAPP_ACCESS_TOKEN` | token de **System User** (abajo) |

**Token.** Business settings → Users → System users → Add → asignar la WABA y la app → Generate
token con `whatsapp_business_messaging` y `whatsapp_business_management`. El token de 24 h de
*API setup* sirve solo para el primer `curl`: con él todo deja de funcionar al día siguiente.

**Webhook — son TRES pasos, y desde el servidor los tres fallos se ven iguales (cero POST):**

| # | Paso | Dónde |
| --- | --- | --- |
| 1 | Callback URL (`https://…/webhook`) + verify token | Webhooks → Edit (nivel app) |
| 2 | Suscribir el campo `messages` | Webhooks → Manage (nivel app) |
| 3 | **Activar el toggle de webhooks del número** | configuración del número |

- El botón *Test* pasa con solo 1 y 2; los mensajes reales siguen sin llegar.
- Meta **no reenvía** lo que pasó antes de suscribirse: vuelve a mandar el mensaje.
- La app debe estar en modo **Live** (en Development solo llegan webhooks de quienes tienen rol en la app).
- La app debe estar suscrita a la WABA (`POST /{waba-id}/subscribed_apps`).
- HTTPS público con certificado válido. Para desarrollo local:
  `cloudflared tunnel --url http://localhost:3000`.
- Si el log no muestra ningún POST, el problema es de suscripción, no de código: mira el panel
  de entregas de Meta.

**Campos a suscribir:** `messages` (obligatorio; trae mensajes **y** statuses). Recomendables más
adelante: `message_template_status_update`, `phone_number_quality_update`, `account_update`.
Evita `message_echoes` salvo que sepas separarlos de la entrada.

**Probar sin Meta:**

```sh
curl -i "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=42"
# → 200, cuerpo exacto: 42

B='{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"messages":[{"from":"573001112233","id":"wamid.1","type":"text","text":{"body":"hola"}}]}}]}]}'
S=$(printf '%s' "$B" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | sed 's/.*= //')
curl -i -X POST localhost:3000/webhook -H "x-hub-signature-256: sha256=$S" -H 'content-type: application/json' -d "$B"
```

## Qué se quedó en Vitrina a propósito

- La interfaz `WhatsAppChannel` y el transporte alternativo (bridge whatsmeow).
- La bandeja persistente, el batcher con debounce, la cola por conversación y los reintentos —
  el ejemplo usa un `Set` en memoria y un bucle; en producción eso es una tabla con clave UNIQUE.
- Los textos en español que veía el agente (`"Seleccionó: …"`): aquí el parser devuelve datos
  estructurados (`reply`, `location`, `reaction`, `orderItemCount`, `raw`) y tú decides el texto.
- Los mensajes de error que nombraban variables de entorno de Vitrina.

Añadido respecto al original: `markAsRead`, `replyTo` (citar un mensaje), `profileName`,
`phoneNumberId` receptor, ubicación/reacción/contexto, los `messageIds` devueltos por cada envío
(para cruzarlos con los statuses) y `WhatsAppApiError` con `code` en lugar de un `Error` plano.

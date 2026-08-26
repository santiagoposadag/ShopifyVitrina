# WhatsApp Business Cloud API (transporte oficial)

Cómo se configura el número oficial de Meta y qué hace el servidor con lo que Meta le
manda. El transporte se elige con **una variable** — `WHATSAPP_PROVIDER=cloud|bridge` — porque
ambos viven detrás de `WhatsAppChannel` (`server/src/whatsapp/channel.ts`). Eso es lo que hace
que volver al bridge sea un reinicio y no un revert.

> Code, comments and docs are English in this repo; this file is Spanish because it is the
> runbook someone follows with the Meta panel open, and the panel is what it describes.

---

## 1. Variables

| Variable | De dónde sale | Obligatoria |
| --- | --- | --- |
| `WHATSAPP_PROVIDER` | `cloud` | sí, para activar el transporte |
| `WHATSAPP_APP_SECRET` | App → **App settings → Basic → App secret** | sí |
| `WHATSAPP_VERIFY_TOKEN` | **la inventas tú** (`openssl rand -hex 16`) | sí |
| `WHATSAPP_PHONE_NUMBER_ID` | **WhatsApp → API setup → Phone number ID** | sí |
| `WHATSAPP_ACCESS_TOKEN` | System User token (§3) | sí |
| `WHATSAPP_GRAPH_VERSION` | la versión que muestre el panel | no (`v23.0`) |
| `WHATSAPP_GRAPH_BASE_URL` | solo para pruebas | no |

`WHATSAPP_PHONE_NUMBER_ID` **no es el número**: es un id numérico que el panel muestra al
lado. El número (`display_phone_number`) no se usa en ninguna llamada.

Con `WHATSAPP_PROVIDER=cloud`, las variables `BRIDGE_*` dejan de ser obligatorias y
`BRIDGE_STAGING_DIR` queda vacío — no hay volumen de staging porque no hay sidecar. El
arranque sigue fallando con el nombre exacto de la variable que falte (`server/src/config.ts`).

---

## 2. El webhook, en el panel

**App → WhatsApp → Configuration → Webhooks → Edit**

| Campo | Valor |
| --- | --- |
| Callback URL | `https://<PUBLIC_BASE_URL>/webhook` |
| Verify token | exactamente el `WHATSAPP_VERIFY_TOKEN` del servidor |

Al pulsar *Verify and save*, Meta hace un **GET** a esa URL con `hub.mode`, `hub.verify_token`
y `hub.challenge`, y espera el `challenge` **en texto plano**. El servidor ya responde eso
(`registerWebhook` en `server/src/inbox/webhook.ts`) y solo registra esa ruta cuando el
provider es `cloud`. Si devuelve 403, el token no coincide; si la URL no es accesible desde
internet, el panel se niega a guardarla — y **rehace el handshake cada vez que la editas**,
por eso el verify token vive en la config y no en un papel.

Tres cosas que fallan silenciosamente si faltan:

1. **La app tiene que estar en modo `Live`.** En *Development* los webhooks solo llegan para
   las personas con rol en la app. La conversación de un cliente real nunca aparece, y no hay
   ningún error que lo diga.
2. **La app tiene que estar suscrita a la WABA.** El botón de *Subscribe* está en la misma
   pantalla de Webhooks (equivale a `POST /{waba-id}/subscribed_apps`). Sin eso, la URL queda
   verificada y no llega ni un mensaje.
3. **El servidor tiene que ser HTTPS público y con certificado válido.** Meta no entrega a
   HTTP ni a un certificado autofirmado.

---

## 3. El token (System User)

**Business settings → Users → System users → Add** → asigna **la WABA y la app** como assets
→ *Generate new token* con estos dos permisos, y ninguno más:

- `whatsapp_business_messaging` — enviar y leer mensajes
- `whatsapp_business_management` — leer la configuración de la WABA y gestionar plantillas

El token de 24 horas que aparece en *API setup* sirve para el primer `curl` y para nada más:
un despliegue con ese token empieza a fallar **todas** las respuestas al día siguiente, en
mitad de conversaciones reales. El de System User no expira salvo que lo revoques.

Su radio de daño es "todo lo que el negocio puede mandar por WhatsApp". Va a gopass, como
`SHOPIFY_ADMIN_TOKEN`, nunca a un archivo versionado.

---

## 4. Qué eventos hay que suscribir

En **Webhooks → Manage**, Meta lista *campos* (`fields`), no eventos sueltos. El único
imprescindible es uno:

| Campo | ¿Suscribir? | Qué trae y por qué |
| --- | --- | --- |
| **`messages`** | **SÍ — obligatorio** | Es todo el canal de entrada: texto, imagen, audio, video, documento, sticker, ubicación, contacto, botones, listas y pedidos de catálogo. **Y también los `statuses`** (sent/delivered/read/failed), que llegan bajo este mismo campo. Sin él no llega absolutamente nada. |
| `message_template_status_update` | Aún no; **sí cuando existan plantillas** | Avisa si Meta aprueba o rechaza una plantilla. Hoy no hay ninguna; el día que exista `back_in_stock` o la confirmación de pago, un rechazo que nadie ve es una notificación que nunca sale. |
| `phone_number_quality_update` | Recomendable al abrir el canal a clientes | Cambios de *quality rating* y de tier de mensajería. Es el aviso temprano de que el número se está quemando, antes de que baje el límite. |
| `account_update` | Recomendable | Cambios de estado de la cuenta: restricciones, baneos, verificación. Lo que explica por qué de repente no sale nada. |
| `account_alerts`, `business_capability_update` | Opcional | Alertas de política y cambios de límites. Informativo. |
| `message_echoes` | **NO** | Copia de cada mensaje que envías. Con el pipeline actual sería ruido puro y arriesga confundir salida con entrada. |
| `flows`, `calls`, `payments`, y el resto | No | Productos que este servidor no usa. |

**Suscribe `messages` ahora y nada más.** Los demás son seguros de añadir cuando toque: el
parser (`server/src/inbox/cloud.ts`) descarta todo `change` cuyo `field` no sea `messages`, así
que una suscripción de más no se malinterpreta, simplemente se ignora.

### Lo que llega dentro de `messages`

```
entry[].changes[].value.messages[]   ← mensajes entrantes  (esto se procesa)
entry[].changes[].value.statuses[]   ← acuses de salida    (esto se registra)
entry[].changes[].value.errors[]     ← errores de cuenta
entry[].changes[].value.contacts[]   ← nombre de perfil y wa_id
```

Los `statuses` no son decoración: **un envío que Meta acepta y luego no puede entregar solo
aparece ahí**. El POST que llevó la respuesta ya devolvió 200, así que sin ese callback un
mensaje que cayó fuera de la ventana de 24 h (error 131047) es invisible en todo el sistema. El
servidor los registra como `warn` con el código y el detalle.

---

## 5. Qué cambió en el código

| Archivo | Qué hace |
| --- | --- |
| `server/src/whatsapp/cloud.ts` | `CloudApiChannel`: envío, descarga de media en dos pasos, lista blanca de hosts, partido de respuestas largas. |
| `server/src/inbox/cloud.ts` | Parser del payload de Meta → `InboundMessage[]`, más `extractCloudStatusErrors`. |
| `server/src/inbox/webhook.ts` | Handshake GET, cabecera de firma por provider, y el bucle sobre **varios** mensajes por POST. |
| `server/src/config.ts` | `WHATSAPP_PROVIDER` y qué credenciales exige cada transporte. |
| `server/src/data/repo.ts`, `db.ts` | Columna `pending_media.sent_at` y el orden de la galería. |

Cinco diferencias con el bridge que sí cambian comportamiento:

1. **Un POST puede traer varios mensajes.** El bridge manda uno por request; Meta anida un
   array. El handler itera; leer solo el primero descartaba el resto de una ráfaga.
2. **La firma es otra.** `X-Hub-Signature-256`, HMAC-SHA256 del **cuerpo crudo** con el *app
   secret* (no con el verify token: son secretos distintos con trabajos distintos). La
   verificación ya existía sobre bytes crudos, que es justo lo que Meta exige.
3. **Media es un id, no una ruta.** Se resuelve `GET /{media-id}` → una URL de
   `lookaside.fbsbx.com` que **caduca en ~5 minutos** y se descarga con el token. Por eso lo
   que viaja por el pipeline es el id y la URL se pide en el momento de bajar el archivo,
   nunca se guarda. El token solo se adjunta a hosts de Meta (`isAllowedMediaHost`) — la URL
   sale de una respuesta, y un host equivocado ahí es una credencial filtrada.
4. **El orden de las fotos ya no lo garantiza el transporte.** El outbox del bridge entregaba
   una ráfaga estrictamente en orden, y ese orden es el orden del listado: la primera foto es
   la portada. Meta no garantiza nada, así que la galería se ordena por `sent_at` — la marca de
   tiempo que WhatsApp le puso al mensaje — y el orden de llegada solo desempata.
   **Limitación conocida:** `sent_at` tiene resolución de segundos, así que dos fotos disparadas
   dentro del mismo segundo vuelven a depender del orden de llegada.
5. **Salir de la ventana de 24 h es un error, no una lentitud.** Una respuesta libre fuera de
   las 24 h desde el último mensaje de la persona la rechaza Meta con el código 131047. El
   error lo dice con esas palabras en el log en vez de aparecer como un HTTP 400 anónimo.

Lo que **no** cambió: la tabla `inbox` y su dedupe por id de mensaje (absorbe igual los
reenvíos de Meta que los del bridge), el batcher, la cola por teléfono, `turnKey` como clave de
idempotencia en Shopify, y la frontera dueño/cliente.

---

## 6. Probarlo antes de tocar el número

```sh
# 1. Handshake, tal como lo hace el panel
curl -i "http://localhost:3001/webhook?hub.mode=subscribe\
&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=1158201444"
#    → 200 y el cuerpo exacto: 1158201444

# 2. Un mensaje entrante firmado, con la forma real de Meta
WHATSAPP_APP_SECRET=... ./scripts/simulate-cloud-inbound.sh 573001112233 "hola, tienen camisas?"
#    → 200, una fila en inbox, un turno del agente y una respuesta saliente
```

`scripts/simulate-cloud-inbound.sh` recorre firma, parser, dedupe, batcher, turno y envío **sin
que el número esté registrado**. Es la forma de ensayar el cambio antes del paso irreversible, y
después sirve para reproducir un mensaje sin teléfono.

Para el primer mensaje real, Meta regala un **número de prueba** (limitado a 5 destinatarios
que registres) — sirve para verificar el webhook de punta a punta antes de migrar el número
comercial.

---

## 7. Operación

- **Volver al bridge:** `WHATSAPP_PROVIDER=bridge` y reiniciar. Nada más — mientras la pareja
  del bridge siga viva. Una vez que el número queda registrado en Cloud API, esa pareja está
  muerta y volver significa re-parear.
- **El contenedor `bridge` no tiene trabajo** con `cloud`: `docker compose stop bridge`.
- **Cuando no llega un mensaje**, el sitio donde mirar cambia: ya no es el `/status` del
  bridge sino **WhatsApp → Configuration → Webhooks** en el panel, que muestra los intentos de
  entrega fallidos. Meta reintenta con backoff; la tabla `inbox` absorbe el duplicado.
- **Límites:** con el negocio verificado el número escala por tiers (1K → 10K → 100K →
  ilimitado) y desde octubre de 2025 el límite es **compartido por portfolio**, no por número.

## 8. Lo que queda pendiente (y no es código de este cambio)

- **Plantillas utility aprobadas** para lo que hoy asume que se puede escribir cuando sea:
  el aviso de `back_in_stock`, la confirmación de pago si llega más de 24 h después, y la
  alerta de caída al dueño (`ConsecutiveFailureAlert`), que puede caer fuera de ventana justo
  cuando más falta hace.
- **Una respuesta por turno.** Desde el 1 de octubre de 2026 Meta cobra cada mensaje de
  servicio dentro de la ventana de 24 h (hoy son gratis). Tres mensajes por respuesta cuestan
  el triple; el partido en trozos de `splitForWhatsApp` solo actúa por encima de 4096
  caracteres, que es el límite duro de WhatsApp.

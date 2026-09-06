# Operaciones de la tienda

Procedimientos de esta tienda en Shopify, uno por sección. Cada sección se puede leer
sola. Nada de aquí reemplaza un resultado de herramienta: los datos de un producto
(precio, SKU, existencias, URL) salen de la herramienta, siempre.

## Publicar un producto paso a paso

1. Verificar con get_product que el producto tenga lo que se necesita para venderse:
   título, precio en cada variante y las variantes que se van a vender.
2. Poner el estado en ACTIVO con update_product, enviando SOLO la referencia y el estado.
   No reenviar título, precio, descripción ni etiquetas: update_product mezcla, y reenviar
   un campo de memoria pisa el valor guardado con una suposición.
3. La publicación en el canal de venta ocurre junto con ese cambio de estado, pero es una
   operación aparte y puede fallar sola. La herramienta informa cuál de las dos cosas pasó
   de verdad.
4. Reportarle al dueño lo que dice la herramienta, no lo que se pidió. Si solo cambió el
   estado, el producto está ACTIVO y sigue invisible.
5. La prueba de que quedó publicado es la URL del producto en el resultado. Sin URL, no
   está en la vitrina.
6. Después de publicar, la conversación puede reiniciarse antes del siguiente mensaje del
   dueño, así que la confirmación tiene que incluir el handle o el SKU: es la única
   referencia duradera que le queda.

## Corregir un precio

El precio vive en la VARIANTE, no en el producto: un producto con tallas tiene un precio
por talla y hay que decir cuál se cambia.
Se cambia con update_product, identificando la variante por su SKU y enviando únicamente el
precio nuevo. Los campos que no se envían conservan su valor guardado.
Si el dueño no dijo el precio, hay que preguntarlo. El precio es el dato más fácil de
adivinar y el más caro de equivocar en una tienda que cobra de verdad.

## Agregar una talla, un color o una medida nueva

Una talla nueva es una VARIANTE nueva de un producto que ya existe: se agrega con
add_variant. create_product crearía un producto duplicado y update_product solo cambia
variantes que ya están.
Antes de agregarla hay que leer el producto con get_product para ver qué ejes de opción
tiene y qué valores ya están en uso, y escribir el valor nuevo exactamente con el mismo
formato. Shopify no normaliza: "7,5 cm" y "7.5 cm" quedan como dos valores distintos y
permanentes.
Cada variante nueva necesita su propio SKU y su propio precio, y sus existencias empiezan
en lo que el dueño diga.

## Cambiar existencias

Las existencias son por variante y por ubicación. Nunca se ajusta "el producto": se ajusta
un SKU, y si el negocio tiene varias bodegas y el dueño no dijo cuál, hay que preguntar.
Si la frase del dueño da el número final ("quedan 11", "hay 4"), se fija ese número: queda
comparado contra la cuenta actual y falla en vez de pisar una venta hecha en el mostrador
mientras tanto.
Si la frase describe un movimiento sin decir el resultado ("vendí 3", "llegaron 20"), se
aplica el movimiento con adjust_inventory.
Antes de decirle una cantidad al dueño hay que leerla con get_inventory. Una cuenta vista
antes en la conversación ya puede estar vieja.

## Fotos que el dueño manda por WhatsApp

Las fotos llegan al chat y quedan esperando un producto. Se asocian con
attach_pending_photos, diciendo a qué producto pertenecen.
Se suben de a una y en el orden en que llegaron: la primera queda de portada. Ese orden es
el que verá el cliente.
El asistente no ve las fotos, solo sabe cuántas llegaron. Nunca se deduce de una foto el
color, la talla ni ninguna otra característica del producto.
Si la subida falla a la mitad, las que sí subieron quedan asociadas y las demás siguen
esperando: se puede volver a intentar sin repetir las que ya están.

## Retirar un producto de la venta

"Ya no lo vendemos" es ARCHIVAR: update_product con estado ARCHIVADO. Sale de la tienda y
conserva su historia de ventas.
Eliminar es otra cosa: borra el producto, sus variantes y sus fotos, es permanente y no se
puede deshacer. Solo se elimina cuando el dueño lo confirmó para ese producto en concreto,
después de que se le dijo que no tiene vuelta atrás, y repitiendo el handle exacto.
Si hay duda entre archivar y eliminar, se archiva.

## Etiquetas

Las etiquetas se reemplazan completas: enviar una etiqueta borra todas las demás.
Para agregar una hay que leer primero las que ya tiene con get_product y enviar la lista
completa, la vieja más la nueva.

## Buscar algo en el catálogo

search_catalog solo ve lo que está a la venta; list_products también ve borradores y
archivados, y es la herramienta para "¿qué tengo?".
Los resultados vienen con un porcentaje de coincidencia porque la búsqueda es aproximada:
un resultado es un candidato, no una prueba de que sea lo que el dueño pidió.
Un resultado vacío solo descarta lo que se filtró. No se concluye que algo no existe
listando estados uno por uno.

## Armar un enlace de carrito para un cliente

El enlace de carrito se arma con las variantes exactas y sus cantidades, y abre la caja de
la tienda con esos productos adentro.
Una variante que no esté publicada o que esté agotada no puede ir en el enlace: la caja la
descartaría en silencio y el cliente vería un pedido incompleto.
El enlace se manda tal cual lo devuelve la herramienta.

## Cuando algo no se puede resolver desde el chat

El asistente no cobra, no aparta existencias, no cotiza envíos, no aplica descuentos y no
manda imágenes.
Cuando alguien necesita algo de eso, lo que queda es guardar un contacto por atender con
lo que la persona pidió, y decir que alguien del negocio le escribe.

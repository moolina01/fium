
Por ahora necesitamos hacer algunos cambios temporales. Sería ideal que dejaras comentarios en el código o documentación indicando cada modificación para no perder estos ajustes cuando los revisemos más adelante.
1. Paso "Elige tu plan"
Por ahora vamos a ocultar o comentar la sección "Elige tu plan", ya que a estos usuarios no les cobraremos.
En lugar de eso, el flujo debería llevarlos directamente al paso de activar Fium en su checkout.
Sería bueno:
* Indicar claramente dónde se activa (probablemente desde Configuraciones).
* Mostrar instrucciones paso a paso para ayudar al usuario.
* Ide alguna forma sis se puede como validar que lo activo
* Si no está activado, avisarle al usuario, ya que de lo contrario las cotizaciones no aparecerán en el carrito.
2. Telefono  del cliente faltante
En algunos casos puede que no recibamos el teléfono del cliente.
Si eso ocurre:
* Utilizar el telefono de la tienda como valor por defecto.
* Informar claramente a la tienda que se utilizó el telefono de la tienda porque no se recibió el telefono del cliente.

También debemos dejar un mensaje claro cuando no recibamos el teléfono del cliente.
Recordarle a la tienda  que el teléfono debe configurarse como campo obligatorio, ya que es necesario para procesar correctamente los envíos.

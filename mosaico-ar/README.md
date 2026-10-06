# Mosaico AR · Arte Digital

Versión 3.

## Interacción
- Entorno 3D: tocar una pieza para seleccionarla; arrastrarla sobre su pared/piso para moverla.
- Profundidad y tamaño se editan en vivo sobre la pieza seleccionada.
- `REUBICAR`: permite cambiar la pieza entre pared/piso (3D) o llevarla a una nueva superficie detectada (AR).
- `BORRAR PIEZA`: elimina únicamente la seleccionada.
- `NUEVA PIEZA`: sale del modo edición y permite colocar otra tesela.

## AR
Se corrigió el fondo opaco del DOM overlay durante una sesión WebXR. En AR, `body`, `#app` y `#stage` pasan a fondo transparente para permitir el passthrough de cámara del navegador.

La realidad aumentada requiere HTTPS y un navegador/dispositivo que exponga `immersive-ar` + `hit-test`. Si no están disponibles, el botón lo indica.


## Versión 4
- Ninguna obra queda seleccionada por defecto.
- Al seleccionar una pieza ya colocada se desactiva el modo de agregar nuevas piezas.
- Control circular táctil: centro = mover X/Y, derecha = girar, arriba = escala, izquierda = espesor.
- Botones de interfaz protegidos con `beforexrselect` para que no generen piezas al tocar LIMPIAR/BORRAR/etc. durante una sesión WebXR.
- Funciona tanto en el entorno 3D como en AR.

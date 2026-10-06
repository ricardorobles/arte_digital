# Mosaico AR · Arte Digital

Prototipo WebXR / Three.js para construir un mosaico tridimensional con seis obras de Ricardo Robles.

## Qué hace

- Modo 3D de escritorio: colocar piezas sobre una pared o el piso.
- Modo AR en dispositivos compatibles: detectar superficies mediante WebXR hit-test y colocar piezas en el espacio.
- Selección entre 6 obras.
- Profundidad regulable entre 1 y 20 cm virtuales.
- Escala regulable.
- Deshacer, limpiar y ocultar interfaz.
- Exportar la composición como JSON con posición, orientación, escala y profundidad.

## Integración en GitHub Pages

1. Copiar la carpeta completa `mosaico-ar` dentro del repositorio de **Arte Digital**.
2. Subir los cambios a la rama publicada por GitHub Pages.
3. Abrir:

   `https://TU-USUARIO.github.io/TU-REPOSITORIO/mosaico-ar/`

4. En el `index.html` general del proyecto, agregar un enlace o tarjeta que apunte a `./mosaico-ar/`.

## Importante para realidad aumentada

- GitHub Pages ya usa HTTPS, requisito de WebXR.
- WebXR AR funciona mejor en Chrome para Android con ARCore.
- Si el navegador no soporta `immersive-ar`, el proyecto sigue disponible en modo 3D.
- La detección de pared/piso depende de las capacidades del dispositivo y navegador.

## Estructura

- `index.html`: interfaz.
- `styles.css`: estética visual.
- `app.js`: escena Three.js, WebXR, hit-test y lógica del mosaico.
- `assets/piezas/`: imágenes originales usadas como texturas, sin reinterpretarlas.

## Próximos pasos posibles

- Guardar/reabrir composiciones desde URL o base de datos.
- Generar QR por mosaico.
- Incorporar más piezas y colecciones.
- Permitir rotación manual de cada tesela.
- Crear modo de composición libre sobre superficies curvas o múltiples paredes.

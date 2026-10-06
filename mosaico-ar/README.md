# Mosaico AR · Arte Digital

Versión v10.

## Piezas dinámicas

En GitHub Pages, la aplicación lee automáticamente los archivos de `assets/piezas/` usando la API pública de GitHub. Para sumar una obra basta con subir una nueva imagen (`.jpg`, `.jpeg`, `.png` o `.webp`) a esa carpeta: no hace falta editar `index.html` ni `app.js`.

Las piezas se ordenan naturalmente por nombre. Se recomienda continuar con nombres como `pieza-07.jpg`, `pieza-08.jpg`, etc.

### Descripciones opcionales

Para una pieza nueva puede agregarse un archivo `.txt` con el mismo nombre base, por ejemplo:

- `pieza-07.jpg`
- `pieza-07.txt`

El contenido del TXT se muestra cuando está activo el botón `?`. Las seis piezas iniciales ya incluyen descripciones internas en el código como respaldo.

## Compartir y grabar

El botón rojo intenta capturar la pantalla cuando el navegador ofrece Screen Capture API. Un toque genera una imagen y abre la hoja nativa de compartir, donde el usuario puede elegir WhatsApp, Instagram u otra aplicación compatible.

Una pulsación larga inicia grabación. La grabación continúa al soltar el botón y se detiene con un nuevo toque.

En navegadores que no permiten capturar la pantalla completa, la aplicación usa el canvas 3D como alternativa. En WebXR algunos navegadores no permiten incluir el passthrough de cámara en una captura web por restricciones de seguridad del sistema.


## Descripciones desde metadatos
La descripción de cada obra se lee automáticamente del metadato XMP `dc:description` embebido en la propia imagen (por ejemplo, el campo Description de Photoshop). Para agregar una obra nueva, solo hay que subir el archivo de imagen a `assets/piezas/`; no hace falta crear un `.txt` ni editar el código.

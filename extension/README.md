# Evidencias Matriz de Pruebas (extensión de Chrome)

Panel lateral que lee tu **Excel local** (`.xlsx` o `.xls`) fila por fila (Usuario,
Funcionalidad, Datos de entrada, Pasos) y permite capturar un área de la pantalla y
guardarla como evidencia en la columna **Evidencia** de la fila actual.

## 1. Instalar (una vez)

1. En Chrome abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. **Cargar descomprimida** → selecciona esta carpeta (`proyecto logs\extension`).
4. Haz clic en el icono de la extensión: se abre el panel lateral. Puede quedarse abierto
   mientras cambias de pestaña.

No hace falta cuenta de Google ni configuración en la nube.

## 2. Uso

1. **Abrir Excel** y elige tu matriz (la que tiene las columnas Pasos, Usuario,
   Funcionalidad, Datos de entrada y Evidencia).
2. Elige la **pestaña** del libro y navega con ◀ ▶, el desplegable o las flechas del teclado.
3. **Carpeta de evidencias:** elige una carpeta. Te recomiendo que sea una carpeta
   **junto al Excel** (por ejemplo `evidencias`), porque la celda enlaza con una ruta
   relativa.
4. **Capturar área:** la página activa se oscurece; arrastra sobre lo que quieres
   capturar (Esc cancela). Revisa la vista previa y pulsa **Guardar en Evidencia**.

Al guardar, la extensión:
- crea un PNG en la carpeta de evidencias, con nombre
  `evidencia_<pestaña>_fila<N>_<fecha>.png`;
- escribe ese nombre en la celda Evidencia de la fila, como enlace a la imagen;
- vuelve a guardar el Excel.

Si la celda ya tenía evidencia, pide confirmación antes de reemplazarla. La captura
anterior sigue en la carpeta.

## Aviso importante sobre el Excel

Al guardar, la extensión reescribe el archivo con SheetJS (librería libre incluida en
`xlsx.full.min.js`). Conserva los valores, fórmulas básicas y enlaces, pero **puede perder
formato avanzado**: estilos finos, validaciones de datos, gráficos, imágenes insertadas,
tablas con formato y macros. Antes de empezar, haz una copia de tu matriz.

## Permisos que usa

- `sidePanel`, `storage`: panel lateral y recordar la pestaña y las carpetas elegidas.
- `activeTab`, `scripting`, `tabs`, `<all_urls>`: mostrar el selector de área en la página
  y capturar la pestaña donde trabajas.

El Excel y la carpeta se leen y escriben solo con los archivos que tú eliges en el
selector de Chrome.

## Limitaciones

- Solo Chrome 116 o superior.
- No se pueden capturar páginas `chrome://` ni la Chrome Web Store.
- Las columnas se detectan por el encabezado: deben existir `Usuario`, `Funcionalidad`,
  `Datos de entrada`, `Pasos` y `Evidencia` en una de las primeras 10 filas.
- El enlace de evidencia es relativo. Si mueves el Excel sin la carpeta de evidencias,
  los enlaces dejan de abrir la imagen.
- Chrome puede pedirte de nuevo el permiso del Excel al reabrir el navegador; pulsa
  **Abrir Excel** y elige el mismo archivo.

## Archivos

- `manifest.json`: configuración y permisos.
- `background.js`: abre el panel, inyecta el selector y toma la captura.
- `content.js`: overlay para seleccionar el área.
- `sidepanel.html`, `sidepanel.js`, `sidepanel.css`: panel, lectura del Excel y guardado.
- `xlsx.full.min.js`: SheetJS (lectura y escritura de Excel), versión 0.18.5.

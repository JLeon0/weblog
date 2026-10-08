# Evidencias Matriz de Pruebas (extensión de Chrome)

Panel lateral que lee tu hoja de Google Sheets fila por fila (Usuario, Funcionalidad,
Datos de entrada, Pasos) y permite capturar un área de la pantalla y guardarla en la
columna **Evidencia** de la fila actual.

## 1. Configurar acceso a Google (una sola vez)

La extensión usa tu cuenta de Google mediante OAuth. Necesitas un ID de cliente:

1. Entra a <https://console.cloud.google.com/> y crea un proyecto.
2. **APIs y servicios → Biblioteca:** activa **Google Sheets API** y **Google Drive API**.
3. **Pantalla de consentimiento de OAuth:** tipo *Externo*, en modo *Prueba*, y agrega
   tu correo como *usuario de prueba*.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth**, tipo
   **Aplicación de Chrome extension**. En *ID de elemento* pon:

   ```
   ejmenonjghaodbghjjhjekpdmlobncjn
   ```

5. Copia el ID de cliente que te muestra Google (termina en `.apps.googleusercontent.com`)
   y pégalo en [manifest.json](manifest.json), reemplazando `REEMPLAZAR.apps.googleusercontent.com`.

## 2. Instalar la extensión

1. En Chrome abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. **Cargar descomprimida** → selecciona esta carpeta (`proyecto logs\extension`).
4. Confirma que el ID mostrado sea `ejmenonjghaodbghjjhjekpdmlobncjn`.
   Si no coincide, la clave del manifest no se aplicó y el inicio de sesión fallará.
5. Haz clic en el icono de la extensión: se abre el panel lateral. Puedes dejarlo abierto
   mientras cambias de pestaña.

## 3. Uso

1. **Conectar Google** y acepta los permisos (hojas y Drive de esta extensión).
2. La hoja por defecto es la de tu matriz; también puedes pegar otra URL o ID.
3. Elige la **pestaña** de la hoja y navega con ◀ ▶, el desplegable o las flechas del teclado.
4. **Capturar área:** la página activa se oscurece; arrastra sobre lo que quieres capturar
   (Esc cancela). Revisa la vista previa y pulsa **Guardar en Evidencia**.

## Dónde queda la captura

- La imagen se sube a tu **Google Drive**, en la raíz, con nombre
  `evidencia_<pestaña>_fila<N>_<fecha>.png`.
- Por defecto la celda **Evidencia** recibe un enlace (`HYPERLINK`) a esa imagen, visible
  solo con tu cuenta.
- Si marcas **Mostrar la imagen dentro de la celda**, la celda usa `IMAGE()` y la imagen
  se hace accesible a cualquiera con el enlace (el enlace es difícil de adivinar, pero es
  más abierto que el modo privado). Úsalo solo si lo necesitas.
- Si la celda ya tiene evidencia, la extensión pide confirmación antes de reemplazarla.
  La captura anterior sigue en tu Drive.

## Permisos que usa

- `sidePanel`, `storage`: panel lateral y recordar la hoja elegida.
- `identity`: acceso a tu cuenta de Google.
- `scripting`, `activeTab`, `<all_urls>`: mostrar el selector de área y capturar la pestaña.
- Acceso a Sheets y Drive, solo a los archivos que la extensión crea.

## Limitaciones

- La extensión solo funciona en Chrome (versión 116 o superior).
- Las capturas de páginas `chrome://` o de la Chrome Web Store no se pueden tomar.
- La columna se detecta por el encabezado: deben existir `Usuario`, `Funcionalidad`,
  `Datos de entrada`, `Pasos` y `Evidencia`.

# Visor de logs SSH

Interfaz web local para seguir logs de servidores por SSH, sin tener que mantener una
terminal abierta ni usar Ctrl+C. Pasa por un servidor intermedio (jump host) si hace
falta, filtra y colorea las líneas, recupera lo que se escribió durante una caída de
red y guarda los perfiles de conexión cifrados.

Solo escucha en `127.0.0.1`, así que solo tu equipo puede acceder.

## Requisitos

- **Node.js 22.13 o superior**, o Node 24 (recomendado). Se usa el módulo integrado
  `node:sqlite`, que no existe en versiones anteriores. Node 20 falla al arrancar.
- Un navegador moderno (Chrome, Edge o Firefox).
- Acceso de red a los servidores SSH (y al intermedio, si el perfil lo usa).


No necesita Python, Docker ni configuración en la nube.

## Instalación y uso

```bash
npm install
npm start
```

Abre <http://127.0.0.1:3000> en el navegador.

1. **Primera vez:** crea una **clave maestra** (mínimo 8 caracteres). Cifra las
   contraseñas guardadas. No se puede recuperar: si la olvidas, tendrás que reiniciar la
   aplicación (ver abajo), y eso borra los perfiles.
2. **Crear un perfil** con el botón **+ Nuevo**:
   - *Salto (opcional):* el servidor intermedio, con su usuario y contraseña.
   - *Destino:* el servidor donde está el log, con su usuario y contraseña.
   - *Carpeta:* relativa al home del usuario remoto (por ejemplo `log/gestion`).
   - *Archivo:* el nombre del log (por ejemplo `mitelcel-negocios-gestion.log`).
3. **Abrir el log:** haz clic en el perfil y pulsa **Abrir log**. Se abre una pestaña.

## Pestañas y conexiones

- Cada perfil abierto tiene su **pestaña**, con su propio log, estado y contador.
  Puedes tener varias a la vez, cada una con su conexión.
- **×** cierra la pestaña, pero la conexión sigue viva en el servidor.
- **Cerrar conexión** corta la conexión de la pestaña activa (pide confirmación).
  **Reiniciar conexión** la vuelve a abrir.
- El punto de color de cada pestaña indica el estado: verde (conectado), amarillo
  (conectando o reconectando), rojo (detenido o error).
- Al hacer clic en un perfil se abre un detalle con su configuración, y desde ahí puedes
  **Abrir log**, **Editar** o **Eliminar**.
- **Clonar** duplica un perfil (con sus contraseñas cifradas) y lo abre para editarlo.

## Reconexión y recuperación de líneas

- Si la conexión se corta, el visor reintenta con espera de 2 s, y la espera crece solo si
  los intentos fallan seguido (hasta 30 s). Al conectar otra vez, la espera vuelve a 2 s.
- Al reconectar, retoma el log **desde el byte exacto donde se quedó**, así que las líneas
  escritas durante la caída también aparecen. Aparece una marca `--- reconectado ... ---`.
- Si el archivo fue recortado mientras estaba caído, vuelve a leer las últimas líneas.
- Cada paso de la conexión se muestra en el log (conectando al salto, abriendo la ruta
  al destino, ejecutando `tail`), así es fácil ver dónde se atasca.

## Filtros y lectura

- **Búsqueda** por texto o expresión regular, con o sin distinguir mayúsculas (Ctrl+F
  enfoca la búsqueda).
- **Niveles:** ERROR, WARN, INFO, DEBUG y Otros. Se pueden ocultar.
- **Solo request/response:** muestra únicamente los bloques de petición y respuesta, con
  su cuerpo completo (el XML entre `Inicio mensaje` y `Fin`).
- Colores: ERROR en rojo, WARN en amarillo, request con borde azul, response con borde
  verde.
- **Formatear XML:** indenta el XML de cada línea sin cambiar los datos guardados.
- **Copiar bloque:** en cada `Inicio mensaje` copia el bloque hasta su `Fin`.
- **Exportar filtrado:** descarga en `.txt` lo que estás viendo.
- **Auto-scroll** y **Limpiar vista**. La casilla *Todas las pestañas* hace que Limpiar
  vacíe todas las pestañas abiertas en vez de solo la activa.
- Las casillas y filtros se recuerdan en este navegador.

## Menú de perfiles y configuración

- El botón **☰** oculta o muestra la lista de perfiles (se recuerda).
- El engranaje **⚙** abre **Reiniciar la aplicación**: borra la clave maestra y todos
  los perfiles, y vuelve a pedir una clave nueva como la primera vez. Hay que escribir
  `BORRAR` para confirmar. También está disponible desde la pantalla de clave maestra, por
  si la olvidaste.

## Seguridad

- Las contraseñas se guardan cifradas con **AES-256-GCM**, con una clave derivada de la
  clave maestra (**scrypt**). Sin la clave maestra no se pueden leer.
- La API nunca devuelve contraseñas; la interfaz solo muestra si están guardadas.
- El servidor solo acepta peticiones desde `localhost` y `127.0.0.1`.
- Los perfiles y la bóveda están en `data/` (ignorado por Git). No la subas a ningún
  repositorio.
- Se recomienda cambiar las contraseñas que hayas escrito en chats o capturas y, cuando
  sea posible, usar claves SSH en lugar de contraseñas (esta versión solo usa contraseña).

## Algoritmos SSH antiguos

Algunos servidores solo aceptan intercambios de claves antiguos (`diffie-hellman-group14-sha1`,
`group1-sha1`, etc.). Están habilitados en `src/logSession.js`, igual que `ssh -legacy`.
Los algoritmos modernos se prefieren cuando el servidor los soporta.

## Limitaciones conocidas

- El `tail` se ejecuta sin pseudo-terminal. Si el visor se cierra de golpe, el proceso
  `tail` del servidor remoto puede seguir vivo hasta que escriba y reciba un error.
- Cada pestaña muestra como máximo 5000 líneas en memoria.
- Si un archivo es reemplazado por otro más grande con el mismo nombre mientras el visor
  está caído, el visor no lo detecta y podría saltarse el inicio del archivo nuevo.
- Las reglas de color están fijas en `public/app.js` (función `classify`).
- La autenticación con clave SSH no está implementada.

## Solución de problemas

| Mensaje | Causa probable |
| --- | --- |
| `No such built-in module: node:sqlite` | Versión de Node anterior a 22.13. Actualízala. |
| `Unable to negotiate ... no matching key exchange method` | El servidor usa algoritmos antiguos; el visor ya los soporta. Verifica la conexión desde otro equipo. |
| `el servidor intermedio no pudo llegar a host:puerto (tiempo agotado …)` | El salto conectó, pero no llega al destino. Revisa host, puerto y reglas de red. |
| `no se pudo leer archivo` | La carpeta o el nombre del log es incorrecto, o el usuario no tiene permisos. |
| `Bóveda bloqueada` / `Clave maestra incorrecta` | Escribe la clave maestra correcta, o reinicia la aplicación si la olvidaste. |

## Estructura

```
server.js            servidor HTTP y WebSocket (varios perfiles por conexión)
src/vault.js         clave maestra, cifrado y reinicio de la bóveda
src/profiles.js      perfiles en SQLite (contraseñas cifradas)
src/logSession.js    SSH, salto, tail, reconexión y recuperación de líneas
public/              interfaz web (index.html, app.js, styles.css)
data/                bóveda y base de datos (se crea al usarla; no versionar)
```

# Visor de logs SSH

Interfaz web local para ver logs de servidores por SSH, con salto (jump host),
búsqueda, filtros, colores y reconexión automática. Solo escucha en `127.0.0.1`.

## Requisitos

- Node.js 18 o superior.

## Uso

```bash
npm install
npm start
```

Luego abre <http://127.0.0.1:3000> en el navegador.

1. La primera vez crea una **clave maestra**. Cifra las contraseñas guardadas.
   Si la olvidas no hay recuperación: habrá que borrar `data/` y volver a crear los perfiles.
2. Crea un perfil con:
   - **Salto (opcional):** `jboss@200.57.170.132`.
   - **Destino:** `api@172.27.156.162` (o `.163`).
   - **Carpeta:** `log/gestión` (relativa al home del usuario remoto).
   - **Archivo:** `mitelcel-negocios-gestion.log`.
3. Selecciona el perfil. Se abre `tail -F` en el servidor y las líneas llegan en vivo.

Ya no necesitas Ctrl+C: la página solo muestra; el servidor mantiene la sesión.
Si la conexión se cae, reintenta con espera creciente (2 s, 4 s … hasta 30 s).

## Colores y filtros

- **ERROR / SEVERE / FATAL / Exception:** fondo rojo.
- **WARN:** fondo amarillo.
- **INFO / DEBUG:** color propio (filtrables).
- **request:** borde azul a la izquierda. **response:** borde verde.
- Búsqueda con texto plano o regex, con o sin mayúsculas. Ctrl+F enfoca la búsqueda.
- "Solo request/response" oculta el resto.
- "Exportar filtrado" descarga lo que estás viendo en un `.txt`.

## Algoritmos antiguos (-legacy)

El servidor usa intercambio de claves antiguo (`diffie-hellman-group14-sha1`,
`group1-sha1`, etc.). `src/logSession.js` los habilita igual que `ssh -legacy`.

## Seguridad

- Las contraseñas se guardan cifradas (AES-256-GCM, clave derivada con scrypt) en `data/`.
- `data/` está en `.gitignore`. No la subas a ningún repositorio.

## Limitaciones conocidas

- Las líneas escritas mientras la conexión está caída no se recuperan; se muestra una
  marca `--- reconectado ... ---` para saber dónde puede haber un hueco.
- Las reglas de color están fijas en `public/app.js` (función `classify`).
- Probado en local con la API y con el reintento de conexión; la conexión real a tus
  servidores no se ha probado todavía.

## Estructura

```
server.js            servidor HTTP + WebSocket
src/vault.js         clave maestra y cifrado
src/profiles.js      perfiles (contraseñas cifradas)
src/logSession.js    SSH, salto, tail -F, reconexión
public/              interfaz web (index.html, app.js, styles.css)
data/                bóveda y perfiles (se crea al usarla)
```

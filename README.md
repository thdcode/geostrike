# GeoStrike — Cliente

Frontend estático (HTML/CSS/JS vanilla, sin build step) — se sirve tal cual desde GitHub Pages.

## 1. Rellenar `js/config.js`

Es el único archivo que necesitas editar antes de desplegar. Copia ahí:

- `FIREBASE_CONFIG` → de tu proyecto Firebase (Project settings → General → tu app web).
- `WORKER_BASE_URL` → la URL que te dio `wrangler deploy` al desplegar el Worker.
- `LOCATION_PUBLIC_KEY_B64` → la clave pública NaCl que generaste con `npm run generate-keys` en el proyecto del Worker.
- `VAPID_PUBLIC_KEY` → la misma clave pública VAPID que pusiste en el `wrangler.toml` del Worker.

Todos estos valores son **públicos por diseño** — la privacidad del juego no depende de ocultarlos, depende del cifrado (nadie sin la clave *privada* correspondiente puede descifrar nada).

## 2. Probar en local

Los módulos ES (`type="module"`) no funcionan abriendo `index.html` directamente con `file://` — necesitas un servidor HTTP mínimo. Por ejemplo:

```bash
npx serve .
# o
python3 -m http.server 8080
```

Abre `http://localhost:8080` (o el puerto que indique). La geolocalización del navegador también exige HTTPS o `localhost` — en local funciona porque `localhost` está exento de esa restricción.

## 3. Desplegar en GitHub Pages

```bash
git init
git add .
git commit -m "Cliente inicial de GeoStrike"
git remote add origin https://github.com/TU_USUARIO/geostrike.git
git branch -M main
git push -u origin main
```

Luego: **Settings → Pages → Source → rama `main`, carpeta `/ (root)`**. Tu juego quedará en `https://TU_USUARIO.github.io/geostrike/`.

## 4. Ajustar CORS en el Worker (recomendado antes de publicar)

En `src/index.js` del proyecto del Worker, la función `corsHeaders()` acepta cualquier origen (`*`) para facilitar las pruebas. Antes de publicar de verdad, restringe esto a tu dominio real de GitHub Pages:

```js
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://TU_USUARIO.github.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
```
Y vuelve a desplegar el Worker (`npm run deploy`).

## 5. Iconos de la PWA (opcional)

`manifest.json` y `sw.js` referencian `assets/icons/icon-192.png` y `icon-512.png`, que no vienen incluidos — añádelos si quieres que el juego sea instalable con su propio icono. Sin ellos, el juego funciona igual, solo faltará el icono en el launcher/notificaciones.

## Estructura

```
index.html
manifest.json
sw.js                  → service worker, solo para Web Push
css/
  styles.css
js/
  config.js            → ÚNICO archivo a editar antes de desplegar
  main.js              → orquestación general
  geolocation.js
  crypto.js             → cifrado NaCl + caché local cifrada (AES-GCM)
  player.js
  realtime.js           → toda la comunicación con Firebase
  map.js                → Leaflet: solo tu marcador + bots + círculos de impacto
  physics.js            → Haversine + tiempo de vuelo local
  teams.js
  countermeasures.js
  push.js
  ranking.js
  ui.js                 → HUD, modales, toasts, avisos
```

## Notas importantes

- El mapa **nunca** dibuja marcadores de otros jugadores reales — solo el tuyo propio y los bots. Aunque el cliente puede leer `players/*` de Firebase, el campo de ubicación es un blob cifrado inútil sin la clave privada del Worker.
- La detección de "¿me amenaza este disparo?" (banner + contramedida) se calcula en tu propio navegador, con tu posición real — nunca se envía a nadie más que a ti mismo.
- Cualquier cliente conectado puede "empujar" la resolución de un disparo vencido llamando al Worker (`tick()` en `main.js`) — es una simplificación deliberada del MVP; si en pruebas ves disparos que tardan en resolverse por falta de clientes conectados, la mejora natural es añadir un Cron Trigger adicional en el Worker como red de seguridad (ver plan, sección 9).
- **Sesiones / recuperación de partida** (sin email ni cuentas): la identidad se verifica con el identificador del dispositivo (`geostrike:deviceId` en localStorage) + nickname. Al entrar, el cliente lee `sessions/{deviceId}`; si hay una partida activa con el mismo nickname, se ofrece recuperarla; si no, crea una partida nueva. El botón **⏹ Finalizar partida** marca `sessions/{deviceId}/active = false`, así la próxima entrada con el mismo nickname empieza de cero. Añade este nodo a las Security Rules:

```json
"sessions": {
  "$deviceId": {
    ".read": true,
    ".write": true
  }
}
```


// config.js — ÚNICO sitio donde pegar tus valores propios de Worker/claves.
// Todos estos valores son PÚBLICOS por diseño (nunca un secret va aquí):
// la privacidad no depende de ocultar esto, depende del cifrado (ver crypto.js).
// NOTA: el cliente NO tiene acceso a Appwrite ni a sus API keys — todo el
// acceso a datos pasa por el Cloudflare Worker (realtime.js).

// URL pública de tu Cloudflare Worker (paso 8 de la guía de instalación)
export const WORKER_BASE_URL = "https://geostrike-worker.thdcode.workers.dev";

// Clave pública NaCl del Worker (generada con `npm run generate-keys` en el proyecto del Worker)
export const LOCATION_PUBLIC_KEY_B64 = "/B8I+XMuOJBCQu1GGtqt7w1xM3HicLvg+493EAyeYSA=";

// Clave pública VAPID (la misma que pusiste en wrangler.toml del Worker)
export const VAPID_PUBLIC_KEY = "BB6QOy0ZwvDJmQeBN1-fQhFCFsefvS1LZ5SlPHlTzs2a2eTEgQa7BQsx3DzAkb1sPSQ4qQgeNN1NOTVBYzaHLus";

// --- Constantes de juego (deben coincidir con src/balance.js del Worker) ---
export const SPLASH_RADIUS_KM = 50;
// Radio del indicador que se dibuja en el mapa para cada disparo: solo visual,
// NO afecta al daño por salpicadura real (SPLASH_RADIUS_KM se mantiene para la
// lógica). Un círculo pequeño evita que se acumulen anillos de 50 km.
export const SHOT_CIRCLE_KM = 4;
export const WARNING_RADIUS_KM = 200;
export const SHOT_COOLDOWN_MS = 30_000; // 30s entre disparos propios (legacy, sin slots)
export const COUNTERMEASURE_COOLDOWN_MS = 90_000; // 1,5 min
export const IMPACTO_VISIBLE_MS = 5 * 60_000; // impactos resueltos de más de 5 min no se dibujan en el mapa

// --- Slots de lanzamiento (mirror de balance.js del Worker) ---
// 3 slots por jugador; cada disparo ocupa el primer slot libre y ese slot se
// renueva 30 s después del lanzamiento. Sin slots libres no se puede lanzar.
export const LAUNCH_SLOTS = 3;
export const LAUNCH_SLOT_RENEW_MS = 30_000;

// --- Disparo interceptor (mirror de balance.js del Worker) ---
export const MAX_INTERCEPTORS_IN_FLIGHT = 1; // solo un interceptor en vuelo por jugador
export const INTERCEPT_MAX_ACCURACY_WINDOW_MS = 150_000; // ≤ este margen → probabilidad ≈ máxima
export const INTERCEPT_MIN_ACCURACY = 0.05; // piso de probabilidad de acierto

export const MIN_FLIGHT_MS = 60_000; // 1 minuto
export const MAX_FLIGHT_MS = 600_000; // 10 minutos
export const MAX_DISTANCE_KM = 20_000; // ~media circunferencia terrestre

// Cada cuánto se revisa localmente si hay disparos por resolver o amenazas nuevas
export const TICK_INTERVAL_MS = 5_000;

// Modo depuración: se activa con ?debug en la URL o con el toggle del HUD (🔬).
// Muestra los bots destacados en el mapa y dibuja sus disparos desde su posición
// real (la posición de un bot es pública; la de los jugadores nunca se revela).
export const DEBUG_MODE =
  new URLSearchParams(location.search).has('debug') ||
  localStorage.getItem('geostrike_debug') === '1';

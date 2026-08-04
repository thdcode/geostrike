// config.js — ÚNICO sitio donde pegar tus valores propios de Firebase/Worker/claves.
// Todos estos valores son PÚBLICOS por diseño (nunca un secret va aquí):
// la privacidad no depende de ocultar esto, depende del cifrado (ver crypto.js).

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCUbovYDL_4Ya7tv3JOSurnbOBdfW4I5ck",
  authDomain: "project-8500527a-1548-47e5-a01.firebaseapp.com",
  databaseURL: "https://project-8500527a-1548-47e5-a01-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "project-8500527a-1548-47e5-a01",
  storageBucket: "project-8500527a-1548-47e5-a01.firebasestorage.app",
  messagingSenderId: "557408192360",
  appId: "1:557408192360:web:fd9f6a2de9841f6d02f8dd",
  measurementId: "G-STE6B376DH"
};

// URL pública de tu Cloudflare Worker (paso 8 de la guía de instalación)
export const WORKER_BASE_URL = "https://geostrike-worker.thdcode.workers.dev";

// Clave pública NaCl del Worker (generada con `npm run generate-keys` en el proyecto del Worker)
export const LOCATION_PUBLIC_KEY_B64 = "/B8I+XMuOJBCQu1GGtqt7w1xM3HicLvg+493EAyeYSA=";

// Clave pública VAPID (la misma que pusiste en wrangler.toml del Worker)
export const VAPID_PUBLIC_KEY = "BB6QOy0ZwvDJmQeBN1-fQhFCFsefvS1LZ5SlPHlTzs2a2eTEgQa7BQsx3DzAkb1sPSQ4qQgeNN1NOTVBYzaHLus";

// --- Constantes de juego (deben coincidir con src/balance.js del Worker) ---
export const SPLASH_RADIUS_KM = 50;
export const WARNING_RADIUS_KM = 200;
export const SHOT_COOLDOWN_MS = 30_000; // 30s entre disparos propios
export const COUNTERMEASURE_COOLDOWN_MS = 90_000; // 1,5 min

export const MIN_FLIGHT_MS = 60_000; // 1 minuto
export const MAX_FLIGHT_MS = 600_000; // 10 minutos
export const MAX_DISTANCE_KM = 20_000; // ~media circunferencia terrestre

// Cada cuánto se revisa localmente si hay disparos por resolver o amenazas nuevas
export const TICK_INTERVAL_MS = 5_000;

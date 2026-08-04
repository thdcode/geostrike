// physics.js — cálculos que solo necesitan datos que el propio cliente ya conoce.
// El tiempo de vuelo se calcula aquí, en local, con TU posición real:
// nunca hace falta enviarla a ningún sitio para saber cuánto tardará el disparo.

import { MIN_FLIGHT_MS, MAX_FLIGHT_MS, MAX_DISTANCE_KM } from './config.js';

/** Distancia Haversine en km entre dos puntos lat/lng. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Tiempo de vuelo en ms, según distancia real (escala de 1 a 10 minutos). */
export function calcularFlightMs(distanceKm) {
  return Math.min(
    MAX_FLIGHT_MS,
    MIN_FLIGHT_MS + (MAX_FLIGHT_MS - MIN_FLIGHT_MS) * Math.sqrt(distanceKm / MAX_DISTANCE_KM)
  );
}

/** Formatea milisegundos restantes como mm:ss para el HUD. */
export function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

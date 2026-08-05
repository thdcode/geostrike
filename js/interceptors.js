// interceptors.js — lanzamiento de disparos interceptores contra disparos
// entrantes. La detección de amenazas es la misma que countermeasures.js
// (disparosQueMeAmenazan); aquí solo se decide cuándo se puede lanzar y se
// delega en el Worker (POST /fire-interceptor), que es quien valida de verdad:
// el cliente nunca escribe interceptores directamente en Firebase.

import { MAX_INTERCEPTORS_IN_FLIGHT } from './config.js';
import { lanzarInterceptor } from './realtime.js';
import { estadoJugador } from './player.js';

/** ¿Hay ya un interceptor en vuelo (flag local del jugador, no expirado)? */
export function hayInterceptorEnVuelo() {
  const inflight = estadoJugador.interceptorInFlight;
  return !!(inflight && Number.isFinite(inflight.until) && inflight.until > Date.now());
}

/**
 * Lanza un interceptor contra el disparo entrante indicado.
 * Lanza Error si el Worker lo rechaza (ya hay uno en vuelo, no te amenaza,
 * no llegas a tiempo, eliminado, etc.).
 * @param {string} targetShotId
 * @returns {Promise<{interceptorId: string, outcome: string, hitProbability: number}>}
 */
export async function lanzar(targetShotId) {
  if (hayInterceptorEnVuelo()) {
    throw new Error('Ya tienes un interceptor en vuelo');
  }
  const res = await lanzarInterceptor(estadoJugador.playerId, targetShotId);
  // Estado local espejo del flag del servidor (si viene en la respuesta).
  if (res.interceptorInFlight) {
    estadoJugador.interceptorInFlight = res.interceptorInFlight;
  }
  return res;
}
